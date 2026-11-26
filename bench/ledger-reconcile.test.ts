/** Ledger reconciliation: phantom empty-reap closes become NULL (never $0),
 *  settlement jobs complete from the position ledger, orphan jobs are reported
 *  and never priced, and a second run is a no-op. */
import { Database } from "bun:sqlite";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  applyLedgerReconcile,
  planLedgerReconcile,
  type LedgerReconcilePlan,
} from "../engine/ledger-reconcile.js";

interface SeedPosition {
  id: string;
  deposited: number;
  realized: number | null;
  exitValueUsd: number;
}

interface SeedJob {
  id: number;
  positionId: string | null;
  realized: number | null;
  outputUsd: number | null;
  costUsd: number | null;
  status: string;
}

function makeDb(positions: SeedPosition[], jobs: SeedJob[]): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE positions (
    position_id TEXT PRIMARY KEY,
    deposited_usd REAL NOT NULL,
    realized_pnl_usd REAL,
    closed_at INTEGER
  )`);
  db.run(`CREATE TABLE position_events (
    id TEXT PRIMARY KEY,
    position_id TEXT,
    event TEXT NOT NULL,
    value_usd REAL,
    metadata TEXT
  )`);
  db.run(`CREATE TABLE settlement_jobs (
    id INTEGER PRIMARY KEY,
    position_id TEXT,
    status TEXT NOT NULL,
    output_usd REAL,
    execution_cost_usd REAL,
    realized_pnl_usd REAL
  )`);
  const position = db.prepare(
    `INSERT INTO positions (position_id, deposited_usd, realized_pnl_usd, closed_at)
     VALUES (?, ?, ?, ?)`,
  );
  const event = db.prepare(
    `INSERT INTO position_events (id, position_id, event, value_usd, metadata)
     VALUES (?, ?, 'EXIT', ?, ?)`,
  );
  for (const row of positions) {
    position.run(row.id, row.deposited, row.realized, 1_780_000_000_000);
    event.run(
      `evt-${row.id}`,
      row.id,
      row.exitValueUsd,
      JSON.stringify({ settlementPending: 0, txSignature: `tx-${row.id}` }),
    );
  }
  const job = db.prepare(
    `INSERT INTO settlement_jobs (id, position_id, status, output_usd, execution_cost_usd, realized_pnl_usd)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const row of jobs) {
    job.run(row.id, row.positionId, row.status, row.outputUsd, row.costUsd, row.realized);
  }
  return db;
}

function seed(): Database {
  return makeDb(
    [
      // Empty reap with no settlement: nothing withdrawn, basis unverifiable.
      { id: "phantom-no-job", deposited: 25, realized: 0, exitValueUsd: 0 },
      // Empty reap whose settlement confirms a net $19.5 (20 output − 0.5 cost).
      { id: "phantom-with-job", deposited: 25, realized: 0, exitValueUsd: 0 },
      // Genuine break-even close: withdrew the full basis, not a phantom.
      { id: "real-breakeven", deposited: 50, realized: 0, exitValueUsd: 50 },
      // Position closed with a known realized value, job still unpriced.
      { id: "priced-position", deposited: 40, realized: 6.5, exitValueUsd: 46.5 },
      // Empty reap with no basis: 0 is already the accurate value.
      { id: "zero-basis", deposited: 0, realized: 0, exitValueUsd: 0 },
    ],
    [
      {
        id: 1,
        positionId: "phantom-with-job",
        realized: null,
        outputUsd: 20,
        costUsd: 0.5,
        status: "confirmed",
      },
      {
        id: 2,
        positionId: "priced-position",
        realized: null,
        outputUsd: 46.5,
        costUsd: 0,
        status: "confirmed",
      },
      // Settlement-only job: no position row, so no cost basis exists.
      {
        id: 3,
        positionId: "settlement-only",
        realized: null,
        outputUsd: 12,
        costUsd: 0,
        status: "confirmed",
      },
      // Already priced: never touched.
      {
        id: 4,
        positionId: "priced-position",
        realized: 6.5,
        outputUsd: 46.5,
        costUsd: 0,
        status: "confirmed",
      },
    ],
  );
}

