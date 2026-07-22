import { Effect, Layer } from "effect";
import { vi } from "vitest";
import type { PoolState, BinArray, AgentDecision } from "../engine/types.js";
import type { PositionRecord } from "../engine/db-service.js";
import type { AppConfig } from "../engine/config-service.js";

// ─── Pool & Bin ──────────────────────────────────────────────────────────────

export function makePool(overrides: Partial<PoolState> = {}): PoolState {
  return {
    address: "TestPool111111111111111111111111111111111111",
    tokenX: "So11111111111111111111111111111111111111112",
    tokenY: "FakeToken1111111111111111111111111111111111",
    tokenXSymbol: "SOL",
    tokenYSymbol: "USDC",
    tvlUsd: 100_000,
    volume24hUsd: 30_000,
    fees24hUsd: 300,
    apr: 60,
    activeBinId: 5000,
    binStep: 10,
    currentPrice: 150,
    timestamp: Date.now(),
    ...overrides,
  };
}

export function makeBinArray(activeBinId = 5000, halfWidth = 20): BinArray {
  const bins = Array.from({ length: halfWidth * 2 }, (_, i) => ({
    binId: activeBinId - halfWidth + i,
    price: 150 + (i - halfWidth) * 0.1,
    reserveX: BigInt(1_000_000),
    reserveY: BigInt(1_000_000),
    liquiditySupply: BigInt(1_000_000_000),
  }));
  return {
    lowerBinId: activeBinId - halfWidth,
    upperBinId: activeBinId + halfWidth - 1,
    bins,
    activeBinId,
  };
}

// ─── Decision ────────────────────────────────────────────────────────────────

export function makeDecision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return {
    action: "HOLD",
    poolAddress: "TestPool111111111111111111111111111111111111",
    confidence: 0.75,
    reasoning: "Test decision",
    ...overrides,
  };
}

// ─── Position (DB record) ────────────────────────────────────────────────────

export function makePosition(overrides: Partial<PositionRecord> = {}): PositionRecord {
  const poolAddress = overrides.poolAddress ?? "Pool111111111111111111111111111111111111111";
  const positionPubKey = overrides.positionPubKey ?? null;
  return {
    positionId: overrides.positionId ?? positionPubKey ?? `paper-${poolAddress}`,
    poolAddress,
    positionPubKey,
    depositedUsd: overrides.depositedUsd ?? 1000,
    currentValueUsd: overrides.currentValueUsd ?? 1000,
    tokenXSymbol: "SOL",
    tokenYSymbol: "USDC",
    activeBinId: 5000,
    lowerBinId: 4980,
    upperBinId: 5020,
    timestamp: Date.now(),
    outOfRangeSince: null,
    oorCycleCount: 0,
    lastFeeClaimAt: overrides.lastFeeClaimAt ?? Date.now(),
    trailingStopThreshold: overrides.trailingStopThreshold ?? null,
    highestValueUsd: overrides.highestValueUsd ?? null,
    lastRebalanceAt: overrides.lastRebalanceAt ?? 0,
    paperExitedAt: overrides.paperExitedAt ?? null,
    entrySignalTimestamp: overrides.entrySignalTimestamp ?? null,
    entrySignalSnapshotId: overrides.entrySignalSnapshotId ?? null,
    entryPriceUsd: overrides.entryPriceUsd ?? null,
    entryAmountXUsd: overrides.entryAmountXUsd ?? null,
    entryAmountYUsd: overrides.entryAmountYUsd ?? null,
    cumulativeFeesClaimedUsd: overrides.cumulativeFeesClaimedUsd ?? 0,
    cumulativeRewardsClaimedUsd: overrides.cumulativeRewardsClaimedUsd ?? 0,
    closedAt: overrides.closedAt ?? null,
    realizedPnlUsd: overrides.realizedPnlUsd ?? null,
  };
}

// ─── AppConfig defaults ─────────────────────────────────────────────────────

export function defaultAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
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
    updateChannel: "stable",
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
    meteoraDatapiBaseUrl: "https://dlmm.datapi.meteora.ag",
    stablecoinMints: new Set(),
    depegAbsoluteUsd: 0.02,
    depegRelativePct: 0.02,
    liquidityDrainPct: 0.5,
    liquidityDrainLookbackSnapshots: 2,
    freezeSmartScreening: false,
    // Pinned false (production default is true) to keep existing engine tests byte-identical.
    ilProtectionEnabled: false,
    ilDominanceExitFactor: 2,
    ilDominanceMinUsd: 5,
    // Pinned false (production default is true) so the token-risk overlay never
    // fires for the existing ~80 test files; feature tests enable it explicitly.
    jupiterTokenRiskEnabled: false,
    jupiterTokenRiskCacheTtlMin: 30,
    // Pinned false (production default true) so the gecko secondary stats source
    // never touches the network for the existing program tests; stats-pipeline
    // tests opt in explicitly.
    geckoTerminalEnabled: false,
    rebalanceGasCostSol: 0.01,
    solPriceUsd: 150,
    gasAwareMinDaysOfFeesPaidAhead: 3,
    volatilityExitStddev: 5,
    volatilityLookbackSnapshots: 12,
    volatilityWideHalfWidthBins: 50,
    entryRangeHalfWidthBins: 0,
    volatilityAdaptiveRanges: false,
    autoCompoundFees: false,
    minCompoundFeesUsd: 0.5,
    compoundGasBufferUsd: 0.05,
    oorRecoveryLookbackCycles: 10,
    oorRecoveryHoldThreshold: 0.6,
    oorRecoveryForceRebalanceThreshold: 0.2,
    maxPerPoolAllocationPct: 0.4,
    maxOpenPositions: 3,
    maxPositionsPerPool: 2,
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
    agentOpenclawWebhookToken: "",
    agentHermesApiToken: "",
    agentHttpPort: 18_790,
    agentMcpEnabled: true,
    agentProposalMode: "veto",
    agentProposalToken: "",
    agentApprovalToken: "",
    agentProposalTimeoutMs: 15_000,
    agentProposalMaxBatchSize: 10,
    agentProposalMaxQueueSize: 50,
    agentProposalStaleMs: 300_000,
    agentProposalBackoffBaseMs: 60_000,
    agentProposalBackoffMaxMs: 3_600_000,
    agentProposalMaxPositionSizePct: 0.4,
    agentProposalMinConfidence: 0.65,
    agentProposalCircuitBreakerThreshold: 5,
    agentProposalCircuitBreakerCooldownMs: 300_000,
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
    entryStrategyType: "spot",
    farmRewardsEnabled: true,
    snapshotRetentionDays: 14,
    alertsEnabled: true,
    alertCooldownMinutes: 120,
    alertFeeMilestoneUsd: 10,
    ...overrides,
  };
}

// ─── Effect runners ──────────────────────────────────────────────────────────

export function run<T, R>(
  effect: Effect.Effect<T, unknown, R>,
  layer: Layer.Layer<R, never, never>,
): T {
  return Effect.runSync(Effect.provide(effect, layer));
}

export async function runAsync<T>(effect: Effect.Effect<T, unknown, never>): Promise<T> {
  return Effect.runPromise(effect);
}

// ─── Fetch mock ──────────────────────────────────────────────────────────────

export function mockFetch(impl: unknown): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(impl as typeof fetch) as unknown as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}
