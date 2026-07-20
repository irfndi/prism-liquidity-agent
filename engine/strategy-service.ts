import { Context, Layer } from "effect";
import { StrategyService, type StrategyApi } from "./services.js";
import type {
  BinArray,
  EntryStrategyShape,
  PoolMetrics,
  PoolState,
  PriceDriftContext,
  SignalWeights,
} from "./types.js";

/**
 * Upper bound for the fee/IL ratio. Also the value reported when observed
 * price drift is zero (no IL measured → fees dominate by construction).
 * Replaces the old hardcoded `999` sentinel which made every fee/IL gate
 * vacuous. Kept in sync with the weightedEntryScore cap below.
 */
export const MAX_FEE_IL_RATIO = 20;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Reference half-width (bins) for the concentration multiplier: the half-range
 * the adapter fetches around the active bin. Liquidity squeezed into a
 * narrower effective width experiences amplified IL per unit of price drift.
 */
const CONCENTRATION_REFERENCE_HALF_WIDTH = 20;
const MAX_CONCENTRATION_MULTIPLIER = 10;

/** Assumed daily drift per unit of bin step when no price history exists yet. */
const BIN_STEP_DRIFT_PROXY_PER_DAY = 10;

/** IL fraction of a full-range LP position after price moves by ratio r. */
function impermanentLossFraction(priceRatio: number): number {
  return Math.abs((2 * Math.sqrt(priceRatio)) / (1 + priceRatio) - 1);
}

/**
 * Liquidity-weighted mean distance (in bins) of stocked bins from the active
 * bin, expressed as an IL amplification factor vs the reference half-width.
 * Returns 1 when bin reserves are unknown or no bin holds liquidity.
 */
function computeConcentrationMultiplier(binArray: BinArray): number {
  if (binArray.reservesKnown === false) return 1;

  let weightSum = 0;
  let distanceSum = 0;
  for (const b of binArray.bins) {
    const weight = Number(b.liquiditySupply);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    weightSum += weight;
    distanceSum += weight * Math.abs(b.binId - binArray.activeBinId);
  }
  if (weightSum <= 0) return 1;

  const effectiveHalfWidth = Math.max(distanceSum / weightSum, 1);
  return Math.min(
    Math.max(CONCENTRATION_REFERENCE_HALF_WIDTH / effectiveHalfWidth, 1),
    MAX_CONCENTRATION_MULTIPLIER,
  );
}

/**
 * Estimated daily impermanent loss in USD for liquidity in this pool.
 *
 * Primary model (price history available): take the per-cycle endpoint drift
 * r = price/prevPrice, convert to the full-range IL fraction, scale to a day
 * by the number of elapsed-cycle equivalents, and amplify by the liquidity
 * concentration multiplier. This is a conservative upper-bound ranking
 * signal: it assumes every cycle drifts like the last one and ignores
 * intra-cycle mean reversion.
 *
 * Fallback (first cycle after startup — no previous snapshot): assume a daily
 * drift of BIN_STEP_DRIFT_PROXY_PER_DAY × binStep, so the estimate still
 * varies across pools with different volatility profiles instead of
 * collapsing to the old `/365`-amortized ~0 that produced the 999 sentinel.
 */
export function estimateDailyIlUsd(
  pool: PoolState,
  binArray: BinArray,
  priceDrift?: PriceDriftContext,
): number {
  const concentration = computeConcentrationMultiplier(binArray);

  const previousPrice = priceDrift?.previousPrice;
  const previousTimestamp = priceDrift?.previousTimestamp;
  const hasDrift =
    previousPrice !== undefined &&
    previousPrice > 0 &&
    previousTimestamp !== undefined &&
    pool.timestamp > previousTimestamp &&
    pool.currentPrice > 0;

  if (hasDrift) {
    const ratio = Math.min(Math.max(pool.currentPrice / previousPrice, 0.5), 2);
    const elapsedMs = pool.timestamp - previousTimestamp;
    const cyclesPerDay = MS_PER_DAY / elapsedMs;
    const ilDailyFraction = impermanentLossFraction(ratio) * cyclesPerDay * concentration;
    return pool.tvlUsd * ilDailyFraction;
  }

  const binStepBps = binArray.binStep ?? pool.binStep ?? 10;
  const assumedDailyDrift = (binStepBps / 10_000) * BIN_STEP_DRIFT_PROXY_PER_DAY;
  const ilDailyFraction = impermanentLossFraction(1 + assumedDailyDrift) * concentration;
  return pool.tvlUsd * ilDailyFraction;
}

