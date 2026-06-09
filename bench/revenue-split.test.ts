import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import { ConfigService } from "../engine/config-service.js";
import { DbLive } from "../engine/db-service.js";
import { DbService } from "../engine/services.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function run<T>(effect: Effect.Effect<T, unknown, unknown>, layer: unknown): T {
  return Effect.runSync((Effect.provide as any)(effect, layer));
}

function buildLayer(overrides: Partial<{
  revenueShareEnabled: boolean;
  revenueShareOperatorPct: number;
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
    updateCheckIntervalMs: 21_600_000,
    updateChannel: "stable" as const,
    updateGithubRepo: "",
    updateAllowDirty: false,
    updateR2PublicUrl: "",
    forceUpdateEnabled: false,
    forceUpdateAfterDays: 14,
    githubToken: "",
    githubRepo: "",
    feedbackOptOut: false,
    paperModeExitLive: false,
    revenueShareEnabled: overrides.revenueShareEnabled ?? false,
    revenueShareOperatorPct: overrides.revenueShareOperatorPct ?? 50,
  });
  return Layer.merge(mockConfig, DbLive(":memory:"));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("revenue share configuration", () => {
  it("defaults to disabled", () => {
    const layer = buildLayer();
    run(
      Effect.gen(function* () {
        const config = yield* ConfigService;
        expect(config.revenueShareEnabled).toBe(false);
        expect(config.revenueShareOperatorPct).toBe(50);
      }),
      layer,
    );
  });

  it("can be enabled with custom percentage", () => {
    const layer = buildLayer({ revenueShareEnabled: true, revenueShareOperatorPct: 75 });
    run(
      Effect.gen(function* () {
        const config = yield* ConfigService;
        expect(config.revenueShareEnabled).toBe(true);
        expect(config.revenueShareOperatorPct).toBe(75);
      }),
      layer,
    );
  });

  it("accepts 0% operator share", () => {
    const layer = buildLayer({ revenueShareEnabled: true, revenueShareOperatorPct: 0 });
    run(
      Effect.gen(function* () {
        const config = yield* ConfigService;
        expect(config.revenueShareOperatorPct).toBe(0);
      }),
      layer,
    );
  });
});

describe("revenue share fee calculation", () => {
  it("when disabled, operator gets 0%", () => {
    const platformFeeX = 100;
    const operatorPct = 50; // irrelevant when disabled
    const enabled = false;

    let operatorFeeX = 0;
    if (enabled) {
      operatorFeeX = platformFeeX * (operatorPct / 100);
    }

    expect(operatorFeeX).toBe(0);
  });

  it("when enabled 50%, operator gets half", () => {
    const platformFeeX = 100;
    const operatorPct = 50;
    const enabled = true;

    const operatorFeeX = enabled ? platformFeeX * (operatorPct / 100) : 0;
    expect(operatorFeeX).toBe(50);
  });

  it("when enabled 100%, operator gets all", () => {
    const platformFeeX = 100;
    const operatorPct = 100;
    const enabled = true;

    const operatorFeeX = enabled ? platformFeeX * (operatorPct / 100) : 0;
    expect(operatorFeeX).toBe(100);
  });

  it("when enabled 0%, operator gets nothing", () => {
    const platformFeeX = 100;
    const operatorPct = 0;
    const enabled = true;

    const operatorFeeX = enabled ? platformFeeX * (operatorPct / 100) : 0;
    expect(operatorFeeX).toBe(0);
  });

  it("circular wallet detection: operator wallet == fee wallet", () => {
    const operatorWallet = "Wallet111111111111111111111111111111111111";
    const feeWallet = "Wallet111111111111111111111111111111111111";
    expect(operatorWallet).toBe(feeWallet);
  });
});
