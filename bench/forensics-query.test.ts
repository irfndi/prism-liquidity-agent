import { afterEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readForensicsReport } from "../cli/forensics.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_000 * DAY_MS;

const SCHEMA = `
  CREATE TABLE audit (
    id TEXT PRIMARY KEY, timestamp INTEGER, cycle_id TEXT, pool_address TEXT,
    action TEXT, confidence REAL, reasoning TEXT, metrics_json TEXT,
    risk_result_json TEXT, executed INTEGER, paper_trading INTEGER,
    tx_signature TEXT, error TEXT
  );
  CREATE TABLE positions (
    position_id TEXT PRIMARY KEY, pool_address TEXT NOT NULL, position_pubkey TEXT,
    deposited_usd REAL, current_value_usd REAL, token_x_symbol TEXT, token_y_symbol TEXT,
    active_bin_id INTEGER, lower_bin_id INTEGER, upper_bin_id INTEGER, timestamp INTEGER,
    out_of_range_since INTEGER, oor_cycle_count INTEGER DEFAULT 0,
    last_fee_claim_at INTEGER DEFAULT 0, trailing_stop_threshold REAL,
    highest_value_usd REAL, last_rebalance_at INTEGER DEFAULT 0, paper_exited_at INTEGER,
    entry_signal_timestamp INTEGER, entry_signal_snapshot_id INTEGER, entry_price_usd REAL,
    entry_amount_x_usd REAL, entry_amount_y_usd REAL,
    cumulative_fees_claimed_usd REAL NOT NULL DEFAULT 0,
    cumulative_rewards_claimed_usd REAL NOT NULL DEFAULT 0,
    closed_at INTEGER, realized_pnl_usd REAL
  );
`;

let tempDir: string | null = null;

function makeDb(): string {
  tempDir = mkdtempSync(join(tmpdir(), "prism-forensics-"));
  const dbPath = join(tempDir, "prism.db");
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  db.close();
  return dbPath;
}

function insertAudit(
  dbPath: string,
  row: {
    id: string;
    timestamp: number;
    pool: string;
    action: string;
    reasoning: string;
    executed: number;
    riskJson: string | null;
  },
): void {
  const db = new Database(dbPath);
  db.query(
    `INSERT INTO audit (id, timestamp, cycle_id, pool_address, action, confidence, reasoning,
      metrics_json, risk_result_json, executed, paper_trading, tx_signature, error)
     VALUES (?, ?, 'cycle-1', ?, ?, 0.8, ?, NULL, ?, ?, 1, NULL, NULL)`,
  ).run(row.id, row.timestamp, row.pool, row.action, row.reasoning, row.riskJson, row.executed);
  db.close();
}

function insertPosition(
  dbPath: string,
  row: {
    id: string;
    pool: string;
    openedAt: number;
    closedAt: number | null;
    realized: number | null;
  },
): void {
  const db = new Database(dbPath);
  db.query(
    `INSERT INTO positions (position_id, pool_address, timestamp, closed_at, realized_pnl_usd,
      deposited_usd, token_x_symbol, token_y_symbol)
     VALUES (?, ?, ?, ?, ?, 100, 'SOL', 'USDC')`,
  ).run(row.id, row.pool, row.openedAt, row.closedAt, row.realized);
  db.close();
}

afterEach(() => {
  if (tempDir !== null) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("readForensicsReport", () => {
  it("joins audit ENTERs to closed positions and aggregates rejections", () => {
    const dbPath = makeDb();
    insertAudit(dbPath, {
      id: "a1",
      timestamp: NOW - 3 * DAY_MS,
      pool: "pool-a",
      action: "ENTER",
      reasoning: "[entry-net-gate] +$0.04 expected [weighted-score] 2.1",
      executed: 1,
      riskJson: '{"approved":true,"reason":"All risk checks passed"}',
    });
    insertAudit(dbPath, {
      id: "a2",
      timestamp: NOW - 2 * DAY_MS,
      pool: "pool-a",
      action: "ENTER",
      reasoning: "[fee-il-gate] Fee/IL 0.4 < 1.2",
      executed: 0,
      riskJson: '{"approved":false,"reason":"[fee-il-gate] Fee/IL 0.4 < 1.2"}',
    });
    insertPosition(dbPath, {
      id: "p1",
      pool: "pool-a",
      openedAt: NOW - 3 * DAY_MS + 60_000,
      closedAt: NOW - DAY_MS,
      realized: -12.5,
    });

    const report = readForensicsReport(dbPath, { now: NOW, windowDays: 30 });

    expect(report.closes).toBe(1);
    expect(report.pricedCloses).toBe(1);
    expect(report.netPnlUsd).toBeCloseTo(-12.5, 8);
    expect(report.rules.map((row) => row.ruleId).sort()).toEqual([
      "entry-net-gate",
      "weighted-score",
    ]);
    for (const row of report.rules) {
      expect(row.creditedPnlUsd).toBeCloseTo(-6.25, 8);
    }

    const rejection = report.rejections.find((row) => row.ruleId === "fee-il-gate");
    expect(rejection?.count).toBe(1);
    expect(rejection?.action).toBe("ENTER");

    expect(report.pools[0]?.poolAddress).toBe("pool-a");
    expect(report.pools[0]?.avgHoldDays).toBeCloseTo(2 - 1 / 1_440, 5);
  });

  it("honors the trailing window and --all", () => {
    const dbPath = makeDb();
    insertAudit(dbPath, {
      id: "a1",
      timestamp: NOW - 3 * DAY_MS,
      pool: "pool-a",
      action: "ENTER",
      reasoning: "[entry-net-gate] ok",
      executed: 1,
      riskJson: null,
    });
    insertPosition(dbPath, {
      id: "recent",
      pool: "pool-a",
      openedAt: NOW - 3 * DAY_MS,
      closedAt: NOW - DAY_MS,
      realized: -12.5,
    });
    insertAudit(dbPath, {
      id: "a2",
      timestamp: NOW - 45 * DAY_MS,
      pool: "pool-b",
      action: "ENTER",
      reasoning: "[churn-guard] capped",
      executed: 1,
      riskJson: null,
    });
    insertPosition(dbPath, {
      id: "old",
      pool: "pool-b",
      openedAt: NOW - 45 * DAY_MS,
      closedAt: NOW - 40 * DAY_MS,
      realized: -1,
    });

    const windowed = readForensicsReport(dbPath, { now: NOW, windowDays: 30 });
    expect(windowed.closes).toBe(1);
    expect(windowed.rules.map((row) => row.ruleId)).not.toContain("churn-guard");

    const all = readForensicsReport(dbPath, { now: NOW, all: true });
    expect(all.closes).toBe(2);
    expect(all.netPnlUsd).toBeCloseTo(-13.5, 8);
    expect(all.rules.map((row) => row.ruleId)).toContain("churn-guard");
  });

  it("fails loudly when the database does not exist", () => {
    expect(() => readForensicsReport(join(tmpdir(), "prism-does-not-exist.db"))).toThrow(
      /Database not found/,
    );
  });
});
