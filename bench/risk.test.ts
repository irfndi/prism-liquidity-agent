import { describe, it, expect, beforeEach } from "vitest";
import { RiskEngine } from "../engine/risk/gate.js";
import type { AgentDecision, Position } from "../engine/types.js";
import type { RiskContext } from "../engine/risk/gate.js";

function makeDecision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return {
    action: "HOLD",
    poolAddress: "TestPool111111111111111111111111111111111111",
    confidence: 0.75,
    reasoning: "Test decision",
    ...overrides,
  };
}

function makeContext(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    openPositions: [],
    portfolioValueUsd: 10_000,
    recentPnlUsd: 0,
    ...overrides,
  };
}

describe("RiskEngine", () => {
  let engine: RiskEngine;

  beforeEach(() => {
    engine = new RiskEngine();
  });

  describe("confidence gate", () => {
    it("rejects decisions below confidence threshold", () => {
      const decision = makeDecision({ confidence: 0.5 });
      const result = engine.evaluate(decision, makeContext());
      expect(result.approved).toBe(false);
      expect(result.reason).toContain("Confidence");
    });

    it("approves decisions at threshold", () => {
      const decision = makeDecision({ confidence: 0.65 });
      const result = engine.evaluate(decision, makeContext());
      expect(result.approved).toBe(true);
    });
  });

  describe("concurrent positions cap", () => {
    it("rejects ENTER when max positions reached", () => {
      const positions: Position[] = Array.from({ length: 5 }, (_, i) => ({
        id: `pos-${i}`,
        poolAddress: `Pool${i}`,
        poolName: `Pool${i}`,
        lowerBinId: 4990,
        upperBinId: 5010,
        liquidityShares: 1000n,
        depositedUsd: 2000,
        currentValueUsd: 2100,
        unrealizedPnlUsd: 100,
        feesEarnedUsd: 50,
        openedAt: Date.now(),
      }));

      const decision = makeDecision({ action: "ENTER", confidence: 0.80 });
      const ctx = makeContext({ openPositions: positions });
      const result = engine.evaluate(decision, ctx);
      expect(result.approved).toBe(false);
      expect(result.reason).toContain("Max concurrent");
    });
  });

  describe("EXIT always approved", () => {
    it("approves EXIT regardless of other conditions", () => {
      const decision = makeDecision({ action: "EXIT", confidence: 0.90 });
      const result = engine.evaluate(decision, makeContext({ recentPnlUsd: -5000 }));
      expect(result.approved).toBe(true);
    });
  });

  describe("drawdown gate", () => {
    it("pauses ENTER on deep drawdown", () => {
      const decision = makeDecision({ action: "ENTER", confidence: 0.80 });
      const ctx = makeContext({ portfolioValueUsd: 10_000, recentPnlUsd: -1100 });
      const result = engine.evaluate(decision, ctx);
      expect(result.approved).toBe(false);
      expect(result.reason).toContain("drawdown");
    });
  });

  describe("position size cap", () => {
    it("caps oversized ENTER positions", () => {
      const decision = makeDecision({
        action: "ENTER",
        confidence: 0.80,
        positionSizeUsd: 5000, // 50% of portfolio
      });
      const ctx = makeContext({ portfolioValueUsd: 10_000 });
      const result = engine.evaluate(decision, ctx);
      expect(result.approved).toBe(true);
      expect(result.adjustedSizeUsd).toBe(3000); // 30% cap
    });
  });

  describe("REBALANCE validation", () => {
    it("rejects inverted bin range", () => {
      const decision = makeDecision({
        action: "REBALANCE",
        confidence: 0.80,
        rebalanceParams: { newLowerBinId: 5010, newUpperBinId: 4990, slippageBps: 50 },
      });
      const result = engine.evaluate(decision, makeContext());
      expect(result.approved).toBe(false);
      expect(result.reason).toContain("Invalid rebalance range");
    });

    it("rejects overly wide bin range", () => {
      const decision = makeDecision({
        action: "REBALANCE",
        confidence: 0.80,
        rebalanceParams: { newLowerBinId: 4900, newUpperBinId: 5050, slippageBps: 50 },
      });
      const result = engine.evaluate(decision, makeContext());
      expect(result.approved).toBe(false);
      expect(result.reason).toContain("too wide");
    });

    it("approves valid bin range", () => {
      const decision = makeDecision({
        action: "REBALANCE",
        confidence: 0.80,
        rebalanceParams: { newLowerBinId: 4985, newUpperBinId: 5015, slippageBps: 50 },
      });
      const result = engine.evaluate(decision, makeContext());
      expect(result.approved).toBe(true);
    });
  });
});

