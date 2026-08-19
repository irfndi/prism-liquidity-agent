import { Effect, Layer } from "effect";
import { ConfigService } from "./config-service.js";
import { MeteoraDatapiService, type MeteoraDatapiApi, type MeteoraPoolStats } from "./services.js";
import type { PoolState } from "./types.js";
import { createLogger } from "./logger.js";
import { retryEffectWithBackoff } from "./adapter-retry.js";

const logger = createLogger("meteora-datapi");

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;

// ─── Response validation ─────────────────────────────────────────────────────

interface RawWindowMap {
  readonly "24h": unknown;
  readonly "12h": unknown;
  readonly "1h": unknown;
}

interface RawDatapiToken {
  readonly freeze_authority_disabled: unknown;
  readonly is_verified: unknown;
}

interface RawDatapiPoolConfig {
  readonly base_fee_pct: unknown;
}

interface RawDatapiPool {
  readonly address: unknown;
  readonly name: unknown;
  readonly tvl: unknown;
  readonly volume: RawWindowMap;
  readonly fees: RawWindowMap;
  readonly apr: unknown;
  readonly apy: unknown;
  readonly current_price: unknown;
  readonly fee_tvl_ratio: RawWindowMap;
  readonly dynamic_fee_pct: unknown;
  readonly pool_config: unknown;
  readonly has_farm: unknown;
  readonly farm_apr: unknown;
  readonly farm_apy: unknown;
  readonly is_blacklisted: unknown;
  readonly token_x: unknown;
  readonly token_y: unknown;
}

function isNonNullObject<T>(value: T): boolean {
  return value !== null && value instanceof Object && !(value instanceof Function);
}

function readString<T>(value: T): string | null {
  // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
  return Object.prototype.toString.call(value) === "[object String]" ? (value as string) : null;
}

function readNumber<T>(value: T): number | null {
  // SAFETY: The enclosing statement has validated or constructed the asserted contract before this value is consumed.
  return Object.prototype.toString.call(value) === "[object Number]" &&
    // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
    Number.isFinite(value as number)
    ? // SAFETY: The runtime guard or typed fixture immediately above this assertion establishes the required invariant.
      // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
      (value as number)
    : null;
}

function readBoolean<T>(value: T): boolean | null {
  // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
  return Object.prototype.toString.call(value) === "[object Boolean]" ? (value as boolean) : null;
}

function readWindow(
  obj: RawWindowMap | null | undefined,
  window: keyof RawWindowMap,
): number | null {
  return readNumber(obj?.[window]);
}

/**
 * Parse one pool object from the Data API. Returns null when required numeric
 * fields are missing (likely an upstream schema change) so the caller falls
 * back to heuristic metrics instead of consuming garbage.
 */
export function parseMeteoraPoolStats<T>(raw: T): MeteoraPoolStats | null {
  if (!isNonNullObject(raw)) return null;
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  const report = raw as RawDatapiPool;
  const address = readString(report.address);
  if (address === null || address.length === 0) return null;
  const tvl = readNumber(report.tvl);
  const volume24h = readWindow(report.volume, "24h");
  const fees24h = readWindow(report.fees, "24h");
  const apr = readNumber(report.apr);
  if (tvl === null || volume24h === null || fees24h === null || apr === null) return null;

  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  const tokenX = isNonNullObject(report.token_x) ? (report.token_x as RawDatapiToken) : null;
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  const tokenY = isNonNullObject(report.token_y) ? (report.token_y as RawDatapiToken) : null;
  // SAFETY: The enclosing statement has validated or constructed the asserted contract before this value is consumed.
  const poolConfig = isNonNullObject(report.pool_config)
    ? // SAFETY: The runtime guard or typed fixture immediately above this assertion establishes the required invariant.
      // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
      (report.pool_config as RawDatapiPoolConfig)
    : null;

  return {
    address,
    name: readString(report.name) ?? "",
    tvlUsd: tvl,
    volume24hUsd: volume24h,
    fees24hUsd: fees24h,
    apr,
    apy: readNumber(report.apy) ?? 0,
    currentPrice: readNumber(report.current_price) ?? 0,
    feeTvlRatio24h: readWindow(report.fee_tvl_ratio, "24h"),
    feeTvlRatio12h: readWindow(report.fee_tvl_ratio, "12h"),
    feeTvlRatio1h: readWindow(report.fee_tvl_ratio, "1h"),
    dynamicFeePct: readNumber(report.dynamic_fee_pct),
    baseFeePct: readNumber(poolConfig?.base_fee_pct),
    hasFarm: readBoolean(report.has_farm),
    farmApr: readNumber(report.farm_apr),
    farmApy: readNumber(report.farm_apy),
    isBlacklisted: readBoolean(report.is_blacklisted),
    tokenXFreezeAuthorityDisabled: readBoolean(tokenX?.freeze_authority_disabled),
    tokenYFreezeAuthorityDisabled: readBoolean(tokenY?.freeze_authority_disabled),
    tokenXVerified: readBoolean(tokenX?.is_verified),
    tokenYVerified: readBoolean(tokenY?.is_verified),
  };
}

