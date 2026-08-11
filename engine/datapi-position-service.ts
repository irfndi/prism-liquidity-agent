import { Effect } from "effect";
import { createLogger } from "./logger.js";
import { retryEffectWithBackoff } from "./adapter-retry.js";

const logger = createLogger("datapi-position");

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;
const DEFAULT_PAGE_SIZE = 100;

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * One open DLMM position crawled from the Meteora Data API
 * (`GET {baseUrl}/portfolio/open?user={wallet}&page=1&page_size=100`).
 *
 * All fields are read defensively from an upstream schema that is not under
 * our control: identity fields (`poolAddress`, `positionId`) are required for
 * a position to be usable, while every economic field is optional and becomes
 * `undefined` when the API omits it or renames it. Parsing never throws.
 */
export interface OpenPosition {
  readonly poolAddress: string;
  readonly positionId: string;
  readonly tokenX?: string;
  readonly tokenY?: string;
  readonly lowerBin?: number;
  readonly upperBin?: number;
  readonly currentBin?: number;
  readonly depositedUsd?: number;
  readonly valueUsd?: number;
  readonly pnlUsd?: number;
  readonly createdAt?: number;
}

// ─── Response validation ─────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Resolve a field from a list of candidate keys, returning the first present
 * value. The Data API's position payload field names have drifted across
 * releases (e.g. `poolAddress` vs `lb_pair` vs `pool`, `positionId` vs
 * `position_address` vs `pubkey`), so we probe each candidate defensively.
 */
