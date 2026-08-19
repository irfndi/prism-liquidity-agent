import { Effect } from "effect";
import { stringifySafe, parseBigIntSafe } from "./bigint-json.js";

/**
 * Persistent token-metadata cache.
 *
 * The engine resolves token decimals/symbol via keyless standard RPC first and
 * Helius DAS `getAsset` last. The Helius path is the only keyed call and should
 * be hit at most ~once per token per day. This module provides a restart-surviving
 * cache on top of the SQLite `metadata` table so that keyed metadata lookups are
 * not repeated after an engine restart.
 *
 * This is a leaf module: it performs no network calls and wires nothing into the
 * engine layer. Consumers own the policy of when to refresh (via
 * {@link shouldRefresh} / {@link isStale}) and when to persist (via
 * {@link savePersistedCache}).
 */

/** Shape of the cached token metadata (bigint-free, JSON-safe). */
export interface TokenMeta {
  symbol: string;
  decimals: number;
  priceUsd?: number;
  priceFetchedAt?: number;
}

/** A cache entry: the metadata plus the wall-clock time it was fetched at. */
export interface CacheEntry {
  meta: TokenMeta;
  fetchedAt: number;
}

/** Hard TTL: past this age a cached entry is unconditionally stale. */
export const TOKEN_META_HARD_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Soft refresh threshold: past this age an entry is a candidate for refresh,
 * but a stale value is still usable until the hard TTL is reached.
 */
export const TOKEN_META_SOFT_REFRESH_MS = 60 * 60 * 1000; // 1h

/** Minimal structural shape of the SQLite-backed metadata store we persist to. */
export interface TokenMetadataDb {
  getMetadata: (key: string) => Effect.Effect<string | null, Error>;
  setMetadata: (key: string, value: string) => Effect.Effect<void, Error>;
}

/** True when the entry is older than the soft-refresh threshold. */
export function shouldRefresh(fetchedAt: number, now: number): boolean {
  return now - fetchedAt > TOKEN_META_SOFT_REFRESH_MS;
}

/** True when the entry is older than the hard TTL and unfit for reuse. */
export function isStale(fetchedAt: number, now: number): boolean {
  return now - fetchedAt > TOKEN_META_HARD_TTL_MS;
}

/** Persistent SQLite metadata key for a cache namespace. */
export function metaCacheKey(namespace: string): string {
  return `token_meta_cache:${namespace}`;
}

/**
 * An in-memory token metadata cache with a configurable TTL. Plain synchronous —
 * no side effects. Age is measured against an injectable `now` so callers (and
 * tests) can simulate time without touching a clock.
 */
export class TokenMetadataCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly ttlMs: number = TOKEN_META_HARD_TTL_MS) {}

  /** Return the cached metadata for a mint, or undefined when absent/expired. */
  get(mint: string, now: number = Date.now()): TokenMeta | undefined {
    const entry = this.entries.get(mint);
    if (entry === undefined) return undefined;
    if (now - entry.fetchedAt > this.ttlMs) {
      this.entries.delete(mint);
      return undefined;
    }
    return entry.meta;
  }

  /** Store metadata for a mint, recording when it was fetched. */
  set(mint: string, meta: TokenMeta, fetchedAt: number = Date.now()): void {
    this.entries.set(mint, { meta, fetchedAt });
  }

  /** Age in ms of the cached entry for a mint, or undefined when absent. */
  getAgeMs(mint: string, now: number = Date.now()): number | undefined {
    const entry = this.entries.get(mint);
    return entry === undefined ? undefined : now - entry.fetchedAt;
  }

  /** Drop every entry older than the configured TTL. */
  prune(now: number = Date.now()): void {
    for (const [mint, entry] of this.entries) {
      if (now - entry.fetchedAt > this.ttlMs) this.entries.delete(mint);
    }
  }

  /** Number of live (non-expired at `now`) entries. */
  size(now: number = Date.now()): number {
    let count = 0;
    for (const [, entry] of this.entries) {
      if (now - entry.fetchedAt <= this.ttlMs) count += 1;
    }
    return count;
  }

  /** Internal accessor for round-tripping the whole map. */
  entriesView(): Map<string, CacheEntry> {
    return this.entries;
  }
}

