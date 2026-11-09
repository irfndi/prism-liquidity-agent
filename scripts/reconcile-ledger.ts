#!/usr/bin/env bun
/**
 * Reconcile two live-ledger accounting defects against a Prism SQLite copy:
 *
 *   bun scripts/reconcile-ledger.ts --db /path/to/prism.db          # dry run
 *   bun scripts/reconcile-ledger.ts --db /path/to/prism.db --apply  # write
 *
 * - Phantom closes (empty on-chain reap booked as $0.00) are set to NULL and
 *   their EXIT events annotated with `pricing: "unresolved"`.
 * - NULL-realized settlement jobs whose position row has a realized value are
 *   completed from it. Jobs without a position row are reported, never priced.
 *
 * Idempotent: a second run plans nothing. Run it on a copy first; `--apply`
 * writes in one transaction.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { getPrismDbPath } from "../engine/paths.js";
import { applyLedgerReconcile, planLedgerReconcile } from "../engine/ledger-reconcile.js";

interface Args {
  readonly dbPath: string;
  readonly apply: boolean;
  readonly json: boolean;
}

// oxlint-disable-next-line complexity -- a small CLI flag parser; splitting it would hide the accepted forms.
function parseArgs(argv: readonly string[]): Args {
  let dbPath: string | null = null;
  let apply = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db" || arg === "-d") {
      dbPath = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg !== undefined && arg.startsWith("--db=")) {
      dbPath = arg.slice("--db=".length);
    }
  }
  return { dbPath: dbPath ?? process.env.SQLITE_DB_PATH ?? getPrismDbPath(), apply, json };
}

function fmtUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.dbPath)) {
    console.error(`reconcile-ledger: database not found: ${args.dbPath}`);
    process.exitCode = 1;
    return;
  }
  const db = new Database(args.dbPath, { readonly: !args.apply });
  try {
    const plan = planLedgerReconcile(db);
    const applied = args.apply
      ? applyLedgerReconcile(db, plan, Date.now())
      : { positionsUpdated: 0, eventsAnnotated: 0, jobsUpdated: 0 };
    const report = { ...plan, applied: args.apply, ...applied };
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`Ledger reconciliation — ${args.dbPath} (${args.apply ? "APPLY" : "dry run"})`);
    console.log(
      `Phantom closes: ${plan.phantomCloses.length} to repair` +
        ` (+${plan.zeroBasisCloseCount} zero-basis rows where 0 is already accurate)`,
    );
    for (const row of plan.phantomCloses) {
      console.log(
        `  ${row.positionId}  deposited ${fmtUsd(row.depositedUsd)}` +
          `  settlement ${fmtUsd(row.settlementOutputUsd)}` +
          `  → realized ${fmtUsd(row.derivedRealizedUsd)}`,
      );
    }
    console.log(`Settlement jobs completed from positions: ${plan.jobsToComplete.length}`);
    console.log(`Settlement jobs with no cost basis (left NULL): ${plan.unpriceableJobCount}`);
    console.log(`Settlement jobs waiting on an unpriced position: ${plan.waitingOnPositionCount}`);
    if (args.apply) {
      console.log(
        `Applied: positions ${applied.positionsUpdated}, EXIT events ${applied.eventsAnnotated}, jobs ${applied.jobsUpdated}`,
      );
    } else {
      console.log("No changes written. Re-run with --apply to commit the plan.");
    }
  } finally {
    db.close();
  }
}

main();
