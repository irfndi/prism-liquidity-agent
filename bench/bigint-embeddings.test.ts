import { describe, it, expect } from "vitest";
import { bigintReplacer, stringifySafe } from "../engine/bigint-json.js";
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

describe("getEmbedding fallback", () => {
  it("returns a 384-dim unit vector when EMBEDDINGS_BACKEND=fallback", async () => {
    const prev = process.env.EMBEDDINGS_BACKEND;
    process.env.EMBEDDINGS_BACKEND = "fallback";
    try {
      const vec = await getEmbedding("hello world");
      expect(vec).toHaveLength(EMBEDDING_DIM);
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1, 5);
    } finally {
      if (prev === undefined) delete process.env.EMBEDDINGS_BACKEND;
      else process.env.EMBEDDINGS_BACKEND = prev;
    }
  });

  it("is deterministic for the same input", async () => {
    const prev = process.env.EMBEDDINGS_BACKEND;
    process.env.EMBEDDINGS_BACKEND = "fallback";
    try {
      const a = await getEmbedding("solana pool rebalance");
      const b = await getEmbedding("solana pool rebalance");
      expect(a).toEqual(b);
    } finally {
      if (prev === undefined) delete process.env.EMBEDDINGS_BACKEND;
      else process.env.EMBEDDINGS_BACKEND = prev;
    }
  });

  it("is non-zero (sanity)", async () => {
    const prev = process.env.EMBEDDINGS_BACKEND;
    process.env.EMBEDDINGS_BACKEND = "fallback";
    try {
      const vec = await getEmbedding("solana");
      expect(vec.some((v) => v !== 0)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.EMBEDDINGS_BACKEND;
      else process.env.EMBEDDINGS_BACKEND = prev;
    }
  });
});
