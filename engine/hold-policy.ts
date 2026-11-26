/**
 * Dynamic hold policy: how long a position must live before an ECONOMIC exit
 * is allowed to fire.
 *
 * A fixed maturity gate (`MIN_YIELD_EXIT_AGE_MS`, 12h) is wrong in both
 * directions:
 *
 * - A pool paying 30,000% APR covers its round trip in ~5 minutes. Holding it
 *   12h before an exit may fire means bleeding IL for 12h on a position that
 *   already paid for itself.
 * - A pool paying 40% APR needs ~11 days. Exiting at 12h realizes a loss that
 *   time would have erased — the exact churn the maturity gate was added for.
 *
 * The measured rate that matters is the one the position is ACTUALLY earning:
 * `accruedFees / age`. From that, the time needed to cover the round trip is
 *
 *     breakEvenHoldMs = roundTripCostUsd × ageMs / accruedFeesUsd
 *
 * which is the same identity as `cost% × 365 / APR%` but uses realized fees
 * instead of a modeled pool APR, so a decaying pool cannot keep a long grace
 * period it no longer earns.
 *
 * Unknown (no age, no fees yet, no cost) falls back to the configured static
 * gate — never to zero, which would remove the protection entirely.
 */

const DAY_MS = 86_400_000;

/**
 * OPTIONAL ceiling on the dynamic grace period. Not applied by default: the
 * measured break-even hold is the whole point, and capping it silently
 * re-imposes the fixed gate this module exists to remove (a 40% APR pool needs
 * ~11 days; a 24h cap would authorise its exit at 24h, which is the original
 * bug moved from 12h to 24h). Dead capital is caught by the real backstops
 * that are still wired: `MAX_POSITION_AGE_MS` (7d) and the fee-starvation
 * exit (72h).
 */
export const LEGACY_MATURITY_CAP_MS = DAY_MS;

export interface BreakEvenHoldInput {
  readonly ageMs: number;
  /** Fees this position has actually accrued (claimed + pending mark), USD. */
  readonly accruedFeesUsd: number;
  /** One round trip in USD (entry+exit swap, gas, harvest). */
  readonly roundTripCostUsd: number;
}

/**
 * Time for the position's OWN realized fee rate to cover one round trip.
 * `null` when unmeasurable: age <= 0, no fees accrued yet, or no cost.
 *
 * Deliberately unbounded here — the caller clamps with `resolveExitMaturityMs`
 * so tests can assert the raw identity.
 */
export function breakEvenHoldMs(input: BreakEvenHoldInput): number | null {
  const { ageMs, accruedFeesUsd, roundTripCostUsd } = input;
  if (!(ageMs > 0) || !(accruedFeesUsd > 0) || !(roundTripCostUsd > 0)) return null;
  const hold = (roundTripCostUsd * ageMs) / accruedFeesUsd;
  return Number.isFinite(hold) && hold > 0 ? hold : null;
}

export interface ExitMaturityInput extends BreakEvenHoldInput {
  /** Configured static gate (`MIN_YIELD_EXIT_AGE_MS`) — used when unknown. */
  readonly fallbackMs: number;
  /** Optional ceiling on the dynamic value (none by default). */
  readonly capMs?: number | undefined;
}

/**
 * The age an economic EXIT must wait for: the break-even hold when the
 * position's realized fee rate is known, else the static fallback. No cap by
 * default — a cap would defeat the measurement (see `LEGACY_MATURITY_CAP_MS`).
 */
export function resolveExitMaturityMs(input: ExitMaturityInput): number {
  const fallback = Number.isFinite(input.fallbackMs) ? Math.max(0, input.fallbackMs) : 0;
  const measured = breakEvenHoldMs(input);
  if (measured === null) return fallback;
  const capValue = input.capMs;
  if (capValue === undefined || !Number.isFinite(capValue)) return measured;
  return Math.min(measured, Math.max(0, capValue));
}
