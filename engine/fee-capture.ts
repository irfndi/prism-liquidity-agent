/** @file Net fee-capture model (Robinhood rule 3): rank pools by expected NET
 * fee velocity per deployed dollar, not raw APR.
 *
 * Pure + unit-testable + deterministic. No config imports, no IO, no
 * dependencies — the caller (market runner / screener) passes every value
 * explicitly; config-service fields arrive here as plain numbers.
 *
 * The pipeline:
 *
 * - activeShareEstimate: what fraction of the pool's fee flow a position
 *   captures, from rank-time inputs only (size, TVL, range width).
 * - netFeeVelocityUsd: that share, de-risked by time-in-range, minus one
 *   daily harvest cost, net of swap/conversion cost, per deployed dollar.
 * - runnerNetAprPct: the same floored math annualized, for runner decisions.
 *
 * Every function fails closed: non-positive or non-finite required inputs
 * produce 0 — a degenerate pool never ranks above a healthy one.
 */

export interface ActiveShareParams {
  readonly positionSizeUsd: number;
  readonly poolTvlUsd: number;
  /** Half-width of the position's bin range, in bins (DLMM bin units). */
  readonly rangeHalfWidthBins: number;
  /** DLMM bin step in basis points (e.g. 20, 40, 80, 100, 200). */
  readonly binStep: number;
}

export interface NetFeeVelocityParams {
  /** Gross pool fees over the trailing 24h, USD. */
  readonly fees24hUsd: number;
  /** Fraction of pool fees the position captures, in [0, 1] (activeShareEstimate). */
  readonly shareEstimate: number;
  /** Cost of one harvest (claim + convert) transaction, USD. */
  readonly harvestCostUsd: number;
  /** Conversion/swap cost as a fraction, in [0, 1] (0.05 = 5%). */
  readonly conversionCostPct: number;
  /** Deployed position size, USD. */
  readonly positionSizeUsd: number;
  /** Expected fraction of time the price spends in range, in [0, 1] (0.9 = 90%). */
  readonly timeInRangePct: number;
}

export interface RunnerNetAprParams {
  /** Gross annual APR, percent (e.g. 120 = 120% APR). Sanity anchor only. */
  readonly grossAprPct: number;
  readonly shareEstimate: number;
  readonly harvestCostUsd: number;
  readonly conversionCostPct: number;
  readonly positionSizeUsd: number;
  readonly timeInRangePct: number;
}

/**
 * The "full-range" price span used as the concentration reference: ±100%,
 * i.e. price from half to double the current price. A position spanning
 * exactly this range has concentration 1 (its share = size / TVL); a tighter
 * range concentrates proportionally more.
 */
export const FEE_CAPTURE_REFERENCE_SPAN_PCT = 2;

/** DLMM binStep is expressed in basis points; convert to a price fraction. */
const BIN_STEP_BPS_TO_PCT = 0.0001;

