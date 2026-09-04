import { createLogger } from "./logger.js";

/**
 * GeckoTerminal OHLCV fetcher for fallen-angel mode (Wave 19).
 *
 * Supplies the deep-drawdown + volatility-baseline signals the pool_snapshots
 * table can't: the engine only keeps 14 days of per-cycle snapshots, but a
 * "fallen angel" is defined by a multi-week/multi-month drawdown from its
 * all-time high. GeckoTerminal's keyless public pool OHLCV endpoint gives a
 * long daily series (default 180 candles) from real on-chain data.
 *
 * Module-function design (clone of `gecko-terminal-service.ts` and
 * `token-risk-service.ts`): plain exported functions with an injectable
 * `fetchImpl`, NOT an Effect Context.Tag, so adding it does not ripple through
 * the test layers. All network failure paths return null (fail-open) — a
 * missing OHLCV means "drawdown unknown", which the caller treats as
 * "not a fallen angel" (fail-closed for the positive gate).
 *
 * LIVE-VERIFIED contract (2026-08-05):
 *   GET {base}/networks/solana/pools/{addr}/ohlcv/day?limit=N  (keyless)
 *   → { "data": { "attributes": { "ohlcv_list": [
 *        [ unixSeconds, open, high, low, close, volume ], …
 *      ] } } }
 *   Timestamps are UNIX SECONDS (not ms). volume is in the quote token.
 *   Unknown pool → HTTP 404 {"errors":[...]}. 429 → rate limited.
 */

const logger = createLogger("gecko-ohlcv");

const DEFAULT_BASE_URL = "https://api.geckoterminal.com/api/v2";
const REQUEST_TIMEOUT_MS = 10_000;
/** Default window of daily candles (raw limit, not a calendar span). */
export const DEFAULT_OHLCV_LIMIT = 180;
/**
 * How long a last-good OHLCV series is served without re-fetching (#154).
 * Daily candles move at most once a day, so 6h is a safe reuse window and it
 * slashes repeated fetches + failure warnings across discovery cycles.
 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** Exponential backoff for failing pools: base 5 min, cap 1 h. */
const BACKOFF_BASE_MS = 5 * 60 * 1000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;
/**
 * Max age of a cached/backoff entry before it is pruned (24h). Bounds the
 * in-process maps to ~a day of active pools so a long-lived process scanning
 * many/rotating pools does not grow memory without bound.
 */
const MAX_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Hard size cap on both maps as an absolute bound regardless of age. */
const MAX_CACHE_ENTRIES = 1000;
/** A single daily OHLCV bar. timestamps are unix seconds. */
export interface GeckoOhlcvBar {
  readonly timestampSec: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volumeQuote: number;
}

