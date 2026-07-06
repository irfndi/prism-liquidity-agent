import { Context, Layer } from "effect";
import { StrategyService, type StrategyApi } from "./services.js";
import type { BinArray, PoolMetrics, PoolState, SignalWeights } from "./types.js";

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
 * avoid constant rebalancing. The widened width comes from the caller-supplied
 * `wideHalfWidth` so users can tune it via VOLATILITY_WIDE_HALF_WIDTH_BINS.
 */
export function recommendBinRangeForVolatility(
  activeBinId: number,
  binStep: number,
  highVolatility: boolean,
  wideHalfWidth = 50,
): { lowerBinId: number; upperBinId: number; halfWidth: number } {
  const baseHalfWidth = binStep <= 10 ? 25 : binStep <= 25 ? 20 : 15;
  const halfWidth = highVolatility ? Math.max(baseHalfWidth * 2, wideHalfWidth) : baseHalfWidth;
  return {
    lowerBinId: activeBinId - halfWidth,
    upperBinId: activeBinId + halfWidth,
    halfWidth,
  };
}

// ─── Adaptive threshold evolution ────────────────────────────────────────────

export interface EvolvableThresholds {
  readonly minFeeIlRatio: number;
  readonly volumeAuthThreshold: number;
  readonly minBinUtilization: number;
}

export interface OutcomeRecord {
  readonly feeIlRatio: number;
  readonly volumeAuthenticity: number;
  readonly binUtilization: number;
  readonly pnlUsd: number;
  readonly outcomeRecordedAt: number;
}

/**
 * Clamp a threshold nudge to ±maxChangePct of the current value.
 * When target > current, nudge upward but never exceed current × (1 + maxChangePct).
 * When target < current, nudge downward but never go below current × (1 - maxChangePct).
 * When target === current, no change.
 */
export function nudgeThreshold(current: number, target: number, maxChangePct: number): number {
  if (current === 0) return target;
  const maxDelta = Math.abs(current) * maxChangePct;
  const rawDelta = target - current;
  const clampedDelta = Math.max(-maxDelta, Math.min(maxDelta, rawDelta));
  return current + clampedDelta;
}

/**
 * Compute mean-normalized difference between winners (pnlUsd > 0) and losers
 * (pnlUsd <= 0) for a given signal key. Returns 0 when either group is empty
 * or when the winner mean equals the loser mean (no discriminative signal).
 */
export function computeSignalLift(
  outcomes: ReadonlyArray<OutcomeRecord>,
  signalKey: keyof Omit<OutcomeRecord, "pnlUsd" | "outcomeRecordedAt">,
): number {
  const winners: number[] = [];
  const losers: number[] = [];
  for (const o of outcomes) {
    const val = o[signalKey];
    if (o.pnlUsd > 0) {
      winners.push(val);
    } else {
      losers.push(val);
    }
  }
  if (winners.length === 0 || losers.length === 0) return 0;

  const winMean = winners.reduce((s, v) => s + v, 0) / winners.length;
  const loseMean = losers.reduce((s, v) => s + v, 0) / losers.length;

  // Normalise by the range to keep lift in a comparable scale.
  const range = Math.max(Math.abs(winMean), Math.abs(loseMean), 1e-9);
  return (winMean - loseMean) / range;
}

/**
 * Evolve thresholds based on closed-position outcomes.
 *
 * Returns the (possibly updated) thresholds and whether any changed.
 * Defaults: evolutionInterval=5, maxChangePct=0.20, minOutcomes=5.
 */
export function evolveThresholds(
  outcomes: ReadonlyArray<OutcomeRecord>,
  current: EvolvableThresholds,
  options?: {
    readonly maxChangePct?: number;
    readonly minOutcomes?: number;
  },
): { readonly thresholds: EvolvableThresholds; readonly changed: boolean } {
  const minOutcomes = options?.minOutcomes ?? 5;
  if (outcomes.length < minOutcomes) {
    return { thresholds: current, changed: false };
  }

  const maxChangePct = options?.maxChangePct ?? 0.2;

  const feeLift = computeSignalLift(outcomes, "feeIlRatio");
  const authLift = computeSignalLift(outcomes, "volumeAuthenticity");
  const utilLift = computeSignalLift(outcomes, "binUtilization");

  // Positive lift means higher signal values correlate with wins → raise the
  // threshold to prefer stronger signals. Negative lift means the opposite.
  // Target nudges the current value toward a direction proportional to lift.
  const feeTarget = current.minFeeIlRatio * (1 + feeLift);
  const authTarget = current.volumeAuthThreshold * (1 + authLift);
  const utilTarget = current.minBinUtilization * (1 + utilLift);

  const newFeeIl = nudgeThreshold(current.minFeeIlRatio, feeTarget, maxChangePct);
  const newAuth = nudgeThreshold(current.volumeAuthThreshold, authTarget, maxChangePct);
  const newUtil = nudgeThreshold(current.minBinUtilization, utilTarget, maxChangePct);

  const changed =
    newFeeIl !== current.minFeeIlRatio ||
    newAuth !== current.volumeAuthThreshold ||
    newUtil !== current.minBinUtilization;

  return {
    thresholds: {
      minFeeIlRatio: newFeeIl,
      volumeAuthThreshold: newAuth,
      minBinUtilization: newUtil,
    },
    changed,
  };
}

