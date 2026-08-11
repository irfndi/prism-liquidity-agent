/** Backtest replay fidelity: empty-bin snapshots are UNKNOWN (not 0) so the
 * replay admits (the paper DB stores bins:[] for every row — the old replay
 * rejected every tick), rejections carry live-vocabulary tags, and the result
 * reports the admit/reject census + winrate by exit reason. */
import { describe, expect, it } from "vitest";
import { runBacktestFromTicks, snapshotsToTicks, type BacktestConfig } from "../ops/backtest.js";
import { makeBinArray } from "./helpers.js";
import type { PoolSnapshot } from "../engine/types.js";

function makeSnapshot(overrides: Partial<PoolSnapshot> = {}): PoolSnapshot {
  return {
    poolAddress: "BacktestPool11111111111111111111111111111111111",
    timestamp: 1_800_000_000_000,
    activeBinId: 5000,
    tvlUsd: 100_000,
    volume24hUsd: 30_000,
    fees24hUsd: 300,
    apr: 60,
    currentPrice: 150,
    binStep: 10,
    tokenXSymbol: "SOL",
    tokenYSymbol: "USDC",
    binArray: makeBinArray(5000),
    ...overrides,
  };
}

const BASE_CONFIG: BacktestConfig = {
  halfWidth: 10,
  driftThreshold: 0.1,
  minHoldTicks: 2,
  minNetBenefitUsd: 0,
  maxRebalances: 5,
  maxPositionsPerPool: 2,
};

function runWithBins(
  bins: PoolSnapshot["binArray"],
  tolerate: boolean,
): ReturnType<typeof runBacktestFromTicks> {
  const ticks = snapshotsToTicks([
    makeSnapshot({ timestamp: 1_800_000_000_000, binArray: bins }),
    makeSnapshot({ timestamp: 1_800_600_000, binArray: bins }),
    makeSnapshot({ timestamp: 1_801_200_000, binArray: bins }),
  ]);
  return runBacktestFromTicks(ticks, { ...BASE_CONFIG, backtestTolerateEmptyBins: tolerate });
}

describe("backtest replay fidelity", () => {
  it("empty-bin snapshots pass the pre-filter by default (tolerate=true)", () => {
    const result = runWithBins(
      { lowerBinId: 4980, upperBinId: 5020, bins: [], activeBinId: 5000 },
      true,
    );
    // With bin utilization UNKNOWN and tolerated, the replay reaches the risk
    // gate — bin-util is not the reject reason. Admitted >= 0 and the census
    // exists; the key assertion: no bin-utilization-mass rejection dominates.
    expect(result.admitted ?? 0).toBeGreaterThanOrEqual(0);
    const binUtilRejects = result.rejectionsByReason?.["[bin-util]"] ?? 0;
    expect(binUtilRejects).toBe(0);
  }, 15_000);

  it("empty-bin snapshots reject when tolerate=false (parity with the old replay)", () => {
    const result = runWithBins(
      { lowerBinId: 4980, upperBinId: 5020, bins: [], activeBinId: 5000 },
      false,
    );
    // Unknown degrades to 0 -> the pre-filter rejects every tick.
    expect(result.admitted ?? 0).toBe(0);
    expect(result.enterAttempts).toBeGreaterThan(0);
  }, 15_000);

  it("full-bin snapshots behave identically regardless of the tolerance flag", () => {
    const bins = makeBinArray(5000);
    const withTolerance = runWithBins(bins, true);
    const without = runWithBins(bins, false);
    expect(withTolerance.admitted ?? 0).toBe(without.admitted ?? 0);
  }, 15_000);

  it("rejections carry live-vocabulary tags and the census is consistent", () => {
    const result = runWithBins(
      { lowerBinId: 4980, upperBinId: 5020, bins: [], activeBinId: 5000 },
      false,
    );
    const rejectSum = Object.values(result.rejectionsByReason ?? {}).reduce((a, b) => a + b, 0);
    // Every no-position tick is an attempt; each attempt is either admitted
    // or rejected with a tag.
    expect(result.enterAttempts).toBeGreaterThan(0);
    expect(rejectSum).toBeGreaterThan(0);
    expect(result.enterAttempts).toBe((result.admitted ?? 0) + rejectSum);
  }, 15_000);

  it("the result shape includes winrate + avg-hold by exit reason", () => {
    const result = runWithBins(makeBinArray(5000), true);
    expect(typeof result.winrateByExitReason).toBe("object");
    expect(typeof result.avgHoldHoursByExitReason).toBe("object");
    expect(result.avgHoldHoursByExitReason).toBeDefined();
  }, 15_000);
});
