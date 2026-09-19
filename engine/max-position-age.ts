/**
 * Hard age backstop (field-research-driven): EXIT once a position has been
 * open longer than maxAgeMs, regardless of measured-fee status. Every other
 * economic exit (fee/IL, yield-regression) skips when the pool's fee data is
 * unmeasured (gecko/heuristic statsSource) — this is the only gate that
 * still fires then, so a position with no measured signal can't drift
 * indefinitely. Launch-mode positions are exempt: their own timebox
 * lifecycle already bounds their age far tighter than this backstop.
 */

export interface MaxPositionAgeInput {
  readonly positionMode: string | null;
  readonly ageMs: number;
  /** ms. ≤0 disables. */
  readonly maxAgeMs: number;
}

/** True when the position has aged past the backstop and isn't launch-mode. */
export function isMaxPositionAgeBreached(input: MaxPositionAgeInput): boolean {
  if (!Number.isFinite(input.maxAgeMs) || input.maxAgeMs <= 0) return false;
  if (input.positionMode === "launch") return false;
  if (!Number.isFinite(input.ageMs)) return false;
  return input.ageMs >= input.maxAgeMs;
}

/** Bracket-tagged EXIT reasoning for ledger slicing. */
export function maxPositionAgeReasoning(input: MaxPositionAgeInput): string {
  const ageHours = input.ageMs / 3_600_000;
  const maxAgeHours = input.maxAgeMs / 3_600_000;
  return `[max-position-age] age ${ageHours.toFixed(1)}h >= ${maxAgeHours.toFixed(1)}h backstop — closing regardless of measured-fee status`;
}

/**
 * Fee-starvation exit (field evidence 2026-09: launch survivors sat 228h with
 * ~$0.06-0.17 fees on $50 deposits — mark held at entry, zero yield, slot
 * occupied. Dust-exit can't see them (mark >> $5); the launch timebox didn't
 * fire because the pools left the scan set. Fires when a position is BOTH old
 * AND fee-starved: age past starveAgeMs with cumulative fees (swap + rewards)
 * below starveFeesUsd. Ledger-verified safe: zero closes exceed 53h, so a
 * 72h+ starvation age has zero backtest churn — it fires only on survivors
 * and future stuck capital, never on live earners (which accrue fees well
 * before the age, or close through a normal lane first).
 */

export interface FeeStarvationInput {
  readonly ageMs: number;
  readonly cumulativeFeesUsd: number;
  readonly cumulativeRewardsUsd: number;
  /** ms. ≤0 disables. */
  readonly starveAgeMs: number;
  /** USD floor below which fees count as starvation. */
  readonly starveFeesUsd: number;
}

/** True when the position is old AND has earned essentially nothing. */
export function isFeeStarved(input: FeeStarvationInput): boolean {
  if (!Number.isFinite(input.starveAgeMs) || input.starveAgeMs <= 0) return false;
  if (!Number.isFinite(input.ageMs) || input.ageMs < input.starveAgeMs) return false;
  const earned =
    (Number.isFinite(input.cumulativeFeesUsd) ? input.cumulativeFeesUsd : 0) +
    (Number.isFinite(input.cumulativeRewardsUsd) ? input.cumulativeRewardsUsd : 0);
  return earned < input.starveFeesUsd;
}

/** Bracket-tagged EXIT reasoning for ledger slicing. */
export function feeStarvationReasoning(input: FeeStarvationInput): string {
  const ageHours = input.ageMs / 3_600_000;
  const earned = input.cumulativeFeesUsd + input.cumulativeRewardsUsd;
  return `[fee-starvation] age ${ageHours.toFixed(1)}h with $${earned.toFixed(2)} fees — dead capital, reclaiming slot`;
}
