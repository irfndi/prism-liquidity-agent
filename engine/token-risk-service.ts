import { createLogger } from "./logger.js";
import { jupiterFetch } from "./jupiter-client.js";
import { consultGoPlusTokenSecurity, goPlusHardRiskReasons } from "./goplus-token-security.js";

/**
 * Token-risk overlay (Wave 18): smart freeze-authority / scam detection that
 * lets Prism admit verified freeze-authority tokens (USDC-class) WITHOUT a
 * manually-curated allowlist. Deliberately a module-function design (clone of
 * `depeg-liquidity-detector.ts`): plain exported functions with an injectable
 * `fetchImpl`, NOT an Effect Context.Tag service, so adding it does not ripple
 * through the ~14 test layers a new required service would touch.
 *
 * The overlay is ADVISORY, never authoritative on its own: it corroborates the
 * existing Data API `is_blacklisted`/`freeze_authority_disabled` + on-chain
 * authority + blacklist pipeline. The only hard rejection it can drive is
 * Jupiter's aggregated `isSus` (RugCheck + Blockaid) flag, and only for mints
 * the allowlist did NOT already exempt. Everything is fail-open: unknown mints,
 * fetch failures and a disabled switch leave decisions unchanged.
 *
 * Contracts are live-verified (2026-07-21); see the stablecoin-allowlist
 * notepad R1 section — do NOT rediscover the API.
 */

const logger = createLogger("token-risk");

const JUPITER_TOKENS_SEARCH_BASE_URL = "https://api.jup.ag/tokens/v2/search";
const MAX_MINTS_PER_REQUEST = 100;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CACHE_TTL_MIN = 30;

/**
 * The `fetch` call surface the module needs. A bare call signature rather than
 * Bun's full `typeof fetch` (which also carries a `preconnect` member), so the
 * global `fetch` and a plain injected fake are both assignable without casts.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Optional fetch options built without ever assigning `undefined` (exactOptionalPropertyTypes). */
export interface FetchTokenRisksOptions {
  apiKey?: string;
  fetchImpl?: FetchLike;
}

export interface TokenRiskSignal {
  readonly isVerified: boolean | null;
  readonly organicScore: number | null;
  readonly organicScoreLabel: "high" | "medium" | "low" | null;
  /** Jupiter's aggregated rug/scam flag. PRESENCE-ONLY upstream: a token with
   *  no `audit.isSus` is NOT proven safe — this reads `audit?.isSus === true`. */
  readonly isSus: boolean;
  /** Top-level freeze-authority address present ⇒ authority ENABLED (risky). */
  readonly freezeAuthorityPresent: boolean;
  /** Top-level mint-authority address present ⇒ authority ENABLED (risky). */
  readonly mintAuthorityPresent: boolean;
  /** GoPlus contract-level hard-risk reason (Wave 20). null = clean/unknown.
   *  A non-null value is a hard-reject reason independent of the Jupiter flags. */
  readonly goPlusHardRisk: string | null;
}

/** The optional fields the overlay consults; the engine's `AppConfig`
 *  satisfies this structurally without coupling the module to the full config. */
export interface TokenRiskConfigLike {
  readonly jupiterTokenRiskEnabled?: boolean;
  readonly jupiterTokenRiskCacheTtlMin?: number;
  readonly goPlusApiKey?: string;
  readonly goPlusApiSecret?: string;
  readonly goPlusTokenRiskEnabled?: boolean;
  readonly goPlusTokenRiskCacheTtlMin?: number;
}

// ─── Response parsing (live-verified semantics) ──────────────────────────────

interface RawAudit {
  readonly isSus: unknown;
}

interface RawTokenRiskEntry {
  readonly address: unknown;
  readonly id: unknown;
  readonly isVerified: unknown;
  readonly organicScore: unknown;
  readonly organicScoreLabel: unknown;
  readonly audit: unknown;
  readonly freezeAuthority: unknown;
  readonly mintAuthority: unknown;
}

function isNonNullObject<T>(value: T): boolean {
  return value !== null && value instanceof Object && !(value instanceof Function);
}

function readString<T>(value: T): string | null {
  // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
  return Object.prototype.toString.call(value) === "[object String]" ? (value as string) : null;
}

function readBoolean<T>(value: T): boolean | null {
  // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
  return Object.prototype.toString.call(value) === "[object Boolean]" ? (value as boolean) : null;
}

