import { Effect, Layer } from "effect";
import { vi } from "vitest";
import type { PoolState, BinArray, AgentDecision } from "../engine/types.js";
import type { PositionRecord } from "../engine/db-service.js";
import type { AppConfig } from "../engine/config-service.js";
import { StrategyLive } from "../engine/strategy-service.js";
import { DbLive } from "../engine/db-service.js";
import { MemoryLive } from "../engine/memory-service.js";
import { RiskLive } from "../engine/risk-service.js";
import { AuditLive } from "../engine/audit-service.js";
import { AgentNoOp } from "../engine/agent-service.js";
import { AgentStateMutable } from "../engine/state-service.js";
import { ConfigService } from "../engine/config-service.js";
import {
  AdapterService,
  BlacklistService,
  ScreenerService,
  DbService,
  MemoryService,
  RevenueService,
  RevenueConfigService,
  ReferralService,
  AgentService,
  McpServerService,
  HttpStatusServerService,
  EntryPrepService,
  MeteoraDatapiService,
  GeckoTerminalService,
  AlertService,
  type AdapterApi,
  type AgentApi,
  type MemoryApi,
  type MeteoraDatapiApi,
  type MeteoraPoolStats,
} from "../engine/services.js";

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
    timestamp: overrides.timestamp ?? Date.now(),
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
    positionMode: overrides.positionMode ?? null,
    tpLadderJson: overrides.tpLadderJson ?? null,
    invalidationStopPrice: overrides.invalidationStopPrice ?? null,
    launchRunner: overrides.launchRunner ?? null,
    launchRunnerSteps: overrides.launchRunnerSteps ?? null,
    launchRunnerAnchorPrice: overrides.launchRunnerAnchorPrice ?? null,
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
    autonomousTokenMode: "off",
    settlementAsset: "SOL",
    candidateMinHealthyScans: 6,
    candidateMinObservationMs: 3_600_000,
    candidateScanLimit: 20,
    candidateMinPoolAgeMs: 86_400_000,
    maxMarketDataAgeMs: 300_000,
    maxSwapSlippageBps: 50,
    maxSwapPriceImpactBps: 100,
    settlementDustUsd: 0.1,
    settlementMaxPendingMs: 3_600_000,
    maxDailyDrawdownPct: 5,
    maxConsecutiveExecutionFailures: 3,
    agentInstanceId: "primary",
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
    trailingStopConfirmCycles: 2,
    oorGracePeriodCycles: 3,
    feeClaimIntervalMs: 86_400_000,
    enablePoolDiscovery: false,
    discoveryMinTvlUsd: 100_000,
    discoveryMinFeeRatio: 1.5,
    marketScanEnabled: false,
    marketScanRefreshIntervalMs: 1_800_000,
    marketScanUniversePages: 3,
    marketScanMinTvlUsd: 250_000,
    marketScanMinFeeApr: 25,
    marketScanTopK: 30,
    marketScanMaxPools: 60,
    marketScanMinHolders: 1000,
    marketScanMinBinStep: 2,
    marketScanMaxBinStep: 200,
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
    dustExitUsd: 5,
    // Pinned false (production default is true) so the token-risk overlay never
    // fires for the existing ~80 test files; feature tests enable it explicitly.
    jupiterTokenRiskEnabled: false,
    jupiterTokenRiskCacheTtlMin: 30,
    // Pinned false (production default true) so the gecko secondary stats source
    // never touches the network for the existing program tests; stats-pipeline
    // tests opt in explicitly.
    geckoTerminalEnabled: false,
    // Pinned false (production default true) for the same reason as gecko — the
    // DexScreener secondary source must never touch the network in existing
    // program tests; stats-pipeline tests opt in explicitly.
    dexscreenerEnabled: false,
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
    maxEntrySizeUsd: 500,
    paperValidationMinDays: 7,
    paperValidationEnforce: false,
    agentiveMode: false,
    agentRuntime: "none",
    agentAcpCommand: "hermes",
    agentAcpArgs: ["acp"],
    agentGatewayUrl: "ws://127.0.0.1:18789",
    agentGatewayToken: "",
    agentPromptTimeoutMs: 15_000,
    agentVetoTimeoutMs: 15_000,
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
    feeDensityCooldowns: true,
    feeDensityCooldownMinMs: 60 * 60 * 1000,
    feeDensityHighPct: 0.005,
    feeDensityLowPct: 0.0005,
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
    idleRedeployEnabled: false,
    idleRedeployThresholdUsd: 500,
    idleRedeployMaxSizeUsd: 2000,
    farmRewardsEnabled: true,
    snapshotRetentionDays: 14,
    alertsEnabled: true,
    alertCooldownMinutes: 120,
    alertFeeMilestoneUsd: 10,
    ...overrides,
  };
}

