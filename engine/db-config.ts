import { Database } from "bun:sqlite";
import fs from "fs";
import { createLogger } from "./logger.js";
import type { AppConfig } from "./config-service.js";

/**
 * DB-backed config sidecar (env > DB > defaults).
 *
 * The engine's `ConfigService.loadConfig` remains the env-driven source of
 * truth (all compiled-in defaults + env vars). This module adds an OPTIONAL
 * SQLite override layer under it: keys stored in the `metadata` table as
 * `config.<ENV_KEY>` win over the compiled-in default, and a real env var
 * always wins over both.
 *
 * Precedence per key, most-specific first:
 *   1. env var (process.env / .env)          — wins always when SET
 *   2. DB row `config.<ENV_KEY>`             — wins when the env var is UNSET
 *   3. compiled-in default in loadConfig     — baseline
 *
 * Design rules (locked user decision #1):
 * - Only an explicit allowlist (`DB_CONFIG_KEYS`) is overridable. Secrets,
 *   wallet keys, RPC URLs, paths and channel names are NOT in it — a DB row
 *   can never inject credentials or redirect network traffic.
 * - Fail-open: a missing/unreadable DB (fresh install, first run, corrupt
 *   file, missing metadata table) leaves env/defaults untouched. One warning
 *   per malformed row, never a crash.
 * - Test mode never touches the DB (loadConfig skips this layer when
 *   NODE_ENV=test or VITEST=true), so the ~960 test fixtures stay
 *   deterministic and network/DB-free.
 * - Values are typed by `kind` and clamped to the same bounds the env loader
 *   uses, so a hand-edited DB row cannot smuggle an out-of-band number.
 */

const logger = createLogger("db-config");

/** Prefix for DB-backed config rows in the `metadata` table. */
export const DB_CONFIG_PREFIX = "config.";

export const dbConfigKey = (envKey: string): string => `${DB_CONFIG_PREFIX}${envKey}`;

export type DbConfigKind = "boolean" | "number";

export interface DbConfigSpec {
  /** The env-style key the user sets, e.g. "MIN_POOL_TVL_USD". */
  readonly envKey: string;
  readonly kind: DbConfigKind;
  /** AppConfig field this override lands on. */
  readonly field: keyof AppConfig;
  readonly min?: number;
  readonly max?: number;
}

/**
 * The allowlist of DB-overridable keys. Deliberately small and conservative:
 * strategy/risk knobs a user might want persistent without touching .env.
 * New fallen-angel keys join here when the gate config lands (Wave C).
 */
export const DB_CONFIG_KEYS: ReadonlyArray<DbConfigSpec> = [
  { envKey: "MIN_POOL_TVL_USD", kind: "number", field: "minPoolTvlUsd", min: 0 },
  { envKey: "MIN_FEE_IL_RATIO", kind: "number", field: "minFeeIlRatio", min: 0 },
  { envKey: "TVL_DROP_EXIT_PCT", kind: "number", field: "tvlDropExitPct", min: 0, max: 1 },
  { envKey: "VOLUME_AUTH_THRESHOLD", kind: "number", field: "volumeAuthThreshold", min: 0, max: 1 },
  { envKey: "MIN_BIN_UTILIZATION", kind: "number", field: "minBinUtilization", min: 0, max: 1 },
  { envKey: "CONFIDENCE_THRESHOLD", kind: "number", field: "confidenceThreshold", min: 0, max: 1 },
  { envKey: "STOP_LOSS_PCT", kind: "number", field: "stopLossPct", min: 0, max: 1 },
  { envKey: "TRAILING_STOP_PCT", kind: "number", field: "trailingStopPct", min: 0, max: 1 },
  { envKey: "PAPER_PORTFOLIO_USD", kind: "number", field: "paperPortfolioUsd", min: 1 },
  { envKey: "MAX_OPEN_POSITIONS", kind: "number", field: "maxOpenPositions", min: 1 },
  { envKey: "MAX_POSITIONS_PER_POOL", kind: "number", field: "maxPositionsPerPool", min: 1 },
  {
    envKey: "MAX_PER_POOL_ALLOCATION_PCT",
    kind: "number",
    field: "maxPerPoolAllocationPct",
    min: 0,
    max: 1,
  },
  { envKey: "SCAN_INTERVAL_MS", kind: "number", field: "scanIntervalMs", min: 10_000 },
  { envKey: "ALERTS_ENABLED", kind: "boolean", field: "alertsEnabled" },
  { envKey: "ALERT_COOLDOWN_MINUTES", kind: "number", field: "alertCooldownMinutes", min: 1 },
  { envKey: "ALERT_FEE_MILESTONE_USD", kind: "number", field: "alertFeeMilestoneUsd", min: 0.01 },
  { envKey: "FALLEN_ANGEL_ENABLED", kind: "boolean", field: "fallenAngelEnabled" },
  { envKey: "FALLEN_ANGEL_MIN_TVL_USD", kind: "number", field: "fallenAngelMinTvlUsd", min: 0 },
  {
    envKey: "FALLEN_ANGEL_MIN_DRAWDOWN_PCT",
    kind: "number",
    field: "fallenAngelMinDrawdownPct",
    min: 0,
    max: 1,
  },
  {
    envKey: "FALLEN_ANGEL_MAX_DRAWDOWN_PCT",
    kind: "number",
    field: "fallenAngelMaxDrawdownPct",
    min: 0,
    max: 1,
  },
  {
    envKey: "FALLEN_ANGEL_VOL_BASELINE_MIN",
    kind: "number",
    field: "fallenAngelVolBaselineMin",
    min: 0,
  },
  {
    envKey: "FALLEN_ANGEL_VOL_BASELINE_MAX",
    kind: "number",
    field: "fallenAngelVolBaselineMax",
    min: 0,
  },
  {
    envKey: "FALLEN_ANGEL_MAX_RUGCHECK_SCORE",
    kind: "number",
    field: "fallenAngelMaxRugcheckScore",
    min: 0,
    max: 100,
  },
  {
    envKey: "FALLEN_ANGEL_MIN_HOLDERS",
    kind: "number",
    field: "fallenAngelMinHolders",
    min: 1,
  },
  {
    envKey: "FALLEN_ANGEL_MAX_TOP10_HOLDER_PCT",
    kind: "number",
    field: "fallenAngelMaxTop10HolderPct",
    min: 0,
    max: 1,
  },
  {
    envKey: "FALLEN_ANGEL_INVALIDATION_STOP_PCT",
    kind: "number",
    field: "fallenAngelInvalidationStopPct",
    min: 0,
    max: 1,
  },
  {
    envKey: "FALLEN_ANGEL_MAX_POSITIONS",
    kind: "number",
    field: "fallenAngelMaxPositions",
    min: 1,
  },
];

