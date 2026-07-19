import { Effect, Fiber, Layer } from "effect";
import { ConfigService, ConfigLive, type AppConfig } from "./config-service.js";
import { AdapterLive } from "./adapter-service.js";
import { StrategyLive } from "./strategy-service.js";
import { MemoryLive } from "./memory-service.js";
import {
  RiskLive,
  evaluateAgentProposal,
  evaluateAgentRebalanceCapitalGates,
  evaluateGasGate,
  evaluateCompoundGate,
  evaluatePerPoolAllocation,
  evaluatePaperValidation,
  convertClaimFeesToUsd,
} from "./risk-service.js";
import {
  computeBinVolatilityStddev,
  isHighVolatility,
  recommendBinRangeForVolatility,
  recommendStrategyShape,
  resolveRangeHalfWidth,
  estimateRecoveryProbability,
  shouldHoldForRecovery,
  evolveThresholds,
  computeSignalWeights,
  weightedEntryScore,
} from "./strategy-service.js";
import type { EvolvableThresholds } from "./strategy-service.js";
import { BlacklistLive } from "./blacklist-service.js";
import { AuditLive } from "./audit-service.js";
import { ScreenerLive } from "./screener-service.js";
import { DbLive } from "./db-service.js";
import { RevenueConfigServiceLive } from "./revenue-config-service.js";
import { AgentStateMutable, initialSnapshot, type PositionSnapshot } from "./state-service.js";
import { McpServerLive } from "./mcp-server.js";
import { HttpStatusServerLive } from "./http-status-server.js";
import { EntryPrepLive } from "./entry-prep-service.js";
import { shouldDiscoverPools } from "./pool-policy.js";

import { checkForAutoUpdate } from "./update-check.js";
import type { PositionRecord } from "./db-service.js";
import { applyCompoundToCostBasis, computeRealizedPnlUsd } from "./pnl.js";
import { buildRewardClaimMetadata, summarizeRewardClaim } from "./rewards.js";
import { BlacklistError, DiscoverPoolsError } from "./errors.js";
import {
  GAS_TOP_UP_USDC,
  SOL_GAS_TOP_UP_THRESHOLD_LAMPORTS,
  MIN_SOL_FOR_GAS_LAMPORTS,
} from "./constants.js";
import {
  AdapterService,
  StrategyService,
  MemoryService,
  RiskService,
  BlacklistService,
  AuditService,
  ScreenerService,
  DbService,
  RevenueService,
  RevenueConfigService,
  ReferralService,
  AgentService,
  AgentStateService,
  McpServerService,
  HttpStatusServerService,
  EntryPrepService,
  MeteoraDatapiService,
  AlertService,
  type AdapterApi,
  type DbApi,
  type MemoryApi,
  type RiskResult,
  type ScreenedPool,
  type StrategyApi,
  type RevenueConfigApi,
  type EntryPrepApi,
  type AgentStateApi,
} from "./services.js";
import { MeteoraDatapiLive, enrichPoolWithDatapi } from "./meteora-datapi-service.js";
import { AlertLive } from "./alert-service.js";
import { detectDepegAndLiquidityDrain } from "./depeg-liquidity-detector.js";
import type {
  AgentDecision,
  AgentProposal,
  AgentProposalMode,
  AgentCycle,
  EntryStrategyShape,
  PoolMetrics,
  PoolSnapshot,
  PoolState,
  Position,
  RebalanceParams,
  SignalWeights,
  ActionType,
} from "./types.js";
import type { AgentRuntimeAlert, AgentRuntimeCheckin } from "./agent-transport.js";
import { randomUUID } from "crypto";
import { AgentLive, AgentNoOp } from "./agent-service.js";
import { createLogger } from "./logger.js";
import {
  isInsufficientTokenBalanceError,
  nextEntryFailureBackoff,
  type EntryFailureBackoff,
} from "./entry-backoff.js";
import {
  nextProposalBackoff,
  isProposalBackoffActive,
  ProposalCircuitBreaker,
  type ProposalBackoff,
} from "./proposal-backoff.js";

const logger = createLogger("program");

/**
 * How far back to look for a previous pool snapshot when computing TVL
 * velocity / IL drift. Wide enough to survive a day of downtime; the query is
 * indexed on (pool_address, timestamp) so this stays cheap.
 */
const PREVIOUS_SNAPSHOT_WINDOW_MS = 26 * 60 * 60 * 1000;

/** How often pool_snapshots pruning runs (rows older than the retention window are deleted). */
const SNAPSHOT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function isProposalStale(proposal: AgentProposal, staleMs: number, now: number): boolean {
  return now > proposal.proposedAt + staleMs || now > proposal.expiresAt;
}

export function shouldHoldForSupervisedApproval(
  agentiveMode: boolean,
  mode: AgentProposalMode,
  approvedProposalApplied: boolean,
  action: ActionType,
): boolean {
  // ENTER and REBALANCE deploy or reshape capital, so supervised mode requires
  // an approved proposal for them. HOLD is a no-op, and deterministic EXITs are
  // operator-configured safety actions (stop-loss / trailing stop) that the
  // engine keeps final authority over — gating them would delay loss-cutting
  // exits while the operator is offline.
  return (
    agentiveMode &&
    mode === "supervised" &&
    !approvedProposalApplied &&
    (action === "ENTER" || action === "REBALANCE")
  );
}

// Consume an applied queued proposal only once its outcome is final: after
// successful execution, or when the applied decision is a non-executing HOLD.
// Failed executions retain the proposal so it can be retried on a later cycle.
// Risk-engine denials are handled separately (reject + drop) before this runs.
export const finalizeAppliedProposal = (
  agentState: Pick<AgentStateApi, "dequeueProposals">,
  appliedQueuedProposalId: string | undefined,
  executed: boolean,
  action: ActionType,
): Effect.Effect<void> =>
  appliedQueuedProposalId !== undefined && (executed || action === "HOLD")
    ? agentState
        .dequeueProposals([appliedQueuedProposalId])
        .pipe(Effect.catchAll(() => Effect.void))
    : Effect.void;

/**
 * True when an applied proposal changes executable behavior vs the deterministic
 * decision. Pure echoes (preserve-original no-ops) should not arm proposal
 * backoff when risk later rejects the unchanged decision. When
 * confidenceThreshold is provided, a confidence nudge inside the epsilon that
 * crosses the gate still counts — it flips the risk outcome.
 */
export function decisionChangesExecutableBehavior(
  before: AgentDecision,
  after: AgentDecision,
  confidenceThreshold?: number,
): boolean {
  if (before.action !== after.action) return true;
  if (Math.abs(before.confidence - after.confidence) >= 0.005) return true;
  if (
    confidenceThreshold !== undefined &&
    before.confidence >= confidenceThreshold !== after.confidence >= confidenceThreshold
  ) {
    return true;
  }
  if ((before.positionSizeUsd ?? undefined) !== (after.positionSizeUsd ?? undefined)) {
    return true;
  }
  const beforeParams = before.rebalanceParams;
  const afterParams = after.rebalanceParams;
  if (beforeParams === undefined && afterParams === undefined) return false;
  if (beforeParams === undefined || afterParams === undefined) return true;
  // Slippage is intentionally excluded, mirroring rebalanceParamsEqual in
  // risk-service.ts: proposals hardcode slippageBps 0 while deterministic
  // decisions use 50, and execution never reads it.
  return (
    beforeParams.newLowerBinId !== afterParams.newLowerBinId ||
    beforeParams.newUpperBinId !== afterParams.newUpperBinId
  );
}

/**
 * True when two rebalance param values are functionally equivalent.
 * Slippage is intentionally excluded (proposals hardcode 0, deterministic
 * decisions use 50, execution never reads it) — keep in sync with
 * rebalanceParamsEqual in risk-service.ts.
 */
const rebalanceParamsEquivalent = (
  a: RebalanceParams | undefined,
  b: RebalanceParams | undefined,
): boolean => {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.newLowerBinId === b.newLowerBinId && a.newUpperBinId === b.newUpperBinId;
};

/**
 * Counterpart to recordAppliedProposalRiskDenial for the approval side: any
 * validated proposal that survives risk evaluation is a usable advisor
 * response, so clear per-pool backoff and reset the circuit breaker —
 * including no-op echoes.
 */
export const recordAppliedProposalRiskApproval = (args: {
  readonly proposalValidated: boolean;
  readonly proposalBackoff: Map<string, ProposalBackoff>;
  readonly recordCircuitSuccess: () => void;
  readonly poolAddress: string;
}): void => {
  if (!args.proposalValidated) return;
  args.proposalBackoff.delete(args.poolAddress);
  args.recordCircuitSuccess();
};

/**
 * Whether a risk denial after an applied proposal should arm proposal backoff
 * / circuit failure. If the proposal changed executable behavior (action,
 * position size, bin range), the advisor is penalized. If it only changed
 * confidence, re-evaluate the pre-apply deterministic decision: penalize only
 * when the deterministic decision would have been approved, i.e. the nudge
 * caused the denial.
 */
export const shouldPenalizeAppliedProposalDenial = (args: {
  readonly appliedAgentProposal: boolean;
  readonly preApplyDecision: AgentDecision | undefined;
  readonly appliedDecision: AgentDecision;
  readonly isPreApplyRiskApproved: () => boolean;
}): boolean => {
  if (!args.appliedAgentProposal || args.preApplyDecision === undefined) {
    return args.appliedAgentProposal;
  }
  const executableParamsUnchanged =
    args.preApplyDecision.action === args.appliedDecision.action &&
    (args.preApplyDecision.positionSizeUsd ?? undefined) ===
      (args.appliedDecision.positionSizeUsd ?? undefined) &&
    rebalanceParamsEquivalent(
      args.preApplyDecision.rebalanceParams,
      args.appliedDecision.rebalanceParams,
    );
  return !executableParamsUnchanged || args.isPreApplyRiskApproved();
};

/**
 * Records sticky risk denials after an applied agent proposal when the advisor
 * should be penalized (`penalizeAdvisor`). Backoff / circuit failure is only
 * armed when penalization is warranted; queued proposals are always rejected
 * so they are not re-selected until TTL prune. Transient execution failures
 * still retry via finalizeAppliedProposal.
 */
export const recordAppliedProposalRiskDenial = (
  agentState: Pick<AgentStateApi, "rejectProposal">,
  args: {
    readonly penalizeAdvisor: boolean;
    readonly appliedQueuedProposalId: string | undefined;
    readonly proposalBackoff: Map<string, ProposalBackoff>;
    readonly recordCircuitFailure: ((now: number) => void) | undefined;
    readonly poolAddress: string;
    readonly now: number;
    readonly backoff: { readonly baseMs: number; readonly maxMs: number };
  },
): Effect.Effect<void> => {
  if (!args.penalizeAdvisor && args.appliedQueuedProposalId === undefined) {
    return Effect.void;
  }
  if (args.penalizeAdvisor) {
    args.proposalBackoff.set(
      args.poolAddress,
      nextProposalBackoff(args.proposalBackoff.get(args.poolAddress), args.now, args.backoff),
    );
    args.recordCircuitFailure?.(args.now);
  }
  if (args.appliedQueuedProposalId === undefined) {
    return Effect.void;
  }
  return agentState
    .rejectProposal(args.appliedQueuedProposalId)
    .pipe(Effect.catchAll(() => Effect.void));
};

/** True when the agent runtime can actually send a sync proposal prompt. */
export function hasSyncProposalTransport(status: { readonly transport: string | null }): boolean {
  return status.transport !== null && status.transport !== "alert-only";
}

// ─── Position value estimation (rough heuristic) ───────────────

export function estimatePositionValue(pos: PositionRecord, pool: PoolState): number {
  const centerBinId = (pos.lowerBinId + pos.upperBinId) / 2;
  const maxDrift = Math.max(pos.upperBinId - centerBinId, 1);
  const drift = Math.abs(pool.activeBinId - centerBinId);
  const driftPct = Math.min(drift / maxDrift, 1);
  const ilFactor = 1 - driftPct * 0.5;
  return pos.depositedUsd * ilFactor;
}

export interface RebalanceBenefitEstimate {
  readonly estimatedFeesUsd: number;
  readonly estimatedCostUsd: number;
  readonly netBenefitUsd: number;
  readonly source: "sdk-simulation" | "pool-heuristic";
}

/**
 * Paper-mode rebalance benefit. There is no on-chain position to simulate in
 * paper mode, so the gate uses a pool-level fee-share heuristic; it shapes
 * simulated decisions only and never moves capital. Live mode instead runs
 * the SDK's atomic-rebalance simulation (see adapter.simulateRebalance).
 */
export function estimatePaperRebalanceBenefit(args: {
  fees24hUsd: number;
  newLowerBinId: number;
  newUpperBinId: number;
}): RebalanceBenefitEstimate {
  const rangeWidth = Math.max(args.newUpperBinId - args.newLowerBinId, 0);
  const feeCaptureRatio = Math.min(rangeWidth / 100, 1.0);
  const estimatedFeesUsd = args.fees24hUsd * feeCaptureRatio;
  const estimatedCostUsd = 0.5; // nominal simulated tx cost — paper pays no real gas/rent
  return {
    estimatedFeesUsd,
    estimatedCostUsd,
    netBenefitUsd: estimatedFeesUsd - estimatedCostUsd,
    source: "pool-heuristic",
  };
}

type PositionReconcileResult = {
  succeeded: boolean;
  unresolvedPoolAddresses: ReadonlySet<string>;
};

function toRiskPosition(pos: PositionRecord): Position {
  return {
    id: pos.positionId,
    poolAddress: pos.poolAddress,
    poolName: `${pos.tokenXSymbol}/${pos.tokenYSymbol}`,
    lowerBinId: pos.lowerBinId,
    upperBinId: pos.upperBinId,
    liquidityShares: 0n,
    depositedUsd: pos.depositedUsd,
    currentValueUsd: pos.currentValueUsd,
    unrealizedPnlUsd: pos.currentValueUsd - pos.depositedUsd,
    feesEarnedUsd: 0,
    openedAt: pos.timestamp,
  };
}

/** All tracked positions on a pool — a pool may hold several (tight+wide pairs). */
export function positionsForPool(
  trackedPositions: Map<string, PositionRecord>,
  poolAddress: string,
): PositionRecord[] {
  const out: PositionRecord[] = [];
  for (const pos of trackedPositions.values()) {
    if (pos.poolAddress === poolAddress) out.push(pos);
  }
  return out;
}

/**
 * The position a decision acts on. Explicit positionId wins; an untargeted
 * decision resolves to the pool's position only when exactly one exists —
 * with several, ambiguity fails closed (undefined) rather than hitting the
 * wrong row.
 */
function resolveTargetPosition(
  trackedPositions: Map<string, PositionRecord>,
  decision: AgentDecision,
): PositionRecord | undefined {
  if (decision.positionId !== undefined) {
    return trackedPositions.get(decision.positionId);
  }
  const poolPositions = positionsForPool(trackedPositions, decision.poolAddress);
  return poolPositions.length === 1 ? poolPositions[0] : undefined;
}

export function reconcilePositions(
  adapter: AdapterApi,
  db: DbApi,
  memory: MemoryApi,
  trackedPositions: Map<string, PositionRecord>,
  poolsToScan: ReadonlyArray<string>,
): Effect.Effect<PositionReconcileResult> {
  return Effect.gen(function* () {
    if (!adapter.hasWallet()) {
      return { succeeded: true, unresolvedPoolAddresses: new Set<string>() };
    }
    const walletAddress = adapter.getWalletAddress();
    if (!walletAddress) {
      return { succeeded: true, unresolvedPoolAddresses: new Set<string>() };
    }

    const onChainPositions = yield* adapter.getAllWalletPositions(walletAddress).pipe(
      Effect.catchAll((err) => {
        console.error("Reconcile: failed to fetch on-chain positions — skipping", {
          err: String(err),
        });
        return Effect.succeed(null);
      }),
    );

    if (onChainPositions === null) {
      return {
        succeeded: false,
        unresolvedPoolAddresses: new Set(poolsToScan),
      };
    }

    // Match by position identity, not pool: a pool can hold several positions
    // (tight+wide pairs), so per-pool matching would conflate siblings.
    const onChainByPubkey = new Map(onChainPositions.map((p) => [p.positionPubKey, p]));
    const watchedPoolSet = new Set(poolsToScan);
    const unresolvedPoolAddresses = new Set<string>();

    for (const [positionId, pos] of trackedPositions) {
      if (pos.positionPubKey && !onChainByPubkey.has(pos.positionPubKey)) {
        console.warn(
          `Reconciling: position ${positionId} on ${pos.poolAddress} no longer on-chain — removing from tracking`,
        );
        trackedPositions.delete(positionId);
        yield* db.deletePosition(positionId).pipe(Effect.catchAll(() => Effect.void));
        yield* memory
          .upsert({
            category: "warning",
            content: `Position ${positionId} on ${pos.poolAddress} was closed externally (e.g. via Solscan/Meteora UI). Removed from tracking.`,
            poolAddress: pos.poolAddress,
          })
          .pipe(Effect.catchAll(() => Effect.void));
      }
    }

    for (const onChainPos of onChainPositions) {
      const tracked = trackedPositions.get(onChainPos.positionPubKey);
      if (tracked) {
        // A tracked position whose on-chain range moved under the same pubkey
        // (e.g. an externally-executed rebalance, or an atomic rebalance whose
        // confirmation errored after landing) — sync the record back to the
        // real range instead of deciding on stale bins.
        if (
          tracked.lowerBinId !== onChainPos.lowerBinId ||
          tracked.upperBinId !== onChainPos.upperBinId
        ) {
          console.warn(
            `Reconciling: position ${onChainPos.positionPubKey} on ${onChainPos.poolAddress} range drifted on-chain (${tracked.lowerBinId}-${tracked.upperBinId} → ${onChainPos.lowerBinId}-${onChainPos.upperBinId}) — syncing record`,
          );
          const updated: PositionRecord = {
            ...tracked,
            lowerBinId: onChainPos.lowerBinId,
            upperBinId: onChainPos.upperBinId,
          };
          trackedPositions.set(onChainPos.positionPubKey, updated);
          yield* db.savePosition(updated).pipe(Effect.catchAll(() => Effect.void));
          yield* memory
            .upsert({
              category: "warning",
              content: `Position ${onChainPos.positionPubKey} on ${onChainPos.poolAddress} range synced to on-chain state (${onChainPos.lowerBinId}-${onChainPos.upperBinId}).`,
              poolAddress: onChainPos.poolAddress,
            })
            .pipe(Effect.catchAll(() => Effect.void));
        }
        continue;
      }
      if (watchedPoolSet.has(onChainPos.poolAddress)) {
        console.warn(
          `Reconciling: discovered external position ${onChainPos.positionPubKey} in ${onChainPos.poolAddress} — adding to tracking`,
        );
        const pool = yield* adapter.getPoolState(onChainPos.poolAddress).pipe(
          Effect.catchAll((err) => {
            console.error("Reconcile: failed to fetch pool state for external position", {
              pool: onChainPos.poolAddress,
              err: String(err),
            });
            unresolvedPoolAddresses.add(onChainPos.poolAddress);
            return Effect.succeed(null);
          }),
        );
        if (pool) {
          const pos: PositionRecord = {
            positionId: onChainPos.positionPubKey,
            poolAddress: onChainPos.poolAddress,
            positionPubKey: onChainPos.positionPubKey,
            depositedUsd: 0,
            currentValueUsd: 0,
            tokenXSymbol: pool.tokenXSymbol,
            tokenYSymbol: pool.tokenYSymbol,
            activeBinId: pool.activeBinId,
            lowerBinId: onChainPos.lowerBinId,
            upperBinId: onChainPos.upperBinId,
            timestamp: Date.now(),
            outOfRangeSince: null,
            oorCycleCount: 0,
            lastFeeClaimAt: Date.now(),
            trailingStopThreshold: null,
            highestValueUsd: null,
            lastRebalanceAt: 0,
            paperExitedAt: null,
            entrySignalTimestamp: null,
            entrySignalSnapshotId: null,
            entryPriceUsd: null,
            entryAmountXUsd: null,
            entryAmountYUsd: null,
            cumulativeFeesClaimedUsd: 0,
            cumulativeRewardsClaimedUsd: 0,
            closedAt: null,
            realizedPnlUsd: null,
          };
          trackedPositions.set(onChainPos.positionPubKey, pos);
          yield* db.savePosition(pos).pipe(Effect.catchAll(() => Effect.void));
          yield* memory
            .upsert({
              category: "warning",
              content: `External position ${onChainPos.positionPubKey} detected in ${onChainPos.poolAddress} and added to tracking.`,
              poolAddress: onChainPos.poolAddress,
            })
            .pipe(Effect.catchAll(() => Effect.void));
        }
      }
    }

    return { succeeded: true, unresolvedPoolAddresses };
  });
}

