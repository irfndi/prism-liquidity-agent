import { Context, Effect } from "effect";
import type { AppConfig } from "./config-service.js";
import type {
  AgentDecision,
  AgentCycle,
  BacktestResult,
  BinArray,
  MemoryCategory,
  MemoryEntry,
  PoolCooldown,
  PoolMetrics,
  PoolSnapshot,
  PoolState,
  Position,
  SignalSnapshot,
  SignalWeights,
} from "./types.js";
import type {
  AgentRuntimeContext,
  AgentRuntimeCheckin,
  AgentRuntimeAlert,
  AgentRuntimeTransport,
} from "./agent-transport.js";
import type {
  PositionSnapshot,
  DecisionSnapshot,
  PortfolioSnapshot,
  PrismStateSnapshot,
} from "./state-service.js";
import type { EvolvableThresholds, OutcomeRecord } from "./strategy-service.js";
import type {
  AdapterError,
  AuditError,
  BlacklistError,
  DiscoverPoolsError,
  EntryPrepError,
  MemoryError,
  RiskError,
  ScreenerError,
} from "./errors.js";

// ─── Adapter Service ─────────────────────────────────────────────────────────

export interface DiscoveredPool {
  readonly address: string;
  readonly tvlUsd: number;
  readonly volume24hUsd: number;
  readonly fees24hUsd: number;
  readonly apr: number;
  readonly binStep: number;
  readonly tokenX: string;
  readonly tokenY: string;
}

export interface AdapterApi {
  readonly hasWallet: () => boolean;
  readonly getWalletAddress: () => string | null;
  readonly getWalletBalanceUsd: () => Effect.Effect<number, unknown>;
  readonly getNativeSolBalance: () => Effect.Effect<bigint, unknown>;
  readonly getPoolState: (poolAddress: string) => Effect.Effect<PoolState, unknown>;
  readonly getBinArray: (poolAddress: string) => Effect.Effect<BinArray, unknown>;
  readonly getPositions: (
    poolAddress: string,
    walletAddress: string,
  ) => Effect.Effect<ReadonlyArray<Position>, unknown>;
  readonly getAllWalletPositions: (walletAddress: string) => Effect.Effect<
    ReadonlyArray<{
      poolAddress: string;
      positionPubKey: string;
      lowerBinId: number;
      upperBinId: number;
    }>,
    unknown
  >;
  readonly simulateRebalance: (
    poolAddress: string,
    newLowerBinId: number,
    newUpperBinId: number,
  ) => Effect.Effect<
    {
      estimatedIlUsd: number;
      estimatedFeesUsd: number;
      netBenefitUsd: number;
    },
    unknown
  >;
  readonly enterPosition: (
    poolAddress: string,
    lowerBinId: number,
    upperBinId: number,
    positionSizeUsd: number,
  ) => Effect.Effect<{ positionPubKey: string; txSignature: string }, unknown>;
  readonly exitPosition: (
    poolAddress: string,
    positionPubKey: string,
  ) => Effect.Effect<{ txSignature: string }, unknown>;
  readonly rebalancePosition: (
    poolAddress: string,
    positionPubKey: string,
    newLowerBinId: number,
    newUpperBinId: number,
  ) => Effect.Effect<
    {
      newPositionPubKey: string;
      txSignatures: ReadonlyArray<string>;
    },
    unknown
  >;
  readonly claimFees: (
    poolAddress: string,
    positionPubKey: string,
    platformFeeRate?: number,
    revenueShareEnabled?: boolean,
    revenueShareOperatorPct?: number,
    feeWalletAddress?: string,
  ) => Effect.Effect<
    {
      txSignature: string;
      feeX: number;
      feeY: number;
      platformFeeX: number;
      platformFeeY: number;
      netFeeX: number;
      netFeeY: number;
      feeTransferTxSignature?: string;
      operatorFeeX?: number;
      operatorFeeY?: number;
    },
    unknown
  >;
  readonly discoverPools: () => Effect.Effect<ReadonlyArray<DiscoveredPool>, DiscoverPoolsError>;
  readonly reportFeeCollection: (event: {
    poolAddress: string;
    positionPubkey?: string;
    feeX: number;
    feeY: number;
    platformFeeX: number;
    platformFeeY: number;
    operatorFeeX?: number;
    operatorFeeY?: number;
    tier: string;
    txSignature: string;
    feeTransferTxSignature?: string;
  }) => Effect.Effect<void, never>;
  readonly swapUSDCForSOL: (
    minSolThreshold?: number,
    swapAmountUSDC?: number,
  ) => Effect.Effect<void, never>;
  readonly getTokenBalance: (mintAddress: string) => Effect.Effect<bigint, unknown>;
  readonly getTokenPrices: (
    mints: ReadonlyArray<string>,
  ) => Effect.Effect<Record<string, number>, unknown>;
  readonly getTokenDecimals: (mintAddress: string) => Effect.Effect<number, unknown>;
  readonly quoteSwapUSDCForToken: (
    outputMint: string,
    amountAtomic: bigint,
  ) => Effect.Effect<Record<string, unknown>, unknown>;
  readonly swapUSDCForToken: (
    outputMint: string,
    amountAtomic: bigint,
    quoteData?: Record<string, unknown>,
  ) => Effect.Effect<string, unknown>;
}