// ─── Effect runners ──────────────────────────────────────────────────────────

export function run<T, E, R>(
  effect: Effect.Effect<T, E, R>,
  layer: Layer.Layer<R, never, never>,
): T {
  return Effect.runSync(Effect.provide(effect, layer));
}

export async function runAsync<T, E>(effect: Effect.Effect<T, E, never>): Promise<T> {
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

// ─── Shared test factories (imported by decision-loop + harvest-gate) ──────

// ─── Wave 2: phantom EXITs, portfolio math, HOLD spam, snapshot retention ────

type MintAuthorities = { mintAuthority: string | null; freezeAuthority: string | null };
const NO_AUTHORITIES: MintAuthorities = { mintAuthority: null, freezeAuthority: null };

export function makeDatapiStats(overrides: Partial<MeteoraPoolStats> = {}): MeteoraPoolStats {
  return {
    address: "unset",
    name: "TEST",
    tvlUsd: 200_000,
    volume24hUsd: 40_000,
    fees24hUsd: 400,
    apr: 20,
    apy: 20,
    currentPrice: 150,
    feeTvlRatio24h: null,
    feeTvlRatio12h: null,
    feeTvlRatio1h: null,
    dynamicFeePct: null,
    baseFeePct: null,
    hasFarm: null,
    farmApr: null,
    farmApy: null,
    isBlacklisted: null,
    tokenXFreezeAuthorityDisabled: null,
    tokenYFreezeAuthorityDisabled: null,
    tokenXVerified: null,
    tokenYVerified: null,
    ...overrides,
  };
}

export function makeAdapter(
  pools: Record<string, ReturnType<typeof makePool>>,
  overrides: Partial<AdapterApi> = {},
): AdapterApi {
  return {
    hasWallet: () => false,
    getWalletAddress: () => null,
    getWalletBalanceUsd: () => Effect.succeed(10_000),
    getNativeSolBalance: () => Effect.succeed(0n),
    getPoolState: (addr: string) => {
      const pool = pools[addr];
      return pool ? Effect.succeed(pool) : Effect.fail(new Error(`unknown pool ${addr}`));
    },
    getBinArray: () => Effect.succeed(makeBinArray()),
    getPositions: () => Effect.succeed([]),
    getAllWalletPositions: () => Effect.succeed([]),
    simulateRebalance: () =>
      Effect.succeed({
        estimatedFeesUsd: 0,
        estimatedCostUsd: 0,
        netBenefitUsd: 0,
        source: "pool-heuristic" as const,
      }),
    enterPosition: (
      _poolAddress: string,
      _lowerBinId: number,
      _upperBinId: number,
      positionSizeUsd: number,
    ) =>
      Effect.succeed({
        positionPubKey: "mock-pos",
        txSignature: "mock-tx",
        depositMode: "two-sided" as const,
        amountXUsd: positionSizeUsd / 2,
        amountYUsd: positionSizeUsd / 2,
      }),
    exitPosition: () => Effect.succeed({ txSignature: "mock-tx" }),
    rebalancePosition: () =>
      Effect.succeed({ positionPubKey: "mock-pos", txSignatures: ["mock-tx"] }),
    claimFees: () =>
      Effect.succeed({
        txSignature: "mock-tx",
        feeX: 0,
        feeY: 0,
        platformFeeX: 0,
        platformFeeY: 0,
        netFeeX: 0,
        netFeeY: 0,
      }),
    claimRewards: () =>
      Effect.succeed({
        skipped: true,
        skipReason: "no pending rewards",
        txSignatures: [],
        rewards: [],
      }),
    discoverPools: () => Effect.succeed([]),
    reportFeeCollection: () => Effect.void,
    swapUSDCForSOL: () => Effect.void,
    getTokenBalance: () => Effect.succeed(0n),
    getTokenPrices: () => Effect.succeed({}),
    getTokenDecimals: () => Effect.succeed(9),
    quoteSwapUSDCForToken: () => Effect.succeed({}),
    swapUSDCForToken: () => Effect.succeed("mock-swap-tx"),
    getMintAuthorities: () => Effect.succeed(NO_AUTHORITIES),
    ...overrides,
  } as AdapterApi;
}

export interface RecordedMemory {
  category: string;
  content: string;
  poolAddress?: string | undefined;
}

function makeRecordingMemory(record: RecordedMemory[]): MemoryApi {
  return {
    initialize: () => Effect.void,
    upsert: (entry) =>
      Effect.sync(() => {
        record.push({
          category: entry.category,
          content: entry.content,
          poolAddress: entry.poolAddress,
        });
      }),
    getRelevantContext: () => Effect.succeed([]),
    pruneExpired: () => Effect.succeed(0),
    recordOutcome: () => Effect.void,
  };
}

export function makeTestLayer(opts: {
  adapter: AdapterApi;
  memoryRecorded?: RecordedMemory[];
  datapi?: MeteoraDatapiApi;
  configOverrides?: Partial<AppConfig>;
  agent?: AgentApi;
}) {
  const config = defaultAppConfig({
    scanIntervalMs: 3_600_000,
    paperTrading: true,
    agentMcpEnabled: false,
    agentHttpPort: 0,
    ...opts.configOverrides,
  });
  const dbLayer = DbLive(":memory:");
  return Layer.mergeAll(
    Layer.succeed(ConfigService, config),
    Layer.succeed(AdapterService, opts.adapter),
    StrategyLive,
    opts.memoryRecorded
      ? Layer.succeed(MemoryService, makeRecordingMemory(opts.memoryRecorded))
      : Layer.provide(MemoryLive, dbLayer),
    RiskLive({
      confidenceThreshold: 0.65,
      maxRebalanceRangeBins: 50,
      stopLossPct: 0.15,
      maxPerPoolAllocationPct: 0.4,
      maxPositionsPerPool: 2,
    }),
    Layer.succeed(BlacklistService, {
      isDeployerBlacklisted: () => false,
      isTokenBlacklisted: () => false,
      checkPool: () => Effect.void,
    }),
    Layer.provide(AuditLive, dbLayer),
    Layer.succeed(ScreenerService, { screenPools: () => Effect.succeed([]) }),
    dbLayer,
    Layer.succeed(RevenueService, {
      calculateTier: () => "free",
      calculatePlatformFee: () => ({ platformFeeUsd: 0, netFeeX: 0, netFeeY: 0 }),
      calculateCreditDiscount: () => 0,
    }),
    Layer.succeed(RevenueConfigService, {
      getConfig: () =>
        Effect.succeed({
          tier: "free",
          platformFeeRate: 0,
          revenueShareEnabled: false,
          revenueShareOperatorPct: 0,
          feeWalletAddress: "",
        }),
      refreshConfig: () =>
        Effect.succeed({
          tier: "free",
          platformFeeRate: 0,
          revenueShareEnabled: false,
          revenueShareOperatorPct: 0,
          feeWalletAddress: "",
        }),
    }),
    Layer.succeed(ReferralService, {
      generateCode: () => Effect.succeed("code"),
      validateCode: () => Effect.succeed({ valid: false }),
      applyReferral: () => Effect.void,
      getReferralCount: () => Effect.succeed(0),
    }),
    Layer.succeed(AgentService, opts.agent ?? AgentNoOp),
    AgentStateMutable({ maxPendingProposals: 50 }).layer,
    Layer.succeed(McpServerService, { start: () => Effect.void, stop: () => Effect.void }),
    Layer.succeed(HttpStatusServerService, { start: () => Effect.void, stop: () => Effect.void }),
    Layer.succeed(EntryPrepService, { prepareEntryTokens: () => Effect.succeed(undefined) }),
    Layer.succeed(MeteoraDatapiService, opts.datapi ?? { getPoolData: () => Effect.succeed(null) }),
    Layer.succeed(GeckoTerminalService, { getPoolStats: () => Effect.succeed(null) }),
    Layer.succeed(AlertService, {
      sendAlert: () => Effect.void,
      recordFeeClaim: () => Effect.void,
    }),
  );
}

export type DecisionRow = {
  poolAddress: string;
  action: string;
  reasoning: string;
  executed: boolean;
  riskResult: { approved: boolean; reason: string };
};
