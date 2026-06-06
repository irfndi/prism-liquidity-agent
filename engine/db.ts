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
    return;
  }

  // Bun's bundled SQLite lacks sqlite-vec (loadable extensions). On Linux
  // we point at the system libsqlite3 so vec0 works out of the box.
  if (process.platform === "linux") {
    const candidates = [
      "/usr/lib/x86_64-linux-gnu/libsqlite3.so",
      "/usr/lib/x86_64-linux-gnu/libsqlite3.so.0",
      "/usr/lib/aarch64-linux-gnu/libsqlite3.so",
      "/usr/lib/aarch64-linux-gnu/libsqlite3.so.0",
      "/usr/lib/libsqlite3.so",
      "/usr/lib/libsqlite3.so.0",
      "/usr/lib64/libsqlite3.so",
      "/usr/lib64/libsqlite3.so.0",
      "/lib/x86_64-linux-gnu/libsqlite3.so",
      "/lib/x86_64-linux-gnu/libsqlite3.so.0",
      "/lib/aarch64-linux-gnu/libsqlite3.so",
      "/lib/aarch64-linux-gnu/libsqlite3.so.0",
    ];
    for (const soPath of candidates) {
      if (fs.existsSync(soPath)) {
        try {
          Database.setCustomSQLite(soPath);
          return;
        } catch {
          // fall through to next candidate
        }
      }
    }
    console.warn(
      "[db] No system libsqlite3.so found on Linux; sqlite-vec may not work. " +
        "Install libsqlite3-dev or set Database.setCustomSQLite() manually.",
    );
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
  {
    version: 4,
    name: "add_pool_snapshots",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pool_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pool_address TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          active_bin_id INTEGER NOT NULL,
          tvl_usd REAL NOT NULL,
          volume_24h_usd REAL NOT NULL,
          fees_24h_usd REAL NOT NULL,
          apr REAL NOT NULL,
          current_price REAL NOT NULL,
          bin_step INTEGER NOT NULL,
          token_x_symbol TEXT,
          token_y_symbol TEXT,
          bin_array_json TEXT NOT NULL
        );
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_snapshots_pool_time
          ON pool_snapshots(pool_address, timestamp);
      `);
    },
  },
  {
    version: 5,
    name: "add_agent_feedback",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_feedback (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          category TEXT NOT NULL,
          severity TEXT NOT NULL,
          summary TEXT NOT NULL,
          details TEXT,
          related_files TEXT,
          context_json TEXT,
          github_issue_number INTEGER,
          github_issue_url TEXT,
          reported_at INTEGER NOT NULL,
          hash TEXT NOT NULL
        );
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_feedback_hash
          ON agent_feedback(hash);
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_feedback_agent_time
          ON agent_feedback(agent_id, reported_at);
      `);
    },
  },
  {
    version: 6,
    name: "add_paper_exited_at",
    up(db) {
      if (!hasColumn(db, "positions", "paper_exited_at")) {
        db.exec("ALTER TABLE positions ADD COLUMN paper_exited_at INTEGER");
      }
    },
  },
  {
    version: 7,
    name: "pool_snapshots_unique_pool_time",
    up(db) {
      // Dedupe any rows that already exist before adding the unique index
      // (idempotent re-imports of historical OHLCV via ops/fetch-history.ts).
      db.exec(`
        DELETE FROM pool_snapshots
        WHERE id NOT IN (
          SELECT MIN(id) FROM pool_snapshots
          GROUP BY pool_address, timestamp
        );
      `);
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_snapshots_pool_time
          ON pool_snapshots(pool_address, timestamp);
      `);
    },
  },
  {
    version: 8,
    name: "referral_tables",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS referral_codes (
          code TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          expires_at INTEGER
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS referral_uses (
          id TEXT PRIMARY KEY,
          code TEXT NOT NULL,
          used_by TEXT NOT NULL UNIQUE,
          used_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_credits (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          amount REAL NOT NULL,
          reason TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          expires_at INTEGER
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_referral_codes_user ON referral_codes(user_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_referral_uses_code ON referral_uses(code)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_user_credits_user ON user_credits(user_id)`);
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
