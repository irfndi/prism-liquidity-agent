import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import { ConfigService } from "../engine/config-service.js";
import { DbLive } from "../engine/db-service.js";
import { DbService } from "../engine/services.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function run<T, R>(effect: Effect.Effect<T, unknown, R>, layer: Layer.Layer<R, never, never>): T {
  return Effect.runSync(Effect.provide(effect, layer));
}

function buildLayer(overrides: Partial<{
  forceUpdateEnabled: boolean;
  forceUpdateAfterDays: number;
  updateCheckIntervalMs: number;
}> = {}) {
  const mockConfig = Layer.succeed(ConfigService, {
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
    updateCheckIntervalMs: overrides.updateCheckIntervalMs ?? 21_600_000,
    updateChannel: "stable" as const,
    updateGithubRepo: "",
    updateAllowDirty: false,
    updateR2PublicUrl: "",
    forceUpdateEnabled: overrides.forceUpdateEnabled ?? false,
    forceUpdateAfterDays: overrides.forceUpdateAfterDays ?? 14,
    githubToken: "",
    githubRepo: "",
    feedbackOptOut: false,
    paperModeExitLive: false,
    revenueShareEnabled: false,
    revenueShareOperatorPct: 50,
  });
  return Layer.merge(mockConfig, DbLive(":memory:"));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("auto-update configuration", () => {
  it("defaults to disabled", () => {
    const layer = buildLayer();
    run(
      Effect.gen(function* () {
        const config = yield* ConfigService;
        expect(config.forceUpdateEnabled).toBe(false);
        expect(config.forceUpdateAfterDays).toBe(14);
      }),
      layer,
    );
  });

  it("can be enabled with custom days", () => {
    const layer = buildLayer({ forceUpdateEnabled: true, forceUpdateAfterDays: 7 });
    run(
      Effect.gen(function* () {
        const config = yield* ConfigService;
        expect(config.forceUpdateEnabled).toBe(true);
        expect(config.forceUpdateAfterDays).toBe(7);
      }),
      layer,
    );
  });

  it("accepts 1 day minimum", () => {
    const layer = buildLayer({ forceUpdateEnabled: true, forceUpdateAfterDays: 1 });
    run(
      Effect.gen(function* () {
        const config = yield* ConfigService;
        expect(config.forceUpdateAfterDays).toBe(1);
      }),
      layer,
    );
  });
});

describe("metadata storage", () => {
  it("stores and retrieves metadata", () => {
    const layer = buildLayer();
    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.setMetadata("test-key", "test-value");
        const value = yield* db.getMetadata("test-key");
        expect(value).toBe("test-value");
      }),
      layer,
    );
  });

  it("returns null for missing keys", () => {
    const layer = buildLayer();
    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        const value = yield* db.getMetadata("non-existent");
        expect(value).toBeNull();
      }),
      layer,
    );
  });

  it("overwrites existing metadata", () => {
    const layer = buildLayer();
    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.setMetadata("key1", "value1");
        yield* db.setMetadata("key1", "value2");
        const value = yield* db.getMetadata("key1");
        expect(value).toBe("value2");
      }),
      layer,
    );
  });
});

describe("force update threshold calculation", () => {
  it("calculates days correctly", () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    const installedAt = now - 15 * dayMs;
    const daysSinceInstall = Math.floor((now - installedAt) / dayMs);
    expect(daysSinceInstall).toBe(15);

    const threshold = 14;
    expect(daysSinceInstall > threshold).toBe(true);
  });

  it("detects when threshold is not exceeded", () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    const installedAt = now - 10 * dayMs;
    const daysSinceInstall = Math.floor((now - installedAt) / dayMs);
    expect(daysSinceInstall).toBe(10);

    const threshold = 14;
    expect(daysSinceInstall > threshold).toBe(false);
  });
});