function finitePositive(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

function clamp01(n: number): number {
  return Math.min(Math.max(n, 0), 1);
}

/**
 * Expected share of pool fees captured by a position, from rank-time inputs
 * only.
 *
 * Model: share = clamp(positionSizeUsd / (poolTvlUsd * concentration), 0, 1),
 * where
 *
 *   spanPct = 2 * rangeHalfWidthBins * binStep * 0.0001   (range width, pct)
 *   concentration = max(FEE_CAPTURE_REFERENCE_SPAN_PCT / spanPct, 1)
 *
 * A wider range → larger spanPct → lower concentration → smaller share; the
 * concentration floor of 1 ensures a range wider than the ±100% reference
 * never claims a share beyond the position's proportional slice of TVL.
 *
 * // ponytail: uniform-liquidity model — share is linear in size and width,
 * // and TVL is treated as uniformly distributed across bins. Real per-bin
 * // liquidity (active-bin TVL, bin liquidity histogram, fee tier) would
 * // refine this; those are not available at rank time. Ceiling: feed the
 * // active bin's TVL + the position's liquidity per bin into the same
 * // quotient.
 *
 * Fail-closed: non-positive or non-finite tvl / size / bins / binStep → 0.
 */
export function activeShareEstimate(params: ActiveShareParams): number {
  const { positionSizeUsd, poolTvlUsd, rangeHalfWidthBins, binStep } = params;
  if (
    !finitePositive(positionSizeUsd) ||
    !finitePositive(poolTvlUsd) ||
    !finitePositive(rangeHalfWidthBins) ||
    !finitePositive(binStep)
  ) {
    return 0;
  }
  const spanPct = 2 * rangeHalfWidthBins * binStep * BIN_STEP_BPS_TO_PCT;
  const concentration = Math.max(FEE_CAPTURE_REFERENCE_SPAN_PCT / spanPct, 1);
  return Math.min(positionSizeUsd / (poolTvlUsd * concentration), 1);
}

/**
 * Net expected daily fee USD per deployed dollar.
 *
 * Model:
 *
 *   gross  = fees24hUsd * shareEstimate * timeInRangePct
 *   net    = max(0, (gross - harvestCostUsd) * (1 - conversionCostPct))
 *   result = net / positionSizeUsd
 *
 * Floored at 0: a harvest cost exceeding the position's gross capture yields
 * 0, never a negative rank signal. timeInRangePct and conversionCostPct are
 * fractions in [0, 1] and are clamped defensively (values outside are treated
 * as their nearest valid bound, so 1.5 time-in-range behaves as 100%).
 *
 * // ponytail: exactly one harvest per day is assumed. A harvest cadence
 * // shorter/longer than daily would scale harvestCostUsd's amortization;
 * // fold a frequency factor in when the runner models cadence.
 *
 * Fail-closed: non-positive or non-finite fees / size / timeInRange → 0;
 * non-finite share, harvest cost, or conversion → 0.
 */
export function netFeeVelocityUsd(params: NetFeeVelocityParams): number {
  const {
    fees24hUsd,
    shareEstimate,
    harvestCostUsd,
    conversionCostPct,
    positionSizeUsd,
    timeInRangePct,
  } = params;
  if (
    !finitePositive(fees24hUsd) ||
    !finitePositive(positionSizeUsd) ||
    !finitePositive(timeInRangePct)
  ) {
    return 0;
  }
  if (
    !Number.isFinite(shareEstimate) ||
    !Number.isFinite(harvestCostUsd) ||
    !Number.isFinite(conversionCostPct)
  ) {
    return 0;
  }
  const gross = fees24hUsd * clamp01(shareEstimate) * clamp01(timeInRangePct);
  const net = (gross - Math.max(harvestCostUsd, 0)) * (1 - clamp01(conversionCostPct));
  return Math.max(net / positionSizeUsd, 0);
}

/**
 * Annualized net APR for a runner decision: netFeeVelocityUsd × 365 × 100
 * with the identical floored math.
 *
 * The runner's params carry no fees24hUsd, so the gross source is the
 * annualized grossAprPct, converted back to the daily USD equivalent
 * (positionSizeUsd * grossAprPct / 100 / 365) and fed through the same
 * share / harvest / conversion / time-in-range haircuts.
 *
 * grossAprPct is a sanity anchor, not the rank signal: raw APR is exactly
 * what this model replaces. It never enters the computation directly — the
 * function derives entirely from the shared terms, and the floored net is by
 * construction ≤ grossAprPct (share, timeInRangePct, and conversionCostPct
 * are all ≤ 1 and harvestCostUsd ≥ 0), which is the consistency property
 * callers can rely on when cross-checking the two.
 *
 * // ponytail: 365-day annualization, no compounding. Add daily compounding
 * // (or a 365.25 anchor) when the APR feeds a TVM calculation.
 *
 * Fail-closed: inherits netFeeVelocityUsd's guards (grossAprPct ≤ 0 → daily
 * gross 0 → net 0; non-positive size / timeInRange → 0).
 */
export function runnerNetAprPct(params: RunnerNetAprParams): number {
  const { shareEstimate, harvestCostUsd, conversionCostPct, positionSizeUsd, timeInRangePct } =
    params;
  const dailyGrossUsd = (positionSizeUsd * (params.grossAprPct / 100)) / 365;
  return (
    netFeeVelocityUsd({
      fees24hUsd: dailyGrossUsd,
      shareEstimate,
      harvestCostUsd,
      conversionCostPct,
      positionSizeUsd,
      timeInRangePct,
    }) *
    365 *
    100
  );
}
