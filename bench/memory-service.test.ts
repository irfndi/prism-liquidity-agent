import { describe, it, expect, beforeAll } from "vitest";
import { Effect, Layer } from "effect";
import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import { createDatabase, hasVecMemoryTable } from "../engine/db.js";
import { DbLive } from "../engine/db-service.js";
import { MemoryLive } from "../engine/memory-service.js";
import { getEmbedding } from "../engine/embeddings.js";
import { DbService, MemoryService } from "../engine/services.js";
import type { MemoryCategory } from "../engine/types.js";

// ─── Fallback embeddings ONLY ────────────────────────────────────────────────
// The ONNX backend (@xenova/transformers) downloads an ~80MB model and crashes
// under Node's BigInt serialization; `engine/embeddings.ts` selects the backend
// from `process.env.EMBEDDINGS_BACKEND` at call time and uses the deterministic
// fallback for ANY value other than "onnx". Pin "fallback" so this suite NEVER
// touches the network or the ONNX path regardless of ambient env.
beforeAll(() => {
  process.env.EMBEDDINGS_BACKEND = "fallback";
});

// The fallback embedder (`engine/embeddings.ts`) is an FNV-1a hash over 8-byte
// windows scattered into a 384-dim L2-normalized vector. It is explicitly NOT
// semantic ("Not semantically meaningful — just stable and fast"). Consequences
// that shape every assertion below:
//   * IDENTICAL text → bit-identical vector → vec distance 0 → the strongest
//     possible recall rank. This is the only deterministic relevance signal.
//   * Differently-worded-but-"related" text has NO guaranteed similarity: the
//     signal is lexical (shared 8-byte substrings), not meaning. We therefore
//     assert ordering via exact-text matches and contract-level guarantees
//     (bounded results, limits, recency/expiry), never magic similarity numbers
//     and never "semantic" ranking the backend cannot provide.
//
// `MemoryApi.getRelevantContext` returns `MemoryEntry` rows WITHOUT a similarity
// score (the blended `simScore*0.7 + recency*0.3` rank is DB-layer internal and
// not surfaced), so score-boundedness is not service-observable; ordering is.

const DAY_MS = 24 * 60 * 60 * 1000;
const PATTERN_TTL_MS = 90 * DAY_MS;
const WARNING_TTL_MS = 60 * DAY_MS;
const OUTCOME_TTL_MS = 180 * DAY_MS;

/** Detect sqlite-vec once so vec-dependent tests report as explicit skips
 * (it.skipIf) instead of silent passes where it is absent
 * (mirrors bench/db-memory.test.ts). */
const vecAvailable = (() => {
  try {
    const db = createDatabase(":memory:");
    const ok = hasVecMemoryTable(db);
    db.close();
    return ok;
  } catch {
    return false;
  }
})();

/** Type-safe Effect runner: provide a self-contained layer and await the value. */
function run<A, R>(
  effect: Effect.Effect<A, Error, R>,
  layer: Layer.Layer<R, never, never>,
): Promise<A> {
  return Effect.runPromise(Effect.provide(effect, layer));
}

/** Layer providing just the MemoryService over a private in-memory DB. */
function memoryLayer(): Layer.Layer<MemoryService, never, never> {
  return Layer.provide(MemoryLive, DbLive(":memory:"));
}

/** Layer providing BOTH MemoryService and DbService, sharing ONE in-memory DB.
 * `dbLayer` is a single Layer value referenced twice, so Effect materializes it
 * once — the MemoryService and the exposed DbService back the same Database
 * (the same pattern bench/metrics-tvl-exit.test.ts relies on). Tests need the
 * raw DbService handle to backdate rows directly for the expiry cases. */
function memoryWithDbLayer(): Layer.Layer<MemoryService | DbService, never, never> {
  const dbLayer = DbLive(":memory:");
  return Layer.merge(Layer.provide(MemoryLive, dbLayer), dbLayer);
}

/** Insert a memory row directly with caller-chosen timestamps. `insertMemory`
 * always stamps `Date.now()`/`now+ttl`, so expiry can only be exercised by
 * writing backdated rows around the service (the task's prescribed approach). */
async function insertBackdated(
  raw: Database,
  opts: {
    content: string;
    category: MemoryCategory;
    createdAt: number;
    expiresAt: number;
    poolAddress?: string;
  },
): Promise<void> {
  const embedding = await Effect.runPromise(getEmbedding(opts.content));
  // `Database.run` is not typed for variadic bindings (engine/db-service.ts has
  // to cast it); the prepared-Statement `.run(...params)` overload IS, so use it.
  raw
    .query(
      `INSERT INTO vec_memory
         (embedding, id, category, content, pool_address, outcome, pnlUsd, confidence, createdAt, expiresAt)
       VALUES (?, ?, ?, ?, ?, NULL, CAST(NULL AS REAL), CAST(NULL AS REAL), ?, ?)`,
    )
    .run(
      JSON.stringify(embedding),
      randomUUID(),
      opts.category,
      opts.content,
      opts.poolAddress ?? null,
      opts.createdAt,
      opts.expiresAt,
    );
}