function readStringCandidates(
  obj: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = readString(obj, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function readNumberCandidates(
  obj: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = readNumber(obj, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Parse one position object from the /portfolio/open `pools[...]` array.
 * Returns null when the object lacks a usable poolAddress + positionId
 * identity pair (likely an upstream schema change) so the caller drops it
 * rather than surfacing a half-formed position. Every other field is optional.
 */
export function parseOpenPosition(raw: unknown): OpenPosition | null {
  if (!isObject(raw)) return null;
  const poolAddress = readStringCandidates(raw, [
    "poolAddress",
    "pool",
    "pool_address",
    "lb_pair",
    "lbPair",
    "pair_address",
  ]);
  const positionId = readStringCandidates(raw, [
    "positionId",
    "position_id",
    "position_address",
    "positionAddress",
    "pubkey",
    "publicKey",
    "position_pubkey",
    "address",
  ]);
  if (poolAddress === undefined || positionId === undefined) return null;

  const tokenX =
    readStringCandidates(raw, ["tokenX", "token_x", "mintX", "mint_x"]) ?? readMint(raw, "token_x");
  const tokenY =
    readStringCandidates(raw, ["tokenY", "token_y", "mintY", "mint_y"]) ?? readMint(raw, "token_y");

  // Build the object with only the keys that are actually present. The repo
  // compiles with `exactOptionalPropertyTypes` (an optional field must never
  // be explicitly `undefined`) and the fields are `readonly`, so absent values
  // are omitted via conditional spreads rather than assigned.
  const lowerBin = readNumberCandidates(raw, [
    "lowerBin",
    "lower_bin_id",
    "minBinId",
    "min_bin_id",
    "lowerBinId",
  ]);
  const upperBin = readNumberCandidates(raw, [
    "upperBin",
    "upper_bin_id",
    "maxBinId",
    "max_bin_id",
    "upperBinId",
  ]);
  const currentBin = readNumberCandidates(raw, [
    "currentBin",
    "active_bin_id",
    "activeBin",
    "current_bin_id",
  ]);
  const depositedUsd = readNumberCandidates(raw, [
    "depositedUsd",
    "deposited_usd",
    "totalDepositedUsd",
    "depositUsd",
  ]);
  const valueUsd = readNumberCandidates(raw, [
    "valueUsd",
    "value_usd",
    "currentValueUsd",
    "positionValueUsd",
    "value",
  ]);
  const pnlUsd = readNumberCandidates(raw, [
    "pnlUsd",
    "pnl_usd",
    "unrealizedPnlUsd",
    "pnl",
    "totalPnlUsd",
  ]);
  const createdAt = readNumberCandidates(raw, [
    "createdAt",
    "created_at",
    "openedAt",
    "opened_at",
    "ts",
  ]);

  return {
    poolAddress,
    positionId,
    ...(tokenX !== undefined ? { tokenX } : {}),
    ...(tokenY !== undefined ? { tokenY } : {}),
    ...(lowerBin !== undefined ? { lowerBin } : {}),
    ...(upperBin !== undefined ? { upperBin } : {}),
    ...(currentBin !== undefined ? { currentBin } : {}),
    ...(depositedUsd !== undefined ? { depositedUsd } : {}),
    ...(valueUsd !== undefined ? { valueUsd } : {}),
    ...(pnlUsd !== undefined ? { pnlUsd } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  } satisfies OpenPosition;
}

/** Read `token_x: { address }` / `token_y: { address }` nested objects. */
function readMint(obj: Record<string, unknown>, key: string): string | undefined {
  const nested = obj[key];
  if (!isObject(nested)) return undefined;
  return readStringCandidates(nested, ["address", "mint", "mint_address"]);
}

/**
 * Parse the full /portfolio/open envelope. The response is
 * `{ page, pageSize, hasNext, totalCount, totalPositions, pools: [...] }`.
 * A pubkey that fails server-side validation returns HTTP 200 with a
 * `{ message: "user: Validation error: ..." }` body (no `pools` key) — that
 * is treated as an empty portfolio, never an error. Any malformed payload
 * degrades to `[]` rather than throwing.
 */
export function parseOpenPortfolio(raw: unknown): OpenPosition[] {
  if (!isObject(raw)) return [];
  const pools = raw["pools"];
  if (!Array.isArray(pools)) return [];
  const positions: OpenPosition[] = [];
  for (const entry of pools) {
    const parsed = parseOpenPosition(entry);
    if (parsed !== null) positions.push(parsed);
  }
  return positions;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

/**
 * In-memory TTL cache keyed by wallet address. Collapses duplicate
 * /portfolio/open fetches for the same wallet within one scan cycle (the
 * wallet is read once per cycle for portfolio context). A failed fetch is NOT
 * cached (fail-open retries next read), and expired entries are pruned on
 * insert so dropped wallets don't accumulate.
 */
export class PositionCrawlCache {
  private readonly entries = new Map<string, { positions: OpenPosition[]; fetchedAt: number }>();
  private readonly ttlMs: number;

  constructor(ttlMs = 60_000) {
    this.ttlMs = ttlMs;
  }

  get(wallet: string, now = Date.now()): OpenPosition[] | undefined {
    const entry = this.entries.get(wallet);
    if (entry === undefined) return undefined;
    if (now - entry.fetchedAt >= this.ttlMs) {
      this.entries.delete(wallet);
      return undefined;
    }
    return entry.positions;
  }

  set(wallet: string, positions: OpenPosition[], now = Date.now()): void {
    this.prune(now);
    this.entries.set(wallet, { positions, fetchedAt: now });
  }

  clear(): void {
    this.entries.clear();
  }

  private prune(now: number): void {
    for (const [wallet, entry] of this.entries) {
      if (now - entry.fetchedAt >= this.ttlMs) this.entries.delete(wallet);
    }
  }
}

// ─── Fetch / crawl ───────────────────────────────────────────────────────────

/**
 * Raw HTTP crawl of a wallet's open DLMM positions. Fails (with an Error) on
 * any network, non-OK HTTP, or parse failure so callers can distinguish a
 * real empty portfolio from a transient failure. `fetchImpl` is injectable
 * for tests (defaults to the global `fetch`).
 */
export function crawlOpenPortfolio(
  baseUrl: string,
  wallet: string,
  fetchImpl: FetchImpl = globalThis.fetch.bind(globalThis) as FetchImpl,
): Effect.Effect<OpenPosition[], Error> {
  const url = `${baseUrl.replace(/\/+$/, "")}/portfolio/open?user=${encodeURIComponent(wallet)}&page=1&page_size=${DEFAULT_PAGE_SIZE}`;
  const fetchJson = retryEffectWithBackoff(
    Effect.tryPromise({
      try: () => fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(
      Effect.flatMap((res) =>
        res.ok
          ? Effect.tryPromise({
              try: () => res.json() as Promise<unknown>,
              catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
            })
          : Effect.fail(new Error(`Meteora Data API HTTP ${res.status} for ${url}`)),
      ),
    ),
    { maxRetries: MAX_RETRIES },
  );

  return fetchJson.pipe(Effect.map(parseOpenPortfolio));
}

/**
 * Crawl a wallet's open DLMM positions from the Meteora Data API. Fail-open:
 * any network, HTTP, or parse error returns `[]` (with a warning) and never
 * rejects the caller. `fetchImpl` is injectable for tests (defaults to the
 * global `fetch`).
 */
export function fetchOpenPortfolio(
  baseUrl: string,
  wallet: string,
  fetchImpl?: FetchImpl,
): Promise<OpenPosition[]> {
  return Effect.runPromise(
    crawlOpenPortfolio(baseUrl, wallet, fetchImpl).pipe(
      Effect.catch((err) =>
        Effect.sync(() => {
          logger.warn("Meteora Data API portfolio crawl failed — returning empty portfolio", {
            wallet,
            error: String(err),
          });
          return [] as OpenPosition[];
        }),
      ),
    ),
  );
}

/**
 * Cached, fail-open read of a wallet's open positions. Returns the cached
 * value within the TTL without re-fetching; otherwise fetches and stores the
 * result. Only a genuine success (including a real empty portfolio) is
 * cached — a failed fetch is not, so the next read retries.
 */
export function effectGetOpenPositions(
  baseUrl: string,
  wallet: string,
  cache: PositionCrawlCache,
  fetchImpl?: FetchImpl,
): Effect.Effect<OpenPosition[], never> {
  return Effect.suspend(() => {
    const cached = cache.get(wallet);
    if (cached !== undefined) return Effect.succeed(cached);
    return crawlOpenPortfolio(baseUrl, wallet, fetchImpl).pipe(
      Effect.map((positions) => {
        cache.set(wallet, positions);
        return positions;
      }),
      Effect.catch((err) =>
        Effect.sync(() => {
          logger.warn("Meteora Data API portfolio crawl failed — returning empty portfolio", {
            wallet,
            error: String(err),
          });
          return [] as OpenPosition[];
        }),
      ),
    );
  });
}
