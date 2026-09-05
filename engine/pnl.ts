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
export interface CompoundCostBasisResult {
  readonly depositedUsd: number;
  readonly currentValueUsd: number;
  readonly highestValueUsd: number;
}

export function applyCompoundToCostBasis(input: {
  readonly depositedUsd: number;
  readonly currentValueUsd: number;
  readonly highestValueUsd: number | null;
  readonly compoundedFeesUsd: number;
}): CompoundCostBasisResult {
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

// ─── Concentrated-liquidity position valuation ───────────────────────────────
//
// A DLMM position spanning bins [lower, upper] behaves as a concentrated
// liquidity position over the price range [P_a, P_b]. Paper positions have no
// on-chain account to read, so the engine marks them with this instead of the
// HODL revaluation (which understates IL: it prices the entry legs as if they
// were never deposited). IL = hodlValueUsd − lpValueUsd. Single source of
// truth — ops/backtest.ts re-exports these rather than keeping a copy.

/** Range edges of a DLMM position expressed as bin prices. */
export interface BinRangePrices {
  readonly pa: number;
  readonly pb: number;
}

/** Mark-to-market and HODL-benchmark values of a CLMM position. */
export interface ClmmPositionValue {
  readonly lpValueUsd: number;
  readonly hodlValueUsd: number;
}

/** Range edges of a DLMM position expressed as bin prices. Bin i has price
 * P_i = P_anchor·(1+s)^(i−anchorBin), so the position's [lower, upper] bin
 * range maps to a CLMM price range [P_a, P_b]. */
export function binRangePrices(args: {
  anchorPrice: number;
  anchorBinId: number;
  lowerBinId: number;
  upperBinId: number;
  binStep: number;
}): BinRangePrices {
  const s = 1 + args.binStep / 10_000;
  const pa = args.anchorPrice * Math.pow(s, args.lowerBinId - args.anchorBinId);
  const pb = args.anchorPrice * Math.pow(s, args.upperBinId - args.anchorBinId);
  return { pa: pa > 0 ? pa : 1, pb: pb > 0 ? pb : 1 };
}

/**
 * Correct DLMM/CLMM position valuation (NOT the V2 full-range curve).
 *
 * Given the deposited USD value split 50/50 at the anchor price, returns the
 * position's mark-to-market value at P1 and the HODL benchmark value (the same
 * capital never deposited), so IL = 1 − V_LP/V_HODL.
 *
 * Piecewise (a=√P_a, b=√P_b, s=√P1):
 *   P1 ≤ P_a : x = L(1/a − 1/b),           y = 0
 *   P_a<P1<P_b: x = L(1/s − 1/b),           y = L(s − a)
 *   P1 ≥ P_b : x = 0,                       y = L(b − a)
 *   V_LP = x·P1 + y
 *   V_HODL = X0·P1 + Y0   (X0,Y0 = initial 50/50 amounts)
 *
 * Crucially this does NOT stop growing once price exits the range: when P1>P_b
 * the position is fully in token1 (V_LP flat) while V_HODL keeps appreciating,
 * so IL grows without bound — the exact behavior the V2 2√r/(1+r) curve
 * wrongly asymptotes away.
 */
export function clmmPositionValue(args: {
  sizeUsd: number;
  anchorPrice: number;
  anchorBinId: number;
  currentPrice: number;
  lowerBinId: number;
  upperBinId: number;
  binStep: number;
}): ClmmPositionValue {
  const { pa, pb } = binRangePrices(args);
  const p0 = args.anchorPrice;
  const p1 = args.currentPrice;
  if (!(p0 > 0) || !(p1 > 0) || !(pb > pa)) {
    return { lpValueUsd: args.sizeUsd, hodlValueUsd: args.sizeUsd };
  }
  // 50/50 deposit at anchor: X tokens and Y tokens.
  const x0 = args.sizeUsd / 2 / p0;
  const y0 = args.sizeUsd / 2;
  const a = Math.sqrt(pa);
  const b = Math.sqrt(pb);
  // Liquidity L is a CONSTANT of the position, fixed at deposit: it is
  // recovered from the X leg at the ANCHOR price p0, never the live price.
  // Deriving it from the live price while reusing the initial x0 is a bug — it
  // inflates in-range LP value and overstates downside IL by an order of
  // magnitude.
  const s0 = Math.sqrt(p0);
  const L = x0 / (1 / s0 - 1 / b) || 0;
  if (!(L > 0)) return { lpValueUsd: args.sizeUsd, hodlValueUsd: x0 * p1 + y0 };
  const sp = Math.sqrt(p1);
  let x: number;
  let y: number;
  if (p1 <= pa) {
    x = L * (1 / a - 1 / b);
    y = 0;
  } else if (p1 >= pb) {
    x = 0;
    y = L * (b - a);
  } else {
    x = L * (1 / sp - 1 / b);
    y = L * (sp - a);
  }
  const lpValueUsd = x * p1 + y;
  const hodlValueUsd = x0 * p1 + y0;
  return { lpValueUsd, hodlValueUsd };
}

/**
 * Paper position mark: the CLMM LP value for a position whose valuation
 * anchor is known, or null when it is not (pre-v16 rows with NULL entry
 * fields, unknown binStep). Null means "keep the caller's fallback" — never
 * fabricate. Paper positions have no on-chain account, so without this their
 * mark is the HODL revaluation and out-of-range IL never appears in
 * unrealized PnL.
 * The anchor tracks the last range-establishing event: ENTER seeds it from
 * the entry print, REBALANCE re-stamps it at the live print — re-centering a
 * range without re-stamping would re-price the original deposit across new
 * bins and fabricate P&L. Rows predating the anchor fall back to the entry
 * anchor. The 50/50-at-anchor derivation only prices ranges containing the
 * anchor: an anchor outside [lower, upper] is a single-sided shape (e.g. a
 * dip-anchored leg) that needs its own deposit model — fail open to HODL
 * rather than price it with the wrong shape.
 */
export interface PaperClmmMarkInput {
  readonly depositedUsd: number;
  readonly entryPriceUsd: number | null;
  readonly anchorBinId: number | null;
  readonly currentPrice: number;
  readonly lowerBinId: number;
  readonly upperBinId: number;
  readonly binStep: number;
  /** Last range-establishing print (ENTER, or REBALANCE); absent → entry anchor. */
  readonly valuationAnchorPriceUsd?: number | null | undefined;
  readonly valuationAnchorBinId?: number | null | undefined;
  readonly valuationAnchorValueUsd?: number | null | undefined;
}
export function paperClmmMarkUsd(args: PaperClmmMarkInput): number | null {
  const anchorPriceUsd = args.valuationAnchorPriceUsd ?? args.entryPriceUsd;
  const anchorBinId = args.valuationAnchorBinId ?? args.anchorBinId;
  const anchorValueUsd = args.valuationAnchorValueUsd ?? args.depositedUsd;
  if (anchorPriceUsd == null || anchorBinId == null) return null;
  if (
    !hasClmmEntryAnchor({
      entryPriceUsd: anchorPriceUsd,
      anchorBinId,
      lowerBinId: args.lowerBinId,
      upperBinId: args.upperBinId,
    }) ||
    !isClmmMarketPriced({ ...args, depositedUsd: anchorValueUsd })
  ) {
    return null;
  }
  const { lpValueUsd } = clmmPositionValue({
    sizeUsd: anchorValueUsd,
    anchorPrice: anchorPriceUsd,
    anchorBinId,
    currentPrice: args.currentPrice,
    lowerBinId: args.lowerBinId,
    upperBinId: args.upperBinId,
    binStep: args.binStep,
  });
  return Number.isFinite(lpValueUsd) && lpValueUsd >= 0 ? lpValueUsd : null;
}

/**
 * Entry anchor usable for CLMM pricing: known price/bin with the anchor bin
 * inside the range (a 50/50-at-anchor deposit). An outside anchor is a
 * single-sided shape this model must not price — fail open instead.
 */
function hasClmmEntryAnchor(args: {
  readonly entryPriceUsd: number | null;
  readonly anchorBinId: number | null;
  readonly lowerBinId: number;
  readonly upperBinId: number;
}): boolean {
  if (args.entryPriceUsd == null || args.anchorBinId == null) return false;
  if (!(args.entryPriceUsd > 0) || !Number.isFinite(args.anchorBinId)) return false;
  return args.anchorBinId >= args.lowerBinId && args.anchorBinId <= args.upperBinId;
}

/** Live market inputs usable for CLMM pricing (positive size/price/step, ordered range). */
function isClmmMarketPriced(args: {
  readonly depositedUsd: number;
  readonly currentPrice: number;
  readonly binStep: number;
  readonly lowerBinId: number;
  readonly upperBinId: number;
}): boolean {
  if (!(args.depositedUsd > 0) || !(args.currentPrice > 0)) return false;
  if (!Number.isFinite(args.currentPrice) || !(args.binStep > 0)) return false;
  return args.upperBinId > args.lowerBinId;
}
