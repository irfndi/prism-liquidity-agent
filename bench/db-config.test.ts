import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Database } from "bun:sqlite";
import fs from "fs";
import {
  dbConfigKey,
  DB_CONFIG_KEYS,
  findDbConfigSpec,
  parseDbConfigValue,
  readDbConfigOverrides,
  applyDbConfigOverrides,
} from "../engine/db-config.js";
import type { AppConfig } from "../engine/config-service.js";

/** Minimal AppConfig-shaped base for override tests. */
function baseConfig(): AppConfig {
  return {
    minPoolTvlUsd: 50_000,
    volumeAuthThreshold: 0.7,
    minFeeIlRatio: 1.2,
    tvlDropExitPct: 0.3,
    maxPerPoolAllocationPct: 0.4,
    maxOpenPositions: 3,
    fallenAngelEnabled: false,
    fallenAngelMinTvlUsd: 50_000,
    fallenAngelMinDrawdownPct: 0.6,
    fallenAngelMaxDrawdownPct: 0.95,
    fallenAngelVolBaselineMin: 0.02,
    fallenAngelVolBaselineMax: 0.35,
    fallenAngelMinRugcheckScore: 0.7,
    fallenAngelMinHolders: 300,
    fallenAngelMaxTop10HolderPct: 0.5,
    fallenAngelInvalidationStopPct: 0.25,
    fallenAngelMaxPositions: 2,
  } as AppConfig;
}

// Bun auto-loads `.env` into process.env, and this repo's own .env sets many of
// the same keys (e.g. MIN_POOL_TVL_USD). Clear every overridable key so the
// sidecar's precedence decisions are deterministic in tests.
beforeEach(() => {
  for (const spec of DB_CONFIG_KEYS) {
    vi.stubEnv(spec.envKey, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("db-config registry", () => {
  it("round-trips keys through the prefix", () => {
    expect(dbConfigKey("MIN_POOL_TVL_USD")).toBe("config.MIN_POOL_TVL_USD");
  });

  it("exposes the allowlist and lookup", () => {
    expect(DB_CONFIG_KEYS.length).toBeGreaterThan(10);
    const spec = findDbConfigSpec("MIN_POOL_TVL_USD");
    expect(spec?.field).toBe("minPoolTvlUsd");
    expect(findDbConfigSpec("WALLET_PRIVATE_KEY")).toBeUndefined();
  });

  it("rejects edits to non-allowlisted values (secrets cannot be stored)", () => {
    for (const spec of DB_CONFIG_KEYS) {
      expect(["WALLET_PRIVATE_KEY", "HELIUS_API_KEY", "SOLANA_RPC_URL"]).not.toContain(spec.envKey);
    }
  });
});

describe("parseDbConfigValue", () => {
  it("parses booleans", () => {
    const spec = { envKey: "X", kind: "boolean", field: "fallenAngelEnabled" } as const;
    expect(parseDbConfigValue(spec, "true")).toBe(true);
    expect(parseDbConfigValue(spec, "1")).toBe(true);
    expect(parseDbConfigValue(spec, "false")).toBe(false);
    expect(parseDbConfigValue(spec, "0")).toBe(false);
    expect(parseDbConfigValue(spec, "maybe")).toBeNull();
  });

  it("parses numbers and clamps to bounds", () => {
    const num = { envKey: "X", kind: "number", field: "minPoolTvlUsd", min: 0 } as const;
    expect(parseDbConfigValue(num, "25000")).toBe(25_000);
    const pct = {
      envKey: "X",
      kind: "number",
      field: "volumeAuthThreshold",
      min: 0,
      max: 1,
    } as const;
    // clamp below min
    expect(parseDbConfigValue(pct, "-2")).toBe(0);
    // clamp above max
    expect(parseDbConfigValue(pct, "5")).toBe(1);
    // non-finite
    expect(parseDbConfigValue(num, "abc")).toBeNull();
    // empty
    expect(parseDbConfigValue(num, "  ")).toBeNull();
  });
});

describe("readDbConfigOverrides + applyDbConfigOverrides", () => {
  it("reads persisted rows from the metadata table", () => {
    const path = "/tmp/prism-db-config-test.sqlite";
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(`${path}${suffix}`, { force: true });
    }
    const fileDb = new Database(path);
    fileDb.exec(
      "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
    fileDb.run("INSERT INTO metadata (key, value, updated_at) VALUES (?, ?, ?)", [
      "config.MIN_POOL_TVL_USD",
      "12345",
      Date.now(),
    ]);
    fileDb.run("INSERT INTO metadata (key, value, updated_at) VALUES (?, ?, ?)", [
      "other.key",
      "junk",
      Date.now(),
    ]);
    fileDb.close();

    const map = readDbConfigOverrides(path);
    expect(map.get("config.MIN_POOL_TVL_USD")).toBe("12345");
    expect(map.get("other.key")).toBeUndefined();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(`${path}${suffix}`, { force: true });
    }
  });

  it("returns empty map for missing DB (fail-open)", () => {
    expect(readDbConfigOverrides("/nonexistent/nope.sqlite").size).toBe(0);
  });

  it("returns empty map when the DB predates the metadata table", () => {
    const path = "/tmp/prism-db-config-predate.sqlite";
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(`${path}${suffix}`, { force: true });
    }
    const db = new Database(path);
    db.exec("CREATE TABLE other_table (id INTEGER PRIMARY KEY)");
    db.close();
    expect(readDbConfigOverrides(path).size).toBe(0);
    fs.rmSync(path, { force: true });
  });

  it("applies DB overrides for keys whose env var is unset", () => {
    const base = baseConfig();
    const overrides = new Map([
      [dbConfigKey("MIN_POOL_TVL_USD"), "12345"],
      [dbConfigKey("FALLEN_ANGEL_ENABLED"), "true"],
    ]);
    const applied = applyDbConfigOverrides(base, overrides);
    expect(applied.minPoolTvlUsd).toBe(12_345);
    expect(applied.fallenAngelEnabled).toBe(true);
    // untouched key keeps its value
    expect(applied.volumeAuthThreshold).toBe(0.7);
  });

  it("env var beats the DB row", () => {
    vi.stubEnv("MIN_POOL_TVL_USD", "999999");
    const base = baseConfig();
    const overrides = new Map([[dbConfigKey("MIN_POOL_TVL_USD"), "12345"]]);
    const applied = applyDbConfigOverrides(base, overrides);
    // DB row ignored (env present); the env value itself is applied by
    // loadConfig, NOT by this sidecar layer.
    expect(applied.minPoolTvlUsd).toBe(50_000);
  });

  it("skips malformed rows instead of crashing", () => {
    const base = baseConfig();
    const overrides = new Map([[dbConfigKey("FALLEN_ANGEL_ENABLED"), "definitely"]]);
    const applied = applyDbConfigOverrides(base, overrides);
    expect(applied.fallenAngelEnabled).toBe(false);
    expect(applied.minPoolTvlUsd).toBe(50_000);
  });

  it("does not mutate the base object", () => {
    const base = baseConfig();
    const overrides = new Map([[dbConfigKey("MIN_POOL_TVL_USD"), "12345"]]);
    const applied = applyDbConfigOverrides(base, overrides);
    expect(base.minPoolTvlUsd).toBe(50_000);
    expect(applied.minPoolTvlUsd).toBe(12_345);
    expect(applied).not.toBe(base);
  });
});
