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
  /** Measured pool fees / TVL, annualized percent (e.g. 120 = 120% APR). */
  readonly grossAprPct: number;
  readonly poolTvlUsd: number;
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
function allFinite(values: ReadonlyArray<number | undefined>): boolean {
  return values.every((value) => value === undefined || Number.isFinite(value));
}

function clamp01(n: number): number {
  return Math.min(Math.max(n, 0), 1);
}

/**
 * Expected share of pool fees captured by a position, from rank-time inputs
 * only.
 *
 * Model: share = clamp(positionSizeUsd / poolTvlUsd * concentration, 0, 1),
 * where
 *
 *   spanPct = 2 * rangeHalfWidthBins * binStep * 0.0001   (range width, pct)
 *   concentration = max(FEE_CAPTURE_REFERENCE_SPAN_PCT / spanPct, 1)
 *
 * A narrower range → smaller spanPct → higher concentration → larger share of
 * pool fees per deployed dollar while in range (concentrated liquidity sits
 * in the traded bins); a range wider than the ±100% reference has
 * concentration 1 and captures exactly its proportional TVL slice. Time in
 * range is the de-risker downstream (narrow churns OOR more often) — share
 * must not pre-discount it, or wide positions win twice.
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
  return Math.min((positionSizeUsd / poolTvlUsd) * concentration, 1);
}

/**
 * Net expected daily fee USD per deployed dollar.
 *
 * Model:
 *
 *   gross  = fees24hUsd * shareEstimate * timeInRangePct
 *   net    = gross * (1 - conversionCostPct) - harvestCostUsd
 *   result = net / positionSizeUsd
 *
 * Conversion is charged on captured fees only; harvest is a separate fixed
 * USD cost. This is the same order used by the cost-aware runner model and
 * paper close settlement.
 * Floored at 0: a harvest cost exceeding the converted gross capture yields 0,
 * never a negative rank signal. timeInRangePct and conversionCostPct are
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
  const capturedAfterConversion = gross * (1 - clamp01(conversionCostPct));
  const net = capturedAfterConversion - Math.max(harvestCostUsd, 0);
  return Math.max(net / positionSizeUsd, 0);
}

/**
 * Annualized net APR for a runner decision: netFeeVelocityUsd × 365 × 100
 * with the identical floored math.
 *
 * The runner's params carry no fees24hUsd, so the gross source is the
 * annualized grossAprPct, converted back to the daily USD equivalent
 * (poolTvlUsd * grossAprPct / 100 / 365) and fed through the same
 * share / harvest / conversion / time-in-range haircuts.
 *
 * Apply the pool-fee share exactly once. Using position size to reconstruct
 * pool fees would discount by size / TVL twice and spuriously favor shallow
 * pools. For proportional liquidity and zero costs, position APR equals
 * pool APR regardless of pool depth; fixed harvest costs still penalize
 * small positions. This remains an estimate, not a per-bin fee quote.
 *
 * // ponytail: 365-day annualization, no compounding. Add daily compounding
 * // (or a 365.25 anchor) when the APR feeds a TVM calculation.
 *
 * Fail-closed: inherits netFeeVelocityUsd's guards (grossAprPct ≤ 0 → daily
 * gross 0 → net 0; non-positive size / timeInRange → 0).
 */
