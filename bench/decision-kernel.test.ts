import { describe, expect, it } from "vitest";
import {
  DECISION_TIER,
  EXIT_RULES,
  arbitrate,
  assertUniqueRuleIds,
  evaluateRules,
  type CycleFacts,
  type DecisionPolicy,
  type PositionFacts,
  type Proposal,
  type Rule,
} from "../engine/decision/index.js";

const NOW = 1_000_000;
const POLICY: DecisionPolicy = {
  version: "test-v1",
  trailingStopPct: 0.1,
  ilProtectionEnabled: true,
  ilDominanceExitFactor: 2,
  ilDominanceMinUsd: 5,
  tvlDropExitPct: 0.3,
  volumeAuthExitThreshold: 0.7,
  feeIlExitRatio: 0.5,
  minYieldExitAgeMs: 1_000,
  holdBiasEnabled: false,
};

function makePosition(overrides: Partial<PositionFacts> = {}): PositionFacts {
  return {
    positionId: "p1",
    poolAddress: "pool-a",
    lowerBinId: 90,
    upperBinId: 110,
    openedAt: NOW - 10_000,
    depositedUsd: 100,
    currentValueUsd: 100,
    highestValueUsd: 100,
    cumulativeFeesClaimedUsd: 0,
    cumulativeRewardsClaimedUsd: 0,
    outOfRangeSince: null,
    hodlValueUsd: 100,
    ...overrides,
  };
}

function makeFacts(
  options: {
    readonly position?: PositionFacts | null;
    readonly pool?: Partial<CycleFacts["pool"]>;
    readonly now?: number;
  } = {},
): CycleFacts {
  const position = options.position ?? null;
  return {
    pool: {
      poolAddress: "pool-a",
      activeBinId: 100,
      tvlUsd: 100_000,
      tvlVelocity: 0,
      fees24hUsd: 500,
      feeIlRatio: 3,
      feeIlRatioKnown: true,
      volumeAuthenticity: 0.9,
      volumeAuthenticityKnown: true,
      binUtilization: 0.8,
      binUtilizationKnown: true,
      netDriftBins: 0,
      ...options.pool,
    },
    positions: position === null ? [] : [position],
    portfolio: { portfolioValueUsd: 1_000, openPositionCount: position === null ? 0 : 1 },
    market: { now: options.now ?? NOW },
  };
}

function proposalsFor(
  facts: CycleFacts,
  position: PositionFacts | null,
  policy = POLICY,
): readonly Proposal[] {
  return evaluateRules(EXIT_RULES, { facts, position, policy });
}

function proposal(overrides: Partial<Proposal> & Pick<Proposal, "ruleId" | "tier">): Proposal {
  return {
    phase: "exit",
    action: "EXIT",
    confidence: 1,
    reason: overrides.ruleId,
    expectedValueUsd: null,
    costsUsd: null,
    positionId: "p1",
    ...overrides,
  };
}

describe("registry", () => {
  it("rejects duplicate rule ids", () => {
    const rule: Rule = {
      id: "dup",
      phase: "exit",
      tier: DECISION_TIER.protect,
      scope: "position",
      evaluate: () => null,
    };
    expect(() => assertUniqueRuleIds([rule, { ...rule }])).toThrow(/Duplicate decision rule id/);
  });

  it("runs pool-scope rules only on the positionless pass", () => {
    const facts = makeFacts({ pool: { tvlVelocity: -0.5 } });

    expect(proposalsFor(facts, null).map((p) => p.ruleId)).toEqual(["tvl-drop"]);
    expect(proposalsFor(facts, makePosition())).toEqual([]);
  });

  it("runs position-scope rules only when a position is supplied", () => {
    const facts = makeFacts();
    expect(proposalsFor(facts, null)).toEqual([]);
    expect(
      proposalsFor(facts, makePosition({ highestValueUsd: 200, currentValueUsd: 100 })).map(
        (p) => p.ruleId,
      ),
    ).toEqual(["trailing-stop"]);
  });
});

