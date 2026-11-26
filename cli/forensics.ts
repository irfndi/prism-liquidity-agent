import { existsSync } from "fs";
import { Database } from "bun:sqlite";
import { Command } from "commander";
import { Schema } from "effect";
import { getPrismDbPath } from "../engine/paths.js";
import {
  buildRuleAttribution,
  type AttributionDecision,
  type AttributionPosition,
  type RuleAttributionReport,
} from "../engine/rule-attribution.js";

const DAY_MS = 24 * 60 * 60 * 1000;

interface AuditRow {
  readonly timestamp: number;
  readonly pool_address: string;
  readonly action: string;
  readonly reasoning: string | null;
  readonly executed: number | boolean;
  readonly risk_result_json: string | null;
}

interface PositionRow {
  readonly position_id: string;
  readonly pool_address: string;
  readonly timestamp: number | null;
  readonly closed_at: number | null;
  readonly realized_pnl_usd: number | null;
  readonly deposited_usd: number | null;
  readonly token_x_symbol: string | null;
  readonly token_y_symbol: string | null;
}

export interface ForensicsOptions {
  /** Scan all history instead of a trailing window. */
  readonly all?: boolean;
  /** Trailing window in days (default 30, ignored when `all`). */
  readonly windowDays?: number;
  /** Max distance between an ENTER audit row and a position's open time. */
  readonly enterLookbackMs?: number;
  /** Injectable clock for deterministic tests. */
  readonly now?: number;
}

const RiskResultSchema = Schema.fromJsonString(
  Schema.Struct({ reason: Schema.optional(Schema.String) }),
);

/** `risk_result_json.reason`, fail-open to null on malformed JSON. */
function readRiskReason(json: string | null): string | null {
  if (json === null || json.length === 0) return null;
  try {
    return Schema.decodeUnknownSync(RiskResultSchema)(json).reason ?? null;
  } catch {
    return null;
  }
}

function toDecision(row: AuditRow): AttributionDecision {
  return {
    timestamp: Number(row.timestamp),
    poolAddress: row.pool_address,
    action: row.action,
    reasoning: row.reasoning ?? "",
    executed: Boolean(row.executed),
    riskReason: readRiskReason(row.risk_result_json),
  };
}

function toPosition(row: PositionRow): AttributionPosition {
  return {
    positionId: row.position_id,
    poolAddress: row.pool_address,
    openedAt: Number(row.timestamp ?? 0),
    closedAt: row.closed_at === null ? null : Number(row.closed_at),
    realizedPnlUsd: row.realized_pnl_usd === null ? null : Number(row.realized_pnl_usd),
    depositedUsd: Number(row.deposited_usd ?? 0),
    tokenXSymbol: row.token_x_symbol,
    tokenYSymbol: row.token_y_symbol,
  };
}

function loadAuditRows(db: Database, windowMs: number, cutoff: number): readonly AuditRow[] {
  const sql = `SELECT timestamp, pool_address, action, reasoning, executed, risk_result_json
      FROM audit${windowMs > 0 ? " WHERE timestamp >= ?" : ""} ORDER BY timestamp DESC`;
  const statement = db.query(sql);
  // SAFETY: the SELECT list is fixed and matches AuditRow field-for-field.
  return (windowMs > 0 ? statement.all(cutoff) : statement.all()) as AuditRow[];
}

function loadPositionRows(db: Database, windowMs: number, cutoff: number): readonly PositionRow[] {
  const sql = `SELECT position_id, pool_address, timestamp, closed_at,
        realized_pnl_usd, deposited_usd, token_x_symbol, token_y_symbol
      FROM positions
      WHERE closed_at IS NOT NULL${windowMs > 0 ? " AND closed_at >= ?" : ""}`;
  const statement = db.query(sql);
  // SAFETY: the SELECT list is fixed and matches PositionRow field-for-field.
  return (windowMs > 0 ? statement.all(cutoff) : statement.all()) as PositionRow[];
}

/**
 * Read the ledger read-only and build the attribution report. Opens with
 * SQLite `readonly` so a forensics run can never mutate (or migrate) the DB.
 */
export function readForensicsReport(
  dbPath: string,
  options: ForensicsOptions = {},
): RuleAttributionReport {
  if (!existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }

  const now = options.now ?? Date.now();
  const windowMs =
    options.all === true ? 0 : Math.max(1, Math.trunc(options.windowDays ?? 30)) * DAY_MS;
  const cutoff = windowMs > 0 ? now - windowMs : 0;

  const db = new Database(dbPath, { readonly: true });
  try {
    const auditRows = loadAuditRows(db, windowMs, cutoff);
    const positionRows = loadPositionRows(db, windowMs, cutoff);
    return buildRuleAttribution({
      decisions: auditRows.map(toDecision),
      positions: positionRows.map(toPosition),
      now,
      windowMs,
      ...(options.enterLookbackMs !== undefined && { enterLookbackMs: options.enterLookbackMs }),
    });
  } finally {
    db.close();
  }
}

function fmtUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function fmtPct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function fmtRatio(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(2);
}