export function runnerNetAprPct(params: RunnerNetAprParams): number {
  if (!finitePositive(params.poolTvlUsd)) return 0;
  const { shareEstimate, harvestCostUsd, conversionCostPct, positionSizeUsd, timeInRangePct } =
    params;
  const dailyGrossUsd = (params.poolTvlUsd * (params.grossAprPct / 100)) / 365;
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

// ─── Position-scale churn / IL / swap cost model ─────────────────────────────
// The runner's ENTER gate and the rotation model above discount a pool by
// capture SHARE (concentration) but assume a single daily harvest and price
// IL — they price neither the OOR-exit frequency nor the swap cost of every
// re-anchor. On a hot volatile pool (big measured fee rate, narrow active-bin
// range, violent whipsaw) that omission is exactly the bleed: narrow bins
// concentrate fee capture, but they also churn OOR constantly, and each exit
// + re-enter pays round-trip swap cost and realizes step IL. If the churn
// cost exceeds the net capture, the runner is net-negative no matter how big
// the headline APR is.
//
// This block adds that cost side, fail-closed (every required input invalid →
// 0 cost / 0 net, never a fabricated edge). Callers pass a maxExitsPerDay
// bound from the scan cadence so the model respects engine cycle limits.

/** Floor on the churn model's expected exits/day (a flat pool still re-enters). */
const OOR_EXITS_MIN = 0.5;

/**
 * Width of the position's bin range as a price fraction (2 × half-width bins
 * × binStep). 0 on non-positive / non-finite inputs.
 */
export function bandWidthPctFromBins(rangeHalfWidthBins: number, binStep: number): number {
  if (!finitePositive(rangeHalfWidthBins) || !finitePositive(binStep)) return 0;
  return 2 * rangeHalfWidthBins * binStep * BIN_STEP_BPS_TO_PCT;
}

export interface OorExitsParams {
  /** Half-width of the position's bin range, in bins. */
  readonly rangeHalfWidthBins: number;
  /** DLMM bin step in basis points. */
  readonly binStep: number;
  /** Realized daily volatility in DLMM bin units (active-bin stddev). */
  readonly volatilityStddev: number;
  /** Upper bound on exits/day, from the scan cadence (ms-per-day / scanIntervalMs). */
  readonly maxExitsPerDay: number;
}

/**
 * Expected number of out-of-range exits per day from range width and realized
 * volatility. Band crossings of a random walk scale with (vol/band)², capped
 * by the scan cadence (the engine can decide an OOR exit at most once per
 * cycle). Narrower band or higher volatility → more churn.
 */
export function expectedOorExitsPerDay(params: OorExitsParams): number {
  const band = bandWidthPctFromBins(params.rangeHalfWidthBins, params.binStep);
  if (
    band <= 0 ||
    !Number.isFinite(params.volatilityStddev) ||
    params.volatilityStddev <= 0 ||
    !Number.isFinite(params.maxExitsPerDay) ||
    params.maxExitsPerDay <= 0
  ) {
    return 0;
  }
  // bin-step converted to price-fraction stddev; crossings scale as (vol/band)².
  const volPct = params.volatilityStddev * (params.binStep * BIN_STEP_BPS_TO_PCT);
  const density = (volPct / band) * (volPct / band);
  return Math.min(Math.max(density, OOR_EXITS_MIN), params.maxExitsPerDay);
}

/**
 * Expected IL realized when an out-of-range position is exited and re-anchored,
 * as USD. The characteristic re-anchor move is one band-width edge, so the
 * realized equal-weight LP IL is that of a move of `bandWidthPct / 2`.
 * Fail-closed: 0 on non-positive size or an invalid band.
 */
export function expectedIlCapturedPerExitUsd(
  positionSizeUsd: number,
  rangeHalfWidthBins: number,
  binStep: number,
): number {
  const band = bandWidthPctFromBins(rangeHalfWidthBins, binStep);
  if (!finitePositive(positionSizeUsd) || band <= 0) return 0;
  const move = band / 2; // one-sided band edge, as a price fraction
  const r = 1 + move;
  const ilPct = 1 - (2 * Math.sqrt(r)) / (1 + r);
  return Math.max(ilPct, 0) * positionSizeUsd;
}

export interface ChurnCostParams {
  readonly positionSizeUsd: number;
  readonly rangeHalfWidthBins: number;
  readonly binStep: number;
  readonly volatilityStddev: number;
  /** Swap/conversion cost per swap, as a fraction (0.005 = 0.5%). In [0,1]. */
  readonly swapCostPct: number;
  readonly maxExitsPerDay: number;
}

/**
 * Expected daily USD cost of the runner's churn: one round trip (two swaps)
 * plus the realized step IL per OOR exit, scaled by the expected exits/day.
 */
export function churnCostDailyUsd(params: ChurnCostParams): number {
  const exits = expectedOorExitsPerDay(params);
  if (exits <= 0 || !finitePositive(params.positionSizeUsd)) return 0;
  const swapPerExit = 2 * clamp01(params.swapCostPct) * params.positionSizeUsd;
  const ilPerExit = expectedIlCapturedPerExitUsd(
    params.positionSizeUsd,
    params.rangeHalfWidthBins,
    params.binStep,
  );
  return exits * (swapPerExit + ilPerExit);
}

export interface NetFeeWithCostsParams {
  /** Pool gross fees over trailing 24h, USD (measured — datapi only for fees). */
  readonly fees24hUsd: number;
  readonly poolTvlUsd: number;
  readonly positionSizeUsd: number;
  readonly rangeHalfWidthBins: number;
  readonly binStep: number;
  readonly volatilityStddev: number;
  readonly swapCostPct: number;
  readonly harvestCostUsd: number;
  /** Conversion haircut on captured fees, in [0, 1]. Defaults to 0. */
  readonly conversionCostPct?: number | undefined;
  readonly timeInRangePct: number;
  readonly maxExitsPerDay: number;
}

/**
 * Net expected daily fee velocity per deployed dollar, after every cost the
 * churn model can name: capture share (concentration) → gross, conversion
 * haircut, minus daily harvest and churn costs (swap + IL per OOR exit).
 * Floored at 0 — a position whose churn cost exceeds its gross capture signals
 * 0, never a fabricated positive edge. This is the runner's "no bleeds" gate.
 */
export function netFeeVelocityUsdWithCosts(params: NetFeeWithCostsParams): number {
  if (
    !finitePositive(params.fees24hUsd) ||
    !finitePositive(params.positionSizeUsd) ||
    !finitePositive(params.timeInRangePct) ||
    !allFinite([
      params.harvestCostUsd,
      params.swapCostPct,
      params.volatilityStddev,
      params.maxExitsPerDay,
      params.conversionCostPct,
    ])
  ) {
    return 0;
  }
  const share = activeShareEstimate({
    positionSizeUsd: params.positionSizeUsd,
    poolTvlUsd: params.poolTvlUsd,
    rangeHalfWidthBins: params.rangeHalfWidthBins,
    binStep: params.binStep,
  });
  const gross = params.fees24hUsd * share * clamp01(params.timeInRangePct);
  const capturedAfterConversion = gross * (1 - clamp01(params.conversionCostPct ?? 0));
  const harvest = Math.max(params.harvestCostUsd, 0);
  const churn = churnCostDailyUsd({
    positionSizeUsd: params.positionSizeUsd,
    rangeHalfWidthBins: params.rangeHalfWidthBins,
    binStep: params.binStep,
    volatilityStddev: params.volatilityStddev,
    swapCostPct: params.swapCostPct,
    maxExitsPerDay: params.maxExitsPerDay,
  });
  const net = capturedAfterConversion - harvest - churn;
  return Number.isFinite(net) ? Math.max(net / params.positionSizeUsd, 0) : 0;
}

/**
 * The same net velocity, expressed as a daily percent of the position
 * (netFeeVelocityUsdWithCosts × 100). This is the signal the runner ENTER gate
 * and the [net-bleed] continuation guard compare against a floor.
 */
export function runnerNetDailyPctAfterCosts(params: NetFeeWithCostsParams): number {
  return netFeeVelocityUsdWithCosts(params) * 100;
}

/**
 * True only when the position's net daily capture clears a positive floor —
 * the "no bleeds at all" rule. A degenerate/unknown position (net 0) fails any
 * positive floor; callers with a positive floor therefore fail closed. A zero
 * floor (net >= 0) is trivially met by a zero-net position, so operators should
 * keep the floor above 0 to actually gate on profitability. floorPct must be
 * >= 0; a non-finite/negative floor is treated as 0.
 */
export function profitableRunner(params: NetFeeWithCostsParams, minNetDailyPct: number): boolean {
  const floor = Number.isFinite(minNetDailyPct) ? Math.max(0, minNetDailyPct) : 0;
  return runnerNetDailyPctAfterCosts(params) >= floor;
}

// ─── Fee-window stability + holding-period profit (normal-lane ENTER) ─────────
// A 24h fee print alone chases spikes: a pool printing hot for one hour looks
// identical to one producing all day. The Data API ships fee/TVL windows
// (fee_tvl_ratio per window, percent-per-window) — the conservative daily
// estimate is the MINIMUM across usable windows, so a lone 1h spike can never
// admit a pool its 12h/24h windows would reject. An ENTER must then cover a
// full round trip (entry + exit swaps and txs) over the intended holding
// period out of that stable estimate, after the same churn/IL/harvest costs
// the runner lane already charges.

/** Fee/TVL ratio windows (percent-per-window) the stability estimate reads. */
export type FeeWindowLabel = "30m" | "1h" | "2h" | "4h" | "12h" | "24h";

/** Annualization of one window's percent-per-window ratio to daily fee dollars. */
const FEE_WINDOW_DAY_FACTORS = {
  "30m": 48,
  "1h": 24,
  "2h": 12,
  "4h": 6,
  "12h": 2,
  "24h": 1,
} satisfies Record<FeeWindowLabel, number>;

/**
 * Conservative daily fee USD: the minimum across usable windows, each
 * normalized to daily dollars (ratioPct/100 × tvl × windowFactor). Null when
 * no window is usable (absent/non-finite/negative ratio or non-positive TVL)
 * — callers fail open to their legacy source rather than fabricate.
 */
export function stableDailyFeesUsd(
  windows: Readonly<Record<string, number | null | undefined>> | null | undefined,
  tvlUsd: number,
): number | null {
  if (windows == null || !(tvlUsd > 0)) return null;
  let stable: number | null = null;
  // SAFETY: FEE_WINDOW_DAY_FACTORS is a literal keyed by every FeeWindowLabel, so Object.keys returns exactly those labels.
  for (const label of Object.keys(FEE_WINDOW_DAY_FACTORS) as ReadonlyArray<FeeWindowLabel>) {
    const ratio = windows[label];
    if (ratio == null || !Number.isFinite(ratio) || ratio < 0) continue;
    const daily = (ratio / 100) * tvlUsd * FEE_WINDOW_DAY_FACTORS[label];
    if (!Number.isFinite(daily)) continue;
    stable = stable == null ? daily : Math.min(stable, daily);
  }
  return stable;
}

export interface ExpectedProfitParams {
  /** Conservative daily pool fees, USD (stableDailyFeesUsd output). */
  readonly dailyFeesUsd: number;
  readonly positionSizeUsd: number;
  readonly poolTvlUsd: number;
  readonly rangeHalfWidthBins: number;
  readonly binStep: number;
  readonly volatilityStddev: number;
  /** Per-swap cost as a fraction (0.005 = 0.5%). */
  readonly swapCostPct: number;
  /** Daily harvest (claim) cost, USD. */
  readonly harvestCostUsd: number;
  /** Conversion haircut as a fraction (0.05 = 5%) — matches settlement. */
  readonly conversionCostPct: number;
  /** Intended holding period, in days. */
  readonly holdingDays: number;
  /** Per-transaction gas cost, USD (entry + exit = 2 txs). */
  readonly txCostUsd: number;
  /** Expected fraction of time in range, in [0, 1]. */
  readonly timeInRangePct?: number;
  /** Upper bound on exits/day, from the scan cadence. */
  readonly maxExitsPerDay?: number;
}

function validExpectedProfitInputs(params: ExpectedProfitParams): boolean {
  return (
    Number.isFinite(params.dailyFeesUsd) &&
    params.dailyFeesUsd >= 0 &&
    finitePositive(params.positionSizeUsd) &&
    finitePositive(params.holdingDays) &&
    allFinite([
      params.swapCostPct,
      params.txCostUsd,
      params.harvestCostUsd,
      params.conversionCostPct,
      params.timeInRangePct,
      params.maxExitsPerDay,
    ])
  );
}

/**
 * Expected net USD over the intended holding period: concentrated gross fees
 * after the conversion haircut, minus daily harvest/churn costs and one full
 * round trip (two swaps on the full size + two txs). Null on invalid inputs
 * (missing/non-finite/negative fees, non-positive size/holding, non-finite
 * costs) — unknown, never zero masquerading as breakeven. A MEASURED zero
 * fee print is valid input: with no income the round trip cannot be covered,
 * so it prices negative and rejects the ENTER.
 */
export function expectedNetProfitUsd(params: ExpectedProfitParams): number | null {
  if (!validExpectedProfitInputs(params)) return null;
  const { dailyFeesUsd, positionSizeUsd, holdingDays, swapCostPct, txCostUsd } = params;
  const velocity = netFeeVelocityUsdWithCosts({
    fees24hUsd: dailyFeesUsd,
    poolTvlUsd: params.poolTvlUsd,
    positionSizeUsd,
    rangeHalfWidthBins: params.rangeHalfWidthBins,
    binStep: params.binStep,
    volatilityStddev: params.volatilityStddev,
    swapCostPct,
    harvestCostUsd: params.harvestCostUsd,
    conversionCostPct: params.conversionCostPct,
    timeInRangePct: params.timeInRangePct ?? 1,
    maxExitsPerDay: params.maxExitsPerDay ?? 86_400_000 / 600_000,
  });
  const roundTrip = 2 * clamp01(swapCostPct) * positionSizeUsd + 2 * Math.max(txCostUsd, 0);
  return velocity * positionSizeUsd * holdingDays - roundTrip;
}
export interface PaperCloseCostsParams {
  /** Deployed position size, USD (round-trip swaps scale with it). */
  readonly positionSizeUsd: number;
  /** Position age, in days (harvest cost accrues with time held). */
  readonly ageDays: number;
  /** Lifetime gross fees accrued (conversion cost scales with it). */
  readonly cumulativeGrossFeesUsd: number;
  /** Per-swap cost as a fraction (0.005 = 0.5%). */
  readonly swapCostPct: number;
  /** Daily harvest (claim) cost, USD. */
  readonly harvestCostUsd: number;
  /** Conversion haircut as a fraction (0.05 = 5%). */
  readonly conversionCostPct: number;
  /** Per-transaction gas cost, USD (entry + exit = 2 txs). */
  readonly txCostUsd: number;
}

/**
 * Modeled lifetime costs debited from paper realized PnL at close: one full
 * round trip (two swaps on the full size + two txs) plus harvest cost over
 * the holding period plus conversion on gross fees. Unlike the per-cycle
 * accrual floor, nothing disappears here — costs that exceeded fee income
 * still debit, so thin positions can realize below their gross. Floored at
 * 0; 0 on non-positive size (unmeasurable, never negative costs).
 */
export function paperCloseCostsUsd(params: PaperCloseCostsParams): number {
  if (!finitePositive(params.positionSizeUsd)) return 0;
  const swap = Number.isFinite(params.swapCostPct) ? clamp01(params.swapCostPct) : 0;
  const tx = Number.isFinite(params.txCostUsd) ? Math.max(params.txCostUsd, 0) : 0;
  const harvestRate = Number.isFinite(params.harvestCostUsd)
    ? Math.max(params.harvestCostUsd, 0)
    : 0;
  const conversion = Number.isFinite(params.conversionCostPct)
    ? clamp01(params.conversionCostPct)
    : 0;
  const ageDays = Number.isFinite(params.ageDays) ? Math.max(params.ageDays, 0) : 0;
  const grossFees = Number.isFinite(params.cumulativeGrossFeesUsd)
    ? Math.max(params.cumulativeGrossFeesUsd, 0)
    : 0;
  const roundTrip = 2 * swap * params.positionSizeUsd + 2 * tx;
  return Math.max(roundTrip + harvestRate * ageDays + conversion * grossFees, 0);
}
