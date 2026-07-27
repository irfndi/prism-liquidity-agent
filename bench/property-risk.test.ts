import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { evaluateRisk, type RiskConfig } from "../engine/risk-service.js";
import type { AgentDecision, ActionType, Position } from "../engine/types.js";

const NUM_RUNS = 200;

const POOL = "TestPool111111111111111111111111111111111111";

const baseConfig: RiskConfig = {
  confidenceThreshold: 0.65,
  maxRebalanceRangeBins: 50,
  stopLossPct: 0.15,
  maxPerPoolAllocationPct: 0.3,
  maxPositionsPerPool: 2,
};

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    id: "pos-1",
    poolAddress: POOL,
    poolName: "Test",
    lowerBinId: 4990,
    upperBinId: 5010,
    liquidityShares: 1n,
    depositedUsd: 1000,
    currentValueUsd: 1000,
    unrealizedPnlUsd: 0,
    feesEarnedUsd: 0,
    openedAt: 0,
    ...overrides,
  };
}

// A position on the target pool with fuzzy value columns so the stop-loss and
// per-pool gates can engage on some runs. identity/pool are fixed so targeting
// resolves deterministically.
const positionArb = fc
  .record({
    depositedUsd: fc.double({ min: 0, max: 1e6, noNaN: true }),
    currentValueUsd: fc.double({ min: 0, max: 1e6, noNaN: true }),
  })
  .map(({ depositedUsd, currentValueUsd }) =>
    makePosition({
      depositedUsd,
      currentValueUsd,
      unrealizedPnlUsd: currentValueUsd - depositedUsd,
    }),
  );

// ─── EXIT is always approved ──────────────────────────────────────────────────