function cell(value: string, width: number, align: "left" | "right" = "left"): string {
  const clipped = value.length > width ? `${value.slice(0, Math.max(0, width - 1))}~` : value;
  return align === "right" ? clipped.padStart(width) : clipped.padEnd(width);
}

function pairLabel(x: string | null, y: string | null): string {
  return `${x ?? "?"}/${y ?? "?"}`;
}

export function formatForensicsReport(
  report: RuleAttributionReport,
  dbPath: string,
  top: number,
): string {
  const lines: string[] = [];
  const windowLabel = report.windowMs > 0 ? `${report.windowMs / DAY_MS}d` : "all history";

  lines.push(`Prism forensics — ${dbPath}`);
  lines.push(
    `Window: ${windowLabel} | closes: ${report.closes} (${report.pricedCloses} priced) | ` +
      `net: ${fmtUsd(report.netPnlUsd)} | win: ${fmtPct(report.winRate)} | ` +
      `PF: ${fmtRatio(report.profitFactor)}`,
  );
  lines.push("");

  lines.push("RULE ATTRIBUTION (worst credited net first)");
  lines.push(
    cell("RULE", 28) +
      cell("CLOSES", 8, "right") +
      cell("PRICED", 8, "right") +
      cell("WIN", 8, "right") +
      cell("CREDITED", 12, "right") +
      cell("AVG", 10, "right") +
      cell("SOLO", 7, "right") +
      cell("SOLO NET", 12, "right"),
  );
  for (const row of report.rules.slice(0, top)) {
    lines.push(
      cell(row.ruleId, 28) +
        cell(String(row.closes), 8, "right") +
        cell(String(row.pricedCloses), 8, "right") +
        cell(fmtPct(row.winRate), 8, "right") +
        cell(fmtUsd(row.creditedPnlUsd), 12, "right") +
        cell(fmtUsd(row.avgCreditedPnlUsd), 10, "right") +
        cell(String(row.soloCloses), 7, "right") +
        cell(fmtUsd(row.soloNetPnlUsd), 12, "right"),
    );
  }
  lines.push("");

  lines.push("POOLS (worst net first)");
  lines.push(
    cell("POOL", 46) +
      cell("PAIR", 18) +
      cell("CLOSES", 8, "right") +
      cell("NET", 12, "right") +
      cell("WIN", 8, "right") +
      cell("HOLD(d)", 9, "right"),
  );
  for (const row of report.pools.slice(0, top)) {
    lines.push(
      cell(row.poolAddress, 46) +
        cell(pairLabel(row.tokenXSymbol, row.tokenYSymbol), 18) +
        cell(String(row.closes), 8, "right") +
        cell(fmtUsd(row.netPnlUsd), 12, "right") +
        cell(fmtPct(row.winRate), 8, "right") +
        cell(row.avgHoldDays === null ? "n/a" : row.avgHoldDays.toFixed(1), 9, "right"),
    );
  }
  lines.push("");

  lines.push("REJECTED DECISIONS (top blockers)");
  lines.push(cell("ACTION", 10) + cell("RULE", 34) + cell("COUNT", 8, "right"));
  for (const row of report.rejections.slice(0, top)) {
    lines.push(cell(row.action, 10) + cell(row.ruleId, 34) + cell(String(row.count), 8, "right"));
  }
  lines.push("");

  lines.push(
    `Attribution: entry rules on the ENTER co-fire share credit equally (${report.enterLookbackMs / 3_600_000}h lookback).`,
  );
  lines.push(
    `Unattributed closes (no ENTER in lookback): ${report.unattributedCloses} | untagged ENTERs: ${report.untaggedCloses}`,
  );
  lines.push(
    "Realized PnL is the ledger value (net of modeled close costs where recorded); NULL closes are excluded from PnL.",
  );
  return lines.join("\n");
}

export const forensicsCommand = new Command("forensics")
  .description("Per-rule and per-pool PnL attribution from the local ledger (read-only)")
  .option("-d, --db <path>", "SQLite database path")
  .option("-w, --window <days>", "Trailing window in days", "30")
  .option("-a, --all", "Scan all history")
  .option("-n, --top <n>", "Rows per table", "15")
  .option("-j, --json", "Emit the full report as JSON")
  .action(
    (opts: {
      readonly db?: string;
      readonly window: string;
      readonly all?: boolean;
      readonly top: string;
      readonly json?: boolean;
    }) => {
      const dbPath = opts.db ?? process.env.SQLITE_DB_PATH ?? getPrismDbPath();
      const parsedWindow = Number(opts.window);
      const parsedTop = Number(opts.top);
      const top = Number.isFinite(parsedTop)
        ? Math.min(200, Math.max(1, Math.trunc(parsedTop)))
        : 15;
      try {
        const report = readForensicsReport(dbPath, {
          all: opts.all === true,
          windowDays: Number.isFinite(parsedWindow) ? parsedWindow : 30,
        });
        if (opts.json === true) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(formatForensicsReport(report, dbPath, top));
        }
      } catch (error) {
        console.error(
          `forensics failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
      }
    },
  );
