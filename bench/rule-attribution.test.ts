import { describe, expect, it } from "vitest";
import {
  buildRuleAttribution,
  extractRuleTags,
  type AttributionDecision,
  type AttributionPosition,
} from "../engine/rule-attribution.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_000 * DAY_MS;

function decision(
  overrides: Partial<AttributionDecision> & Pick<AttributionDecision, "timestamp" | "poolAddress">,
): AttributionDecision {
  return {
    action: "ENTER",
    reasoning: "",
    executed: true,
    riskReason: null,
    ...overrides,
  };
}

function position(
  overrides: Partial<AttributionPosition> &
    Pick<AttributionPosition, "positionId" | "poolAddress" | "openedAt">,
): AttributionPosition {
  return {
    closedAt: overrides.openedAt + 3_600_000,
    realizedPnlUsd: 0,
    depositedUsd: 100,
    tokenXSymbol: "SOL",
    tokenYSymbol: "USDC",
    ...overrides,
  };
}

describe("extractRuleTags", () => {
  it("extracts bracket tags from reasoning text", () => {
    expect(extractRuleTags("[fee-il-gate] Fee/IL 1.10 < 1.20")).toEqual(["fee-il-gate"]);
  });

  it("dedupes repeated tags and lowercases", () => {
    expect(extractRuleTags("[W15] exit [w15] again")).toEqual(["w15"]);
  });

  it("drops indexes, placeholders and non-rule brackets", () => {
    expect(extractRuleTags("[0] step [1] [i] [SOL/USDC]")).toEqual([]);
  });

  it("returns no tags for untagged or empty text", () => {
    expect(extractRuleTags("Fee/IL ratio 0.4")).toEqual([]);
    expect(extractRuleTags(null)).toEqual([]);
    expect(extractRuleTags("")).toEqual([]);
  });
});