/** Derived fallen-angel signals from an OHLCV series. */
export interface GeckoOhlcvSignals {
  readonly bars: ReadonlyArray<GeckoOhlcvBar>;
  /** Highest `high` over the window (all-time high proxy). */
  readonly atlHigh: number;
  /** Latest `close` (current price proxy). */
  readonly latestClose: number;
  /** 1 - latestClose/atlHigh (0..1); 0 when no positive ATH. */
  readonly drawdownFromAth: number;
  /** Sample stddev of daily log-returns over the window (0 when <2 bars). */
  readonly dailyReturnStddev: number;
  /** Sum of quote volume over the window (0 when empty). */
  readonly totalVolumeQuote: number;
  /** Number of usable bars (excludes bars with non-positive close). */
  readonly barCount: number;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface RawOhlcvAttrs {
  readonly ohlcv_list: unknown;
}

interface RawOhlcvData {
  readonly attributes: RawOhlcvAttrs;
}

interface RawOhlcvResponse {
  readonly data: RawOhlcvData;
}

function isNonNullObject<T>(value: T): boolean {
  return value !== null && value instanceof Object && !(value instanceof Function);
}

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

/** Read the OHLCV attributes envelope, or null when the shape is off. */
function readOhlcvAttributes<T>(raw: T): RawOhlcvAttrs | null {
  if (!isNonNullObject(raw)) return null;
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  const data = (raw as RawOhlcvResponse).data;
  if (!isNonNullObject(data)) return null;
  const attrs = data.attributes;
  if (!isNonNullObject(attrs)) return null;
  return attrs;
}

/** Bundle the five required bar fields; null when any failed to decode. */
function readBarFields(
  timestampSec: number | null,
  open: number | null,
  high: number | null,
  low: number | null,
  close: number | null,
): readonly [number, number, number, number, number] | null {
  if (timestampSec === null || open === null || high === null || low === null || close === null)
    return null;
  return [timestampSec, open, high, low, close];
}

/** Parse one `ohlcv_list` row into a bar; null when malformed or dead. */
function parseOhlcvRow<T>(entry: T): GeckoOhlcvBar | null {
  if (!Array.isArray(entry) || entry.length < 5) return null;
  const fields = readBarFields(
    readFiniteNumber(entry[0]),
    readFiniteNumber(entry[1]),
    readFiniteNumber(entry[2]),
    readFiniteNumber(entry[3]),
    readFiniteNumber(entry[4]),
  );
  if (fields === null) return null;
  const [timestampSec, open, high, low, close] = fields;
  if (close <= 0) return null;
  return {
    timestampSec,
    open,
    high,
    low,
    close,
    volumeQuote: readFiniteNumber(entry[5]) ?? 0,
  };
}

/**
 * Parse a raw `ohlcv_list` into bars. Returns [] when the payload is not a
 * usable ohlcv_list (malformed, missing, or empty). Bars with a non-positive
 * close are dropped (dead/corrupt candle — a positive close is required to
 * compute log returns and drawdown).
 */
export function parseGeckoOhlcv<T>(raw: T): ReadonlyArray<GeckoOhlcvBar> {
  const attrs = readOhlcvAttributes(raw);
  if (attrs === null) return [];
  const list = attrs.ohlcv_list;
  if (!Array.isArray(list)) return [];

  const bars: GeckoOhlcvBar[] = [];
  for (const entry of list) {
    const bar = parseOhlcvRow(entry);
    if (bar === null) continue;
    bars.push(bar);
  }
  return bars;
}

/** Empty-signal shape for a bar-less window. */
function emptyOhlcvSignals(bars: ReadonlyArray<GeckoOhlcvBar>): GeckoOhlcvSignals {
  return {
    bars,
    atlHigh: 0,
    latestClose: 0,
    drawdownFromAth: 0,
    dailyReturnStddev: 0,
    totalVolumeQuote: 0,
    barCount: 0,
  };
}

/** Highest `high` across ascending bars. */
function findAthHigh(ascending: ReadonlyArray<GeckoOhlcvBar>): number {
  let atlHigh = 0;
  for (const bar of ascending) {
    if (bar.high > atlHigh) atlHigh = bar.high;
  }
  return atlHigh;
}

/** Summed quote volume across ascending bars. */
function sumQuoteVolume(ascending: ReadonlyArray<GeckoOhlcvBar>): number {
  let totalVolumeQuote = 0;
  for (const bar of ascending) totalVolumeQuote += bar.volumeQuote;
  return totalVolumeQuote;
}

/** Consecutive log returns over ascending closes (positive pairs only). */
function collectLogReturns(ascending: ReadonlyArray<GeckoOhlcvBar>): number[] {
  const logReturns: number[] = [];
  for (let i = 1; i < ascending.length; i++) {
    const prev = ascending[i - 1]!.close;
    const cur = ascending[i]!.close;
    if (prev > 0 && cur > 0) logReturns.push(Math.log(cur / prev));
  }
  return logReturns;
}

/** Sample stddev of log returns; 0 when fewer than two samples. */
function measureReturnStddev(logReturns: ReadonlyArray<number>): number {
  if (logReturns.length < 2) return 0;
  const mean = logReturns.reduce((s, v) => s + v, 0) / logReturns.length;
  const variance =
    logReturns.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (logReturns.length - 1);
  return Math.sqrt(variance);
}

/**
 * Derive fallen-angel signals from parsed bars.
 * - ATH = highest `high` across the (positive-close) window.
 * - drawdown = 1 - latestClose/ATH (0 when ATH <= 0).
 * - daily stddev = sample stddev of log(clos) consecutive differences.
 *   Skipped when < 2 bars (0).
 */
export function summarizeGeckoOhlcv(bars: ReadonlyArray<GeckoOhlcvBar>): GeckoOhlcvSignals {
  if (bars.length === 0) return emptyOhlcvSignals(bars);

  // GeckoTerminal returns OHLCV newest-FIRST (verified live). Normalize to
  // ascending timestamp so "latest" is always the last bar and consecutive
  // log-returns are computed in chronological order — otherwise drawdown
  // would be measured against the OLDEST close and daily stddev would flip
  // the sign of every return.
  const ascending = [...bars].sort((a, b) => a.timestampSec - b.timestampSec);

  const atlHigh = findAthHigh(ascending);
  const latestClose = ascending[ascending.length - 1]!.close;
  return {
    bars,
    atlHigh,
    latestClose,
    drawdownFromAth: atlHigh > 0 ? Math.max(0, 1 - latestClose / atlHigh) : 0,
    dailyReturnStddev: measureReturnStddev(collectLogReturns(ascending)),
    totalVolumeQuote: sumQuoteVolume(ascending),
    barCount: bars.length,
  };
}

/**
 * Last-good OHLCV per pool (issue #154): a transient GeckoTerminal outage
 * must not re-classify a pool that had data as "unknown".
 */
const lastGoodCache = new Map<
  string,
  { readonly signals: GeckoOhlcvSignals; readonly fetchedAt: number }
>();
/** Exponential backoff per failing pool so a dead endpoint is not re-hit every cycle. */
const backoff = new Map<string, { readonly nextAttemptAt: number; readonly failures: number }>();

/** Clear the in-process OHLCV cache + backoff state (test helper). */
export function resetGeckoOhlcvCache(): void {
  lastGoodCache.clear();
  backoff.clear();
}

/**
 * Opportunistic eviction (called on every fetch): drop entries older than
 * MAX_RETENTION_MS, then enforce the hard size cap via insertion-order
 * eviction so the maps stay bounded even under sustained pool rotation.
 */
function pruneOhlcvState(nowMs: number): void {
  for (const [pool, entry] of lastGoodCache) {
    if (nowMs - entry.fetchedAt > MAX_RETENTION_MS) lastGoodCache.delete(pool);
  }
  for (const [pool, entry] of backoff) {
    if (nowMs - entry.nextAttemptAt > MAX_RETENTION_MS) backoff.delete(pool);
  }
  while (lastGoodCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = lastGoodCache.keys().next().value;
    if (oldest === undefined) break;
    lastGoodCache.delete(oldest);
  }
  while (backoff.size >= MAX_CACHE_ENTRIES) {
    const oldest = backoff.keys().next().value;
    if (oldest === undefined) break;
    backoff.delete(oldest);
  }
}
/** Resolve an optional base-URL override (env, then default) to a clean endpoint. */
function resolveOhlcvBaseUrl(baseUrl: string | undefined, envUrl: string | undefined): string {
  const base = (baseUrl ?? envUrl ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  return base.length > 0 ? base : DEFAULT_BASE_URL;
}

/** Read a fresh last-good series, or null on miss/expiry. */
function readFreshOhlcvCache(
  poolAddress: string,
  ttlMs: number,
  nowMs: number,
): GeckoOhlcvSignals | null {
  const cached = lastGoodCache.get(poolAddress);
  if (cached !== undefined && nowMs - cached.fetchedAt < ttlMs) return cached.signals;
  return null;
}

/** Read any last-good series regardless of age (backoff/failure cover). */
function readOhlcvFallback(poolAddress: string): GeckoOhlcvSignals | null {
  return lastGoodCache.get(poolAddress)?.signals ?? null;
}

/** True when a failing pool is still inside its backoff window. */
function isOhlcvBackedOff(poolAddress: string, nowMs: number): boolean {
  const pending = backoff.get(poolAddress);
  return pending !== undefined && nowMs < pending.nextAttemptAt;
}

/** Enter/extend backoff, serving the last-good series when one exists. */
function recordOhlcvFailure(poolAddress: string, nowMs: number): GeckoOhlcvSignals | null {
  const failures = (backoff.get(poolAddress)?.failures ?? 0) + 1;
  backoff.set(poolAddress, {
    nextAttemptAt: nowMs + Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS),
    failures,
  });
  const cached = lastGoodCache.get(poolAddress);
  if (cached === undefined) return null;
  logger.debug("GeckoTerminal OHLCV fetch failed — reusing last-good series", {
    pool: poolAddress,
    ageMs: nowMs - cached.fetchedAt,
  });
  return cached.signals;
}

/** Fetch + decode one OHLCV page; null on any HTTP/parse/transport failure. */
async function fetchOhlcvBars(
  fetchImpl: FetchLike,
  url: string,
  timeoutMs: number,
  poolAddress: string,
): Promise<ReadonlyArray<GeckoOhlcvBar> | null> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      logger.warn("GeckoTerminal OHLCV request failed", { pool: poolAddress, status: res.status });
      return null;
    }
    const body: unknown = await res.json();
    const bars = parseGeckoOhlcv(body);
    if (bars.length === 0) {
      logger.warn("GeckoTerminal OHLCV returned no usable bars", { pool: poolAddress });
      return null;
    }
    return bars;
  } catch (err) {
    logger.warn("GeckoTerminal OHLCV fetch threw", {
      pool: poolAddress,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Fetch a daily OHLCV series for a pool. NEVER throws and NEVER crashes the
 * scan: 404/429/5xx, timeout, fetch failure, or parse failure all return null
 * so the caller treats the drawdown as unknown (fail-closed for the positive
 * gate).
 *
 * Resilience (#154):
 * - a fresh last-good series is served from cache (daily candles move ~1/day);
 * - a failing pool enters exponential backoff (5 min → 1 h) instead of being
 *   re-fetched + re-warned every cycle;
 * - during a failure or backoff window, the STALE last-good series is reused
 *   (debug) — only a pool with NO history is treated as unknown (warn).
 */
export async function getGeckoPoolOhlcv(
  poolAddress: string,
  options: {
    readonly limit?: number;
    readonly baseUrl?: string;
    readonly timeoutMs?: number;
    readonly cacheTtlMs?: number;
    readonly fetchImpl?: FetchLike;
  } = {},
): Promise<GeckoOhlcvSignals | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const limit = options.limit ?? DEFAULT_OHLCV_LIMIT;
  const effectiveBase = resolveOhlcvBaseUrl(options.baseUrl, process.env.GECKO_TERMINAL_API_URL);
  const url = `${effectiveBase}/networks/solana/pools/${poolAddress}/ohlcv/day?limit=${limit}`;
  const nowMs = Date.now();
  pruneOhlcvState(nowMs);

  const fresh = readFreshOhlcvCache(poolAddress, options.cacheTtlMs ?? CACHE_TTL_MS, nowMs);
  if (fresh !== null) return fresh;
  if (isOhlcvBackedOff(poolAddress, nowMs)) return readOhlcvFallback(poolAddress);

  const bars = await fetchOhlcvBars(fetchImpl, url, timeoutMs, poolAddress);
  if (bars === null) return recordOhlcvFailure(poolAddress, Date.now());
  const signals = summarizeGeckoOhlcv(bars);
  lastGoodCache.set(poolAddress, { signals, fetchedAt: Date.now() });
  backoff.delete(poolAddress);
  return signals;
}
