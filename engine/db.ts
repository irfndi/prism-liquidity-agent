import { Database } from "bun:sqlite";
import { load as loadVec } from "sqlite-vec";
import path from "path";
import fs from "fs";
import { createLogger } from "./logger.js";
import { getEmbeddedVec0Path } from "./sqlite-vec-embedded.js";

const logger = createLogger("db");
let sqliteVecEverFailed = false;
// Database.setCustomSQLite() is a process-wide one-shot; once any candidate
// wins, later callers (createDatabase, probeVecAvailability) skip the loop.
let customSQLiteConfigured = false;

/**
 * Actionable remediation for sqlite-vec load failures. Shared by the runtime
 * warn paths below and the loud `prism doctor` memory check (cli/doctor.ts).
 */
export function vecRemediationHint(platform: string = process.platform): string {
  if (platform === "darwin") {
    return "Install an extension-capable SQLite (macOS: `brew install sqlite`) and restart; release bundles ship lib/vec0.dylib, so verify PRISM_VEC0_PATH (set by the prism wrapper) and run `prism doctor`.";
  }
  if (platform === "linux") {
    return "Install an extension-capable SQLite (Linux: `apt-get install -y libsqlite3-0` or `dnf install -y sqlite-libs`) and restart; release bundles ship lib/vec0.so, so verify PRISM_VEC0_PATH and run `prism doctor`.";
  }
  return "Install an extension-capable SQLite (compiled with loadable-extension support) and restart; verify PRISM_VEC0_PATH and run `prism doctor`.";
}

function setupCustomSQLite() {
  if (customSQLiteConfigured) return;

  if (process.platform === "darwin") {
    // Bun's bundled SQLite cannot load extensions; sqlite-vec needs a system
    // libsqlite3 built with extension loading. Homebrew first — it is the only
    // extension-capable candidate. The eager dlopen in setCustomSQLite() doubles
    // as the existence check, which matters because Apple's /usr/lib library has
    // no on-disk file (dyld shared cache) yet still dlopens — only to fail vec0
    // loading, which prism doctor then reports loudly as a last-resort fallback.
    const brewPrefix = process.arch === "arm64" ? "/opt/homebrew" : "/usr/local";
    const otherBrewPrefix = process.arch === "arm64" ? "/usr/local" : "/opt/homebrew";
    const candidates = [
      `${brewPrefix}/opt/sqlite/lib/libsqlite3.dylib`,
      `${otherBrewPrefix}/opt/sqlite/lib/libsqlite3.dylib`,
      "/usr/lib/libsqlite3.dylib",
      "/opt/local/lib/libsqlite3.dylib",
    ];
    for (const dylib of candidates) {
      try {
        Database.setCustomSQLite(dylib);
        customSQLiteConfigured = true;
        return;
      } catch {
        // candidate missing or not loadable — fall through to the next one
      }
    }
    logger.warn("No loadable libsqlite3.dylib found on macOS; sqlite-vec may not work", {
      hint: vecRemediationHint("darwin"),
    });
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
          customSQLiteConfigured = true;
          return;
        } catch {
          // fall through to next candidate
        }
      }
    }
    logger.warn("No system libsqlite3.so found on Linux; sqlite-vec may not work", {
      hint: vecRemediationHint("linux"),
    });
  }
}

export function createDatabase(dbPath = "./prism.db"): Database {
  setupCustomSQLite();
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");

  // Load sqlite-vec before migrations so migration v1 can create the vec_memory
  // virtual table without warning. Extension availability is determined by the
  // runtime environment and won't change within a process, so a process-wide
  // flag is used to skip repeated failing attempts.
  let vecLoaded = false;
  if (!sqliteVecEverFailed) {
    try {
      loadVec(db);
      vecLoaded = true;
    } catch (e) {
      const envPath = process.env.PRISM_VEC0_PATH;
      if (envPath) {
        try {
          db.loadExtension(envPath);
          vecLoaded = true;
        } catch (envErr) {
          logger.warn("PRISM_VEC0_PATH sqlite-vec extension could not be loaded", {
            error: envErr instanceof Error ? envErr.message : String(envErr),
            hint: vecRemediationHint(),
          });
        }
      }
      if (!vecLoaded) {
        const embeddedPath = getEmbeddedVec0Path();
        if (embeddedPath) {
          try {
            db.loadExtension(embeddedPath);
            vecLoaded = true;
          } catch (embeddedErr) {
            logger.warn("Embedded sqlite-vec extension could not be loaded", {
              error: embeddedErr instanceof Error ? embeddedErr.message : String(embeddedErr),
              hint: vecRemediationHint(),
            });
          }
        }
      }
      if (!vecLoaded) {
        logger.warn("sqlite-vec extension could not be loaded; memory will be disabled", {
          error: e instanceof Error ? e.message : String(e),
          hint: vecRemediationHint(),
        });
        sqliteVecEverFailed = true;
      }
    }
  }

  runMigrations(db);

  if (vecLoaded && !hasVecMemoryTable(db)) {
    tryCreateVecMemoryTable(db);
    if (hasVecMemoryTable(db)) {
      logger.info("sqlite-vec vec_memory table self-healed");
    } else {
      logger.warn("sqlite-vec vec_memory table not queryable; memory disabled", {
        hint: vecRemediationHint(),
      });
      sqliteVecEverFailed = true;
    }
  }

  return db;
}