// ─── Build the dependency layer ──────────────────────────────────────────────

type AllServices =
  | ConfigService
  | AdapterService
  | StrategyService
  | MemoryService
  | RiskService
  | BlacklistService
  | AuditService
  | ScreenerService
  | DbService
  | RevenueConfigService
  | AgentService
  | AgentStateService
  | McpServerService
  | HttpStatusServerService
  | EntryPrepService
  | MeteoraDatapiService
  | AlertService;

export function buildLayer(cfg?: AppConfig): Layer.Layer<AllServices, never, never> {
  const dbLayer = DbLive(cfg?.sqliteDbPath);
  const configLayer = ConfigLive;

  const adapter = Layer.provide(AdapterLive, configLayer);
  const memory = Layer.provide(MemoryLive, dbLayer);
  const audit = Layer.provide(AuditLive, dbLayer);
  const meteoraDatapi = Layer.provide(MeteoraDatapiLive, configLayer);

  const screenerDeps = Layer.merge(adapter, StrategyLive);
  const screener = Layer.provide(
    ScreenerLive({
      minTvlUsd: cfg?.discoveryMinTvlUsd ?? 1_000_000,
      minFeeRatio: cfg?.discoveryMinFeeRatio ?? 1.5,
      volumeAuthThreshold: cfg?.volumeAuthThreshold ?? 0.7,
      minBinUtilization: cfg?.minBinUtilization ?? 0.3,
    }),
    screenerDeps,
  );

  const risk = RiskLive({
    confidenceThreshold: cfg?.confidenceThreshold ?? 0.65,
    maxRebalanceRangeBins: cfg?.maxRebalanceRangeBins ?? 50,
    stopLossPct: cfg?.stopLossPct ?? 0.15,
    maxPerPoolAllocationPct: cfg?.maxPerPoolAllocationPct ?? 0.4,
    maxPositionsPerPool: cfg?.maxPositionsPerPool ?? 2,
  });
  const blacklist = BlacklistLive({
    deployerBlacklistPath: cfg?.deployerBlacklistPath ?? "./engine/data/deployer-blacklist.json",
    tokenBlacklistPath: cfg?.tokenBlacklistPath ?? "./engine/data/token-blacklist.json",
  });

  const revenueConfigDeps = Layer.merge(dbLayer, configLayer);
  const revenueConfig = Layer.provide(RevenueConfigServiceLive, revenueConfigDeps);

  const entryPrepDeps = Layer.merge(adapter, configLayer);
  const entryPrep = Layer.provide(EntryPrepLive, entryPrepDeps);

  const merged = Layer.merge(adapter, StrategyLive);
  const merged2 = Layer.merge(merged, dbLayer);
  const merged3 = Layer.merge(merged2, memory);
  const merged4 = Layer.merge(merged3, risk);
  const merged5 = Layer.merge(merged4, blacklist);
  const merged6 = Layer.merge(merged5, audit);
  const merged7 = Layer.merge(merged6, screener);
  const merged8 = Layer.merge(merged7, configLayer);
  const merged11 = Layer.merge(merged8, revenueConfig);
  const merged11a = Layer.merge(merged11, entryPrep);
  const merged11b = Layer.merge(merged11a, meteoraDatapi);

  const agentLayer = cfg?.agentiveMode ? AgentLive(cfg) : Layer.succeed(AgentService, AgentNoOp);

  const agentStateLayer = AgentStateMutable({
    maxPendingProposals: cfg?.agentProposalMaxQueueSize ?? 50,
  }).layer;

  const mcpLayer = cfg?.agentMcpEnabled
    ? Layer.provide(McpServerLive(cfg), agentStateLayer)
    : Layer.succeed(McpServerService, { start: () => Effect.void, stop: () => Effect.void });

  const httpLayer =
    cfg && cfg.agentHttpPort > 0
      ? Layer.provide(HttpStatusServerLive(cfg), agentStateLayer)
      : Layer.succeed(HttpStatusServerService, {
          start: () => Effect.void,
          stop: () => Effect.void,
        });

  const merged12 = Layer.merge(merged11b, agentLayer);
  const merged13 = Layer.merge(merged12, agentStateLayer);
  const merged14 = Layer.merge(merged13, mcpLayer);
  const merged15 = Layer.merge(merged14, httpLayer);

  const alertDeps = Layer.merge(dbLayer, configLayer);
  const alertLayer = Layer.provide(AlertLive, alertDeps);
  const merged16 = Layer.merge(merged15, alertLayer);

  return merged16 as Layer.Layer<AllServices, never, never>;
}

// ─── Paper execution ─────────────────────────────────────────────────────────

export function executePaper(
  deps: {
    db: DbApi;
    trackedPositions: Map<string, PositionRecord>;
    strategy: StrategyApi;
    entryStrategyShape: EntryStrategyShape;
    entryRangeHalfWidth?: number;
  },
  decision: AgentDecision,
  pool: {
    activeBinId: number;
    binStep: number;
    tokenXSymbol: string;
    tokenYSymbol: string;
    currentPrice: number;
  },
  signalTimestamp?: number,
  signalSnapshotId?: number,
): Effect.Effect<{ executed: boolean; error: string | undefined }, never> {
  return Effect.gen(function* () {
    const { db, trackedPositions, strategy, entryStrategyShape, entryRangeHalfWidth } = deps;
    if (decision.action === "ENTER" && decision.positionSizeUsd) {
      // Legacy parity: re-entering a pool whose live position was paper-exited
      // keeps the live identity so the rows merge instead of duplicating.
      const liveExited = positionsForPool(trackedPositions, decision.poolAddress).find(
        (p) => p.paperExitedAt !== null && p.positionPubKey !== null,
      );
      // Paper/live parity: the simulated range comes from the same
      // recommendBinRange live entries use, so paper validates real behavior.
      const recommended = strategy.recommendBinRange(
        pool.activeBinId,
        pool.binStep,
        entryRangeHalfWidth,
      );
      const positionId = liveExited
        ? liveExited.positionPubKey!
        : `paper-${decision.poolAddress}-${randomUUID()}`;
      const pos: PositionRecord = {
        positionId,
        poolAddress: decision.poolAddress,
        positionPubKey: liveExited ? liveExited.positionPubKey : null,
        depositedUsd: decision.positionSizeUsd,
        currentValueUsd: decision.positionSizeUsd,
        tokenXSymbol: pool.tokenXSymbol,
        tokenYSymbol: pool.tokenYSymbol,
        activeBinId: pool.activeBinId,
        lowerBinId: recommended.lowerBinId,
        upperBinId: recommended.upperBinId,
        timestamp: Date.now(),
        outOfRangeSince: null,
        oorCycleCount: 0,
        lastFeeClaimAt: Date.now(),
        trailingStopThreshold: null,
        highestValueUsd: null,
        lastRebalanceAt: 0,
        paperExitedAt: liveExited ? liveExited.paperExitedAt : null,
        entrySignalTimestamp: signalTimestamp ?? null,
        entrySignalSnapshotId: signalSnapshotId ?? null,
        entryPriceUsd: pool.currentPrice,
        entryAmountXUsd: decision.positionSizeUsd / 2,
        entryAmountYUsd: decision.positionSizeUsd / 2,
        cumulativeFeesClaimedUsd: 0,
        cumulativeRewardsClaimedUsd: 0,
        closedAt: null,
        realizedPnlUsd: null,
      };
      trackedPositions.set(pos.positionId, pos);
      yield* db.savePosition(pos).pipe(Effect.catchAll(() => Effect.void));
      yield* db
        .savePositionEvent({
          id: randomUUID(),
          poolAddress: decision.poolAddress,
          positionPubKey: pos.positionPubKey,
          positionId: pos.positionId,
          event: "ENTER",
          valueUsd: decision.positionSizeUsd,
          feesUsd: null,
          price: pool.currentPrice,
          metadata: {
            lowerBinId: pos.lowerBinId,
            upperBinId: pos.upperBinId,
            strategyShape: entryStrategyShape,
          },
          createdAt: Date.now(),
        })
        .pipe(Effect.catchAll(() => Effect.void));
    } else if (decision.action === "EXIT") {
      const pos = resolveTargetPosition(trackedPositions, decision);
      if (pos?.positionPubKey) {
        // Live position — paper trading must not "exit" it without an on-chain tx.
        // Skip and warn so the user can switch to live mode to actually close it.
        console.warn(
          `[PAPER] Skipping EXIT for ${pos.positionId} on ${decision.poolAddress} — this is a live position ` +
            `(pubKey: ${pos.positionPubKey}). Switch to live mode to close it on-chain.`,
        );
        return {
          executed: false,
          error: `Skipping EXIT for live position in paper mode: ${pos.positionId}`,
        };
      }
      if (pos?.entrySignalSnapshotId != null) {
        const pnlUsd = pos.currentValueUsd - pos.depositedUsd;
        yield* db
          .recordSignalOutcome(pos.entrySignalSnapshotId, pnlUsd)
          .pipe(Effect.catchAll(() => Effect.void));
      }
      if (pos) {
        const realizedPnlUsd = computeRealizedPnlUsd(
          pos.currentValueUsd,
          pos.cumulativeFeesClaimedUsd,
          pos.depositedUsd,
          pos.cumulativeRewardsClaimedUsd,
        );
        yield* db
          .savePositionEvent({
            id: randomUUID(),
            poolAddress: decision.poolAddress,
            positionPubKey: pos.positionPubKey,
            positionId: pos.positionId,
            event: "EXIT",
            valueUsd: pos.currentValueUsd,
            feesUsd: pos.cumulativeFeesClaimedUsd,
            price: pool.currentPrice,
            metadata: { realizedPnlUsd },
            createdAt: Date.now(),
          })
          .pipe(Effect.catchAll(() => Effect.void));
        yield* db
          .closePosition(pos.positionId, realizedPnlUsd)
          .pipe(Effect.catchAll(() => Effect.void));
        yield* db.markPaperExited(pos.positionId).pipe(Effect.catchAll(() => Effect.void));
        trackedPositions.delete(pos.positionId);
      }
    } else if (decision.action === "REBALANCE" && decision.rebalanceParams) {
      const current = resolveTargetPosition(trackedPositions, decision);
      if (current) {
        const updated: PositionRecord = {
          ...current,
          lowerBinId: decision.rebalanceParams.newLowerBinId,
          upperBinId: decision.rebalanceParams.newUpperBinId,
          lastRebalanceAt: Date.now(),
        };
        trackedPositions.set(updated.positionId, updated);
        yield* db.savePosition(updated).pipe(Effect.catchAll(() => Effect.void));
        yield* db
          .savePositionEvent({
            id: randomUUID(),
            poolAddress: decision.poolAddress,
            positionPubKey: updated.positionPubKey,
            positionId: updated.positionId,
            event: "REBALANCE",
            valueUsd: updated.currentValueUsd,
            feesUsd: null,
            price: pool.currentPrice,
            metadata: {
              newLowerBinId: decision.rebalanceParams.newLowerBinId,
              newUpperBinId: decision.rebalanceParams.newUpperBinId,
            },
            createdAt: Date.now(),
          })
          .pipe(Effect.catchAll(() => Effect.void));
      }
    }
    return { executed: true, error: undefined };
  });
}

// ─── Live execution ──────────────────────────────────────────────────────────

/**
 * Execute a live decision. `entryPrep` is only used for ENTER actions; callers
 * must still provide it because the function signature does not conditionally
 * expose the dependency.
 */