/** Written-metadata contract asserted by the apply test. */
const ReconciledMetadata = Schema.fromJsonString(
  Schema.Struct({
    pricing: Schema.optional(Schema.String),
    emptyReap: Schema.optional(Schema.Boolean),
    txSignature: Schema.optional(Schema.String),
    reconciledAt: Schema.optional(Schema.String),
  }),
);

function realizedOf(db: Database, positionId: string): number | null {
  // SAFETY: the SELECT list returns exactly the asserted single column.
  const row = db
    .query(`SELECT realized_pnl_usd FROM positions WHERE position_id = ?`)
    .get(positionId) as { realized_pnl_usd: number | null };
  return row.realized_pnl_usd;
}

function jobRealized(db: Database, id: number): number | null {
  // SAFETY: the SELECT list returns exactly the asserted single column.
  const row = db.query(`SELECT realized_pnl_usd FROM settlement_jobs WHERE id = ?`).get(id) as {
    realized_pnl_usd: number | null;
  };
  return row.realized_pnl_usd;
}

describe("planLedgerReconcile", () => {
  it("finds only empty-reap closes and derives from confirmed settlement output", () => {
    const db = seed();
    const plan = planLedgerReconcile(db);
    expect(plan.phantomCloses.map((row) => row.positionId).sort()).toEqual([
      "phantom-no-job",
      "phantom-with-job",
    ]);
    const noJob = plan.phantomCloses.find((row) => row.positionId === "phantom-no-job");
    expect(noJob?.derivedRealizedUsd).toBeNull();
    const withJob = plan.phantomCloses.find((row) => row.positionId === "phantom-with-job");
    expect(withJob?.settlementOutputUsd).toBe(19.5);
    expect(withJob?.derivedRealizedUsd).toBeCloseTo(-5.5, 6);
  });

  it("completes jobs from the post-repair position value and reports orphans", () => {
    const db = seed();
    const plan = planLedgerReconcile(db);
    const completed = new Map(plan.jobsToComplete.map((row) => [row.jobId, row.realizedPnlUsd]));
    // The phantom's job must copy the DERIVED value, not the 0 being replaced.
    expect(completed.get(1)).toBeCloseTo(-5.5, 6);
    expect(completed.get(2)).toBe(6.5);
    expect(completed.has(4)).toBe(false); // already priced
    expect(plan.unpriceableJobCount).toBe(1); // settlement-only
    expect(plan.zeroBasisCloseCount).toBe(1);
  });
});

describe("applyLedgerReconcile", () => {
  it("writes NULL for an unverifiable reap and the derived value when settleable", () => {
    const db = seed();
    const plan = planLedgerReconcile(db);
    const changed = applyLedgerReconcile(db, plan, 1_780_000_100_000);
    expect(changed.positionsUpdated).toBe(2);
    expect(changed.eventsAnnotated).toBe(2);
    expect(changed.jobsUpdated).toBe(2);

    expect(realizedOf(db, "phantom-no-job")).toBeNull();
    expect(realizedOf(db, "phantom-with-job")).toBeCloseTo(-5.5, 6);
    // Untouched rows keep their values.
    expect(realizedOf(db, "real-breakeven")).toBe(0);
    expect(realizedOf(db, "priced-position")).toBe(6.5);
    expect(jobRealized(db, 3)).toBeNull();

    // SAFETY: the SELECT list returns exactly the asserted single column.
    const event = db
      .query(`SELECT metadata FROM position_events WHERE id = 'evt-phantom-no-job'`)
      .get() as { metadata: string };
    const metadata = Schema.decodeUnknownSync(ReconciledMetadata)(event.metadata);
    expect(metadata.pricing).toBe("unresolved");
    expect(metadata.emptyReap).toBe(true);
    expect(metadata.txSignature).toBe("tx-phantom-no-job"); // provenance kept
  });

  it("is idempotent: a second plan is empty and a second apply changes nothing", () => {
    const db = seed();
    applyLedgerReconcile(db, planLedgerReconcile(db), 1_780_000_100_000);
    const second: LedgerReconcilePlan = planLedgerReconcile(db);
    expect(second.phantomCloses).toHaveLength(0);
    expect(second.jobsToComplete).toHaveLength(0);
    const changed = applyLedgerReconcile(db, second, 1_780_000_200_000);
    expect(changed).toEqual({ positionsUpdated: 0, eventsAnnotated: 0, jobsUpdated: 0 });
  });
});