// ─── initialize ──────────────────────────────────────────────────────────────

describe("MemoryLive.initialize", () => {
  it("resolves without error", async () => {
    const result = await run(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        return yield* memory.initialize();
      }),
      memoryLayer(),
    );
    expect(result).toBeUndefined();
  });
});

// ─── upsert + getRelevantContext roundtrip ─────────────────────────────────────

describe("MemoryLive.upsert + getRelevantContext roundtrip", () => {
  it.skipIf(!vecAvailable)("recalls a recorded entry with all fields passed through", async () => {
    const content = "SOL/USDC pool performed well under steady volume";
    const result = await run(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        yield* memory.upsert({
          content,
          category: "pattern",
          poolAddress: "PoolAlpha",
          outcome: "profit",
          pnlUsd: 150,
          confidence: 0.85,
        });
        // Exact-text query → distance 0 → guaranteed nearest neighbour.
        return yield* memory.getRelevantContext(content, 5);
      }),
      memoryLayer(),
    );
    expect(result.length).toBeGreaterThanOrEqual(1);
    const entry = result[0]!;
    expect(entry.content).toBe(content);
    expect(entry.category).toBe("pattern");
    expect(entry.poolAddress).toBe("PoolAlpha");
    expect(entry.outcome).toBe("profit");
    expect(entry.pnlUsd).toBe(150);
    expect(entry.confidence).toBe(0.85);
    expect(entry.id.length).toBeGreaterThan(0);
    expect(entry.createdAt).toBeGreaterThan(0);
    expect(entry.expiresAt).toBeGreaterThan(entry.createdAt);
  });

  // Contract gap (NOT tested, unreachable): `upsert` runs
  // `entry.content ?? \`${category} entry\``, but `MemoryEntry.content` is a
  // REQUIRED `string` in the `Omit<...>` param type, so the typed API cannot
  // pass `undefined`. The fallback only guards a runtime shape the compiler
  // forbids; exercising it would require a type suppression. Documented, not
  // forced.

  it.skipIf(!vecAvailable)("returns [] on an empty store without throwing", async () => {
    const result = await run(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        return yield* memory.getRelevantContext("anything at all", 5);
      }),
      memoryLayer(),
    );
    expect(result).toEqual([]);
  });

  it.skipIf(!vecAvailable)("applies the default topK of 5 when no limit is given", async () => {
    const exact = "needle memory we must find";
    const result = await run(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        yield* memory.upsert({ content: exact, category: "pattern", poolAddress: "PoolN" });
        for (let i = 0; i < 7; i += 1) {
          yield* memory.upsert({
            content: `haystack filler memory number ${i}`,
            category: "pattern",
            poolAddress: "PoolN",
          });
        }
        // No topK argument → service default 5; the exact match (rank 0) is in.
        return yield* memory.getRelevantContext(exact);
      }),
      memoryLayer(),
    );
    expect(result.length).toBe(5);
    expect(result.some((e) => e.content === exact)).toBe(true);
  });

  it.skipIf(!vecAvailable)("respects an explicit topK limit", async () => {
    const exact = "cap probe memory";
    const result = await run(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        for (let i = 0; i < 4; i += 1) {
          yield* memory.upsert({
            content: `cap probe distractor ${i}`,
            category: "pattern",
            poolAddress: "PoolCap",
          });
        }
        yield* memory.upsert({ content: exact, category: "pattern", poolAddress: "PoolCap" });
        return yield* memory.getRelevantContext(exact, 2);
      }),
      memoryLayer(),
    );
    expect(result.length).toBeLessThanOrEqual(2);
    expect(result.some((e) => e.content === exact)).toBe(true);
  });
});

// ─── relevance ranking (fallback hash embedding) ─────────────────────────────

describe("MemoryLive.getRelevantContext ranking", () => {
  it.skipIf(!vecAvailable)(
    "ranks an exact-text match above unrelated memories (lexical, not semantic)",
    async () => {
      const target = "pool gamma fees compounded daily";
      const result = await run(
        Effect.gen(function* () {
          const memory = yield* MemoryService;
          yield* memory.upsert({ content: "zzz qqq unrelated noise blob", category: "pattern" });
          yield* memory.upsert({ content: target, category: "pattern" });
          yield* memory.upsert({ content: "completely different text here", category: "pattern" });
          return yield* memory.getRelevantContext(target, 5);
        }),
        memoryLayer(),
      );
      expect(result.length).toBe(3);
      // Identical text → identical normalized vector → distance 0 → simScore 1,
      // which no different-text row can beat (all else equal on recency). Rank 0.
      expect(result[0]!.content).toBe(target);
    },
  );
});

