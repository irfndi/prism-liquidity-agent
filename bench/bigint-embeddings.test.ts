import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import {
  bigintReplacer,
  bigintReviver,
  stringifySafe,
  parseBigIntSafe,
} from "../engine/bigint-json.js";
import { getEmbedding, EMBEDDING_DIM } from "../engine/embeddings.js";

describe("bigintReplacer", () => {
  it("converts bigint values to decimal strings", () => {
    const value = { reserve: 123n, name: "x" };
    expect(bigintReplacer("", value)).toBe(value);
    expect(bigintReplacer("reserve", 9_007_199_254_740_993n)).toBe("9007199254740993");
  });

  it("passes other types through unchanged", () => {
    expect(bigintReplacer("k", "s")).toBe("s");
    expect(bigintReplacer("k", 1)).toBe(1);
    expect(bigintReplacer("k", null)).toBe(null);
    expect(bigintReplacer("k", undefined)).toBe(undefined);
  });

  it("stringifySafe handles nested bigints in objects and arrays", () => {
    const json = stringifySafe({
      a: 1n,
      b: [2n, 3n, { c: 4n }],
    });
    expect(JSON.parse(json)).toEqual({
      a: "1",
      b: ["2", "3", { c: "4" }],
    });
  });
});

describe("bigintReviver (parse round-trip)", () => {
  it("converts decimal strings back to bigint for known fields", () => {
    const json = stringifySafe({
      reserveX: 123n,
      reserveY: 456n,
      liquiditySupply: 789n,
      name: "x",
    });
    const parsed = parseBigIntSafe<{
      reserveX: bigint;
      reserveY: bigint;
      liquiditySupply: bigint;
      name: string;
    }>(json);
    expect(parsed.reserveX).toBe(123n);
    expect(parsed.reserveY).toBe(456n);
    expect(parsed.liquiditySupply).toBe(789n);
    expect(parsed.name).toBe("x");
    expect(typeof parsed.reserveX).toBe("bigint");
  });

  it("preserves non-bigint fields unchanged", () => {
    const json = stringifySafe({ price: 1.5, count: 42, label: "abc" });
    const parsed = parseBigIntSafe<{ price: number; count: number; label: string }>(json);
    expect(parsed.price).toBe(1.5);
    expect(parsed.count).toBe(42);
    expect(parsed.label).toBe("abc");
  });

  it("does not convert unrelated string fields", () => {
    const json = JSON.stringify({ description: "123" });
    const parsed = parseBigIntSafe<{ description: string }>(json);
    expect(parsed.description).toBe("123");
  });

  it("bigintReviver returns value unchanged for non-bigint fields", () => {
    expect(bigintReviver("name", "foo")).toBe("foo");
    expect(bigintReviver("name", 42)).toBe(42);
  });
});

describe("getEmbedding fallback", () => {
  // Clear EMBEDDINGS_BACKEND so we assert the default, not the explicit flag.
  const clearEnv = () => delete process.env.EMBEDDINGS_BACKEND;
  const restoreEnv = (prev: string | undefined) => {
    if (prev === undefined) clearEnv();
    else process.env.EMBEDDINGS_BACKEND = prev;
  };

  it("returns a 384-dim unit vector by default (no env var set)", async () => {
    const prev = process.env.EMBEDDINGS_BACKEND;
    clearEnv();
    try {
      const vec = await Effect.runPromise(getEmbedding("hello world"));
      expect(vec).toHaveLength(EMBEDDING_DIM);
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1, 5);
    } finally {
      restoreEnv(prev);
    }
  });

  it("is deterministic for the same input", async () => {
    const prev = process.env.EMBEDDINGS_BACKEND;
    clearEnv();
    try {
      const a = await Effect.runPromise(getEmbedding("solana pool rebalance"));
      const b = await Effect.runPromise(getEmbedding("solana pool rebalance"));
      expect(a).toEqual(b);
    } finally {
      restoreEnv(prev);
    }
  });

  it("is non-zero (sanity)", async () => {
    const prev = process.env.EMBEDDINGS_BACKEND;
    clearEnv();
    try {
      const vec = await Effect.runPromise(getEmbedding("solana"));
      expect(vec.some((v) => v !== 0)).toBe(true);
    } finally {
      restoreEnv(prev);
    }
  });
});