// ─── sqlite-vec availability probe (prism doctor) ───────────────────────────

export interface VecProbeResult {
  readonly available: boolean;
  readonly source: "npm" | "env" | "embedded" | null;
  readonly error: string | null;
}

function probeErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function vecTableCreateAndQueryError(db: Database): string | null {
  try {
    db.exec(VEC_MEMORY_TABLE_SQL);
  } catch (err) {
    return `create failed: ${probeErrorMessage(err)}`;
  }
  try {
    db.query("SELECT 1 FROM vec_memory LIMIT 1").get();
    return null;
  } catch (err) {
    return `query failed: ${probeErrorMessage(err)}`;
  }
}

/**
 * Probe sqlite-vec availability without touching any on-disk database file.
 * Mirrors createDatabase()'s extension chain — sqlite-vec npm package, then
 * PRISM_VEC0_PATH, then the embedded base64 fallback — against a throwaway
 * :memory: database and verifies vec_memory can be created and queried.
 * Deliberately ignores (and does not set) the sqliteVecEverFailed latch, so
 * it can run in the doctor CLI process independently of the engine.
 */
export function probeVecAvailability(): VecProbeResult {
  setupCustomSQLite();

  let db: Database;
  try {
    db = new Database(":memory:");
  } catch (err) {
    return {
      available: false,
      source: null,
      error: `could not open probe database: ${probeErrorMessage(err)}`,
    };
  }

  try {
    const failures: string[] = [];

    try {
      loadVec(db);
      const npmError = vecTableCreateAndQueryError(db);
      if (npmError === null) {
        return { available: true, source: "npm", error: null };
      }
      failures.push(`npm: loaded, ${npmError}`);
    } catch (err) {
      failures.push(`npm: ${probeErrorMessage(err)}`);
    }

    const envPath = process.env.PRISM_VEC0_PATH;
    if (envPath) {
      try {
        db.loadExtension(envPath);
        const envError = vecTableCreateAndQueryError(db);
        if (envError === null) {
          return { available: true, source: "env", error: null };
        }
        failures.push(`env: loaded, ${envError}`);
      } catch (err) {
        failures.push(`env (${envPath}): ${probeErrorMessage(err)}`);
      }
    }

    const embeddedPath = getEmbeddedVec0Path();
    if (embeddedPath) {
      try {
        db.loadExtension(embeddedPath);
        const embeddedError = vecTableCreateAndQueryError(db);
        if (embeddedError === null) {
          return { available: true, source: "embedded", error: null };
        }
        failures.push(`embedded: loaded, ${embeddedError}`);
      } catch (err) {
        failures.push(`embedded (${embeddedPath}): ${probeErrorMessage(err)}`);
      }
    }

    return {
      available: false,
      source: null,
      error: failures.length > 0 ? failures.join("; ") : "no sqlite-vec source attempted",
    };
  } finally {
    db.close();
  }
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

function vecMemoryTableIsQueryable(db: Database): boolean {
  try {
    db.query("SELECT 1 FROM vec_memory LIMIT 1").get();
    return true;
  } catch {
    return false;
  }
}

// vec0 auxiliary columns accept TEXT, INTEGER, DOUBLE and BLOB only — a REAL
// column fails construction with a misleading "chunk_size must be a non-zero
// positive integer" error, silently leaving the table uncreated.
const VEC_MEMORY_TABLE_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(
    embedding float[384],
    +id TEXT,
    +category TEXT,
    +content TEXT,
    +pool_address TEXT,
    +outcome TEXT,
    +pnlUsd DOUBLE,
    +confidence DOUBLE,
    +createdAt INTEGER,
    +expiresAt INTEGER
  );
`;

export function hasVecMemoryTable(db: Database): boolean {
  return hasTable(db, "vec_memory") && vecMemoryTableIsQueryable(db);
}

function tryCreateVecMemoryTable(db: Database): void {
  try {
    db.exec(VEC_MEMORY_TABLE_SQL);
  } catch (err) {
    logger.warn("Failed to create vec_memory table during self-heal", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
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

      // Memory vector table with sqlite-vec — guarded so the other
      // tables above are still created if the vec0 extension fails.
      try {
        db.exec(VEC_MEMORY_TABLE_SQL);
      } catch (e) {
        logger.warn("sqlite-vec vec_memory table could not be created during migration", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
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
  {
    version: 9,
    name: "metadata",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 10,
    name: "fee_claims",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS fee_claims (
          id TEXT PRIMARY KEY,
          pool_address TEXT NOT NULL,
          position_pubkey TEXT NOT NULL,
          fee_x REAL NOT NULL DEFAULT 0,
          fee_y REAL NOT NULL DEFAULT 0,
          platform_fee_x REAL NOT NULL DEFAULT 0,
          platform_fee_y REAL NOT NULL DEFAULT 0,
          net_fee_x REAL NOT NULL DEFAULT 0,
          net_fee_y REAL NOT NULL DEFAULT 0,
          tx_signature TEXT,
          fee_transfer_tx_signature TEXT,
          reported_to_api INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_fee_claims_pool ON fee_claims(pool_address)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_fee_claims_created ON fee_claims(created_at)`);
    },
  },
  {
    version: 11,
    name: "fee_claims_operator_fees",
    up(db) {
      db.exec(`ALTER TABLE fee_claims ADD COLUMN operator_fee_x REAL NOT NULL DEFAULT 0`);
      db.exec(`ALTER TABLE fee_claims ADD COLUMN operator_fee_y REAL NOT NULL DEFAULT 0`);
    },
  },
  {
    version: 12,
    name: "signal_snapshots",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS signal_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pool_address TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          fee_il_ratio REAL NOT NULL,
          volume_authenticity REAL NOT NULL,
          bin_utilization REAL NOT NULL,
          tvl_usd REAL NOT NULL,
          tvl_velocity REAL NOT NULL,
          volatility_stddev REAL NOT NULL,
          bin_step INTEGER NOT NULL,
          action TEXT NOT NULL,
          confidence REAL NOT NULL,
          outcome_pnl_usd REAL,
          outcome_recorded_at INTEGER
        );
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_signal_snapshots_pool_time
          ON signal_snapshots(pool_address, timestamp);
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_signal_snapshots_outcome
          ON signal_snapshots(outcome_recorded_at);
      `);
    },
  },
  {
    version: 13,
    name: "pool_cooldowns",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pool_cooldowns (
          pool_address TEXT PRIMARY KEY,
          cooldown_until INTEGER NOT NULL,
          reason TEXT NOT NULL,
          consecutive_oor_exits INTEGER NOT NULL DEFAULT 0
        );
      `);
    },
  },
  {
    version: 14,
    name: "add_entry_signal_timestamp",
    up(db) {
      if (!hasColumn(db, "positions", "entry_signal_timestamp")) {
        db.exec("ALTER TABLE positions ADD COLUMN entry_signal_timestamp INTEGER");
      }
    },
  },
  {
    version: 15,
    name: "add_entry_signal_snapshot_id",
    up(db) {
      if (!hasColumn(db, "positions", "entry_signal_snapshot_id")) {
        db.exec("ALTER TABLE positions ADD COLUMN entry_signal_snapshot_id INTEGER");
      }
    },
  },
  {
    version: 16,
    name: "pnl_accounting",
    up(db) {
      // Per-position PnL accounting. Entry columns stay NULL for positions
      // opened before this migration — analytics degrade gracefully on them.
      if (!hasColumn(db, "positions", "entry_price_usd")) {
        db.exec("ALTER TABLE positions ADD COLUMN entry_price_usd REAL");
      }
      if (!hasColumn(db, "positions", "entry_amount_x_usd")) {
        db.exec("ALTER TABLE positions ADD COLUMN entry_amount_x_usd REAL");
      }
      if (!hasColumn(db, "positions", "entry_amount_y_usd")) {
        db.exec("ALTER TABLE positions ADD COLUMN entry_amount_y_usd REAL");
      }
      if (!hasColumn(db, "positions", "cumulative_fees_claimed_usd")) {
        db.exec(
          "ALTER TABLE positions ADD COLUMN cumulative_fees_claimed_usd REAL NOT NULL DEFAULT 0",
        );
      }
      if (!hasColumn(db, "positions", "closed_at")) {
        db.exec("ALTER TABLE positions ADD COLUMN closed_at INTEGER");
      }
      if (!hasColumn(db, "positions", "realized_pnl_usd")) {
        db.exec("ALTER TABLE positions ADD COLUMN realized_pnl_usd REAL");
      }

      // Append-only lifecycle event log (ENTER/EXIT/REBALANCE/CLAIM/COMPOUND).
      db.exec(`
        CREATE TABLE IF NOT EXISTS position_events (
          id TEXT PRIMARY KEY,
          pool_address TEXT NOT NULL,
          position_pubkey TEXT,
          event TEXT NOT NULL,
          value_usd REAL,
          fees_usd REAL,
          price REAL,
          metadata TEXT,
          created_at INTEGER NOT NULL
        );
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_position_events_pool_time
          ON position_events(pool_address, created_at);
      `);
    },
  },
  {
    version: 17,
    name: "farm_rewards_accounting",
    up(db) {
      // LM farm reward claims tracked separately from swap fees so fee APR
      // stays fee-pure; pre-existing rows default to 0.
      if (!hasColumn(db, "positions", "cumulative_rewards_claimed_usd")) {
        db.exec(
          "ALTER TABLE positions ADD COLUMN cumulative_rewards_claimed_usd REAL NOT NULL DEFAULT 0",
        );
      }
    },
  },
  {
    version: 18,
    name: "multi_position_per_pool",
    up(db) {
      // Re-key positions by position identity so a pool can hold multiple
      // positions (tight+wide range pairs). Live positions key on their
      // on-chain pubkey; legacy paper rows (no pubkey) get a stable synthetic
      // id — unique because pool_address was the old primary key.
      if (!hasColumn(db, "positions", "position_id")) {
        db.exec(`
          CREATE TABLE positions_new (
            position_id TEXT PRIMARY KEY,
            pool_address TEXT NOT NULL,
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
            trailing_stop_threshold REAL,
            highest_value_usd REAL,
            last_rebalance_at INTEGER DEFAULT 0,
            paper_exited_at INTEGER,
            entry_signal_timestamp INTEGER,
            entry_signal_snapshot_id INTEGER,
            entry_price_usd REAL,
            entry_amount_x_usd REAL,
            entry_amount_y_usd REAL,
            cumulative_fees_claimed_usd REAL NOT NULL DEFAULT 0,
            cumulative_rewards_claimed_usd REAL NOT NULL DEFAULT 0,
            closed_at INTEGER,
            realized_pnl_usd REAL
          );
        `);
        db.exec(`
          INSERT INTO positions_new (
            position_id, pool_address, position_pubkey, deposited_usd, current_value_usd,
            token_x_symbol, token_y_symbol, active_bin_id, lower_bin_id, upper_bin_id,
            timestamp, out_of_range_since, oor_cycle_count, last_fee_claim_at,
            trailing_stop_threshold, highest_value_usd, last_rebalance_at, paper_exited_at,
            entry_signal_timestamp, entry_signal_snapshot_id,
            entry_price_usd, entry_amount_x_usd, entry_amount_y_usd,
            cumulative_fees_claimed_usd, cumulative_rewards_claimed_usd, closed_at,
            realized_pnl_usd
          )
          SELECT
            COALESCE(position_pubkey, 'paper-' || pool_address), pool_address, position_pubkey,
            deposited_usd, current_value_usd, token_x_symbol, token_y_symbol,
            active_bin_id, lower_bin_id, upper_bin_id, timestamp, out_of_range_since,
            oor_cycle_count, last_fee_claim_at, trailing_stop_threshold, highest_value_usd,
            last_rebalance_at, paper_exited_at, entry_signal_timestamp, entry_signal_snapshot_id,
            entry_price_usd, entry_amount_x_usd, entry_amount_y_usd,
            cumulative_fees_claimed_usd, cumulative_rewards_claimed_usd, closed_at,
            realized_pnl_usd
          FROM positions;
        `);
        db.exec("DROP TABLE positions");
        db.exec("ALTER TABLE positions_new RENAME TO positions");
        db.exec("CREATE INDEX IF NOT EXISTS idx_positions_pool ON positions(pool_address)");
      }

      // Lifecycle events get the same identity column so paper positions
      // (NULL pubkey) stay attributable per position. Legacy rows backfill
      // from position_pubkey; pre-v18 paper events keep NULL (unknown).
      if (!hasColumn(db, "position_events", "position_id")) {
        db.exec("ALTER TABLE position_events ADD COLUMN position_id TEXT");
        db.exec(
          "UPDATE position_events SET position_id = position_pubkey WHERE position_pubkey IS NOT NULL",
        );
        db.exec(
          "CREATE INDEX IF NOT EXISTS idx_position_events_position ON position_events(position_id)",
        );
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