// ─── pool-scoped filtering ───────────────────────────────────────────────────

describe("MemoryLive.getRelevantContext pool scoping", () => {
  it.skipIf(!vecAvailable)("returns only the requested pool's entries when scoped", async () => {
    const shared = "shared memory text for scoping";
    const result = await run(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        yield* memory.upsert({ content: shared, category: "pattern", poolAddress: "ScopeA" });
        yield* memory.upsert({ content: shared, category: "pattern", poolAddress: "ScopeB" });
        const unscoped = yield* memory.getRelevantContext(shared, 5);
        const scoped = yield* memory.getRelevantContext(shared, 5, "ScopeA");
        return { unscoped, scoped };
      }),
      memoryLayer(),
    );
    const unscopedPools = new Set(result.unscoped.map((e) => e.poolAddress));
    expect(unscopedPools.has("ScopeA")).toBe(true);
    expect(unscopedPools.has("ScopeB")).toBe(true);
    expect(result.scoped.length).toBe(1);
    expect(result.scoped[0]!.poolAddress).toBe("ScopeA");
  });
});

// ─── recordOutcome ───────────────────────────────────────────────────────────

describe("MemoryLive.recordOutcome", () => {
  async function recordAndRecall(
    pnlUsd: number,
  ): Promise<{ outcome: string | undefined; category: MemoryCategory; content: string }> {
    const action = "EXIT";
    const pool = "PoolOmega";
    const context = "trailing stop hit";
    const expectedContent = `${action} on ${pool}: PnL=$${pnlUsd.toFixed(2)}. Context: ${context}`;
    const recalled = await run(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        yield* memory.recordOutcome(pool, action, pnlUsd, context);
        // Exact content query → deterministic nearest neighbour.
        const rows = yield* memory.getRelevantContext(expectedContent, 5);
        return rows;
      }),
      memoryLayer(),
    );
    expect(recalled.length).toBeGreaterThanOrEqual(1);
    const entry = recalled[0]!;
    expect(entry.content).toBe(expectedContent);
    return { outcome: entry.outcome, category: entry.category, content: entry.content };
  }

  it.skipIf(!vecAvailable)(
    "classifies positive PnL as profit and stores it as an outcome",
    async () => {
      const r = await recordAndRecall(42.5);
      expect(r.category).toBe("outcome");
      expect(r.outcome).toBe("profit");
      expect(r.content).toContain("PnL=$42.50");
    },
  );

  it.skipIf(!vecAvailable)("classifies negative PnL as loss", async () => {
    const r = await recordAndRecall(-17.25);
    expect(r.outcome).toBe("loss");
    expect(r.content).toContain("PnL=$-17.25");
  });

  it.skipIf(!vecAvailable)("classifies zero PnL as neutral", async () => {
    const r = await recordAndRecall(0);
    expect(r.outcome).toBe("neutral");
    expect(r.content).toContain("PnL=$0.00");
  });
});

// ─── TTL assignment ──────────────────────────────────────────────────────────

describe("MemoryLive TTL assignment", () => {
  it.skipIf(!vecAvailable)("sets a pattern entry's expiry to createdAt + 90 days", async () => {
    const content = "ttl pattern probe";
    const result = await run(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        yield* memory.upsert({ content, category: "pattern" });
        return yield* memory.getRelevantContext(content, 1);
      }),
      memoryLayer(),
    );
    const entry = result[0]!;
    expect(entry.expiresAt - entry.createdAt).toBe(PATTERN_TTL_MS);
  });

  it.skipIf(!vecAvailable)("sets an outcome entry's expiry to createdAt + 180 days", async () => {
    const pool = "PoolTtl";
    const expectedContent = `HOLD on ${pool}: PnL=$5.00. Context: steady`;
    const result = await run(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        yield* memory.recordOutcome(pool, "HOLD", 5, "steady");
        return yield* memory.getRelevantContext(expectedContent, 1);
      }),
      memoryLayer(),
    );
    const entry = result[0]!;
    expect(entry.expiresAt - entry.createdAt).toBe(OUTCOME_TTL_MS);
  });

  it.skipIf(!vecAvailable)("sets a warning entry's expiry to createdAt + 60 days", async () => {
    const content = "ttl warning probe";
    const result = await run(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        yield* memory.upsert({ content, category: "warning" });
        return yield* memory.getRelevantContext(content, 1);
      }),
      memoryLayer(),
    );
    const entry = result[0]!;
    expect(entry.expiresAt - entry.createdAt).toBe(WARNING_TTL_MS);
  });
});

