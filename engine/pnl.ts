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

/** Computes the display analytics for one open or closed position. */
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

export interface NetRealizedPnlInput {
  readonly finalValueUsd: number;
  readonly cumulativeFeesClaimedUsd: number;
  readonly cumulativeRewardsClaimedUsd: number;
  readonly costBasisUsd: number;
  readonly settlementCostUsd: number;
  readonly executionCostUsd: number;
}

/** Computes realized PnL after settlement and execution costs are deducted. */
export function computeNetRealizedPnlUsd(input: NetRealizedPnlInput): number {
  return (
    computeRealizedPnlUsd(
      input.finalValueUsd,
      input.cumulativeFeesClaimedUsd,
      input.costBasisUsd,
      input.cumulativeRewardsClaimedUsd,
    ) -
    input.settlementCostUsd -
    input.executionCostUsd
  );
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

// ─── Portfolio equity (issue #149) ───────────────────────────────────────────
//
// The wallet's liquid balance (SOL + SPL across Token Program and Token-2022)
// is real operator equity that the per-position rows do not hold. Reporting
// positions-only equity understates the portfolio by the full liquid balance,
// which trips phantom drawdown pauses and misleads the operator/Telegram.
// One canonical function: equity = liquid wallet + open-position value. The
// equity-based unrealized P&L is (equity + claimed fees + claimed rewards −
// total deposits) — the same shape as the per-position model, extended to the
// whole wallet.

export interface PortfolioEquityInput {
  /** Liquid wallet balance (native SOL + SPL), or null when unreadable. */
  readonly walletBalanceUsd: number | null;
  readonly positions: ReadonlyArray<{
    readonly currentValueUsd: number;
    readonly depositedUsd: number;
    readonly cumulativeFeesClaimedUsd: number;
    readonly cumulativeRewardsClaimedUsd?: number | undefined;
  }>;
}

export interface PortfolioEquity {
  /** Current value of all positions. */
  readonly positionsValueUsd: number;
  /** Liquid wallet balance (same as input; 0 when unknown). */
  readonly walletBalanceUsd: number;
  /** True equity = positions + wallet. */
  readonly totalEquityUsd: number;
  /** Sum of position cost bases. */
  readonly totalDepositedUsd: number;
  /** Sum of claimed swap fees across positions. */
  readonly totalFeesClaimedUsd: number;
  /** Sum of claimed farm rewards across positions. */
  readonly totalRewardsClaimedUsd: number;
  /**
   * Equity-based unrealized P&L: (equity + fees + rewards − deposits).
   * When the wallet balance is unknown (null input), this falls back to the
   * positions-only figure exactly as before — never fabricates a wallet.
   */
  readonly unrealizedPnlUsd: number;
  /** unrealizedPnlUsd / totalDepositedUsd (0 when no deposits). */
  readonly unrealizedPnlPct: number;
  /** False when the wallet balance could not be read (equity is positions-only). */
  readonly walletKnown: boolean;
}

export function computePortfolioEquity(input: PortfolioEquityInput): PortfolioEquity {
  const positionsValueUsd = input.positions.reduce(
    (sum, pos) => (Number.isFinite(pos.currentValueUsd) ? sum + pos.currentValueUsd : sum),
    0,
  );
  const totalDepositedUsd = input.positions.reduce(
    (sum, pos) => (Number.isFinite(pos.depositedUsd) ? sum + pos.depositedUsd : sum),
    0,
  );
  const totalFeesClaimedUsd = input.positions.reduce(
    (sum, pos) =>
      Number.isFinite(pos.cumulativeFeesClaimedUsd) ? sum + pos.cumulativeFeesClaimedUsd : sum,
    0,
  );
  const totalRewardsClaimedUsd = input.positions.reduce(
    (sum, pos) =>
      Number.isFinite(pos.cumulativeRewardsClaimedUsd ?? 0)
        ? sum + (pos.cumulativeRewardsClaimedUsd ?? 0)
        : sum,
    0,
  );

  const walletBalanceUsd =
    input.walletBalanceUsd !== null && Number.isFinite(input.walletBalanceUsd)
      ? input.walletBalanceUsd
      : 0;
  const walletKnown = input.walletBalanceUsd !== null && Number.isFinite(input.walletBalanceUsd);
  const totalEquityUsd = positionsValueUsd + walletBalanceUsd;
  // Unrealized P&L is POSITIONS-ONLY: equity minus deposits would count the
  // idle wallet balance (e.g. residual SOL/USDC that was never deposited) as
  // "gain", which produced the misleading "+127%" status on live wallets
  // (issue #151 follow-up). The wallet is its own line (totalEquityUsd /
  // walletBalanceUsd); it is not P&L.
  const unrealizedPnlUsd =
    positionsValueUsd + totalFeesClaimedUsd + totalRewardsClaimedUsd - totalDepositedUsd;
  const unrealizedPnlPct = totalDepositedUsd > 0 ? (unrealizedPnlUsd / totalDepositedUsd) * 100 : 0;

  return {
    positionsValueUsd,
    walletBalanceUsd,
    totalEquityUsd,
    totalDepositedUsd,
    totalFeesClaimedUsd,
    totalRewardsClaimedUsd,
    unrealizedPnlUsd,
    unrealizedPnlPct,
    walletKnown,
  };
}
