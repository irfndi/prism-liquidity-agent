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

interface RawPosition {
  readonly poolAddress?: unknown;
  readonly pool?: unknown;
  readonly pool_address?: unknown;
  readonly lb_pair?: unknown;
  readonly lbPair?: unknown;
  readonly pair_address?: unknown;
  readonly positionId?: unknown;
  readonly position_id?: unknown;
  readonly position_address?: unknown;
  readonly positionAddress?: unknown;
  readonly pubkey?: unknown;
  readonly publicKey?: unknown;
  readonly position_pubkey?: unknown;
  readonly address?: unknown;
  readonly mint?: unknown;
  readonly mint_address?: unknown;
  readonly tokenX?: unknown;
  readonly token_x?: unknown;
  readonly mintX?: unknown;
  readonly mint_x?: unknown;
  readonly tokenY?: unknown;
  readonly token_y?: unknown;
  readonly mintY?: unknown;
  readonly mint_y?: unknown;
  readonly lowerBin?: unknown;
  readonly lower_bin_id?: unknown;
  readonly minBinId?: unknown;
  readonly min_bin_id?: unknown;
  readonly lowerBinId?: unknown;
  readonly upperBin?: unknown;
  readonly upper_bin_id?: unknown;
  readonly maxBinId?: unknown;
  readonly max_bin_id?: unknown;
  readonly upperBinId?: unknown;
  readonly currentBin?: unknown;
  readonly active_bin_id?: unknown;
  readonly activeBin?: unknown;
  readonly current_bin_id?: unknown;
  readonly depositedUsd?: unknown;
  readonly deposited_usd?: unknown;
  readonly totalDepositedUsd?: unknown;
  readonly depositUsd?: unknown;
  readonly valueUsd?: unknown;
  readonly value_usd?: unknown;
  readonly currentValueUsd?: unknown;
  readonly positionValueUsd?: unknown;
  readonly value?: unknown;
  readonly pnlUsd?: unknown;
  readonly pnl_usd?: unknown;
  readonly unrealizedPnlUsd?: unknown;
  readonly pnl?: unknown;
  readonly totalPnlUsd?: unknown;
  readonly createdAt?: unknown;
  readonly created_at?: unknown;
  readonly openedAt?: unknown;
  readonly opened_at?: unknown;
  readonly ts?: unknown;
}

interface RawPortfolio {
  readonly pools: unknown;
}

function isNonNullObject<T>(value: T): boolean {
  return value !== null && value instanceof Object && !(value instanceof Function);
}

function readString<T>(value: T): string | undefined {
  // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
  return Object.prototype.toString.call(value) === "[object String]" && (value as string).length > 0
    ? // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
      (value as string)
    : undefined;
}

function readNumber<T>(value: T): number | undefined {
  // SAFETY: The enclosing statement has validated or constructed the asserted contract before this value is consumed.
  return Object.prototype.toString.call(value) === "[object Number]" &&
    // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
    Number.isFinite(value as number)
    ? // SAFETY: The runtime guard or typed fixture immediately above this assertion establishes the required invariant.
      // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
      (value as number)
    : undefined;
}

/** Candidate keys for the pool identity of a position (upstream names drift). */
const POOL_ADDRESS_KEYS: ReadonlyArray<keyof RawPosition> = [
  "poolAddress",
  "pool",
  "pool_address",
  "lb_pair",
  "lbPair",
  "pair_address",
];

/** Candidate keys for the position identity of a position. */
const POSITION_ID_KEYS: ReadonlyArray<keyof RawPosition> = [
  "positionId",
  "position_id",
  "position_address",
  "positionAddress",
  "pubkey",
  "publicKey",
  "position_pubkey",
  "address",
];

/** Candidate token keys per side, plus the nested-object key per side. */
const POSITION_TOKEN_KEYS = {
  x: ["tokenX", "token_x", "mintX", "mint_x"],
  y: ["tokenY", "token_y", "mintY", "mint_y"],
} satisfies Record<"x" | "y", ReadonlyArray<keyof RawPosition>>;
const POSITION_MINT_KEYS = { x: "token_x", y: "token_y" } as const;

/**
 * Resolve a field from a list of candidate keys, returning the first present
 * value. The Data API's position payload field names have drifted across
 * releases (e.g. `poolAddress` vs `lb_pair` vs `pool`, `positionId` vs
 * `position_address` vs `pubkey`), so we probe each candidate defensively.
 */