// ─── F4: OOR recovery prediction ──────────────────────────────────────────────

/**
 * Estimate the probability that an OOR position recovers into its existing
 * range. Heuristic: typical mean-reversion amplitude (mean |Δbin| over the
 * recent history) divided by current drift distance. If the typical swing is
 * at least as large as the current drift, the price is more likely to come
 * back. Trending or runaway series score low; oscillating series score high.
 * Returns 0.5 for empty history (no signal, fall through to defaults).
 */
export function estimateRecoveryProbability(
  recentBins: ReadonlyArray<number>,
  currentDriftBins: number,
): number {
  if (recentBins.length < 2) return 0.5;

  let sumAbsDelta = 0;
  for (let i = 1; i < recentBins.length; i++) {
    sumAbsDelta += Math.abs((recentBins[i] ?? 0) - (recentBins[i - 1] ?? 0));
  }
  const meanAbsDelta = sumAbsDelta / (recentBins.length - 1);

  if (meanAbsDelta <= 0) {
    return currentDriftBins <= 0 ? 1 : 0;
  }

  const ratio = meanAbsDelta / (meanAbsDelta + currentDriftBins);
  return Math.max(0, Math.min(1, ratio));
}

/**
 * Decide whether to HOLD the position in expectation of recovery rather than
 * REBALANCE. Returns true when the recovery probability is at/above the hold
 * threshold (we believe the price will come back). Returns false otherwise
 * (including in the gray zone — we rebalance rather than gamble).
 */
export function shouldHoldForRecovery(recoveryProbability: number, holdThreshold: number): boolean {
  return recoveryProbability >= holdThreshold;
}

// ─── Darwinian signal weighting ─────────────────────────────────────────────

export function computeSignalWeights(
  outcomes: ReadonlyArray<OutcomeRecord>,
  current: SignalWeights,
  options?: {
    readonly windowDays?: number;
    readonly minOutcomes?: number;
    readonly boostFactor?: number;
    readonly decayFactor?: number;
    readonly weightFloor?: number;
    readonly weightCeiling?: number;
  },
): SignalWeights {
  const windowDays = options?.windowDays ?? 60;
  const minOutcomes = options?.minOutcomes ?? 10;
  const boostFactor = options?.boostFactor ?? 1.05;
  const decayFactor = options?.decayFactor ?? 0.95;
  const weightFloor = options?.weightFloor ?? 0.3;
  const weightCeiling = options?.weightCeiling ?? 2.5;

  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const recent = outcomes.filter((o) => o.outcomeRecordedAt > cutoff);

  if (recent.length < minOutcomes) {
    return current;
  }

  const signals: ReadonlyArray<keyof Omit<OutcomeRecord, "pnlUsd" | "outcomeRecordedAt">> = [
    "feeIlRatio",
    "volumeAuthenticity",
    "binUtilization",
  ];

  let updated = { ...current, updatedAt: Date.now() };

  for (const signal of signals) {
    const lift = computeSignalLift(recent, signal);
    const quartile = computeQuartile(recent, signal);

    let nudge = 1;
    if (quartile === 0) {
      nudge = decayFactor;
    } else if (quartile === 3) {
      nudge = boostFactor;
    } else {
      nudge = 1 + lift * 0.05;
    }

    const currentWeight = updated[signal];
    const newWeight = clampWeight(currentWeight * nudge, weightFloor, weightCeiling);
    updated = { ...updated, [signal]: newWeight };
  }

  return updated;
}

function computeQuartile(
  outcomes: ReadonlyArray<OutcomeRecord>,
  signalKey: keyof Omit<OutcomeRecord, "pnlUsd" | "outcomeRecordedAt">,
): number {
  const sorted = [...outcomes].map((o) => o[signalKey]).sort((a, b) => a - b);
  const lastValue = sorted[sorted.length - 1] ?? 0;
  const q3Threshold = sorted[Math.floor(sorted.length * 0.75)] ?? lastValue;
  const q0Threshold = sorted[Math.floor(sorted.length * 0.25)] ?? 0;
  const latest = outcomes[0]?.[signalKey] ?? 0;

  if (latest >= q3Threshold) return 3;
  if (latest <= q0Threshold) return 0;
  if (latest >= (q0Threshold + q3Threshold) / 2) return 2;
  return 1;
}

function clampWeight(value: number, floor: number, ceiling: number): number {
  return Math.max(floor, Math.min(ceiling, value));
}

const MAX_FEE_IL_RATIO = 20;

export function weightedEntryScore(metrics: PoolMetrics, weights: SignalWeights): number {
  const cappedFeeIlRatio = Math.min(metrics.feeIlRatio, MAX_FEE_IL_RATIO);
  const feeContrib = cappedFeeIlRatio * weights.feeIlRatio;
  const authContrib = metrics.volumeAuthenticity * weights.volumeAuthenticity;
  const binContrib = metrics.binUtilization * weights.binUtilization;
  const tvlContrib = Math.min(metrics.pool.tvlUsd / 1_000_000, 1) * weights.tvlUsd;
  const velContrib = (1 / (1 + Math.abs(metrics.tvlVelocity))) * weights.tvlVelocity * 0.1;

  return feeContrib + authContrib + binContrib + tvlContrib + velContrib;
}
