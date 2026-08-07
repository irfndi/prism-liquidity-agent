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
 * Effect timing: the engine loads config ONCE at startup (ConfigLive), so a
 * DB override takes effect on the NEXT engine start — `prism config set`
 * prints this hint. Hot-reload of the running program is deliberately NOT
 * supported: `config` is captured by reference throughout the scan loop, and
 * silently mutating it mid-cycle would make sizing/risk decisions
 * non-deterministic.
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
  /**
   * AppConfig field this override lands on. Typed as string so specs can
   * reference fields introduced by newer feature branches (market-scan etc.)
   * while this module compiles against older bases; applyDbConfigOverrides
   * narrows at runtime via the kind parse and guards the name against
   * FORWARD_REFERENCE_FIELDS. A typo fails loudly: the row is skipped with
   * a warning and the key is invisible to `prism config list`.
   */
  readonly field: string;
  readonly min?: number;
  readonly max?: number;
  /** Fallback used only by the bin-step range cross-check (env > DB > default). */
  readonly default?: number;
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
  { envKey: "MAX_ENTRY_SIZE_USD", kind: "number", field: "maxEntrySizeUsd", min: 10 },
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
  // ── Market-scan mode (DB-overridable; applied on the next engine start) ─
  { envKey: "MARKET_SCAN_ENABLED", kind: "boolean", field: "marketScanEnabled" },
  {
    envKey: "MARKET_SCAN_REFRESH_INTERVAL_MS",
    kind: "number",
    field: "marketScanRefreshIntervalMs",
    min: 60_000,
  },
  {
    envKey: "MARKET_SCAN_UNIVERSE_PAGES",
    kind: "number",
    field: "marketScanUniversePages",
    min: 1,
    max: 10,
  },
  {
    envKey: "MARKET_SCAN_MIN_TVL_USD",
    kind: "number",
    field: "marketScanMinTvlUsd",
    min: 0,
  },
  {
    envKey: "MARKET_SCAN_MIN_FEE_APR",
    kind: "number",
    field: "marketScanMinFeeApr",
    min: 0,
  },
  {
    envKey: "MARKET_SCAN_TOP_K",
    kind: "number",
    field: "marketScanTopK",
    min: 1,
    max: 200,
  },
  {
    envKey: "MARKET_SCAN_MAX_POOLS",
    kind: "number",
    field: "marketScanMaxPools",
    min: 1,
    max: 500,
  },
  {
    envKey: "MARKET_SCAN_MIN_HOLDERS",
    kind: "number",
    field: "marketScanMinHolders",
    min: 0,
  },
  {
    envKey: "MARKET_SCAN_MIN_BIN_STEP",
    kind: "number",
    field: "marketScanMinBinStep",
    min: 0,
    max: 100,
    default: 2,
  },
  {
    envKey: "MARKET_SCAN_MAX_BIN_STEP",
    kind: "number",
    field: "marketScanMaxBinStep",
    min: 1,
    max: 2000,
    default: 200,
  },
  // ── Post-#157 tuning knobs (churn / dust / range) ────────────────────────
  { envKey: "DUST_EXIT_USD", kind: "number", field: "dustExitUsd", min: 0 },
  {
    envKey: "TRAILING_STOP_CONFIRM_CYCLES",
    kind: "number",
    field: "trailingStopConfirmCycles",
    min: 1,
    max: 10,
  },
  {
    envKey: "VOLATILITY_EXIT_STDDEV",
    kind: "number",
    field: "volatilityExitStddev",
    min: 0,
  },
  {
    envKey: "ENTRY_RANGE_HALF_WIDTH_BINS",
    kind: "number",
    field: "entryRangeHalfWidthBins",
    min: 0,
    max: 200,
  },
  {
    envKey: "MAX_REBALANCE_RANGE_BINS",
    kind: "number",
    field: "maxRebalanceRangeBins",
    min: 1,
  },
  { envKey: "OOR_COOLDOWN_MS", kind: "number", field: "oorCooldownMs", min: 0 },
  {
    envKey: "OOR_GRACE_PERIOD_CYCLES",
    kind: "number",
    field: "oorGracePeriodCycles",
    min: 1,
  },
  {
    envKey: "FEE_CLAIM_INTERVAL_MS",
    kind: "number",
    field: "feeClaimIntervalMs",
    min: 60_000,
  },
  {
    envKey: "MIN_REBALANCE_INTERVAL_MS",
    kind: "number",
    field: "minRebalanceIntervalMs",
    min: 0,
  },
  { envKey: "IDLE_REDEPLOY_ENABLED", kind: "boolean", field: "idleRedeployEnabled" },
  {
    envKey: "IDLE_REDEPLOY_THRESHOLD_USD",
    kind: "number",
    field: "idleRedeployThresholdUsd",
    min: 0,
  },
  {
    envKey: "IDLE_REDEPLOY_MAX_SIZE_USD",
    kind: "number",
    field: "idleRedeployMaxSizeUsd",
    min: 0,
  },
];

