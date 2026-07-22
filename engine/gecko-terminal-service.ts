import { createLogger } from "./logger.js";
import type { PoolState } from "./types.js";

/**
 * GeckoTerminal secondary pool-stats source. Sits between the Meteora Data API
 * (primary, datapi-exclusive safety signals) and the adapter's fabricated
 * heuristic (last resort). When the Data API is unreachable, GeckoTerminal's
 * keyless public API (30 req/min) supplies REAL 24h volume and reserve TVL so
 * volume-authenticity, TVL gates and the fee/IL ratio are computed from
 * measured data instead of `tvlUsd × modeled turnover`.
 *
 * Deliberately a module-function design (clone of `token-risk-service.ts`):
 * plain exported functions with an injectable `fetchImpl`, NOT an Effect
 * Context.Tag service, so adding it does not ripple through the ~14 test layers
 * a new required service would touch. program.ts consumes it via
 * `Effect.promise`, exactly like `consultTokenRisks`.
 *
 * LIVE-VERIFIED contract (2026-07-22, 5 pools across meteora/orca/raydium-clmm/
 * pancakeswap-v3-solana + raydium-v4 CPMM):
 *   - `data.attributes.volume_usd.h24`  → real 24h volume as a numeric STRING.
 *   - `data.attributes.reserve_in_usd`  → real reserve TVL as a numeric STRING.
 *   - `data.attributes.pool_fee_percentage` → **null for EVERY pool tested.**
 *     GeckoTerminal does not expose a usable fee rate for concentrated-liquidity
 *     pools (their fees are dynamic per bin). The field name is
 *     `pool_fee_percentage` (NOT `fee_percentage`); do NOT rediscover the API.
 *   - Unknown pool → HTTP 404 `{"errors":[{"status":"404","title":"Not Found"}]}`.
 *
 * Because `pool_fee_percentage` is null for the pools Prism watches, fees are
 * derived as `realVolume24h × baseFeeRate`, where the caller passes the pool's
 * binStep-derived base-fee rate (`0.0025 + binStep/1e4`, same model the adapter
 * uses) — applied to REAL volume, so it is materially better than the heuristic
 * (which applies the rate to FABRICATED volume), and is honestly tagged
 * `statsSource: "geckoterminal"` rather than `datapi`. When GeckoTerminal does
 * populate `pool_fee_percentage` (a percentage, e.g. 0.25 = 0.25%) it takes
 * precedence. Data-API-exclusive safety signals (blacklist/freeze/verification/
 * farm) are NEVER sourced from here — they stay null and the safety screener's
 * fail-open handling of null is unaffected.
 */

const logger = createLogger("gecko-terminal");

const DEFAULT_BASE_URL = "https://api.geckoterminal.com/api/v2";
const REQUEST_TIMEOUT_MS = 10_000;

// ─── Request pacing (30 req/min keyless endpoint) ────────────────────────────
// Discovery can fan out ~50 pools per cycle; if the Data API is down mid-scan
// every one of them falls through to GeckoTerminal, whose keyless tier allows
// 30 req/min. At ≥2.1s between requests (28/min) a full 50-pool list drains over
// ~2 minutes instead of exhausting the quota mid-list — the 429 → null
// fail-through in getGeckoPoolStats remains the backstop for bursts pacing
// cannot absorb.

const DEFAULT_REQUEST_INTERVAL_MS = 2_100;
let lastGeckoRequestAt = 0;
let requestIntervalMs = DEFAULT_REQUEST_INTERVAL_MS;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** TEST-ONLY: override the minimum inter-request interval (call with 0 to
 *  disable pacing in fast unit tests, or a small value for the pacing test).
 *  Restore to DEFAULT_REQUEST_INTERVAL_MS afterwards; production never calls
 *  this and keeps the 2.1s interval. */
export function setGeckoRequestIntervalMsForTest(ms: number): void {
  requestIntervalMs = ms;
}

/**
 * The `fetch` call surface the module needs. A bare call signature rather than
 * the runtime's full `typeof fetch`, so the global `fetch` and a plain injected
 * fake are both assignable without casts.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Real pool stats resolved from GeckoTerminal. `tvlUsd` is null when the pool
 *  has no usable reserve — the caller treats that as "unavailable" and falls
 *  through to the next source rather than enriching with garbage. */
export interface GeckoPoolStats {
  readonly tvlUsd: number | null;
  readonly volume24hUsd: number;
  readonly fees24hUsd: number;
  readonly basePriceUsd: number | null;
  readonly quotePriceUsd: number | null;
}

// ─── Response parsing (live-verified semantics) ──────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Parse a numeric STRING or number into a finite number, else null. GeckoTerminal
 *  returns numeric fields as decimal strings ("23551730.42"). */
function readFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * GeckoTerminal's `pool_fee_percentage` is a PERCENTAGE (e.g. 0.25 = 0.25%), so
 * the decimal fraction is value/100. Null for every concentrated-liquidity pool
 * tested (verified live 2026-07-22) — the binStep-derived baseFeeRate is the
 * operative path; this only ever runs if GeckoTerminal starts populating it.
 */
function parseFeePercentageFraction(value: unknown): number | null {
  const num = readFiniteNumber(value);
  if (num === null || num < 0) return null;
  return num / 100;
}

/**
 * Parse one `GET /networks/solana/pools/{address}` response. Returns null when
 * the payload is not a usable pool object or 24h volume cannot be read (the one
 * field every downstream gate needs). `tvlUsd` is null (not a failure) when the
 * reserve is missing — the caller decides whether to treat that as unavailable.
 *
 * `baseFeeRate` is the pool's binStep-derived base-fee fraction used to price
 * real volume into fees when `pool_fee_percentage` is null (always, for DLMM).
 */