describe("property: EXIT is always approved", () => {
  it("approves EXIT for any confidence and any portfolio / position state", () => {
    const arb = fc.record({
      confidence: fc.double({ min: 0, max: 1, noNaN: true }),
      portfolioValueUsd: fc.double({ min: 0, max: 1e9, noNaN: true }),
      recentPnlUsd: fc.double({ min: -1e9, max: 1e9, noNaN: true }),
      positions: fc.array(positionArb, { maxLength: 3 }),
      threshold: fc.double({ min: 0.01, max: 1, noNaN: true }),
    });
    fc.assert(
      fc.property(arb, (v) => {
        const config = { ...baseConfig, confidenceThreshold: v.threshold };
        const decision: AgentDecision = {
          action: "EXIT",
          poolAddress: POOL,
          confidence: v.confidence,
          reasoning: "fuzz exit",
        };
        const result = evaluateRisk(config, decision, {
          openPositions: v.positions,
          portfolioValueUsd: v.portfolioValueUsd,
          recentPnlUsd: v.recentPnlUsd,
          poolAddress: POOL,
        });
        // Capital protection beats the confidence gate and every other gate:
        // even deep drawdown + stop-loss-broken positions cannot block an EXIT.
        expect(result.approved).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── Confidence gate ───────────────────────────────────────────────────────────

describe("property: confidence gate", () => {
  it("rejects every non-EXIT decision strictly below threshold, on confidence", () => {
    const arb = fc.record({
      action: fc.constantFrom<ActionType>("ENTER", "HOLD", "REBALANCE"),
      threshold: fc.double({ min: 0.1, max: 0.95, noNaN: true }),
      frac: fc.double({ min: 0, max: 1, noNaN: true }),
    });
    fc.assert(
      fc.property(arb, ({ action, threshold, frac }) => {
        // confidence ∈ [0, 0.999·threshold) ⊂ [0, threshold) — strictly below.
        const confidence = threshold * 0.999 * (1 - frac);
        const config = { ...baseConfig, confidenceThreshold: threshold };
        const decision: AgentDecision = {
          action,
          poolAddress: POOL,
          confidence,
          reasoning: "fuzz",
          ...(action === "ENTER" && { positionSizeUsd: 100 }),
        };
        const result = evaluateRisk(config, decision, {
          openPositions: [],
          portfolioValueUsd: 10_000,
          recentPnlUsd: 0,
          poolAddress: POOL,
        });
        // Gate 2 precedes every action-specific gate, so a sub-threshold
        // non-EXIT decision is always rejected for confidence, whatever else.
        expect(result.approved).toBe(false);
        expect(result.reason).toContain("Confidence");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("at or above threshold, confidence alone never rejects a passing context", () => {
    const arb = fc.record({
      action: fc.constantFrom<ActionType>("ENTER", "HOLD"),
      threshold: fc.double({ min: 0.05, max: 0.95, noNaN: true }),
      frac: fc.double({ min: 0, max: 1, noNaN: true }),
    });
    fc.assert(
      fc.property(arb, ({ action, threshold, frac }) => {
        // confidence ∈ [threshold, 1] — at or above the gate.
        const confidence = threshold + (1 - threshold) * frac;
        const config = { ...baseConfig, confidenceThreshold: threshold };
        const decision: AgentDecision = {
          action,
          poolAddress: POOL,
          confidence,
          reasoning: "fuzz",
          ...(action === "ENTER" && { positionSizeUsd: 100 }),
        };
        // Fixed PASSING context: no drawdown, no positions, ENTER size (100)
        // well inside the 30% per-pool cap of a $10k portfolio. With every
        // other gate satisfied, confidence alone must never cause rejection.
        const result = evaluateRisk(config, decision, {
          openPositions: [],
          portfolioValueUsd: 10_000,
          recentPnlUsd: 0,
          poolAddress: POOL,
        });
        expect(result.approved).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── Monotonicity ───────────────────────────────────────────────────────────────

describe("property: approval is monotonic in confidence", () => {
  it("raising confidence (all else equal) never flips approved → rejected", () => {
    const arb = fc.record({
      action: fc.constantFrom<ActionType>("HOLD", "REBALANCE", "EXIT", "ENTER"),
      threshold: fc.double({ min: 0.05, max: 0.95, noNaN: true }),
      c1: fc.double({ min: 0, max: 1, noNaN: true }),
      c2: fc.double({ min: 0, max: 1, noNaN: true }),
      sizeUsd: fc.double({ min: 0, max: 1e6, noNaN: true }),
      portfolioValueUsd: fc.double({ min: 0, max: 1e9, noNaN: true }),
      recentPnlUsd: fc.double({ min: -1e9, max: 1e9, noNaN: true }),
      positions: fc.array(positionArb, { maxLength: 3 }),
    });
    fc.assert(
      fc.property(arb, (v) => {
        const lo = Math.min(v.c1, v.c2);
        const hi = Math.max(v.c1, v.c2);
        const config = { ...baseConfig, confidenceThreshold: v.threshold };
        const ctx = {
          openPositions: v.positions,
          portfolioValueUsd: v.portfolioValueUsd,
          recentPnlUsd: v.recentPnlUsd,
          poolAddress: POOL,
        };
        const decisionLo: AgentDecision = {
          action: v.action,
          poolAddress: POOL,
          confidence: lo,
          reasoning: "fuzz",
          ...(v.action === "ENTER" && { positionSizeUsd: v.sizeUsd }),
          ...(v.action === "REBALANCE" && {
            rebalanceParams: { newLowerBinId: 4990, newUpperBinId: 5010, slippageBps: 50 },
          }),
        };
        const decisionHi: AgentDecision = { ...decisionLo, confidence: hi };

        const rLo = evaluateRisk(config, decisionLo, ctx);
        const rHi = evaluateRisk(config, decisionHi, ctx);

        // Only gate 2 (confidence) depends on confidence; every other gate is
        // confidence-independent. Hence approval is upward-closed in confidence:
        // approved at `lo` ⟹ approved at any `hi` ≥ `lo`.
        if (rLo.approved) {
          expect(rHi.approved).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
