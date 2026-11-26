/**
 * PnL ledger audit — the regression guard for the 2026-11-26 defect.
 *
 * The defect: the exit measured the whole wallet delta (deposit + rent refund
 * + fees) while the entry recorded only the deposit, so every clean close
 * booked refunded rent as profit. A flat round trip read as +16% on a $20
 * position, which kept the rolling halt, the pool kill switch and the operator
 * dashboard all reading "winning" while the wallet drained.
 *
 * Two things are checked here:
 *
 * 1. **Identity** — for every closed position the ledger must satisfy
 *    `realized = withdrawn + priorFees + rewards − deposit − modeledCosts`.
 *    Drift means a writer bypassed the shared realized path.
 * 2. **Provenance** — a LIVE close after the rent fix must carry a measured
 *    `entry_overhead_usd`. Missing provenance means that row's realized value
 *    is gross of rent and cannot be trusted; it is reported (and, with
 *    `--apply-rent-backfill`, set to NULL with a `pricing` marker, following
 *    the same convention as an unpriced exit: unknown, never a fabricated 0).
 *
 * Pure planning, explicit apply. A re-run after applying plans nothing.
 */
import type { Database } from "bun:sqlite";

/**
 * Closes on/after this instant must carry measured rent provenance.
 *
 * 2026-08-09 is when #205 switched the exit to the measured wallet delta
 * (`1fb7fbd`), which is what started folding the rent refund into realized
 * PnL. Every close since then was written without an `entry_overhead_usd`
 * column existing at all, so they are all unprovenanced.
 */
export const RENT_BASIS_EPOCH_MS = Date.parse("2026-08-09T00:00:00Z");

const IDENTITY_EPSILON_USD = 0.05;

export type AuditStatus = "ok" | "drift" | "unpriced" | "rent-unaccounted";

export interface AuditRow {
  readonly positionId: string;
  readonly closedAt: number | null;
  readonly positionPubKey: string | null;
  readonly depositedUsd: number | null;
  readonly realizedPnlUsd: number | null;
  readonly entryOverheadUsd: number | null;
  /** USD value the EXIT event recorded (the withdrawal, gross of overhead). */
  readonly withdrawnUsd: number | null;
  readonly modeledCostsUsd: number | null;
  /** Lifetime fees claimed, INCLUDING the exit sweep credited after realized. */
  readonly feesUsd: number;
  readonly rewardsUsd: number;
  /** The exit sweep credited after realized — must not be added twice. */
  readonly sweepFeeUsd: number;
}

export interface AuditFinding {
  readonly positionId: string;
  readonly status: AuditStatus;
  /** Signed USD gap between reported and re-derived realized. */
  readonly driftUsd: number | null;
  readonly reason: string;
}

export interface PnlAudit {
  readonly closedCount: number;
  readonly findings: readonly AuditFinding[];
  readonly counts: Readonly<Record<AuditStatus, number>>;
  /** Positions whose phantom profit must be voided (rent-unaccounted, live). */
  readonly rentBackfill: readonly string[];
  /** Reported total as stored. */
  readonly reportedUsd: number;
  /** Total once rent-unaccounted rows are removed (they are unknown, not 0). */
  readonly adjustedUsd: number;
}

/**
 * Re-derive realized PnL from the stored legs. Mirrors
 * `computeLedgerExitRealized`: withdrawn (already net of entry overhead on new
 * rows) + prior fees + rewards − deposit − modeled close costs.
 */
export function deriveRealizedUsd(row: AuditRow): number | null {
  if (row.depositedUsd === null || row.withdrawnUsd === null) return null;
  const costs = row.modeledCostsUsd ?? 0;
  // The withdrawal already contains the fees the close batch swept, and the
  // sweep is credited into `cumulative_fees_claimed_usd` AFTER realized is
  // computed. Adding the stored lifetime total would count them twice and
  // report every sweeping close as drift.
  const priorFees = Math.max(0, row.feesUsd - row.sweepFeeUsd);
  return row.withdrawnUsd + priorFees + row.rewardsUsd - row.depositedUsd - costs;
}

/**
 * Classify one closed position.
 *
 * Order matters: unresolved pricing wins over provenance (nothing to compare),
 * and provenance wins over identity (an unprovenanced row's identity can still
 * balance while being wrong about rent).
 */
export function auditRow(row: AuditRow): AuditFinding {
  if (row.realizedPnlUsd === null || row.withdrawnUsd === null) {
    return {
      positionId: row.positionId,
      status: "unpriced",
      driftUsd: null,
      reason: "no trusted withdrawal value (realized recorded as n/a)",
    };
  }
  if (
    row.positionPubKey !== null &&
    row.closedAt !== null &&
    row.closedAt >= RENT_BASIS_EPOCH_MS &&
    row.entryOverheadUsd === null
  ) {
    return {
      positionId: row.positionId,
      status: "rent-unaccounted",
      driftUsd: null,
      reason: "live close after the rent fix without measured entry overhead",
    };
  }
  const derived = deriveRealizedUsd(row);
  if (derived === null) {
    return {
      positionId: row.positionId,
      status: "drift",
      driftUsd: null,
      reason: "cost basis missing — realized cannot be re-derived",
    };
  }
  const drift = row.realizedPnlUsd - derived;
  if (Math.abs(drift) > IDENTITY_EPSILON_USD) {
    return {
      positionId: row.positionId,
      status: "drift",
      driftUsd: drift,
      reason: `reported ${row.realizedPnlUsd.toFixed(4)} vs derived ${derived.toFixed(4)}`,
    };
  }
  return { positionId: row.positionId, status: "ok", driftUsd: 0, reason: "" };
}