export function executeLive(
  deps: {
    adapter: AdapterApi;
    strategy: StrategyApi;
    db: DbApi;
    revenueConfigSvc: RevenueConfigApi;
    trackedPositions: Map<string, PositionRecord>;
    entryPrep: EntryPrepApi;
    solPriceUsd: number;
    entryStrategyShape: EntryStrategyShape;
    entryRangeHalfWidth?: number;
    reconcileRequestedPools?: Set<string>;
  },
  decision: AgentDecision,
  pool: {
    activeBinId: number;
    binStep: number;
    tokenXSymbol: string;
    tokenYSymbol: string;
    currentPrice: number;
  },
  signalTimestamp?: number,
  signalSnapshotId?: number,
): Effect.Effect<{ executed: boolean; error: string | undefined }, never, never> {
  return Effect.gen(function* () {
    const {
      adapter,
      strategy,
      db,
      revenueConfigSvc,
      trackedPositions,
      entryPrep,
      solPriceUsd,
      entryStrategyShape,
      entryRangeHalfWidth,
    } = deps;

    if (!adapter.hasWallet()) {
      console.error("Live trading enabled but no wallet configured");
      return { executed: false, error: "Live trading enabled but no wallet configured" };
    }

    // F5 allocation gate already caps the number of simultaneously open
    // positions via evaluatePerPoolAllocation (rejected in the decision
    // flow before we reach executeLive). No additional hard cap here so
    // live mode honors maxOpenPositions.

    if (decision.action === "ENTER") {
      yield* adapter
        .swapUSDCForSOL(Number(SOL_GAS_TOP_UP_THRESHOLD_LAMPORTS) / 1e9, GAS_TOP_UP_USDC)
        .pipe(Effect.catchAll(() => Effect.void));

      const nativeBalance = yield* adapter.getNativeSolBalance().pipe(
        Effect.map((lamports) => ({ value: lamports, error: undefined as string | undefined })),
        Effect.catchAll((err) =>
          Effect.succeed({
            value: null,
            error: `Unable to read native SOL balance: ${err instanceof Error ? err.message : String(err)}`,
          }),
        ),
      );
      if (nativeBalance.value === null) {
        return { executed: false, error: nativeBalance.error };
      }
      const solBalance = nativeBalance.value;
      if (solBalance < MIN_SOL_FOR_GAS_LAMPORTS) {
        console.warn("Insufficient SOL for gas — skipping ENTER");
        return { executed: false, error: "Insufficient SOL for gas — skipping ENTER" };
      }
    }

    if (decision.action === "ENTER" && decision.positionSizeUsd) {
      const prepResult = yield* entryPrep
        .prepareEntryTokens(decision.poolAddress, decision.positionSizeUsd)
        .pipe(
          Effect.matchEffect({
            onSuccess: () => Effect.succeed({ error: undefined as string | undefined }),
            onFailure: (err) =>
              Effect.succeed({
                error: `Entry token preparation failed: ${err instanceof Error ? err.message : String(err)}`,
              }),
          }),
        );
      if (prepResult.error) {
        console.warn(prepResult.error, { pool: decision.poolAddress });
        return { executed: false, error: prepResult.error };
      }
    }

    if (decision.action === "ENTER" && decision.positionSizeUsd) {
      const recommended = strategy.recommendBinRange(
        pool.activeBinId,
        pool.binStep,
        entryRangeHalfWidth,
      );
      const enterResult = yield* adapter
        .enterPosition(
          decision.poolAddress,
          recommended.lowerBinId,
          recommended.upperBinId,
          decision.positionSizeUsd,
          { strategyShape: entryStrategyShape },
        )
        .pipe(
          Effect.tap((r) =>
            console.info("Live position entered", {
              pool: decision.poolAddress,
              position: r.positionPubKey,
              tx: r.txSignature,
            }),
          ),
          Effect.map((r) => ({ result: r, error: undefined as string | undefined })),
          Effect.catchAll((err) => {
            const msg = (err as { message?: string }).message ?? String(err);
            console.error("Live ENTER failed", {
              pool: decision.poolAddress,
              err: msg,
            });
            return Effect.succeed({ result: null, error: msg });
          }),
        );

      if (enterResult.result) {
        const pos: PositionRecord = {
          positionId: enterResult.result.positionPubKey,
          poolAddress: decision.poolAddress,
          positionPubKey: enterResult.result.positionPubKey,
          depositedUsd: decision.positionSizeUsd,
          currentValueUsd: decision.positionSizeUsd,
          tokenXSymbol: pool.tokenXSymbol,
          tokenYSymbol: pool.tokenYSymbol,
          activeBinId: pool.activeBinId,
          lowerBinId: recommended.lowerBinId,
          upperBinId: recommended.upperBinId,
          timestamp: Date.now(),
          outOfRangeSince: null,
          oorCycleCount: 0,
          lastFeeClaimAt: Date.now(),
          trailingStopThreshold: null,
          highestValueUsd: null,
          lastRebalanceAt: 0,
          paperExitedAt: null,
          entrySignalTimestamp: signalTimestamp ?? null,
          entrySignalSnapshotId: signalSnapshotId ?? null,
          entryPriceUsd: pool.currentPrice,
          // Entry legs come from the adapter's executed deposit: 50/50 for a
          // two-sided entry, full-size/0 for a single-sided one.
          entryAmountXUsd: enterResult.result.amountXUsd,
          entryAmountYUsd: enterResult.result.amountYUsd,
          cumulativeFeesClaimedUsd: 0,
          cumulativeRewardsClaimedUsd: 0,
          closedAt: null,
          realizedPnlUsd: null,
        };
        trackedPositions.set(pos.positionId, pos);
        yield* db.savePosition(pos).pipe(Effect.catchAll(() => Effect.void));
        yield* db
          .savePositionEvent({
            id: randomUUID(),
            poolAddress: decision.poolAddress,
            positionPubKey: pos.positionPubKey,
            positionId: pos.positionId,
            event: "ENTER",
            valueUsd: decision.positionSizeUsd,
            feesUsd: null,
            price: pool.currentPrice,
            metadata: {
              lowerBinId: pos.lowerBinId,
              upperBinId: pos.upperBinId,
              txSignature: enterResult.result.txSignature,
              depositMode: enterResult.result.depositMode,
              strategyShape: entryStrategyShape,
            },
            createdAt: Date.now(),
          })
          .pipe(Effect.catchAll(() => Effect.void));
        return { executed: true, error: undefined };
      }
      return { executed: false, error: enterResult.error };
    } else if (decision.action === "ENTER") {
      return { executed: false, error: "ENTER decision missing position size" };
    } else if (decision.action === "EXIT") {
      const pos = resolveTargetPosition(trackedPositions, decision);
      let exited = false;
      let exitError: string | undefined = undefined;
      if (pos?.positionPubKey) {
        const exitResult = yield* adapter
          .exitPosition(decision.poolAddress, pos.positionPubKey)
          .pipe(
            Effect.tap(() =>
              console.info("Live position exited", {
                pool: decision.poolAddress,
                position: pos.positionPubKey,
              }),
            ),
            Effect.map((r) => ({ result: r, error: undefined as string | undefined })),
            Effect.catchAll((err) => {
              const msg = (err as { message?: string }).message ?? String(err);
              console.error("Live EXIT failed", {
                pool: decision.poolAddress,
                err: msg,
              });
              return Effect.succeed({ result: null, error: msg });
            }),
          );
        exited = exitResult.result !== null;
        exitError = exitResult.error;
      } else {
        exited = true;
      }
      if (exited) {
        if (pos?.entrySignalSnapshotId != null) {
          const pnlUsd = pos.currentValueUsd - pos.depositedUsd;
          yield* db
            .recordSignalOutcome(pos.entrySignalSnapshotId, pnlUsd)
            .pipe(Effect.catchAll(() => Effect.void));
        }
        if (pos) {
          const realizedPnlUsd = computeRealizedPnlUsd(
            pos.currentValueUsd,
            pos.cumulativeFeesClaimedUsd,
            pos.depositedUsd,
            pos.cumulativeRewardsClaimedUsd,
          );
          yield* db
            .savePositionEvent({
              id: randomUUID(),
              poolAddress: decision.poolAddress,
              positionPubKey: pos.positionPubKey,
              positionId: pos.positionId,
              event: "EXIT",
              valueUsd: pos.currentValueUsd,
              feesUsd: pos.cumulativeFeesClaimedUsd,
              price: pool.currentPrice,
              metadata: { realizedPnlUsd },
              createdAt: Date.now(),
            })
            .pipe(Effect.catchAll(() => Effect.void));
          yield* db
            .closePosition(pos.positionId, realizedPnlUsd)
            .pipe(Effect.catchAll(() => Effect.void));
          trackedPositions.delete(pos.positionId);
        }
        return { executed: true, error: undefined };
      }
      return { executed: false, error: exitError };
    } else if (decision.action === "REBALANCE" && decision.rebalanceParams) {
      const pos = resolveTargetPosition(trackedPositions, decision);
      if (pos?.positionPubKey) {
        const revenueConfigResult = yield* revenueConfigSvc.getConfig();
        const platformFeeRate = revenueConfigResult.platformFeeRate;
        const revenueShareEnabled = revenueConfigResult.revenueShareEnabled;
        const revenueShareOperatorPct = revenueConfigResult.revenueShareOperatorPct;
        const tier = revenueConfigResult.tier;

        // Claim fees before rebalancing (with platform fee)
        const claimResult = yield* adapter
          .claimFees(
            decision.poolAddress,
            pos.positionPubKey,
            platformFeeRate,
            revenueShareEnabled,
            revenueShareOperatorPct,
            revenueConfigResult.feeWalletAddress,
          )
          .pipe(Effect.catchAll(() => Effect.succeed(null)));

        if (claimResult && (claimResult.feeX > 0 || claimResult.feeY > 0)) {
          yield* db
            .saveFeeClaim({
              id: randomUUID(),
              poolAddress: decision.poolAddress,
              positionPubkey: pos.positionPubKey,
              feeX: claimResult.feeX,
              feeY: claimResult.feeY,
              platformFeeX: claimResult.platformFeeX,
              platformFeeY: claimResult.platformFeeY,
              netFeeX: claimResult.netFeeX,
              netFeeY: claimResult.netFeeY,
              operatorFeeX: claimResult.operatorFeeX ?? 0,
              operatorFeeY: claimResult.operatorFeeY ?? 0,
              txSignature: claimResult.txSignature,
              feeTransferTxSignature: claimResult.feeTransferTxSignature ?? null,
              reportedToApi: false,
              createdAt: Date.now(),
            })
            .pipe(Effect.catchAll(() => Effect.void));

          const claimedFeesUsd = convertClaimFeesToUsd({
            netFeeXRaw: claimResult.netFeeX,
            netFeeYRaw: claimResult.netFeeY,
            tokenXSymbol: pos.tokenXSymbol,
            tokenYSymbol: pos.tokenYSymbol,
            solPriceUsd,
          });
          pos.cumulativeFeesClaimedUsd += claimedFeesUsd;
          yield* db
            .savePositionEvent({
              id: randomUUID(),
              poolAddress: decision.poolAddress,
              positionPubKey: pos.positionPubKey,
              positionId: pos.positionId,
              event: "CLAIM",
              valueUsd: null,
              feesUsd: claimedFeesUsd,
              price: pool.currentPrice,
              metadata: { txSignature: claimResult.txSignature },
              createdAt: Date.now(),
            })
            .pipe(Effect.catchAll(() => Effect.void));

          if (
            claimResult.platformFeeX > 0 ||
            claimResult.platformFeeY > 0 ||
            (claimResult.operatorFeeX ?? 0) > 0 ||
            (claimResult.operatorFeeY ?? 0) > 0
          ) {
            yield* Effect.fork(
              adapter
                .reportFeeCollection({
                  poolAddress: decision.poolAddress,
                  ...(pos.positionPubKey != null && { positionPubkey: pos.positionPubKey }),
                  feeX: claimResult.feeX,
                  feeY: claimResult.feeY,
                  platformFeeX: claimResult.platformFeeX,
                  platformFeeY: claimResult.platformFeeY,
                  tier,
                  txSignature: claimResult.txSignature,
                  ...(claimResult.feeTransferTxSignature != null && {
                    feeTransferTxSignature: claimResult.feeTransferTxSignature,
                  }),
                  ...(claimResult.operatorFeeX != null && {
                    operatorFeeX: claimResult.operatorFeeX,
                  }),
                  ...(claimResult.operatorFeeY != null && {
                    operatorFeeY: claimResult.operatorFeeY,
                  }),
                })
                .pipe(
                  Effect.catchAllCause((cause) =>
                    Effect.sync(() =>
                      console.error("reportFeeCollection failed", { cause: String(cause) }),
                    ),
                  ),
                ),
            ).pipe(Effect.asVoid);
          }
        }

        const rebalanceResult = yield* adapter
          .rebalancePosition(
            decision.poolAddress,
            pos.positionPubKey,
            decision.rebalanceParams.newLowerBinId,
            decision.rebalanceParams.newUpperBinId,
          )
          .pipe(
            Effect.tap((r) =>
              console.info("Live position rebalanced atomically", {
                pool: decision.poolAddress,
                position: r.positionPubKey,
                txSignatures: r.txSignatures.length,
              }),
            ),
            Effect.map((r) => ({ result: r, error: undefined as string | undefined })),
            Effect.catchAll((err) => {
              const msg = (err as { message?: string }).message ?? String(err);
              console.error("Live atomic REBALANCE failed", {
                pool: decision.poolAddress,
                err: msg,
              });
              return Effect.succeed({ result: null, error: msg });
            }),
          );

        if (rebalanceResult.result) {
          const updated: PositionRecord = {
            ...pos,
            // Atomic rebalance preserves the position account: the pubkey,
            // entry basis and cumulative fee accounting all survive.
            positionId: rebalanceResult.result.positionPubKey,
            positionPubKey: rebalanceResult.result.positionPubKey,
            lowerBinId: decision.rebalanceParams.newLowerBinId,
            upperBinId: decision.rebalanceParams.newUpperBinId,
            lastFeeClaimAt: Date.now(),
            lastRebalanceAt: Date.now(),
          };
          if (updated.positionId !== pos.positionId) {
            // Defensive re-key: the SDK preserves the account, but if the
            // pubkey ever changed, the identity and its row must move with it
            // — otherwise the stale row would linger as a phantom position.
            trackedPositions.delete(pos.positionId);
            yield* db.deletePosition(pos.positionId).pipe(Effect.catchAll(() => Effect.void));
          }
          trackedPositions.set(updated.positionId, updated);
          yield* db.savePosition(updated).pipe(Effect.catchAll(() => Effect.void));
          yield* db
            .savePositionEvent({
              id: randomUUID(),
              poolAddress: decision.poolAddress,
              positionPubKey: updated.positionPubKey,
              positionId: updated.positionId,
              event: "REBALANCE",
              valueUsd: updated.currentValueUsd,
              feesUsd: null,
              price: pool.currentPrice,
              metadata: {
                newLowerBinId: decision.rebalanceParams.newLowerBinId,
                newUpperBinId: decision.rebalanceParams.newUpperBinId,
                txSignatures: rebalanceResult.result.txSignatures,
              },
              createdAt: Date.now(),
            })
            .pipe(Effect.catchAll(() => Effect.void));
          return { executed: true, error: undefined };
        }
        // Atomic failure leaves the on-chain position untouched — unless the
        // tx landed despite a confirmation error. Either way the next
        // reconcile sweep re-reads the real range; in-memory/DB state is
        // deliberately left exactly as-is (no half-updated records).
        logger.warn("Atomic rebalance failed — flagging pool for reconcile", {
          pool: decision.poolAddress,
          error: rebalanceResult.error,
        });
        deps.reconcileRequestedPools?.add(decision.poolAddress);
        return { executed: false, error: rebalanceResult.error };
      }
      return { executed: false, error: "REBALANCE requires an existing live position" };
    }
    return { executed: false, error: `No live execution path for action: ${decision.action}` };
  });
}

// ─── Main program ────────────────────────────────────────────────────────────

export const buildPositionSnapshots = (
  positions: Iterable<PositionRecord>,
): Array<PositionSnapshot> =>
  Array.from(positions).map((p) => ({
    poolAddress: p.poolAddress,
    positionId: p.positionId,
    tokenXSymbol: p.tokenXSymbol,
    tokenYSymbol: p.tokenYSymbol,
    depositedUsd: p.depositedUsd,
    currentValueUsd: p.currentValueUsd,
    activeBinId: p.activeBinId,
    lowerBinId: p.lowerBinId,
    upperBinId: p.upperBinId,
    lastAction: (p.lastRebalanceAt > p.timestamp ? "REBALANCE" : "ENTER") as
      | "ENTER"
      | "EXIT"
      | "REBALANCE"
      | "HOLD",
    lastActionAt: p.lastRebalanceAt > p.timestamp ? p.lastRebalanceAt : p.timestamp,
    hoursHeld: (Date.now() - p.timestamp) / 3_600_000,
  }));