// ─── Pool enrichment ─────────────────────────────────────────────────────────

/**
 * Replace heuristic tvl/volume/fees with real Data API values. On-chain
 * identity fields (mints, symbols, active bin, price, bin step) always come
 * from the adapter and are preserved. APR is recomputed into the engine's
 * annualized-percent convention (the API's `apr` is a daily fee/TVL rate).
 */
export function enrichPoolWithDatapi(pool: PoolState, stats: MeteoraPoolStats): PoolState {
  const aprAnnualizedPct =
    stats.tvlUsd > 0 && stats.fees24hUsd > 0
      ? ((stats.fees24hUsd * 365) / stats.tvlUsd) * 100
      : pool.apr;
  return {
    ...pool,
    tvlUsd: stats.tvlUsd > 0 ? stats.tvlUsd : pool.tvlUsd,
    volume24hUsd: stats.volume24hUsd,
    fees24hUsd: stats.fees24hUsd,
    apr: aprAnnualizedPct,
    hasFarm: stats.hasFarm,
    // farm_apr is already annualized percent (unlike the API's daily `apr`),
    // so it lands on the pool state without rescaling. A farm pool with an
    // unknown APR keeps null here — computeMetrics reports 0 for it.
    farmAprPct: stats.hasFarm === true ? stats.farmApr : null,
    statsSource: "datapi",
  };
}

// ─── Live layer ──────────────────────────────────────────────────────────────

export const MeteoraDatapiLive = Layer.effect(
  MeteoraDatapiService,
  Effect.gen(function* () {
    const config = yield* ConfigService;
    const baseUrl = config.meteoraDatapiBaseUrl.replace(/\/+$/, "");

    // Response-level dedup: the same pool's detail is fetched once per cycle
    // (and shared across the scan loop + screening + signal paths). The Data
    // API is keyless and effectively unlimited, but the pool's TVL/volume/fees
    // only move on swap cadence — a short TTL collapses the within-cycle
    // duplicates without going stale across cycles. A failed fetch is NOT
    // cached (fail-open retries next read), and the map is opportunistically
    // pruned on insert so dropped pools don't accumulate.
    const POOL_STATS_CACHE_TTL_MS = 30_000;
    const poolStatsCache = new Map<string, { stats: MeteoraPoolStats; fetchedAt: number }>();
    function prunePoolStatsCache(): void {
      const now = Date.now();
      for (const [addr, entry] of poolStatsCache) {
        if (now - entry.fetchedAt >= POOL_STATS_CACHE_TTL_MS) poolStatsCache.delete(addr);
      }
    }

    const getPoolData = (poolAddress: string): Effect.Effect<MeteoraPoolStats | null, never> => {
      prunePoolStatsCache();
      const cached = poolStatsCache.get(poolAddress);
      if (cached && Date.now() - cached.fetchedAt < POOL_STATS_CACHE_TTL_MS) {
        return Effect.succeed(cached.stats);
      }
      const url = `${baseUrl}/pools/${poolAddress}`;
      const fetchJson = retryEffectWithBackoff(
        Effect.tryPromise({
          try: () => fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        }).pipe(
          Effect.flatMap((res) =>
            res.ok
              ? Effect.tryPromise({
                  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
                  try: () => res.json() as Promise<unknown>,
                  catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
                })
              : Effect.fail(new Error(`Meteora Data API HTTP ${res.status} for ${url}`)),
          ),
        ),
        { maxRetries: MAX_RETRIES },
      );

      return fetchJson.pipe(
        Effect.flatMap((json) => {
          const parsed = parseMeteoraPoolStats(json);
          return parsed === null
            ? Effect.fail(new Error(`Meteora Data API returned an invalid pool payload for ${url}`))
            : Effect.succeed(parsed);
        }),
        Effect.tap((stats) =>
          Effect.sync(() => {
            poolStatsCache.set(poolAddress, { stats, fetchedAt: Date.now() });
          }),
        ),
        Effect.catch((err) =>
          Effect.sync(() => {
            logger.warn("Meteora Data API unavailable — falling back to heuristic pool stats", {
              pool: poolAddress,
              error: String(err),
            });
            return null;
          }),
        ),
      );
    };

    const api: MeteoraDatapiApi = { getPoolData };
    return api;
  }),
);
