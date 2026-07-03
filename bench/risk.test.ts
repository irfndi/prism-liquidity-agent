import { describe, it, expect } from "vitest";
import { evaluateRisk } from "../engine/risk-service.js";
import type { AgentDecision, Position } from "../engine/types.js";

function makeDecision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return {
    action: "HOLD",
    poolAddress: "TestPool111111111111111111111111111111111111",
    confidence: 0.75,
    reasoning: "Test decision",
    ...overrides,
  };
}

function makeContext(
  overrides: Partial<{
    openPositions: ReadonlyArray<Position>;
    portfolioValueUsd: number;
    recentPnlUsd: number;
  }> = {},
) {
  return {
    openPositions: [] as ReadonlyArray<Position>,
    portfolioValueUsd: 10_000,
    recentPnlUsd: 0,
    ...overrides,
  };
}

describe("RiskEngine", () => {
  const riskConfig = {
    confidenceThreshold: 0.65,
    maxRebalanceRangeBins: 50,
    stopLossPct: 0.15,
  };

  describe("confidence gate", () => {
    it("rejects decisions below confidence threshold", () => {
      const decision = makeDecision({ confidence: 0.5 });
      const result = evaluateRisk(riskConfig, decision, makeContext());
      expect(result.approved).toBe(false);
      expect(result.reason).toContain("Confidence");
    });

    it("approves decisions at threshold", () => {
      const decision = makeDecision({ confidence: 0.65 });
      const result = evaluateRisk(riskConfig, decision, makeContext());
      expect(result.approved).toBe(true);
    });
  });

  describe("EXIT always approved", () => {
    it("approves EXIT regardless of other conditions", () => {
      const decision = makeDecision({ action: "EXIT", confidence: 0.9 });
      const result = evaluateRisk(riskConfig, decision, makeContext({ recentPnlUsd: -5000 }));
      expect(result.approved).toBe(true);
    });
  });

  describe("drawdown gate", () => {
    it("pauses ENTER on deep drawdown", () => {
      const decision = makeDecision({ action: "ENTER", confidence: 0.8 });
      const result = evaluateRisk(
        riskConfig,
        decision,
        makeContext({ portfolioValueUsd: 10_000, recentPnlUsd: -1100 }),
      );
      expect(result.approved).toBe(false);
      expect(result.reason).toContain("drawdown");
    });
  });

  describe("position size cap", () => {
    it("caps oversized ENTER positions", () => {
      const decision = makeDecision({ action: "ENTER", confidence: 0.8, positionSizeUsd: 5000 });
      const result = evaluateRisk(riskConfig, decision, makeContext({ portfolioValueUsd: 10_000 }));
      expect(result.approved).toBe(true);
      expect(result.adjustedSizeUsd).toBe(3000);
    });
  });

  describe("stop-loss", () => {
    it("rejects HOLD when stop-loss triggered", () => {
      const positions: ReadonlyArray<Position> = [
        {
          id: "pos-1",
          poolAddress: "TestPool111111111111111111111111111111111111",
          poolName: "Test",
          lowerBinId: 4990,
          upperBinId: 5010,
          liquidityShares: 1000n,
          depositedUsd: 1000,
          currentValueUsd: 800,
          unrealizedPnlUsd: -200,
          feesEarnedUsd: 0,
          openedAt: Date.now(),
        },
      ];
      const decision = makeDecision({ action: "HOLD", confidence: 0.8 });
      const result = evaluateRisk(riskConfig, decision, makeContext({ openPositions: positions }));
      expect(result.approved).toBe(false);
      expect(result.reason).toContain("Stop-loss");
    });
  });

  describe("REBALANCE validation", () => {
    it("rejects inverted bin range", () => {
      const decision = makeDecision({
        action: "REBALANCE",
        confidence: 0.8,
        rebalanceParams: { newLowerBinId: 5010, newUpperBinId: 4990, slippageBps: 50 },
      });
      const result = evaluateRisk(riskConfig, decision, makeContext());
      expect(result.approved).toBe(false);
      expect(result.reason).toContain("Invalid rebalance range");
    });

    it("rejects overly wide bin range", () => {
      const decision = makeDecision({
        action: "REBALANCE",
        confidence: 0.8,
        rebalanceParams: { newLowerBinId: 4900, newUpperBinId: 5050, slippageBps: 50 },
      });
      const result = evaluateRisk(riskConfig, decision, makeContext());
      expect(result.approved).toBe(false);
      expect(result.reason).toContain("exceeds max");
    });

    it("approves valid bin range", () => {
      const decision = makeDecision({
        action: "REBALANCE",
        confidence: 0.8,
        rebalanceParams: { newLowerBinId: 4985, newUpperBinId: 5015, slippageBps: 50 },
      });
      const result = evaluateRisk(riskConfig, decision, makeContext());
      expect(result.approved).toBe(true);
    });
  });
});
