/**
 * Pure entry-size math, extracted verbatim from the ENTER slot in
 * engine/program.ts so both the normal entry path and the opt-in
 * idle-capital redeploy pass share one source of truth.
 */

/** Fraction of the wallet balance the conservative entry size may use. */
export const ENTRY_SIZE_WALLET_FRACTION = 0.5;
/** Fraction of pool TVL the conservative entry size may use. */
export const ENTRY_SIZE_TVL_FRACTION = 0.005;
/** Hard dollar ceiling on a normal (conservative) entry. */
export const ENTRY_SIZE_CAP_USD = 500;
/** Minimum entry size worth submitting, normal and redeploy paths alike. */
export const ENTRY_SIZE_FLOOR_USD = 10;

export interface EntrySizeInput {
  readonly walletBalanceUsd: number;
  readonly tvlUsd: number;
  /** Hard dollar ceiling on the entry; defaults to ENTRY_SIZE_CAP_USD. */
  readonly maxSizeUsd?: number;
}

/**
 * Conservative base entry size: the tightest of half the wallet balance,
 * 0.5% of pool TVL, and the ceiling (ENTRY_SIZE_CAP_USD by default, or the
 * caller's `maxSizeUsd`), with a $10 floor. Byte-identical to the legacy
 * inline formula (`max(min(walletBalanceUsd * 0.5, tvlUsd * 0.005, 500), 10)`)
 * when no override is supplied — this path is UNCHANGED by the idle-redeploy
 * feature; the wider redeploy size is computed separately by the redeploy
 * pass (see computeIdleRedeploySizeUsd) and still re-capped by every risk
 * gate downstream.
 */
export function computeEntrySizeUsd(input: EntrySizeInput): number {
  const maxPositionSize = Math.min(
    input.walletBalanceUsd * ENTRY_SIZE_WALLET_FRACTION,
    input.tvlUsd * ENTRY_SIZE_TVL_FRACTION,
    input.maxSizeUsd ?? ENTRY_SIZE_CAP_USD,
  );
  return Math.max(maxPositionSize, ENTRY_SIZE_FLOOR_USD);
}

export interface IdleRedeploySizeInput {
  /** Idle capital detected this cycle (USDC wallet balance live; undeployed paper seed). */
  readonly idleCapitalUsd: number;
  /** Portfolio value = wallet + open positions, as sized by the risk gates. */
  readonly portfolioValueUsd: number;
  /** MAX_PER_POOL_ALLOCATION_PCT — the redeploy size never exceeds this share. */
  readonly maxPerPoolAllocationPct: number;
  /** IDLE_REDEPLOY_MAX_SIZE_USD — the configured hard ceiling on one redeploy. */
  readonly maxSizeUsd: number;
}

/**
 * Wider idle-capital deployment size proposed by the redeploy pass: half the
 * idle capital, bounded by the per-pool allocation share of the portfolio and
 * the configured idle-redeploy ceiling, floored at 0 (the pass applies the
 * shared $10 floor before dispatching). This is the "larger than the
 * conservative default" size; evaluatePerPoolAllocation and risk gate 6
 * re-cap it to the pool's real remaining headroom before execution, so it
 * widens the CEILING without ever breaching a cap.
 */
export function computeIdleRedeploySizeUsd(input: IdleRedeploySizeInput): number {
  return Math.max(
    Math.min(
      input.idleCapitalUsd * ENTRY_SIZE_WALLET_FRACTION,
      input.portfolioValueUsd * input.maxPerPoolAllocationPct,
      input.maxSizeUsd,
    ),
    0,
  );
}
