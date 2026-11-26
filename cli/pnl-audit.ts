import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { Command } from "commander";
import { getPrismDbPath } from "../engine/paths.js";
import {
  applyRentBackfill,
  auditRows,
  readClosedPositions,
  type PnlAudit,
} from "../engine/pnl-audit.js";

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
    } else if (arg === "--apply-rent-backfill") {
      apply = true;
    } else if (arg === "--json" || arg === "-j") {
      json = true;
    }
  }
  return { dbPath: dbPath ?? getPrismDbPath(), apply, json };
}

function money(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function printReport(
  audit: PnlAudit,
  rows: readonly { positionId: string }[],
  applied: number,
): void {
  const line = (label: string, value: string) => console.log(`${label.padEnd(22)} ${value}`);
  line("closed positions", String(audit.closedCount));
  line("identity ok", String(audit.counts.ok));
  line("drift", String(audit.counts.drift));
  line("unpriced (n/a)", String(audit.counts.unpriced));
  line("rent-unaccounted", String(audit.counts["rent-unaccounted"]));
  line("reported PnL", money(audit.reportedUsd));
  line("trusted-only PnL", money(audit.adjustedUsd));
  // Everything the report flagged: unpriced, drift and rent-unaccounted. The
  // trusted total above contains ONLY rows that re-derived and had provenance.
  line("excluded (n/a+drift+rent)", money(audit.reportedUsd - audit.adjustedUsd));
  if (audit.rentBackfill.length > 0) {
    line(
      "rent backfill",
      `${audit.rentBackfill.length} row(s)${applied > 0 ? " voided" : " pending --apply-rent-backfill"}`,
    );
  }
  const drift = audit.findings.filter((f) => f.status === "drift").slice(0, 10);
  if (drift.length > 0) {
    console.log("\nfirst drift findings");
    for (const f of drift) console.log(`  ${f.positionId}: ${f.reason}`);
  }
  if (audit.counts.drift > 0) {
    console.log(
      `\nFAIL: ${audit.counts.drift} position(s) do not satisfy realized = withdrawn + fees + rewards - deposit - costs`,
    );
  }
  void rows;
}

export function registerPnlAuditCommand(program: Command): void {
  program
    .command("audit-pnl")
    .description(
      "Verify the closed-position ledger (identity + rent provenance). Exits 1 on drift.",
    )
    .option("-d, --db <path>", "SQLite database path")
    .option("--apply-rent-backfill", "Void realized PnL on rows without measured rent basis")
    .option("-j, --json", "Emit the report as JSON")
    .action((options: { db?: string; applyRentBackfill?: boolean; json?: boolean }) => {
      const args = parseArgs([
        ...(options.db ? ["--db", options.db] : []),
        ...(options.applyRentBackfill ? ["--apply-rent-backfill"] : []),
        ...(options.json ? ["--json"] : []),
      ]);
      if (!existsSync(args.dbPath)) {
        console.error(`Database not found: ${args.dbPath}`);
        process.exit(1);
      }
      const db = new Database(args.dbPath, { readonly: !args.apply });
      try {
        const rows = readClosedPositions(db);
        const audit = auditRows(rows);
        const applied = args.apply ? applyRentBackfill(db, audit.rentBackfill) : 0;
        if (args.json) {
          console.log(JSON.stringify({ ...audit, applied }, null, 2));
        } else {
          printReport(audit, rows, applied);
        }
        process.exit(audit.counts.drift > 0 ? 1 : 0);
      } finally {
        db.close();
      }
    });
}
