import { Effect, Layer } from "effect";
import { createLogger } from "./logger.js";
import { DexScreenerService } from "./services.js";
import { BoundedTtlCache, PublicProviderBreaker, RequestPacer } from "./public-data-client.js";

/**
 * DexScreener primary secondary pool-stats source. Sits ahead of GeckoTerminal
 * as the first resilience tier for the Meteora Data API: when the Data API is
 * unreachable, DexScreener's keyless public API (300 req/min, far higher than
 * GeckoTerminal's 30/min) supplies REAL 24h volume and reserve TVL so
 * volume-authenticity, TVL gates and volume measurements stay computed from
 * measured data instead of `tvlUsd × modeled turnover`.
 *
 * LIVE-VERIFIED contract (tested the XST/SOL Meteora DLMM pool):
 *   - `pairs[0].volume.h24`  → real 24h volume as a NUMBER.
 *   - `pairs[0].liquidity.usd` → real reserve TVL as a NUMBER.
 *   - `pairs[0].priceUsd`    → USD price as a numeric STRING.
 *   - NO fees field of any kind. DexScreener never exposes pool fees, so fees
 *     are ALWAYS derived as `realVolume24h × baseFeeRate` (the caller passes the
 *     pool's binStep-derived base-fee rate `0.0025 + binStep/1e4`, the same model
 *     the adapter and gecko path use) — applied to REAL volume, honestly tagged.
 *   - Unknown pool → HTTP 200 with `{"pairs": null, "pair": null}` (NOT a 404).
 *     The parser MUST treat a null/empty `pairs` array as "not found".
 *   - `pairs` is an ARRAY (the single-pair endpoint nests one element; the
 *     multi-pair token endpoint nests many). We take the first element.
 *
 * Trust posture (identical to GeckoTerminal): measured volume/TVL, MODELED fees,
 * NO Data-API-exclusive safety signals (blacklist/freeze/verification/farm).
 * Because the resolver enriches both sources through the same
 * `enrichPoolFromGecko` path and tags them `statsSource: "geckoterminal"`, the
 * trust model is unchanged — DexScreener data is a measured volume/TVL overlay
 * with a modeled fee rate, exactly the gecko level. It is never a fee-measured
 * source and never sources safety data.
 */

const logger = createLogger("dexscreener");

const DEFAULT_BASE_URL = "https://api.dexscreener.com/latest/dex";
const REQUEST_TIMEOUT_MS = 10_000;

// ─── Request pacing (300 req/min keyless endpoint) ───────────────────────────
// 250ms keeps the shared pool/token lookup budget at ~240 req/min, leaving
// headroom for retries instead of deliberately running into the 429 ceiling.
const DEFAULT_REQUEST_INTERVAL_MS = 250;
const DEFAULT_TOKEN_API_URL = "https://api.dexscreener.com/tokens/v1/solana";
const MINTS_PER_REQUEST = 30;
const requestPacer = new RequestPacer(DEFAULT_REQUEST_INTERVAL_MS);
const providerBreaker = new PublicProviderBreaker(3, 60_000);
const POOL_STATS_CACHE_TTL_MS = 30_000;
const POOL_MISS_CACHE_TTL_MS = 5_000;
const MAX_POOL_STATS_CACHE_ENTRIES = 500;
const poolStatsCache = new BoundedTtlCache<DexscreenerPoolStats>(MAX_POOL_STATS_CACHE_ENTRIES);
const poolRequestCache = new BoundedTtlCache<DexscreenerPoolStats | null>(
  MAX_POOL_STATS_CACHE_ENTRIES,
);

export function clearDexscreenerCacheForTest(): void {
  poolStatsCache.clear();
  poolRequestCache.clear();
  providerBreaker.reset();
  requestPacer.reset();
}

export function setDexscreenerRequestIntervalMsForTest(ms: number): void {
  requestPacer.intervalMs = ms;
  requestPacer.reset();
}

/** The `fetch` call surface the module needs (bare signature, mirroring the
 *  gecko service so the global fetch and an injected fake are both assignable). */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Real pool stats resolved from DexScreener. Reuses the same shape as the
 *  gecko service (`GeckoPoolStats`) so the resolver and enricher treat both
 *  secondary sources uniformly. `tvlUsd` is null when the pool has no usable
 *  liquidity — the caller treats that as "unavailable" and falls through. */
