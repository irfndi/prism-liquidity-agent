import { describe, expect, it } from "vitest";
import { evaluateReplayPool } from "../engine/cycle/evaluate-pool.js";
import type { PoolMetrics } from "../engine/types.js";

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
  },
  proposedSizeUsd: 9_000,
  range: { lowerBinId: 90, upperBinId: 110 },
} as const;

describe("evaluateReplayPool", () => {
  it("caps an ENTER through the same per-pool risk gate as the engine", () => {
    const result = evaluateReplayPool({ ...base, position: undefined });

    expect(result.decision.action).toBe("ENTER");
    expect(result.riskApproved).toBe(true);
    expect(result.adjustedSizeUsd).toBe(4_000);
  });

  it("forces a capital-protection EXIT when the trailing stop is breached", () => {
    const result = evaluateReplayPool({
      ...base,
      position: {
        poolAddress: "pool-a",
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
      memoryWarningCount: 3,
    });

    expect(result.riskApproved).toBe(false);
    expect(result.riskReason).toContain("below threshold");
  });
});
