import { createLogger } from "../logger.js";
import type { BinArray, PoolMetrics, PoolState } from "../types.js";
import { config } from "../config.js";

const log = createLogger("DLMMStrategy");

export interface VolumeAuthResult {
  score: number; // 0–1
  flags: string[];
}

export class DLMMStrategy {
  /**
   * Compute composite pool metrics from raw pool + bin data.
   * These values feed directly into the Claude agent's tool response.
   */
  computeMetrics(
    pool: PoolState,
    binArray: BinArray,
    previousTvlUsd: number
  ): PoolMetrics {
    const tvlVelocity =
      previousTvlUsd > 0
        ? (pool.tvlUsd - previousTvlUsd) / previousTvlUsd
        : 0;

    const feeIlRatio = this.computeFeeIlRatio(pool, binArray);
    const volumeAuthenticity = this.checkVolumeAuthenticity(pool);
    const binUtilization = this.computeBinUtilization(binArray);

    return {
      pool,
      binArray,
      tvlVelocity,
      feeIlRatio,
      volumeAuthenticity: volumeAuthenticity.score,
      binUtilization,
    };
  }

  /**
   * Fee / IL ratio. > 1.0 means fees are covering impermanent loss.
   *
   * IL estimation uses the DLMM bin step to convert bin drift into a price ratio,
   * then applies the standard CPMM IL formula: IL = 2√r/(1+r) − 1 where r is the
   * price ratio between entry and current price. Each DLMM bin covers exactly
   * (1 + binStep/10_000) of price, so d bins of drift → r = (1 + bs/10_000)^d.
   * Prior model used a flat 0.2% per full drift which underestimates IL on
   * high-step pools (binStep 25+) and overestimates on tight-step pairs.
   */
  computeFeeIlRatio(pool: PoolState, binArray: BinArray): number {
    if (pool.tvlUsd === 0) return 0;

    const activeBin = binArray.bins.find((b) => b.binId === binArray.activeBinId);
    if (!activeBin) return 0;

    const rangeCenter = (binArray.lowerBinId + binArray.upperBinId) / 2;
    const binsDrifted = Math.abs(binArray.activeBinId - rangeCenter);
    const binStep = binArray.binStep ?? 10; // fallback to 10bps if missing

    // Price ratio at current active bin vs range center
    const priceRatio = Math.pow(1 + binStep / 10_000, binsDrifted);
    // Standard CPMM IL formula
    const ilFraction = 2 * Math.sqrt(priceRatio) / (1 + priceRatio) - 1;
    const estimatedIlUsd = pool.tvlUsd * Math.abs(ilFraction);
    const estimatedIlDaily = estimatedIlUsd / 365;

    if (estimatedIlDaily === 0) return pool.fees24hUsd > 0 ? 999 : 0;
    return pool.fees24hUsd / estimatedIlDaily;
  }

  /**
   * Volume authenticity check — detects wash trading via:
   * - Volume / TVL ratio anomaly
   * - Fee yield vs volume mismatch
   * Returns a 0–1 score where 1.0 = fully authentic.
   */
  checkVolumeAuthenticity(pool: PoolState): VolumeAuthResult {
    const flags: string[] = [];
    let score = 1.0;

    if (pool.tvlUsd === 0) {
      return { score: 0, flags: ["zero-tvl"] };
    }

    const volTvlRatio = pool.volume24hUsd / pool.tvlUsd;

    // Suspiciously high volume relative to TVL (> 10x)
    if (volTvlRatio > 10) {
      score -= 0.3;
      flags.push(`vol/tvl=${volTvlRatio.toFixed(1)}x (suspicious)`);
    } else if (volTvlRatio > 5) {
      score -= 0.15;
      flags.push(`vol/tvl=${volTvlRatio.toFixed(1)}x (elevated)`);
    }

    // Fees should be roughly 0.2–1% of volume
    if (pool.volume24hUsd > 0) {
      const feeRate = pool.fees24hUsd / pool.volume24hUsd;
      if (feeRate < 0.0002 || feeRate > 0.02) {
        score -= 0.2;
        flags.push(`fee-rate=${(feeRate * 100).toFixed(4)}% (outlier)`);
      }
    }

    // Near-zero TVL with non-zero volume = likely manipulation
    if (pool.tvlUsd < 5000 && pool.volume24hUsd > 100000) {
      score -= 0.5;
      flags.push("low-tvl high-volume (possible wash)");
    }

    return { score: Math.max(0, score), flags };
  }

  /**
   * % of bins in the range that have non-zero liquidity.
   */
  computeBinUtilization(binArray: BinArray): number {
    const total = binArray.bins.length;
    if (total === 0) return 0;

    const active = binArray.bins.filter(
      (b) => b.reserveX > 0n || b.reserveY > 0n
    ).length;

    return active / total;
  }

  /**
   * Recommend optimal bin range centered on active bin.
   * Width is based on recent price volatility heuristic.
   */
  recommendBinRange(
    activeBinId: number,
    binStep: number
  ): { lowerBinId: number; upperBinId: number } {
    // Wider range for higher binStep (more volatile pairs)
    const halfWidth = binStep <= 10 ? 15 : binStep <= 25 ? 10 : 7;
    return {
      lowerBinId: activeBinId - halfWidth,
      upperBinId: activeBinId + halfWidth,
    };
  }

  /**
   * Pre-filter: should this pool even be sent to the Claude agent?
   */
  passesPreFilter(pool: PoolState, authScore: number, binUtilization: number): boolean {
    if (pool.tvlUsd < config.MIN_POOL_TVL_USD) {
      log.debug("Pool filtered: TVL too low", {
        pool: pool.address,
        tvl: pool.tvlUsd,
      });
      return false;
    }

    if (authScore < config.VOLUME_AUTH_THRESHOLD) {
      log.debug("Pool filtered: volume not authentic", {
        pool: pool.address,
        score: authScore,
      });
      return false;
    }

    // Pools with sparse bin utilization are one-sided or near-empty.
    // The IL model assumes liquidity spread across the range — this breaks down
    // when most bins are empty and all liquidity is concentrated in a few adjacent bins.
    if (binUtilization < config.MIN_BIN_UTILIZATION) {
      log.debug("Pool filtered: bin utilization too low", {
        pool: pool.address,
        utilization: binUtilization,
        threshold: config.MIN_BIN_UTILIZATION,
      });
      return false;
    }

    return true;
  }
}

