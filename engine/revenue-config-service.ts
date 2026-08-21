import { Effect, Layer } from "effect";
import { ConfigService } from "./config-service.js";
import { DbService, RevenueConfigService, type DbApi, type RevenueConfig } from "./services.js";
import { createLogger } from "./logger.js";
import fs from "fs";
import path from "path";
import { getPrismUserConfigDir } from "./paths.js";

const log = createLogger("revenue-config-service");

const API_BASE_URL = "https://prism-api.irfndi.workers.dev";
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const CREDENTIALS_FILE = path.join(getPrismUserConfigDir(), "credentials.json");
const METADATA_KEY = "revenue_config";

const DEFAULT_CONFIG: RevenueConfig = {
  tier: "free",
  platformFeeRate: 0,
  revenueShareEnabled: false,
  revenueShareOperatorPct: 0,
  feeWalletAddress: "",
};

const FAIL_CLOSED_CONFIG: RevenueConfig = {
  tier: "fund",
  platformFeeRate: 0.1,
  revenueShareEnabled: true,
  revenueShareOperatorPct: 0,
  feeWalletAddress: "",
};

interface CachedConfig {
  readonly config: RevenueConfig;
  readonly expiresAt: number;
}

interface RawRevenueConfig {
  readonly tier?: unknown;
  readonly platformFeeRate?: unknown;
  readonly revenueShareEnabled?: unknown;
  readonly revenueShareOperatorPct?: unknown;
  readonly feeWalletAddress?: unknown;
}

function isNonNullObject<T>(value: T): boolean {
  return value !== null && value instanceof Object && !(value instanceof Function);
}

function readString<T>(value: T): string | null {
  // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
  return Object.prototype.toString.call(value) === "[object String]" ? (value as string) : null;
}

function readNumber<T>(value: T): number | null {
  if (Object.prototype.toString.call(value) !== "[object Number]") return null;
  // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
  const n = value as number;
  return Number.isFinite(n) ? n : null;
}

function readBoolean<T>(value: T): boolean | null {
  // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
  return Object.prototype.toString.call(value) === "[object Boolean]" ? (value as boolean) : null;
}

