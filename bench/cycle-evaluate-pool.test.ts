import { describe, expect, it } from "vitest";
import { evaluateReplayPool } from "../engine/cycle/evaluate-pool.js";
import { evaluateRisk } from "../engine/risk-service.js";
import type { PoolMetrics, Position } from "../engine/types.js";

const metrics: PoolMetrics = {
  pool: {} as PoolMetrics["pool"],
  binArray: {} as PoolMetrics["binArray"],
  tvlVelocity: 0,
  feeIlRatio: 2,
  volumeAuthenticity: 0.9,
  binUtilization: 0.8,
  volumeAuthenticityKnown: true,
  binUtilizationKnown: true,
  farmAprPct: null,
};

const base = {
  poolAddress: "pool-a",
  activeBinId: 100,
  metrics,
  portfolioValueUsd: 10_000,
  recentPnlUsd: 0,
  memoryWarningCount: 0,
  confidenceThreshold: 0.65,
  trailingStopPct: 0.1,
  risk: {
    confidenceThreshold: 0.65,
    maxRebalanceRangeBins: 50,
    stopLossPct: 0.15,
    maxPerPoolAllocationPct: 0.4,
    maxPositionsPerPool: 2,
  },
  proposedSizeUsd: 9_000,
} as const;

describe("evaluateReplayPool", () => {
  it("caps an ENTER through the same per-pool risk gate as the engine", () => {
    const result = evaluateReplayPool({ ...base, position: undefined, openPositions: [] });

    expect(result.decision.action).toBe("ENTER");
    expect(result.riskApproved).toBe(true);
    expect(result.adjustedSizeUsd).toBe(4_000);
  });

  it("forces a capital-protection EXIT when the trailing stop is breached", () => {
    const result = evaluateReplayPool({
      ...base,
      openPositions: [],
      position: {
        poolAddress: "pool-a",
        positionPubKey: "position-1",
        lowerBinId: 90,
        upperBinId: 110,
        depositedUsd: 1_000,
        currentValueUsd: 800,
        highestValueUsd: 1_000,
      },
    });

    expect(result.decision.action).toBe("EXIT");
    expect(result.riskApproved).toBe(true);
    expect(result.riskReason).toContain("capital protection");
  });

  it("lets recent memory warnings reduce confidence below the gate", () => {
    const result = evaluateReplayPool({
      ...base,
      position: undefined,
      openPositions: [],
      memoryWarningCount: 3,
    });

    expect(result.riskApproved).toBe(false);
    expect(result.riskReason).toContain("below threshold");
  });

  it("matches the engine decision for a recorded trailing-stop snapshot", () => {
    const position = {
      poolAddress: "pool-a",
      positionPubKey: "position-1",
      lowerBinId: 90,
      upperBinId: 110,
      depositedUsd: 1_000,
      currentValueUsd: 800,
      highestValueUsd: 1_000,
    };
    const replay = evaluateReplayPool({
      ...base,
      position,
      openPositions: [position],
    });
    const enginePosition: Position = {
      id: position.positionPubKey,
      poolAddress: position.poolAddress,
      poolName: position.poolAddress,
      lowerBinId: position.lowerBinId,
      upperBinId: position.upperBinId,
      liquidityShares: 0n,
      depositedUsd: position.depositedUsd,
      currentValueUsd: position.currentValueUsd,
      unrealizedPnlUsd: position.currentValueUsd - position.depositedUsd,
      feesEarnedUsd: 0,
      openedAt: 1_700_000_000_000,
    };
    const engineRisk = evaluateRisk(
      base.risk,
      {
        action: "EXIT",
        poolAddress: position.poolAddress,
        confidence: 0.8,
        reasoning: "Trailing stop from recorded snapshot",
      },
      {
        openPositions: [enginePosition],
        portfolioValueUsd: base.portfolioValueUsd,
        recentPnlUsd: 0,
        poolAddress: position.poolAddress,
        activeBinId: base.activeBinId,
      },
    );

    expect(replay.decision.action).toBe("EXIT");
    expect(replay.riskApproved).toBe(engineRisk.approved);
    expect(replay.decision.poolAddress).toBe(position.poolAddress);
  });

  it("rejects ENTER when the W10 per-pool position cap is reached", () => {
    const positions = [1, 2].map((index) => ({
      poolAddress: "pool-a",
      positionPubKey: `position-${index}`,
      lowerBinId: 90,
      upperBinId: 110,
      depositedUsd: 1_000,
      currentValueUsd: 1_000,
      highestValueUsd: 1_000,
    }));
    const result = evaluateReplayPool({
      ...base,
      position: undefined,
      openPositions: positions,
    });

    expect(result.riskApproved).toBe(false);
    expect(result.riskReason).toContain("Per-pool position cap reached");
  });
});
