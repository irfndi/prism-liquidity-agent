/**
 * One-off ledger reconciliation for the two accounting defects found in the
 * 2026-10-30 live forensics:
 *
 * 1. **Phantom closes booked $0.00.** A closed position whose EXIT withdrew
 *    `value_usd = 0` (the on-chain account held no liquidity) was written with
 *    `realized_pnl_usd = 0`, which reads as a break-even trade and keeps the
 *    row out of the rolling-PnL halt and the pool kill switch. The live EXIT
 *    path now records such a close as NULL (`pricing: "unresolved"`); this
 *    module repairs the rows written before that fix.
 * 2. **Unpriced settlement jobs.** A job whose `realized_pnl_usd` is NULL but
 *    whose position row carries a realized value can be completed from the
 *    position ledger. Jobs with no position row have no cost basis and stay
 *    NULL — they are reported, never fabricated.
 *
 * Planning is read-only and idempotent; `applyLedgerReconcile` runs in one
 * transaction. A re-run after applying produces an empty plan.
 *
 * A settlement job settles one token mint, so its `output_usd` is a PARTIAL
 * position value and is never used as a cost-basis derivation. Only confirmed
 * full-position output backs a phantom re-derivation, and job completion
 * copies the position ledger rather than inventing a figure.
 */
import type { Database } from "bun:sqlite";
import { Schema } from "effect";

export interface PhantomClosePlan {
  readonly positionId: string;
  readonly depositedUsd: number;
  /** NULL when nothing was withdrawn and no settlement output exists. */
  readonly derivedRealizedUsd: number | null;
  /** Settlement output USD used for the derivation, null when none. */
  readonly settlementOutputUsd: number | null;
}

export interface JobCompletionPlan {
  readonly jobId: number;
  readonly positionId: string;
  readonly realizedPnlUsd: number;
}

export interface LedgerReconcilePlan {
  readonly phantomCloses: readonly PhantomClosePlan[];
  /** Empty-reap closes with a zero cost basis — 0 is already accurate there. */
  readonly zeroBasisCloseCount: number;
  readonly jobsToComplete: readonly JobCompletionPlan[];
  /** Jobs with NULL realized and no position row: no cost basis exists. */
  readonly unpriceableJobCount: number;
  /** NULL-realized jobs whose position row is itself still unpriced. */
  readonly waitingOnPositionCount: number;
}

export interface LedgerReconcileChanges {
  readonly positionsUpdated: number;
  readonly eventsAnnotated: number;
  readonly jobsUpdated: number;
}

export interface LedgerReconcileReport extends LedgerReconcilePlan, LedgerReconcileChanges {
  readonly applied: boolean;
}

interface PhantomRow {
  readonly position_id: string;
  readonly deposited_usd: number;
}

interface JobRow {
  readonly id: number;
  readonly position_id: string | null;
  readonly realized_pnl_usd: number | null;
  readonly output_usd: number | null;
  readonly execution_cost_usd: number | null;
  readonly status: string;
}

interface PositionRow {
  readonly position_id: string;
  readonly realized_pnl_usd: number | null;
}

interface EventRow {
  readonly id: string;
  readonly metadata: string | null;
}

/** Field subset the reconcile preserves from an EXIT event's metadata. */
const ExitMetadataSchema = Schema.Struct({
  txSignature: Schema.optional(Schema.String),
  settlementPending: Schema.optional(Schema.Number),
  exitReason: Schema.optional(Schema.String),
});
const ExitMetadataFromJson = Schema.fromJsonString(ExitMetadataSchema);
type ExitMetadata = Schema.Schema.Type<typeof ExitMetadataSchema>;

function parseExitMetadata(json: string | null): ExitMetadata {
  if (json === null || json.length === 0) return {};
  try {
    return Schema.decodeUnknownSync(ExitMetadataFromJson)(json);
  } catch {
    return {};
  }
}

/** Settlement output net of execution cost for one position, or null. */
function settlementNetUsd(jobs: readonly JobRow[], positionId: string): number | null {
  let output = 0;
  let cost = 0;
  let priced = false;
  for (const job of jobs) {
    if (job.position_id !== positionId) continue;
    // A PARTIAL group is not proceeds. Summing only the confirmed members books
    // a fraction of the exit, and finalizeSettlementGroups later preserves the
    // non-NULL realized value instead of correcting it. Stay unresolved until
    // every job for this position has confirmed, priced output.
    if (job.status !== "confirmed") return null;
    if (job.output_usd === null || !Number.isFinite(job.output_usd)) return null;
    output += job.output_usd;
    cost += job.execution_cost_usd ?? 0;
    priced = true;
  }
  return priced ? output - cost : null;
}

function planJobCompletions(
  jobs: readonly JobRow[],
  positionRealized: ReadonlyMap<string, number | null>,
): Pick<LedgerReconcilePlan, "jobsToComplete" | "unpriceableJobCount" | "waitingOnPositionCount"> {
  const jobsToComplete: JobCompletionPlan[] = [];
  let unpriceableJobCount = 0;
  let waitingOnPositionCount = 0;
  for (const job of jobs) {
    if (job.realized_pnl_usd !== null) continue;
    if (job.position_id === null || !positionRealized.has(job.position_id)) {
      unpriceableJobCount += 1;
      continue;
    }
    const realized = positionRealized.get(job.position_id);
    if (realized === null || realized === undefined) {
      waitingOnPositionCount += 1;
      continue;
    }
    jobsToComplete.push({
      jobId: job.id,
      positionId: job.position_id,
      realizedPnlUsd: realized,
    });
  }
  return { jobsToComplete, unpriceableJobCount, waitingOnPositionCount };
}

