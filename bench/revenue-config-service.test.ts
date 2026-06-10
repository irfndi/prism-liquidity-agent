import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import { ConfigService, type AppConfig } from "../engine/config-service.js";
import { DbLive } from "../engine/db-service.js";
import { DbService, RevenueConfigService } from "../engine/services.js";
import fs from "fs";

let RevenueConfigServiceLive: typeof import("../engine/revenue-config-service.js").RevenueConfigServiceLive;

const originalFetch = globalThis.fetch;

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    walletPrivateKey: "",
    heliusApiKey: "",
    solanaRpcUrl: "",
    paperTrading: true,
    scanIntervalMs: 600_000,
    minPoolTvlUsd: 50_000,
    minFeeIlRatio: 1.2,
    tvlDropExitPct: 0.3,
    volumeAuthThreshold: 0.7,
    maxConcurrentPositions: 5,
    minRebalanceIntervalMs: 86_400_000,
    minRebalanceNetBenefitUsd: 10,
    confidenceThreshold: 0.65,
    paperPortfolioUsd: 10_000,
    minBinUtilization: 0.3,
    maxRebalanceRangeBins: 50,
    watchlistPools: [],
    stopLossPct: 0.15,
    trailingStopPct: 0.1,
    oorGracePeriodCycles: 3,
    feeClaimIntervalMs: 86_400_000,
    enablePoolDiscovery: false,
    discoveryMinTvlUsd: 100_000,
    discoveryMinFeeRatio: 1.5,
    deployerBlacklistPath: "",
    tokenBlacklistPath: "",
    sqliteDbPath: "",
    enableSnapshotCapture: false,
    autoUpdate: true,
    updateCheckIntervalMs: 21_600_000,
    updateChannel: "stable" as const,
    updateGithubRepo: "",
    updateAllowDirty: false,
    forceUpdateEnabled: false,
    forceUpdateAfterDays: 14,
    updateR2PublicUrl: "",
    githubToken: "",
    githubRepo: "",
    feedbackOptOut: false,
    paperModeExitLive: false,
    ...overrides,
  };
}

function buildLayer(
  overrides: Partial<AppConfig> = {},
): Layer.Layer<RevenueConfigService | DbService, never, never> {
  const mockConfig = Layer.succeed(ConfigService, makeConfig(overrides));
  const dbLayer = DbLive(":memory:");
  const revenueConfigDeps = Layer.merge(mockConfig, dbLayer);
  const revenueConfig = Layer.provide(RevenueConfigServiceLive, revenueConfigDeps);
  return Layer.merge(revenueConfig, dbLayer) as Layer.Layer<
    RevenueConfigService | DbService,
    never,
    never
  >;
}

function mockCredentialsFile(apiKey = "test-api-key"): void {
  vi.spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor) => {
    if (typeof path === "string" && path.includes("credentials.json")) {
      return JSON.stringify({
        apiKey,
        userId: "test-user",
        createdAt: "2024-01-01T00:00:00Z",
      });
    }
    throw new Error(`ENOENT: no such file: ${String(path)}`);
  }) as typeof fs.readFileSync);
}

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("../engine/revenue-config-service.js");
  RevenueConfigServiceLive = mod.RevenueConfigServiceLive;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ─── Paper mode: fail-open ──────────────────────────────────────────────────

describe("RevenueConfigService — paper mode fail-open", () => {
  it("returns default config when API is unreachable", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("network error")) as unknown as typeof fetch;
    mockCredentialsFile();
    const layer = buildLayer({ paperTrading: true });

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* RevenueConfigService;
          return yield* svc.getConfig();
        }),
        layer,
      ),
    );

    expect(result.tier).toBe("free");
    expect(result.platformFeeRate).toBe(0);
    expect(result.revenueShareEnabled).toBe(false);
    expect(result.revenueShareOperatorPct).toBe(0);
    expect(result.feeWalletAddress).toBe("");
  }, 15_000);
});

// ─── Live mode: fail-closed ─────────────────────────────────────────────────

