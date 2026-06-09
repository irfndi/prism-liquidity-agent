import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { ConfigService } from "../engine/config-service.js";
import { DbLive } from "../engine/db-service.js";
import { AuditLive } from "../engine/audit-service.js";
import { calculateRevenueShare } from "../engine/adapter-service.js";

function runAsync<T>(effect: Effect.Effect<T, unknown, never>): Promise<T> {
  return Effect.runPromise(effect);
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
    revenueShareOperatorPct: overrides.revenueShareOperatorPct ?? 0,
  });
  const baseLayer = Layer.merge(mockConfig, DbLive(":memory:"));
  return Layer.merge(Layer.provide(AuditLive, DbLive(":memory:")), baseLayer);
}

describe("revenue share configuration", () => {
  it("defaults to disabled", async () => {
    const layer = buildLayer();
    await runAsync(
      Effect.gen(function* () {
        const config = yield* ConfigService;
        expect(config.revenueShareEnabled).toBe(false);
        expect(config.revenueShareOperatorPct).toBe(0);
      }).pipe(Effect.provide(layer)),
    );
  });

  it("can be enabled with custom percentage", async () => {
    const layer = buildLayer({ revenueShareEnabled: true, revenueShareOperatorPct: 75 });
    await runAsync(
      Effect.gen(function* () {
        const config = yield* ConfigService;
        expect(config.revenueShareEnabled).toBe(true);
        expect(config.revenueShareOperatorPct).toBe(75);
      }).pipe(Effect.provide(layer)),
    );
  });

  it("accepts 0% operator share", async () => {
    const layer = buildLayer({ revenueShareEnabled: true, revenueShareOperatorPct: 0 });
    await runAsync(
      Effect.gen(function* () {
        const config = yield* ConfigService;
        expect(config.revenueShareOperatorPct).toBe(0);
      }).pipe(Effect.provide(layer)),
    );
  });
});

describe("revenue share fee calculation", () => {
  const FEE_WALLET = "FeeWallet1111111111111111111111111111111111";
  const OPERATOR_WALLET = "OperatorWallet111111111111111111111111111111";

  it("when disabled, operator gets 0%", () => {
    const result = calculateRevenueShare(100, 200, 0.1, false, 50, FEE_WALLET, OPERATOR_WALLET);
    expect(result.operatorFeeX).toBe(0);
    expect(result.operatorFeeY).toBe(0);
    expect(result.amountToTransferX).toBe(10); // full platform fee transferred
  });

  it("when enabled 50%, operator gets half", () => {
    const result = calculateRevenueShare(100, 200, 0.1, true, 50, FEE_WALLET, OPERATOR_WALLET);
    expect(result.operatorFeeX).toBe(5); // floor(10 * 0.5)
    expect(result.operatorFeeY).toBe(10); // floor(20 * 0.5)
    expect(result.amountToTransferX).toBe(5); // 10 - 5
    expect(result.amountToTransferY).toBe(10); // 20 - 10
  });

  it("when enabled 100%, operator gets all", () => {
    const result = calculateRevenueShare(100, 200, 0.1, true, 100, FEE_WALLET, OPERATOR_WALLET);
    expect(result.operatorFeeX).toBe(10); // floor(10 * 1.0)
    expect(result.operatorFeeY).toBe(20); // floor(20 * 1.0)
    expect(result.amountToTransferX).toBe(0); // 10 - 10
    expect(result.amountToTransferY).toBe(0); // 20 - 20
  });

  it("when enabled 0%, operator gets nothing", () => {
    const result = calculateRevenueShare(100, 200, 0.1, true, 0, FEE_WALLET, OPERATOR_WALLET);
    expect(result.operatorFeeX).toBe(0);
    expect(result.operatorFeeY).toBe(0);
    expect(result.amountToTransferX).toBe(10); // full platform fee transferred
  });

  it("circular wallet detection: operator wallet == fee wallet", () => {
    const result = calculateRevenueShare(100, 200, 0.1, true, 50, OPERATOR_WALLET, OPERATOR_WALLET);
    expect(result.isCircular).toBe(true);
    expect(result.amountToTransferX).toBe(0);
    expect(result.amountToTransferY).toBe(0);
  });
});
