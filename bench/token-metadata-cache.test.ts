import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import {
  TokenMetadataCache,
  TOKEN_META_HARD_TTL_MS,
  TOKEN_META_SOFT_REFRESH_MS,
  shouldRefresh,
  isStale,
  serializeCache,
  deserializeCache,
  loadPersistedCache,
  savePersistedCache,
  metaCacheKey,
  type CacheEntry,
  type TokenMeta,
  type TokenMetadataDb,
} from "../engine/token-metadata-cache.js";

const MINT_A = "mint-a";
const MINT_B = "mint-b";

function makeMeta(overrides: Partial<TokenMeta> = {}): TokenMeta {
  return { symbol: "SOL", decimals: 9, ...overrides };
}

function runSync<T>(effect: Effect.Effect<T, never>): T {
  return Effect.runSync(effect);
}

/** In-memory fake for the SQLite metadata store. */
function makeFakeDb() {
  const store = new Map<string, string>();
  const db: TokenMetadataDb = {
    getMetadata: (key) => Effect.sync(() => store.get(key) ?? null),
    setMetadata: (key, value) =>
      Effect.sync(() => {
        store.set(key, value);
      }),
  };
  return { db, store };
}

describe("TokenMetadataCache", () => {
  it("round-trips set/get", () => {
    const cache = new TokenMetadataCache();
    const meta = makeMeta();
    cache.set(MINT_A, meta, 1000);
    expect(cache.get(MINT_A, 2000)).toEqual(meta);
  });

  it("returns undefined for an unknown mint", () => {
    const cache = new TokenMetadataCache();
    expect(cache.get(MINT_A, 0)).toBeUndefined();
  });

  it("reports the entry age", () => {
    const cache = new TokenMetadataCache();
    cache.set(MINT_A, makeMeta(), 1000);
    expect(cache.getAgeMs(MINT_A, 2500)).toBe(1500);
    expect(cache.getAgeMs("unknown", 2500)).toBeUndefined();
  });

  it("expires entries past the TTL", () => {
    const cache = new TokenMetadataCache(1000);
    cache.set(MINT_A, makeMeta(), 0);
    // Within TTL: still present.
    expect(cache.get(MINT_A, 999)).toEqual(makeMeta());
    // Just past TTL: gone.
    expect(cache.get(MINT_A, 1001)).toBeUndefined();
  });

  it("prune removes only expired entries", () => {
    const cache = new TokenMetadataCache(1000);
    cache.set(MINT_A, makeMeta(), 0); // expires at 1000
    cache.set(MINT_B, makeMeta(), 500); // expires at 1500
    cache.prune(1250);
    expect(cache.get(MINT_A, 1250)).toBeUndefined();
    expect(cache.get(MINT_B, 1250)).toEqual(makeMeta());
  });

  it("size counts only live entries", () => {
    const cache = new TokenMetadataCache(1000);
    cache.set(MINT_A, makeMeta(), 0);
    cache.set(MINT_B, makeMeta(), 500);
    expect(cache.size(750)).toBe(2);
    expect(cache.size(1250)).toBe(1);
  });
});

describe("shouldRefresh / isStale", () => {
  const fetchedAt = 1_000_000;

  it("shouldRefresh is false before the soft threshold", () => {
    expect(shouldRefresh(fetchedAt, fetchedAt + TOKEN_META_SOFT_REFRESH_MS - 1)).toBe(false);
  });

  it("shouldRefresh is true after the soft threshold", () => {
    expect(shouldRefresh(fetchedAt, fetchedAt + TOKEN_META_SOFT_REFRESH_MS + 1)).toBe(true);
  });

  it("isStale is false before the hard TTL", () => {
    expect(isStale(fetchedAt, fetchedAt + TOKEN_META_HARD_TTL_MS - 1)).toBe(false);
  });

  it("isStale is true after the hard TTL", () => {
    expect(isStale(fetchedAt, fetchedAt + TOKEN_META_HARD_TTL_MS + 1)).toBe(true);
  });
});

