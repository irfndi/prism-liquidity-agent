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