export class AdapterService extends Context.Tag("AdapterService")<AdapterService, AdapterApi>() {}

// ─── Entry Prep Service ───────────────────────────────────────────────────────

export interface EntryPrepApi {
  readonly prepareEntryTokens: (
    poolAddress: string,
    positionSizeUsd: number,
  ) => Effect.Effect<void, EntryPrepError>;
}

export class EntryPrepService extends Context.Tag("EntryPrepService")<
  EntryPrepService,
  EntryPrepApi
>() {}

// ─── Strategy Service ────────────────────────────────────────────────────────

export interface StrategyApi {
  readonly computeMetrics: (
    pool: PoolState,
    binArray: BinArray,
    previousTvlUsd: number,
  ) => PoolMetrics;
  readonly checkVolumeAuthenticity: (pool: PoolState) => {
    score: number;
    flags: ReadonlyArray<string>;
  };
  readonly computeBinUtilization: (binArray: BinArray) => number;
  readonly computeFeeIlRatio: (pool: PoolState, binArray: BinArray) => number;
  readonly recommendBinRange: (
    activeBinId: number,
    binStep: number,
  ) => { lowerBinId: number; upperBinId: number };
  readonly passesPreFilter: (
    pool: PoolState,
    authScore: number,
    binUtilization: number,
    minTvlUsd: number,
    minAuthScore: number,
    minBinUtilization: number,
  ) => boolean;
}

export class StrategyService extends Context.Tag("StrategyService")<
  StrategyService,
  StrategyApi
>() {}

// ─── Memory Service ──────────────────────────────────────────────────────────

export interface MemoryApi {
  readonly initialize: () => Effect.Effect<void, unknown>;
  readonly upsert: (
    entry: Omit<MemoryEntry, "id" | "createdAt" | "expiresAt">,
  ) => Effect.Effect<void, unknown>;
  readonly getRelevantContext: (
    query: string,
    topK?: number,
    poolAddress?: string,
  ) => Effect.Effect<ReadonlyArray<MemoryEntry>, unknown>;
  readonly pruneExpired: () => Effect.Effect<number, unknown>;
  readonly recordOutcome: (
    poolAddress: string,
    action: string,
    pnlUsd: number,
    context: string,
  ) => Effect.Effect<void, unknown>;
}

export class MemoryService extends Context.Tag("MemoryService")<MemoryService, MemoryApi>() {}

// ─── Risk Service ────────────────────────────────────────────────────────────

export interface RiskContext {
  readonly openPositions: ReadonlyArray<Position>;
  readonly portfolioValueUsd: number;
  readonly recentPnlUsd: number;
}