function readFiniteNumber<T>(value: T): number | null {
  // SAFETY: The enclosing statement has validated or constructed the asserted contract before this value is consumed.
  return Object.prototype.toString.call(value) === "[object Number]" &&
    // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
    Number.isFinite(value as number)
    ? // SAFETY: The runtime guard or typed fixture immediately above this assertion establishes the required invariant.
      // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
      (value as number)
    : null;
}

function readMint<T>(value: T): string | null {
  const s = readString(value);
  return s !== null && s.length > 0 ? s : null;
}

export interface ParsedTokenRiskEntry {
  readonly mint: string;
  readonly signal: TokenRiskSignal;
}

/**
 * Parse one entry of the Tokens V2 search ARRAY. Returns null when the entry
 * carries no usable address (schema drift) so it is simply skipped — mints
 * absent from the response stay unknown to the caller (no fabricated entry).
 */
export function parseTokenRiskEntry<T>(raw: T): ParsedTokenRiskEntry | null {
  if (!isNonNullObject(raw)) return null;
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  const entry = raw as RawTokenRiskEntry;
  // The response keys an entry by the token address; live payloads have also
  // carried `id`. Accept either, never guess.
  const mint = readMint(entry.address) ?? readMint(entry.id);
  if (mint === null) return null;
  const audit = entry.audit;
  const score = entry.organicScore;
  const label = entry.organicScoreLabel;
  return {
    mint,
    signal: {
      isVerified: readBoolean(entry.isVerified),
      organicScore: readFiniteNumber(score),
      organicScoreLabel: label === "high" || label === "medium" || label === "low" ? label : null,
      // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
      isSus: isNonNullObject(audit) && (audit as RawAudit).isSus === true,
      freezeAuthorityPresent: readMint(entry.freezeAuthority) !== null,
      mintAuthorityPresent: readMint(entry.mintAuthority) !== null,
      goPlusHardRisk: null,
    },
  };
}

// ─── Fetcher ─────────────────────────────────────────────────────────────────

/** ONLY send the key when a non-empty value is configured — an empty
 *  `x-api-key` header can be treated as an invalid key and 401; its absence
 *  is the supported keyless path. */
function tokenRiskHeaders(apiKey: string | undefined) {
  const headers: Record<string, string> = {};
  if (apiKey !== undefined && apiKey.length > 0) {
    headers["x-api-key"] = apiKey;
  }
  return headers;
}

/** Fetch one mint chunk and store its entries into `result`. A 200 with a
 *  non-array body (a CDN/intermediary error object or HTML) is a FAILURE,
 *  not an empty success: treating it as success would negative-cache every
 *  requested mint — dropping cached isSus flags and silently stopping
 *  hard-reject enforcement for the whole TTL. Throwing routes the entire
 *  consult into the fail-open catch instead, which serves stale signals and
 *  never negative-caches. */