describe("RevenueConfigService — live mode fail-closed", () => {
  it("throws when API is unreachable and no DB cache exists", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("network error")) as unknown as typeof fetch;
    mockCredentialsFile();
    const layer = buildLayer({ paperTrading: false });

    const program = Effect.provide(
      Effect.gen(function* () {
        const svc = yield* RevenueConfigService;
        return yield* svc.getConfig();
      }),
      layer,
    );

    await expect(Effect.runPromise(program)).rejects.toBeDefined();
  }, 15_000);
});

// ─── SQLite caching ─────────────────────────────────────────────────────────

describe("RevenueConfigService — SQLite caching", () => {
  it("saves fetched config to metadata table and serves subsequent calls from in-memory cache", async () => {
    const proConfig = {
      tier: "pro",
      platformFeeRate: 0.05,
      revenueShareEnabled: true,
      revenueShareOperatorPct: 0.2,
      feeWalletAddress: "ProWallet1111111111111111111111111111111111",
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(proConfig),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    mockCredentialsFile();
    const layer = buildLayer();

    const program = Effect.provide(
      Effect.gen(function* () {
        const svc = yield* RevenueConfigService;
        const first = yield* svc.getConfig();
        const second = yield* svc.getConfig();
        const db = yield* DbService;
        const cached = yield* db.getMetadata("revenue_config");
        return { first, second, cached };
      }),
      layer,
    );

    const { first, second, cached } = await Effect.runPromise(program);

    expect(first.tier).toBe("pro");
    expect(first.platformFeeRate).toBe(0.05);
    expect(first.feeWalletAddress).toBe(proConfig.feeWalletAddress);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(cached).not.toBeNull();
    const parsed = JSON.parse(cached!);
    expect(parsed.tier).toBe("pro");
    expect(parsed.platformFeeRate).toBe(0.05);
    expect(parsed.feeWalletAddress).toBe(proConfig.feeWalletAddress);
  });
});

// ─── refreshConfig bypasses cache ───────────────────────────────────────────

describe("RevenueConfigService — refreshConfig", () => {
  it("bypasses in-memory cache and refetches from API", async () => {
    const firstConfig = {
      tier: "pro",
      platformFeeRate: 0.05,
      revenueShareEnabled: true,
      revenueShareOperatorPct: 0.2,
      feeWalletAddress: "FirstWallet1111111111111111111111111111111",
    };
    const secondConfig = {
      tier: "enterprise",
      platformFeeRate: 0.1,
      revenueShareEnabled: false,
      revenueShareOperatorPct: 0,
      feeWalletAddress: "SecondWallet111111111111111111111111111111",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(firstConfig),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(secondConfig),
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    mockCredentialsFile();
    const layer = buildLayer();

    const program = Effect.provide(
      Effect.gen(function* () {
        const svc = yield* RevenueConfigService;
        const first = yield* svc.getConfig();
        const refreshed = yield* svc.refreshConfig();
        return { first, refreshed };
      }),
      layer,
    );

    const { first, refreshed } = await Effect.runPromise(program);

    expect(first.tier).toBe("pro");
    expect(refreshed.tier).toBe("enterprise");
    expect(refreshed.platformFeeRate).toBe(0.1);
    expect(refreshed.feeWalletAddress).toBe(secondConfig.feeWalletAddress);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ─── In-memory cache within TTL ─────────────────────────────────────────────

describe("RevenueConfigService — in-memory cache within TTL", () => {
  it("serves repeated calls from in-memory cache without hitting API", async () => {
    const config = {
      tier: "pro",
      platformFeeRate: 0.05,
      revenueShareEnabled: true,
      revenueShareOperatorPct: 0.2,
      feeWalletAddress: "CachedWallet111111111111111111111111111111",
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(config),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    mockCredentialsFile();
    const layer = buildLayer();

    const program = Effect.provide(
      Effect.gen(function* () {
        const svc = yield* RevenueConfigService;
        const results: string[] = [];
        for (let i = 0; i < 5; i++) {
          const cfg = yield* svc.getConfig();
          results.push(cfg.tier);
        }
        return results;
      }),
      layer,
    );

    const tiers = await Effect.runPromise(program);

    expect(tiers).toEqual(["pro", "pro", "pro", "pro", "pro"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