export const program = Effect.gen(function* () {
  const config = yield* ConfigService;
  const adapter = yield* AdapterService;
  const strategy = yield* StrategyService;
  const memory = yield* MemoryService;
  const risk = yield* RiskService;
  const blacklist = yield* BlacklistService;
  const audit = yield* AuditService;
  const screener = yield* ScreenerService;
  const db = yield* DbService;
  const revenueConfigSvc = yield* RevenueConfigService;
  const agent = yield* AgentService;
  const agentState = yield* AgentStateService;
  const mcpServer = yield* McpServerService;
  const httpStatusServer = yield* HttpStatusServerService;
  const meteoraDatapi = yield* MeteoraDatapiService;
  const alertSvc = yield* AlertService;

  // Load persisted positions at startup (keyed by position identity — a pool
  // may hold several positions).
  const allPositions = yield* db.getAllPositions().pipe(Effect.catchAll(() => Effect.succeed([])));
  const trackedPositions = new Map<string, PositionRecord>();
  for (const pos of allPositions) {
    trackedPositions.set(pos.positionId, pos);
  }
  const entryFailureBackoff = new Map<string, EntryFailureBackoff>();

  // Agent check-in state
  const programStartTime = Date.now();
  let scanCount = 0;
  let lastAgentCheckinAt = 0;
  let lastWalletBalanceUsd = config.paperPortfolioUsd;
  let lastSnapshotPruneAt = 0;

  // F2: per-pool recent active-bin history (in-memory ring buffer; resets on restart)
  const binHistoryCap = Math.max(
    config.volatilityLookbackSnapshots,
    config.oorRecoveryLookbackCycles,
    2,
  );
  const binHistory = new Map<string, number[]>();
  const pushBinHistory = (poolAddress: string, activeBinId: number): void => {
    const arr = binHistory.get(poolAddress) ?? [];
    arr.push(activeBinId);
    while (arr.length > binHistoryCap) arr.shift();
    binHistory.set(poolAddress, arr);
  };

  // F6: paper-trading day counter — persisted in metadata table so it
  // survives restarts. Increments when the day boundary rolls over.
  const PAPER_DAYS_KEY = "paperTradingDaysAccumulated";
  const PAPER_DAYS_LAST_KEY = "paperTradingLastDayIso";
  const todayIso = (): string => new Date().toISOString().slice(0, 10);

  const tickPaperDays = Effect.gen(function* () {
    if (!config.paperTrading) return 0;
    const lastDay = yield* db
      .getMetadata(PAPER_DAYS_LAST_KEY)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    const today = todayIso();
    if (lastDay === today) return 0;
    const stored = yield* db
      .getMetadata(PAPER_DAYS_KEY)
      .pipe(Effect.catchAll(() => Effect.succeed("0")));
    const current = Number(stored) || 0;
    const next = current + 1;
    yield* db
      .setMetadataBatch([
        { key: PAPER_DAYS_KEY, value: String(next) },
        { key: PAPER_DAYS_LAST_KEY, value: today },
      ])
      .pipe(Effect.catchAll(() => Effect.void));
    if (next % 7 === 0) {
      console.info(`[paper-validation] ${next} paper days accumulated`);
    }
    return next;
  });

  const readPaperDays = Effect.gen(function* () {
    const stored = yield* db
      .getMetadata(PAPER_DAYS_KEY)
      .pipe(Effect.catchAll(() => Effect.succeed("0")));
    return Number(stored) || 0;
  });

  // ─── Threshold evolution state ────────────────────────────────────────
  const EVOLUTION_COUNT_KEY = "threshold_evolution_count";
  let evolvedThresholds: EvolvableThresholds = {
    minFeeIlRatio: config.minFeeIlRatio,
    volumeAuthThreshold: config.volumeAuthThreshold,
    minBinUtilization: config.minBinUtilization,
  };

  const loadEvolvedThresholds = Effect.gen(function* () {
    const stored = yield* db
      .getEvolvedThresholds()
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (stored) {
      evolvedThresholds = stored;
    }
  });

  yield* loadEvolvedThresholds;

  const tryEvolveThresholds = Effect.gen(function* () {
    const countStr = yield* db
      .getMetadata(EVOLUTION_COUNT_KEY)
      .pipe(Effect.catchAll(() => Effect.succeed("0")));
    const count = Number(countStr) || 0;

    if (count < config.evolutionInterval) return;

    const outcomes = yield* db
      .getClosedPositionOutcomes(1000)
      .pipe(Effect.catchAll(() => Effect.succeed([])));

    const result = evolveThresholds(outcomes, evolvedThresholds, {
      maxChangePct: config.evolutionMaxChangePct,
      minOutcomes: config.evolutionInterval,
    });

    if (result.changed) {
      evolvedThresholds = result.thresholds;
      yield* db.saveEvolvedThresholds(result.thresholds).pipe(Effect.catchAll(() => Effect.void));
      console.info("[threshold-evolution] Evolved thresholds", {
        minFeeIlRatio: result.thresholds.minFeeIlRatio.toFixed(3),
        volumeAuthThreshold: result.thresholds.volumeAuthThreshold.toFixed(3),
        minBinUtilization: result.thresholds.minBinUtilization.toFixed(3),
      });

      const newWeights = computeSignalWeights(outcomes, signalWeights, {
        windowDays: config.signalWeightWindowDays,
        minOutcomes: config.signalWeightMinOutcomes,
        boostFactor: config.signalWeightBoostFactor,
        decayFactor: config.signalWeightDecayFactor,
        weightFloor: config.signalWeightFloor,
        weightCeiling: config.signalWeightCeiling,
      });
      if (newWeights.updatedAt !== signalWeights.updatedAt) {
        signalWeights = newWeights;
        yield* db.saveSignalWeights(newWeights).pipe(Effect.catchAll(() => Effect.void));
        console.info("[signal-weights] Recomputed weights", {
          feeIlRatio: newWeights.feeIlRatio.toFixed(3),
          volumeAuthenticity: newWeights.volumeAuthenticity.toFixed(3),
          binUtilization: newWeights.binUtilization.toFixed(3),
          tvlUsd: newWeights.tvlUsd.toFixed(3),
          tvlVelocity: newWeights.tvlVelocity.toFixed(3),
        });
      }
    }
    yield* db.setMetadata(EVOLUTION_COUNT_KEY, "0").pipe(Effect.catchAll(() => Effect.void));
  });

  const incrementEvolutionCount = Effect.gen(function* () {
    const countStr = yield* db
      .getMetadata(EVOLUTION_COUNT_KEY)
      .pipe(Effect.catchAll(() => Effect.succeed("0")));
    const count = Number(countStr) || 0;
    yield* db
      .setMetadata(EVOLUTION_COUNT_KEY, String(count + 1))
      .pipe(Effect.catchAll(() => Effect.void));
  });

  // ─── Signal weights state ─────────────────────────────────────────────
  const DEFAULT_SIGNAL_WEIGHTS: SignalWeights = {
    feeIlRatio: 1.0,
    volumeAuthenticity: 1.0,
    binUtilization: 1.0,
    tvlUsd: 1.0,
    tvlVelocity: 1.0,
    updatedAt: Date.now(),
  };
  let signalWeights: SignalWeights = DEFAULT_SIGNAL_WEIGHTS;

  const loadSignalWeights = Effect.gen(function* () {
    const stored = yield* db.getSignalWeights().pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (stored) {
      signalWeights = stored;
    }
  });

  yield* loadSignalWeights;

  if (!config.paperTrading) {
    const paperExited = yield* db
      .getPaperExitedPositions()
      .pipe(Effect.catchAll(() => Effect.succeed([])));
    if (paperExited.length > 0) {
      console.warn(
        `Found ${paperExited.length} paper-exited position(s) from a previous paper-trading run. ` +
          `If you entered these in live mode, the on-chain position is NOT closed by the paper exit — ` +
          `close it manually. The engine tracks these rows to prevent re-entering the same pool ` +
          `while the on-chain position is still open.`,
      );
      for (const pos of paperExited) {
        console.warn(`  Paper-exited: ${pos.poolAddress} (${pos.positionId})`);
        if (pos.positionPubKey) {
          trackedPositions.set(pos.positionId, pos);
        }
      }
      for (const pos of paperExited) {
        if (!pos.positionPubKey) {
          yield* db.deletePosition(pos.positionId).pipe(Effect.catchAll(() => Effect.void));
        }
      }
    }

    for (const [positionId, pos] of trackedPositions) {
      if (!pos.positionPubKey) {
        trackedPositions.delete(positionId);
        yield* db.deletePosition(positionId).pipe(Effect.catchAll(() => Effect.void));
      }
    }
  }

  // ─── Pool discovery ────────────────────────────────────────────────────────

  let poolsToScan = [...config.watchlistPools];

  if (!shouldDiscoverPools(config) && config.enablePoolDiscovery) {
    logger.warn("Live pool discovery is disabled; configure WATCHLIST_POOLS for approved pools.", {
      paperTrading: config.paperTrading,
    });
  }

  if (shouldDiscoverPools(config)) {
    const screened = yield* screener.screenPools().pipe(
      Effect.catchAll((err) => {
        if (
          err instanceof DiscoverPoolsError ||
          (err as { _tag?: string })?._tag === "DiscoverPoolsError"
        ) {
          console.warn(
            "Pool discovery failed; falling back to watchlist-only mode:",
            err instanceof Error ? err.message : String(err),
          );
          return Effect.succeed([] as ReadonlyArray<ScreenedPool>);
        }
        // Non-discovery error: let it propagate so the cycle fails loudly
        // instead of silently masking bugs as an empty discovery result.
        return Effect.fail(err);
      }),
    );
    if (screened.length > 0) {
      console.info(`Discovered ${screened.length} candidate pools`);
      const top3 = screened.slice(0, 3);
      for (const pool of top3) {
        console.info(`  Candidate: ${pool.address} (fee/IL: ${pool.feeIlRatio.toFixed(2)})`);
        if (!poolsToScan.includes(pool.address)) {
          poolsToScan.push(pool.address);
        }
      }
    }
  }

  const approvedPoolAddresses = [...poolsToScan];
  let unresolvedPoolAddresses = new Set<string>();
  // Pools whose atomic rebalance failed mid-execution — re-read on-chain
  // state at the next cycle's reconcile before deciding again.
  const reconcileRequestedPools = new Set<string>();
  const refreshPoolsToScan = (reconcileResult: PositionReconcileResult) => {
    unresolvedPoolAddresses = new Set(reconcileResult.unresolvedPoolAddresses);
    poolsToScan = [...approvedPoolAddresses];
    if (!reconcileResult.succeeded) {
      return;
    }
    // Held pools stay scanned even if they left the watchlist — positions are
    // managed to exit. Iterate values: several positions can share a pool.
    for (const pos of trackedPositions.values()) {
      if (!poolsToScan.includes(pos.poolAddress)) {
        poolsToScan.push(pos.poolAddress);
      }
    }
  };

  const initialReconcileResult = yield* reconcilePositions(
    adapter,
    db,
    memory,
    trackedPositions,
    approvedPoolAddresses,
  );
  refreshPoolsToScan(initialReconcileResult);

  // Seed the agent state snapshot with current positions before exposing the
  // HTTP/MCP interfaces, so /propose can accept proposals for held pools
  // immediately after startup (not just after the first scan cycle).
  yield* agentState
    .updateSnapshot({ positions: buildPositionSnapshots(trackedPositions.values()) })
    .pipe(Effect.catchAll(() => Effect.void));

  // Start agent-facing servers (MCP and HTTP fallback)
  yield* mcpServer.start().pipe(Effect.catchAll(() => Effect.void));
  yield* httpStatusServer.start().pipe(Effect.catchAll(() => Effect.void));

  if (
    config.agentiveMode &&
    config.agentProposalMode === "supervised" &&
    config.agentApprovalToken.length === 0
  ) {
    logger.warn(
      "Supervised proposal mode is enabled without AGENT_APPROVAL_TOKEN — /approve and MCP prism_approve_proposals will reject all approvals (fail-closed)",
    );
  }

  // ─── Agent state snapshot ──────────────────────────────────────────────────

  const refreshAgentState = (): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      const snapshot = yield* agentState
        .getSnapshot()
        .pipe(Effect.catchAll(() => Effect.succeed(initialSnapshot)));
      const positions = buildPositionSnapshots(trackedPositions.values());
      const positionsValueUsd = positions.reduce((sum, p) => sum + p.currentValueUsd, 0);
      const unrealizedPnlUsd = positions.reduce(
        (sum, p) => sum + (p.currentValueUsd - p.depositedUsd),
        0,
      );
      const recentDecisions = yield* audit
        .getRecentDecisions(20)
        .pipe(Effect.catchAll(() => Effect.succeed([])));

      const now = Date.now();
      let badProposalBackoffUntil: number | null = null;
      for (const backoff of proposalBackoff.values()) {
        if (isProposalBackoffActive(backoff, now)) {
          if (
            badProposalBackoffUntil === null ||
            backoff.nextProposalAt > badProposalBackoffUntil
          ) {
            badProposalBackoffUntil = backoff.nextProposalAt;
          }
        }
      }

      yield* agentState.updateSnapshot({
        scanCount,
        lastCycleAt: now,
        portfolio: {
          totalValueUsd: lastWalletBalanceUsd + positionsValueUsd,
          unrealizedPnlUsd,
          realizedPnlUsd: 0,
          openPositions: trackedPositions.size,
          maxPositions: config.maxOpenPositions,
          walletBalanceUsd: lastWalletBalanceUsd,
        },
        positions,
        recentDecisions: recentDecisions.map((d) => ({
          timestamp: d.timestamp,
          cycleId: d.cycleId,
          poolAddress: d.poolAddress,
          action: d.action,
          confidence: d.confidence,
          reasoning: d.reasoning,
          executed: d.executed,
        })),
        agentPolicy: {
          mode: config.agentProposalMode,
          proposalsQueued: snapshot.pendingProposals.length,
          lastProposalAt: snapshot.agentPolicy.lastProposalAt,
          badProposalBackoffUntil,
          circuitBreakerOpen: Array.from(proposalCircuitBreakers.values()).some((breaker) =>
            breaker.isOpen(now),
          ),
          hardCaps: {
            maxPositionSizePct: config.agentProposalMaxPositionSizePct,
            maxRebalanceRangeBins: config.maxRebalanceRangeBins,
            minProposalConfidence: config.agentProposalMinConfidence,
            proposalStaleMs: config.agentProposalStaleMs,
          },
        },
      });
    });

  // ─── Scan cycle ────────────────────────────────────────────────────────────

  const runScanCycle = (): Effect.Effect<void, never, EntryPrepService> =>
    Effect.gen(function* () {
      const cycle: AgentCycle = {
        cycleId: randomUUID(),
        startedAt: Date.now(),
        poolsScanned: 0,
        poolsDecided: 0,
        poolsExecuted: 0,
        poolsFailed: 0,
        decisions: [],
        totalGasCostSol: 0,
        paperTrading: config.paperTrading,
      };

      console.info("Scan cycle started", { cycleId: cycle.cycleId });

      if (poolsToScan.length === 0) {
        console.info("No pools configured — skipping cycle");
        cycle.completedAt = Date.now();
        return;
      }

      // F6: tick paper-trading day counter once per cycle.
      if (config.paperTrading) {
        yield* tickPaperDays;
      }

      for (const poolAddress of poolsToScan) {
        // A pool yields one decision per held position plus at most one ENTER.
        const decisions = yield* evaluatePool(poolAddress, cycle).pipe(
          Effect.catchAll((err) => {
            cycle.poolsFailed++;
            console.error("Error processing pool", { poolAddress, err: String(err) });
            return Effect.succeed(null);
          }),
        );

        if (decisions && decisions.length > 0) {
          cycle.decisions.push(...decisions);
          cycle.poolsDecided++;
        }
        cycle.poolsScanned++;
      }

      cycle.completedAt = Date.now();
      const durationMs = cycle.completedAt - cycle.startedAt;
      console.info("Scan cycle complete", {
        cycleId: cycle.cycleId,
        scanned: cycle.poolsScanned,
        decided: cycle.poolsDecided,
        executed: cycle.poolsExecuted,
        failed: cycle.poolsFailed,
        durationSec: (durationMs / 1000).toFixed(1),
      });

      // Prune expired memories after each cycle
      yield* memory.pruneExpired().pipe(Effect.catchAll(() => Effect.void));

      // Prune pool_snapshots past the retention window (they grow every
      // cycle). Runs at most once per day; the first cycle prunes immediately.
      const nowForPrune = Date.now();
      if (nowForPrune - lastSnapshotPruneAt > SNAPSHOT_PRUNE_INTERVAL_MS) {
        lastSnapshotPruneAt = nowForPrune;
        const cutoff = nowForPrune - config.snapshotRetentionDays * 86_400_000;
        const pruned = yield* db
          .pruneSnapshots(cutoff)
          .pipe(Effect.catchAll(() => Effect.succeed(0)));
        if (pruned > 0) {
          console.info("[snapshot-retention] Pruned old pool snapshots", {
            pruned,
            retentionDays: config.snapshotRetentionDays,
          });
        }
      }

      scanCount += 1;
      yield* maybeSendAgentCheckin("periodic").pipe(Effect.catchAll(() => Effect.void));
      yield* refreshAgentState();
    });

  // ─── Agent check-ins ────────────────────────────────────────────────────────

  const buildAgentCheckin = (
    trigger: AgentRuntimeCheckin["trigger"],
  ): Effect.Effect<AgentRuntimeCheckin, unknown> =>
    Effect.gen(function* () {
      const recentDecisions = yield* audit
        .getRecentDecisions(20)
        .pipe(Effect.catchAll(() => Effect.succeed([])));
      const warnings = config.agentCheckinIncludeHistory
        ? yield* memory
            .getRelevantContext("recent warnings", 10)
            .pipe(Effect.catchAll(() => Effect.succeed([])))
        : [];
      const positions = Array.from(trackedPositions.values())
        .sort((a, b) => b.currentValueUsd - a.currentValueUsd)
        .slice(0, config.agentCheckinMaxPositions);
      const positionsValueUsd = positions.reduce((sum, p) => sum + p.currentValueUsd, 0);
      const unrealizedPnlUsd = positions.reduce(
        (sum, p) => sum + (p.currentValueUsd - p.depositedUsd),
        0,
      );
      const totalValueUsd = lastWalletBalanceUsd + positionsValueUsd;
      const now = Date.now();
      return {
        type: "checkin" as const,
        trigger,
        timestamp: now,
        portfolio: {
          totalValueUsd,
          unrealizedPnlUsd,
          realizedPnlUsd: 0,
          openPositions: trackedPositions.size,
          maxPositions: config.maxOpenPositions,
        },
        positions: positions.map((p) => ({
          pool: p.poolAddress,
          tokenX: p.tokenXSymbol,
          tokenY: p.tokenYSymbol,
          valueUsd: p.currentValueUsd,
          depositedUsd: p.depositedUsd,
          pnlUsd: p.currentValueUsd - p.depositedUsd,
          activeBinId: p.activeBinId,
          lowerBinId: p.lowerBinId,
          upperBinId: p.upperBinId,
          hoursHeld: (now - p.timestamp) / 3_600_000,
          lastAction: p.lastRebalanceAt > p.timestamp ? "REBALANCE" : "ENTER",
          lastActionAt: p.lastRebalanceAt > p.timestamp ? p.lastRebalanceAt : p.timestamp,
        })),
        recentDecisions: recentDecisions.slice(0, 10).map((d) => ({
          action: d.action,
          confidence: d.confidence,
          pool: d.poolAddress,
          timestamp: d.timestamp,
          reasoning: d.reasoning,
        })),
        warnings: warnings.slice(0, 10).map((w) => ({
          category: w.category,
          content: w.content,
        })),
        market: {
          solPriceUsd: config.solPriceUsd,
          gasEstimateSol: config.rebalanceGasCostSol,
          scanCount,
          uptimeMs: now - programStartTime,
        },
      };
    });

  const maybeSendAgentCheckin = (
    trigger: AgentRuntimeCheckin["trigger"],
  ): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      if (!config.agentiveMode) return;
      if (trigger === "periodic") {
        const since = Date.now() - lastAgentCheckinAt;
        if (lastAgentCheckinAt > 0 && since < config.agentCheckinIntervalMs) return;
      } else if (!config.agentCheckinOnEvents) {
        return;
      }
      const checkin = yield* buildAgentCheckin(trigger);
      yield* agent.sendCheckin(checkin).pipe(Effect.catchAll(() => Effect.void));
      lastAgentCheckinAt = Date.now();
    });

  const sendAgentAlert = (
    severity: AgentRuntimeAlert["severity"],
    category: AgentRuntimeAlert["category"],
    message: string,
    ctx: { pool: PoolState; metrics: PoolMetrics; position: PositionRecord | undefined },
  ): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      if (!config.agentiveMode) return;
      const position = ctx.position
        ? {
            depositedUsd: ctx.position.depositedUsd,
            currentValueUsd: ctx.position.currentValueUsd,
            pnlUsd: ctx.position.currentValueUsd - ctx.position.depositedUsd,
            activeBinId: ctx.position.activeBinId,
            lowerBinId: ctx.position.lowerBinId,
            upperBinId: ctx.position.upperBinId,
          }
        : undefined;
      const alert: AgentRuntimeAlert = {
        type: "alert",
        timestamp: Date.now(),
        severity,
        category,
        pool: ctx.pool.address,
        tokenPair: `${ctx.pool.tokenXSymbol}/${ctx.pool.tokenYSymbol}`,
        message,
        metrics: {
          tvlUsd: ctx.pool.tvlUsd,
          feeIlRatio: ctx.metrics.feeIlRatio,
          volumeAuthenticity: ctx.metrics.volumeAuthenticity,
          binUtilization: ctx.metrics.binUtilization,
          tvlVelocity: ctx.metrics.tvlVelocity,
        },
        ...(position ? { position } : {}),
      };
      yield* agent.sendAlert(alert).pipe(Effect.catchAll(() => Effect.void));
    });

  const proposalBackoff = new Map<string, ProposalBackoff>();
  const proposalCircuitBreakers = new Map<string, ProposalCircuitBreaker>();
  const vetoWarningThrottle = new Map<string, number>();
  const getPoolCircuitBreaker = (poolAddress: string): ProposalCircuitBreaker => {
    let breaker = proposalCircuitBreakers.get(poolAddress);
    if (!breaker) {
      breaker = new ProposalCircuitBreaker({
        failureThreshold: config.agentProposalCircuitBreakerThreshold,
        cooldownMs: config.agentProposalCircuitBreakerCooldownMs,
      });
      proposalCircuitBreakers.set(poolAddress, breaker);
    }
    return breaker;
  };

  const findPendingProposal = (
    proposals: ReadonlyArray<AgentProposal>,
    poolAddress: string,
    mode: AgentProposalMode,
    staleMs: number,
    now: number,
  ): AgentProposal | undefined => {
    for (let i = proposals.length - 1; i >= 0; i--) {
      const p = proposals[i];
      if (!p) continue;
      if (p.poolAddress !== poolAddress) continue;
      if (isProposalStale(p, staleMs, now)) continue;
      if (mode === "supervised") {
        if (p.status === "approved") return p;
      } else {
        if (p.status === "pending" || p.status === "approved") return p;
      }
    }
    return undefined;
  };

  const isAgentProposal = (value: AgentDecision | null): value is AgentProposal =>
    value !== null && "proposalId" in value && "source" in value && "status" in value;

  // ─── Per-pool evaluation ───────────────────────────────────────────────────

  const evaluatePool = (
    poolAddress: string,
    cycle: AgentCycle,
  ): Effect.Effect<ReadonlyArray<AgentDecision>, unknown, EntryPrepService> =>
    Effect.gen(function* () {
      const cycleId = cycle.cycleId;
      const rawPool = yield* adapter.getPoolState(poolAddress);
      const binArray = yield* adapter.getBinArray(poolAddress);
      pushBinHistory(poolAddress, rawPool.activeBinId);

      // Real pool stats from the Meteora Data API; falls back to the
      // adapter's heuristic stats (with a logged warning) when unavailable.
      const datapiStats = yield* meteoraDatapi.getPoolData(poolAddress);
      const pool = datapiStats === null ? rawPool : enrichPoolWithDatapi(rawPool, datapiStats);

      // TVL velocity + IL price-drift need a previous reference point, so the
      // previous snapshot must be read BEFORE persisting the current one.
      const previousSnapshots = yield* db
        .getSnapshots(poolAddress, pool.timestamp - PREVIOUS_SNAPSHOT_WINDOW_MS, pool.timestamp)
        .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<PoolSnapshot>)));
      const previousSnapshot =
        previousSnapshots.length > 0 ? previousSnapshots[previousSnapshots.length - 1] : undefined;
      const w15Signals = detectDepegAndLiquidityDrain(pool, previousSnapshots, config);

      // Persist a snapshot every cycle (both paper and live): TVL velocity and
      // the TVL-drop EXIT are dead code without per-cycle history. The full
      // bin-array detail is only stored under ENABLE_SNAPSHOT_CAPTURE (paper)
      // as before; routine rows stay lightweight.
      yield* db
        .saveSnapshot({
          poolAddress,
          timestamp: pool.timestamp,
          activeBinId: pool.activeBinId,
          tvlUsd: pool.tvlUsd,
          volume24hUsd: pool.volume24hUsd,
          fees24hUsd: pool.fees24hUsd,
          apr: pool.apr,
          currentPrice: pool.currentPrice,
          binStep: pool.binStep,
          tokenXSymbol: pool.tokenXSymbol,
          tokenYSymbol: pool.tokenYSymbol,
          binArray:
            config.enableSnapshotCapture && config.paperTrading
              ? { ...binArray, binStep: pool.binStep }
              : {
                  lowerBinId: binArray.lowerBinId,
                  upperBinId: binArray.upperBinId,
                  bins: [],
                  activeBinId: binArray.activeBinId,
                  binStep: pool.binStep,
                  reservesKnown: binArray.reservesKnown,
                },
        })
        .pipe(
          Effect.catchAll((err) => {
            console.warn("Snapshot save failed", { pool: poolAddress, err });
            return Effect.void;
          }),
        );

      // Safety screening (fail-closed on positive signals, fail-open on
      // transport errors):
      // 1. Meteora Data API flags: is_blacklisted, freeze_authority_disabled.
      // 2. On-chain mint accounts: freeze authority enabled → reject; mint
      //    authority doubles as the documented deployer fallback for the
      //    deployer blacklist.
      // 3. Token + deployer blacklist: a loaded blacklist hit rejects the
      //    pool; only unexpected transport/IO errors are swallowed.
      const rejectForSafety = (reason: string): Effect.Effect<ReadonlyArray<AgentDecision>> =>
        Effect.gen(function* () {
          logger.warn("Pool rejected by safety screening", { pool: poolAddress, reason });
          yield* audit
            .recordDecision({
              timestamp: Date.now(),
              cycleId,
              poolAddress,
              action: "HOLD",
              confidence: 0,
              reasoning: `[safety] ${reason}`,
              riskResult: { approved: false, reason: `[safety] ${reason}` },
              executed: false,
              paperTrading: config.paperTrading,
            })
            .pipe(Effect.catchAll(() => Effect.void));
          yield* memory
            .upsert({
              category: "warning",
              content: `Safety screening rejected ${poolAddress}: ${reason}`,
              poolAddress,
            })
            .pipe(Effect.catchAll(() => Effect.void));
          return [];
        });

      if (datapiStats?.isBlacklisted === true) {
        return yield* rejectForSafety("Meteora Data API flags pool as blacklisted");
      }

      const fetchAuthorities = (mint: string) =>
        adapter.getMintAuthorities(mint).pipe(
          Effect.catchAll((err) => {
            logger.warn(
              "Mint authority fetch failed — skipping on-chain authority screening (fail-open)",
              { pool: poolAddress, mint, err: String(err) },
            );
            return Effect.succeed(null);
          }),
        );
      const [authX, authY] = yield* Effect.all([
        fetchAuthorities(pool.tokenX),
        fetchAuthorities(pool.tokenY),
      ]);

      const freezeEnabledX =
        datapiStats?.tokenXFreezeAuthorityDisabled === false || authX?.freezeAuthority != null;
      const freezeEnabledY =
        datapiStats?.tokenYFreezeAuthorityDisabled === false || authY?.freezeAuthority != null;
      if (freezeEnabledX || freezeEnabledY) {
        const which = [
          freezeEnabledX ? `token X (${pool.tokenXSymbol})` : null,
          freezeEnabledY ? `token Y (${pool.tokenYSymbol})` : null,
        ]
          .filter((s) => s !== null)
          .join(" and ");
        return yield* rejectForSafety(`Freeze authority enabled on ${which}`);
      }

      const blacklistRejection = yield* blacklist
        .checkPool(
          poolAddress,
          pool.tokenX,
          pool.tokenY,
          authX?.mintAuthority ?? undefined,
          authY?.mintAuthority ?? undefined,
        )
        .pipe(
          Effect.as(null as string | null),
          Effect.catchIf(
            (err): err is BlacklistError => err instanceof BlacklistError,
            (err) => Effect.succeed(err.message),
          ),
          Effect.catchAll((err) => {
            logger.warn("Blacklist check failed — proceeding (fail-open)", {
              pool: poolAddress,
              err: String(err),
            });
            return Effect.succeed(null);
          }),
        );
      if (blacklistRejection !== null) {
        return yield* rejectForSafety(blacklistRejection);
      }

      const metrics = strategy.computeMetrics(
        pool,
        binArray,
        previousSnapshot?.tvlUsd ?? 0,
        previousSnapshot
          ? {
              previousPrice: previousSnapshot.currentPrice,
              previousTimestamp: previousSnapshot.timestamp,
            }
          : undefined,
      );

      if (!metrics.volumeAuthenticityKnown || !metrics.binUtilizationKnown) {
        logger.warn("Metric data unavailable — skipping the affected gates for this pool", {
          pool: poolAddress,
          volumeAuthenticityKnown: metrics.volumeAuthenticityKnown,
          binUtilizationKnown: metrics.binUtilizationKnown,
        });
      }

      // Pre-filter
      if (
        !strategy.passesPreFilter(
          pool,
          metrics.volumeAuthenticity,
          metrics.binUtilization,
          config.minPoolTvlUsd,
          evolvedThresholds.volumeAuthThreshold,
          evolvedThresholds.minBinUtilization,
          metrics.volumeAuthenticityKnown,
          metrics.binUtilizationKnown,
        )
      ) {
        console.debug("Pool failed pre-filter", { pool: poolAddress });
        return [];
      }

      // Check memory for warnings
      const warnings = yield* memory
        .getRelevantContext(`warnings for pool ${poolAddress}`, 3, poolAddress)
        .pipe(Effect.catchAll(() => Effect.succeed([])));
      const hasRecentWarning = warnings.some(
        (w) => w.category === "warning" && w.createdAt > Date.now() - 7 * 24 * 60 * 60 * 1000,
      );

      // Decision rules
      const feeIlRatio = metrics.feeIlRatio;
      const volumeAuth = metrics.volumeAuthenticity;
      const tvlVelocity = metrics.tvlVelocity;
      const binUtilization = metrics.binUtilization;

      // ── Per-position tracking ───────────────────────────────────────────
      // A pool may hold several positions (tight+wide pairs). Every position
      // gets independent OOR tracking, value estimation, and its own
      // EXIT/REBALANCE/HOLD decision; the pool gets at most one ENTER.
      let poolPositions = positionsForPool(trackedPositions, poolAddress).sort(
        (a, b) => a.timestamp - b.timestamp || a.positionId.localeCompare(b.positionId),
      );

      // OOR tracking must run before EXIT conditions so that out-of-range
      // cycle counts accumulate even when fee/IL triggers an EXIT.
      for (const pos of poolPositions) {
        const inRange = pool.activeBinId >= pos.lowerBinId && pool.activeBinId <= pos.upperBinId;
        if (!inRange) {
          if (pos.outOfRangeSince === null) {
            pos.outOfRangeSince = Date.now();
            yield* alertSvc.sendAlert({
              type: "position_out_of_range",
              severity: "critical",
              message:
                `Position ${pos.positionId} out of range on ${pool.tokenXSymbol}/${pool.tokenYSymbol}: ` +
                `active bin ${pool.activeBinId} is outside [${pos.lowerBinId}, ${pos.upperBinId}] — fees stopped accruing`,
              poolAddress,
              positionId: pos.positionId,
              data: {
                activeBinId: pool.activeBinId,
                lowerBinId: pos.lowerBinId,
                upperBinId: pos.upperBinId,
              },
            });
          }
          pos.oorCycleCount++;
        } else {
          pos.outOfRangeSince = null;
          pos.oorCycleCount = 0;
          // Range-consumption warning: alert once per cooldown when the active
          // bin has drifted ≥80% toward an edge of the position range.
          const halfWidth = (pos.upperBinId - pos.lowerBinId) / 2;
          if (halfWidth > 0) {
            const rangeCenter = (pos.lowerBinId + pos.upperBinId) / 2;
            const consumedPct = Math.abs(pool.activeBinId - rangeCenter) / halfWidth;
            if (consumedPct >= 0.8) {
              yield* alertSvc.sendAlert({
                type: "range_warning",
                severity: "warning",
                message:
                  `Range ${(consumedPct * 100).toFixed(0)}% consumed on ${pool.tokenXSymbol}/${pool.tokenYSymbol}: ` +
                  `active bin ${pool.activeBinId} nearing edge of [${pos.lowerBinId}, ${pos.upperBinId}]`,
                poolAddress,
                positionId: pos.positionId,
                data: {
                  activeBinId: pool.activeBinId,
                  lowerBinId: pos.lowerBinId,
                  upperBinId: pos.upperBinId,
                  consumedPct,
                },
              });
            }
          }
        }
      }

      // Per-cycle external-close reconcile: one position fetch per pool,
      // matched per position pubkey so a sibling's external close only
      // removes its own record.
      if (adapter.hasWallet() && poolPositions.some((p) => p.positionPubKey !== null)) {
        const walletAddress = adapter.getWalletAddress();
        if (walletAddress) {
          const onChainPositions = yield* adapter.getPositions(poolAddress, walletAddress).pipe(
            Effect.catchAll((err) => {
              console.error("Per-cycle reconcile: failed to fetch positions — skipping", {
                pool: poolAddress,
                err: String(err),
              });
              return Effect.succeed(null);
            }),
          );
          if (onChainPositions !== null) {
            const survivors: PositionRecord[] = [];
            for (const pos of poolPositions) {
              if (
                pos.positionPubKey &&
                !onChainPositions.some((p) => p.id === pos.positionPubKey)
              ) {
                console.warn(
                  `Per-cycle reconcile: position ${pos.positionId} on ${poolAddress} no longer on-chain — removing from tracking`,
                );
                trackedPositions.delete(pos.positionId);
                yield* db.deletePosition(pos.positionId).pipe(Effect.catchAll(() => Effect.void));
                yield* memory
                  .upsert({
                    category: "warning",
                    content: `Position ${pos.positionId} on ${poolAddress} was closed externally during this cycle. Removed from tracking.`,
                    poolAddress,
                  })
                  .pipe(Effect.catchAll(() => Effect.void));
              } else {
                survivors.push(pos);
              }
            }
            poolPositions = survivors;
          }
        }
      }

      const recentBins = binHistory.get(poolAddress) ?? [];
      const volatilityLookback = Math.max(2, config.volatilityLookbackSnapshots);
      const volatilityBins =
        recentBins.length > volatilityLookback
          ? recentBins.slice(recentBins.length - volatilityLookback)
          : recentBins;
      const volatilityStddev = computeBinVolatilityStddev(volatilityBins);

      // Wave 9: resolve the entry/rebalance range half-width once per
      // pool-cycle — static baseline (ENTRY_RANGE_HALF_WIDTH_BINS or the
      // binStep tier), scaled by σ when VOLATILITY_ADAPTIVE_RANGES is on.
      // σ=0 (cold start, <2 snapshots) yields the bounded baseline.
      const rangeHalfWidth = resolveRangeHalfWidth({
        binStep: pool.binStep,
        configuredBaseHalfWidth: config.entryRangeHalfWidthBins,
        adaptiveEnabled: config.volatilityAdaptiveRanges,
        volatilityStddev,
        maxFullRangeBins: config.maxRebalanceRangeBins,
      });

      // Value estimation per position (feeds the trailing stop and the
      // REBALANCE gas gate); OOR counters above are persisted by the same save.
      for (const pos of poolPositions) {
        const estimatedValue = estimatePositionValue(pos, pool);
        pos.currentValueUsd = estimatedValue;
        const highest = pos.highestValueUsd ?? pos.depositedUsd;
        if (estimatedValue > highest) {
          pos.highestValueUsd = estimatedValue;
        }
        yield* db.savePosition(pos).pipe(Effect.catchAll(() => Effect.void));
      }

      // ── Phase 1: EXIT evaluation per position ───────────────────────────
      // Pool-level degradation (TVL drop, fake volume, low fee/IL) exits
      // every position on the pool; the trailing stop is per position.
      const rawDecisions: AgentDecision[] = [];
      let poolExitFired = false;

      if (w15Signals.depeg || w15Signals.liquidityDrain) {
        const reasons = [
          ...(w15Signals.depeg
            ? [`stablecoin deviation ${(w15Signals.depeg.deviationUsd * 100).toFixed(2)}%`]
            : []),
          ...(w15Signals.liquidityDrain
            ? [
                `TVL ${(w15Signals.liquidityDrain.tvlPct * 100).toFixed(1)}%, volume ${(w15Signals.liquidityDrain.volumePct * 100).toFixed(1)}%`,
              ]
            : []),
        ];
        yield* alertSvc.sendAlert({
          type: w15Signals.depeg ? "stablecoin_depeg" : "liquidity_drain",
          severity: "critical",
          message: `Fast EXIT signal on ${pool.tokenXSymbol}/${pool.tokenYSymbol}: ${reasons.join("; ")}`,
          poolAddress,
          data: { ...w15Signals },
        });
      }

      for (const pos of poolPositions) {
        let decision: AgentDecision | null = null;

        if (w15Signals.depeg || w15Signals.liquidityDrain) {
          decision = {
            action: "EXIT",
            poolAddress,
            positionId: pos.positionId,
            confidence: 1,
            reasoning: `W15 fast EXIT: ${w15Signals.depeg ? "stablecoin depeg" : "liquidity drain"}`,
          };
        } else if (tvlVelocity < -config.tvlDropExitPct) {
          decision = {
            action: "EXIT",
            poolAddress,
            positionId: pos.positionId,
            confidence: 0.85,
            reasoning: `TVL dropped ${(Math.abs(tvlVelocity) * 100).toFixed(1)}% — capital protection exit`,
          };
          if (!poolExitFired) {
            yield* memory
              .upsert({
                category: "warning",
                content: `Pool ${poolAddress} TVL dropped sharply. Exit triggered.`,
                poolAddress,
              })
              .pipe(Effect.catchAll(() => Effect.void));
          }
          yield* sendAgentAlert(
            "critical",
            "tvl_drop",
            `TVL dropped ${(Math.abs(tvlVelocity) * 100).toFixed(1)}% on ${pool.tokenXSymbol}/${pool.tokenYSymbol} — capital protection EXIT triggered`,
            { pool, metrics, position: pos },
          );
        } else if (
          metrics.volumeAuthenticityKnown &&
          volumeAuth < evolvedThresholds.volumeAuthThreshold
        ) {
          decision = {
            action: "EXIT",
            poolAddress,
            positionId: pos.positionId,
            confidence: 0.8,
            reasoning: `Volume authenticity ${volumeAuth.toFixed(2)} below threshold`,
          };
          yield* sendAgentAlert(
            "warning",
            "risk_rejected",
            `Volume authenticity ${volumeAuth.toFixed(2)} below threshold on ${pool.tokenXSymbol}/${pool.tokenYSymbol} — EXIT`,
            { pool, metrics, position: pos },
          );
        } else if (feeIlRatio < 0.5) {
          decision = {
            action: "EXIT",
            poolAddress,
            positionId: pos.positionId,
            confidence: 0.75,
            reasoning: `Fee/IL ratio ${feeIlRatio.toFixed(2)} below 0.5`,
          };
          yield* sendAgentAlert(
            "warning",
            "risk_rejected",
            `Fee/IL ratio ${feeIlRatio.toFixed(2)} below 0.5 on ${pool.tokenXSymbol}/${pool.tokenYSymbol} — EXIT`,
            { pool, metrics, position: pos },
          );
        }

        // Trailing exit (profit protection)
        if (!decision) {
          const estimatedValue = pos.currentValueUsd;
          const highest = pos.highestValueUsd ?? pos.depositedUsd;
          const drawdown = highest > 0 ? (highest - estimatedValue) / highest : 0;
          if (drawdown > config.trailingStopPct) {
            decision = {
              action: "EXIT",
              poolAddress,
              positionId: pos.positionId,
              confidence: 0.8,
              reasoning: `Trailing stop: value dropped ${(drawdown * 100).toFixed(1)}% from peak $${highest.toFixed(2)}`,
            };
            yield* sendAgentAlert(
              "critical",
              "trailing_stop",
              `Trailing stop triggered on ${pool.tokenXSymbol}/${pool.tokenYSymbol}: value dropped ${(drawdown * 100).toFixed(1)}% from peak $${highest.toFixed(2)}`,
              { pool, metrics, position: pos },
            );
          } else {
            const pnlPct =
              pos.depositedUsd > 0 ? (estimatedValue - pos.depositedUsd) / pos.depositedUsd : 0;
            if (pnlPct < -0.15) {
              yield* sendAgentAlert(
                "warning",
                "large_pnl_swing",
                `Large unrealized loss on ${pool.tokenXSymbol}/${pool.tokenYSymbol}: ${(pnlPct * 100).toFixed(1)}% ($${(estimatedValue - pos.depositedUsd).toFixed(2)})`,
                { pool, metrics, position: pos },
              );
            }
          }
        }

        if (decision) {
          rawDecisions.push(decision);
          if (decision.action === "EXIT") poolExitFired = true;
        }
      }

      const computeCooldownForExit = (
        exitDecision: AgentDecision,
        position: PositionRecord | undefined,
      ): Effect.Effect<
        {
          poolAddress: string;
          cooldownUntil: number;
          reason: string;
          consecutiveOorExits: number;
        } | null,
        unknown
      > =>
        Effect.gen(function* () {
          if (exitDecision.action !== "EXIT") return null;

          const existingCooldown = yield* db
            .getPoolCooldown(poolAddress)
            .pipe(Effect.catchAll(() => Effect.succeed(null)));
          const existingOorCount = existingCooldown?.consecutiveOorExits ?? 0;
          const isOorExit =
            exitDecision.reasoning.includes("volatility") ||
            (position &&
              position.oorCycleCount >= config.oorGracePeriodCycles &&
              position.oorCycleCount > 0);
          const isLowYieldExit =
            exitDecision.reasoning.includes("Fee/IL ratio") ||
            exitDecision.reasoning.includes("Volume authenticity");

          if (isOorExit) {
            const newOorCount = existingOorCount + 1;
            const cooldownDuration =
              newOorCount >= config.maxOorCooldownExits
                ? config.repeatOorCooldownMs
                : config.oorCooldownMs;
            const cooldownUntil = Date.now() + cooldownDuration;
            const hours = (cooldownDuration / 3_600_000).toFixed(1);
            console.info(
              `[cooldown] Pool ${poolAddress} on cooldown for ${hours}h — OOR exit #${newOorCount}`,
            );
            return {
              poolAddress,
              cooldownUntil,
              reason: `OOR exit (#${newOorCount})`,
              consecutiveOorExits: newOorCount,
            };
          } else if (isLowYieldExit) {
            const cooldownDuration = config.oorCooldownMs;
            const cooldownUntil = Date.now() + cooldownDuration;
            const hours = (cooldownDuration / 3_600_000).toFixed(1);
            console.info(
              `[cooldown] Pool ${poolAddress} on cooldown for ${hours}h — low yield exit`,
            );
            return {
              poolAddress,
              cooldownUntil,
              reason: `Low yield exit`,
              consecutiveOorExits: 0,
            };
          }
          return null;
        });

      // Single persist point happened per position above (OOR + value updates).
      const exitPending = rawDecisions.some((d) => d.action === "EXIT");
      const walletBalanceUsd = adapter.hasWallet()
        ? yield* adapter.getWalletBalanceUsd().pipe(
            Effect.catchAll((err) => {
              if (config.paperTrading) return Effect.succeed(config.paperPortfolioUsd);
              if (exitPending) {
                console.error("Live wallet balance unavailable; continuing EXIT", {
                  pool: poolAddress,
                  error: String(err),
                });
                return Effect.succeed(lastWalletBalanceUsd);
              }
              console.error("Live wallet balance unavailable; skipping pool", {
                pool: poolAddress,
                error: String(err),
              });
              return Effect.fail(err);
            }),
          )
        : config.paperPortfolioUsd;
      lastWalletBalanceUsd = walletBalanceUsd;

      // Portfolio value = wallet + open positions (mirrors refreshAgentState).
      // Using the wallet alone shrinks the drawdown/allocation/size gates as
      // positions grow, tightening risk limits exactly when capital is deployed.
      const openPositions = Array.from(trackedPositions.values()).map(toRiskPosition);
      const portfolioValueUsd =
        walletBalanceUsd + openPositions.reduce((sum, p) => sum + p.currentValueUsd, 0);
      const recentPnlUsd = openPositions.reduce((sum, pos) => sum + pos.unrealizedPnlUsd, 0);

      // ── Phase 2: REBALANCE / HOLD per surviving position ────────────────
      const decidedPositionIds = new Set(
        rawDecisions.map((d) => d.positionId).filter((id): id is string => id !== undefined),
      );
      const recoveryLookback = Math.max(2, config.oorRecoveryLookbackCycles);
      // F4: slice the history to the configured recovery lookback window.
      // The full ring buffer is sized to hold at least
      // max(volatilityLookbackSnapshots, oorRecoveryLookbackCycles); volatility
      // uses the full buffer while recovery slices to its own window.
      const recoveryBins =
        recentBins.length > recoveryLookback
          ? recentBins.slice(recentBins.length - recoveryLookback)
          : recentBins;
      const highVol = isHighVolatility(volatilityStddev, config.volatilityExitStddev);

      for (const pos of poolPositions) {
        if (decidedPositionIds.has(pos.positionId)) continue;
        let decision: AgentDecision | null = null;

        const positionCenter = (pos.lowerBinId + pos.upperBinId) / 2;
        const positionHalfWidth = (pos.upperBinId - pos.lowerBinId) / 2;
        const driftPct = Math.abs(pool.activeBinId - positionCenter) / (positionHalfWidth || 1);
        const timeSinceRebal = Date.now() - pos.lastRebalanceAt;
        const oorGraceExpired = pos.oorCycleCount >= config.oorGracePeriodCycles;

        if (
          highVol &&
          driftPct > 0.6 &&
          (timeSinceRebal >= config.minRebalanceIntervalMs || oorGraceExpired)
        ) {
          console.info(
            `[vol-gate] EXITING ${poolAddress} (${pos.positionId}) — high volatility (stddev=${volatilityStddev.toFixed(2)}, threshold=${config.volatilityExitStddev}). Drift=${(driftPct * 100).toFixed(0)}%`,
          );
          decision = {
            action: "EXIT",
            poolAddress,
            positionId: pos.positionId,
            confidence: 0.8,
            reasoning: `High volatility (σ=${volatilityStddev.toFixed(2)}) + ${(driftPct * 100).toFixed(0)}% drift — exit to wallet rather than rebalancing into new range`,
          };
          if (!poolExitFired) {
            yield* memory
              .upsert({
                category: "warning",
                content: `Volatility-gate EXIT for ${poolAddress}: stddev=${volatilityStddev.toFixed(2)} over ${volatilityBins.length} snapshots`,
                poolAddress,
              })
              .pipe(Effect.catchAll(() => Effect.void));
          }
          yield* sendAgentAlert(
            "warning",
            "high_volatility",
            `High volatility exit on ${pool.tokenXSymbol}/${pool.tokenYSymbol}: σ=${volatilityStddev.toFixed(2)}, drift=${(driftPct * 100).toFixed(0)}%`,
            { pool, metrics, position: pos },
          );
        } else if (
          (driftPct > 0.6 || oorGraceExpired) &&
          (timeSinceRebal >= config.minRebalanceIntervalMs || oorGraceExpired)
        ) {
          // Wave 9: adaptive mode replaces the binary high-vol widening with
          // the continuous σ-scaled width; disabled keeps the legacy behavior.
          const recommended = config.volatilityAdaptiveRanges
            ? strategy.recommendBinRange(pool.activeBinId, pool.binStep, rangeHalfWidth)
            : highVol
              ? recommendBinRangeForVolatility(
                  pool.activeBinId,
                  pool.binStep,
                  true,
                  config.volatilityWideHalfWidthBins,
                  config.entryRangeHalfWidthBins > 0 ? config.entryRangeHalfWidthBins : undefined,
                )
              : strategy.recommendBinRange(pool.activeBinId, pool.binStep, rangeHalfWidth);
          // Simulation-first: live mode runs the SDK's atomic-rebalance
          // simulation against the real position; on any simulation/transport
          // failure the gate fails closed (no rebalance this cycle).
          const sim = config.paperTrading
            ? estimatePaperRebalanceBenefit({
                fees24hUsd: pool.fees24hUsd,
                newLowerBinId: recommended.lowerBinId,
                newUpperBinId: recommended.upperBinId,
              })
            : pos.positionPubKey
              ? yield* adapter
                  .simulateRebalance(
                    poolAddress,
                    pos.positionPubKey,
                    recommended.lowerBinId,
                    recommended.upperBinId,
                  )
                  .pipe(
                    Effect.catchAll((err) =>
                      Effect.sync(() => {
                        logger.warn(
                          "Rebalance simulation failed — holding position (fail-closed)",
                          {
                            pool: poolAddress,
                            error: err instanceof Error ? err.message : String(err),
                          },
                        );
                        return null;
                      }),
                    ),
                  )
              : null;

          if (sim === null) {
            yield* memory
              .upsert({
                category: "warning",
                content: `Rebalance simulation unavailable for ${poolAddress} — rebalance skipped this cycle`,
                poolAddress,
              })
              .pipe(Effect.catchAll(() => Effect.void));
          } else {
            console.info(
              `[rebalance-sim] ${poolAddress} source=${sim.source} fees=$${sim.estimatedFeesUsd.toFixed(2)} cost=$${sim.estimatedCostUsd.toFixed(2)} net=$${sim.netBenefitUsd.toFixed(2)}`,
            );
            // F1: gas-aware gate — skip rebalance when gas cost > N days of position fees
            // Use currentValueUsd (not depositedUsd) so the share reflects the
            // position's present value, not its original deposit. If current
            // value is unknown (reconciled positions), fall back to 0 which
            // makes the gas gate reject — a conservative default.
            const positionSharePct =
              pool.tvlUsd > 0 && pos.currentValueUsd > 0
                ? Math.min(pos.currentValueUsd / pool.tvlUsd, 1)
                : 0;
            const positionDailyFeesUsd = pool.fees24hUsd * positionSharePct;
            const gasGate = evaluateGasGate({
              rebalanceGasCostSol: config.rebalanceGasCostSol,
              solPriceUsd: config.solPriceUsd,
              positionDailyFeesUsd,
              minDaysOfFeesPaidAhead: config.gasAwareMinDaysOfFeesPaidAhead,
            });
            if (!gasGate.approved) {
              console.info(
                `[gas-gate] Holding ${poolAddress} — ${gasGate.reason} (gas=$${gasGate.gasCostUsd.toFixed(2)}, threshold=$${gasGate.feesThresholdUsd.toFixed(2)})`,
              );
              yield* memory
                .upsert({
                  category: "warning",
                  content: `Gas-aware rebalance gate held ${poolAddress}: ${gasGate.reason}`,
                  poolAddress,
                })
                .pipe(Effect.catchAll(() => Effect.void));
              yield* audit
                .recordDecision({
                  timestamp: Date.now(),
                  cycleId,
                  poolAddress,
                  action: "HOLD",
                  confidence: 0,
                  reasoning: `[gas-gate] ${gasGate.reason}`,
                  metrics,
                  riskResult: { approved: false, reason: `[gas-gate] ${gasGate.reason}` },
                  executed: false,
                  paperTrading: config.paperTrading,
                })
                .pipe(Effect.catchAll(() => Effect.void));
            } else {
              // F4: OOR recovery probability — if the recent bin path is
              // mean-reverting enough to plausibly recover, hold rather than
              // rebalance. Otherwise rebalance as usual.
              const recoveryProb = estimateRecoveryProbability(
                recoveryBins,
                Math.abs(pool.activeBinId - positionCenter),
              );
              const holdForRecovery = shouldHoldForRecovery(
                recoveryProb,
                config.oorRecoveryHoldThreshold,
              );
              if (holdForRecovery) {
                console.info(
                  `[recovery-gate] Holding ${poolAddress} — recovery prob ${recoveryProb.toFixed(2)} >= ${config.oorRecoveryHoldThreshold}`,
                );
                yield* memory
                  .upsert({
                    category: "pattern",
                    content: `OOR recovery prediction held ${poolAddress}: probability ${recoveryProb.toFixed(2)}`,
                    poolAddress,
                  })
                  .pipe(Effect.catchAll(() => Effect.void));
                yield* audit
                  .recordDecision({
                    timestamp: Date.now(),
                    cycleId,
                    poolAddress,
                    action: "HOLD",
                    confidence: recoveryProb,
                    reasoning: `[recovery-gate] probability ${recoveryProb.toFixed(2)} >= ${config.oorRecoveryHoldThreshold} — expecting mean-reversion`,
                    metrics,
                    riskResult: {
                      approved: false,
                      reason: `[recovery-gate] probability ${recoveryProb.toFixed(2)} above hold threshold`,
                    },
                    executed: false,
                    paperTrading: config.paperTrading,
                  })
                  .pipe(Effect.catchAll(() => Effect.void));
              } else if (
                sim.netBenefitUsd > config.minRebalanceNetBenefitUsd ||
                recoveryProb <= config.oorRecoveryForceRebalanceThreshold
              ) {
                const forceRebalance = recoveryProb <= config.oorRecoveryForceRebalanceThreshold;
                decision = {
                  action: "REBALANCE",
                  poolAddress,
                  positionId: pos.positionId,
                  confidence: Math.min(0.7 + feeIlRatio * 0.1, 0.9),
                  reasoning: forceRebalance
                    ? `[recovery-gate] force-rebalance — probability ${recoveryProb.toFixed(2)} <= ${config.oorRecoveryForceRebalanceThreshold}. Drift ${(driftPct * 100).toFixed(0)}%`
                    : `Drift ${(driftPct * 100).toFixed(0)}%. Net benefit: $${sim.netBenefitUsd.toFixed(2)}`,
                  rebalanceParams: {
                    newLowerBinId: recommended.lowerBinId,
                    newUpperBinId: recommended.upperBinId,
                    slippageBps: 50,
                  },
                };
              }
            }
          }
        }

        // HOLD — a held position with a healthy fee/IL and no recent warnings
        // stays put; anything else falls through to the pool's default HOLD.
        if (!decision && feeIlRatio > evolvedThresholds.minFeeIlRatio && !hasRecentWarning) {
          decision = {
            action: "HOLD",
            poolAddress,
            positionId: pos.positionId,
            confidence: Math.min(0.6 + feeIlRatio * 0.05, 0.9),
            reasoning: `Fee/IL ${feeIlRatio.toFixed(2)} above threshold. Holding.`,
          };
        }

        if (decision) {
          rawDecisions.push(decision);
          if (decision.action === "EXIT") poolExitFired = true;
        }
      }

      // ── ENTER slot: one per pool per cycle, under the per-pool cap ──────
      // A pool already exiting this cycle never re-enters in the same cycle;
      // the count cap (MAX_POSITIONS_PER_POOL) bounds stacked positions while
      // the allocation gate bounds their aggregate exposure.
      let enterGateRejected = false;
      if (!poolExitFired && poolPositions.length < config.maxPositionsPerPool) {
        if (unresolvedPoolAddresses.has(poolAddress)) {
          logger.warn("Skipping ENTER for unresolved pool", { pool: poolAddress });
          enterGateRejected = true;
        } else if (!approvedPoolAddresses.includes(poolAddress)) {
          logger.info("Skipping ENTER for unmanaged pool", { pool: poolAddress });
          enterGateRejected = true;
        } else {
          const entryBackoff = entryFailureBackoff.get(poolAddress);
          if (entryBackoff && entryBackoff.nextAttemptAt > Date.now()) {
            const retryAfterMs = entryBackoff.nextAttemptAt - Date.now();
            cycle.poolsDecided++;
            yield* audit
              .recordDecision({
                timestamp: Date.now(),
                cycleId,
                poolAddress,
                action: "ENTER",
                confidence: 0,
                reasoning: `[entry-backoff] insufficient token balance; retry in ${Math.ceil(retryAfterMs / 60_000)} minutes`,
                metrics,
                riskResult: {
                  approved: false,
                  reason: "Entry suppressed after insufficient token balance",
                },
                executed: false,
                paperTrading: config.paperTrading,
              })
              .pipe(Effect.catchAll(() => Effect.void));
            yield* memory
              .upsert({
                category: "warning",
                content: `Entry suppressed for ${poolAddress} after insufficient token balance; retry in ${Math.ceil(retryAfterMs / 60_000)} minutes.`,
                poolAddress,
              })
              .pipe(Effect.catchAll(() => Effect.void));
            enterGateRejected = true;
          }

          // F7: pool cooldown check — skip ENTER if this pool is on cooldown
          if (!enterGateRejected) {
            const cooldown = yield* db
              .getPoolCooldown(poolAddress)
              .pipe(Effect.catchAll(() => Effect.succeed(null)));
            if (cooldown && Date.now() < cooldown.cooldownUntil) {
              const remainingH = ((cooldown.cooldownUntil - Date.now()) / 3_600_000).toFixed(1);
              console.info(
                `[cooldown-gate] Skipping ENTER ${poolAddress} — on cooldown for ${remainingH}h (reason: ${cooldown.reason})`,
              );
              yield* memory
                .upsert({
                  category: "warning",
                  content: `Pool cooldown blocked ENTER on ${poolAddress}: ${cooldown.reason} (cooldown for ${remainingH}h more)`,
                  poolAddress,
                })
                .pipe(Effect.catchAll(() => Effect.void));
              yield* audit
                .recordDecision({
                  timestamp: Date.now(),
                  cycleId,
                  poolAddress,
                  action: "ENTER",
                  confidence: 0,
                  reasoning: `[cooldown-gate] ${cooldown.reason} — cooldown active for ${remainingH}h`,
                  metrics,
                  riskResult: { approved: false, reason: `[cooldown-gate] ${cooldown.reason}` },
                  executed: false,
                  paperTrading: config.paperTrading,
                })
                .pipe(Effect.catchAll(() => Effect.void));
              enterGateRejected = true;
            }
          }

          if (
            !enterGateRejected &&
            feeIlRatio > evolvedThresholds.minFeeIlRatio * 1.5 &&
            metrics.volumeAuthenticityKnown &&
            volumeAuth > 0.8 &&
            metrics.binUtilizationKnown &&
            binUtilization > 0.4 &&
            pool.tvlUsd > config.minPoolTvlUsd * 2
          ) {
            const entryScore = weightedEntryScore(metrics, signalWeights);
            if (entryScore <= config.weightedEntryScoreThreshold) {
              yield* audit
                .recordDecision({
                  timestamp: Date.now(),
                  cycleId,
                  poolAddress,
                  action: "ENTER",
                  confidence: 0,
                  reasoning: `[weighted-score] score ${entryScore.toFixed(3)} <= threshold ${config.weightedEntryScoreThreshold}`,
                  metrics,
                  riskResult: {
                    approved: false,
                    reason: `[weighted-score] ${entryScore.toFixed(3)} <= ${config.weightedEntryScoreThreshold}`,
                  },
                  executed: false,
                  paperTrading: config.paperTrading,
                })
                .pipe(Effect.catchAll(() => Effect.void));
              enterGateRejected = true;
            } else {
              const maxPositionSize = Math.min(walletBalanceUsd * 0.5, pool.tvlUsd * 0.005, 500);
              const proposedSizeUsd = Math.max(maxPositionSize, 10);

              // F5: per-pool allocation cap — aggregate across the pool's
              // positions so stacked exposure can't dominate the portfolio.
              const allocation = evaluatePerPoolAllocation({
                proposedDepositUsd: proposedSizeUsd,
                portfolioValueUsd,
                openPositions,
                maxPerPoolAllocationPct: config.maxPerPoolAllocationPct,
                maxOpenPositions: config.maxOpenPositions,
                poolAddress,
                maxPositionsPerPool: config.maxPositionsPerPool,
              });
              if (!allocation.approved) {
                console.info(`[alloc-gate] Skipping ENTER ${poolAddress} — ${allocation.reason}`);
                yield* memory
                  .upsert({
                    category: "pattern",
                    content: `Allocation gate skipped ENTER on ${poolAddress}: ${allocation.reason}`,
                    poolAddress,
                  })
                  .pipe(Effect.catchAll(() => Effect.void));
                yield* audit
                  .recordDecision({
                    timestamp: Date.now(),
                    cycleId,
                    poolAddress,
                    action: "ENTER",
                    confidence: 0,
                    reasoning: `[alloc-gate] ${allocation.reason}`,
                    metrics,
                    riskResult: { approved: false, reason: `[alloc-gate] ${allocation.reason}` },
                    executed: false,
                    paperTrading: config.paperTrading,
                  })
                  .pipe(Effect.catchAll(() => Effect.void));
                enterGateRejected = true;
              } else {
                const positionSizeUsd = allocation.adjustedDepositUsd;
                rawDecisions.push({
                  action: "ENTER",
                  poolAddress,
                  confidence: Math.min(0.5 + feeIlRatio * 0.05, 0.85),
                  reasoning: `Strong pool: Fee/IL ${feeIlRatio.toFixed(2)}, auth ${volumeAuth.toFixed(2)}, TVL $${pool.tvlUsd.toFixed(0)}`,
                  positionSizeUsd,
                });
              }
            }
          }
        }
      }

      if (rawDecisions.length === 0 && !enterGateRejected) {
        rawDecisions.push({
          action: "HOLD",
          poolAddress,
          confidence: 0.5,
          reasoning: `No strong signal. Fee/IL: ${feeIlRatio.toFixed(2)}`,
        });
      }
      if (rawDecisions.length === 0) {
        // An ENTER gate rejected with nothing else to do — mirror the legacy
        // early-return (the rejection was already audited by the gate).
        return [];
      }

      // ── Per-decision tail: overlay → supervised → risk → execution → audit.
      // Decisions run sequentially so a queued proposal consumed by one
      // decision is gone for the next, and so executions mutate tracking in
      // a deterministic order (per-position decisions first, ENTER last).
      const entryPrep = yield* EntryPrepService;

      // Resolve the deposit distribution for entries: a concrete configured
      // shape is used as-is; `auto` picks per pool from the recent volatility
      // regime (see recommendStrategyShape). `spot` is the default.
      const entryStrategyShape: EntryStrategyShape =
        config.entryStrategyType === "auto"
          ? recommendStrategyShape({
              volatilityStddev,
              highVolThreshold: config.volatilityExitStddev,
              netDriftBins:
                recentBins.length >= 2 ? recentBins[recentBins.length - 1]! - recentBins[0]! : 0,
            })
          : config.entryStrategyType;

      const finalDecisions: AgentDecision[] = [];

      for (const rawDecision of rawDecisions) {
        let decision = rawDecision;
        // The position this decision targets (EXIT/REBALANCE/HOLD). ENTER and
        // the default positionless HOLD have none. Re-resolved against the
        // live map so executions always act on current state.
        const pos =
          decision.positionId !== undefined ? trackedPositions.get(decision.positionId) : undefined;
        const hasOpenPosition = positionsForPool(trackedPositions, poolAddress).length > 0;
        let agentProposal: AgentProposal | null = null;
        let proposalSource: "queue" | "sync" | undefined;
        let appliedQueuedProposalId: string | undefined;
        /** True when a full/supervised proposal replaced the deterministic decision. */
        let appliedAgentProposal = false;
        /** True when any proposal (echo or behavior-changing) was validated and applied. */
        let proposalValidated = false;
        /** The deterministic decision before an applied proposal replaced it. */
        let preApplyDecision: AgentDecision | undefined;

        if (config.agentiveMode) {
          const proposalMode = config.agentProposalMode;
          const now = Date.now();

          if (proposalMode === "veto") {
            // Veto is a safety overlay: it runs independently of the proposal
            // backoff/circuit-breaker path so a transient failure cannot silence it.
            let vetoFetchFailed = false;
            const enhanced = yield* agent
              .enhanceDecision(decision, {
                decision,
                pool,
                metrics,
                warnings,
                recentDecisions: yield* audit
                  .getRecentDecisions(10)
                  .pipe(Effect.catchAll(() => Effect.succeed([]))),
                hasOpenPosition,
              })
              .pipe(
                Effect.catchAll((err) => {
                  vetoFetchFailed = true;
                  logger.warn("Agent veto fetch failed", {
                    pool: poolAddress,
                    error: String(err),
                  });
                  return Effect.succeed(null);
                }),
              );
            if (enhanced) {
              logger.info("Agent override", {
                pool: poolAddress,
                from: decision.action,
                to: enhanced.action,
                fromConfidence: decision.confidence.toFixed(2),
                toConfidence: enhanced.confidence.toFixed(2),
              });
              decision = enhanced;
            } else if (vetoFetchFailed) {
              const lastWarn = vetoWarningThrottle.get(poolAddress) ?? 0;
              if (now - lastWarn > config.agentProposalStaleMs) {
                vetoWarningThrottle.set(poolAddress, now);
                yield* memory
                  .upsert({
                    category: "warning",
                    content: `Agent veto fetch failed for ${poolAddress}`,
                    poolAddress,
                  })
                  .pipe(Effect.catchAll(() => Effect.void));
              }
            }
          } else {
            // suggest | supervised | full
            // HTTP queue consumption is independent of sync advisor backoff /
            // circuit-breaker state so AgentNoOp and failed local runtimes cannot
            // suppress already-enqueued /propose proposals.
            const poolCircuitBreaker = getPoolCircuitBreaker(poolAddress);
            let syncFetchFailed = false;

            const snapshot = yield* agentState.getSnapshot();
            const queuedProposal = findPendingProposal(
              snapshot.pendingProposals,
              poolAddress,
              proposalMode,
              config.agentProposalStaleMs,
              now,
            );
            if (queuedProposal) {
              agentProposal = queuedProposal;
              proposalSource = "queue";
            }

            if (!agentProposal && proposalMode !== "supervised") {
              const agentStatus = yield* agent.getStatus().pipe(
                Effect.catchAll(() =>
                  Effect.succeed({
                    connected: false,
                    transport: null,
                    lastPromptAt: null,
                    errorCount: 0,
                  }),
                ),
              );
              if (!hasSyncProposalTransport(agentStatus)) {
                // No local runtime / AgentNoOp: skip sync without recording failure.
              } else if (!poolCircuitBreaker.canTry(now)) {
                logger.info("Agent proposal circuit breaker open — skipping sync", {
                  pool: poolAddress,
                });
              } else if (isProposalBackoffActive(proposalBackoff.get(poolAddress), now)) {
                logger.info("Agent proposal sync skipped — backoff active", {
                  pool: poolAddress,
                });
              } else {
                const syncProposal = yield* agent
                  .enhanceDecision(decision, {
                    decision,
                    pool,
                    metrics,
                    warnings,
                    recentDecisions: yield* audit
                      .getRecentDecisions(10)
                      .pipe(Effect.catchAll(() => Effect.succeed([]))),
                    hasOpenPosition,
                  })
                  .pipe(
                    Effect.catchAll((err) => {
                      syncFetchFailed = true;
                      logger.warn("Agent proposal fetch failed", {
                        pool: poolAddress,
                        error: String(err),
                      });
                      return Effect.succeed(null);
                    }),
                  );
                if (syncProposal && isAgentProposal(syncProposal)) {
                  agentProposal = syncProposal;
                  proposalSource = "sync";
                } else if (syncProposal === null) {
                  // Real transport attempt returned null (parse/timeout/etc.).
                  syncFetchFailed = true;
                }
              }
            }

            if (agentProposal) {
              const poolBackoff = proposalBackoff.get(poolAddress);
              const proposalToEvaluate = {
                ...agentProposal,
                ...(agentProposal.originalAction === undefined
                  ? { originalAction: decision.action }
                  : {}),
                ...(agentProposal.originalConfidence === undefined
                  ? { originalConfidence: decision.confidence }
                  : {}),
              };
              let validation = evaluateAgentProposal(
                proposalToEvaluate,
                {
                  openPositions,
                  portfolioValueUsd,
                  recentPnlUsd,
                  poolAddress,
                  originalDecision: decision,
                  activeBinId: pool.activeBinId,
                },
                config,
              );

              // Re-run deterministic capital-protection gates for agent REBALANCE
              // so advisors cannot skip min-interval / gas / recovery policy.
              // The gated position is the adjusted decision's target (inherited
              // from the deterministic decision by proposal validation).
              const gatePosId = validation.adjustedDecision?.positionId ?? decision.positionId;
              const gatePos = gatePosId !== undefined ? trackedPositions.get(gatePosId) : undefined;
              if (
                validation.valid &&
                validation.adjustedDecision?.action === "REBALANCE" &&
                gatePos !== undefined
              ) {
                const currentLowerBinId = gatePos.lowerBinId;
                const currentUpperBinId = gatePos.upperBinId;
                const positionCenter = (currentLowerBinId + currentUpperBinId) / 2;
                const oorGraceExpired = gatePos.oorCycleCount >= config.oorGracePeriodCycles;
                const recoveryProb = estimateRecoveryProbability(
                  recoveryBins,
                  Math.abs(pool.activeBinId - positionCenter),
                );
                const positionSharePct =
                  pool.tvlUsd > 0 && gatePos.currentValueUsd > 0
                    ? Math.min(gatePos.currentValueUsd / pool.tvlUsd, 1)
                    : 0;
                const positionDailyFeesUsd = pool.fees24hUsd * positionSharePct;
                const capitalGate = evaluateAgentRebalanceCapitalGates({
                  now,
                  lastRebalanceAt: gatePos.lastRebalanceAt ?? 0,
                  minRebalanceIntervalMs: config.minRebalanceIntervalMs,
                  oorGraceExpired,
                  rebalanceGasCostSol: config.rebalanceGasCostSol,
                  solPriceUsd: config.solPriceUsd,
                  positionDailyFeesUsd,
                  minDaysOfFeesPaidAhead: config.gasAwareMinDaysOfFeesPaidAhead,
                  recoveryProbability: recoveryProb,
                  oorRecoveryHoldThreshold: config.oorRecoveryHoldThreshold,
                });
                if (!capitalGate.approved) {
                  validation = { valid: false, reason: capitalGate.reason };
                }
              }

              if (validation.valid && validation.adjustedDecision) {
                if (proposalMode === "suggest") {
                  logger.info("Agent proposal suggested (advisory)", {
                    source: proposalSource,
                    pool: poolAddress,
                    from: decision.action,
                    suggested: validation.adjustedDecision.action,
                  });
                  yield* memory
                    .upsert({
                      category: "pattern",
                      content: `Advisory suggestion for ${poolAddress}: ${validation.adjustedDecision.action} (confidence ${validation.adjustedDecision.confidence.toFixed(2)})`,
                      poolAddress,
                    })
                    .pipe(Effect.catchAll(() => Effect.void));

                  proposalBackoff.delete(poolAddress);
                  poolCircuitBreaker.recordSuccess();

                  if (proposalSource === "queue" && agentProposal.proposalId) {
                    yield* agentState
                      .dequeueProposals([agentProposal.proposalId])
                      .pipe(Effect.catchAll(() => Effect.void));
                  }
                } else {
                  logger.info("Agent proposal applied", {
                    source: proposalSource,
                    pool: poolAddress,
                    from: decision.action,
                    to: validation.adjustedDecision.action,
                  });
                  preApplyDecision = decision;
                  const originalAction = decision.action;
                  const deterministicReasoning = decision.reasoning;
                  decision = validation.adjustedDecision;
                  if (
                    originalAction === "EXIT" &&
                    decision.action === "EXIT" &&
                    deterministicReasoning.length > 0
                  ) {
                    decision = { ...decision, reasoning: deterministicReasoning };
                  }
                  // Only count real executable changes toward risk-deny backoff /
                  // circuit failure. Pure preserve-original echoes that later
                  // fail the confidence gate must not silence the advisor.
                  // Defer backoff clear / circuit success until risk.evaluate
                  // approves — otherwise apply→risk-deny loops reset counters.
                  proposalValidated = true;
                  if (
                    decisionChangesExecutableBehavior(
                      preApplyDecision,
                      decision,
                      config.confidenceThreshold,
                    )
                  ) {
                    appliedAgentProposal = true;
                  }

                  // Queued proposals are retained until execution succeeds (or
                  // the applied decision is a non-executing HOLD) so a
                  // transient failure can be retried on the next cycle.
                  // Deterministic risk denials reject/drop the proposal earlier.
                  // No-op echoes still set the id so the queue entry is consumed.
                  if (proposalSource === "queue" && agentProposal.proposalId) {
                    appliedQueuedProposalId = agentProposal.proposalId;
                  }
                }
                yield* agentState
                  .setAgentPolicy({ lastProposalAt: now })
                  .pipe(Effect.catchAll(() => Effect.void));
              } else {
                logger.warn("Agent proposal rejected", {
                  source: proposalSource,
                  pool: poolAddress,
                  reason: validation.reason,
                });
                proposalBackoff.set(
                  poolAddress,
                  nextProposalBackoff(poolBackoff, now, {
                    baseMs: config.agentProposalBackoffBaseMs,
                    maxMs: config.agentProposalBackoffMaxMs,
                  }),
                );
                poolCircuitBreaker.recordFailure(now);
                yield* memory
                  .upsert({
                    category: "warning",
                    content: `Agent proposal rejected for ${poolAddress}: ${validation.reason}`,
                    poolAddress,
                  })
                  .pipe(Effect.catchAll(() => Effect.void));

                if (proposalSource === "queue" && agentProposal.proposalId) {
                  yield* agentState
                    .rejectProposal(agentProposal.proposalId)
                    .pipe(Effect.catchAll(() => Effect.void));
                }
                yield* agentState
                  .setAgentPolicy({ lastProposalAt: now })
                  .pipe(Effect.catchAll(() => Effect.void));
              }
            } else if (syncFetchFailed) {
              logger.warn("Agent proposal fetch failed — recording backoff", {
                pool: poolAddress,
              });
              proposalBackoff.set(
                poolAddress,
                nextProposalBackoff(proposalBackoff.get(poolAddress), now, {
                  baseMs: config.agentProposalBackoffBaseMs,
                  maxMs: config.agentProposalBackoffMaxMs,
                }),
              );
              poolCircuitBreaker.recordFailure(now);
              yield* memory
                .upsert({
                  category: "warning",
                  content: `Agent proposal fetch failed for ${poolAddress}`,
                  poolAddress,
                })
                .pipe(Effect.catchAll(() => Effect.void));
            }
          }
        }

        // Supervised mode gates execution on human approval: without an applied
        // approved proposal, ENTER/REBALANCE decisions are held until one is
        // available. Deterministic EXITs are exempt — they are safety actions
        // the engine keeps final authority over.
        if (
          shouldHoldForSupervisedApproval(
            config.agentiveMode,
            config.agentProposalMode,
            appliedQueuedProposalId !== undefined,
            decision.action,
          )
        ) {
          logger.info("Supervised mode: holding decision pending approved proposal", {
            pool: poolAddress,
            action: decision.action,
          });
          decision = {
            ...decision,
            action: "HOLD",
            reasoning: `Supervised mode: awaiting approved proposal (held ${decision.action}: ${decision.reasoning})`,
          };
        }

        // Risk evaluation. HOLD executes nothing, so risk gates are skipped for
        // it — every rejection used to write a 60-day warning memory, and those
        // warnings then suppressed the good-HOLD branch (hasRecentWarning),
        // feeding a self-sustaining spam loop that flooded vector memory.
        const riskCtx = {
          openPositions,
          portfolioValueUsd,
          recentPnlUsd,
          poolAddress,
          activeBinId: pool.activeBinId,
          positionId: decision.positionId,
        };
        const riskResult: RiskResult =
          decision.action === "HOLD"
            ? { approved: true, reason: "HOLD — no execution; risk gates skipped" }
            : risk.evaluate(decision, riskCtx);

        // Apply risk-adjusted position size cap
        if (riskResult.adjustedSizeUsd && decision.action === "ENTER") {
          decision.positionSizeUsd = riskResult.adjustedSizeUsd;
          decision.reasoning += ` (size capped to $${riskResult.adjustedSizeUsd.toFixed(0)})`;
        }

        if (!riskResult.approved) {
          console.warn("Risk engine rejected", {
            reason: riskResult.reason,
            pool: poolAddress,
          });
          yield* sendAgentAlert(
            "warning",
            "risk_rejected",
            `Risk gate rejected ${decision.action} on ${pool.tokenXSymbol}/${pool.tokenYSymbol}: ${riskResult.reason}`,
            { pool, metrics, position: pos },
          );
          yield* alertSvc.sendAlert({
            type: "risk_rejection",
            severity: "warning",
            message: `Risk gate rejected ${decision.action} on ${pool.tokenXSymbol}/${pool.tokenYSymbol}: ${riskResult.reason}`,
            poolAddress,
            ...(pos !== undefined ? { positionId: pos.positionId } : {}),
            data: { action: decision.action, reason: riskResult.reason },
          });
          yield* audit
            .recordDecision({
              timestamp: Date.now(),
              cycleId,
              poolAddress,
              action: decision.action,
              confidence: decision.confidence,
              reasoning: decision.reasoning,
              metrics,
              riskResult,
              executed: false,
              paperTrading: config.paperTrading,
            })
            .pipe(Effect.catchAll(() => Effect.void));
          yield* memory
            .upsert({
              category: "warning",
              content: `Decision rejected: ${riskResult.reason}. Action: ${decision.action}`,
              poolAddress,
            })
            .pipe(Effect.catchAll(() => Effect.void));

          // Deterministic risk denials are sticky (drawdown pause, stop-loss, etc.).
          // Arm backoff / circuit breaker for applied sync or queue proposals so
          // the same doomed advisor response is not re-requested every scan.
          // Queued proposals are rejected; transient execution failures still
          // retry via finalize. A pure gate-crossing nudge is penalized only when
          // it caused the denial — denials the deterministic decision would have
          // received identically are not the advisor's fault.
          const penalizeAppliedProposal = shouldPenalizeAppliedProposalDenial({
            appliedAgentProposal,
            preApplyDecision,
            appliedDecision: decision,
            isPreApplyRiskApproved: () =>
              preApplyDecision !== undefined && risk.evaluate(preApplyDecision, riskCtx).approved,
          });
          yield* recordAppliedProposalRiskDenial(agentState, {
            penalizeAdvisor: penalizeAppliedProposal,
            appliedQueuedProposalId,
            proposalBackoff,
            recordCircuitFailure: penalizeAppliedProposal
              ? (t) => getPoolCircuitBreaker(poolAddress).recordFailure(t)
              : undefined,
            poolAddress,
            now: Date.now(),
            backoff: {
              baseMs: config.agentProposalBackoffBaseMs,
              maxMs: config.agentProposalBackoffMaxMs,
            },
          });
          finalDecisions.push(decision);
          continue;
        }

        // Any validated proposal that survives risk is a usable advisor response:
        // clear per-pool backoff and reset the breaker, including no-op echoes.
        recordAppliedProposalRiskApproval({
          proposalValidated,
          proposalBackoff,
          recordCircuitSuccess: () => getPoolCircuitBreaker(poolAddress).recordSuccess(),
          poolAddress,
        });

        if (decision.action === "EXIT") {
          const pendingCooldown = yield* computeCooldownForExit(decision, pos);
          if (pendingCooldown) {
            yield* db.setPoolCooldown(pendingCooldown).pipe(Effect.catchAll(() => Effect.void));
          }
        }

        const signalTimestamp = Date.now();
        const signalSnapshotId = yield* db
          .saveSignalSnapshot({
            poolAddress,
            timestamp: signalTimestamp,
            feeIlRatio: metrics.feeIlRatio,
            volumeAuthenticity: metrics.volumeAuthenticity,
            binUtilization: metrics.binUtilization,
            tvlUsd: pool.tvlUsd,
            tvlVelocity: metrics.tvlVelocity,
            volatilityStddev,
            binStep: pool.binStep,
            action: decision.action,
            confidence: decision.confidence,
          })
          .pipe(Effect.catchAll(() => Effect.succeed(null)));

        // Execute
        let executed = false;
        let executionError: string | undefined = undefined;

        // F6: paper-trading validation gate — only blocks ENTER, runs only in live mode
        if (!config.paperTrading && decision.action === "ENTER") {
          const paperDays = yield* readPaperDays;
          const validation = evaluatePaperValidation({
            paperTrading: false,
            paperDaysAccumulated: paperDays,
            minDays: config.paperValidationMinDays,
            enforce: config.paperValidationEnforce,
          });
          if (validation.warning) {
            console.warn(`[paper-validation] ${validation.warning}`);
          }
          if (!validation.approved) {
            console.warn(
              `[paper-validation] Blocking live ENTER on ${poolAddress} — ${validation.reason}`,
            );
            yield* memory
              .upsert({
                category: "warning",
                content: `Paper validation gate blocked live ENTER on ${poolAddress}: ${validation.reason}`,
                poolAddress,
              })
              .pipe(Effect.catchAll(() => Effect.void));
            yield* audit
              .recordDecision({
                timestamp: Date.now(),
                cycleId,
                poolAddress,
                action: decision.action,
                confidence: decision.confidence,
                reasoning: `[paper-validation] ${validation.reason}`,
                metrics,
                riskResult: { approved: false, reason: validation.reason },
                executed: false,
                paperTrading: false,
              })
              .pipe(Effect.catchAll(() => Effect.void));
            finalDecisions.push(decision);
            continue;
          }
        }

        const paperExitShouldGoLive =
          config.paperTrading &&
          decision.action === "EXIT" &&
          pos?.positionPubKey &&
          config.paperModeExitLive;

        if (decision.action === "ENTER" && config.entryStrategyType === "auto") {
          console.info(`[strategy-shape] auto resolved ${entryStrategyShape} for ${poolAddress}`, {
            volatilityStddev,
            netDriftBins:
              recentBins.length >= 2 ? recentBins[recentBins.length - 1]! - recentBins[0]! : 0,
          });
        }
        if (decision.action === "ENTER" && config.volatilityAdaptiveRanges) {
          console.info(`[adaptive-range] ${poolAddress} halfWidth=${rangeHalfWidth}`, {
            volatilityStddev,
            binStep: pool.binStep,
            configuredBaseHalfWidth: config.entryRangeHalfWidthBins,
          });
        }

        if (paperExitShouldGoLive) {
          console.warn(
            `[PAPER] PAPER_MODE_EXIT_LIVE is enabled — executing live EXIT for ${poolAddress}`,
          );
          const liveResult = yield* executeLive(
            {
              adapter,
              strategy,
              db,
              revenueConfigSvc,
              trackedPositions,
              entryPrep,
              solPriceUsd: config.solPriceUsd,
              entryStrategyShape,
              entryRangeHalfWidth: rangeHalfWidth,
              reconcileRequestedPools,
            },
            decision,
            pool,
            signalTimestamp,
            signalSnapshotId ?? undefined,
          );
          executed = liveResult.executed;
          executionError = liveResult.error;
        } else if (config.paperTrading) {
          console.info("[PAPER] Would execute", {
            action: decision.action,
            pool: poolAddress,
          });
          const paperResult = yield* executePaper(
            {
              db,
              trackedPositions,
              strategy,
              entryStrategyShape,
              entryRangeHalfWidth: rangeHalfWidth,
            },
            decision,
            pool,
            signalTimestamp,
            signalSnapshotId ?? undefined,
          );
          executed = paperResult.executed;
          executionError = paperResult.error;
        } else {
          const liveResult = yield* executeLive(
            {
              adapter,
              strategy,
              db,
              revenueConfigSvc,
              trackedPositions,
              entryPrep,
              solPriceUsd: config.solPriceUsd,
              entryStrategyShape,
              entryRangeHalfWidth: rangeHalfWidth,
              reconcileRequestedPools,
            },
            decision,
            pool,
            signalTimestamp,
            signalSnapshotId ?? undefined,
          );
          executed = liveResult.executed;
          executionError = liveResult.error;
        }

        if (decision.action !== "HOLD") {
          if (executed) {
            cycle.poolsExecuted++;
          } else {
            cycle.poolsFailed++;
          }
        }
        if (executed && decision.action === "EXIT") {
          yield* alertSvc.sendAlert({
            type: "exit_executed",
            severity: "critical",
            message: `EXIT executed on ${pool.tokenXSymbol}/${pool.tokenYSymbol}: ${decision.reasoning}`,
            poolAddress,
            ...(pos !== undefined ? { positionId: pos.positionId } : {}),
            data: { reasoning: decision.reasoning, paperTrading: config.paperTrading },
          });
        }
        if (decision.action === "ENTER" && isInsufficientTokenBalanceError(executionError)) {
          const backoff = nextEntryFailureBackoff(entryFailureBackoff.get(poolAddress));
          entryFailureBackoff.set(poolAddress, backoff);
          logger.warn("Entry suppressed after insufficient token balance", {
            pool: poolAddress,
            retryAfterMs: backoff.nextAttemptAt - Date.now(),
            failures: backoff.failures,
          });
        } else if (decision.action === "ENTER" && executed) {
          entryFailureBackoff.delete(poolAddress);
        }

        // Risk-rejected paths reject/drop the proposal before this point.
        // Paper-validation-blocked and failed executions retain for retry.
        yield* finalizeAppliedProposal(
          agentState,
          appliedQueuedProposalId,
          executed,
          decision.action,
        );

        // Audit after execution
        yield* audit
          .recordDecision({
            timestamp: Date.now(),
            cycleId,
            poolAddress,
            action: decision.action,
            confidence: decision.confidence,
            reasoning: decision.reasoning,
            metrics,
            riskResult,
            executed,
            error: executionError,
            paperTrading: config.paperTrading,
          })
          .pipe(Effect.catchAll(() => Effect.void));

        // Threshold evolution: increment counter on EXIT, try evolve at interval
        if (decision.action === "EXIT" && executed) {
          yield* incrementEvolutionCount.pipe(Effect.catchAll(() => Effect.void));
          yield* tryEvolveThresholds.pipe(Effect.catchAll(() => Effect.void));
        }

        if (
          executed &&
          (decision.action === "ENTER" ||
            decision.action === "EXIT" ||
            decision.action === "REBALANCE")
        ) {
          const trigger = decision.action.toLowerCase() as AgentRuntimeCheckin["trigger"];
          yield* maybeSendAgentCheckin(trigger).pipe(Effect.catchAll(() => Effect.void));
        }

        finalDecisions.push(decision);
      }

      return finalDecisions;
    });

  // ─── Periodic fee claiming ─────────────────────────────────────────────────

  const claimAllFees = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      const revenueConfigResult = yield* revenueConfigSvc.getConfig();
      const platformFeeRate = revenueConfigResult.platformFeeRate;
      const revenueShareEnabled = revenueConfigResult.revenueShareEnabled;
      const revenueShareOperatorPct = revenueConfigResult.revenueShareOperatorPct;
      const tier = revenueConfigResult.tier;

      for (const pos of trackedPositions.values()) {
        const poolAddress = pos.poolAddress;
        if (pos.positionPubKey && Date.now() - pos.lastFeeClaimAt > config.feeClaimIntervalMs) {
          // LM farm rewards ride the same periodic cadence as swap-fee
          // claims. The adapter skips silently for LimitOrder pools and
          // positions with no pending rewards, so this is a cheap no-op for
          // non-farm positions. Rewards are tracked separately from fees:
          // cumulativeFeesClaimedUsd stays fee-pure (fee APR), while the
          // USD-valued portion accumulates in cumulativeRewardsClaimedUsd.
          if (config.farmRewardsEnabled) {
            const rewardResult = yield* adapter
              .claimRewards(poolAddress, pos.positionPubKey)
              .pipe(Effect.catchAll(() => Effect.succeed(null)));
            if (rewardResult && !rewardResult.skipped && rewardResult.rewards.length > 0) {
              const rewardSummary = summarizeRewardClaim(rewardResult.rewards);
              console.info("Farm rewards claimed", {
                pool: poolAddress,
                rewards: rewardResult.rewards,
                totalUsd: rewardSummary.totalUsd,
                txSignatures: rewardResult.txSignatures,
              });
              pos.cumulativeRewardsClaimedUsd += rewardSummary.totalUsd;
              // Re-arm the shared claim gate: lastFeeClaimAt means "last
              // on-chain claim of either kind" — a successful reward claim is
              // a real claim tx, so the position waits one full interval
              // before the next claim pass even when swap fees are zero
              // (their claim path never updates the timestamp on a zero
              // result, which would otherwise re-fire every scan cycle).
              pos.lastFeeClaimAt = Date.now();
              yield* db.savePosition(pos).pipe(Effect.catchAll(() => Effect.void));
              yield* db
                .savePositionEvent({
                  id: randomUUID(),
                  poolAddress,
                  positionPubKey: pos.positionPubKey,
                  positionId: pos.positionId,
                  event: "CLAIM",
                  valueUsd: rewardSummary.totalUsd > 0 ? rewardSummary.totalUsd : null,
                  feesUsd: null,
                  price: null,
                  metadata: buildRewardClaimMetadata({
                    txSignatures: rewardResult.txSignatures,
                    rewards: rewardResult.rewards,
                  }),
                  createdAt: Date.now(),
                })
                .pipe(Effect.catchAll(() => Effect.void));
              if (rewardSummary.unpricedCount > 0) {
                yield* memory
                  .upsert({
                    category: "warning",
                    content: `Claimed ${rewardSummary.unpricedCount} farm reward(s) for ${poolAddress} without USD pricing — raw amounts recorded in position_events.`,
                    poolAddress,
                  })
                  .pipe(Effect.catchAll(() => Effect.void));
              }
            }
          }

          const result = yield* adapter
            .claimFees(
              poolAddress,
              pos.positionPubKey,
              platformFeeRate,
              revenueShareEnabled,
              revenueShareOperatorPct,
              revenueConfigResult.feeWalletAddress,
            )
            .pipe(
              Effect.tap((r) =>
                console.info("Fees claimed", {
                  pool: poolAddress,
                  tier,
                  feeX: r.feeX,
                  feeY: r.feeY,
                  platformFeeX: r.platformFeeX,
                  platformFeeY: r.platformFeeY,
                  netFeeX: r.netFeeX,
                  netFeeY: r.netFeeY,
                  tx: r.txSignature,
                }),
              ),
              Effect.catchAll(() => Effect.succeed(null)),
            );
          if (!result || (result.feeX === 0 && result.feeY === 0)) {
            continue;
          }

          const netFeesUsd = convertClaimFeesToUsd({
            netFeeXRaw: result.netFeeX,
            netFeeYRaw: result.netFeeY,
            tokenXSymbol: pos.tokenXSymbol,
            tokenYSymbol: pos.tokenYSymbol,
            solPriceUsd: config.solPriceUsd,
          });

          yield* db
            .saveFeeClaim({
              id: randomUUID(),
              poolAddress,
              positionPubkey: pos.positionPubKey,
              feeX: result.feeX,
              feeY: result.feeY,
              platformFeeX: result.platformFeeX,
              platformFeeY: result.platformFeeY,
              netFeeX: result.netFeeX,
              netFeeY: result.netFeeY,
              operatorFeeX: result.operatorFeeX ?? 0,
              operatorFeeY: result.operatorFeeY ?? 0,
              txSignature: result.txSignature,
              feeTransferTxSignature: result.feeTransferTxSignature ?? null,
              reportedToApi: false,
              createdAt: Date.now(),
            })
            .pipe(Effect.catchAll(() => Effect.void));

          if (
            result.platformFeeX > 0 ||
            result.platformFeeY > 0 ||
            (result.operatorFeeX ?? 0) > 0 ||
            (result.operatorFeeY ?? 0) > 0
          ) {
            yield* Effect.fork(
              adapter
                .reportFeeCollection({
                  poolAddress,
                  ...(pos.positionPubKey != null && { positionPubkey: pos.positionPubKey }),
                  feeX: result.feeX,
                  feeY: result.feeY,
                  platformFeeX: result.platformFeeX,
                  platformFeeY: result.platformFeeY,
                  tier,
                  txSignature: result.txSignature,
                  ...(result.feeTransferTxSignature != null && {
                    feeTransferTxSignature: result.feeTransferTxSignature,
                  }),
                  ...(result.operatorFeeX != null && {
                    operatorFeeX: result.operatorFeeX,
                  }),
                  ...(result.operatorFeeY != null && {
                    operatorFeeY: result.operatorFeeY,
                  }),
                })
                .pipe(
                  Effect.catchAllCause((cause) =>
                    Effect.sync(() =>
                      console.error("reportFeeCollection failed", { cause: String(cause) }),
                    ),
                  ),
                ),
            ).pipe(Effect.asVoid);
          }

          pos.lastFeeClaimAt = Date.now();
          pos.cumulativeFeesClaimedUsd += netFeesUsd;
          yield* db.savePosition(pos).pipe(Effect.catchAll(() => Effect.void));

          yield* db
            .savePositionEvent({
              id: randomUUID(),
              poolAddress,
              positionPubKey: pos.positionPubKey,
              positionId: pos.positionId,
              event: "CLAIM",
              valueUsd: null,
              feesUsd: netFeesUsd,
              price: null,
              metadata: { txSignature: result.txSignature },
              createdAt: Date.now(),
            })
            .pipe(Effect.catchAll(() => Effect.void));

          yield* alertSvc.recordFeeClaim(poolAddress, netFeesUsd);

          const feeDestination = config.feeDestination ?? "compound";
          if (feeDestination !== "compound") {
            const liveConversion = adapter.convertClaimedFees
              ? adapter
                  .convertClaimedFees(poolAddress, feeDestination, result.netFeeX, result.netFeeY)
                  .pipe(Effect.catchAll(() => Effect.succeed(null)))
              : Effect.succeed(null);
            const conversion = config.paperTrading
              ? Effect.succeed({
                  destination: feeDestination,
                  outputAtomic: 0n,
                  outputUsd: null,
                  txSignatures: [] as ReadonlyArray<string>,
                })
              : liveConversion;
            const converted = yield* conversion;
            if (converted) {
              yield* db
                .savePositionEvent({
                  id: randomUUID(),
                  poolAddress,
                  positionPubKey: pos.positionPubKey,
                  positionId: pos.positionId,
                  event: "CLAIM",
                  valueUsd: converted.outputUsd,
                  feesUsd: null,
                  price: null,
                  metadata: {
                    kind: "fee_accumulation",
                    destination: converted.destination,
                    outputAtomic: converted.outputAtomic.toString(),
                    txSignatures: converted.txSignatures,
                  },
                  createdAt: Date.now(),
                })
                .pipe(Effect.catchAll(() => Effect.void));
            }
            continue;
          }

          // F3: fee compounding — if AUTO_COMPOUND_FEES is on and the net fees
          // cleared the cost threshold, redeposit them into the same range.
          // This closes + reopens the position around the same bins so the
          // claimed fees become new liquidity instead of sitting in the wallet.
          if (config.autoCompoundFees && config.paperTrading === false) {
            const rebalanceGasCostUsd = config.rebalanceGasCostSol * config.solPriceUsd;
            const compoundGate = evaluateCompoundGate({
              netFeesUsd,
              minCompoundFeesUsd: config.minCompoundFeesUsd,
              compoundGasBufferUsd: config.compoundGasBufferUsd,
              rebalanceGasCostUsd,
            });
            if (compoundGate.approved) {
              console.info(
                `[compound] Redeeming fees back into ${poolAddress} — ${compoundGate.reason}`,
              );
              // Atomic rebalance into the same range with the just-claimed
              // net fees as top-up, so the claimed fees become new liquidity
              // in the preserved position (no close+reopen).
              const topUp = {
                amountXAtomic: BigInt(Math.max(Math.trunc(result.netFeeX), 0)),
                amountYAtomic: BigInt(Math.max(Math.trunc(result.netFeeY), 0)),
              };
              const compoundResult =
                topUp.amountXAtomic === 0n && topUp.amountYAtomic === 0n
                  ? null
                  : yield* adapter
                      .rebalancePosition(
                        poolAddress,
                        pos.positionPubKey,
                        pos.lowerBinId,
                        pos.upperBinId,
                        topUp,
                      )
                      .pipe(
                        Effect.tap((r) =>
                          console.info("Compound rebalance succeeded", {
                            pool: poolAddress,
                            position: r.positionPubKey,
                          }),
                        ),
                        Effect.catchAll((err) => {
                          console.warn("Compound rebalance failed", {
                            pool: poolAddress,
                            err: (err as { message?: string }).message ?? String(err),
                          });
                          return Effect.succeed(null);
                        }),
                      );
              if (compoundResult) {
                if (compoundResult.positionPubKey !== pos.positionId) {
                  // Defensive re-key (same contract as the atomic rebalance
                  // path): the identity and its row move with the pubkey.
                  trackedPositions.delete(pos.positionId);
                  yield* db.deletePosition(pos.positionId).pipe(Effect.catchAll(() => Effect.void));
                  pos.positionId = compoundResult.positionPubKey;
                  trackedPositions.set(pos.positionId, pos);
                }
                pos.positionPubKey = compoundResult.positionPubKey;
                pos.lastRebalanceAt = Date.now();
                // Compounded fees become new cost basis; currentValue/highest
                // adjust in lockstep so PnL and the trailing stop stay honest
                // (see applyCompoundToCostBasis in engine/pnl.ts).
                const compounded = applyCompoundToCostBasis({
                  depositedUsd: pos.depositedUsd,
                  currentValueUsd: pos.currentValueUsd,
                  highestValueUsd: pos.highestValueUsd,
                  compoundedFeesUsd: netFeesUsd,
                });
                pos.depositedUsd = compounded.depositedUsd;
                pos.currentValueUsd = compounded.currentValueUsd;
                pos.highestValueUsd = compounded.highestValueUsd;
                yield* db.savePosition(pos).pipe(Effect.catchAll(() => Effect.void));
                yield* db
                  .savePositionEvent({
                    id: randomUUID(),
                    poolAddress,
                    positionPubKey: pos.positionPubKey,
                    positionId: pos.positionId,
                    event: "COMPOUND",
                    valueUsd: netFeesUsd,
                    feesUsd: null,
                    price: null,
                    metadata: { savingsUsd: compoundGate.savingsUsd },
                    createdAt: Date.now(),
                  })
                  .pipe(Effect.catchAll(() => Effect.void));
                yield* memory
                  .upsert({
                    category: "pattern",
                    content: `Auto-compounded $${netFeesUsd.toFixed(2)} fees into ${poolAddress} (savings $${compoundGate.savingsUsd.toFixed(2)})`,
                    poolAddress,
                  })
                  .pipe(Effect.catchAll(() => Effect.void));
              }
            }
          }
        }
      }
    });

  // ─── Run initial cycle and schedule ────────────────────────────────────────

  yield* memory.initialize().pipe(Effect.catchAll(() => Effect.void));

  // Run first cycle
  yield* runScanCycle();

  let shuttingDown = false;
  const runScheduledCycle = Effect.gen(function* () {
    if (shuttingDown) return;
    if (reconcileRequestedPools.size > 0) {
      logger.warn("Reconciling pools flagged by failed atomic rebalances", {
        pools: [...reconcileRequestedPools],
      });
    }
    const reconcileResult = yield* reconcilePositions(
      adapter,
      db,
      memory,
      trackedPositions,
      approvedPoolAddresses,
    );
    reconcileRequestedPools.clear();
    refreshPoolsToScan(reconcileResult);
    yield* claimAllFees();
    yield* checkForAutoUpdate(config, db);
    yield* runScanCycle();
  }).pipe(
    Effect.catchAll((err) =>
      Effect.sync(() => {
        console.error("Cycle error:", err);
      }),
    ),
  );

  const schedulerFiber = yield* Effect.fork(
    Effect.forever(Effect.sleep(config.scanIntervalMs).pipe(Effect.zipRight(runScheduledCycle))),
  );

  const gracefulShutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`Received ${signal} — shutting down`);
    Effect.runFork(
      Fiber.interrupt(schedulerFiber).pipe(
        Effect.zipRight(agent.disconnect()),
        Effect.ensuring(Effect.sync(() => process.exit(0))),
      ),
    );
  };

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

  yield* Fiber.join(schedulerFiber);
});