async function fetchTokenRiskChunk(
  fetchImpl: FetchLike,
  chunk: ReadonlyArray<string>,
  headers: Record<string, string>,
  timeoutMs: number,
  result: Map<string, TokenRiskSignal>,
): Promise<void> {
  const query = chunk.map((mint) => encodeURIComponent(mint)).join(",");
  const url = `${JUPITER_TOKENS_SEARCH_BASE_URL}?query=${query}`;
  const res = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Jupiter tokens API HTTP ${res.status}`);
  }
  const body: unknown = await res.json();
  if (!Array.isArray(body)) {
    throw new Error(`Jupiter tokens API returned a non-array body (${res.status})`);
  }
  for (const entry of body) {
    const parsed = parseTokenRiskEntry(entry);
    if (parsed !== null) result.set(parsed.mint, parsed.signal);
  }
}

export async function fetchTokenRisks(
  mints: ReadonlyArray<string>,
  options: {
    readonly apiKey?: string;
    readonly timeoutMs?: number;
    readonly fetchImpl?: FetchLike;
  } = {},
): Promise<Map<string, TokenRiskSignal>> {
  // The default fetch routes through the process-wide Jupiter traffic gate
  // (pacing + 429 breaker — the tokens API shares the same keyless
  // rate-limit bucket as quote/swap/price). Injected fakes (tests) bypass
  // the gate.
  const fetchImpl =
    options.fetchImpl ??
    ((url: string | URL | Request, init?: RequestInit) => jupiterFetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers = tokenRiskHeaders(options.apiKey);

  const result = new Map<string, TokenRiskSignal>();
  for (let start = 0; start < mints.length; start += MAX_MINTS_PER_REQUEST) {
    const chunk = mints.slice(start, start + MAX_MINTS_PER_REQUEST);
    await fetchTokenRiskChunk(fetchImpl, chunk, headers, timeoutMs, result);
  }
  return result;
}

// ─── Consult (TTL cache + fail-open) ─────────────────────────────────────────

interface CacheEntry {
  readonly signal: TokenRiskSignal;
  readonly fetchedAt: number;
}

/**
 * Negative-cache marker: a SUCCESSFUL refresh that OMITS a mint (verification
 * revoked, token delisted, or never listed) is recorded with this all-null/false
 * signal and a fresh timestamp. It exists purely to stop the per-cycle re-query
 * spam — fresh negative entries are NOT served in the result, so a revoked
 * verification stops exempting the pool. Detected by reference equality (real
 * signals are always freshly-parsed objects, never this shared const).
 */
const UNKNOWN_TOKEN_RISK_SIGNAL: TokenRiskSignal = {
  isVerified: null,
  organicScore: null,
  organicScoreLabel: null,
  isSus: false,
  freezeAuthorityPresent: false,
  mintAuthorityPresent: false,
  goPlusHardRisk: null,
};

// Mint-global cache: a token's safety signals are not pool-specific, so the key
// is the mint address alone. Fresh entries are served without any network call.
const cache = new Map<string, CacheEntry>();

/** Hard cap on cached token entries; the oldest (insertion-order) entries are
 *  evicted once the cap is exceeded so the cache cannot grow without bound. */
const MAX_CACHE_ENTRIES = 1000;

/**
 * Insert a cache entry under the hard cap, evicting the oldest entries (Map
 * insertion order) when the cap is exceeded. TTL expiry is pruned separately
 * on each consult; this bounds memory even when the TTL is very large.
 */
function setCacheEntry(mint: string, entry: CacheEntry): void {
  cache.set(mint, entry);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Test/observability hook: drop all cached signals (production never resets). */
export function clearTokenRiskCache(): void {
  cache.clear();
}

/** Serve fresh cache hits into `result` and return the mints that need a
 *  network fetch. Expired REAL signals are served as resilience in case the
 *  refresh fails; expired negative entries stay omitted. */
function collectCachedSignals(
  mints: ReadonlyArray<string>,
  ttlMs: number,
  now: number,
  result: Map<string, TokenRiskSignal>,
): string[] {
  const toFetch: string[] = [];
  for (const mint of mints) {
    const entry = cache.get(mint);
    if (entry === undefined) {
      toFetch.push(mint);
    } else if (now - entry.fetchedAt >= ttlMs) {
      // Expired: re-fetch. A stale REAL signal is served as resilience in case
      // the refresh fails; a stale negative entry stays omitted.
      if (entry.signal !== UNKNOWN_TOKEN_RISK_SIGNAL) result.set(mint, entry.signal);
      toFetch.push(mint);
    } else if (entry.signal !== UNKNOWN_TOKEN_RISK_SIGNAL) {
      // Fresh real signal: serve from cache, no network call. A fresh negative
      // entry is cached only to stop re-query spam — it is intentionally NOT
      // served, so a revoked verification stops exempting the pool.
      result.set(mint, entry.signal);
    }
  }
  return toFetch;
}

/** Build the request options without ever assigning `undefined` to an
 *  optional field (exactOptionalPropertyTypes): an empty JUPITER_API_KEY is
 *  omitted, never sent as an empty header. */
function buildJupiterFetchOptions(options: {
  readonly fetchImpl?: FetchLike;
}): FetchTokenRisksOptions {
  const request: FetchTokenRisksOptions = {};
  const apiKey = process.env.JUPITER_API_KEY?.trim();
  if (apiKey) request.apiKey = apiKey;
  if (options.fetchImpl !== undefined) request.fetchImpl = options.fetchImpl;
  return request;
}

/** Fetch the missing/expired mints and refresh the cache + result. Fail-open:
 *  on any fetch failure expired REAL signals keep their stale value in
 *  result, never-fetched mints stay absent — one warn per failing consult. */
async function refreshTokens(
  toFetch: readonly string[],
  request: FetchTokenRisksOptions,
  result: Map<string, TokenRiskSignal>,
): Promise<void> {
  try {
    const fetched = await fetchTokenRisks(toFetch, request);
    const fetchedAt = Date.now();
    for (const mint of toFetch) {
      const signal = fetched.get(mint);
      if (signal !== undefined) {
        setCacheEntry(mint, { signal, fetchedAt });
        result.set(mint, signal);
      } else {
        // Omitted by a SUCCESSFUL refresh: NEGATIVE cache with a fresh
        // timestamp (stops per-cycle re-query) and NOT served — revoked
        // verification must not keep exempting the pool.
        setCacheEntry(mint, { signal: UNKNOWN_TOKEN_RISK_SIGNAL, fetchedAt });
        result.delete(mint);
      }
    }
  } catch (err) {
    logger.warn("Jupiter token risk fetch failed — serving cached signals (fail-open)", {
      mints: toFetch.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Prune TTL-expired entries so the cache cannot grow without bound across
 *  scan cycles. Runs after the fetch/resolve pass so a stale signal served
 *  for this consult (fail-open) is not removed mid-flight. */
function pruneExpiredCacheEntries(ttlMs: number, now: number): void {
  for (const [mint, entry] of cache) {
    if (now - entry.fetchedAt >= ttlMs) cache.delete(mint);
  }
}

/** Merge GoPlus contract-level hard-risk (Wave 20). GoPlus runs independently
 *  of the Jupiter switch/result — a mint Jupiter omits but GoPlus hard-flags
 *  still gets a signal, so a contract-level rug signal can never be masked by
 *  a Jupiter miss. Unknown/failed GoPlus consults return empty (fail-open). */
async function mergeGoPlusHardRisk(
  mints: ReadonlyArray<string>,
  config: TokenRiskConfigLike,
  goPlusOptions: { readonly fetchImpl?: FetchLike },
  result: Map<string, TokenRiskSignal>,
): Promise<void> {
  const goPlusSignals = await consultGoPlusTokenSecurity(mints, config, goPlusOptions);
  for (const [mint, goPlusSignal] of goPlusSignals) {
    const reasons = goPlusHardRiskReasons(goPlusSignal);
    if (reasons.length === 0) continue;
    const goPlusHardRisk = reasons.join("; ");
    const existing = result.get(mint);
    if (existing !== undefined) {
      // Copy, never mutate: the Jupiter cache holds the original object and a
      // GoPlus overlay must not leak back into that cache entry.
      result.set(mint, { ...existing, goPlusHardRisk });
    } else {
      result.set(mint, {
        isVerified: null,
        organicScore: null,
        organicScoreLabel: null,
        isSus: false,
        freezeAuthorityPresent: false,
        mintAuthorityPresent: false,
        goPlusHardRisk,
      });
    }
  }
}

/**
 * Resolve signals for a set of mints. NEVER throws and NEVER blocks the scan
 * cycle: fresh cache hits are served without fetching; on any fetch failure the
 * last known (possibly stale) signals are served — unknown mints fall through
 * as absent so callers fail-open. Disabled config (`jupiterTokenRiskEnabled ===
 * false`) returns an empty map without touching the network. Signals are never
 * fabricated. Logs ONE warning per failing consult, not per mint.
 */
export async function consultTokenRisks(
  mints: ReadonlyArray<string>,
  config: TokenRiskConfigLike,
  options: { readonly fetchImpl?: FetchLike; readonly goPlusFetchImpl?: FetchLike } = {},
): Promise<Map<string, TokenRiskSignal>> {
  const jupiterEnabled = config.jupiterTokenRiskEnabled !== false;
  const ttlMs = (config.jupiterTokenRiskCacheTtlMin ?? DEFAULT_CACHE_TTL_MIN) * 60_000;
  const now = Date.now();

  const result = new Map<string, TokenRiskSignal>();
  if (jupiterEnabled) {
    const toFetch = collectCachedSignals(mints, ttlMs, now, result);
    if (toFetch.length > 0) {
      await refreshTokens(toFetch, buildJupiterFetchOptions(options), result);
    }
    pruneExpiredCacheEntries(ttlMs, now);
  }

  await mergeGoPlusHardRisk(
    mints,
    config,
    options.goPlusFetchImpl === undefined ? {} : { fetchImpl: options.goPlusFetchImpl },
    result,
  );

  return result;
}