// ─── expiry (backdated rows) + pruneExpired ──────────────────────────────────

describe("MemoryLive expiry + pruneExpired", () => {
  it.skipIf(!vecAvailable)(
    "getRelevantContext omits expired rows but returns fresh ones",
    async () => {
      const expired = "expired ghost memory";
      const fresh = "fresh living memory";
      const result = await run(
        Effect.gen(function* () {
          const memory = yield* MemoryService;
          const dbService = yield* DbService;
          const raw = dbService.db as Database;
          const now = Date.now();
          // Expired 10 days ago (created 100 days ago, well past the 60d warning TTL).
          yield* Effect.promise(() =>
            insertBackdated(raw, {
              content: expired,
              category: "warning",
              createdAt: now - 100 * DAY_MS,
              expiresAt: now - 10 * DAY_MS,
            }),
          );
          // Fresh row via the service path (expiresAt = now + TTL, in the future).
          yield* memory.upsert({ content: fresh, category: "warning" });
          return yield* memory.getRelevantContext(fresh, 10);
        }),
        memoryWithDbLayer(),
      );
      const contents = result.map((e) => e.content);
      expect(contents).toContain(fresh);
      expect(contents).not.toContain(expired);
    },
  );

  it.skipIf(!vecAvailable)(
    "pruneExpired deletes exactly the expired rows and is idempotent",
    async () => {
      const fresh = "survivor memory";
      const result = await run(
        Effect.gen(function* () {
          const memory = yield* MemoryService;
          const dbService = yield* DbService;
          const raw = dbService.db as Database;
          const now = Date.now();
          yield* Effect.promise(() =>
            insertBackdated(raw, {
              content: "expired row one",
              category: "pattern",
              createdAt: now - 200 * DAY_MS,
              expiresAt: now - 50 * DAY_MS,
            }),
          );
          yield* Effect.promise(() =>
            insertBackdated(raw, {
              content: "expired row two",
              category: "outcome",
              createdAt: now - 300 * DAY_MS,
              expiresAt: now - 1 * DAY_MS,
            }),
          );
          yield* memory.upsert({ content: fresh, category: "pattern" });
          const firstPrune = yield* memory.pruneExpired();
          const secondPrune = yield* memory.pruneExpired();
          const survivors = yield* memory.getRelevantContext(fresh, 10);
          return { firstPrune, secondPrune, survivors };
        }),
        memoryWithDbLayer(),
      );
      expect(result.firstPrune).toBe(2);
      expect(result.secondPrune).toBe(0);
      expect(result.survivors.map((e) => e.content)).toContain(fresh);
    },
  );

  it.skipIf(!vecAvailable)("returns 0 and keeps every row when nothing is expired", async () => {
    const result = await run(
      Effect.gen(function* () {
        const memory = yield* MemoryService;
        for (let i = 0; i < 3; i += 1) {
          yield* memory.upsert({ content: `fresh keep memory ${i}`, category: "warning" });
        }
        const pruned = yield* memory.pruneExpired();
        const recalled = yield* memory.getRelevantContext("fresh keep memory 0", 10);
        return { pruned, recalledCount: recalled.length };
      }),
      memoryLayer(),
    );
    expect(result.pruned).toBe(0);
    expect(result.recalledCount).toBeGreaterThanOrEqual(1);
  });
});

// ─── degraded mode: vec_memory absent ────────────────────────────────────────

describe("MemoryLive degraded mode (vec_memory absent)", () => {
  it.skipIf(!vecAvailable)(
    "upsert no-ops, recall returns [], prune returns 0 after vec_memory is dropped",
    async () => {
      const result = await run(
        Effect.gen(function* () {
          const memory = yield* MemoryService;
          const dbService = yield* DbService;
          const raw = dbService.db as Database;
          // Knock the vector table out from under the live service. Every memory
          // op guards on hasVecMemoryTable(db) and degrades to a no-op/[].
          raw.exec("DROP TABLE vec_memory");
          yield* memory.upsert({ content: "orphan", category: "pattern", poolAddress: "PoolX" });
          const recalled = yield* memory.getRelevantContext("orphan", 5);
          const pruned = yield* memory.pruneExpired();
          return { recalled, pruned };
        }),
        memoryWithDbLayer(),
      );
      expect(result.recalled).toEqual([]);
      expect(result.pruned).toBe(0);
    },
  );
});
