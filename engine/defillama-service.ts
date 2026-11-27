import { createLogger } from "./logger.js";
import { BoundedTtlCache, PublicProviderBreaker, RequestPacer } from "./public-data-client.js";
import type { JsonValue } from "./services.js";

const logger = createLogger("defillama-coins");

const DEFAULT_BASE_URL = "https://coins.llama.fi";
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_INTERVAL_MS = 1_000;
const CACHE_TTL_MS = 60_000;
const MAX_PRICE_AGE_MS = 10 * 60_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MIN_PRICE_CONFIDENCE = 0.9;
const MINTS_PER_REQUEST = 50;
const MAX_CACHE_ENTRIES = 1_000;

export type DefillamaFetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface DefillamaCoinData {
  readonly priceUsd: number | null;
  readonly decimals: number | null;
  readonly symbol: string | null;
  readonly timestamp: number | null;
  readonly confidence: number | null;
}

interface UnknownRecord {
  readonly [key: string]: JsonValue;
}

const coinCache = new BoundedTtlCache<DefillamaCoinData>(MAX_CACHE_ENTRIES);
const coinRequestCache = new BoundedTtlCache<ReadonlyMap<string, DefillamaCoinData>>(128);
const requestPacer = new RequestPacer(DEFAULT_REQUEST_INTERVAL_MS);
const providerBreaker = new PublicProviderBreaker(3, 60_000);

export function setDefillamaRequestIntervalMsForTest(ms: number): void {
  requestPacer.intervalMs = ms;
  requestPacer.reset();
}

export function clearDefillamaCoinCacheForTest(): void {
  coinCache.clear();
  coinRequestCache.clear();
  providerBreaker.reset();
  requestPacer.reset();
}

function isRecord<T>(value: T): value is UnknownRecord & T {
  return value !== null && Object.prototype.toString.call(value) === "[object Object]";
}

function readFiniteNumber<T>(value: T): number | null {
  if (Object.prototype.toString.call(value) !== "[object Number]") return null;
  // SAFETY: The preceding runtime branch establishes the asserted primitive type.
  const number = value as number;
  return Number.isFinite(number) ? number : null;
}

function readPositiveNumber<T>(value: T): number | null {
  const number = readFiniteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function readString<T>(value: T): string | null {
  if (Object.prototype.toString.call(value) !== "[object String]") return null;
  // SAFETY: The preceding runtime branch establishes the asserted primitive type.
  const text = (value as string).trim();
  return text.length > 0 ? text : null;
}

function readDecimals<T>(value: T): number | null {
  const decimals = readFiniteNumber(value);
  return decimals !== null && Number.isInteger(decimals) && decimals >= 0 && decimals <= 255
    ? decimals
    : null;
}

function readTimestampMs<T>(value: T): number | null {
  const timestamp = readFiniteNumber(value);
  if (timestamp === null || timestamp <= 0) return null;
  return timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1_000;
}

function trustedPrice(
  price: number | null,
  timestamp: number | null,
  confidence: number | null,
  nowMs: number,
): number | null {
  if (price === null || timestamp === null || confidence === null) return null;
  const fresh = nowMs - timestamp <= MAX_PRICE_AGE_MS && timestamp - nowMs <= MAX_CLOCK_SKEW_MS;
  return fresh && confidence >= MIN_PRICE_CONFIDENCE ? price : null;
}

function parseCoinData<T>(raw: T, nowMs: number): DefillamaCoinData | null {
  if (!isRecord(raw)) return null;
  const timestamp = readTimestampMs(raw["timestamp"]);
  const data: DefillamaCoinData = {
    priceUsd: trustedPrice(
      readPositiveNumber(raw["price"]),
      timestamp,
      readFiniteNumber(raw["confidence"]),
      nowMs,
    ),
    decimals: readDecimals(raw["decimals"]),
    symbol: readString(raw["symbol"]),
    timestamp,
    confidence: readFiniteNumber(raw["confidence"]),
  };
  if (data.priceUsd === null && data.decimals === null && data.symbol === null) return null;
  return data;
}

export function parseDefillamaCoinData<T>(
  raw: T,
  requestedMints: ReadonlyArray<string>,
  nowMs: number = Date.now(),
): ReadonlyMap<string, DefillamaCoinData> {
  const result = new Map<string, DefillamaCoinData>();
  if (!isRecord(raw) || !isRecord(raw["coins"])) return result;
  const coins = raw["coins"];
  for (const mint of new Set(requestedMints)) {
    const parsed = parseCoinData(coins[`solana:${mint}`], nowMs);
    if (parsed !== null) result.set(mint, parsed);
  }
  return result;
}

function resolveBaseUrl(configured: string | undefined): string {
  const base = (configured ?? process.env.DEFILLAMA_COINS_API_URL ?? DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  return base.length > 0 ? base : DEFAULT_BASE_URL;
}

async function fetchDefillamaChunk(
  chunk: ReadonlyArray<string>,
  options: {
    readonly baseUrl: string;
    readonly timeoutMs: number;
    readonly fetchImpl: DefillamaFetchLike;
  },
): Promise<ReadonlyMap<string, DefillamaCoinData>> {
  if (!providerBreaker.canTry()) return new Map();
  await requestPacer.wait();
  const path = chunk.map((mint) => `solana:${encodeURIComponent(mint)}`).join(",");
  try {
    const response = await options.fetchImpl(`${options.baseUrl}/prices/current/${path}`, {
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      providerBreaker.recordFailure();
      logger.warn("DefiLlama coin prices unavailable", { status: response.status });
      return new Map();
    }
    // SAFETY: response.json() is parsed by parseDefillamaCoinData before domain use.
    const body = (await response.json()) as JsonValue;
    const parsed = parseDefillamaCoinData(body, chunk);
    providerBreaker.recordSuccess();
    return parsed;
  } catch (error) {
    providerBreaker.recordFailure();
    logger.warn("DefiLlama coin price fetch failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
}

export async function fetchDefillamaCoins(
  mints: ReadonlyArray<string>,
  options: {
    readonly baseUrl?: string;
    readonly timeoutMs?: number;
    readonly fetchImpl?: DefillamaFetchLike;
  } = {},
): Promise<ReadonlyMap<string, DefillamaCoinData>> {
  const uniqueMints = [...new Set(mints)];
  const nowMs = Date.now();
  const result = new Map<string, DefillamaCoinData>();
  const missing: string[] = [];
  for (const mint of uniqueMints) {
    const cached = coinCache.get(mint, nowMs);
    if (cached !== undefined) {
      result.set(mint, cached);
    } else {
      missing.push(mint);
    }
  }
  if (missing.length === 0 || !providerBreaker.canTry(nowMs)) return result;

  const request = {
    baseUrl: resolveBaseUrl(options.baseUrl),
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    fetchImpl: options.fetchImpl ?? fetch,
  };
  for (let start = 0; start < missing.length; start += MINTS_PER_REQUEST) {
    const chunk = missing.slice(start, start + MINTS_PER_REQUEST);
    const requestKey = `${request.baseUrl}|${chunk.map((mint) => `solana:${mint}`).join(",")}`;
    const parsed = await coinRequestCache.getOrFetch(requestKey, 5_000, () =>
      fetchDefillamaChunk(chunk, request),
    );
    for (const [mint, data] of parsed) {
      coinCache.set(mint, data, CACHE_TTL_MS);
      result.set(mint, data);
    }
  }
  return result;
}
