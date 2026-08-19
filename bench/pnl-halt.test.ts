import { describe, expect, it } from "vitest";
import { rollingRealizedPnlHalted } from "../engine/pnl-halt.js";
import { evaluateRisk, type RiskConfig } from "../engine/risk-service.js";
import type { AgentDecision, Position } from "../engine/types.js";
import type { RiskContext } from "../engine/services.js";

// ─── Pure helper: rollingRealizedPnlHalted ─────────────────────────────────

describe("rollingRealizedPnlHalted", () => {
  it("halts when the trailing window sum is below the threshold", () => {
    // newest-first list: [-1,-2,-3,-4,-5] (recent losses) sum -15 < -10
    expect(rollingRealizedPnlHalted([-1, -2, -3, -4, -5], 5, -10)).toBe(true);
  });

  it("does not halt when the trailing window sum is at/above the threshold", () => {
    expect(rollingRealizedPnlHalted([5, 5, 5, 5, 5], 5, -10)).toBe(false);
    // exactly at boundary -> not below -> not halted
    expect(rollingRealizedPnlHalted([-2, -2, -2, -2, -2], 5, -10)).toBe(false);
  });

  it("sums only the most-recent `window` positions, not the whole ledger", () => {
    // newest-first: 5 recent losses then 50 older wins. A window of 5 sees
    // only the losses (sum -15, below -10) and halts; a window of 200 sums
    // the whole ledger (strongly positive) and does not.
    const ledger = [-1, -2, -3, -4, -5, ...Array<number>(50).fill(10)];
    expect(rollingRealizedPnlHalted(ledger, 5, -10)).toBe(true);
    expect(rollingRealizedPnlHalted(ledger, 200, -10)).toBe(false);
  });

  it("skips null/unknown realized values within the window", () => {
    // one null among the recent five -> the four known sum -10, below -5
    const withNull: (number | null)[] = [-1, null, -2, -3, -4, -5];
    expect(rollingRealizedPnlHalted(withNull, 5, -5)).toBe(true);
  });

  it("fails open (never halts) when there is no realized history", () => {
    expect(rollingRealizedPnlHalted([], 100, -1)).toBe(false);
    expect(rollingRealizedPnlHalted([null, null], 100, -1)).toBe(false);
    expect(rollingRealizedPnlHalted([undefined], 100, -1)).toBe(false);
  });

  it("clamps a non-positive window to 1", () => {
    expect(rollingRealizedPnlHalted([-5], 0, -1)).toBe(true);
    expect(rollingRealizedPnlHalted([], 0, -1)).toBe(false);
  });
});

// ─── Risk gate: [rolling-pnl-halt] ──────────────────────────────────────────

function makeContext(overrides: Partial<RiskContext> = {}): RiskContext {
  const openPositions: Position[] = [];
  return {
    openPositions,
    portfolioValueUsd: 10_000,
    recentPnlUsd: 0,
    poolAddress: "pool",
    maxOpenPositions: 3,
    ...overrides,
  };
}

function makeDecision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  // SAFETY: This test fixture is constructed to satisfy the asserted service/domain contract and is exercised by the surrounding test.
  return {
    action: "ENTER",
    poolAddress: "pool",
    confidence: 0.9,
    reasoning: "test",
    ...overrides,
  } as AgentDecision;
}

const riskConfig: RiskConfig = {
  confidenceThreshold: 0.65,
  maxRebalanceRangeBins: 50,
  stopLossPct: 0.15,
  maxPerPoolAllocationPct: 0.4,
  maxPositionsPerPool: 2,
};

describe("risk gate [rolling-pnl-halt]", () => {
  it("rejects a new-capital ENTER when the rolling halt is active", () => {
    const result = evaluateRisk(
      riskConfig,
      makeDecision({ action: "ENTER" }),
      makeContext({ rollingRealizedPnlHalted: true }),
    );
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("[rolling-pnl-halt]");
  });

  it("does NOT halt ENTER when the flag is false/absent (fail-open)", () => {
    const absent = evaluateRisk(
      riskConfig,
      makeDecision({ action: "ENTER" }),
      makeContext(), // no rollingRealizedPnlHalted -> undefined
    );
    expect(absent.reason).not.toContain("[rolling-pnl-halt]");

    const presentFalse = evaluateRisk(
      riskConfig,
      makeDecision({ action: "ENTER" }),
      makeContext({ rollingRealizedPnlHalted: false }),
    );
    expect(presentFalse.reason).not.toContain("[rolling-pnl-halt]");
  });

  it("never blocks EXIT when the halt is active (capital protection)", () => {
    const result = evaluateRisk(
      riskConfig,
      makeDecision({ action: "EXIT" }),
      makeContext({ rollingRealizedPnlHalted: true }),
    );
    expect(result.approved).toBe(true);
    expect(result.reason).toBe("EXIT approved: capital protection");
  });

  it("does not block REBALANCE when the halt is active", () => {
    // stop-loss would be the next gate for REBALANCE; a healthy position
    // must pass through untouched by the halt.
    const result = evaluateRisk(
      riskConfig,
      makeDecision({
        action: "REBALANCE",
        positionId: "pos-1",
        confidence: 0.8,
      }),
      makeContext({
        rollingRealizedPnlHalted: true,
        openPositions: [
          // SAFETY: This test fixture is constructed to satisfy the asserted service/domain contract and is exercised by the surrounding test.
          {
            id: "pos-1",
            poolAddress: "pool",
            depositedUsd: 100,
            currentValueUsd: 105,
            unrealizedPnlUsd: 5,
          } as Position,
        ],
      }),
    );
    expect(result.reason).not.toContain("[rolling-pnl-halt]");
  });
});