describe("buildRuleAttribution", () => {
  it("shares credit equally when entry rules co-fire", () => {
    const report = buildRuleAttribution({
      now: NOW,
      decisions: [
        decision({
          timestamp: NOW - DAY_MS,
          poolAddress: "pool-a",
          reasoning: "[fee-il-gate] ok [volume-authenticity] ok",
        }),
      ],
      positions: [
        position({
          positionId: "p1",
          poolAddress: "pool-a",
          openedAt: NOW - DAY_MS,
          realizedPnlUsd: 10,
        }),
      ],
    });

    expect(report.closes).toBe(1);
    expect(report.pricedCloses).toBe(1);
    expect(report.netPnlUsd).toBe(10);
    expect(report.rules).toHaveLength(2);
    for (const row of report.rules) {
      expect(row.closes).toBe(1);
      expect(row.creditedPnlUsd).toBeCloseTo(5, 8);
      expect(row.soloCloses).toBe(0);
    }
  });

  it("reports sole-rule outcomes uncontaminated", () => {
    const report = buildRuleAttribution({
      now: NOW,
      decisions: [
        decision({
          timestamp: NOW - DAY_MS,
          poolAddress: "pool-a",
          reasoning: "[entry-net-gate] positive",
        }),
      ],
      positions: [
        position({
          positionId: "p1",
          poolAddress: "pool-a",
          openedAt: NOW - DAY_MS,
          realizedPnlUsd: -4,
        }),
      ],
    });

    const row = report.rules[0];
    expect(row?.ruleId).toBe("entry-net-gate");
    expect(row?.soloCloses).toBe(1);
    expect(row?.soloNetPnlUsd).toBe(-4);
    expect(row?.winRate).toBe(0);
  });

  it("does not attribute an ENTER outside the lookback window", () => {
    const report = buildRuleAttribution({
      now: NOW,
      enterLookbackMs: 6 * 60 * 60 * 1000,
      decisions: [
        decision({ timestamp: NOW - 2 * DAY_MS, poolAddress: "pool-a", reasoning: "[a-rule-tag]" }),
      ],
      positions: [
        position({
          positionId: "p1",
          poolAddress: "pool-a",
          openedAt: NOW - DAY_MS,
          realizedPnlUsd: 5,
        }),
      ],
    });

    expect(report.unattributedCloses).toBe(1);
    expect(report.rules).toHaveLength(0);
  });

  it("counts untagged ENTERs separately", () => {
    const report = buildRuleAttribution({
      now: NOW,
      decisions: [
        decision({ timestamp: NOW - DAY_MS, poolAddress: "pool-a", reasoning: "no tag" }),
      ],
      positions: [
        position({
          positionId: "p1",
          poolAddress: "pool-a",
          openedAt: NOW - DAY_MS,
          realizedPnlUsd: 5,
        }),
      ],
    });

    expect(report.untaggedCloses).toBe(1);
    expect(report.unattributedCloses).toBe(0);
  });

  it("tracks unpriced closes without inventing PnL", () => {
    const report = buildRuleAttribution({
      now: NOW,
      decisions: [
        decision({ timestamp: NOW - DAY_MS, poolAddress: "pool-a", reasoning: "[a-rule-tag]" }),
      ],
      positions: [
        position({
          positionId: "p1",
          poolAddress: "pool-a",
          openedAt: NOW - DAY_MS,
          realizedPnlUsd: null,
        }),
      ],
    });

    expect(report.closes).toBe(1);
    expect(report.pricedCloses).toBe(0);
    expect(report.netPnlUsd).toBe(0);
    expect(report.rules[0]?.closes).toBe(1);
    expect(report.rules[0]?.creditedPnlUsd).toBe(0);
    expect(report.rules[0]?.avgCreditedPnlUsd).toBeNull();
  });

  it("aggregates rejection tags from both reasoning and risk reason", () => {
    const report = buildRuleAttribution({
      now: NOW,
      decisions: [
        decision({
          timestamp: NOW - DAY_MS,
          poolAddress: "pool-a",
          action: "ENTER",
          reasoning: "[drift-gate] falling",
          executed: false,
          riskReason: "[fee-il-gate] Fee/IL 0.4 < 1.2",
        }),
      ],
      positions: [],
    });

    const byRule = new Map(report.rejections.map((row) => [row.ruleId, row.count]));
    expect(byRule.get("drift-gate")).toBe(1);
    expect(byRule.get("fee-il-gate")).toBe(1);
  });

  it("filters closes by the trailing window", () => {
    const report = buildRuleAttribution({
      now: NOW,
      windowMs: 30 * DAY_MS,
      decisions: [
        decision({
          timestamp: NOW - 60 * DAY_MS,
          poolAddress: "pool-a",
          reasoning: "[a-rule-tag]",
        }),
      ],
      positions: [
        position({
          positionId: "old",
          poolAddress: "pool-a",
          openedAt: NOW - 60 * DAY_MS,
          closedAt: NOW - 40 * DAY_MS,
          realizedPnlUsd: -99,
        }),
      ],
    });

    expect(report.closes).toBe(0);
    expect(report.netPnlUsd).toBe(0);
  });

  it("sorts rules and pools by worst net first", () => {
    const report = buildRuleAttribution({
      now: NOW,
      decisions: [
        decision({ timestamp: NOW - DAY_MS, poolAddress: "pool-a", reasoning: "[winner-rule]" }),
        decision({ timestamp: NOW - DAY_MS, poolAddress: "pool-b", reasoning: "[loser-rule]" }),
      ],
      positions: [
        position({
          positionId: "p1",
          poolAddress: "pool-a",
          openedAt: NOW - DAY_MS,
          realizedPnlUsd: 20,
        }),
        position({
          positionId: "p2",
          poolAddress: "pool-b",
          openedAt: NOW - DAY_MS,
          realizedPnlUsd: -20,
        }),
      ],
    });

    expect(report.rules.map((row) => row.ruleId)).toEqual(["loser-rule", "winner-rule"]);
    expect(report.pools.map((row) => row.poolAddress)).toEqual(["pool-b", "pool-a"]);
    expect(report.profitFactor).toBeCloseTo(1, 8);
  });

  it("is insensitive to decision input order", () => {
    const decisions: AttributionDecision[] = [
      decision({
        timestamp: NOW - DAY_MS,
        poolAddress: "pool-a",
        reasoning: "[rule-one] [rule-two]",
      }),
      decision({ timestamp: NOW - 2 * DAY_MS, poolAddress: "pool-a", reasoning: "[rule-one]" }),
    ];
    const positions = [
      position({
        positionId: "p1",
        poolAddress: "pool-a",
        openedAt: NOW - DAY_MS,
        realizedPnlUsd: 8,
      }),
    ];

    const forward = buildRuleAttribution({ now: NOW, decisions, positions });
    const reversed = buildRuleAttribution({
      now: NOW,
      decisions: [...decisions].reverse(),
      positions,
    });

    expect(reversed.rules).toEqual(forward.rules);
    expect(reversed.netPnlUsd).toBe(forward.netPnlUsd);
  });
});