function readStringCandidates(
  record: RawPosition,
  keys: readonly (keyof RawPosition)[],
): string | undefined {
  for (const key of keys) {
    const value = readString(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function readNumberCandidates(
  record: RawPosition,
  keys: readonly (keyof RawPosition)[],
): number | undefined {
  for (const key of keys) {
    const value = readNumber(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Mutable construction shape for {@link OpenPosition} (readonly on the public type). */
interface MutableOpenPosition {
  poolAddress: string;
  positionId: string;
  tokenX?: string;
  tokenY?: string;
  lowerBin?: number;
  upperBin?: number;
  currentBin?: number;
  depositedUsd?: number;
  valueUsd?: number;
  pnlUsd?: number;
  createdAt?: number;
}

/** Optional numeric fields of a position, each with its upstream key drift. */
type PositionNumberField =
  | "lowerBin"
  | "upperBin"
  | "currentBin"
  | "depositedUsd"
  | "valueUsd"
  | "pnlUsd"
  | "createdAt";
const POSITION_NUMBER_KEYS = {
  lowerBin: ["lowerBin", "lower_bin_id", "minBinId", "min_bin_id", "lowerBinId"],
  upperBin: ["upperBin", "upper_bin_id", "maxBinId", "max_bin_id", "upperBinId"],
  currentBin: ["currentBin", "active_bin_id", "activeBin", "current_bin_id"],
  depositedUsd: ["depositedUsd", "deposited_usd", "totalDepositedUsd", "depositUsd"],
  valueUsd: ["valueUsd", "value_usd", "currentValueUsd", "positionValueUsd", "value"],
  pnlUsd: ["pnlUsd", "pnl_usd", "unrealizedPnlUsd", "pnl", "totalPnlUsd"],
  createdAt: ["createdAt", "created_at", "openedAt", "opened_at", "ts"],
} satisfies Record<PositionNumberField, ReadonlyArray<keyof RawPosition>>;

/** Read the pool + position identity pair; null when either leg is missing. */
function readPositionIdentity(
  record: RawPosition,
): { readonly poolAddress: string; readonly positionId: string } | null {
  const poolAddress = readStringCandidates(record, POOL_ADDRESS_KEYS);
  const positionId = readStringCandidates(record, POSITION_ID_KEYS);
  if (poolAddress === undefined || positionId === undefined) return null;
  return { poolAddress, positionId };
}

/** Read one side's mint (flat candidates, then the nested `token_x/y` object). */
function readPositionToken(record: RawPosition, side: "x" | "y"): string | undefined {
  return (
    readStringCandidates(record, POSITION_TOKEN_KEYS[side]) ??
    readMint(record, POSITION_MINT_KEYS[side])
  );
}

/** Copy one optional numeric field onto the result when present upstream. */
function assignPositionNumber(
  result: MutableOpenPosition,
  record: RawPosition,
  field: PositionNumberField,
): void {
  const value = readNumberCandidates(record, POSITION_NUMBER_KEYS[field]);
  if (value !== undefined) result[field] = value;
}

/**
 * Parse one position object from the /portfolio/open `pools[...]` array.
 * Returns null when the object lacks a usable poolAddress + positionId
 * identity pair (likely an upstream schema change) so the caller drops it
 * rather than surfacing a half-formed position. Every other field is optional.
 */
export function parseOpenPosition<T>(raw: T): OpenPosition | null {
  if (!isNonNullObject(raw)) return null;
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  const record = raw as RawPosition;
  const identity = readPositionIdentity(record);
  if (identity === null) return null;

  const result: MutableOpenPosition = {
    poolAddress: identity.poolAddress,
    positionId: identity.positionId,
  };

  const tokenX = readPositionToken(record, "x");
  if (tokenX !== undefined) result.tokenX = tokenX;
  const tokenY = readPositionToken(record, "y");
  if (tokenY !== undefined) result.tokenY = tokenY;

  assignPositionNumber(result, record, "lowerBin");
  assignPositionNumber(result, record, "upperBin");
  assignPositionNumber(result, record, "currentBin");
  assignPositionNumber(result, record, "depositedUsd");
  assignPositionNumber(result, record, "valueUsd");
  assignPositionNumber(result, record, "pnlUsd");
  assignPositionNumber(result, record, "createdAt");

  return result;
}

/** Read `token_x: { address }` / `token_y: { address }` nested objects. */
function readMint(record: RawPosition, key: keyof RawPosition): string | undefined {
  const nested = record[key];
  if (!isNonNullObject(nested)) return undefined;
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  return readStringCandidates(nested as RawPosition, ["address", "mint", "mint_address"]);
}

/**
 * Parse the full /portfolio/open envelope. The response is
 * `{ page, pageSize, hasNext, totalCount, totalPositions, pools: [...] }`.
 * A pubkey that fails server-side validation returns HTTP 200 with a
 * `{ message: "user: Validation error: ..." }` body (no `pools` key) — that
 * is treated as an empty portfolio, never an error. Any malformed payload
 * degrades to `[]` rather than throwing.
 */
export function parseOpenPortfolio<T>(raw: T): OpenPosition[] {
  if (!isNonNullObject(raw)) return [];
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  const record = raw as RawPortfolio;
  const pools = record.pools;
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
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
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
              // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
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
          // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
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
          // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
          return [] as OpenPosition[];
        }),
      ),
    );
  });
}
