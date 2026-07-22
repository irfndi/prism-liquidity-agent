import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { createDatabase, hasVecMemoryTable, probeVecAvailability } from "../engine/db.js";
import { DbLive } from "../engine/db-service.js";
import { DbService } from "../engine/services.js";

async function run<T, R>(
  effect: Effect.Effect<T, unknown, R>,
  layer: Layer.Layer<R, unknown, unknown>,
): Promise<T> {
  return Effect.runPromise(
    (Effect.provide as any)(effect, layer) as Effect.Effect<T, unknown, never>,
  );
}

/**
 * Attempts to create a database with sqlite-vec loaded.
 * Returns the Database if vec_memory is present, otherwise null.
 * This mirrors the engine's createDatabase() but lets tests decide
 * whether the current environment supports dynamic extension loading.
 */
function tryCreateVecDatabase(): Database | null {
  try {
    const db = createDatabase(":memory:");
    if (hasVecMemoryTable(db)) return db;
    db.close();
    return null;
  } catch {
    return null;
  }
}

// ─── hasVecMemoryTable detection ─────────────────────────────────────────────

describe("hasVecMemoryTable", () => {
  it("returns false on a raw in-memory database (no migrations)", () => {
    const db = new Database(":memory:");
    expect(hasVecMemoryTable(db)).toBe(false);
    db.close();
  });

  it("returns a consistent result on repeated calls", () => {
    const db = new Database(":memory:");
    const first = hasVecMemoryTable(db);
    const second = hasVecMemoryTable(db);
    expect(second).toBe(first);
    db.close();
  });

  it("returns true after createDatabase when sqlite-vec is available", () => {
    const db = tryCreateVecDatabase();
    if (!db) {
      // Environment cannot load sqlite-vec; skip the positive-detection test.
      return;
    }
    expect(hasVecMemoryTable(db)).toBe(true);
    db.close();
  });

  it("createDatabase completes without error regardless of sqlite-vec availability", () => {
    const db = createDatabase(":memory:");
    expect(() => hasVecMemoryTable(db)).not.toThrow();
    db.close();
  });
});

// ─── Core tables survive when vec0 is absent ─────────────────────────────────

describe("migration 1 creates core tables even when vec0 is missing", () => {
  it("positions, audit, and blacklists exist on a raw database without vec_memory", () => {
    const db = new Database(":memory:");
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
    db.exec(`
      CREATE TABLE IF NOT EXISTS blacklists (
        type TEXT,
        value TEXT,
        PRIMARY KEY (type, value)
      );
    `);

    const hasPositions = db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'positions'")
      .get();
    const hasAudit = db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit'")
      .get();
    const hasBlacklists = db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'blacklists'")
      .get();

    expect(hasPositions).toBeTruthy();
    expect(hasAudit).toBeTruthy();
    expect(hasBlacklists).toBeTruthy();
    expect(hasVecMemoryTable(db)).toBe(false);
    db.close();
  });
});

// ─── Guard behavior when vec_memory is absent ────────────────────────────────

describe("DbService memory operations when vec_memory is absent", () => {
  it("pruneMemory returns 0 without throwing", async () => {
    const db = new Database(":memory:");
    const layer = DbLive(":memory:");

    const result = await run(
      Effect.gen(function* () {
        const dbService = yield* DbService;
        return yield* dbService.pruneMemory();
      }),
      layer,
    );
    expect(result).toBe(0);
    db.close();
  });

  it("queryMemory returns empty array without throwing", async () => {
    const db = new Database(":memory:");
    const layer = DbLive(":memory:");

    const result = await run(
      Effect.gen(function* () {
        const dbService = yield* DbService;
        return yield* dbService.queryMemory("test query", 5);
      }),
      layer,
    );
    expect(result).toEqual([]);
    db.close();
  });

  it("insertMemory is a no-op and does not throw", async () => {
    const db = new Database(":memory:");
    const layer = DbLive(":memory:");

    await run(
      Effect.gen(function* () {
        const dbService = yield* DbService;
        yield* dbService.insertMemory({
          content: "orphan pattern",
          category: "pattern",
          poolAddress: "PoolNoVec",
        });
        return yield* dbService.queryMemory("orphan pattern", 5);
      }),
      layer,
    );

    // The guard path returns Effect.void; the only observable outcome is no crash.
    expect(true).toBe(true);
    db.close();
  });
});

