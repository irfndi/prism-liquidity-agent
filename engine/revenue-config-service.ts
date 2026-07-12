import { Effect, Layer } from "effect";
import { ConfigService } from "./config-service.js";
import { DbService, RevenueConfigService, type DbApi, type RevenueConfig } from "./services.js";
import { createLogger } from "./logger.js";
import fs from "fs";
import path from "path";
import os from "os";

const log = createLogger("revenue-config-service");

const API_BASE_URL = "https://prism-api.irfndi.workers.dev";
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const CREDENTIALS_FILE = path.join(os.homedir(), ".config", "prism", "credentials.json");
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

function readApiKey(): Effect.Effect<string | null, never> {
  return Effect.try({
    try: () => {
      const raw = fs.readFileSync(CREDENTIALS_FILE, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || !("apiKey" in parsed)) return null;
      const key = (parsed as { apiKey: unknown }).apiKey;
      return typeof key === "string" && key.length > 0 ? key : null;
    },
    catch: (cause) => cause,
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));
}

function parseRevenueConfig(data: unknown): RevenueConfig | null {
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;
  return {
    tier: typeof obj.tier === "string" ? obj.tier : "free",
    platformFeeRate: typeof obj.platformFeeRate === "number" ? obj.platformFeeRate : 0,
    revenueShareEnabled:
      typeof obj.revenueShareEnabled === "boolean" ? obj.revenueShareEnabled : false,
    revenueShareOperatorPct:
      typeof obj.revenueShareOperatorPct === "number" ? obj.revenueShareOperatorPct : 0,
    feeWalletAddress: typeof obj.feeWalletAddress === "string" ? obj.feeWalletAddress : "",
  };
}

function fetchConfigFromApi(apiKey: string): Effect.Effect<RevenueConfig, unknown> {
  return Effect.gen(function* () {
    const res = yield* Effect.tryPromise(() =>
      fetch(`${API_BASE_URL}/v1/config`, {
        headers: { Authorization: `Bearer ${apiKey}` },
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

function loadFromDb(db: DbApi): Effect.Effect<RevenueConfig | null, unknown> {
  return Effect.gen(function* () {
    const raw = yield* db.getMetadata(METADATA_KEY);
    if (raw === null) return null;
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: () => null,
    });
    return parseRevenueConfig(parsed);
  });
}

function saveToDb(db: DbApi, config: RevenueConfig): Effect.Effect<void, unknown> {
  return db.setMetadata(METADATA_KEY, JSON.stringify(config));
}

function fetchWithRetry(apiKey: string): Effect.Effect<RevenueConfig, unknown> {
  return Effect.gen(function* () {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const result = yield* Effect.either(fetchConfigFromApi(apiKey));
      if (result._tag === "Right") {
        return result.right;
      }
      lastError = result.left;
      if (attempt < MAX_RETRIES - 1) {
        yield* Effect.sleep(RETRY_DELAY_MS);
      }
    }
    return yield* Effect.fail(lastError);
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

    const result = yield* Effect.either(fetchWithRetry(apiKey));
    if (result._tag === "Right") {
      cached = { config: result.right, expiresAt: Date.now() + CACHE_TTL_MS };
      yield* Effect.ignoreLogged(saveToDb(db, result.right));
      return result.right;
    }

    log.warn("Failed to fetch revenue config from API, trying DB cache");
    const fromDb = yield* Effect.either(loadFromDb(db));
    if (fromDb._tag === "Right" && fromDb.right !== null) {
      cached = { config: fromDb.right, expiresAt: Date.now() + CACHE_TTL_MS };
      return fromDb.right;
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

    const result = yield* Effect.either(fetchWithRetry(apiKey));
    if (result._tag === "Right") {
      cached = { config: result.right, expiresAt: Date.now() + CACHE_TTL_MS };
      yield* Effect.ignoreLogged(saveToDb(db, result.right));
      return result.right;
    }

    const fromDb = yield* Effect.either(loadFromDb(db));
    if (fromDb._tag === "Right" && fromDb.right !== null) {
      cached = { config: fromDb.right, expiresAt: Date.now() + CACHE_TTL_MS };
      return fromDb.right;
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