/**
 * AppConfig fields this base does not declare yet but that land with a newer
 * feature branch (market-scan mode). Kept as an explicit allowlist so
 * legitimate forward references keep working while a typo in a spec's
 * `field` still fails loudly (warn + skip) instead of silently creating an
 * unused property.
 */
const FORWARD_REFERENCE_FIELDS: ReadonlySet<string> = new Set([
  "marketScanEnabled",
  "marketScanRefreshIntervalMs",
  "marketScanUniversePages",
  "marketScanMinTvlUsd",
  "marketScanMinFeeApr",
  "marketScanTopK",
  "marketScanMaxPools",
  "marketScanMinHolders",
  "marketScanMinBinStep",
  "marketScanMaxBinStep",
]);

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
 * True when `field` is declared on AppConfig (present on the resolved base
 * object) or listed in FORWARD_REFERENCE_FIELDS. Guards applyDbConfigOverrides
 * so a typo in a spec's `field` cannot silently create an unused property.
 */
export function isKnownConfigField(field: string, base: AppConfig): boolean {
  return FORWARD_REFERENCE_FIELDS.has(field) || Object.prototype.hasOwnProperty.call(base, field);
}

/**
 * Apply DB overrides onto a resolved AppConfig. Only keys whose env var is
 * UNSET take the DB value; the env var always wins. Malformed rows are
 * skipped with a warning; rows whose spec field is neither declared on
 * AppConfig nor an explicit forward reference are skipped with a warning
 * (typo guard). After the loop, an inverted market-scan bin-step range is
 * normalized (max raised to min) with a warning. Returns a new object
 * (never mutates `base`).
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

    // Typo guard: the field must be declared on AppConfig or be an explicit
    // forward reference to a newer feature branch's config; otherwise the
    // row would silently create an unused property and the setting would
    // have no effect.
    if (!isKnownConfigField(spec.field, base)) {
      logger.warn("Skipping DB config row for unknown AppConfig field", {
        key: spec.envKey,
        field: spec.field,
      });
      continue;
    }
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

  // ── Market-scan bin-step range cross-check ──────────────────────────────
  // Individual clamps permit MIN > MAX (e.g. MIN=100, MAX=1), which would
  // make every pool fail the bin-step filter. Resolve both ends with the
  // same env > DB > default precedence and normalize an inverted range by
  // raising the max to the min (never narrows the operator's lower bound).
  const binMinSpec = findDbConfigSpec("MARKET_SCAN_MIN_BIN_STEP");
  const binMaxSpec = findDbConfigSpec("MARKET_SCAN_MAX_BIN_STEP");
  if (binMinSpec !== undefined && binMaxSpec !== undefined) {
    const binMinRaw =
      process.env[binMinSpec.envKey] ?? overrides.get(dbConfigKey(binMinSpec.envKey));
    const binMaxRaw =
      process.env[binMaxSpec.envKey] ?? overrides.get(dbConfigKey(binMaxSpec.envKey));
    const binMin =
      binMinRaw === undefined ? binMinSpec.default : parseDbConfigValue(binMinSpec, binMinRaw);
    const binMax =
      binMaxRaw === undefined ? binMaxSpec.default : parseDbConfigValue(binMaxSpec, binMaxRaw);
    if (typeof binMin === "number" && typeof binMax === "number" && binMin > binMax) {
      logger.warn("Inverted market-scan bin-step range; raising max to min", {
        marketScanMinBinStep: binMin,
        marketScanMaxBinStep: binMax,
      });
      next = { ...next, [binMinSpec.field]: binMin, [binMaxSpec.field]: binMin };
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