interface RawTokenMeta {
  readonly symbol: unknown;
  readonly decimals: unknown;
  readonly priceUsd?: unknown;
  readonly priceFetchedAt?: unknown;
}

interface RawCacheEntry {
  readonly fetchedAt: unknown;
  readonly meta: unknown;
}

function isNonNullObject<T>(value: T): boolean {
  return value !== null && value instanceof Object && !(value instanceof Function);
}

function readString<T>(value: T): string | null {
  // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
  return Object.prototype.toString.call(value) === "[object String]" ? (value as string) : null;
}

function readNumber<T>(value: T): number | null {
  // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
  return Object.prototype.toString.call(value) === "[object Number]" ? (value as number) : null;
}

function parseTokenMeta<T>(value: T): TokenMeta | null {
  if (!isNonNullObject(value)) return null;
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  const record = value as RawTokenMeta;
  const symbol = readString(record.symbol);
  if (symbol === null) return null;
  const decimals = readNumber(record.decimals);
  if (decimals === null) return null;
  const meta: TokenMeta = { symbol, decimals };
  if (record.priceUsd !== undefined) {
    const priceUsd = readNumber(record.priceUsd);
    if (priceUsd === null) return null;
    meta.priceUsd = priceUsd;
  }
  if (record.priceFetchedAt !== undefined) {
    const priceFetchedAt = readNumber(record.priceFetchedAt);
    if (priceFetchedAt === null) return null;
    meta.priceFetchedAt = priceFetchedAt;
  }
  return meta;
}

/**
 * Serialize a map of cache entries into a JSON string. The data is bigint-free,
 * but `stringifySafe` keeps the serialize path safe regardless. Returns the JSON
 * string (never throws).
 */
export function serializeCache(map: Map<string, CacheEntry>): string {
  return stringifySafe(Array.from(map.entries()));
}

/**
 * Parse a JSON string produced by {@link serializeCache} back into a Map.
 * Tolerant of malformed/partial input: invalid entries are skipped and parse
 * failures return an empty Map (never throws).
 */
export function deserializeCache(json: string): Map<string, CacheEntry> {
  const result = new Map<string, CacheEntry>();
  let raw: unknown;
  try {
    raw = parseBigIntSafe<unknown>(json);
  } catch {
    return result;
  }
  if (!Array.isArray(raw)) return result;
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const mint = readString(item[0]);
    if (mint === null) continue;
    const entry = item[1];
    if (!isNonNullObject(entry)) continue;
    // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
    const record = entry as RawCacheEntry;
    const fetchedAt = readNumber(record.fetchedAt);
    if (fetchedAt === null) continue;
    const meta = parseTokenMeta(record.meta);
    if (meta === null) continue;
    result.set(mint, { meta, fetchedAt });
  }
  return result;
}

/**
 * Load a persisted cache from the SQLite `metadata` table. Fail-open: a missing
 * row or a read/parse error yields an empty Map (never throws).
 */
export function loadPersistedCache(
  db: TokenMetadataDb,
  namespace: string,
): Effect.Effect<Map<string, CacheEntry>, never> {
  // Wrap the db read in Effect.try and drive it with runSync so BOTH a typed
  // failure and a defect thrown inside the underlying Effect.sync (how
  // DbLive.getMetadata is implemented) surface as a recoverable typed error.
  // Effect.catch then swallows it fail-open.
  return Effect.try({
    try: () => Effect.runSync(db.getMetadata(metaCacheKey(namespace))),
    catch: () => new Error("token metadata cache read failed"),
  }).pipe(
    Effect.catch(() => Effect.succeed(null)),
    Effect.map((raw) => (raw === null ? new Map() : deserializeCache(raw))),
  );
}

/**
 * Persist a cache to the SQLite `metadata` table. Fail-open: a write error is
 * swallowed so persistence problems never break a scan cycle.
 */
export function savePersistedCache(
  db: TokenMetadataDb,
  namespace: string,
  map: Map<string, CacheEntry>,
): Effect.Effect<void, never> {
  return Effect.try({
    try: () => Effect.runSync(db.setMetadata(metaCacheKey(namespace), serializeCache(map))),
    catch: () => new Error("token metadata cache write failed"),
  }).pipe(Effect.catch(() => Effect.void));
}
