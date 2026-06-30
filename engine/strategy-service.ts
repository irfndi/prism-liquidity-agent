import { Context, Layer } from "effect";
import { StrategyService, type StrategyApi } from "./services.js";
import type { BinArray, PoolMetrics, PoolState } from "./types.js";

export const DLMMStrategy: StrategyApi = {
  computeMetrics(pool: PoolState, binArray: BinArray, previousTvlUsd: number): PoolMetrics {
    const tvlVelocity = previousTvlUsd > 0 ? (pool.tvlUsd - previousTvlUsd) / previousTvlUsd : 0;

    const feeIlRatio = DLMMStrategy.computeFeeIlRatio(pool, binArray);
    const volumeAuthenticity = DLMMStrategy.checkVolumeAuthenticity(pool);
    const binUtilization = DLMMStrategy.computeBinUtilization(binArray);

    return {
      pool,
      binArray,
      tvlVelocity,
      feeIlRatio,
      volumeAuthenticity: volumeAuthenticity.score,
      binUtilization,
    };
  },

  computeFeeIlRatio(pool: PoolState, binArray: BinArray): number {
    if (pool.tvlUsd === 0) return 0;

    const activeBin = binArray.bins.find((b) => b.binId === binArray.activeBinId);
    if (!activeBin) return 0;

    const rangeCenter = (binArray.lowerBinId + binArray.upperBinId) / 2;
    const binsDrifted = Math.abs(binArray.activeBinId - rangeCenter);
    const binStep = binArray.binStep ?? 10;

    const priceRatio = Math.pow(1 + binStep / 10_000, binsDrifted);
    const ilFraction = (2 * Math.sqrt(priceRatio)) / (1 + priceRatio) - 1;
    const estimatedIlUsd = pool.tvlUsd * Math.abs(ilFraction);
    const estimatedIlDaily = estimatedIlUsd / 365;

    if (estimatedIlDaily === 0) return pool.fees24hUsd > 0 ? 999 : 0;
    return pool.fees24hUsd / estimatedIlDaily;
  },

  checkVolumeAuthenticity(pool: PoolState): {
    score: number;
    flags: ReadonlyArray<string>;
  } {
    const flags: string[] = [];
    let score = 1.0;

    if (pool.tvlUsd === 0) {
      return { score: 0, flags: ["zero-tvl"] };
    }

    const volTvlRatio = pool.volume24hUsd / pool.tvlUsd;

    if (volTvlRatio > 10) {
      score -= 0.3;
      flags.push(`vol/tvl=${volTvlRatio.toFixed(1)}x (suspicious)`);
    } else if (volTvlRatio > 5) {
      score -= 0.15;
      flags.push(`vol/tvl=${volTvlRatio.toFixed(1)}x (elevated)`);
    }

    if (pool.volume24hUsd > 0) {
      const feeRate = pool.fees24hUsd / pool.volume24hUsd;
      if (feeRate < 0.0002 || feeRate > 0.02) {
        score -= 0.2;
        flags.push(`fee-rate=${(feeRate * 100).toFixed(4)}% (outlier)`);
      }
    }

    if (pool.tvlUsd < 5000 && pool.volume24hUsd > 100000) {
      score -= 0.5;
      flags.push("low-tvl high-volume (possible wash)");
    }

    return { score: Math.max(0, score), flags };
  },

  computeBinUtilization(binArray: BinArray): number {
    const total = binArray.bins.length;
    if (total === 0) return 0;

    const active = binArray.bins.filter(
      (b) => b.reserveX > 0n || b.reserveY > 0n || b.liquiditySupply > 0n,
    ).length;

    return active / total;
  },

  recommendBinRange(
    activeBinId: number,
    binStep: number,
  ): { lowerBinId: number; upperBinId: number } {
    const halfWidth = binStep <= 10 ? 25 : binStep <= 25 ? 20 : 15;
    return {
      lowerBinId: activeBinId - halfWidth,
      upperBinId: activeBinId + halfWidth,
    };
  },

  passesPreFilter(
    pool: PoolState,
    authScore: number,
    binUtilization: number,
    minTvlUsd: number,
    minAuthScore: number,
    minBinUtilization: number,
  ): boolean {
    return (
      pool.tvlUsd > 0 &&
      pool.tvlUsd >= minTvlUsd &&
      authScore >= minAuthScore &&
      binUtilization >= minBinUtilization
    );
  },
};

export const StrategyLive = Layer.succeed(StrategyService, StrategyService.of(DLMMStrategy));

// ─── F2: Volatility-adjusted range sizing ────────────────────────────────────

/**
 * Sample standard deviation of the active bin over recent snapshots. Returns 0
 * for empty or single-point series. Used as the "high-vol" detector.
 */
export function computeBinVolatilityStddev(activeBins: ReadonlyArray<number>): number {
  if (activeBins.length < 2) return 0;
  const mean = activeBins.reduce((s, v) => s + v, 0) / activeBins.length;
  const variance =
    activeBins.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (activeBins.length - 1);
  return Math.sqrt(variance);
}

/** Returns true when the stddev of recent bin moves exceeds the configured threshold. */
export function isHighVolatility(stddev: number, threshold: number): boolean {
  return stddev >= threshold;
}

/**
 * Pick a bin-range half-width based on the bin step, widened when the pool is
 * currently in a high-volatility regime. High-vol gets a much wider range to
 * avoid constant rebalancing.
 */
export function recommendBinRangeForVolatility(
  activeBinId: number,
  binStep: number,
  highVolatility: boolean,
): { lowerBinId: number; upperBinId: number; halfWidth: number } {
  const baseHalfWidth = binStep <= 10 ? 25 : binStep <= 25 ? 20 : 15;
  const halfWidth = highVolatility ? Math.max(baseHalfWidth * 2, 50) : baseHalfWidth;
  return {
    lowerBinId: activeBinId - halfWidth,
    upperBinId: activeBinId + halfWidth,
    halfWidth,
  };
}
