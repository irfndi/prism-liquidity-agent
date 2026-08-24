/** Churn circuit breaker: per-pool same-day re-entry cap.
 *
 * Forensics (2026-08-22 audit, 379 closed positions): the engine's entire
 * all-time loss concentrates in two churned pools — 5rCf1DM8 lost −$163.33
 * across 221 round-trips and BGm1 −$64.76 across 125 — while a passive
 * backtest of 5rCf1DM8's own snapshots shows +$17.16 from simply holding.
 * The loss-per-trade tail (avg −$1.34) dwarfs the fee income per round-trip
 * ($7.31 fees claimed ALL-TIME), so trade COUNT itself is the damage
 * mechanism: every re-entry pays spread + slippage for a position whose
 * expected fee capture cannot amortize it at this account size.
 *
 * The existing pool-PnL kill switch arms only after ~10 closes AND a net
 * loss threshold; by then the bleed already happened. This guard caps
 * RE-ENTRIES per pool per UTC day BEFORE the losses accumulate. Exits are
 * never restricted — capital protection stays free; only NEW capital is
 * rationed.
 *
 * Pure module (like market-runner.ts / regime-gate.ts): no Effect services,
 * deterministic, fail-open on missing history.
 */

export interface ChurnEntry {
  /** Position open timestamp (ms epoch) — `PositionRecord.timestamp`. */
  readonly openedAt: number;
  /** True when the row was closed (closedAt != null). */
  readonly closed: boolean;
}

/** Count ENTERs on one pool within a UTC calendar day (UTC day boundaries:
 *  deterministic regardless of server timezone; hot-window's trip counter
 *  uses the same convention via `hotWindowDayKey`). */
export function countEntriesOnUtcDay(
  entries: ReadonlyArray<ChurnEntry>,
  dayStartUtcMs: number,
): number {
  const dayEnd = dayStartUtcMs + 86_400_000;
  return entries.filter((e) => e.openedAt >= dayStartUtcMs && e.openedAt < dayEnd).length;
}

/** UTC midnight (ms) of the timestamp. */
export function utcDayStart(nowMs: number): number {
  return Math.floor(nowMs / 86_400_000) * 86_400_000;
}

export interface ChurnGuardVerdict {
  /** True when an ENTER would exceed the daily cap → reject. */
  readonly blocked: boolean;
  /** Entries already made today (informational, for audit rows). */
  readonly todayCount: number;
}

/** Evaluate the per-pool daily churn cap. Fail-open: cap ≤ 0 disables the
 *  gate entirely (operator opt-out); missing history counts as zero. */
export function evaluateChurnGuard(params: {
  history: ReadonlyArray<ChurnEntry>;
  maxEntriesPerPoolPerDay: number;
  nowMs: number;
}): ChurnGuardVerdict {
  if (params.maxEntriesPerPoolPerDay <= 0) return { blocked: false, todayCount: 0 };
  const todayCount = countEntriesOnUtcDay(params.history, utcDayStart(params.nowMs));
  return { blocked: todayCount >= params.maxEntriesPerPoolPerDay, todayCount };
}
