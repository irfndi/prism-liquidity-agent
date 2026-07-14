import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { ConfigService } from "../engine/config-service.js";
import { DbLive } from "../engine/db-service.js";
import { AuditLive } from "../engine/audit-service.js";
import { calculateRevenueShare } from "../engine/adapter-service.js";

function runAsync<T>(effect: Effect.Effect<T, unknown, never>): Promise<T> {
  return Effect.runPromise(effect);
}

function buildLayer() {
  const mockConfig = Layer.succeed(ConfigService, {
    walletPrivateKey: "",
    heliusApiKey: "",
    solanaRpcUrl: "",
    solanaRpcFallbackUrl: "",
    paperTrading: true,
    scanIntervalMs: 600_000,
    minPoolTvlUsd: 50_000,
    minFeeIlRatio: 1.2,
    tvlDropExitPct: 0.3,
    volumeAuthThreshold: 0.7,
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
    meteoraPoolsUrl:
      "https://dlmm.datapi.meteora.ag/pools?page=1&page_size=1000&filter_by=is_blacklisted=false&sort_by=tvl:desc",
    rebalanceGasCostSol: 0.01,
    solPriceUsd: 150,
    gasAwareMinDaysOfFeesPaidAhead: 3,
    volatilityExitStddev: 5,
    volatilityLookbackSnapshots: 12,
    volatilityWideHalfWidthBins: 50,
    autoCompoundFees: false,
    minCompoundFeesUsd: 0.5,
    compoundGasBufferUsd: 0.05,
    oorRecoveryLookbackCycles: 10,
    oorRecoveryHoldThreshold: 0.6,
    oorRecoveryForceRebalanceThreshold: 0.2,
    maxPerPoolAllocationPct: 0.4,
    maxOpenPositions: 3,
    paperValidationMinDays: 7,
    paperValidationEnforce: false,
    agentiveMode: false,
    agentRuntime: "none",
    agentAcpCommand: "hermes",
    agentAcpArgs: ["acp"],
    agentGatewayUrl: "ws://127.0.0.1:18789",
    agentGatewayToken: "",
    agentPromptTimeoutMs: 15_000,
    agentCheckinIntervalMs: 3_600_000,
    agentCheckinOnEvents: true,
    agentCheckinIncludeHistory: true,
    agentCheckinMaxPositions: 10,
    agentOpenclawWebhookUrl: "",
    agentHermesApiUrl: "",
    agentHttpPort: 18_790,
    agentMcpEnabled: true,
    oorCooldownMs: 4 * 60 * 60 * 1000,
    repeatOorCooldownMs: 12 * 60 * 60 * 1000,
    maxOorCooldownExits: 3,
    evolutionInterval: 5,
    evolutionMaxChangePct: 0.2,
    signalWeightWindowDays: 60,
    signalWeightMinOutcomes: 10,
    signalWeightBoostFactor: 1.05,
    signalWeightDecayFactor: 0.95,
    signalWeightFloor: 0.3,
    signalWeightCeiling: 2.5,
    weightedEntryScoreThreshold: 1.8,
    autoSwapEntry: false,
  });
  const baseLayer = Layer.merge(mockConfig, DbLive(":memory:"));
  return Layer.merge(Layer.provide(AuditLive, DbLive(":memory:")), baseLayer);
}

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