export interface RiskResult {
  readonly approved: boolean;
  readonly reason: string;
  readonly adjustedSizeUsd?: number;
}

export interface RiskApi {
  readonly evaluate: (decision: AgentDecision, ctx: RiskContext) => RiskResult;
}

export class RiskService extends Context.Tag("RiskService")<RiskService, RiskApi>() {}

// ─── Blacklist Service ───────────────────────────────────────────────────────

export interface BlacklistApi {
  readonly isDeployerBlacklisted: (deployer: string) => boolean;
  readonly isTokenBlacklisted: (mint: string) => boolean;
  readonly checkPool: (
    poolAddress: string,
    tokenXMint: string,
    tokenYMint: string,
    tokenXDeployer?: string,
    tokenYDeployer?: string,
  ) => Effect.Effect<void, unknown>;
}

export class BlacklistService extends Context.Tag("BlacklistService")<
  BlacklistService,
  BlacklistApi
>() {}

// ─── Audit Service ───────────────────────────────────────────────────────────

export interface DecisionRecord {
  readonly timestamp: number;
  readonly cycleId: string;
  readonly poolAddress: string;
  readonly action: string;
  readonly confidence: number;
  readonly reasoning: string;
  readonly metrics?: PoolMetrics | undefined;
  readonly riskResult: RiskResult;
  readonly executed: boolean;
  readonly paperTrading: boolean;
  readonly txSignature?: string | undefined;
  readonly error?: string | undefined;
}

