import { createLogger } from "./logger.js";

/**
 * GoPlus token security overlay (Wave 20): contract-level Solana token-risk
 * detection that corroborates the Jupiter/Data-API overlay. Follows the same
 * module-function pattern as `token-risk-service.ts` (plain exported functions,
 * injectable `fetchImpl`, NOT an Effect Context.Tag service) so adding it does
 * not ripple through the existing Effect test layers.
 *
 * ADVISORY and fail-open, exactly like the Jupiter overlay: unknown mints,
 * fetch failures, an unset key/secret, and a disabled switch all leave
 * decisions unchanged. The only signals that can hard-reject a pool are the
 * three unambiguous "cannot exit / can be rugged" findings:
 *   - non-transferable tokens (honeypot-like),
 *   - a closable token program (assets can be eliminated),
 *   - a mutable balance authority (dev can tamper with holder balances).
 *
 * Auth model (live-verified against docs.gopluslabs.io, 2026-08):
 *   1. POST /api/v1/token with { app_key, sign, time } where
 *      sign = sha1(app_key + time + app_secret), time = epoch seconds.
 *   2. The returned access_token is sent as the `Authorization` header value
 *      VERBATIM on GET /api/v1/solana/token_security?contract_addresses=...
 *      (the token ALREADY carries the "Bearer " scheme — do not prepend it
 *      again, or the API returns `signature verification failure`).
 */

const logger = createLogger("goplus");

const GOPLUS_BASE_URL = "https://api.gopluslabs.io";
const MAX_MINTS_PER_REQUEST = 100;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CACHE_TTL_MIN = 30;
/** Access tokens are cached until this long before their expiry. */
const ACCESS_TOKEN_EXPIRY_SKEW_MS = 60_000;

/** The `fetch` call surface the module needs (mirrors token-risk-service.ts). */
export type GoPlusFetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Optional fetch options built without ever assigning `undefined` (exactOptionalPropertyTypes). */
export interface FetchGoPlusOptions {
  fetchImpl?: GoPlusFetchLike;
}

/** The optional config fields the overlay consults; the engine's `AppConfig`
 *  satisfies this structurally without coupling the module to the full config. */
export interface GoPlusConfigLike {
  readonly goPlusApiKey?: string;
  readonly goPlusApiSecret?: string;
  readonly goPlusTokenRiskEnabled?: boolean;
  readonly goPlusTokenRiskCacheTtlMin?: number;
}

export interface GoPlusTokenSecuritySignal {
  /** "1" = non-transferable (honeypot-like). */
  readonly noneTransferable: boolean;
  /** "1" = the token program can be closed, eliminating assets. */
  readonly closable: boolean;
  /** "1" = the balance authority is mutable (dev can tamper with balances). */
  readonly balanceMutable: boolean;
  /** "1" = freeze authority present (corroborates the existing freeze seam). */
  readonly freezable: boolean;
  /** "1" = mint authority present (dilution risk; advisory only). */
  readonly mintable: boolean;
  /** A non-empty transfer hook can block trading. */
  readonly hasTransferHook: boolean;
  /** 1 = a recognized/trustworthy token; otherwise null/unknown. */
  readonly trusted: boolean | null;
}

function isNonNullObject<T>(value: T): boolean {
  return value !== null && value instanceof Object && !(value instanceof Function);
}

