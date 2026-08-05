/**
 * Spot TP-ladder + invalidation-stop lifecycle for fallen-angel positions
 * (Wave 19) — pure module.
 *
 * A fallen-angel position is a mean-reversion bet on a distressed-but-clean
 * token. It exits NOT by range-harvesting rebalance but by a ladder of
 * take-profit targets above entry plus a hard invalidation stop below it:
 *
 *   - TP ladder: `rungs` at ascending price targets (fractions ABOVE entry,
 *     e.g. +15% / +30% / +50%), each scaling out a `fraction` of the position.
 *   - Invalidation stop: when price falls to `entry × (1 − stopPct)`, the
 *     thesis is broken — EXIT at confidence 1 (capital protection).
 *
 * EXECUTION MODEL (locked user decision #3): the adapter's `exitPosition` is
 * full-close-only (no bps partial withdraw) and W14 on-chain limit orders are
 * blocked, so a rung is realized as a FULL EXIT at confidence 1 with a
 * `[tp-ladder]` reason, then the remaining fraction re-opens next scan cycle as
 * a fresh smaller fallen-angel position (scale-out via close-and-reopen). When
 * the last rung is hit (the whole ladder is complete), there is no remainder.
 *
 * All functions are pure and side-effect free; the caller persists state.
 */

export interface TpRung {
  /** Take-profit price target (absolute, in the pool's quote-asset price). */
  readonly targetPrice: number;
  /** Fraction of the position scaled out at this rung (0..1). */
  readonly fraction: number;
}

export interface TpLadder {
  readonly rungs: ReadonlyArray<TpRung>;
  /** Total fraction scaled out by the ladder (≤ 1). */
  readonly totalFraction: number;
}

export interface TpLadderConfig {
  /** TP rung targets as fractions ABOVE entry (e.g. [0.15, 0.30, 0.50]). */
  readonly rungs: ReadonlyArray<number>;
  /** Fraction to scale out per rung (e.g. [0.4, 0.3, 0.3]); renormalized to sum ≤ 1. */
  readonly fractions: ReadonlyArray<number>;
  /** Invalidation stop: EXIT when price ≤ entry × (1 − pct). */
  readonly invalidationStopPct: number;
}

/**
 * Build a TP ladder + invalidation price for a fallen-angel entry.
 * - rungs are entry × (1 + rungPct), in ascending order.
 * - fractions are capped at the number of rungs and renormalized so the total
 *   never exceeds 1 (excess is trimmed, not silently dropped from the middle).
 * - invalidationPrice = entry × (1 − invalidationStopPct).
 * Returns null when the config is empty (no rungs) or entry is non-positive.
 */
export function buildTpLadder(
  entryPrice: number,
  config: TpLadderConfig,
): { readonly ladder: TpLadder; readonly invalidationPrice: number } | null {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  const rungCount = Math.min(config.rungs.length, config.fractions.length);
  if (rungCount === 0) return null;

  // Pair each rung pct with its fraction BEFORE sorting, so an unsorted
  // input keeps each fraction attached to the target it belongs to.
  const pairs: Array<{ pct: number; fraction: number }> = config.rungs
    .slice(0, rungCount)
    .map((pct, i) => ({ pct, fraction: config.fractions[i]! }));
  pairs.sort((a, b) => a.pct - b.pct);
  const rawRungs: Array<{ targetPrice: number; fraction: number }> = pairs.map((pair) => ({
    targetPrice: entryPrice * (1 + pair.pct),
    fraction: pair.fraction,
  }));

  const total = rawRungs.reduce((sum, rung) => sum + rung.fraction, 0);
  // Renormalize so the ladder never scales out more than the whole position
  // (rebuild — fields are readonly, mutation is not allowed).
  const scale = total > 1 ? 1 / total : 1;
  const rungs: TpRung[] = rawRungs.map((rung) => ({
    targetPrice: rung.targetPrice,
    fraction: rung.fraction * scale,
  }));

  const invalidationPrice = entryPrice * (1 - config.invalidationStopPct);
  const totalFraction = rungs.reduce((sum, rung) => sum + rung.fraction, 0);
  return { ladder: { rungs, totalFraction }, invalidationPrice };
}

export type TpLadderActionStatus = "none" | "tp" | "invalidation";

export interface TpLadderEvaluation {
  readonly status: TpLadderActionStatus;
  /** The reached rung (status === "tp"), else undefined. */
  readonly rungReached?: TpRung;
  /** Fraction to scale out at this step (the reached rung's fraction). */
  readonly scaleOutFraction?: number;
  /** True when the reached rung is the last one (ladder complete → no remainder). */
  readonly ladderComplete?: boolean;
  /** Invalidation price (status === "invalidation"), else undefined. */
  readonly invalidationPrice?: number;
}

/**
 * Evaluate the ladder against the current price.
 * - invalidation fires first (capital protection): price ≤ invalidationPrice.
 * - otherwise the FIRST rung whose targetPrice ≤ price fires (a rung is
 *   "reached" once price rises to it; we take the lowest reached, since the
 *   position is scaled out monotonically).
 * - "none" when no rung is reached and the invalidation is not hit.
 */
export function evaluateTpLadder(
  currentPrice: number,
  ladder: TpLadder,
  invalidationPrice: number,
): TpLadderEvaluation {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { status: "none" };
  }
  if (currentPrice <= invalidationPrice) {
    return { status: "invalidation", invalidationPrice };
  }
  const reachedIndex = ladder.rungs.findIndex((rung) => currentPrice >= rung.targetPrice);
  if (reachedIndex === -1) return { status: "none" };
  const rungReached = ladder.rungs[reachedIndex]!;
  return {
    status: "tp",
    rungReached,
    scaleOutFraction: rungReached.fraction,
    ladderComplete: reachedIndex === ladder.rungs.length - 1,
  };
}

/**
 * Serialize a ladder to a compact JSON string for persistence (or null when
 * the ladder is undefined/empty).
 */
export function serializeTpLadder(ladder: TpLadder | undefined): string | null {
  if (ladder === undefined || ladder.rungs.length === 0) return null;
  return JSON.stringify(ladder);
}

/** Parse a persisted ladder JSON string back into a TpLadder (or null). */
export function parseTpLadder(raw: string | null | undefined): TpLadder | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { rungs?: Array<{ targetPrice: number; fraction: number }> };
    if (!Array.isArray(parsed.rungs) || parsed.rungs.length === 0) return null;
    const rungs = parsed.rungs
      .filter(
        (rung) =>
          Number.isFinite(rung.targetPrice) &&
          Number.isFinite(rung.fraction) &&
          rung.targetPrice > 0 &&
          rung.fraction > 0,
      )
      .map((rung) => ({ targetPrice: rung.targetPrice, fraction: rung.fraction }));
    if (rungs.length === 0) return null;
    return { rungs, totalFraction: rungs.reduce((sum, r) => sum + r.fraction, 0) };
  } catch {
    return null;
  }
}
