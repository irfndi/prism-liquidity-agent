import { describe, it, expect } from "vitest";
import { evaluateRisk, evaluateAgentProposal } from "../engine/risk-service.js";
import type { AgentDecision, AgentProposal, Position } from "../engine/types.js";
import { defaultAppConfig } from "./helpers.js";

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
    poolAddress: string;
  }> = {},
) {
  return {
    openPositions: [] as ReadonlyArray<Position>,
    portfolioValueUsd: 10_000,
    recentPnlUsd: 0,
    poolAddress: "TestPool111111111111111111111111111111111111",
    ...overrides,
  };
}

function makeProposal(overrides: Partial<AgentProposal> = {}): AgentProposal {
  return {
    proposalId: "prop-1",
    proposedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    source: "sync-prompt",
    status: "pending",
    action: "HOLD",
    poolAddress: "TestPool111111111111111111111111111111111111",
    confidence: 0.75,
    reasoning: "Test proposal",
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

  describe("evaluateAgentProposal", () => {
    const appConfig = defaultAppConfig();

    it("approves a valid HOLD proposal", () => {
      const proposal = makeProposal({ action: "HOLD", confidence: 0.8 });
      const result = evaluateAgentProposal(proposal, makeContext(), appConfig);
      expect(result.valid).toBe(true);
      expect(result.adjustedDecision).toBeDefined();
      expect(result.adjustedDecision?.action).toBe("HOLD");
    });

    it("rejects proposals with confidence below the configured minimum", () => {
      const proposal = makeProposal({ confidence: 0.5 });
      const result = evaluateAgentProposal(proposal, makeContext(), appConfig);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Confidence");
    });

    it("rejects proposals with confidence above 1", () => {
      const proposal = makeProposal({ confidence: 1.01 });
      const result = evaluateAgentProposal(proposal, makeContext(), appConfig);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Confidence");
    });

    it("rejects proposals with non-finite confidence", () => {
      const proposal = makeProposal({ confidence: Number.NaN });
      const result = evaluateAgentProposal(proposal, makeContext(), appConfig);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Confidence");
    });

    it("rejects proposals whose poolAddress does not match the evaluated pool", () => {
      const proposal = makeProposal({ poolAddress: "OtherPool111111111111111111111111111111" });
      const result = evaluateAgentProposal(proposal, makeContext(), appConfig);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("poolAddress");
    });

    it("rejects downgrading a safety EXIT to a non-EXIT action", () => {
      const proposal = makeProposal({ action: "HOLD", originalAction: "EXIT" });
      const result = evaluateAgentProposal(proposal, makeContext(), appConfig);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("safety EXIT");
    });

    it("allows an EXIT proposal after a safety EXIT", () => {
      const proposal = makeProposal({ action: "EXIT", originalAction: "EXIT", confidence: 0.9 });
      const result = evaluateAgentProposal(proposal, makeContext(), appConfig);
      expect(result.valid).toBe(true);
      expect(result.adjustedDecision?.action).toBe("EXIT");
    });

    it("rejects promoting a non-ENTER action to ENTER", () => {
      const proposal = makeProposal({
        action: "ENTER",
        originalAction: "HOLD",
        positionSizeUsd: 1_000,
      });
      const result = evaluateAgentProposal(proposal, makeContext(), appConfig);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("promote");
    });

    it("rejects promoting REBALANCE to ENTER", () => {
      const proposal = makeProposal({
        action: "ENTER",
        originalAction: "REBALANCE",
        positionSizeUsd: 1_000,
      });
      const result = evaluateAgentProposal(proposal, makeContext(), appConfig);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("promote");
    });

    it("allows ENTER when the original action was already ENTER", () => {
      const proposal = makeProposal({
        action: "ENTER",
        originalAction: "ENTER",
        positionSizeUsd: 1_000,
      });
      const result = evaluateAgentProposal(proposal, makeContext(), appConfig);
      expect(result.valid).toBe(true);
      expect(result.adjustedDecision?.action).toBe("ENTER");
    });

    it("rejects a negative position size", () => {
      const proposal = makeProposal({ positionSizeUsd: -100 });
      const result = evaluateAgentProposal(proposal, makeContext(), appConfig);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("positionSizeUsd");
    });

    it("caps an oversized ENTER position to the agent proposal max", () => {
      const proposal = makeProposal({ action: "ENTER", positionSizeUsd: 5_000 });
      const result = evaluateAgentProposal(
        proposal,
        makeContext({ portfolioValueUsd: 10_000 }),
        appConfig,
      );
      expect(result.valid).toBe(true);
      expect(result.adjustedDecision?.positionSizeUsd).toBe(4_000);
    });

    it("caps an oversized ENTER position to the per-pool allocation cap", () => {
      const proposal = makeProposal({ action: "ENTER", positionSizeUsd: 5_000 });
      const result = evaluateAgentProposal(
        proposal,
        makeContext({ portfolioValueUsd: 10_000 }),
        defaultAppConfig({
          agentProposalMaxPositionSizePct: 0.5,
          maxPerPoolAllocationPct: 0.3,
        }),
      );
      expect(result.valid).toBe(true);
      expect(result.adjustedDecision?.positionSizeUsd).toBe(3_000);
    });

    it("rejects ENTER when the open-position cap is reached", () => {
      const positions: ReadonlyArray<Position> = [
        {
          id: "p1",
          poolAddress: "P1",
          poolName: "P1",
          lowerBinId: 1,
          upperBinId: 2,
          liquidityShares: 1n,
          depositedUsd: 1,
          currentValueUsd: 1,
          unrealizedPnlUsd: 0,
          feesEarnedUsd: 0,
          openedAt: 0,
        },
        {
          id: "p2",
          poolAddress: "P2",
          poolName: "P2",
          lowerBinId: 1,
          upperBinId: 2,
          liquidityShares: 1n,
          depositedUsd: 1,
          currentValueUsd: 1,
          unrealizedPnlUsd: 0,
          feesEarnedUsd: 0,
          openedAt: 0,
        },
        {
          id: "p3",
          poolAddress: "P3",
          poolName: "P3",
          lowerBinId: 1,
          upperBinId: 2,
          liquidityShares: 1n,
          depositedUsd: 1,
          currentValueUsd: 1,
          unrealizedPnlUsd: 0,
          feesEarnedUsd: 0,
          openedAt: 0,
        },
      ];
      const proposal = makeProposal({ action: "ENTER", positionSizeUsd: 1_000 });
      const result = evaluateAgentProposal(
        proposal,
        makeContext({ openPositions: positions, portfolioValueUsd: 10_000 }),
        defaultAppConfig({ maxOpenPositions: 3 }),
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Max open positions");
    });

    it("rejects an inverted rebalance range", () => {
      const positions: ReadonlyArray<Position> = [
        {
          id: "pos-1",
          poolAddress: "TestPool111111111111111111111111111111111111",
          poolName: "Test",
          lowerBinId: 4990,
          upperBinId: 5010,
          liquidityShares: 1000n,
          depositedUsd: 1000,
          currentValueUsd: 1000,
          unrealizedPnlUsd: 0,
          feesEarnedUsd: 0,
          openedAt: Date.now(),
        },
      ];
      const proposal = makeProposal({
        action: "REBALANCE",
        rebalanceParams: { newLowerBinId: 5010, newUpperBinId: 4990, slippageBps: 50 },
      });
      const result = evaluateAgentProposal(
        proposal,
        makeContext({ openPositions: positions }),
        appConfig,
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Invalid rebalance range");
    });

    it("rejects an overly wide rebalance range", () => {
      const positions: ReadonlyArray<Position> = [
        {
          id: "pos-1",
          poolAddress: "TestPool111111111111111111111111111111111111",
          poolName: "Test",
          lowerBinId: 4990,
          upperBinId: 5010,
          liquidityShares: 1000n,
          depositedUsd: 1000,
          currentValueUsd: 1000,
          unrealizedPnlUsd: 0,
          feesEarnedUsd: 0,
          openedAt: Date.now(),
        },
      ];
      const proposal = makeProposal({
        action: "REBALANCE",
        rebalanceParams: { newLowerBinId: 4900, newUpperBinId: 5050, slippageBps: 50 },
      });
      const result = evaluateAgentProposal(
        proposal,
        makeContext({ openPositions: positions }),
        appConfig,
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("exceeds max");
    });

    it("approves a valid rebalance range", () => {
      const positions: ReadonlyArray<Position> = [
        {
          id: "pos-1",
          poolAddress: "TestPool111111111111111111111111111111111111",
          poolName: "Test",
          lowerBinId: 4990,
          upperBinId: 5010,
          liquidityShares: 1000n,
          depositedUsd: 1000,
          currentValueUsd: 1000,
          unrealizedPnlUsd: 0,
          feesEarnedUsd: 0,
          openedAt: Date.now(),
        },
      ];
      const proposal = makeProposal({
        action: "REBALANCE",
        rebalanceParams: { newLowerBinId: 4985, newUpperBinId: 5015, slippageBps: 50 },
      });
      const result = evaluateAgentProposal(
        proposal,
        makeContext({ openPositions: positions }),
        appConfig,
      );
      expect(result.valid).toBe(true);
      expect(result.adjustedDecision?.rebalanceParams).toBeDefined();
    });
  });
});