export function findDbConfigSpec(envKey: string): DbConfigSpec | undefined {
  return DB_CONFIG_KEYS.find((spec) => spec.envKey === envKey);
}

/**
 * Parse a raw DB row value for a spec. Returns null when the value is not a
 * valid instance of the spec's kind (or falls outside the clamp bounds after
 * clamping) — the caller treats null as "row ignored, keep current value".
 * Numbers are clamped to [min, max] (mirroring the env loader's
 * `validatedNumber` clamp semantics), never bounced.
 */
export function parseDbConfigValue(
  spec: DbConfigSpec,
  raw: string,
): string | number | boolean | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  if (spec.kind === "boolean") {
    if (trimmed === "true" || trimmed === "1") return true;
    if (trimmed === "false" || trimmed === "0") return false;
    return null;
  }

  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  if (spec.min !== undefined && value < spec.min) return spec.min;
  if (spec.max !== undefined && value > spec.max) return spec.max;
  return value;
}

/**
 * Apply DB overrides onto a resolved AppConfig. Only keys whose env var is
 * UNSET take the DB value; the env var always wins. Malformed rows are
 * skipped with a warning. Returns a new object (never mutates `base`).
 */
export function applyDbConfigOverrides(
  base: AppConfig,
  overrides: ReadonlyMap<string, string>,
): AppConfig {
  let next = base as AppConfig & Record<string, unknown>;

  for (const spec of DB_CONFIG_KEYS) {
    // Env wins over the DB, always.
    if (process.env[spec.envKey] !== undefined) continue;

    const raw = overrides.get(dbConfigKey(spec.envKey));
    if (raw === undefined) continue;

    const value = parseDbConfigValue(spec, raw);
    if (value === null) {
      logger.warn("Skipping malformed DB config row", { key: spec.envKey, raw });
      continue;
    }

    // Narrowed writes: booleans and numbers spread cleanly onto both optional
    // (absent = safe off) and required AppConfig fields. A malformed row is
    // silently dropped above, never clamped into a fake value.
    if (typeof value === "boolean" || typeof value === "number") {
      next = { ...next, [spec.field]: value };
    }
  }

  return next;
}

/**
 * Read all `config.*` rows from the SQLite metadata table. Fail-open: returns
 * an empty map when the DB file is absent/unreadable or the metadata table
 * does not exist (fresh install or pre-v9 DB — the env/defaults stand).
 * Opens with a plain (non-migrating) connection and closes it immediately.
 */
export function readDbConfigOverrides(dbPath: string): ReadonlyMap<string, string> {
  if (!dbPath || dbPath === ":memory:" || !fs.existsSync(dbPath)) return new Map<string, string>();
  try {
    const db = new Database(dbPath);
    try {
      const rows = db
        .query("SELECT key, value FROM metadata WHERE key LIKE ?")
        .all(`${DB_CONFIG_PREFIX}%`) as Array<{ key: string; value: string }>;
      return new Map(rows.map((row) => [row.key, row.value]));
    } catch {
      return new Map<string, string>();
    } finally {
      db.close();
    }
  } catch {
    return new Map<string, string>();
  }
}