describe("extracted exit rules", () => {
  it("fires the trailing stop only above the threshold", () => {
    const atThreshold = proposalsFor(
      makeFacts(),
      makePosition({ highestValueUsd: 100, currentValueUsd: 90 }),
    );
    expect(atThreshold).toEqual([]);

    const above = proposalsFor(
      makeFacts(),
      makePosition({ highestValueUsd: 100, currentValueUsd: 89 }),
    );
    expect(above[0]?.action).toBe("EXIT");
    expect(above[0]?.confidence).toBe(1);
    expect(above[0]?.reason).toContain("[trailing-stop]");
  });

  it("requires IL dominance to be out of range and above both floors", () => {
    const base = makePosition({
      outOfRangeSince: NOW - 5_000,
      hodlValueUsd: 150,
      currentValueUsd: 100,
      cumulativeFeesClaimedUsd: 10,
    });
    expect(proposalsFor(makeFacts(), base).map((p) => p.ruleId)).toContain("il-dominance");

    expect(
      proposalsFor(makeFacts(), { ...base, outOfRangeSince: null }).map((p) => p.ruleId),
    ).not.toContain("il-dominance");

    expect(
      proposalsFor(makeFacts(), { ...base, hodlValueUsd: 115 }).map((p) => p.ruleId),
    ).not.toContain("il-dominance");

    expect(
      proposalsFor(makeFacts(), base, { ...POLICY, ilProtectionEnabled: false }).map(
        (p) => p.ruleId,
      ),
    ).not.toContain("il-dominance");
  });

  it("fires the TVL-drop exit on a sharp negative velocity", () => {
    expect(proposalsFor(makeFacts({ pool: { tvlVelocity: -0.2 } }), null)).toEqual([]);
    const fired = proposalsFor(makeFacts({ pool: { tvlVelocity: -0.31 } }), null);
    expect(fired[0]?.confidence).toBe(0.85);
  });

  it("skips volume-authenticity when the signal is unknown", () => {
    const facts = makeFacts({ pool: { volumeAuthenticityKnown: false, volumeAuthenticity: 0 } });
    expect(proposalsFor(facts, makePosition()).map((p) => p.ruleId)).not.toContain(
      "volume-authenticity",
    );
  });

  it("suppresses the volume-authenticity exit under hold-bias only while in range", () => {
    const facts = makeFacts({ pool: { volumeAuthenticity: 0.5 } });
    const holdBias = { ...POLICY, holdBiasEnabled: true };

    expect(proposalsFor(facts, makePosition(), holdBias).map((p) => p.ruleId)).not.toContain(
      "volume-authenticity",
    );
    expect(
      proposalsFor(facts, makePosition({ outOfRangeSince: NOW - 1 }), holdBias).map(
        (p) => p.ruleId,
      ),
    ).toContain("volume-authenticity");
  });

  it("maturity-gates the fee/IL exit", () => {
    const facts = makeFacts({ pool: { feeIlRatio: 0.4 } });
    expect(
      proposalsFor(facts, makePosition({ openedAt: NOW - 500 })).map((p) => p.ruleId),
    ).not.toContain("fee-il");

    expect(
      proposalsFor(facts, makePosition({ openedAt: NOW - 2_000 })).map((p) => p.ruleId),
    ).toContain("fee-il");
  });

  it("suppresses the fee/IL exit for a healthy in-range position under hold-bias", () => {
    const facts = makeFacts({ pool: { feeIlRatio: 0.4 } });
    const holdBias = { ...POLICY, holdBiasEnabled: true };

    expect(proposalsFor(facts, makePosition(), holdBias).map((p) => p.ruleId)).not.toContain(
      "fee-il",
    );
    expect(
      proposalsFor(facts, makePosition({ currentValueUsd: 80 }), holdBias).map((p) => p.ruleId),
    ).toContain("fee-il");
  });
});

describe("arbitration", () => {
  it("returns no winner for an empty proposal set", () => {
    expect(arbitrate([])).toEqual({ winner: null, suppressed: [] });
  });

  it("prefers the higher tier regardless of expected value", () => {
    const entry = proposal({
      ruleId: "entry",
      tier: DECISION_TIER.entry,
      action: "ENTER",
      expectedValueUsd: 1_000,
    });
    const protect = proposal({
      ruleId: "protect",
      tier: DECISION_TIER.protect,
      expectedValueUsd: 1,
    });

    const result = arbitrate([entry, protect]);
    expect(result.winner?.ruleId).toBe("protect");
    expect(result.suppressed.map((p) => p.ruleId)).toEqual(["entry"]);
  });

  it("ranks by expected value inside a tier, with null last", () => {
    const low = proposal({ ruleId: "low", tier: DECISION_TIER.entry, expectedValueUsd: 2 });
    const high = proposal({ ruleId: "high", tier: DECISION_TIER.entry, expectedValueUsd: 10 });
    const unknown = proposal({ ruleId: "unknown", tier: DECISION_TIER.entry });

    expect(arbitrate([unknown, low, high]).winner?.ruleId).toBe("high");
    expect(arbitrate([unknown, low]).winner?.ruleId).toBe("low");
  });

  it("breaks exact ties by rule id, independent of input order", () => {
    const bravo = proposal({ ruleId: "bravo", tier: DECISION_TIER.entry });
    const alpha = proposal({ ruleId: "alpha", tier: DECISION_TIER.entry });

    expect(arbitrate([bravo, alpha]).winner?.ruleId).toBe("alpha");
    expect(arbitrate([alpha, bravo]).winner?.ruleId).toBe("alpha");
  });

  it("is pure: frozen facts and policy evaluate identically twice", () => {
    const facts = Object.freeze(makeFacts());
    const policy = Object.freeze({ ...POLICY });
    const context = { facts, position: makePosition(), policy };

    const first = evaluateRules(EXIT_RULES, context);
    const second = evaluateRules(EXIT_RULES, context);
    expect(second).toEqual(first);
  });
});