export interface AuditApi {
  readonly recordDecision: (record: DecisionRecord) => Effect.Effect<void, unknown>;
  readonly getRecentDecisions: (
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<DecisionRecord>, unknown>;
}

export class AuditService extends Context.Tag("AuditService")<AuditService, AuditApi>() {}

// ─── Screener Service ────────────────────────────────────────────────────────

export interface ScreenedPool {
  readonly address: string;
  readonly tvlUsd: number;
  readonly volume24hUsd: number;
  readonly fees24hUsd: number;
  readonly apr: number;
  readonly feeIlRatio: number;
  readonly volumeAuth: number;
  readonly binUtilization: number;
  readonly tokenX: string;
  readonly tokenY: string;
}

export interface ScreenerApi {
  readonly screenPools: () => Effect.Effect<ReadonlyArray<ScreenedPool>, unknown>;
}

export class ScreenerService extends Context.Tag("ScreenerService")<
  ScreenerService,
  ScreenerApi
>() {}

// ─── Database Service ────────────────────────────────────────────────────────

export interface DbApi {
  readonly db: unknown;
  readonly savePosition: (pos: {
    poolAddress: string;
    positionPubKey: string | null;
    depositedUsd: number;
    currentValueUsd: number;
    tokenXSymbol: string;
    tokenYSymbol: string;
    activeBinId: number;
    lowerBinId: number;
    upperBinId: number;
    timestamp: number;
    outOfRangeSince: number | null;
    oorCycleCount: number;
    lastFeeClaimAt: number;
    trailingStopThreshold: number | null;
    highestValueUsd: number | null;
    lastRebalanceAt: number;
    paperExitedAt: number | null;
    entrySignalTimestamp: number | null;
    entrySignalSnapshotId: number | null;
  }) => Effect.Effect<void, unknown>;
  readonly getPosition: (poolAddress: string) => Effect.Effect<
    {
      poolAddress: string;
      positionPubKey: string | null;
      depositedUsd: number;
      currentValueUsd: number;
      tokenXSymbol: string;
      tokenYSymbol: string;
      activeBinId: number;
      lowerBinId: number;
      upperBinId: number;
      timestamp: number;
      outOfRangeSince: number | null;
      oorCycleCount: number;
      lastFeeClaimAt: number;
      trailingStopThreshold: number | null;
      highestValueUsd: number | null;
      lastRebalanceAt: number;
      paperExitedAt: number | null;
      entrySignalTimestamp: number | null;
      entrySignalSnapshotId: number | null;
    } | null,
    unknown
  >;
  readonly getAllPositions: () => Effect.Effect<
    ReadonlyArray<{
      poolAddress: string;
      positionPubKey: string | null;
      depositedUsd: number;
      currentValueUsd: number;
      tokenXSymbol: string;
      tokenYSymbol: string;
      activeBinId: number;
      lowerBinId: number;
      upperBinId: number;
      timestamp: number;
      outOfRangeSince: number | null;
      oorCycleCount: number;
      lastFeeClaimAt: number;
      trailingStopThreshold: number | null;
      highestValueUsd: number | null;
      lastRebalanceAt: number;
      paperExitedAt: number | null;
      entrySignalTimestamp: number | null;
      entrySignalSnapshotId: number | null;
    }>,
    unknown
  >;
  readonly getPaperExitedPositions: () => Effect.Effect<
    ReadonlyArray<{
      poolAddress: string;
      positionPubKey: string | null;
      depositedUsd: number;
      currentValueUsd: number;
      tokenXSymbol: string;
      tokenYSymbol: string;
      activeBinId: number;
      lowerBinId: number;
      upperBinId: number;
      timestamp: number;
      outOfRangeSince: number | null;
      oorCycleCount: number;
      lastFeeClaimAt: number;
      trailingStopThreshold: number | null;
      highestValueUsd: number | null;
      lastRebalanceAt: number;
      paperExitedAt: number | null;
      entrySignalTimestamp: number | null;
      entrySignalSnapshotId: number | null;
    }>,
    unknown
  >;
  readonly deletePosition: (poolAddress: string) => Effect.Effect<void, unknown>;
  readonly markPaperExited: (poolAddress: string) => Effect.Effect<void, unknown>;
  readonly updatePositionValue: (
    poolAddress: string,
    currentValueUsd: number,
    highestValueUsd?: number,
  ) => Effect.Effect<void, unknown>;
  readonly saveAudit: (record: {
    id: string;
    timestamp: number;
    cycleId: string;
    poolAddress: string;
    action: string;
    confidence: number;
    reasoning: string;
    metricsJson: string | null;
    riskResultJson: string | null;
    executed: boolean;
    paperTrading: boolean;
    txSignature: string | null;
    error: string | null;
  }) => Effect.Effect<void, unknown>;
  readonly getRecentAudit: (limit: number) => Effect.Effect<
    ReadonlyArray<{
      id: string;
      timestamp: number;
      cycleId: string;
      poolAddress: string;
      action: string;
      confidence: number;
      reasoning: string;
      metricsJson: string | null;
      riskResultJson: string | null;
      executed: boolean;
      paperTrading: boolean;
      txSignature: string | null;
      error: string | null;
    }>,
    unknown
  >;
  readonly cacheBlacklist: (
    type: "deployer" | "token",
    values: ReadonlyArray<string>,
  ) => Effect.Effect<void, unknown>;
  readonly isBlacklisted: (
    type: "deployer" | "token",
    value: string,
  ) => Effect.Effect<boolean, unknown>;
  readonly insertMemory: (entry: {
    content: string;
    category: MemoryCategory;
    poolAddress?: string | undefined;
    outcome?: MemoryEntry["outcome"];
    pnlUsd?: number | undefined;
    confidence?: number | undefined;
  }) => Effect.Effect<void, unknown>;
  readonly queryMemory: (
    queryText: string,
    topK: number,
    poolAddress?: string,
  ) => Effect.Effect<ReadonlyArray<MemoryEntry>, unknown>;
  readonly pruneMemory: () => Effect.Effect<number, unknown>;
  readonly saveSnapshot: (snapshot: PoolSnapshot) => Effect.Effect<void, unknown>;
  readonly getSnapshots: (
    poolAddress: string,
    startMs: number,
    endMs: number,
  ) => Effect.Effect<ReadonlyArray<PoolSnapshot>, unknown>;
  readonly getSnapshotPools: () => Effect.Effect<ReadonlyArray<string>, unknown>;
  readonly getSnapshotCount: (poolAddress: string) => Effect.Effect<number, unknown>;
  readonly pruneSnapshots: (olderThanMs: number) => Effect.Effect<number, unknown>;
  readonly saveFeedback: (entry: {
    id: string;
    agentId: string;
    category: string;
    severity: string;
    summary: string;
    details: string | null;
    relatedFiles: ReadonlyArray<string>;
    contextJson: string;
    githubIssueNumber: number | null;
    githubIssueUrl: string | null;
    reportedAt: number;
    hash: string;
  }) => Effect.Effect<void, unknown>;
  readonly getFeedbackByHash: (
    hash: string,
    agentId: string,
  ) => Effect.Effect<
    {
      id: string;
      agentId: string;
      category: string;
      severity: string;
      summary: string;
      details: string | null;
      relatedFiles: ReadonlyArray<string>;
      contextJson: string;
      githubIssueNumber: number | null;
      githubIssueUrl: string | null;
      reportedAt: number;
      hash: string;
    } | null,
    unknown
  >;
  readonly getRecentFeedbackForAgent: (
    agentId: string,
    sinceMs: number,
  ) => Effect.Effect<
    ReadonlyArray<{
      id: string;
      agentId: string;
      category: string;
      severity: string;
      summary: string;
      details: string | null;
      relatedFiles: ReadonlyArray<string>;
      contextJson: string;
      githubIssueNumber: number | null;
      githubIssueUrl: string | null;
      reportedAt: number;
      hash: string;
    }>,
    unknown
  >;
  readonly getLastFeedbackForAgent: (agentId: string) => Effect.Effect<
    {
      id: string;
      agentId: string;
      category: string;
      severity: string;
      summary: string;
      details: string | null;
      relatedFiles: ReadonlyArray<string>;
      contextJson: string;
      githubIssueNumber: number | null;
      githubIssueUrl: string | null;
      reportedAt: number;
      hash: string;
    } | null,
    unknown
  >;
  readonly listFeedbackForAgent: (agentId: string) => Effect.Effect<
    ReadonlyArray<{
      id: string;
      agentId: string;
      category: string;
      severity: string;
      summary: string;
      details: string | null;
      relatedFiles: ReadonlyArray<string>;
      contextJson: string;
      githubIssueNumber: number | null;
      githubIssueUrl: string | null;
      reportedAt: number;
      hash: string;
    }>,
    unknown
  >;
  readonly getMetadata: (key: string) => Effect.Effect<string | null, unknown>;
  readonly setMetadata: (key: string, value: string) => Effect.Effect<void, unknown>;
  readonly setMetadataBatch: (
    entries: ReadonlyArray<{ key: string; value: string }>,
  ) => Effect.Effect<void, unknown>;

