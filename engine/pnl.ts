// ─── Per-position PnL accounting (pure functions) ────────────────────────────
//
// Data model (Wave 4):
// - `depositedUsd` is the position cost basis. Auto-compounded fees become new
//   cost basis when they are redeposited (see applyCompoundToCostBasis), which
//   keeps total-PnL and trailing-stop math continuous across a compound.
// - `entryPriceUsd` is the pool's `currentPrice` at ENTER (price of token X
//   denominated in token Y, as served by the DLMM SDK / Meteora Data API).
// - `entryAmountXUsd` / `entryAmountYUsd` are the USD values of each leg at
//   entry. The adapter does not return actual on-chain deposit amounts, so the
//   engine records the documented 50/50 model: each leg is half of the entry
//   size in USD. This matches a symmetric range centered on the active bin.
// - Positions opened before this accounting existed have NULL entry fields;
//   analytics degrade gracefully (no HODL benchmark, PnL from cost basis).

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export interface PositionAnalyticsInput {
  /** Cost basis: initial deposit plus any compounded fees. */
  readonly depositedUsd: number;
  /** Latest estimated position value (per-cycle mark). */
  readonly currentValueUsd: number;
  /** Total fees claimed over the position lifecycle, in USD. */
  readonly cumulativeFeesClaimedUsd: number;
  /**
   * Total LM farm rewards claimed over the lifecycle, in USD (only the
   * USD-priced portion). Defaults to 0 — W4 math is unchanged for callers
   * that predate reward tracking. Counted in total PnL but never in fee APR.
   */
  readonly cumulativeRewardsClaimedUsd?: number | undefined;
  /** Pool price at entry; null for pre-migration rows. */
  readonly entryPriceUsd: number | null;
  /** USD value of the token-X leg at entry; null for pre-migration rows. */
  readonly entryAmountXUsd: number | null;
  /** USD value of the token-Y leg at entry; null for pre-migration rows. */
  readonly entryAmountYUsd: number | null;
  /** Position open timestamp (ms). */
  readonly openedAtMs: number;
  /** Start of the current out-of-range stint (ms); null when in range. */
  readonly outOfRangeSinceMs: number | null;
}

export interface PositionAnalytics {
  readonly costBasisUsd: number;
  /** currentValue + cumulativeFees − costBasis. */
  readonly unrealizedPnlUsd: number;
  /** unrealizedPnlUsd / costBasis × 100 (0 when basis is 0). */
  readonly unrealizedPnlPct: number;
  readonly feesClaimedUsd: number;
  /** LM farm rewards claimed (USD-priced portion); 0 for pre-W8 callers. */
  readonly rewardsClaimedUsd: number;
  /** HODL benchmark value; null when entry data or current price is missing. */
  readonly hodlValueUsd: number | null;
  /** currentValue − hodlValue (negative = worse than holding); null as above. */
  readonly ilVsHodlUsd: number | null;
  /**
   * Approximation: 1 − (current OOR stint / age). Only the current stint is
   * tracked, so recovered past stints count as in-range time (documented
   * overestimate for positions that went out of range and came back).
   */
  readonly timeInRangePct: number | null;
  /** Fees / cost basis annualized by position age; null when age or basis is 0. */
  readonly feeAprPct: number | null;
  readonly ageMs: number;
}

/**
 * HODL benchmark: what the entry capital would be worth if it had never been
 * deposited. The X leg moves with the price ratio, the Y leg (numeraire) is
 * constant. Returns null when the entry price is not positive.
 */
export function computeHodlValueUsd(
  entryAmountXUsd: number,
  entryAmountYUsd: number,
  entryPriceUsd: number,
  currentPriceUsd: number,
): number | null {
  if (!(entryPriceUsd > 0)) return null;
  return entryAmountXUsd * (currentPriceUsd / entryPriceUsd) + entryAmountYUsd;
}

/** Fees earned annualized against cost basis. Null when age or basis is 0. */
export function computeFeeAprPct(
  feesClaimedUsd: number,
  costBasisUsd: number,
  ageMs: number,
): number | null {
  if (costBasisUsd <= 0 || ageMs <= 0) return null;
  return (feesClaimedUsd / costBasisUsd) * (YEAR_MS / ageMs) * 100;
}