/**
 * Read-only plan. "Phantom" = a closed row with realized 0, a positive cost
 * basis, and an EXIT event that withdrew nothing; it is the exact shape the
 * live ledger produced when an empty position account was reaped.
 */
export function planLedgerReconcile(db: Database): LedgerReconcilePlan {
  const phantomQuery = db.query(
    `SELECT p.position_id, p.deposited_usd
       FROM positions p
      WHERE p.closed_at IS NOT NULL
        AND p.realized_pnl_usd = 0
        AND p.deposited_usd > 0
        AND EXISTS (
              SELECT 1 FROM position_events e
               WHERE e.position_id = p.position_id
                 AND e.event = 'EXIT'
                 AND e.value_usd = 0
            )
      ORDER BY p.closed_at ASC`,
  );
  // SAFETY: the SELECT list above matches PhantomRow field-for-field.
  const phantomRows = phantomQuery.all() as PhantomRow[];

  const jobsQuery = db.query(
    `SELECT id, position_id, realized_pnl_usd, output_usd, execution_cost_usd, status
       FROM settlement_jobs
      ORDER BY id ASC`,
  );
  // SAFETY: the SELECT list above matches JobRow field-for-field.
  const jobs = jobsQuery.all() as JobRow[];

  const zeroBasisQuery = db.query(
    `SELECT COUNT(*) AS n
       FROM positions p
      WHERE p.closed_at IS NOT NULL
        AND p.realized_pnl_usd = 0
        AND p.deposited_usd = 0
        AND EXISTS (
              SELECT 1 FROM position_events e
               WHERE e.position_id = p.position_id
                 AND e.event = 'EXIT'
                 AND e.value_usd = 0
            )`,
  );
  // SAFETY: COUNT(*) always returns exactly one integer row.
  const zeroBasis = zeroBasisQuery.get() as { n: number };

  const phantomCloses: PhantomClosePlan[] = [];
  for (const row of phantomRows) {
    const outputUsd = settlementNetUsd(jobs, row.position_id);
    phantomCloses.push({
      positionId: row.position_id,
      depositedUsd: row.deposited_usd,
      derivedRealizedUsd: outputUsd === null ? null : outputUsd - row.deposited_usd,
      settlementOutputUsd: outputUsd,
    });
  }

  const positionsQuery = db.query(`SELECT position_id, realized_pnl_usd FROM positions`);
  // SAFETY: the SELECT list above matches PositionRow field-for-field.
  const positioned = positionsQuery.all() as PositionRow[];
  const positionRealized = new Map<string, number | null>();
  for (const row of positioned) positionRealized.set(row.position_id, row.realized_pnl_usd);
  // The phantom repair changes the position's realized value, so job completion
  // must read the POST-repair value, never the 0 being replaced.
  for (const entry of phantomCloses) {
    positionRealized.set(entry.positionId, entry.derivedRealizedUsd);
  }

  const jobPlan = planJobCompletions(jobs, positionRealized);
  return {
    phantomCloses,
    zeroBasisCloseCount: zeroBasis.n,
    ...jobPlan,
  };
}

/** Rebuild an EXIT event's metadata with reconcile provenance. */
function reconcileMetadata(existing: string | null, entry: PhantomClosePlan, now: number): string {
  // `pricing: "unresolved"` is the documented marker for an unpriced close;
  // `emptyReap` says why. Known provenance (txSignature, settlementPending,
  // exitReason) is preserved so the audit trail stays complete.
  const base = parseExitMetadata(existing);
  return JSON.stringify({
    ...base,
    pricing: "unresolved",
    emptyReap: entry.settlementOutputUsd === null,
    reconciledAt: new Date(now).toISOString(),
    reconciliation: {
      reason:
        entry.settlementOutputUsd === null
          ? "withdrawal value 0 and no confirmed settlement output — cost basis unverifiable"
          : "re-derived from confirmed settlement output",
      depositedUsd: entry.depositedUsd,
      settlementOutputUsd: entry.settlementOutputUsd,
    },
  });
}

/** Apply a plan atomically. Returns what changed (all counts 0 on a no-op). */
export function applyLedgerReconcile(
  db: Database,
  plan: LedgerReconcilePlan,
  now: number,
): LedgerReconcileChanges {
  let positionsUpdated = 0;
  let eventsAnnotated = 0;
  let jobsUpdated = 0;

  db.transaction(() => {
    const updatePosition = db.prepare(
      `UPDATE positions SET realized_pnl_usd = ? WHERE position_id = ?`,
    );
    const selectEvents = db.prepare(
      `SELECT id, metadata FROM position_events
        WHERE position_id = ? AND event = 'EXIT' AND value_usd = 0`,
    );
    const updateEvent = db.prepare(`UPDATE position_events SET metadata = ? WHERE id = ?`);

    for (const entry of plan.phantomCloses) {
      updatePosition.run(entry.derivedRealizedUsd, entry.positionId);
      positionsUpdated += 1;
      // SAFETY: the SELECT list above matches EventRow field-for-field.
      const events = selectEvents.all(entry.positionId) as EventRow[];
      for (const event of events) {
        updateEvent.run(reconcileMetadata(event.metadata, entry, now), event.id);
        eventsAnnotated += 1;
      }
    }

    const updateJob = db.prepare(
      `UPDATE settlement_jobs SET realized_pnl_usd = ? WHERE id = ? AND realized_pnl_usd IS NULL`,
    );
    for (const job of plan.jobsToComplete) {
      updateJob.run(job.realizedPnlUsd, job.jobId);
      jobsUpdated += 1;
    }
  })();

  return { positionsUpdated, eventsAnnotated, jobsUpdated };
}
