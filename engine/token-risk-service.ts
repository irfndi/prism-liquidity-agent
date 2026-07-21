import { createLogger } from "./logger.js";

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
}

/** The two optional fields the overlay consults; the engine's `AppConfig`
 *  satisfies this structurally without coupling the module to the full config. */
export interface TokenRiskConfigLike {
  readonly jupiterTokenRiskEnabled?: boolean;
  readonly jupiterTokenRiskCacheTtlMin?: number;
}

// ─── Response parsing (live-verified semantics) ──────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readMint(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Parse one entry of the Tokens V2 search ARRAY. Returns null when the entry
 * carries no usable address (schema drift) so it is simply skipped — mints
 * absent from the response stay unknown to the caller (no fabricated entry).
 */
export function parseTokenRiskEntry(raw: unknown): {
  readonly mint: string;
  readonly signal: TokenRiskSignal;
} | null {
  if (!isObject(raw)) return null;
  // The response keys an entry by the token address; live payloads have also
  // carried `id`. Accept either, never guess.
  const mint = readMint(raw["address"]) ?? readMint(raw["id"]);
  if (mint === null) return null;
  const audit = raw["audit"];
  const score = raw["organicScore"];
  const label = raw["organicScoreLabel"];
  return {
    mint,
    signal: {
      isVerified: typeof raw["isVerified"] === "boolean" ? raw["isVerified"] : null,
      organicScore: typeof score === "number" && Number.isFinite(score) ? score : null,
      organicScoreLabel: label === "high" || label === "medium" || label === "low" ? label : null,
      isSus: isObject(audit) && audit["isSus"] === true,
      freezeAuthorityPresent: readMint(raw["freezeAuthority"]) !== null,
      mintAuthorityPresent: readMint(raw["mintAuthority"]) !== null,
    },
  };
}

// ─── Fetcher ─────────────────────────────────────────────────────────────────

export async function fetchTokenRisks(
  mints: ReadonlyArray<string>,
  options: {
    readonly apiKey?: string;
    readonly timeoutMs?: number;
    readonly fetchImpl?: FetchLike;
  } = {},
): Promise<Map<string, TokenRiskSignal>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers: Record<string, string> = {};
  // ONLY send the key when a non-empty value is configured — an empty
  // `x-api-key` header can be treated as an invalid key and 401; its absence
  // is the supported keyless path.
  if (typeof options.apiKey === "string" && options.apiKey.length > 0) {
    headers["x-api-key"] = options.apiKey;
  }

  const result = new Map<string, TokenRiskSignal>();
  for (let start = 0; start < mints.length; start += MAX_MINTS_PER_REQUEST) {
    const chunk = mints.slice(start, start + MAX_MINTS_PER_REQUEST);
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
    if (!Array.isArray(body)) continue;
    for (const entry of body) {
      const parsed = parseTokenRiskEntry(entry);
      if (parsed !== null) result.set(parsed.mint, parsed.signal);
    }
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
};

// Mint-global cache: a token's safety signals are not pool-specific, so the key
// is the mint address alone. Fresh entries are served without any network call.
const cache = new Map<string, CacheEntry>();

/** Test/observability hook: drop all cached signals (production never resets). */
export function clearTokenRiskCache(): void {
  cache.clear();
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
  options: { readonly fetchImpl?: FetchLike } = {},
): Promise<Map<string, TokenRiskSignal>> {
  if (config.jupiterTokenRiskEnabled === false) return new Map();
  const ttlMs = (config.jupiterTokenRiskCacheTtlMin ?? DEFAULT_CACHE_TTL_MIN) * 60_000;
  const now = Date.now();

  const result = new Map<string, TokenRiskSignal>();
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

  if (toFetch.length > 0) {
    // Build the request options without ever assigning `undefined` to an
    // optional field (exactOptionalPropertyTypes): an empty JUPITER_API_KEY is
    // omitted, never sent as an empty header.
    const request: { apiKey?: string; fetchImpl?: FetchLike } = {};
    const apiKey = process.env.JUPITER_API_KEY?.trim();
    if (apiKey) request.apiKey = apiKey;
    if (options.fetchImpl !== undefined) request.fetchImpl = options.fetchImpl;
    try {
      const fetched = await fetchTokenRisks(toFetch, request);
      const fetchedAt = Date.now();
      for (const mint of toFetch) {
        const signal = fetched.get(mint);
        if (signal !== undefined) {
          cache.set(mint, { signal, fetchedAt });
          result.set(mint, signal);
        } else {
          // Omitted by a SUCCESSFUL refresh: NEGATIVE cache with a fresh
          // timestamp (stops per-cycle re-query) and NOT served — revoked
          // verification must not keep exempting the pool.
          cache.set(mint, { signal: UNKNOWN_TOKEN_RISK_SIGNAL, fetchedAt });
          result.delete(mint);
        }
      }
    } catch (err) {
      // Fail-open: expired real signals keep their stale value in result;
      // never-fetched mints stay absent. One warn per failing consult.
      logger.warn("Jupiter token risk fetch failed — serving cached signals (fail-open)", {
        mints: toFetch.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