/**
 * Time-in-range approximation (see PositionAnalytics.timeInRangePct).
 * Null when the position age is zero.
 */
export function computeTimeInRangePct(
  ageMs: number,
  outOfRangeSinceMs: number | null,
  nowMs: number,
): number | null {
  if (ageMs <= 0) return null;
  const oorMs = outOfRangeSinceMs != null ? Math.max(0, nowMs - outOfRangeSinceMs) : 0;
  const ratio = Math.max(0, 1 - oorMs / ageMs);
  return ratio * 100;
}

export function computePositionAnalytics(
  input: PositionAnalyticsInput,
  currentPriceUsd: number | null,
  nowMs: number,
): PositionAnalytics {
  const ageMs = Math.max(0, nowMs - input.openedAtMs);
  const rewardsUsd = input.cumulativeRewardsClaimedUsd ?? 0;
  const unrealizedPnlUsd =
    input.currentValueUsd + input.cumulativeFeesClaimedUsd + rewardsUsd - input.depositedUsd;
  const unrealizedPnlPct =
    input.depositedUsd > 0 ? (unrealizedPnlUsd / input.depositedUsd) * 100 : 0;

  const hasEntryLegs =
    input.entryPriceUsd != null && input.entryAmountXUsd != null && input.entryAmountYUsd != null;
  const hodlValueUsd =
    hasEntryLegs && currentPriceUsd != null
      ? computeHodlValueUsd(
          input.entryAmountXUsd!,
          input.entryAmountYUsd!,
          input.entryPriceUsd!,
          currentPriceUsd,
        )
      : null;

  return {
    costBasisUsd: input.depositedUsd,
    unrealizedPnlUsd,
    unrealizedPnlPct,
    feesClaimedUsd: input.cumulativeFeesClaimedUsd,
    rewardsClaimedUsd: rewardsUsd,
    hodlValueUsd,
    ilVsHodlUsd: hodlValueUsd != null ? input.currentValueUsd - hodlValueUsd : null,
    timeInRangePct: computeTimeInRangePct(ageMs, input.outOfRangeSinceMs, nowMs),
    feeAprPct: computeFeeAprPct(input.cumulativeFeesClaimedUsd, input.depositedUsd, ageMs),
    ageMs,
  };
}

/** Realized PnL at close: final value + cumulative fees + rewards − cost basis. */
export function computeRealizedPnlUsd(
  finalValueUsd: number,
  cumulativeFeesClaimedUsd: number,
  costBasisUsd: number,
  cumulativeRewardsClaimedUsd = 0,
): number {
  return finalValueUsd + cumulativeFeesClaimedUsd + cumulativeRewardsClaimedUsd - costBasisUsd;
}

/**
 * Cost-basis bookkeeping for an auto-compound of already-claimed fees.
 *
 * The fees were counted once in `cumulativeFeesClaimedUsd` when claimed.
 * Redepositing them injects new capital into the position, so the cost basis
 * rises by the same amount — the two cancel in total-PnL math, keeping it
 * continuous. `currentValueUsd` rises by the compounded amount and
 * `highestValueUsd` tracks the new peak, fixing the W2 reviewer finding where
 * `depositedUsd` was inflated without adjusting the value columns (which
 * distorted PnL and the trailing stop).
 */
export function applyCompoundToCostBasis(input: {
  readonly depositedUsd: number;
  readonly currentValueUsd: number;
  readonly highestValueUsd: number | null;
  readonly compoundedFeesUsd: number;
}): {
  readonly depositedUsd: number;
  readonly currentValueUsd: number;
  readonly highestValueUsd: number;
} {
  const depositedUsd = input.depositedUsd + input.compoundedFeesUsd;
  const currentValueUsd = input.currentValueUsd + input.compoundedFeesUsd;
  const highest = Math.max(input.highestValueUsd ?? input.depositedUsd, currentValueUsd);
  return { depositedUsd, currentValueUsd, highestValueUsd: highest };
}
