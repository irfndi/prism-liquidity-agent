import { Database } from "bun:sqlite";
import { load as loadVec } from "sqlite-vec";
import path from "path";
import fs from "fs";

function setupCustomSQLite() {
  if (process.platform === "darwin") {
    try {
      const brewPrefix = process.arch === "arm64" ? "/opt/homebrew" : "/usr/local";
      const dylib = `${brewPrefix}/opt/sqlite/lib/libsqlite3.dylib`;
      if (fs.existsSync(dylib)) {
        Database.setCustomSQLite(dylib);
      }
    } catch {
      // ignore
    }
  }
}

export function createDatabase(dbPath = "./prism.db"): Database {
  setupCustomSQLite();
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  loadVec(db);
  runMigrations(db);
  return db;
}

// ─── Migration system ────────────────────────────────────────────────────────

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: Database) => void;
}

function hasTable(db: Database, name: string): boolean {
  const row = db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { "1": number } | null;
  return !!row;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return rows.some((r) => r.name === column);
}

const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    name: "initial_schema",
    up(db) {
      // Positions table
      db.exec(`
        CREATE TABLE IF NOT EXISTS positions (
          pool_address TEXT PRIMARY KEY,
          position_pubkey TEXT,
          deposited_usd REAL,
          current_value_usd REAL,
          token_x_symbol TEXT,
          token_y_symbol TEXT,
          active_bin_id INTEGER,
          lower_bin_id INTEGER,
          upper_bin_id INTEGER,
          timestamp INTEGER,
          out_of_range_since INTEGER,
          oor_cycle_count INTEGER DEFAULT 0,
          last_fee_claim_at INTEGER DEFAULT 0,
          last_rebalance_at INTEGER DEFAULT 0
        );
      `);

      // Audit table
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit (
          id TEXT PRIMARY KEY,
          timestamp INTEGER,
          cycle_id TEXT,
          pool_address TEXT,
          action TEXT,
          confidence REAL,
          reasoning TEXT,
          metrics_json TEXT,
          risk_result_json TEXT,
          executed INTEGER,
          paper_trading INTEGER,
          tx_signature TEXT,
          error TEXT
        );
      `);

      // Blacklist cache table
      db.exec(`
        CREATE TABLE IF NOT EXISTS blacklists (
          type TEXT,
          value TEXT,
          PRIMARY KEY (type, value)
        );
      `);

      // Memory vector table with sqlite-vec
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(
          embedding float[384],
          +id TEXT,
          +category TEXT,
          +content TEXT,
          +pool_address TEXT,
          +outcome TEXT,
          +pnlUsd REAL,
          +confidence REAL,
          +createdAt INTEGER,
          +expiresAt INTEGER
        );
      `);
    },
  },
  {
    version: 2,
    name: "add_trailing_stop_columns",
    up(db) {
      if (!hasColumn(db, "positions", "trailing_stop_threshold")) {
        db.exec("ALTER TABLE positions ADD COLUMN trailing_stop_threshold REAL");
      }
      if (!hasColumn(db, "positions", "highest_value_usd")) {
        db.exec("ALTER TABLE positions ADD COLUMN highest_value_usd REAL");
      }
    },
  },
  {
    version: 3,
    name: "add_last_rebalance_at",
    up(db) {
      if (!hasColumn(db, "positions", "last_rebalance_at")) {
        db.exec("ALTER TABLE positions ADD COLUMN last_rebalance_at INTEGER DEFAULT 0");
      }
    },
  },
];

function runMigrations(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const row = db.query("SELECT MAX(version) as v FROM _migrations").get() as {
    v: number | null;
  } | null;
  const currentVersion = row?.v ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;

    const alreadyApplied = db
      .query("SELECT 1 FROM _migrations WHERE version = ?")
      .get(migration.version) as { "1": number } | null;
    if (alreadyApplied) continue;

    db.transaction(() => {
      migration.up(db);
      (db.run as (sql: string, ...params: unknown[]) => void)(
        "INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)",
        migration.version,
        migration.name,
        Date.now(),
      );
    })();
  }
}
