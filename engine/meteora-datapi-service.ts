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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNumber(obj: Record<string, unknown>, key: string): number | null {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(obj: Record<string, unknown>, key: string): boolean | null {
  const value = obj[key];
  return typeof value === "boolean" ? value : null;
}

function readWindow(obj: Record<string, unknown>, key: string, window: string): number | null {
  const nested = obj[key];
  if (!isObject(nested)) return null;
  return readNumber(nested, window);
}

/**
 * Parse one pool object from the Data API. Returns null when required numeric
 * fields are missing (likely an upstream schema change) so the caller falls
 * back to heuristic metrics instead of consuming garbage.
 */
export function parseMeteoraPoolStats(raw: unknown): MeteoraPoolStats | null {
  if (!isObject(raw)) return null;
  const address = raw["address"];
  const tvl = readNumber(raw, "tvl");
  const volume24h = readWindow(raw, "volume", "24h");
  const fees24h = readWindow(raw, "fees", "24h");
  const apr = readNumber(raw, "apr");
  if (typeof address !== "string" || address.length === 0) return null;
  if (tvl === null || volume24h === null || fees24h === null || apr === null) return null;

  const tokenX = isObject(raw["token_x"]) ? raw["token_x"] : {};
  const tokenY = isObject(raw["token_y"]) ? raw["token_y"] : {};
  const poolConfig = isObject(raw["pool_config"]) ? raw["pool_config"] : {};

  return {
    address,
    name: typeof raw["name"] === "string" ? raw["name"] : "",
    tvlUsd: tvl,
    volume24hUsd: volume24h,
    fees24hUsd: fees24h,
    apr,
    apy: readNumber(raw, "apy") ?? 0,
    currentPrice: readNumber(raw, "current_price") ?? 0,
    feeTvlRatio24h: readWindow(raw, "fee_tvl_ratio", "24h"),
    feeTvlRatio12h: readWindow(raw, "fee_tvl_ratio", "12h"),
    feeTvlRatio1h: readWindow(raw, "fee_tvl_ratio", "1h"),
    dynamicFeePct: readNumber(raw, "dynamic_fee_pct"),
    baseFeePct: readNumber(poolConfig, "base_fee_pct"),
    hasFarm: readBoolean(raw, "has_farm"),
    farmApr: readNumber(raw, "farm_apr"),
    farmApy: readNumber(raw, "farm_apy"),
    isBlacklisted: readBoolean(raw, "is_blacklisted"),
    tokenXFreezeAuthorityDisabled: readBoolean(tokenX, "freeze_authority_disabled"),
    tokenYFreezeAuthorityDisabled: readBoolean(tokenY, "freeze_authority_disabled"),
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

    const getPoolData = (poolAddress: string): Effect.Effect<MeteoraPoolStats | null, never> => {
      const url = `${baseUrl}/pools/${poolAddress}`;
      const fetchJson = retryEffectWithBackoff(
        Effect.tryPromise({
          try: () => fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
          catch: (cause) => cause,
        }).pipe(
          Effect.flatMap((res) =>
            res.ok
              ? Effect.tryPromise({
                  try: () => res.json() as Promise<unknown>,
                  catch: (cause) => cause,
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
        Effect.catchAll((err) =>
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