function readApiKey(): Effect.Effect<string | null, never> {
  return Effect.try({
    try: () => {
      const raw = fs.readFileSync(CREDENTIALS_FILE, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed === null ||
        !(parsed instanceof Object) ||
        parsed instanceof Function ||
        !("apiKey" in parsed)
      ) {
        return null;
      }
      // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
      const key = readString((parsed as { apiKey: unknown }).apiKey);
      return key !== null && key.length > 0 ? key : null;
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(Effect.catch(() => Effect.succeed(null)));
}

export function parseRevenueConfig<T>(data: T): RevenueConfig | null {
  if (!isNonNullObject(data)) return null;
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  const obj = data as RawRevenueConfig;
  return {
    tier: readString(obj.tier) ?? "free",
    platformFeeRate: readNumber(obj.platformFeeRate) ?? 0,
    revenueShareEnabled: readBoolean(obj.revenueShareEnabled) ?? false,
    revenueShareOperatorPct: readNumber(obj.revenueShareOperatorPct) ?? 0,
    feeWalletAddress: readString(obj.feeWalletAddress) ?? "",
  };
}

export function fetchConfigFromApi(apiKey: string): Effect.Effect<RevenueConfig, Error> {
  return Effect.gen(function* () {
    const res = yield* Effect.tryPromise(() =>
      fetch(`${API_BASE_URL}/v1/config`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      }),
    );

    if (!res.ok) {
      return yield* Effect.fail(new Error(`API returned ${res.status}`));
    }

    const data: unknown = yield* Effect.tryPromise(() => res.json());
    const parsed = parseRevenueConfig(data);
    if (parsed === null) {
      return yield* Effect.fail(new Error("Invalid API response"));
    }
    return parsed;
  });
}

function loadFromDb(db: DbApi): Effect.Effect<RevenueConfig | null, Error> {
  return Effect.gen(function* () {
    const raw = yield* db.getMetadata(METADATA_KEY);
    if (raw === null) return null;
    const parsed = yield* Effect.try({
      // SAFETY: The value is intentionally opaque at this boundary and is validated by the enclosing parser or schema before domain use.
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(Effect.catch(() => Effect.succeed(null)));
    return parseRevenueConfig(parsed);
  });
}

function saveToDb(db: DbApi, config: RevenueConfig): Effect.Effect<void, Error> {
  return db.setMetadata(METADATA_KEY, JSON.stringify(config));
}

function fetchWithRetry(apiKey: string): Effect.Effect<RevenueConfig, Error> {
  return Effect.gen(function* () {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const result = yield* Effect.result(fetchConfigFromApi(apiKey));
      if (result._tag === "Success") {
        return result.success;
      }
      lastError = result.failure;
      if (attempt < MAX_RETRIES - 1) {
        yield* Effect.sleep(RETRY_DELAY_MS);
      }
    }
    // SAFETY: This branch normalizes the caught cause to the Error contract before propagation.
    return yield* Effect.fail(lastError as Error);
  });
}

function resolveConfig(db: DbApi, paperTrading: boolean): Effect.Effect<RevenueConfig, never> {
  return Effect.gen(function* () {
    if (cached && Date.now() < cached.expiresAt) {
      return cached.config;
    }

    const apiKey = yield* readApiKey();
    if (apiKey === null) {
      log.warn("No API key found, using default revenue config");
      return DEFAULT_CONFIG;
    }

    const result = yield* Effect.result(fetchWithRetry(apiKey));
    if (result._tag === "Success") {
      cached = { config: result.success, expiresAt: Date.now() + CACHE_TTL_MS };
      yield* Effect.ignore(saveToDb(db, result.success), { log: true });
      return result.success;
    }

    log.warn("Failed to fetch revenue config from API, trying DB cache");
    const fromDb = yield* Effect.result(loadFromDb(db));
    if (fromDb._tag === "Success" && fromDb.success !== null) {
      cached = { config: fromDb.success, expiresAt: Date.now() + CACHE_TTL_MS };
      return fromDb.success;
    }

    if (paperTrading) {
      log.warn("Paper mode: using default revenue config after fetch failure");
      return DEFAULT_CONFIG;
    }

    log.error("Live mode: API unreachable, using fail-closed config with max fee rate");
    return FAIL_CLOSED_CONFIG;
  });
}

function forceRefresh(db: DbApi, paperTrading: boolean): Effect.Effect<RevenueConfig, never> {
  return Effect.gen(function* () {
    cached = null;

    const apiKey = yield* readApiKey();
    if (apiKey === null) {
      return DEFAULT_CONFIG;
    }

    const result = yield* Effect.result(fetchWithRetry(apiKey));
    if (result._tag === "Success") {
      cached = { config: result.success, expiresAt: Date.now() + CACHE_TTL_MS };
      yield* Effect.ignore(saveToDb(db, result.success), { log: true });
      return result.success;
    }

    const fromDb = yield* Effect.result(loadFromDb(db));
    if (fromDb._tag === "Success" && fromDb.success !== null) {
      cached = { config: fromDb.success, expiresAt: Date.now() + CACHE_TTL_MS };
      return fromDb.success;
    }

    if (paperTrading) {
      return DEFAULT_CONFIG;
    }

    log.error("Live mode: API unreachable on refresh, using fail-closed config with max fee rate");
    return FAIL_CLOSED_CONFIG;
  });
}

let cached: CachedConfig | null = null;

export const RevenueConfigServiceLive: Layer.Layer<
  RevenueConfigService,
  never,
  DbService | ConfigService
> = Layer.effect(
  RevenueConfigService,
  Effect.gen(function* () {
    const db = yield* DbService;
    const config = yield* ConfigService;
    const paperTrading = config.paperTrading;

    return {
      getConfig: (): Effect.Effect<RevenueConfig, never> => resolveConfig(db, paperTrading),
      refreshConfig: (): Effect.Effect<RevenueConfig, never> => forceRefresh(db, paperTrading),
    };
  }),
);
