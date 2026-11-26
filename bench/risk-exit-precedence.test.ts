/**
 * Property: an EXIT decision is approved under EVERY input that rejects a
 * non-EXIT decision.
 *
 * This is the capital-protection promise in `evaluateRisk` (engine/risk-service.ts:27):
 * the EXIT branch returns before any gate runs, so a loss-cut can never be
 * blocked by confidence, a halt, an allocation cap, a drawdown, a stop-loss,
 * a size cap or a range check. Tests elsewhere check the EXIT branch against a
 * couple of hand-picked contexts; this one derives the hostile context FOR EACH
 * GATE by first proving a HOLD is rejected there, then flipping the action to
 * EXIT. If that second assertion fails, some gate moved above the EXIT branch.
 *
 * Scope: the seven gates in `evaluateRisk`, over the hostile points listed in
 * `HOSTILE`. Not modelled: `evaluateAgentProposal` (a separate path) and the
 * engine's own pre-filter, which runs before risk evaluation.
 */
import { describe, expect, it } from "vitest";
import { evaluateRisk, type RiskConfig } from "../engine/risk-service.js";
import type { AgentDecision } from "../engine/types.js";
import type { Position } from "../engine/types.js";
import type { RiskContext } from "../engine/services.js";

const POOL = "TestPool111111111111111111111111111111111111";
const POS = "pos-1";

const CONFIG: RiskConfig = {
  confidenceThreshold: 0.65,
  maxRebalanceRangeBins: 50,
  stopLossPct: 0.15,
  maxPerPoolAllocationPct: 0.3,
  maxPositionsPerPool: 2,
};

function position(overrides: Partial<Position> = {}): Position {
  // SAFETY: the literal supplies every field the gates read; fields the gate
  // chain never touches are the domain's optional/extra members.
  return {
    id: POS,
    poolAddress: POOL,
    depositedUsd: 100,
    currentValueUsd: 100,
    highestValueUsd: 100,
    outOfRangeSince: null,
    ...overrides,
  } as Position;
}

function decision(overrides: Partial<AgentDecision>): AgentDecision {
  // SAFETY: each caller supplies `action`; the rest are literals the gates read.
  return {
    poolAddress: POOL,
    confidence: 0.75,
    reasoning: "probe",
    ...overrides,
  } as AgentDecision;
}

function context(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    openPositions: [],
    portfolioValueUsd: 10_000,
    recentPnlUsd: 0,
    poolAddress: POOL,
    positionId: POS,
    ...overrides,
  };
}

interface Hostile {
  readonly gate: string;
  readonly decision: Partial<AgentDecision>;
  readonly ctx: Partial<RiskContext>;
}

/**
 * One context per gate, each constructed to trip exactly that gate for a
 * non-EXIT action. Order matches `evaluateRisk`'s gate order.
 */
const HOSTILE: ReadonlyArray<Hostile> = [
  {
    gate: "confidence (numeric)",
    decision: { action: "HOLD", confidence: 0.01 },
    ctx: {},
  },
  {
    gate: "confidence (NaN)",
    decision: { action: "HOLD", confidence: Number.NaN },
    ctx: {},
  },
  {
    gate: "confidence (Infinity)",
    decision: { action: "HOLD", confidence: Number.POSITIVE_INFINITY },
    ctx: {},
  },
  {
    gate: "rolling realized-PnL halt",
    decision: { action: "ENTER", confidence: 0.9, positionSizeUsd: 50 },
    ctx: { rollingRealizedPnlHalted: true },
  },
  {
    gate: "per-pool position cap",
    decision: { action: "ENTER", confidence: 0.9, positionSizeUsd: 50 },
    ctx: {
      openPositions: [position({ id: "a" }), position({ id: "b" })],
    },
  },
  {
    gate: "portfolio drawdown >10%",
    decision: { action: "ENTER", confidence: 0.9, positionSizeUsd: 50 },
    ctx: { recentPnlUsd: -2_000, portfolioValueUsd: 10_000 },
  },
  {
    gate: "stop loss breached",
    decision: { action: "HOLD", confidence: 0.9 },
    ctx: { openPositions: [position({ currentValueUsd: 50 })] },
  },
  {
    // The size gate normally SHRINKS an oversized entry; it rejects only when
    // the result would be dust. Use the dust path so the gate is genuinely
    // hostile rather than merely adjusting.
    gate: "position size below the entry floor",
    decision: { action: "ENTER", confidence: 0.9, positionSizeUsd: 5 },
    ctx: {},
  },
  {
    gate: "rebalance range wider than the cap",
    decision: {
      action: "REBALANCE",
      confidence: 0.9,
      positionSizeUsd: 50,
      rebalanceParams: { newLowerBinId: 1_000, newUpperBinId: 1_100, slippageBps: 50 },
    },
    ctx: { activeBinId: 5_000, openPositions: [position()] },
  },
];

describe("EXIT precedence over every risk gate", () => {
  for (const hostile of HOSTILE) {
    it(`EXIT is approved where ${hostile.gate} rejects`, () => {
      const ctx = context(hostile.ctx);

      // Precondition: this context really does trip the gate. Without this,
      // the EXIT assertion below could pass for the wrong reason.
      const blocked = evaluateRisk(CONFIG, decision(hostile.decision), ctx);
      expect(blocked.approved, `gate "${hostile.gate}" should reject a non-EXIT`).toBe(false);

      // The property: the same inputs, EXIT.
      const exit = evaluateRisk(CONFIG, decision({ ...hostile.decision, action: "EXIT" }), ctx);
      expect(exit.approved, `EXIT must bypass "${hostile.gate}"`).toBe(true);
      expect(exit.reason).toContain("capital protection");
    });
  }

  it("holds across a grid of confidence x size x drawdown, all gates at once", () => {
    const confidences = [0, Number.NaN, Number.POSITIVE_INFINITY, 0.01, 0.5, 1];
    const sizes = [0, 1, 9_000, Number.MAX_SAFE_INTEGER];
    const pnls = [0, -1_000, -50_000];
    for (const confidence of confidences) {
      for (const positionSizeUsd of sizes) {
        for (const recentPnlUsd of pnls) {
          const ctx = context({
            openPositions: [
              position({ id: "a", currentValueUsd: 1 }),
              position({ id: "b", currentValueUsd: 1 }),
            ],
            recentPnlUsd,
            rollingRealizedPnlHalted: true,
          });
          const exit = evaluateRisk(
            CONFIG,
            decision({ action: "EXIT", confidence, positionSizeUsd }),
            ctx,
          );
          expect(exit.approved).toBe(true);
        }
      }
    }
  });
});
