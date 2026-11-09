import {
  GAS_RESERVE_LAMPORTS,
  MIN_SOL_FOR_ENTRY_LAMPORTS,
  SOL_ENTRY_TRANSACTION_BUFFER_LAMPORTS,
  SOL_MINT,
} from "./constants.js";

// Slippage/fee buffer applied to the SOL-funded portion of an entry estimate
// (mirrors the 1% input buffer entry-prep applies to swap inputs).
const SOL_PRICE_BUFFER_PCT = 1.01;

/** True when one of the pool's legs is native SOL (entries spend SOL on that leg). */
export function hasNativeSolLeg(pool: {
  readonly tokenX?: string | null;
  readonly tokenY?: string | null;
}): boolean {
  return pool.tokenX === SOL_MINT || pool.tokenY === SOL_MINT;
}

/** Converts a USD amount to lamports at the given SOL price, rounding up. */
export function usdToLamports(usd: number, solPriceUsd: number): bigint {
  if (!Number.isFinite(usd) || usd <= 0) return 0n;
  if (!Number.isFinite(solPriceUsd) || solPriceUsd <= 0) return 0n;
  return BigInt(Math.ceil((usd / solPriceUsd) * 1e9));
}

/**
 * Conservative estimate of the native SOL a single live ENTER can consume.
 *
 * Every live entry needs at least MIN_SOL_FOR_ENTRY_LAMPORTS (the existing
 * executeLive gate floor: gas + rent + ATA creation + priority-fee buffer).
 * On top of that:
 * - solFunded (autonomous canary/live) entries buy pool-token deficits with
 *   SOL swaps, so the worst case is the WHOLE position size funded by SOL;
 * - otherwise only the pool's SOL leg (half the entry) plus the wSOL wrap
 *   buffer comes from native SOL — non-SOL legs are USDC-funded.
 *
 * Over-estimating is safe: the gate only skips (never fails) an entry, and
 * the pool re-qualifies next cycle.
 */
export function estimateEntrySolLamports(input: {
  readonly positionSizeUsd: number;
  readonly solPriceUsd: number;
  readonly poolHasSolLeg: boolean;
  /** Autonomous canary/live mode: non-SOL legs are bought with SOL swaps. */
  readonly solFunded: boolean;
}): bigint {
  const legFraction = input.solFunded ? 1 : input.poolHasSolLeg ? 0.5 : 0;
  const legLamports = usdToLamports(
    input.positionSizeUsd * legFraction * SOL_PRICE_BUFFER_PCT,
    input.solPriceUsd,
  );
  const wrapBuffer = input.poolHasSolLeg ? SOL_ENTRY_TRANSACTION_BUFFER_LAMPORTS : 0n;
  return MIN_SOL_FOR_ENTRY_LAMPORTS + legLamports + wrapBuffer;
}

/**
 * Free SOL available for entries: native balance minus the gas reserve the
 * cycle must keep for its remaining transactions. Never negative.
 */
export function freeEntrySolLamports(nativeSolLamports: bigint): bigint {
  return nativeSolLamports > GAS_RESERVE_LAMPORTS ? nativeSolLamports - GAS_RESERVE_LAMPORTS : 0n;
}

export interface FitEntrySizeInput {
  readonly desiredSizeUsd: number;
  readonly freeSolLamports: bigint;
  readonly solPriceUsd: number;
  readonly poolHasSolLeg: boolean;
  readonly solFunded: boolean;
  /** Smallest position worth submitting (`ENTRY_SIZE_FLOOR_USD`). */
  readonly minSizeUsd: number;
}

function fitsSolBudget(sizeUsd: number, input: FitEntrySizeInput): boolean {
  return (
    estimateEntrySolLamports({
      positionSizeUsd: sizeUsd,
      solPriceUsd: input.solPriceUsd,
      poolHasSolLeg: input.poolHasSolLeg,
      solFunded: input.solFunded,
    }) <= input.freeSolLamports
  );
}

/**
 * Largest entry size at or below `desiredSizeUsd` that the free SOL can fund,
 * or null when even `minSizeUsd` does not fit.
 *
 * Minimal-capital operation: instead of skipping a qualifying entry because the
 * wallet is a few percent short, shrink the position (never below the $10
 * floor). Smaller sizes only relax risk/allocation caps, so every downstream
 * gate stays valid; the estimate is re-checked after the shrink so rounding
 * can never over-commit. Whole-dollar sizes keep the intent readable.
 */
function hasUsableFitInput(input: FitEntrySizeInput): boolean {
  return (
    Number.isFinite(input.desiredSizeUsd) &&
    input.desiredSizeUsd > 0 &&
    Number.isFinite(input.solPriceUsd) &&
    input.solPriceUsd > 0 &&
    Number.isFinite(input.minSizeUsd) &&
    input.minSizeUsd > 0 &&
    input.freeSolLamports > 0n
  );
}

/** Upper bound from the closed-form leg budget before the exact re-check. */
function maxAffordableEntryUsd(input: FitEntrySizeInput): number | null {
  const legFraction = input.solFunded ? 1 : input.poolHasSolLeg ? 0.5 : 0;
  const fixed =
    MIN_SOL_FOR_ENTRY_LAMPORTS + (input.poolHasSolLeg ? SOL_ENTRY_TRANSACTION_BUFFER_LAMPORTS : 0n);
  if (legFraction === 0 || input.freeSolLamports <= fixed) return null;
  const legBudgetSol = Number(input.freeSolLamports - fixed) / 1e9;
  return (legBudgetSol * input.solPriceUsd) / (legFraction * SOL_PRICE_BUFFER_PCT);
}

export function fitEntrySizeToSolBudget(input: FitEntrySizeInput): number | null {
  if (!hasUsableFitInput(input)) return null;
  if (fitsSolBudget(input.desiredSizeUsd, input)) return input.desiredSizeUsd;

  const maxUsd = maxAffordableEntryUsd(input);
  if (maxUsd === null) return null;
  const fitted = Math.floor(Math.min(input.desiredSizeUsd, maxUsd));
  if (!Number.isFinite(fitted) || fitted < input.minSizeUsd) return null;

  // Re-check the exact estimate (ceil/floor edges) and step down if needed.
  for (let size = fitted; size >= input.minSizeUsd; size -= 1) {
    if (fitsSolBudget(size, input)) return size;
  }
  return null;
}