export function auditRows(rows: readonly AuditRow[]): PnlAudit {
  const findings = rows.map(auditRow);
  const counts: Record<AuditStatus, number> = {
    ok: 0,
    drift: 0,
    unpriced: 0,
    "rent-unaccounted": 0,
  };
  for (const f of findings) counts[f.status] += 1;
  const rentBackfill = findings
    .filter((f) => f.status === "rent-unaccounted")
    .map((f) => f.positionId);
  // Trusted-only means: re-derived from stored legs AND provenance intact.
  // Drift and unpriced rows stay out of it — a total labelled "trusted" must
  // not contain rows the same report just flagged.
  const okById = new Set(findings.filter((f) => f.status === "ok").map((f) => f.positionId));
  let reported = 0;
  let trusted = 0;
  for (const row of rows) {
    if (row.realizedPnlUsd === null) continue;
    reported += row.realizedPnlUsd;
    if (okById.has(row.positionId)) trusted += row.realizedPnlUsd;
  }
  return {
    closedCount: rows.length,
    findings,
    counts,
    rentBackfill,
    reportedUsd: reported,
    adjustedUsd: trusted,
  };
}

interface PositionDbRow {
  readonly position_id: string;
  readonly closed_at: number | null;
  readonly position_pubkey: string | null;
  readonly deposited_usd: number | null;
  readonly realized_pnl_usd: number | null;
  readonly entry_overhead_usd: number | null;
  readonly cumulative_fees_claimed_usd: number | null;
  readonly cumulative_rewards_claimed_usd: number | null;
  readonly withdrawn_usd: number | null;
  readonly modeled_costs_usd: number | null;
  readonly sweep_fee_usd: number | null;
}

/** Does a table carry this column? (Pre-migration databases do not.) */
function columnExists(db: Database, table: string, column: string): boolean {
  // SAFETY: PRAGMA table_info rows always carry a `name` TEXT column.
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

/** Read every closed position with the legs the audit needs (EXIT event joined). */
export function readClosedPositions(db: Database): AuditRow[] {
  // A pre-v26 database has no `entry_overhead_usd` column yet (the engine adds
  // it on its next start). Reading it directly would make the audit and the
  // backfill unusable exactly when they are most needed, so the column is
  // selected as NULL when absent — every row then classifies as unprovenanced.
  const overheadExpr = columnExists(db, "positions", "entry_overhead_usd")
    ? "p.entry_overhead_usd"
    : "NULL AS entry_overhead_usd";
  // SAFETY: the SELECT projects exactly these columns with these SQLite
  // affinities (REAL/integer ids, TEXT pubkeys, JSON scalar for the costs), so
  // each row matches PositionDbRow; a NULL column lands as null.
  const rows = db
    .query(
      `SELECT p.position_id, p.closed_at, p.position_pubkey, p.deposited_usd,
              p.realized_pnl_usd, ${overheadExpr},
              p.cumulative_fees_claimed_usd, p.cumulative_rewards_claimed_usd,
              (SELECT e.value_usd FROM position_events e
                 WHERE e.position_id = p.position_id AND e.event = 'EXIT'
                 ORDER BY e.created_at LIMIT 1) AS withdrawn_usd,
              (SELECT json_extract(e.metadata, '$.modeledCostsUsd') FROM position_events e
                 WHERE e.position_id = p.position_id AND e.event = 'EXIT'
                 ORDER BY e.created_at LIMIT 1) AS modeled_costs_usd,
              (SELECT COALESCE(SUM(e.fees_usd), 0) FROM position_events e
                 WHERE e.position_id = p.position_id AND e.event = 'CLAIM'
                   AND json_extract(e.metadata, '$.kind') = 'exit_sweep') AS sweep_fee_usd
         FROM positions p
        WHERE p.closed_at IS NOT NULL`,
    )
    .all() as PositionDbRow[];
  return rows.map((r) => ({
    positionId: r.position_id,
    closedAt: r.closed_at,
    positionPubKey: r.position_pubkey,
    depositedUsd: r.deposited_usd,
    realizedPnlUsd: r.realized_pnl_usd,
    entryOverheadUsd: r.entry_overhead_usd,
    withdrawnUsd: r.withdrawn_usd,
    modeledCostsUsd: r.modeled_costs_usd,
    feesUsd: r.cumulative_fees_claimed_usd ?? 0,
    rewardsUsd: r.cumulative_rewards_claimed_usd ?? 0,
    sweepFeeUsd: r.sweep_fee_usd ?? 0,
  }));
}

/**
 * Void the phantom profit on rent-unaccounted closes: realized becomes NULL
 * (unknown) and the row is tagged, so no PnL consumer counts a number that was
 * never measured. Returns the number of rows written; one transaction.
 */
export function applyRentBackfill(db: Database, positionIds: readonly string[]): number {
  if (positionIds.length === 0) return 0;
  const update = db.query("UPDATE positions SET realized_pnl_usd = NULL WHERE position_id = ?");
  const tag = db.query(
    `UPDATE position_events
        SET metadata = json_set(COALESCE(metadata, '{}'), '$.pricing', 'rentUnaccounted')
      WHERE position_id = ? AND event = 'EXIT'`,
  );
  db.transaction(() => {
    for (const id of positionIds) {
      update.run(id);
      tag.run(id);
    }
  })();
  return positionIds.length;
}
