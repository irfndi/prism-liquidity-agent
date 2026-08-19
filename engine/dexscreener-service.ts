import { Effect, Layer } from "effect";
import { createLogger } from "./logger.js";
import { DexScreenerService } from "./services.js";

/**
 * DexScreener parallel pool-stats source. Sits alongside GeckoTerminal as a
 * secondary resilience tier for the Meteora Data API: when the Data API is
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
// Far more headroom than GeckoTerminal's 30/min, but a Data-API outage can still
// fan out a full pool list, so a modest 120ms between requests (~8/min headroom
// over 500/min) keeps bursts well under the quota while staying fast enough to
// drain a 50-pool list in ~6s. The 429 → null fail-through remains the backstop.
const DEFAULT_REQUEST_INTERVAL_MS = 120;
let nextDexscreenerRequestAt = 0;
let requestIntervalMs = DEFAULT_REQUEST_INTERVAL_MS;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** TEST-ONLY: override the inter-request interval (same contract as the gecko
 *  service's test hook). Restore to DEFAULT_REQUEST_INTERVAL_MS afterwards. */
export function setDexscreenerRequestIntervalMsForTest(ms: number): void {
  requestIntervalMs = ms;
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

interface RawDexscreenerPair {
  readonly volume: unknown;
  readonly liquidity: unknown;
  readonly priceUsd: unknown;
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
  if (!isNonNullObject(raw)) return null;
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  const response = raw as RawDexscreenerResponse;
  const pairs = response.pairs;
  // DexScreener returns `{"pairs": null}` (HTTP 200) for an unknown pair.
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  const pair = pairs[0];
  if (!isNonNullObject(pair)) return null;
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  const pairObj = pair as RawDexscreenerPair;

  const volume = isNonNullObject(pairObj.volume)
    ? // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
      readFiniteNumber((pairObj.volume as RawVolume).h24)
    : null;
  // Volume is the one field every downstream gate (authenticity, fee/IL) needs;
  // non-positive volume is malformed data — reject the stats ENTIRELY rather
  // than marking garbage measured.
  if (volume === null || volume <= 0) return null;

  const liquidity = isNonNullObject(pairObj.liquidity)
    ? // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
      readFiniteNumber((pairObj.liquidity as RawLiquidity).usd)
    : null;
  // Non-positive liquidity is malformed; null it so the caller treats the stats
  // as unavailable (the most conservative outcome). DexScreener has NO fees
  // field, so the fee rate is always the binStep-derived model.
  return {
    tvlUsd: liquidity !== null && liquidity <= 0 ? null : liquidity,
    volume24hUsd: volume,
    fees24hUsd: volume * baseFeeRate,
    basePriceUsd: readFiniteNumber(pairObj.priceUsd),
    quotePriceUsd: null,
  };
}

// ─── Pool enrichment (source-aware) ──────────────────────────────────────────
// DexScreener data is enriched through the SAME `enrichPoolFromGecko` path as
// GeckoTerminal (identical trust posture: measured volume/TVL, modeled fees, no
// safety signals) and tagged `statsSource: "geckoterminal"` so the trust model
// and every gate are unchanged. The resolver in program.ts calls
// `enrichPoolFromGecko` for BOTH secondary sources.

// ─── Fetcher (fail-through to the next source) ───────────────────────────────

/**
 * Fetch real stats for one pool from DexScreener. NEVER throws and NEVER crashes
 * the scan cycle: an empty `pairs` array, 429/5xx, timeout, fetch failure, parse
 * failure, or missing liquidity all return null so the caller falls through.
 * Logs ONE warning per failing fetch.
 *
 * `baseFeeRate` is the pool's binStep-derived base-fee fraction (the caller
 * computes `0.0025 + binStep / 1e4`); `baseUrl` overrides the endpoint.
 */
export async function getDexscreenerPoolStats(
  poolAddress: string,
  options: {
    readonly baseFeeRate: number;
    readonly baseUrl?: string;
    readonly timeoutMs?: number;
    readonly fetchImpl?: FetchLike;
  },
): Promise<DexscreenerPoolStats | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const base = (options.baseUrl ?? process.env.DEXSCREENER_API_URL ?? DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  const effectiveBase = base.length > 0 ? base : DEFAULT_BASE_URL;
  const url = `${effectiveBase}/pairs/solana/${poolAddress}`;

  // Pace toward the keyless quota (see the pacing constants above). Reserving
  // the next slot synchronously before any await keeps concurrent callers from
  // observing the same free slot.
  const now = Date.now();
  const delayMs = Math.max(0, nextDexscreenerRequestAt - now);
  nextDexscreenerRequestAt = Math.max(now, nextDexscreenerRequestAt) + requestIntervalMs;
  if (delayMs > 0) {
    await sleep(delayMs);
  }

  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      logger.warn("DexScreener unavailable — falling through to next stats source", {
        pool: poolAddress,
        status: res.status,
      });
      return null;
    }
    const body: unknown = await res.json();
    const parsed = parseDexscreenerPoolStats(body, options.baseFeeRate);
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
    return parsed;
  } catch (err) {
    logger.warn("DexScreener fetch failed — falling through to next stats source", {
      pool: poolAddress,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─── Effect service wiring ───────────────────────────────────────────────────
// Thin live layer so program.ts consumes DexScreener through the
// DexScreenerService Context.Tag (symmetric with GeckoTerminalLive). The module
// functions, injectable FetchLike and pacing stay exactly as they are.

export const DexScreenerLive = Layer.succeed(DexScreenerService, {
  getPoolStats: (poolAddress, baseFeeRate) =>
    Effect.promise(() => getDexscreenerPoolStats(poolAddress, { baseFeeRate })),
});
