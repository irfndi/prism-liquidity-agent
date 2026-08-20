/** Backtest replay fidelity: empty-bin snapshots are UNKNOWN (not 0) so the
 * replay admits (the paper DB stores bins:[] for every row — the old replay
 * rejected every tick), rejections carry live-vocabulary tags, and the result
 * reports the admit/reject census + winrate by exit reason. */
import { describe, expect, it } from "vitest";
import {
  aggregateBacktestResults,
  createSeededRandom,
  generateMockHistory,
  parseArgs,
  parseSeedList,
  rankBacktestResults,
  runBacktestFromTicks,
  snapshotsToTicks,
  type BacktestConfig,
} from "../ops/backtest.js";
import type { BacktestResult } from "../engine/types.js";
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

function makeResult(overrides: Partial<BacktestResult>): BacktestResult {
  return {
    poolAddress: "RankingPool111111111111111111111111111111111111",
    startDate: 1,
    endDate: 2,
    initialValueUsd: 10_000,
    finalValueUsd: 10_000,
    totalFeesUsd: 0,
    totalIlUsd: 0,
    netPnlUsd: 0,
    totalRebalances: 0,
    winRate: 0,
    sharpeRatio: 0,
    ...overrides,
  };
}

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
  describe("synthetic sweep parsing", () => {
    it("parses a bounded comma-separated unsigned 32-bit seed list", () => {
      expect(parseSeedList("0, 42, 4294967295")).toEqual([0, 42, 4294967295]);
      expect(parseArgs(["--seeds", "0,42"]).seeds).toEqual([0, 42]);
    });

    it("rejects malformed, duplicate, and over-limit seed lists", () => {
      expect(() => parseSeedList("1,,2")).toThrow(/comma-separated list/);
      expect(() => parseSeedList("1,1")).toThrow(/duplicate/);
      expect(() => parseSeedList("4294967296")).toThrow(/unsigned 32-bit/);
      expect(() => parseArgs(["--seeds"])).toThrow(/comma-separated list/);
      expect(() => parseSeedList(Array.from({ length: 33 }, (_, i) => `${i}`).join(","))).toThrow(
        /at most 32 seeds/,
      );
    });

    it("rejects replay sweeps and mixing --seed with --seeds", () => {
      expect(() => parseArgs(["--source", "replay", "--seeds", "1,2"])).toThrow(
        /only supported with the synthetic source/,
      );
      expect(() => parseArgs(["--seed", "1", "--seeds", "2,3"])).toThrow(/mutually exclusive/);
    });

    it("parses zero-default execution costs and validates bounded nonnegative values", () => {
      expect(parseArgs([])).toMatchObject({
        entryCostBps: 0,
        exitCostBps: 0,
        fixedActionCostUsd: 0,
      });
      expect(
        parseArgs([
          "--entry-cost-bps",
          "12.5",
          "--exit-cost-bps",
          "25",
          "--fixed-action-cost-usd",
          "1.75",
        ]),
      ).toMatchObject({ entryCostBps: 12.5, exitCostBps: 25, fixedActionCostUsd: 1.75 });
      expect(() => parseArgs(["--entry-cost-bps", "-1"])).toThrow(/finite, nonnegative/);
      expect(() => parseArgs(["--exit-cost-bps", "10001"])).toThrow(/at most 10000 bps/);
      expect(() => parseArgs(["--fixed-action-cost-usd", "Infinity"])).toThrow(
        /finite, nonnegative/,
      );
    });

    it("parses and validates the optional fee-share dilution reference width", () => {
      expect(parseArgs([]).feeShareDilutionRefWidth).toBeUndefined();
      expect(parseArgs(["--fee-share-ref-width", "250"]).feeShareDilutionRefWidth).toBe(250);
      expect(parseArgs(["--fee-share-ref-width", "0"]).feeShareDilutionRefWidth).toBe(0);
      expect(() => parseArgs(["--fee-share-ref-width", "-1"])).toThrow(/finite, nonnegative/);
      expect(() => parseArgs(["--fee-share-ref-width", "10001"])).toThrow(/at most 10000 bins/);
    });
  });

  describe("synthetic sweep aggregation", () => {
    it("reports mean, stability, ranges, and profitable-run count per configuration", () => {
      const aggregates = aggregateBacktestResults([
        { name: "C1", seed: 1, result: makeResult({ netPnlUsd: 10, winRate: 0.2 }) },
        { name: "C1", seed: 2, result: makeResult({ netPnlUsd: 30, winRate: 0.6 }) },
        { name: "C2", seed: 1, result: makeResult({ netPnlUsd: -5, winRate: 0.4 }) },
      ]);

      expect(aggregates).toHaveLength(2);
      expect(aggregates[0]).toMatchObject({
        name: "C1",
        seedCount: 2,
        meanNetPnlUsd: 20,
        netPnlStdDevUsd: 10,
        minNetPnlUsd: 10,
        maxNetPnlUsd: 30,
        meanWinRate: 0.4,
        minWinRate: 0.2,
        maxWinRate: 0.6,
        profitableRuns: 2,
      });
      expect(aggregates[0]!.winRateStdDev).toBeCloseTo(0.2);
      expect(aggregates[1]).toEqual({
        name: "C2",
        seedCount: 1,
        meanNetPnlUsd: -5,
        netPnlStdDevUsd: 0,
        minNetPnlUsd: -5,
        maxNetPnlUsd: -5,
        meanWinRate: 0.4,
        winRateStdDev: 0,
        minWinRate: 0.4,
        maxWinRate: 0.4,
        profitableRuns: 0,
      });
    });
  });

  describe("round-trip execution costs", () => {
    const roundTripTicks = snapshotsToTicks([
      makeSnapshot({
        timestamp: 1_800_000_000_000,
        fees24hUsd: 12_000,
        activeBinId: 5000,
        currentPrice: 150,
        binArray: makeBinArray(5000),
      }),
      makeSnapshot({
        timestamp: 1_800_000_600_000,
        fees24hUsd: 12_000,
        activeBinId: 5000,
        currentPrice: 150,
        binArray: makeBinArray(5000),
      }),
      makeSnapshot({
        timestamp: 1_801_200_000_000,
        fees24hUsd: 12_000,
        activeBinId: 5002,
        currentPrice: 150 * Math.pow(1.001, 2),
        binArray: makeBinArray(5002),
      }),
    ]);

    const roundTripConfig: BacktestConfig = {
      ...BASE_CONFIG,
      halfWidth: 1,
      ilProtectionEnabled: true,
      ilDominanceExitFactor: 0,
      ilDominanceMinUsd: 0,
    };

    it("preserves exact results when all execution costs are explicitly zero", () => {
      const implicitZero = runBacktestFromTicks(roundTripTicks, roundTripConfig);
      const explicitZero = runBacktestFromTicks(roundTripTicks, {
        ...roundTripConfig,
        entryCostBps: 0,
        exitCostBps: 0,
        fixedActionCostUsd: 0,
      });
      expect(explicitZero).toEqual(implicitZero);
    });

    it("makes a fee-poor completed round trip negative when costs are enabled", () => {
      const noCosts = runBacktestFromTicks(roundTripTicks, roundTripConfig);
      const withCosts = runBacktestFromTicks(roundTripTicks, {
        ...roundTripConfig,
        entryCostBps: 100,
        exitCostBps: 100,
        fixedActionCostUsd: 25,
      });
      const exits = Object.values(withCosts.exitsByReason ?? {}).reduce(
        (sum, count) => sum + count,
        0,
      );

      expect(exits).toBe(1);
      expect(noCosts.netPnlUsd).toBeGreaterThan(0);
      expect(withCosts.netPnlUsd).toBeLessThan(0);
      expect(withCosts.netPnlUsd).toBeLessThan(noCosts.netPnlUsd);
    });
  });

  it("produces identical synthetic history for the same seed and end time", () => {
    const first = generateMockHistory(
      "SeedPool1111111111111111111111111111111111111",
      1,
      100_000,
      createSeededRandom(42),
      1_700_000_000_000,
    );
    const second = generateMockHistory(
      "SeedPool1111111111111111111111111111111111111",
      1,
      100_000,
      createSeededRandom(42),
      1_700_000_000_000,
    );

    expect(second).toEqual(first);
  });

  it("produces different synthetic history for different seeds", () => {
    const first = generateMockHistory(
      "SeedPool1111111111111111111111111111111111111",
      1,
      100_000,
      createSeededRandom(42),
      1_700_000_000_000,
    );
    const second = generateMockHistory(
      "SeedPool1111111111111111111111111111111111111",
      1,
      100_000,
      createSeededRandom(43),
      1_700_000_000_000,
    );

    expect(second).not.toEqual(first);
  });

  describe("configuration ranking", () => {
    it("ranks net PnL ahead of win rate", () => {
      const ranked = rankBacktestResults([
        {
          name: "high-win-rate-loser",
          result: makeResult({ netPnlUsd: -100, winRate: 0.95 }),
        },
        {
          name: "profitable-lower-win-rate",
          result: makeResult({ netPnlUsd: 250, winRate: 0.4 }),
        },
      ]);

      expect(ranked.map(({ name }) => name)).toEqual([
        "profitable-lower-win-rate",
        "high-win-rate-loser",
      ]);
    });

    it("uses deterministic tie-breakers after net PnL", () => {
      const ranked = rankBacktestResults([
        {
          name: "zeta",
          result: makeResult({ netPnlUsd: 100, winRate: 0.5, sharpeRatio: 1 }),
        },
        {
          name: "alpha",
          result: makeResult({ netPnlUsd: 100, winRate: 0.5, sharpeRatio: 1 }),
        },
      ]);

      expect(ranked.map(({ name }) => name)).toEqual(["alpha", "zeta"]);
    });
  });

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
    expect(result.winrateByExitReason).toBeTypeOf("object");
    expect(result.avgHoldHoursByExitReason).toBeTypeOf("object");
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