export const DLMMStrategy: StrategyApi = {
  computeMetrics(
    pool: PoolState,
    binArray: BinArray,
    previousTvlUsd: number,
    priceDrift?: PriceDriftContext,
  ): PoolMetrics {
    const tvlVelocity = previousTvlUsd > 0 ? (pool.tvlUsd - previousTvlUsd) / previousTvlUsd : 0;

    const feeIlRatio = DLMMStrategy.computeFeeIlRatio(pool, binArray, priceDrift);
    const volumeAuthenticity = DLMMStrategy.checkVolumeAuthenticity(pool);
    const binUtilization = DLMMStrategy.computeBinUtilization(binArray);

    return {
      pool,
      binArray,
      tvlVelocity,
      feeIlRatio,
      volumeAuthenticity: volumeAuthenticity.score,
      binUtilization,
      // Volume authenticity is only meaningful on real (Data API) stats;
      // heuristic volume/fees would just re-validate their own assumptions.
      volumeAuthenticityKnown: pool.statsSource === "datapi",
      binUtilizationKnown: binArray.reservesKnown !== false,
      // Farm APR only flows from the Data API overlay: a pool with a farm but
      // an unknown APR reports 0 (known farm, no rate), non-farm/unknown null.
      farmAprPct: pool.hasFarm === true ? (pool.farmAprPct ?? 0) : null,
    };
  },

  computeFeeIlRatio(pool: PoolState, binArray: BinArray, priceDrift?: PriceDriftContext): number {
    if (pool.tvlUsd === 0) return 0;

    const estimatedIlDailyUsd = estimateDailyIlUsd(pool, binArray, priceDrift);
    if (estimatedIlDailyUsd <= 0) return pool.fees24hUsd > 0 ? MAX_FEE_IL_RATIO : 0;
    return Math.min(pool.fees24hUsd / estimatedIlDailyUsd, MAX_FEE_IL_RATIO);
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
    // Unknown reserves must report 0 (and binUtilizationKnown=false upstream)
    // — never fabricate 1.0 from synthetic bins.
    if (binArray.reservesKnown === false) return 0;

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
    halfWidthOverride?: number,
  ): { lowerBinId: number; upperBinId: number } {
    const halfWidth = halfWidthOverride ?? baselineHalfWidthForBinStep(binStep);
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
    authKnown = true,
    binUtilizationKnown = true,
  ): boolean {
    return (
      pool.tvlUsd > 0 &&
      pool.tvlUsd >= minTvlUsd &&
      // Unknown metrics skip their gate (a warning is logged by the caller);
      // they must neither auto-pass nor auto-fail the pre-filter.
      (!authKnown || authScore >= minAuthScore) &&
      (!binUtilizationKnown || binUtilization >= minBinUtilization)
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
 * `baseHalfWidthOverride` (Wave 9) replaces the binStep-tier base when
 * ENTRY_RANGE_HALF_WIDTH_BINS is set.
 */
export function recommendBinRangeForVolatility(
  activeBinId: number,
  binStep: number,
  highVolatility: boolean,
  wideHalfWidth = 50,
  baseHalfWidthOverride?: number,
): { lowerBinId: number; upperBinId: number; halfWidth: number } {
  const baseHalfWidth = baseHalfWidthOverride ?? baselineHalfWidthForBinStep(binStep);
  const halfWidth = highVolatility ? Math.max(baseHalfWidth * 2, wideHalfWidth) : baseHalfWidth;
  return {
    lowerBinId: activeBinId - halfWidth,
    upperBinId: activeBinId + halfWidth,
    halfWidth,
  };
}

// ─── Wave 9: Volatility-adaptive range width ─────────────────────────────────

/** σ of active-bin moves at which the baseline half-width is calibrated. */
export const ADAPTIVE_RANGE_REFERENCE_STDDEV = 2;
/** Calm-market floor: adaptation never tightens below half the baseline. */
export const ADAPTIVE_RANGE_MIN_MULTIPLIER = 0.5;
/** High-vol ceiling: adaptation never widens beyond 2× the baseline. */
export const ADAPTIVE_RANGE_MAX_MULTIPLIER = 2;
/** Sane floor — narrower ranges churn out-of-range within a cycle or two. */
export const MIN_ADAPTIVE_HALF_WIDTH_BINS = 5;

/**
 * Static baseline range half-width (bins each side) by bin step. Coarser pools
 * (larger binStep) get narrower ranges because each bin spans more price. This
 * is the pre-Wave-9 hardcoded 25/20/15 tiering, now the default base that
 * ENTRY_RANGE_HALF_WIDTH_BINS overrides and Wave 9 adaptation scales.
 */
export function baselineHalfWidthForBinStep(binStep: number): number {
  return binStep <= 10 ? 25 : binStep <= 25 ? 20 : 15;
}

/**
 * Resolve the range half-width (bins each side) for entries and rebalances.
 *
 * Base: `configuredBaseHalfWidth` (ENTRY_RANGE_HALF_WIDTH_BINS) when > 0, else
 * the binStep tier. When `adaptiveEnabled` (VOLATILITY_ADAPTIVE_RANGES) and
 * realized volatility has been measured, the base scales with
 *
 *   clamp(σ / ADAPTIVE_RANGE_REFERENCE_STDDEV, MIN_MULTIPLIER, MAX_MULTIPLIER)
 *
 * so high-vol regimes get wider ranges (fewer forced rebalances) and calm
 * regimes get narrower ones (fee concentration). The result is always clamped
 * to [MIN_ADAPTIVE_HALF_WIDTH_BINS, floor(maxFullRangeBins / 2)] so the full
 * range never exceeds the MAX_REBALANCE_RANGE_BINS risk cap.
 *
 * Warmup: σ <= 0 means fewer than 2 bin snapshots (cold start) or a perfectly
 * flat pool — both return the bounded baseline, never a fabricated jump.
 */
export function resolveRangeHalfWidth(args: {
  readonly binStep: number;
  readonly configuredBaseHalfWidth: number;
  readonly adaptiveEnabled: boolean;
  readonly volatilityStddev: number;
  readonly maxFullRangeBins: number;
}): number {
  const base =
    args.configuredBaseHalfWidth > 0
      ? args.configuredBaseHalfWidth
      : baselineHalfWidthForBinStep(args.binStep);
  const halfCap = Math.max(1, Math.floor(args.maxFullRangeBins / 2));
  const effectiveMin = Math.min(MIN_ADAPTIVE_HALF_WIDTH_BINS, halfCap);
  if (
    !args.adaptiveEnabled ||
    !Number.isFinite(args.volatilityStddev) ||
    args.volatilityStddev <= 0
  ) {
    return Math.min(halfCap, Math.max(effectiveMin, base));
  }
  const rawMultiplier = args.volatilityStddev / ADAPTIVE_RANGE_REFERENCE_STDDEV;
  const multiplier = Math.min(
    ADAPTIVE_RANGE_MAX_MULTIPLIER,
    Math.max(ADAPTIVE_RANGE_MIN_MULTIPLIER, rawMultiplier),
  );
  const scaled = Math.round(base * multiplier);
  return Math.min(halfCap, Math.max(effectiveMin, scaled));
}

// ─── Entry strategy shape regime pick (ENTRY_STRATEGY_TYPE=auto) ─────────────

/**
 * Pick a DLMM deposit distribution from recent pool regime signals. Only used
 * when ENTRY_STRATEGY_TYPE=auto; any concrete configured shape bypasses this.
 *
 * Heuristic:
 * - A dominant trend (|net drift| ≥ max(3 bins, 2σ) over the lookback window)
 *   → `bidask`, whose edge-weighted distribution leans into directional moves.
 * - High-volatility chop (σ ≥ highVolThreshold, no dominant trend) → `spot`,
 *   the uniform, most rebalance-tolerant distribution.
 * - Calm / mean-reverting (default, including no history yet) → `curve`,
 *   concentrated around the active bin for maximum fee capture.
 */
export function recommendStrategyShape(args: {
  readonly volatilityStddev: number;
  readonly highVolThreshold: number;
  readonly netDriftBins: number;
}): EntryStrategyShape {
  const trendDominates = Math.abs(args.netDriftBins) >= Math.max(3, 2 * args.volatilityStddev);
  if (trendDominates) return "bidask";
  if (isHighVolatility(args.volatilityStddev, args.highVolThreshold)) return "spot";
  return "curve";
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

/**
 * Farm-APR score normalization: a farm streaming FARM_APR_SCORE_REFERENCE_PCT
 * (annualized) or more earns the full FARM_SCORE_WEIGHT contribution; smaller
 * APRs scale linearly. The contribution is a fixed, bounded tie-breaker — it
 * is deliberately NOT part of the Darwinian SignalWeights so weight evolution
 * cannot inflate farm yield above fee/IL quality signals.
 */
export const FARM_APR_SCORE_REFERENCE_PCT = 100;
export const FARM_SCORE_WEIGHT = 1;

export function weightedEntryScore(metrics: PoolMetrics, weights: SignalWeights): number {
  const cappedFeeIlRatio = Math.min(metrics.feeIlRatio, MAX_FEE_IL_RATIO);
  const feeContrib = cappedFeeIlRatio * weights.feeIlRatio;
  // Unknown metrics contribute 0 (fail-closed) rather than a fabricated 1.0.
  const authContrib =
    (metrics.volumeAuthenticityKnown ? metrics.volumeAuthenticity : 0) * weights.volumeAuthenticity;
  const binContrib =
    (metrics.binUtilizationKnown ? metrics.binUtilization : 0) * weights.binUtilization;
  const tvlContrib = Math.min(metrics.pool.tvlUsd / 1_000_000, 1) * weights.tvlUsd;
  const velContrib = (1 / (1 + Math.abs(metrics.tvlVelocity))) * weights.tvlVelocity * 0.1;
  const farmContrib =
    Math.min(Math.max(metrics.farmAprPct ?? 0, 0) / FARM_APR_SCORE_REFERENCE_PCT, 1) *
    FARM_SCORE_WEIGHT;

  return feeContrib + authContrib + binContrib + tvlContrib + velContrib + farmContrib;
}