function readString<T>(value: T): string | null {
  // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
  return Object.prototype.toString.call(value) === "[object String]" ? (value as string) : null;
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

/** GoPlus uses "1"/"0" string flags for most risk indicators. */
function readFlag<T>(value: T): boolean {
  return readString(value) === "1";
}

/** `trusted_token` is an integer 1/0, null when unknown. */
function readTrusted<T>(value: T): boolean | null {
  const trusted = readFiniteNumber(value);
  if (trusted === 1) return true;
  if (trusted === 0) return false;
  return null;
}

/** GoPlus wraps some indicators as `{ status: "1" | "0" }` objects. */
function readStatus<T>(value: T): boolean {
  if (!isNonNullObject(value)) return false;
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  const status = readString((value as { status?: unknown }).status);
  return status === "1";
}

interface RawGoPlusEntry {
  readonly none_transferable?: unknown;
  readonly closable?: unknown;
  readonly balance_mutable_authority?: unknown;
  readonly freezable?: unknown;
  readonly mintable?: unknown;
  readonly transfer_hook?: unknown;
  readonly trusted_token?: unknown;
}

export interface ParsedGoPlusEntry {
  readonly mint: string;
  readonly signal: GoPlusTokenSecuritySignal;
}

/** Parse one per-address entry of the token_security `result` map. */
export function parseGoPlusEntry<T>(mint: string, raw: T): ParsedGoPlusEntry | null {
  if (!isNonNullObject(raw)) return null;
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  const entry = raw as RawGoPlusEntry;
  return {
    mint,
    signal: {
      noneTransferable: readFlag(entry.none_transferable),
      closable: readStatus(entry.closable),
      balanceMutable: readStatus(entry.balance_mutable_authority),
      freezable: readStatus(entry.freezable),
      mintable: readStatus(entry.mintable),
      hasTransferHook: Array.isArray(entry.transfer_hook) && entry.transfer_hook.length > 0,
      trusted: readTrusted(entry.trusted_token),
    },
  };
}

/** The three unambiguous hard-risk findings, each with a human reason. */
export function goPlusHardRiskReasons(signal: GoPlusTokenSecuritySignal): string[] {
  const reasons: string[] = [];
  if (signal.noneTransferable) reasons.push("non-transferable (honeypot risk)");
  if (signal.closable) reasons.push("closable program (assets can be eliminated)");
  if (signal.balanceMutable) reasons.push("mutable balance authority");
  return reasons;
}

// ─── Access token (SHA1-signed, cached) ───────────────────────────────────────

interface GoPlusAccessToken {
  readonly token: string;
  readonly expiresAt: number;
}

async function sha1Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function fetchGoPlusAccessToken(
  appKey: string,
  appSecret: string,
  options: { readonly fetchImpl?: GoPlusFetchLike; readonly timeoutMs?: number } = {},
): Promise<GoPlusAccessToken> {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const time = Math.floor(Date.now() / 1000);
  const sign = await sha1Hex(`${appKey}${time}${appSecret}`);
  const res = await fetchImpl(`${GOPLUS_BASE_URL}/api/v1/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_key: appKey, sign, time }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GoPlus token API HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!isNonNullObject(body)) throw new Error("GoPlus token API returned a non-object body");
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  const result = (body as { result?: unknown }).result;
  if (!isNonNullObject(result)) throw new Error("GoPlus token API response missing result");
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  const token = readString((result as { access_token?: unknown }).access_token);
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  const expiresIn = readFiniteNumber((result as { expires_in?: unknown }).expires_in);
  if (token === null || token.length === 0) {
    throw new Error("GoPlus token API response missing access_token");
  }
  const expiresSeconds = expiresIn ?? 3600;
  return {
    token,
    expiresAt: Date.now() + expiresSeconds * 1000,
  };
}

// ─── Token security fetch ─────────────────────────────────────────────────────

export async function fetchGoPlusTokenSecurity(
  mints: ReadonlyArray<string>,
  accessToken: string,
  options: { readonly fetchImpl?: GoPlusFetchLike; readonly timeoutMs?: number } = {},
): Promise<Map<string, GoPlusTokenSecuritySignal>> {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result = new Map<string, GoPlusTokenSecuritySignal>();
  for (let start = 0; start < mints.length; start += MAX_MINTS_PER_REQUEST) {
    const chunk = mints.slice(start, start + MAX_MINTS_PER_REQUEST);
    const query = chunk.map((mint) => encodeURIComponent(mint)).join(",");
    const url = `${GOPLUS_BASE_URL}/api/v1/solana/token_security?contract_addresses=${query}`;
    const res = await fetchImpl(url, {
      headers: { authorization: accessToken },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`GoPlus token security API HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (!isNonNullObject(body)) {
      throw new Error("GoPlus token security API returned a non-object body");
    }
    // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
    const resultMap = (body as { result?: unknown }).result;
    if (!isNonNullObject(resultMap)) continue;
    // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
    for (const [mint, entry] of Object.entries(resultMap as Record<string, RawGoPlusEntry>)) {
      const parsed = parseGoPlusEntry(mint, entry);
      if (parsed !== null) result.set(parsed.mint, parsed.signal);
    }
  }
  return result;
}

// ─── Consult (access-token cache + mint TTL cache + fail-open) ────────────────

interface MintCacheEntry {
  readonly signal: GoPlusTokenSecuritySignal;
  readonly fetchedAt: number;
}

const mintCache = new Map<string, MintCacheEntry>();
const MAX_MINT_CACHE_ENTRIES = 1000;
let accessTokenCache: GoPlusAccessToken | null = null;

/** Test/observability hook: drop all cached signals + the access token. */
export function clearGoPlusCache(): void {
  mintCache.clear();
  accessTokenCache = null;
}

function setMintCacheEntry(mint: string, entry: MintCacheEntry): void {
  mintCache.set(mint, entry);
  while (mintCache.size > MAX_MINT_CACHE_ENTRIES) {
    const oldest = mintCache.keys().next().value;
    if (oldest === undefined) break;
    mintCache.delete(oldest);
  }
}

/** True only when BOTH the key and secret are non-empty (GoPlus is wired). */
export function goPlusConfigured(config: GoPlusConfigLike): boolean {
  return (
    (config.goPlusApiKey?.trim().length ?? 0) > 0 &&
    (config.goPlusApiSecret?.trim().length ?? 0) > 0
  );
}

async function getAccessToken(
  config: GoPlusConfigLike,
  options: { readonly fetchImpl?: GoPlusFetchLike; readonly timeoutMs?: number },
): Promise<string> {
  if (
    accessTokenCache !== null &&
    accessTokenCache.expiresAt > Date.now() + ACCESS_TOKEN_EXPIRY_SKEW_MS
  ) {
    return accessTokenCache.token;
  }
  const appKey = (config.goPlusApiKey ?? "").trim();
  const appSecret = (config.goPlusApiSecret ?? "").trim();
  const fetched = await fetchGoPlusAccessToken(appKey, appSecret, options);
  accessTokenCache = fetched;
  return fetched.token;
}

/**
 * Resolve GoPlus token-security signals for a set of mints. NEVER throws and
 * NEVER blocks the scan cycle. Disabled config, an unset key/secret, and fetch
 * failures all fail open (serve stale or omit). Signals are never fabricated.
 */
/** Serve fresh cache hits into `result` and return the mints that need a
 *  network fetch. Expired entries are served stale as resilience in case the
 *  refresh fails. */
function collectGoPlusCached(
  mints: ReadonlyArray<string>,
  ttlMs: number,
  now: number,
  result: Map<string, GoPlusTokenSecuritySignal>,
): string[] {
  const toFetch: string[] = [];
  for (const mint of mints) {
    const entry = mintCache.get(mint);
    if (entry === undefined) {
      toFetch.push(mint);
    } else if (now - entry.fetchedAt >= ttlMs) {
      result.set(mint, entry.signal); // stale served as resilience; refreshed below
      toFetch.push(mint);
    } else {
      result.set(mint, entry.signal);
    }
  }
  return toFetch;
}

/** Store freshly fetched signals in the bounded cache + `result`. Mints the
 *  fetch omits keep their stale value (fail-open), never-fetched stay absent. */
function storeGoPlusFetched(
  toFetch: ReadonlyArray<string>,
  fetched: Map<string, GoPlusTokenSecuritySignal>,
  fetchedAt: number,
  result: Map<string, GoPlusTokenSecuritySignal>,
): void {
  for (const mint of toFetch) {
    const signal = fetched.get(mint);
    if (signal !== undefined) {
      setMintCacheEntry(mint, { signal, fetchedAt });
      result.set(mint, signal);
    }
  }
}

/** Prune TTL-expired entries so the cache cannot grow without bound. */
function pruneGoPlusCache(ttlMs: number, now: number): void {
  for (const [mint, entry] of mintCache) {
    if (now - entry.fetchedAt >= ttlMs) mintCache.delete(mint);
  }
}

export async function consultGoPlusTokenSecurity(
  mints: ReadonlyArray<string>,
  config: GoPlusConfigLike,
  options: { readonly fetchImpl?: GoPlusFetchLike; readonly timeoutMs?: number } = {},
): Promise<Map<string, GoPlusTokenSecuritySignal>> {
  if (config.goPlusTokenRiskEnabled === false || !goPlusConfigured(config)) {
    return new Map();
  }
  const ttlMs = (config.goPlusTokenRiskCacheTtlMin ?? DEFAULT_CACHE_TTL_MIN) * 60_000;
  const now = Date.now();

  const result = new Map<string, GoPlusTokenSecuritySignal>();
  const toFetch = collectGoPlusCached(mints, ttlMs, now, result);

  if (toFetch.length > 0) {
    try {
      const accessToken = await getAccessToken(config, options);
      const fetched = await fetchGoPlusTokenSecurity(toFetch, accessToken, options);
      storeGoPlusFetched(toFetch, fetched, Date.now(), result);
    } catch (err) {
      // Fail-open: stale signals keep their value in result; never-fetched
      // mints stay absent. One warn per failing consult, not per mint.
      logger.warn("GoPlus token security consult failed — serving cached signals (fail-open)", {
        mints: toFetch.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  pruneGoPlusCache(ttlMs, now);

  return result;
}