  readonly saveFeeClaim: (claim: {
    id: string;
    poolAddress: string;
    positionPubkey: string;
    feeX: number;
    feeY: number;
    platformFeeX: number;
    platformFeeY: number;
    netFeeX: number;
    netFeeY: number;
    operatorFeeX?: number;
    operatorFeeY?: number;
    txSignature: string | null;
    feeTransferTxSignature: string | null;
    reportedToApi: boolean;
    createdAt: number;
  }) => Effect.Effect<void, unknown>;

  readonly getUnreportedFeeClaims: () => Effect.Effect<
    ReadonlyArray<{
      id: string;
      poolAddress: string;
      positionPubkey: string;
      feeX: number;
      feeY: number;
      platformFeeX: number;
      platformFeeY: number;
      txSignature: string | null;
      feeTransferTxSignature: string | null;
      createdAt: number;
    }>,
    unknown
  >;

  readonly markFeeClaimReported: (id: string) => Effect.Effect<void, unknown>;

  readonly saveSignalSnapshot: (snapshot: SignalSnapshot) => Effect.Effect<number, unknown>;
  readonly getSignalSnapshots: (
    poolAddress: string,
    startMs: number,
    endMs: number,
  ) => Effect.Effect<
    ReadonlyArray<
      SignalSnapshot & { outcomePnlUsd: number | null; outcomeRecordedAt: number | null }
    >,
    unknown
  >;
  readonly recordSignalOutcome: (
    snapshotId: number,
    pnlUsd: number,
  ) => Effect.Effect<void, unknown>;
  readonly getRecentOutcomes: (limit: number) => Effect.Effect<
    ReadonlyArray<{
      poolAddress: string;
      timestamp: number;
      feeIlRatio: number;
      volumeAuthenticity: number;
      binUtilization: number;
      tvlUsd: number;
      tvlVelocity: number;
      volatilityStddev: number;
      binStep: number;
      action: string;
      confidence: number;
      outcomePnlUsd: number | null;
      outcomeRecordedAt: number | null;
    }>,
    unknown
  >;

