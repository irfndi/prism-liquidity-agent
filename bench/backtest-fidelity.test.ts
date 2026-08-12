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

  it("rejections carry live-vocabulary tags and the census is consistent (tolerate=true admits)", () => {
    // With empty-bin tolerance ON, the replay ADMITS — exercising the
    // admitted-counts-as-an-attempt invariant that the all-rejected case
    // cannot prove.
    const result = runWithBins(
      { lowerBinId: 4980, upperBinId: 5020, bins: [], activeBinId: 5000 },
      true,
    );
    const rejectSum = Object.values(result.rejectionsByReason ?? {}).reduce((a, b) => a + b, 0);
    expect(result.admitted ?? 0).toBeGreaterThan(0);
    expect(result.enterAttempts).toBe((result.admitted ?? 0) + rejectSum);
    for (const tag of Object.keys(result.rejectionsByReason ?? {})) {
      expect(tag).toMatch(/^\[.*\]$/); // live-vocabulary bracket tags
    }
  }, 15_000);

  it("the result shape includes winrate + avg-hold by exit reason", () => {
    const result = runWithBins(makeBinArray(5000), true);
    expect(typeof result.winrateByExitReason).toBe("object");
    expect(typeof result.avgHoldHoursByExitReason).toBe("object");
    expect(result.avgHoldHoursByExitReason).toBeDefined();
  }, 15_000);

  describe("concentration-aware fee share (feeShareDilutionRefWidth)", () => {
    // Two ticks: admission on the first, then a stable in-range hold. The
    // `fees24hUsd` is identical on both, so a wider range collects MORE total
    // fees only through the dilution option — this isolates width-independent
    // (default) vs concentration-penalized (opt-in) fee accounting.
    const ticks = snapshotsToTicks([
      makeSnapshot({ timestamp: 1_800_000_000_000 }),
      makeSnapshot({ timestamp: 1_800_600_000, currentPrice: 150, tvlUsd: 100_000 }),
      makeSnapshot({ timestamp: 1_801_200_000, currentPrice: 150, tvlUsd: 100_000 }),
    ]);

    it("default: width-independent fee share (higher fees for wider ranges)", () => {
      const wide = runBacktestFromTicks(ticks, {
        ...BASE_CONFIG,
        halfWidth: 40,
        minPriceCoveragePct: 0,
      });
      const narrow = runBacktestFromTicks(ticks, {
        ...BASE_CONFIG,
        halfWidth: 4,
        minPriceCoveragePct: 0,
      });
      // Both ranges are in-range the whole time; the wider range accrues the
      // same or more fees because the model ignores density.
      expect(wide.totalFeesUsd).toBeGreaterThanOrEqual(narrow.totalFeesUsd);
    }, 15_000);

    it("opt-in dilution scales the in-range fee share by refWidth/effectiveWidth", () => {
      const diluted = runBacktestFromTicks(ticks, {
        ...BASE_CONFIG,
        halfWidth: 40,
        minPriceCoveragePct: 0,
        feeShareDilutionRefWidth: 4, // 4/40 = 0.1 → ~10% of the undiluted share
      });
      const undiluted = runBacktestFromTicks(ticks, {
        ...BASE_CONFIG,
        halfWidth: 40,
        minPriceCoveragePct: 0,
      });
      // The diluted position captures roughly a tenth of the fees.
      expect(diluted.totalFeesUsd).toBeLessThan(0.25 * undiluted.totalFeesUsd);
      expect(diluted.totalFeesUsd).toBeGreaterThan(0);
    }, 15_000);

    it("dilution is capped at 1 (never inflates beyond the width-independent model)", () => {
      // ref > effective → dilution = 1 → identical to no dilution.
      const capped = runBacktestFromTicks(ticks, {
        ...BASE_CONFIG,
        halfWidth: 4,
        feeShareDilutionRefWidth: 100,
      });
      const plain = runBacktestFromTicks(ticks, { ...BASE_CONFIG, halfWidth: 4 });
      expect(capped.totalFeesUsd).toBe(plain.totalFeesUsd);
    }, 15_000);
  });
});