export function parseGeckoPoolStats(raw: unknown, baseFeeRate: number): GeckoPoolStats | null {
  if (!isObject(raw)) return null;
  const data = raw["data"];
  if (!isObject(data)) return null;
  const attrs = data["attributes"];
  if (!isObject(attrs)) return null;

  const volumeUsd = attrs["volume_usd"];
  const volume24hUsd = isObject(volumeUsd) ? readFiniteNumber(volumeUsd["h24"]) : null;
  // Volume is the one field every downstream gate (authenticity, fee/IL) needs;
  // non-positive volume is malformed data (a live pool never reports ≤0 24h
  // volume) — reject the stats ENTIRELY rather than marking garbage measured.
  if (volume24hUsd === null || volume24hUsd <= 0) return null;

  const feePercentage = parseFeePercentageFraction(attrs["pool_fee_percentage"]);
  const effectiveFeeRate = feePercentage ?? baseFeeRate;

  // Negative reserves are equally malformed; null them so the caller treats the
  // stats as unavailable (getGeckoPoolStats → null → heuristic + unknown flags,
  // the most conservative outcome).
  const reserveUsd = readFiniteNumber(attrs["reserve_in_usd"]);

  return {
    tvlUsd: reserveUsd !== null && reserveUsd < 0 ? null : reserveUsd,
    volume24hUsd,
    fees24hUsd: volume24hUsd * effectiveFeeRate,
    basePriceUsd: readFiniteNumber(attrs["base_token_price_usd"]),
    quotePriceUsd: readFiniteNumber(attrs["quote_token_price_usd"]),
  };
}

// ─── Pool enrichment (source-aware) ──────────────────────────────────────────

/**
 * Replace heuristic tvl/volume/fees with real GeckoTerminal values. Mirrors
 * `enrichPoolWithDatapi` but tags `statsSource: "geckoterminal"` and leaves the
 * Data-API-exclusive signals (farm, verification, freeze) null — gecko never
 * sources safety data. APR is recomputed into the engine's annualized-percent
 * convention from the real fees/TVL. `stats.tvlUsd` is non-null on this path
 * (`getGeckoPoolStats` returns null when the reserve is missing).
 */
export function enrichPoolFromGecko(pool: PoolState, stats: GeckoPoolStats): PoolState {
  const tvlUsd = stats.tvlUsd;
  const aprAnnualizedPct =
    tvlUsd !== null && tvlUsd > 0 && stats.fees24hUsd > 0
      ? ((stats.fees24hUsd * 365) / tvlUsd) * 100
      : pool.apr;
  return {
    ...pool,
    tvlUsd: tvlUsd !== null && tvlUsd > 0 ? tvlUsd : pool.tvlUsd,
    volume24hUsd: stats.volume24hUsd,
    fees24hUsd: stats.fees24hUsd,
    apr: aprAnnualizedPct,
    hasFarm: null,
    farmAprPct: null,
    statsSource: "geckoterminal",
  };
}

// ─── Fetcher (fail-through to the next source) ───────────────────────────────

/**
 * Fetch real stats for one pool from GeckoTerminal. NEVER throws and NEVER
 * crashes the scan cycle: 404/429/5xx, timeout, fetch failure, parse failure, or
 * a missing reserve all return null so the caller falls through to the heuristic
 * (the safety net for total API outage). Logs ONE warning per failing fetch.
 *
 * `baseFeeRate` is the pool's binStep-derived base-fee fraction (the caller
 * computes `0.0025 + binStep / 1e4`); `baseUrl` overrides the endpoint
 * (env `GECKO_TERMINAL_API_URL` already resolved by the caller, else default).
 */
export async function getGeckoPoolStats(
  poolAddress: string,
  options: {
    readonly baseFeeRate: number;
    readonly baseUrl?: string;
    readonly timeoutMs?: number;
    readonly fetchImpl?: FetchLike;
  },
): Promise<GeckoPoolStats | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const base = (options.baseUrl ?? process.env.GECKO_TERMINAL_API_URL ?? DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  const effectiveBase = base.length > 0 ? base : DEFAULT_BASE_URL;
  const url = `${effectiveBase}/networks/solana/pools/${poolAddress}`;

  // Pace toward the 30 req/min keyless limit (see the pacing constants above).
  const now = Date.now();
  const nextAllowedAt = lastGeckoRequestAt + requestIntervalMs;
  if (nextAllowedAt > now) {
    await sleep(nextAllowedAt - now);
  }
  lastGeckoRequestAt = Date.now();

  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      logger.warn("GeckoTerminal unavailable — falling through to next stats source", {
        pool: poolAddress,
        status: res.status,
      });
      return null;
    }
    const body: unknown = await res.json();
    const parsed = parseGeckoPoolStats(body, options.baseFeeRate);
    if (parsed === null) {
      logger.warn("GeckoTerminal returned an unparseable pool payload", { pool: poolAddress });
      return null;
    }
    // A usable reserve is required to enrich TVL; without it the stats are too
    // partial to trust (volume alone mis-sizes TVL gates) — treat as unavailable.
    if (parsed.tvlUsd === null) {
      logger.warn("GeckoTerminal pool has no reserve — treating stats as unavailable", {
        pool: poolAddress,
      });
      return null;
    }
    return parsed;
  } catch (err) {
    logger.warn("GeckoTerminal fetch failed — falling through to next stats source", {
      pool: poolAddress,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