  readonly getEvolvedThresholds: () => Effect.Effect<EvolvableThresholds | null, unknown>;
  readonly saveEvolvedThresholds: (thresholds: EvolvableThresholds) => Effect.Effect<void, unknown>;
  readonly getClosedPositionOutcomes: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<OutcomeRecord>, unknown>;

  readonly getSignalWeights: () => Effect.Effect<SignalWeights | null, unknown>;
  readonly saveSignalWeights: (weights: SignalWeights) => Effect.Effect<void, unknown>;

  readonly getPoolCooldown: (poolAddress: string) => Effect.Effect<PoolCooldown | null, unknown>;
  readonly setPoolCooldown: (cooldown: PoolCooldown) => Effect.Effect<void, unknown>;
  readonly clearPoolCooldown: (poolAddress: string) => Effect.Effect<void, unknown>;
}

export class DbService extends Context.Tag("DbService")<DbService, DbApi>() {}

// ─── Feedback Service ───────────────────────────────────────────────────────

export type FeedbackCategory = "friction" | "suggestion" | "observation" | "praise";
export type FeedbackSeverity = "low" | "medium" | "high";

export interface FeedbackContext {
  readonly prismVersion: string;
  readonly installMethod: string;
  readonly platform: string;
  readonly runtime: string;
  readonly nodeVersion?: string;
}

export interface AgentFeedback {
  readonly category: FeedbackCategory;
  readonly severity: FeedbackSeverity;
  readonly summary: string;
  readonly details?: string;
  readonly context?: FeedbackContext;
  readonly relatedFiles?: ReadonlyArray<string>;
}

export type FeedbackResult =
  | { kind: "rate_limited"; reason: string }
  | { kind: "opt_out" }
  | { kind: "local_only"; localId: string }
  | { kind: "cloud"; id: string; duplicate?: boolean }
  | { kind: "error"; error: string };

export interface FeedbackEntry {
  readonly id: string;
  readonly agentId: string;
  readonly category: FeedbackCategory;
  readonly severity: FeedbackSeverity;
  readonly summary: string;
  readonly details: string | null;
  readonly relatedFiles: ReadonlyArray<string>;
  readonly contextJson: string;
  readonly githubIssueNumber: number | null;
  readonly githubIssueUrl: string | null;
  readonly reportedAt: number;
  readonly hash: string;
}

export interface FeedbackApi {
  readonly submit: (feedback: AgentFeedback) => Effect.Effect<FeedbackResult, unknown>;
  readonly list: () => Effect.Effect<ReadonlyArray<FeedbackEntry>, unknown>;
  readonly listForAgent: (agentId: string) => Effect.Effect<ReadonlyArray<FeedbackEntry>, unknown>;
  readonly getByHash: (hash: string) => Effect.Effect<FeedbackEntry | null, unknown>;
  readonly setOptOut: (optOut: boolean) => Effect.Effect<void, unknown>;
  readonly getOptOut: () => Effect.Effect<boolean, unknown>;
}

export class FeedbackService extends Context.Tag("FeedbackService")<
  FeedbackService,
  FeedbackApi
>() {}

// ─── Referral Service ───────────────────────────────────────────────────────

export interface ReferralApi {
  readonly generateCode: (userId: string) => Effect.Effect<string, Error>;
  readonly validateCode: (
    code: string,
  ) => Effect.Effect<{ valid: boolean; referrerId?: string }, Error>;
  readonly applyReferral: (code: string, refereeId: string) => Effect.Effect<void, Error>;
  readonly getReferralCount: (userId: string) => Effect.Effect<number, Error>;
}

export class ReferralService extends Context.Tag("ReferralService")<
  ReferralService,
  ReferralApi
>() {}

// ─── Revenue Service ────────────────────────────────────────────────────────

export interface RevenueApi {
  readonly calculateTier: (walletSol: number, referralCount: number) => string;
  readonly calculatePlatformFee: (
    tier: string,
    feeXAmount: number,
    feeYAmount: number,
    tokenPrices: { x: number; y: number },
  ) => { platformFeeUsd: number; netFeeX: number; netFeeY: number };
  readonly calculateCreditDiscount: (credits: number, feeUsd: number) => number;
}

export class RevenueService extends Context.Tag("RevenueService")<RevenueService, RevenueApi>() {}

// ─── Revenue Config Service ─────────────────────────────────────────────────

export interface RevenueConfig {
  readonly tier: string;
  readonly platformFeeRate: number;
  readonly revenueShareEnabled: boolean;
  readonly revenueShareOperatorPct: number;
  readonly feeWalletAddress: string;
}

export interface RevenueConfigApi {
  readonly getConfig: () => Effect.Effect<RevenueConfig, never>;
  readonly refreshConfig: () => Effect.Effect<RevenueConfig, never>;
}

export class RevenueConfigService extends Context.Tag("RevenueConfigService")<
  RevenueConfigService,
  RevenueConfigApi
>() {}

// ─── Agent Service (agentic-mode overlay) ──────────────────────────────────

export interface AgentApi {
  readonly enhanceDecision: (
    decision: AgentDecision,
    context: AgentRuntimeContext,
  ) => Effect.Effect<AgentDecision | null, unknown>;
  readonly sendCheckin: (checkin: AgentRuntimeCheckin) => Effect.Effect<void, unknown>;
  readonly sendAlert: (alert: AgentRuntimeAlert) => Effect.Effect<void, unknown>;
  readonly getStatus: () => Effect.Effect<
    {
      readonly connected: boolean;
      readonly transport: string | null;
      readonly lastPromptAt: number | null;
      readonly errorCount: number;
    },
    unknown
  >;
  readonly disconnect: () => Effect.Effect<void, unknown>;
}

export class AgentService extends Context.Tag("AgentService")<AgentService, AgentApi>() {}

// ─── Agent State Service (shared mutable state for MCP/HTTP servers) ─────────

export interface AgentStateApi {
  readonly getSnapshot: () => Effect.Effect<PrismStateSnapshot, never>;
  readonly updateSnapshot: (patch: Partial<PrismStateSnapshot>) => Effect.Effect<void, never>;
}

export class AgentStateService extends Context.Tag("AgentStateService")<
  AgentStateService,
  AgentStateApi
>() {}

// ─── MCP Server Service ──────────────────────────────────────────────────────

export interface McpServerApi {
  readonly start: () => Effect.Effect<void, unknown>;
  readonly stop: () => Effect.Effect<void, unknown>;
}

export class McpServerService extends Context.Tag("McpServerService")<
  McpServerService,
  McpServerApi
>() {}

// ─── HTTP Status Server Service ──────────────────────────────────────────────

export interface HttpStatusServerApi {
  readonly start: () => Effect.Effect<void, unknown>;
  readonly stop: () => Effect.Effect<void, unknown>;
}

export class HttpStatusServerService extends Context.Tag("HttpStatusServerService")<
  HttpStatusServerService,
  HttpStatusServerApi
>() {}