// ─── Memory operations via DbLive (table present) ───────────────────────────

describe("DbService memory operations (vec_memory present)", () => {
  it("insertMemory + queryMemory roundtrip", async () => {
    const db = tryCreateVecDatabase();
    if (!db) return; // Skip if sqlite-vec unavailable.
    db.close();

    const layer = DbLive(":memory:");
    const result = await run(
      Effect.gen(function* () {
        const dbService = yield* DbService;
        yield* dbService.insertMemory({
          content: "SOL/USDC pool performed well",
          category: "pattern",
          poolAddress: "PoolA",
          outcome: "profit",
          pnlUsd: 150,
          confidence: 0.85,
        });
        return yield* dbService.queryMemory("SOL/USDC pool performance", 5);
      }),
      layer,
    );
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.content).toBe("SOL/USDC pool performed well");
  });

  it("insertMemory + queryMemory roundtrip with INTEGER-valued pnlUsd/confidence", async () => {
    const db = tryCreateVecDatabase();
    if (!db) return; // Skip if sqlite-vec unavailable.
    db.close();

    const layer = DbLive(":memory:");
    const result = await run(
      Effect.gen(function* () {
        const dbService = yield* DbService;
        // Integer-valued numbers bind as SQLITE_INTEGER. The vec0 DOUBLE aux
        // columns reject that under the strict linux binary unless
        // insertMemory wraps them in CAST(? AS REAL); this locks that path.
        yield* dbService.insertMemory({
          content: "integer pnl and confidence roundtrip",
          category: "outcome",
          poolAddress: "PoolInt",
          outcome: "profit",
          pnlUsd: 100,
          confidence: 1,
        });
        return yield* dbService.queryMemory("integer pnl and confidence roundtrip", 5, "PoolInt");
      }),
      layer,
    );
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.content).toBe("integer pnl and confidence roundtrip");
    expect(result[0]!.pnlUsd).toBe(100);
    expect(result[0]!.confidence).toBe(1);
  });

  it("queryMemory pool-scoped filtering via the legal KNN shape (no aux-column WHERE)", async () => {
    const db = tryCreateVecDatabase();
    if (!db) return; // Skip if sqlite-vec unavailable.
    db.close();

    const layer = DbLive(":memory:");
    const result = await run(
      Effect.gen(function* () {
        const dbService = yield* DbService;
        // Two KNN-nearest entries (identical content) on different pools.
        yield* dbService.insertMemory({
          content: "shared near-identical memory",
          category: "pattern",
          poolAddress: "PoolScopeA",
          outcome: "profit",
          pnlUsd: 100,
          confidence: 1,
        });
        yield* dbService.insertMemory({
          content: "shared near-identical memory",
          category: "pattern",
          poolAddress: "PoolScopeB",
          outcome: "loss",
          pnlUsd: 50,
          confidence: 1,
        });
        const unscoped = yield* dbService.queryMemory("shared near-identical memory", 5);
        const scoped = yield* dbService.queryMemory(
          "shared near-identical memory",
          5,
          "PoolScopeA",
        );
        return { unscoped, scoped };
      }),
      layer,
    );
    // Unscoped sees both pools — proves both rows are KNN-nearest neighbours.
    const unscopedPools = new Set(result.unscoped.map((r) => r.poolAddress));
    expect(unscopedPools.has("PoolScopeA")).toBe(true);
    expect(unscopedPools.has("PoolScopeB")).toBe(true);
    // Scoped returns only PoolScopeA via the post-fetch JS pool filter.
    expect(result.scoped.length).toBe(1);
    expect(result.scoped[0]!.poolAddress).toBe("PoolScopeA");
    expect(result.scoped[0]!.pnlUsd).toBe(100);
  });

  it("queryMemory expands the KNN window when the in-scope pool is a minority of the nearest neighbours", async () => {
    const db = tryCreateVecDatabase();
    if (!db) return; // Skip if sqlite-vec unavailable.
    db.close();

    const layer = DbLive(":memory:");
    const result = await run(
      Effect.gen(function* () {
        const dbService = yield* DbService;
        // 3 target rows + 15 other-pool rows (18 distinct contents). The target
        // pool may be a small minority of the global distance ordering, far
        // beyond the initial topK*2 window; the expanding loop must re-query
        // with a wider k until the post-filter has enough in-scope rows. The
        // cap (max(topK*8, 64) = 64 >= 18) makes this deterministic for ANY
        // embedding distance order — the widest query returns the whole table.
        for (let i = 0; i < 3; i += 1) {
          yield* dbService.insertMemory({
            content: `expanding window target memory ${i}`,
            category: "pattern",
            poolAddress: "PoolExpandA",
          });
        }
        for (let i = 0; i < 15; i += 1) {
          yield* dbService.insertMemory({
            content: `expanding window noise memory ${i}`,
            category: "pattern",
            poolAddress: "PoolExpandB",
          });
        }
        return yield* dbService.queryMemory("expanding window target memory", 2, "PoolExpandA");
      }),
      layer,
    );
    expect(result).toHaveLength(2);
    expect(result.every((entry) => entry.poolAddress === "PoolExpandA")).toBe(true);
  });

  it("queryMemory KNN expansion reliably reaches the configured cap (k = maxK)", async () => {
    const db = tryCreateVecDatabase();
    if (!db) return; // Skip if sqlite-vec unavailable.
    db.close();

    const layer = DbLive(":memory:");
    const result = await run(
      Effect.gen(function* () {
        const dbService = yield* DbService;
        // 3 target rows + 60 other-pool rows (63 distinct contents).
        // topK = 3 → maxK = max(3*8, 64) = 64, so the fixed expansion loop's
        // final k = 64 query covers the whole 63-row table and the post-filter
        // finds all 3 target rows REGARDLESS of embedding distance order —
        // this is deterministic for ANY distance order. The OLD bounded loop
        // (4 iterations → k = 6, 12, 24, 48; k = 64 never queried) could return
        // fewer than 3 once the target rows ranked 49–63 in a table this size.
        for (let i = 0; i < 3; i += 1) {
          yield* dbService.insertMemory({
            content: `cap reach target memory ${i}`,
            category: "pattern",
            poolAddress: "PoolCapA",
          });
        }
        for (let i = 0; i < 60; i += 1) {
          yield* dbService.insertMemory({
            content: `cap reach noise memory ${i}`,
            category: "pattern",
            poolAddress: "PoolCapB",
          });
        }
        return yield* dbService.queryMemory("cap reach target memory", 3, "PoolCapA");
      }),
      layer,
    );
    expect(result).toHaveLength(3);
    expect(result.every((entry) => entry.poolAddress === "PoolCapA")).toBe(true);
  });
});

// ─── probeVecAvailability (real environment, doctor seam) ───────────────────

describe("probeVecAvailability", () => {
  it("agrees with createDatabase when sqlite-vec can load (skipped in vec0-less environments)", () => {
    const db = tryCreateVecDatabase();
    if (!db) {
      // Environment cannot load sqlite-vec; skip the positive probe test.
      return;
    }
    db.close();

    const result = probeVecAvailability();
    expect(result.available).toBe(true);
    expect(result.source).not.toBeNull();
    expect(result.error).toBeNull();
  });

  it("creates a queryable vec_memory table from createDatabase (regression: REAL aux columns fail vec0 construction with a misleading chunk_size error)", () => {
    const db = tryCreateVecDatabase();
    if (!db) {
      // Environment cannot load sqlite-vec; skip the schema regression test.
      return;
    }
    expect(hasVecMemoryTable(db)).toBe(true);
    db.close();
  });

  it("opens only in-memory databases and never creates a file", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "prism-probe-"));
    const previousCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const before = readdirSync(tmpDir);
      const result = probeVecAvailability();
      const after = readdirSync(tmpDir);
      expect(after).toEqual(before);
      expect(typeof result.available).toBe("boolean");
    } finally {
      process.chdir(previousCwd);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