export interface DexscreenerPoolStats {
  readonly tvlUsd: number | null;
  readonly volume24hUsd: number;
  readonly fees24hUsd: number;
  readonly basePriceUsd: number | null;
  readonly quotePriceUsd: number | null;
}

interface RawVolume {
  readonly h24: unknown;
}

interface RawLiquidity {
  readonly usd: unknown;
}

interface RawDexscreenerToken {
  readonly address: unknown;
}

interface RawDexscreenerPair {
  readonly volume: unknown;
  readonly liquidity: unknown;
  readonly priceUsd: unknown;
  readonly priceNative: unknown;
  readonly baseToken: unknown;
  readonly quoteToken: unknown;
}

interface RawDexscreenerResponse {
  readonly pairs: unknown;
}

function isNonNullObject<T>(value: T): boolean {
  return value !== null && value instanceof Object && !(value instanceof Function);
}

/** Parse a numeric STRING or number into a finite number, else null. */
function readFiniteNumber<T>(value: T): number | null {
  if (Object.prototype.toString.call(value) === "[object Number]") {
    // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
    const num = value as number;
    return Number.isFinite(num) ? num : null;
  }
  if (
    Object.prototype.toString.call(value) === "[object String]" &&
    // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
    (value as string).trim().length > 0
  ) {
    // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
    const parsed = Number(value as string);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Read the first pair object, or null when the payload has no usable pair. */
function readDexPair<T>(raw: T): RawDexscreenerPair | null {
  if (!isNonNullObject(raw)) return null;
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  const pairs = (raw as RawDexscreenerResponse).pairs;
  // DexScreener returns `{"pairs": null}` (HTTP 200) for an unknown pair.
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  const pair = pairs[0];
  if (!isNonNullObject(pair)) return null;
  // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
  return pair as RawDexscreenerPair;
}

/** Read 24h volume; null when missing or non-positive (unusable downstream). */
function readDexVolumeUsd(pair: RawDexscreenerPair): number | null {
  const volume = isNonNullObject(pair.volume)
    ? // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
      readFiniteNumber((pair.volume as RawVolume).h24)
    : null;
  if (volume === null || volume <= 0) return null;
  return volume;
}

/** Read liquidity as TVL; missing or non-positive values degrade to null. */
function readDexLiquidityUsd(pair: RawDexscreenerPair): number | null {
  const liquidity = isNonNullObject(pair.liquidity)
    ? // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
      readFiniteNumber((pair.liquidity as RawLiquidity).usd)
    : null;
  if (liquidity !== null && liquidity <= 0) return null;
  return liquidity;
}

/** Resolve an optional base-URL override (env, then default) to a clean endpoint. */
function resolveDexBaseUrl(configured: string | undefined, envUrl: string | undefined): string {
  const base = (configured ?? envUrl ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  return base.length > 0 ? base : DEFAULT_BASE_URL;
}

/**
 * Parse one `GET .../pairs/solana/{address}` response. Returns null when the
 * payload has no usable pair object or 24h volume cannot be read (the one field
 * every downstream gate needs). `tvlUsd` is null (not a failure) when liquidity
 * is missing — the caller decides whether to treat that as unavailable.
 *
 * `baseFeeRate` is the pool's binStep-derived base-fee fraction used to price
 * real volume into fees (DexScreener has no fees field — always applied).
 */
export function parseDexscreenerPoolStats<T>(
  raw: T,
  baseFeeRate: number,
): DexscreenerPoolStats | null {
  const pair = readDexPair(raw);
  if (pair === null) return null;
  const volume = readDexVolumeUsd(pair);
  if (volume === null) return null;
  return {
    tvlUsd: readDexLiquidityUsd(pair),
    volume24hUsd: volume,
    fees24hUsd: volume * baseFeeRate,
    basePriceUsd: readFiniteNumber(pair.priceUsd),
    quotePriceUsd: null,
  };
}

function readTokenAddress<T>(value: T): string | null {
  if (!isNonNullObject(value)) return null;
  // SAFETY: isNonNullObject establishes the record shape at this external-data boundary.
  const address = (value as RawDexscreenerToken).address;
  if (Object.prototype.toString.call(address) !== "[object String]") return null;
  // SAFETY: The preceding runtime branch establishes the asserted primitive type.
  const text = address as string;
  return text.length > 0 ? text : null;
}

function readPositiveNumber<T>(value: T): number | null {
  const number = readFiniteNumber(value);
  return number !== null && number > 0 ? number : null;
}

/** Parse the batch token-pairs response, choosing each mint's deepest pair. */
export function parseDexscreenerTokenPrices<T>(
  raw: T,
  requestedMints: ReadonlyArray<string>,
): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  if (!Array.isArray(raw)) return result;
  const requested = new Set(requestedMints);
  const bestLiquidity = new Map<string, number>();
  const consider = (mint: string | null, price: number | null, liquidityUsd: number): void => {
    if (mint === null || !requested.has(mint) || price === null || price <= 0) return;
    const previous = bestLiquidity.get(mint);
    if (previous !== undefined && previous >= liquidityUsd) return;
    bestLiquidity.set(mint, liquidityUsd);
    result.set(mint, price);
  };
  for (const value of raw) {
    if (!isNonNullObject(value)) continue;
    // SAFETY: isNonNullObject establishes the record shape at this external-data boundary.
    const pair = value as RawDexscreenerPair;
    const liquidityUsd = readDexLiquidityUsd(pair) ?? 0;
    const priceUsd = readPositiveNumber(pair.priceUsd);
    const priceNative = readPositiveNumber(pair.priceNative);
    consider(readTokenAddress(pair.baseToken), priceUsd, liquidityUsd);
    if (priceUsd !== null && priceNative !== null) {
      consider(readTokenAddress(pair.quoteToken), priceUsd / priceNative, liquidityUsd);
    }
  }
  return result;
}

async function fetchDexscreenerTokenChunk(
  chunk: ReadonlyArray<string>,
  options: {
    readonly baseUrl: string;
    readonly timeoutMs: number;
    readonly fetchImpl: FetchLike;
  },
): Promise<ReadonlyMap<string, number>> {
  if (!providerBreaker.canTry()) return new Map();
  await requestPacer.wait();
  const path = chunk.map((mint) => encodeURIComponent(mint)).join(",");
  try {
    const response = await options.fetchImpl(`${options.baseUrl}/${path}`, {
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      providerBreaker.recordFailure();
      logger.warn("DexScreener token prices unavailable", { status: response.status });
      return new Map();
    }
    const body: unknown = await response.json();
    providerBreaker.recordSuccess();
    return parseDexscreenerTokenPrices(body, chunk);
  } catch (error) {
    providerBreaker.recordFailure();
    logger.warn("DexScreener token price fetch failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
}

/** Fetch up to 30 mints per request from DexScreener's keyless token-pairs API. */
export async function getDexscreenerTokenPrices(
  mints: ReadonlyArray<string>,
  options: {
    readonly baseUrl?: string;
    readonly timeoutMs?: number;
    readonly fetchImpl?: FetchLike;
  } = {},
): Promise<ReadonlyMap<string, number>> {
  const uniqueMints = [...new Set(mints)];
  const result = new Map<string, number>();
  if (uniqueMints.length === 0 || !providerBreaker.canTry()) return result;
  const request = {
    baseUrl: (options.baseUrl ?? process.env.DEXSCREENER_TOKEN_API_URL ?? DEFAULT_TOKEN_API_URL)
      .trim()
      .replace(/\/+$/, ""),
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    fetchImpl: options.fetchImpl ?? fetch,
  };
  for (let start = 0; start < uniqueMints.length; start += MINTS_PER_REQUEST) {
    const chunk = uniqueMints.slice(start, start + MINTS_PER_REQUEST);
    const parsed = await fetchDexscreenerTokenChunk(chunk, request);
    for (const [mint, price] of parsed) result.set(mint, price);
  }
  return result;
}

// ─── Pool enrichment (source-aware) ──────────────────────────────────────────
// DexScreener data is enriched through the SAME `enrichPoolFromGecko` path as
// GeckoTerminal (identical trust posture: measured volume/TVL, modeled fees, no
// safety signals) and tagged `statsSource: "geckoterminal"` so the trust model
// and every gate are unchanged. The resolver in program.ts calls
// `enrichPoolFromGecko` for BOTH secondary sources.

// ─── Fetcher (fail-through to the next source) ───────────────────────────────

function cachePoolStats(
  poolAddress: string,
  baseFeeRate: number,
  stats: DexscreenerPoolStats,
): void {
  poolStatsCache.set(`${poolAddress}|${baseFeeRate}`, stats, POOL_STATS_CACHE_TTL_MS);
}

/**
 * Fetch real stats for one pool from DexScreener. NEVER throws and NEVER crashes
 * the scan cycle: an empty `pairs` array, 429/5xx, timeout, fetch failure, parse
 * failure, or missing liquidity all return null so the caller falls through.
 * Logs ONE warning per failing fetch.
 *
 * `baseFeeRate` is the pool's binStep-derived base-fee fraction (the caller
 * computes `0.0025 + binStep / 1e4`); `baseUrl` overrides the endpoint.
 */
async function fetchDexscreenerPoolStatsUncached(
  poolAddress: string,
  options: {
    readonly baseFeeRate: number;
    readonly baseUrl?: string;
    readonly timeoutMs?: number;
    readonly fetchImpl?: FetchLike;
  },
): Promise<DexscreenerPoolStats | null> {
  if (!providerBreaker.canTry()) return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const effectiveBase = resolveDexBaseUrl(options.baseUrl, process.env.DEXSCREENER_API_URL);
  const url = `${effectiveBase}/pairs/solana/${poolAddress}`;

  // Pace toward the keyless quota (see the pacing constants above). Reserving
  // the next slot synchronously before any await keeps concurrent callers from
  // observing the same free slot.
  await requestPacer.wait();

  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      providerBreaker.recordFailure();
      logger.warn("DexScreener unavailable — falling through to next stats source", {
        pool: poolAddress,
        status: res.status,
      });
      return null;
    }
    const body: unknown = await res.json();
    const parsed = parseDexscreenerPoolStats(body, options.baseFeeRate);
    providerBreaker.recordSuccess();
    if (parsed === null) {
      logger.warn("DexScreener returned an unparseable or unknown pool payload", {
        pool: poolAddress,
      });
      return null;
    }
    // A usable liquidity figure is required to enrich TVL; without it the stats
    // are too partial to trust (volume alone mis-sizes TVL gates).
    if (parsed.tvlUsd === null) {
      logger.warn("DexScreener pool has no liquidity — treating stats as unavailable", {
        pool: poolAddress,
      });
      return null;
    }
    cachePoolStats(poolAddress, options.baseFeeRate, parsed);
    return parsed;
  } catch (err) {
    providerBreaker.recordFailure();
    logger.warn("DexScreener fetch failed — falling through to next stats source", {
      pool: poolAddress,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function getDexscreenerPoolStats(
  poolAddress: string,
  options: {
    readonly baseFeeRate: number;
    readonly baseUrl?: string;
    readonly timeoutMs?: number;
    readonly fetchImpl?: FetchLike;
  },
): Promise<DexscreenerPoolStats | null> {
  const cacheKey = `${poolAddress}|${options.baseFeeRate}`;
  const cached = poolStatsCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const requestKey = `${cacheKey}|${options.baseUrl ?? process.env.DEXSCREENER_API_URL ?? ""}|${options.timeoutMs ?? REQUEST_TIMEOUT_MS}`;
  return poolRequestCache.getOrFetch(requestKey, POOL_MISS_CACHE_TTL_MS, () =>
    fetchDexscreenerPoolStatsUncached(poolAddress, options),
  );
}

// ─── Effect service wiring ───────────────────────────────────────────────────
// Thin live layer so program.ts consumes DexScreener through the
// DexScreenerService Context.Tag (symmetric with GeckoTerminalLive). The module
// functions, injectable FetchLike and pacing stay exactly as they are.

export const DexScreenerLive = Layer.succeed(DexScreenerService, {
  getPoolStats: (poolAddress, baseFeeRate) =>
    Effect.promise(() => getDexscreenerPoolStats(poolAddress, { baseFeeRate })),
});
