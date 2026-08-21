/**
 * Rolling realized-PnL (loss) halt — a capital-protection circuit breaker for
 * new ENTERs.
 *
 * The high-frequency rotation lanes proved (live forensics, 2026-08) able to
 * churn a single pool hundreds of times per day on tiny positions, where
 * round-trip swap/spread cost plus IL reliably exceeds the fee capture and the
 * agent bleeds a steady negative realized PnL (50% win rate at -2.7% ROI =
 * pure cost drag, not signal loss). The halt is the anti-bleed control: while
 * the trailing realized PnL over the last `window` closed positions nets below
 * `thresholdUsd`, the engine pauses DEPLOYING NEW CAPITAL (blocked in the risk
 * gate). EXITs and REBALANCEs stay free — capital protection and position
 * management are never blocked. The halt is recomputed every scan cycle from
 * the DB, so it auto-lifts as soon as the strategy nets back above the
 * threshold. Fail-open: a missing/empty realized history never halts (cold
 * start does not freeze trading).
 */
export function rollingRealizedPnlHalted(
  realizedValues: ReadonlyArray<number | null | undefined>,
  window: number,
  thresholdUsd: number,
): boolean {
  const w = Math.max(1, Math.floor(window));
  const recent = realizedValues.slice(0, w);
  const known = recent.filter(
    // The array is typed `number | null | undefined`, so narrowing the
    // nullable entries (and rejecting non-finite values) yields only real
    // realized numbers — no `typeof` needed.
    (v): v is number => v !== null && v !== undefined && Number.isFinite(v),
  );
  if (known.length === 0) {
    // No closed/realized history whatsoever → warm start; do not freeze
    // trading on a cold ledger.
    return false;
  }
  const sum = known.reduce((acc, value) => acc + value, 0);
  return sum < thresholdUsd;
}