describe("serialize / deserialize", () => {
  it("round-trips bigint-free metadata", () => {
    const map = new Map<string, CacheEntry>([
      [MINT_A, { meta: { symbol: "SOL", decimals: 9 }, fetchedAt: 1000 }],
      [
        MINT_B,
        {
          meta: { symbol: "USDC", decimals: 6, priceUsd: 1.0, priceFetchedAt: 2000 },
          fetchedAt: 1500,
        },
      ],
    ]);
    const json = serializeCache(map);
    const restored = deserializeCache(json);
    expect(restored).toEqual(map);
  });

  it("returns an empty map for an empty cache", () => {
    expect(deserializeCache(serializeCache(new Map()))).toEqual(new Map());
  });

  it("is tolerant of malformed input", () => {
    expect(deserializeCache("not json")).toEqual(new Map());
    expect(deserializeCache("42")).toEqual(new Map());
    expect(deserializeCache("null")).toEqual(new Map());
    // Well-formed but invalid entries are skipped, valid ones survive.
    const json = '[[123, {}], ["mint", {"meta": "bad", "fetchedAt": 1}]]';
    expect(deserializeCache(json)).toEqual(new Map());
  });

  it("skips invalid entries but keeps valid ones", () => {
    const valid: CacheEntry = { meta: { symbol: "SOL", decimals: 9 }, fetchedAt: 1000 };
    const json = `[[${JSON.stringify(MINT_A)}, ${JSON.stringify(valid)}], [${JSON.stringify(
      MINT_B,
    )}, {"meta": "nope", "fetchedAt": 1}]]`;
    const restored = deserializeCache(json);
    expect(restored).toEqual(new Map([[MINT_A, valid]]));
  });
});

describe("persistence helpers", () => {
  it("loadPersistedCache returns an empty map when nothing is stored", () => {
    const { db } = makeFakeDb();
    expect(runSync(loadPersistedCache(db, "ns"))).toEqual(new Map());
  });

  it("round-trips a cache through the metadata store", () => {
    const { db, store } = makeFakeDb();
    const map = new Map<string, CacheEntry>([[MINT_A, { meta: makeMeta(), fetchedAt: 1000 }]]);
    runSync(savePersistedCache(db, "ns", map));
    expect(store.get(metaCacheKey("ns"))).toBe(serializeCache(map));
    expect(runSync(loadPersistedCache(db, "ns"))).toEqual(map);
  });

  it("namespaces keys per namespace", () => {
    const { db } = makeFakeDb();
    const a = new Map<string, CacheEntry>([[MINT_A, { meta: makeMeta(), fetchedAt: 1 }]]);
    const b = new Map<string, CacheEntry>([[MINT_B, { meta: makeMeta(), fetchedAt: 2 }]]);
    runSync(savePersistedCache(db, "ns-a", a));
    runSync(savePersistedCache(db, "ns-b", b));
    expect(runSync(loadPersistedCache(db, "ns-a"))).toEqual(a);
    expect(runSync(loadPersistedCache(db, "ns-b"))).toEqual(b);
  });

  it("loadPersistedCache is fail-open on a throwing getMetadata", () => {
    const db: TokenMetadataDb = {
      getMetadata: () =>
        Effect.sync(() => {
          throw new Error("boom");
        }),
      setMetadata: () => Effect.void,
    };
    expect(runSync(loadPersistedCache(db, "ns"))).toEqual(new Map());
  });

  it("loadPersistedCache is fail-open on a throwing getMetadata via Effect.fail", () => {
    const db: TokenMetadataDb = {
      getMetadata: () => Effect.fail(new Error("boom")),
      setMetadata: () => Effect.void,
    };
    expect(runSync(loadPersistedCache(db, "ns"))).toEqual(new Map());
  });

  it("savePersistedCache is fail-open on a throwing setMetadata", () => {
    const db: TokenMetadataDb = {
      getMetadata: () => Effect.succeed(null),
      setMetadata: () =>
        Effect.sync(() => {
          throw new Error("boom");
        }),
    };
    const map = new Map<string, CacheEntry>([[MINT_A, { meta: makeMeta(), fetchedAt: 1 }]]);
    expect(() => runSync(savePersistedCache(db, "ns", map))).not.toThrow();
  });

  it("loadPersistedCache is fail-open on corrupt stored JSON", () => {
    const { db, store } = makeFakeDb();
    store.set(metaCacheKey("ns"), "{{{ not json");
    expect(runSync(loadPersistedCache(db, "ns"))).toEqual(new Map());
  });
});
