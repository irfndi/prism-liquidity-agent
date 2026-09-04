import { Effect, Fiber, Layer } from "effect";
import { ConfigService, ConfigLive, type AppConfig } from "./config-service.js";
import { AdapterLive, getUnpricedWalletMintCount } from "./adapter-service.js";
import { StrategyLive } from "./strategy-service.js";
import { MemoryLive } from "./memory-service.js";
import {
  RiskLive,
  type PerPoolAllocationResult,
  type RiskConfig,
  evaluateAgentProposal,
  evaluateAgentRebalanceCapitalGates,
  evaluateGasGate,
  evaluateCompoundGate,
  evaluatePerPoolAllocation,
  evaluatePaperValidation,
} from "./risk-service.js";
import {
  computeBinVolatilityStddev,
  isHighVolatility,
  recommendBinRangeForVolatility,
  dipOffsetBinsForPct,
  recommendStrategy,
  resolveRangeHalfWidth,
  estimateRecoveryProbability,
  shouldHoldForRecovery,
  evolveThresholds,
  computeSignalWeights,
  weightedEntryScore,
  driftGateRejected,
  normalEntryConfidence,
  DEFAULT_MOMENTUM_REFERENCE_BINS,
  DEFAULT_MOMENTUM_SCORE_WEIGHT,
  DEFAULT_MOMENTUM_CONF_BOOST,
  DEFAULT_MAX_NEGATIVE_DRIFT_BINS,
} from "./strategy-service.js";
import type { EvolvableThresholds } from "./strategy-service.js";
import { BlacklistLive } from "./blacklist-service.js";
import { AuditLive } from "./audit-service.js";
import { ScreenerLive, type ScreenerConfig } from "./screener-service.js";
import { DbLive, PRICE_SCALE_MIGRATION_KEY } from "./db-service.js";
import { RevenueConfigServiceLive } from "./revenue-config-service.js";
import { AgentStateMutable, initialSnapshot, type PositionSnapshot } from "./state-service.js";
import { McpServerLive } from "./mcp-server.js";
import { HttpStatusServerLive } from "./http-status-server.js";
import { EntryPrepLive } from "./entry-prep-service.js";
import { shouldDiscoverPools } from "./pool-policy.js";
import {
  DEFAULT_RUNNER_MIN_DRIFT_BINS,
  DEFAULT_RUNNER_MIN_FEE_APR,
  DEFAULT_ROTATION_APR_MULT,
  consecutiveAboveFloorObservations,
  isMarketRunnerPool,
  lowestAprHeldPosition,
  shouldRotate,
} from "./market-runner.js";
import {
  assessHerding,
  herdingBlocksEntry,
  isAprSelfOutlier,
  type ReturnSeries,
} from "./regime-gate.js";
import { runnerNetAprPct, runnerNetDailyPctAfterCosts } from "./fee-capture.js";
import { advanceScreenedCandidates } from "./candidate-discovery.js";
import {
  gateAndRankMarketPools,
  mintAuthorityRejectReason,
  type MarketPoolRank,
} from "./market-gate.js";
import {
  gateAndRankLaunchPools,
  summarizeLaunchRejections,
  type LaunchGateConfig,
  type LaunchPoolRank,
} from "./launch-gate.js";
import type { WashEvidence } from "./wash-forensics.js";
import { transitionCandidate } from "./candidate-policy.js";
import { getPrismUserConfigDir } from "./paths.js";

import { checkForAutoUpdate } from "./update-check.js";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { PositionRecord } from "./db-service.js";
import { applyCompoundToCostBasis, computeHodlValueUsd, computeRealizedPnlUsd } from "./pnl.js";
import { rollingRealizedPnlHalted as rollingRealizedPnlHaltSignal } from "./pnl-halt.js";
import { findPoolPnlKillSwitchTrips } from "./pool-pnl-kill-switch.js";
import { buildRewardClaimMetadata, summarizeRewardClaim } from "./rewards.js";
import { errorReporter } from "./error-reporter.js";
import {
  BlacklistError,
  DiscoverPoolsError,
  EntryPrepError,
  underlyingErrorMessage,
} from "./errors.js";
import {
  GAS_TOP_UP_USDC,
  SOL_GAS_TOP_UP_THRESHOLD_LAMPORTS,
  MIN_SOL_FOR_GAS_LAMPORTS,
  MIN_SOL_FOR_ENTRY_LAMPORTS,
  SOL_MINT,
  USDC_MINT,
} from "./constants.js";
import {
  computeEntrySizeUsd,
  computeIdleRedeploySizeUsd,
  ENTRY_SIZE_FLOOR_USD,
} from "./entry-sizing.js";
import {
  AdapterService,
  StrategyService,
  MemoryService,
  RiskService,
  BlacklistService,
  AuditService,
  ScreenerService,
  DbService,
  RevenueConfigService,
  AgentService,
  AgentStateService,
  McpServerService,
  HttpStatusServerService,
  EntryPrepService,
  MeteoraDatapiService,
  GeckoTerminalService,
  DexScreenerService,
  PythPriceService,
  AlertService,
  CopySignalService,
  type AdapterApi,
  type MeteoraPoolStats,
  type DbApi,
  type MemoryApi,
  type RiskResult,
  type ScreenedPool,
  type ScreenerApi,
  type DiscoveredPool,
  type StrategyApi,
  type RevenueConfigApi,
  type EntryPrepApi,
  type EntryPreparationOutcome,
  type AgentStateApi,
} from "./services.js";
import { MeteoraDatapiLive, enrichPoolWithDatapi } from "./meteora-datapi-service.js";
import { GeckoTerminalLive, enrichPoolFromGecko } from "./gecko-terminal-service.js";
import { DexScreenerLive } from "./dexscreener-service.js";
import { PythPriceLive } from "./pyth-price-service.js";
import { AlertLive } from "./alert-service.js";
import {
  detectDepegAndLiquidityDrain,
  type DepegLiquiditySignals,
} from "./depeg-liquidity-detector.js";
import { consultTokenRisks, type TokenRiskSignal } from "./token-risk-service.js";
import { CopySignalLive, applyCopySignalBoost } from "./copy-trading-signals.js";
import { evaluateFallenAngelDiscovery } from "./fallen-angel-discovery.js";
import { identifyAssetMint } from "./fallen-angel-service.js";
import { buildTpLadder, evaluateTpLadder, parseTpLadder, serializeTpLadder } from "./tp-ladder.js";
import { getGeckoPoolOhlcv, type GeckoOhlcvSignals } from "./gecko-ohlcv-service.js";
import { getRugCheckReport, type RugCheckReport } from "./rugcheck-service.js";
import {
  detectVolumeSpike,
  evaluateHotWindowEnter,
  evaluateHotWindowExit,
  hotWindowDayKey,
  type VolumeSpikeResult,
} from "./hot-window.js";
import { evaluateChurnGuard, type ChurnEntry } from "./churn-guard.js";
import {
  launchEntrySizeUsd,
  launchPositionExit,
  scaleInTopUpUsd,
  shouldScaleInRunner,
} from "./launch-position.js";
import type {
  AgentDecision,
  AgentProposal,
  AgentProposalMode,
  AgentCycle,
  EntryStrategySpec,
  EntryStrategyType,
  PoolMetrics,
  PoolSnapshot,
  PoolState,
  Position,
  RebalanceParams,
  SignalWeights,
  ActionType,
  AutonomousTokenMode,
  ExecutionOperationRecord,
  SettlementJobRecord,
  TokenCandidateRecord,
} from "./types.js";

import type {
  AgentPositionState,
  AgentRuntimeAlert,
  AgentRuntimeCheckin,
} from "./agent-transport.js";
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
import { computeCooldownForExit } from "./cooldown.js";
import {
  loadDailyEquityBaseline,
  oldestActiveSettlementAgeMs,
  persistDailyEquityBaseline,
  processSettlementJobs,
  safetyPauseBlockReason,
  settlementOverduePauseAction,
  shouldAutoResolveDailyDrawdownPause,
  shouldAutoResolveExecutionFailuresPause,
  decayExecutionFailureCounter,
  shouldTriggerSafetyPause,
  sweepOrphanSettlements,
} from "./autonomous-runtime.js";
import { routeProbeAmountAtomic } from "./route-probe.js";
import {
  estimateEntrySolLamports,
  freeEntrySolLamports,
  hasNativeSolLeg,
} from "./entry-sol-budget.js";

const logger = createLogger("program");
const idleRedeployLogger = createLogger("idle-redeploy");
const statusLogger = createLogger("engine-status");

/**
 * Run a DB persistence effect, logging (not swallowing) failures so a desync
 * between in-memory trackedPositions and SQLite is observable. Best-effort by
 * design — reconcilePositions and the on-chain record are the backstop — but
 * silent loss of a capital-state write is a reliability gap.
 */
function persist<T>(
  label: string,
  effect: Effect.Effect<T, Error, never>,
): Effect.Effect<void, never, never> {
  return Effect.catch(effect, (err) =>
    Effect.sync(() =>
      logger.warn(
        `DB persistence failed for ${label}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    ),
  );
}

/**
 * Read the Prism Cloud API key from the on-disk credentials file. Returns null
 * when the user has not registered — a normal condition, not an error, so status
 * reporting simply no-ops.
 */
const readEngineStatusApiKey = (): string | null => {
  try {
    const credentialsFile = join(getPrismUserConfigDir(), "credentials.json");
    if (!existsSync(credentialsFile)) return null;
    const parsed: unknown = JSON.parse(readFileSync(credentialsFile, "utf-8"));
    return parsed !== null &&
      Object.prototype.toString.call(parsed) === "[object Object]" &&
      // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
      Object.prototype.toString.call((parsed as { apiKey?: unknown }).apiKey) === "[object String]"
      ? // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
        (parsed as { apiKey: string }).apiKey
      : null;
  } catch {
    return null;
  }
};

/**
 * Post the engine's current status to the Prism Cloud API so the Telegram bot's
 * /status command can serve real data. Runs fully inside the Effect boundary
 * (filesystem read + HTTP request) and never fails — a missing API key or a
 * transient network error is logged and swallowed so it can never block the scan
 * cycle or the shutdown path. Mirrors the fire-and-forget `reportFeeCollection`
 * reporting pattern in this file.
 */
function postEngineStatus(
  status: "running" | "stopped",
  positions: number,
  unrealizedPnlUsd: number,
): Effect.Effect<void> {
  const DEFAULT_API_BASE_URL = "https://prism-api.irfndi.workers.dev";
  const TIMEOUT_MS = 5_000;
  return Effect.gen(function* () {
    const baseUrl = process.env.PRISM_API_URL ?? DEFAULT_API_BASE_URL;
    const apiKey = yield* Effect.sync(readEngineStatusApiKey);
    if (apiKey == null) return;
    const response = yield* Effect.tryPromise(() =>
      fetch(`${baseUrl}/v1/agent-status/report`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ status, positions, pnl: unrealizedPnlUsd }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    );
    if (!response.ok) {
      statusLogger.warn("Engine status report rejected", { status: response.status });
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => statusLogger.warn("Engine status report failed", { cause: String(cause) })),
    ),
  );
}

/**
 * How far back to look for a previous pool snapshot when computing TVL
 * velocity / IL drift. Wide enough to survive a day of downtime; the query is
 * indexed on (pool_address, timestamp) so this stays cheap.
 */
const PREVIOUS_SNAPSHOT_WINDOW_MS = 26 * 60 * 60 * 1000;

/** How often pool_snapshots pruning runs (rows older than the retention window are deleted). */
const SNAPSHOT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Empty-reap tombstone TTL. When rent reclaim fails, a reaped-empty position
// account lingers on-chain and reconcile would otherwise re-discover it as an
// "external position" every cycle (pointless EXIT -> reap churn). The pubkey
// stays tombstoned away from re-admission for this long; bounded so a later
// legitimate refill is eventually re-admitted. Shared by reconcilePositions
// (guard) and executeLive (write).
const EMPTY_REAP_REDISCOVERY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Mint → USD price map returned by the adapter; a named owner contract so
 * empty-lookup fallbacks don't widen a known value into an open dictionary. */
export type TokenPriceMap = Record<string, number>;

/** Shared empty price map for lookups that fail closed (indexing an empty map
 * yields `undefined`, which `prices[mint] != null` checks treat as unknown). */
const EMPTY_TOKEN_PRICES: TokenPriceMap = Object.create(null);

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

/** Derive the advisor-facing position snapshot for a decision that targets an
 *  open position. Unrealized PnL mirrors pnl.ts:
 *  value + fees claimed + rewards claimed − deposited (cost basis). */
export function toAgentPositionState(pos: PositionRecord, now: number): AgentPositionState {
  return {
    positionId: pos.positionId,
    valueUsd: pos.currentValueUsd,
    depositedUsd: pos.depositedUsd,
    unrealizedPnlUsd:
      pos.currentValueUsd +
      pos.cumulativeFeesClaimedUsd +
      pos.cumulativeRewardsClaimedUsd -
      pos.depositedUsd,
    feesClaimedUsd: pos.cumulativeFeesClaimedUsd,
    rewardsClaimedUsd: pos.cumulativeRewardsClaimedUsd,
    outOfRangeSinceMs: pos.outOfRangeSince,
    oorCycleCount: pos.oorCycleCount,
    hoursOutOfRange:
      pos.outOfRangeSince === null ? null : Math.max(0, now - pos.outOfRangeSince) / 3_600_000,
    // Clamp against future timestamps (clock skew) — mirrors pnl.ts's
    // Math.max(0, nowMs - openedAtMs).
    hoursHeld: Math.max(0, now - pos.timestamp) / 3_600_000,
    activeBinId: pos.activeBinId,
    lowerBinId: pos.lowerBinId,
    upperBinId: pos.upperBinId,
    entryPriceUsd: pos.entryPriceUsd,
    highestValueUsd: pos.highestValueUsd,
    lastRebalanceAtMs: pos.lastRebalanceAt,
  };
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
    ? agentState.dequeueProposals([appliedQueuedProposalId]).pipe(Effect.catch(() => Effect.void))
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
  if (before.positionSizeUsd !== after.positionSizeUsd) return true;
  return !rebalanceParamsEquivalent(before.rebalanceParams, after.rebalanceParams);
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
    .pipe(Effect.catch(() => Effect.void));
};

/** True when the agent runtime can actually send a sync proposal prompt. */
export function hasSyncProposalTransport(status: { readonly transport: string | null }): boolean {
  return status.transport !== null && status.transport !== "alert-only";
}

// ─── Position value estimation (fallback mark) ─────────────────
//
// The PRIMARY live mark is the real on-chain position value from the
// adapter (`getPositionValueUsd`: actual X/Y bin holdings priced at the
// token mints — captures genuine IL). This function is the FAIL-OPEN
// fallback used when the position account cannot be read, a leg is
// unpriceable, or the position is paper (no on-chain account). It is
// deliberately price-anchored (the HODL revaluation of the recorded entry
// legs) and NEVER the old bin-drift heuristic (`deposited ×
// (1 − 0.5 × driftPct)`), which fabricated 10-40% "drawdowns" from
// sub-1% price moves and fired the trailing stop every cycle. A fallback
// that cannot price simply returns the cost basis — a flat mark never
// invents a loss.

/**
 * True when the position carries finite entry legs against a positive live
 * price, so the HODL benchmark is computable (pre-v16 rows fail open to cost).
 */
function hasKnownEntryLegs(pos: PositionRecord, pool: PoolState): boolean {
  return (
    pos.entryPriceUsd != null &&
    pos.entryPriceUsd > 0 &&
    pos.entryAmountXUsd != null &&
    pos.entryAmountYUsd != null &&
    Number.isFinite(pos.entryAmountXUsd) &&
    Number.isFinite(pos.entryAmountYUsd) &&
    Number.isFinite(pool.currentPrice) &&
    pool.currentPrice > 0
  );
}

export function estimatePositionValue(pos: PositionRecord, pool: PoolState): number {
  if (!hasKnownEntryLegs(pos, pool)) return pos.depositedUsd;
  // SAFETY: hasKnownEntryLegs proved every leg non-null; the ?? 0 legs are dead
  // fallbacks that keep the typechecker honest without narrowing assertions.
  const hodl = computeHodlValueUsd(
    pos.entryAmountXUsd ?? 0,
    pos.entryAmountYUsd ?? 0,
    pos.entryPriceUsd ?? 0,
    pool.currentPrice,
  );
  if (hodl !== null && Number.isFinite(hodl) && hodl > 0) return hodl;
  return pos.depositedUsd;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Paper notional-fee accrual for one cycle (A4 paper/live parity). A paper
 * position never claims on-chain, so it accrues its proportional share of the
 * pool's REAL 24h fees while the active bin sits in range. Pure and guard-first:
 * heuristic pools (fees24h null/NaN/<=0) and dead TVL accrue 0 — never
 * fabricate. The elapsed window resolves to one scan interval on the first
 * cycle for a position, and is capped at 2× the scan interval afterwards so a
 * long downtime cannot dump a lump of fees into a single cycle. `inRange` is a
 * binary gate (active bin inside [lower, upper]), not a partial weight.
 */
export function computePaperFeeAccrualUsd(input: {
  readonly fees24hUsd: number | null | undefined;
  readonly tvlUsd: number;
  readonly depositedUsd: number;
  readonly activeBinId: number;
  readonly lowerBinId: number;
  readonly upperBinId: number;
  readonly firstCycle: boolean;
  readonly elapsedMs: number;
  readonly scanIntervalMs: number;
}): number {
  const fees24hUsd = input.fees24hUsd;
  if (!(input.tvlUsd > 0)) return 0;
  if (fees24hUsd == null || !Number.isFinite(fees24hUsd) || fees24hUsd <= 0) return 0;
  const dtMs = input.firstCycle
    ? input.scanIntervalMs
    : Math.min(Math.max(input.elapsedMs, 0), 2 * input.scanIntervalMs);
  if (!(dtMs > 0)) return 0;
  const tvlShare = Math.min(input.depositedUsd / input.tvlUsd, 1);
  const inRange =
    input.activeBinId >= input.lowerBinId && input.activeBinId <= input.upperBinId ? 1 : 0;
  return fees24hUsd * tvlShare * inRange * (dtMs / DAY_MS);
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

/**
 * Economic harvest gate (Robinhood rule 10): never spend $0.80 to realize
 * $1.00. Decides whether a pending fee claim clears the cost floor before any
 * on-chain claim tx executes. A `netUsd` of null means the pending amount is
 * genuinely unavailable (no adapter support, unpriceable legs, read failure)
 * — the gate FAILS OPEN and the claim proceeds (fee capture is protective).
 * Skip semantics mirror the zero-fee claim: the caller does NOT re-arm the
 * claim interval, so a skipped claim retries next scan.
 */
/** Metadata writes from the executor paths: some test mocks omit
 * setMetadata, so guard before calling — a metadata write must never fail an
 * ENTER/EXIT. */
export const persistMetadataIfSupported = (
  db: DbApi,
  key: string,
  value: string,
): Effect.Effect<void, never> =>
  db.setMetadata != null
    ? db.setMetadata(key, value).pipe(Effect.catch(() => Effect.void))
    : Effect.void;

export interface HarvestGateConfig {
  readonly harvestMinNetUsd?: number;
  readonly harvestMaxCostPct?: number;
  readonly harvestTxCostUsdEst?: number;
}

/** Outcome of the economic harvest gate (claim vs skip). */
export interface HarvestGateDecision {
  readonly approved: boolean;
  readonly reason: string;
}

export function evaluateHarvestGate(
  netUsd: number | null,
  config: HarvestGateConfig,
): HarvestGateDecision {
  const minNetUsd = config.harvestMinNetUsd ?? 1;
  const maxCostPct = config.harvestMaxCostPct ?? 0.15;
  const costUsd = config.harvestTxCostUsdEst ?? 0.005;
  if (netUsd == null) {
    return {
      approved: true,
      reason: "[harvest-gate] pending USD unavailable — fail open (claim anyway)",
    };
  }
  if (netUsd < minNetUsd) {
    return {
      approved: false,
      reason: `[harvest-gate] net $${netUsd.toFixed(4)} below floor $${minNetUsd} — claim skipped (retries next scan)`,
    };
  }
  if (costUsd > maxCostPct * netUsd) {
    return {
      approved: false,
      reason: `[harvest-gate] est cost $${costUsd} > ${maxCostPct * 100}% of net $${netUsd.toFixed(4)} — claim skipped (retries next scan)`,
    };
  }
  return {
    approved: true,
    reason: `[harvest-gate] net $${netUsd.toFixed(4)} clears floor $${minNetUsd} and est cost $${costUsd} ≤ ${maxCostPct * 100}% of net`,
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

/** Mean age of tracked positions in minutes (0 when none open). */
export function avgTrackedPositionAgeMin(
  trackedPositions: Map<string, PositionRecord>,
  now: number,
): number {
  if (trackedPositions.size === 0) return 0;
  let totalMs = 0;
  for (const pos of trackedPositions.values()) totalMs += now - pos.timestamp;
  return totalMs / trackedPositions.size / 60_000;
}

/**
 * Idle-redeploy confidence (P2 3654054423 + follow-up 3655288403): repo
 * doctrine (AGENTS.md §decision-loop) gives a modeled/fabricated fee/IL ratio
 * NO vote in an ENTER gate in EITHER direction. gecko candidates reach the pass
 * with feeIlRatioKnown=false (their fee figure is a binStep base-rate MODEL on
 * real volume), so the fee term is applied ONLY when the ratio is measured
 * (datapi) — exactly how weightedEntryScore drops its fee term when
 * feeIlRatioKnown is false. A modeled ratio can neither RAISE nor LOWER
 * redeploy confidence.
 *
 * An absent fee signal must neither HELP nor BLOCK a qualified candidate. A
 * flat fail-closed 0.5 sat below the default CONFIDENCE_THRESHOLD=0.65 and
 * rejected EVERY gecko candidate (gecko qualifies on measured volume/TVL +
 * on-chain bin utilization, never on fees). So when fee/IL is unknown the
 * confidence is derived from the signals that ARE known — measured volume
 * authenticity and on-chain bin utilization — while the modeled fee stays
 * silent. Known signals vote; the modeled fee does not.
 */
export function computeIdleRedeployConfidence(args: {
  readonly feeIlRatio: number;
  readonly feeIlRatioKnown: boolean;
  readonly volumeAuthenticity: number;
  readonly volumeAuthenticityKnown: boolean;
  readonly binUtilization: number;
  readonly binUtilizationKnown: boolean;
}): number {
  if (args.feeIlRatioKnown) {
    return Math.min(0.5 + args.feeIlRatio * 0.05, 0.85);
  }
  let confidence = 0.5;
  if (args.volumeAuthenticityKnown) {
    confidence += 0.1 + Math.max(0, args.volumeAuthenticity - 0.8) * 0.25;
  }
  if (args.binUtilizationKnown) {
    confidence += 0.05 + args.binUtilization * 0.1;
  }
  return Math.min(Math.max(confidence, 0), 0.85);
}

/**
 * A pool that passed this cycle's ENTER candidate conditions + weighted entry
 * score in-pool but whose normal ENTER did not consume the slot — eligible
 * for the opt-in idle-capital redeploy pass after the pools loop. The pass
 * re-runs evaluatePerPoolAllocation and the full risk tail verbatim before
 * executing, so the candidate record carries no authority to bypass anything;
 * it only seeds the pass's score-ranked choice.
 */
interface IdleRedeployCandidate {
  readonly poolAddress: string;
  readonly pool: PoolState;
  readonly metrics: PoolMetrics;
  readonly entryScore: number;
  readonly feeIlRatio: number;
  /**
   * The size the normal conservative path chose (or proposed) for this pool.
   * Mutable on purpose: when the normal ENTER for the pool actually executes,
   * the in-slot tail overwrites this with the FINAL executed size
   * (post-overlay, post-risk-adjustment) so the widened-size guard compares
   * against the position really opened, not a stale pre-overlay figure
   * (follow-up 3655404934). Candidates whose pool did not enter keep the
   * pre-computed size.
   */
  normalEntrySizeUsd: number;
  readonly volatilityStddev: number;
  readonly netDriftBins: number;
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

/** On-chain position identity from either reconcile source (chain or Data API). */
interface ReconcilablePosition {
  readonly poolAddress: string;
  readonly positionPubKey: string;
  readonly lowerBinId: number;
  readonly upperBinId: number;
}

/** Reconcile wallet address (null = walletless; reconcile degrades to success). */
function resolveReconcileWallet(adapter: AdapterApi): string | null | undefined {
  if (!adapter.hasWallet()) return null;
  return adapter.getWalletAddress();
}

/**
 * Delete loop — chain-only. A Data API feed must never drive a removal:
 * a stale/partial crawl would falsely mark a live position as externally
 * closed and delete real capital.
 */
function pruneExternallyClosedPositions(
  db: DbApi,
  memory: MemoryApi,
  trackedPositions: Map<string, PositionRecord>,
  onChainByPubkey: ReadonlyMap<string, ReconcilablePosition>,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    for (const [positionId, pos] of trackedPositions) {
      if (pos.positionPubKey && !onChainByPubkey.has(pos.positionPubKey)) {
        console.warn(
          `Reconciling: position ${positionId} on ${pos.poolAddress} no longer on-chain — removing from tracking`,
        );
        trackedPositions.delete(positionId);
        yield* persist(`deletePosition ${positionId}`, db.deletePosition(positionId));
        yield* memory
          .upsert({
            category: "warning",
            content: `Position ${positionId} on ${pos.poolAddress} was closed externally (e.g. via Solscan/Meteora UI). Removed from tracking.`,
            poolAddress: pos.poolAddress,
          })
          .pipe(Effect.catch(() => Effect.void));
      }
    }
  });
}

/**
 * Range-sync for one tracked position — chain-only (source authority). A
 * tracked position whose on-chain range moved under the same pubkey is
 * synced back to the real range instead of deciding on stale bins. On the
 * Data API path the range is never mutated from a third-party view.
 */
function syncDriftedPositionRange(
  db: DbApi,
  memory: MemoryApi,
  trackedPositions: Map<string, PositionRecord>,
  tracked: PositionRecord,
  onChainPos: ReconcilablePosition,
  source: "chain" | "datapi",
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (source !== "chain") return;
    if (
      tracked.lowerBinId === onChainPos.lowerBinId &&
      tracked.upperBinId === onChainPos.upperBinId
    ) {
      return;
    }
    console.warn(
      `Reconciling: position ${onChainPos.positionPubKey} on ${onChainPos.poolAddress} range drifted on-chain (${tracked.lowerBinId}-${tracked.upperBinId} → ${onChainPos.lowerBinId}-${onChainPos.upperBinId}) — syncing record`,
    );
    const updated: PositionRecord = {
      ...tracked,
      lowerBinId: onChainPos.lowerBinId,
      upperBinId: onChainPos.upperBinId,
    };
    trackedPositions.set(onChainPos.positionPubKey, updated);
    yield* persist(`savePosition ${updated.positionId}`, db.savePosition(updated));
    yield* memory
      .upsert({
        category: "warning",
        content: `Position ${onChainPos.positionPubKey} on ${onChainPos.poolAddress} range synced to on-chain state (${onChainPos.lowerBinId}-${onChainPos.upperBinId}).`,
        poolAddress: onChainPos.poolAddress,
      })
      .pipe(Effect.catch(() => Effect.void));
  });
}

/**
 * Adopt one newly discovered on-chain position on a watched pool (tombstoned
 * reaped-empty ghosts stay excluded until the bound lapses).
 */
function discoverExternalPosition(
  adapter: AdapterApi,
  db: DbApi,
  memory: MemoryApi,
  trackedPositions: Map<string, PositionRecord>,
  unresolvedPoolAddresses: Set<string>,
  onChainPos: ReconcilablePosition,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    // Never re-admit an account the engine already reaped as empty-on-chain
    // (rent reclaim may have failed, leaving the ghost account in the
    // wallet's on-chain set). Without this guard, reconcile would re-discover
    // the phantom row every cycle -> pointless EXIT -> reap churn. Bounded so
    // a later legitimate refill of the same account is eventually re-admitted.
    const reapTombstone = yield* db
      .getMetadata(`reaped_empty:${onChainPos.positionPubKey}`)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (reapTombstone !== null && Date.now() < Number(reapTombstone)) {
      console.warn(
        `Reconciling: skipping re-admission of reaped-empty position ${onChainPos.positionPubKey} on ${onChainPos.poolAddress} (ghost on-chain account)`,
      );
      return;
    }
    console.warn(
      `Reconciling: discovered external position ${onChainPos.positionPubKey} in ${onChainPos.poolAddress} — adding to tracking`,
    );
    const pool = yield* adapter.getPoolState(onChainPos.poolAddress).pipe(
      Effect.catch((err) => {
        console.error("Reconcile: failed to fetch pool state for external position", {
          pool: onChainPos.poolAddress,
          err: String(err),
        });
        unresolvedPoolAddresses.add(onChainPos.poolAddress);
        return Effect.succeed(null);
      }),
    );
    if (!pool) return;
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
    yield* persist(`savePosition ${pos.positionId}`, db.savePosition(pos));
    yield* memory
      .upsert({
        category: "warning",
        content: `External position ${onChainPos.positionPubKey} detected in ${onChainPos.poolAddress} and added to tracking.`,
        poolAddress: onChainPos.poolAddress,
      })
      .pipe(Effect.catch(() => Effect.void));
  });
}

export function reconcilePositions(
  adapter: AdapterApi,
  db: DbApi,
  memory: MemoryApi,
  trackedPositions: Map<string, PositionRecord>,
  poolsToScan: ReadonlyArray<string>,
): Effect.Effect<PositionReconcileResult> {
  return Effect.gen(function* () {
    const walletAddress = resolveReconcileWallet(adapter);
    if (!walletAddress) {
      return { succeeded: true, unresolvedPoolAddresses: new Set<string>() };
    }

    const onChainPositions = yield* adapter.getAllWalletPositions(walletAddress).pipe(
      Effect.catch((err) => {
        console.error("Reconcile: failed to fetch on-chain positions — falling back to Data API", {
          err: String(err),
        });
        return Effect.succeed(null);
      }),
    );

    // Chain is authoritative. When the aggregate on-chain position read fails
    // (e.g. Helius 429 under load), fall back to the keyless Meteora Data API
    // crawl — but in ADD-ONLY mode: the Data API is a delayed third-party view
    // that can lag/omit a position, so it may discover new external positions
    // but must NEVER remove or range-sync an existing tracked position.
    let reconcilablePositions = onChainPositions;
    let source: "chain" | "datapi" = "chain";
    if (onChainPositions === null && adapter.getWalletPositionsFromDatapi) {
      reconcilablePositions = yield* adapter.getWalletPositionsFromDatapi(walletAddress).pipe(
        Effect.catch((err) => {
          console.error("Reconcile: Data API fallback also failed — skipping", {
            err: String(err),
          });
          return Effect.succeed(null);
        }),
      );
      if (reconcilablePositions !== null) source = "datapi";
    }

    if (reconcilablePositions === null) {
      return {
        succeeded: false,
        unresolvedPoolAddresses: new Set(poolsToScan),
      };
    }

    // Match by position identity, not pool: a pool can hold several positions
    // (tight+wide pairs), so per-pool matching would conflate siblings.
    const onChainByPubkey = new Map(reconcilablePositions.map((p) => [p.positionPubKey, p]));
    const watchedPoolSet = new Set(poolsToScan);
    const unresolvedPoolAddresses = new Set<string>();

    // # Delete loop — chain-only. A Data API feed must never drive a removal:
    // a stale/partial crawl would falsely mark a live position as externally
    // closed and delete real capital. On the Data API path this loop is
    // skipped entirely.
    if (source === "chain") {
      yield* pruneExternallyClosedPositions(db, memory, trackedPositions, onChainByPubkey);
    }

    for (const onChainPos of reconcilablePositions) {
      const tracked = trackedPositions.get(onChainPos.positionPubKey);
      if (tracked) {
        // # Range-sync loop — chain-only (source authority). A tracked position
        // whose on-chain range moved under the same pubkey (e.g. an
        // externally-executed rebalance, or an atomic rebalance whose
        // confirmation errored after landing) is synced back to the real range
        // instead of deciding on stale bins. On the Data API path we do NOT
        // mutate a tracked position's range from a possibly-stale third-party
        // view — the chain read is the only authority that adjusts it.
        yield* syncDriftedPositionRange(db, memory, trackedPositions, tracked, onChainPos, source);
        continue;
      }
      if (watchedPoolSet.has(onChainPos.poolAddress)) {
        yield* discoverExternalPosition(
          adapter,
          db,
          memory,
          trackedPositions,
          unresolvedPoolAddresses,
          onChainPos,
        );
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
  | GeckoTerminalService
  | DexScreenerService
  | PythPriceService
  | AlertService
  | CopySignalService;

function screenerLayerConfig(cfg?: AppConfig): ScreenerConfig {
  return {
    minTvlUsd: cfg?.discoveryMinTvlUsd ?? 1_000_000,
    minFeeRatio: cfg?.discoveryMinFeeRatio ?? 1.5,
    volumeAuthThreshold: cfg?.volumeAuthThreshold ?? 0.7,
    minBinUtilization: cfg?.minBinUtilization ?? 0.3,
  };
}

function riskLayerConfig(cfg?: AppConfig): RiskConfig {
  const {
    confidenceThreshold = 0.65,
    maxRebalanceRangeBins = 50,
    stopLossPct = 0.15,
    maxPerPoolAllocationPct = 0.4,
    maxPositionsPerPool = 2,
  } = cfg ?? {};
  return {
    confidenceThreshold,
    maxRebalanceRangeBins,
    stopLossPct,
    maxPerPoolAllocationPct,
    maxPositionsPerPool,
  };
}

/** Agent decision-review layer: live transport when agentic mode is on, no-op otherwise. */
function resolveAgentLayer(cfg?: AppConfig): Layer.Layer<AgentService, never, never> {
  if (cfg?.agentiveMode !== true) return Layer.succeed(AgentService, AgentNoOp);
  return AgentLive(cfg);
}

/** Agent-state layer with the operator proposal-queue bound. */
function buildAgentStateLayer(cfg?: AppConfig): Layer.Layer<AgentStateService, never, never> {
  return AgentStateMutable({ maxPendingProposals: cfg?.agentProposalMaxQueueSize ?? 50 }).layer;
}

/** MCP stdio layer: live server when enabled, inert stub otherwise. */
function resolveMcpLayer(
  cfg: AppConfig | undefined,
  agentStateLayer: Layer.Layer<AgentStateService, never, never>,
): Layer.Layer<McpServerService, never, never> {
  if (cfg?.agentMcpEnabled !== true) {
    return Layer.succeed(McpServerService, { start: () => Effect.void, stop: () => Effect.void });
  }
  return Layer.provide(McpServerLive(cfg), agentStateLayer);
}

/** HTTP status layer: live server on a configured port, inert stub otherwise. */
function resolveHttpLayer(
  cfg: AppConfig | undefined,
  agentStateLayer: Layer.Layer<AgentStateService, never, never>,
): Layer.Layer<HttpStatusServerService, never, never> {
  if (cfg && cfg.agentHttpPort > 0) {
    return Layer.provide(HttpStatusServerLive(cfg), agentStateLayer);
  }
  return Layer.succeed(HttpStatusServerService, {
    start: () => Effect.void,
    stop: () => Effect.void,
  });
}

export function buildLayer(cfg?: AppConfig): Layer.Layer<AllServices, never, never> {
  const dbLayer = DbLive(cfg?.sqliteDbPath);
  const configLayer = ConfigLive;

  const adapter = Layer.provide(AdapterLive, Layer.merge(configLayer, dbLayer));
  const memory = Layer.provide(MemoryLive, dbLayer);
  const audit = Layer.provide(AuditLive, dbLayer);
  const meteoraDatapi = Layer.provide(MeteoraDatapiLive, configLayer);
  // Available-but-unconsumed: PythPriceLive exposes USD prices through the
  // PythPriceService Tag; no decision/risk code reads it yet (follow-up).
  const pythPrice = Layer.provide(PythPriceLive, configLayer);

  const screenerDeps = Layer.merge(adapter, StrategyLive);
  const screener = Layer.provide(ScreenerLive(screenerLayerConfig(cfg)), screenerDeps);

  const risk = RiskLive(riskLayerConfig(cfg));
  const blacklist = BlacklistLive({
    deployerBlacklistPath: cfg?.deployerBlacklistPath ?? "./engine/data/deployer-blacklist.json",
    tokenBlacklistPath: cfg?.tokenBlacklistPath ?? "./engine/data/token-blacklist.json",
  });

  const revenueConfigDeps = Layer.merge(dbLayer, configLayer);
  const revenueConfig = Layer.provide(RevenueConfigServiceLive, revenueConfigDeps);

  const entryPrepDeps = Layer.merge(Layer.merge(adapter, configLayer), dbLayer);
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
  const merged11c = Layer.merge(merged11b, GeckoTerminalLive);
  const merged11d = Layer.merge(merged11c, DexScreenerLive);
  const merged11e = Layer.merge(merged11d, pythPrice);

  const agentLayer = resolveAgentLayer(cfg);

  const agentStateLayer = buildAgentStateLayer(cfg);

  const mcpLayer = resolveMcpLayer(cfg, agentStateLayer);

  const httpLayer = resolveHttpLayer(cfg, agentStateLayer);

  const merged12 = Layer.merge(merged11e, agentLayer);
  const merged13 = Layer.merge(merged12, agentStateLayer);
  const merged14 = Layer.merge(merged13, mcpLayer);
  const merged15 = Layer.merge(merged14, httpLayer);

  const alertDeps = Layer.merge(dbLayer, configLayer);
  const alertLayer = Layer.provide(AlertLive, alertDeps);
  const merged16 = Layer.merge(merged15, alertLayer);
  const copySignalLayer = Layer.provide(CopySignalLive, configLayer);
  const merged17 = Layer.merge(merged16, copySignalLayer);

  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  return merged17 as Layer.Layer<AllServices, never, never>;
}

/**
 * Which token legs should be rug-blocked after a position closed at a
 * catastrophic realized loss. Returns only the NON-stable legs: a rug blocks
 * the rugged token, never the base (stablecoin/SOL) leg it was paired with, so
 * a drained token cannot lock USDC/SOL out of every other pool on the market.
 */
function rugBlockMints(input: {
  readonly realizedPnlUsd: number | null;
  readonly depositedUsd: number;
  readonly rugExitLossPct: number;
  readonly stablecoinMints: ReadonlySet<string> | undefined;
  readonly tokenX: string | undefined;
  readonly tokenY: string | undefined;
}): ReadonlyArray<string> {
  const { realizedPnlUsd, depositedUsd, rugExitLossPct } = input;
  if (realizedPnlUsd === null || depositedUsd <= 0) return [];
  if (-realizedPnlUsd / depositedUsd < rugExitLossPct) return [];
  const isStable = (mint: string) =>
    mint === SOL_MINT || (input.stablecoinMints?.has(mint) ?? false);
  return [input.tokenX, input.tokenY].filter(
    (mint): mint is string => mint !== undefined && mint !== "" && !isStable(mint),
  );
}

// ─── Paper execution ─────────────────────────────────────────────────────────

/** Paper-execution dependency and pool shapes (mirrors executePaper's contract). */
type PaperExecDeps = Parameters<typeof executePaper>[0];
type PaperExecPool = Parameters<typeof executePaper>[2];

/** Owner contract for the shared paper position-record builder. */
interface PaperPositionInput {
  readonly decision: AgentDecision;
  readonly pool: PaperExecPool;
  readonly positionId: string;
  readonly positionPubKey: string | null;
  readonly depositedUsd: number;
  readonly fullSizeUsd: number;
  readonly activeBinId: number;
  readonly lowerBinId: number;
  readonly upperBinId: number;
  readonly entryStrategySpec: EntryStrategySpec;
  readonly entryDipOffsetBins?: number | undefined;
  readonly signalTimestamp?: number | undefined;
  readonly signalSnapshotId?: number | undefined;
  readonly paperExitedAt?: number | null | undefined;
}

/** Nullable-field normalizer: six lockstep `?? null` call sites below. */
function orNull<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

/** Entry-leg split USD: dip entries go single-sided X, otherwise 50/50. */
interface PaperEntryLegUsd {
  readonly xUsd: number;
  readonly yUsd: number;
}
function paperEntryLegSplit(fullSizeUsd: number, dipEntry: boolean): PaperEntryLegUsd {
  if (dipEntry) return { xUsd: fullSizeUsd, yUsd: 0 };
  return { xUsd: fullSizeUsd / 2, yUsd: fullSizeUsd / 2 };
}

/** Launch-runner seed fields: set together on dip entries, null otherwise. */
interface PaperLaunchRunnerSeed {
  readonly runner: true | null;
  readonly steps: number | null;
  readonly anchorPrice: number | null;
}
function paperLaunchRunnerSeed(dipEntry: boolean, anchorPrice: number): PaperLaunchRunnerSeed {
  if (!dipEntry) return { runner: null, steps: null, anchorPrice: null };
  return { runner: true, steps: 0, anchorPrice };
}

/** Build a paper PositionRecord (single + ladder legs share every dip/shape rule). */
function makePaperPositionRecord(input: PaperPositionInput): PositionRecord {
  const { decision, pool } = input;
  const dipEntry = (input.entryDipOffsetBins ?? 0) !== 0;
  const legs = paperEntryLegSplit(input.fullSizeUsd, dipEntry);
  const runnerSeed = paperLaunchRunnerSeed(dipEntry, pool.currentPrice);
  return {
    positionId: input.positionId,
    poolAddress: decision.poolAddress,
    positionPubKey: input.positionPubKey,
    depositedUsd: input.depositedUsd,
    currentValueUsd: input.depositedUsd,
    tokenXSymbol: pool.tokenXSymbol,
    tokenYSymbol: pool.tokenYSymbol,
    activeBinId: input.activeBinId,
    lowerBinId: input.lowerBinId,
    upperBinId: input.upperBinId,
    timestamp: Date.now(),
    outOfRangeSince: null,
    oorCycleCount: 0,
    lastFeeClaimAt: Date.now(),
    trailingStopThreshold: null,
    highestValueUsd: null,
    lastRebalanceAt: 0,
    paperExitedAt: orNull(input.paperExitedAt),
    entrySignalTimestamp: orNull(input.signalTimestamp),
    entrySignalSnapshotId: orNull(input.signalSnapshotId),
    entryPriceUsd: pool.currentPrice,
    entryAmountXUsd: legs.xUsd,
    entryAmountYUsd: legs.yUsd,
    cumulativeFeesClaimedUsd: 0,
    cumulativeRewardsClaimedUsd: 0,
    closedAt: null,
    realizedPnlUsd: null,
    positionMode: orNull(decision.positionMode),
    tpLadderJson: orNull(decision.tpLadderJson),
    invalidationStopPrice: orNull(decision.invalidationStopPrice),
    launchRunner: runnerSeed.runner,
    launchRunnerSteps: runnerSeed.steps,
    launchRunnerAnchorPrice: runnerSeed.anchorPrice,
  };
}

/** Derived ladder halves (null = fall back to a single position). */
interface PaperLadderPlan {
  readonly halfSize: number;
  readonly tightHalf: number;
  readonly wideHalf: number;
}

/** Ladder range halves from operator widths (5-bin tight floor). */
interface LadderRangeHalves {
  readonly tightHalf: number;
  readonly wideHalf: number;
}
function ladderRangeHalves(
  halfWidth: number | undefined,
  tightMult: number | undefined,
  wideMult: number | undefined,
): LadderRangeHalves {
  return {
    tightHalf: Math.max(5, Math.round((halfWidth ?? 20) * (tightMult ?? 0.6))),
    wideHalf: Math.round((halfWidth ?? 20) * (wideMult ?? 1.6)),
  };
}

/** Ladder capacity: headroom for the tight+wide pair portfolio- and pool-wide. */
function ladderCapacityOk(deps: PaperExecDeps, poolCount: number): boolean {
  return (
    deps.trackedPositions.size + 2 <= (deps.maxOpenPositions ?? 3) &&
    poolCount + 2 <= (deps.maxPositionsPerPool ?? 2)
  );
}

/** Ladder eligibility + derived halves: tight harvests fees, wide survives chop. */
function paperLadderPlan(
  deps: PaperExecDeps,
  decision: AgentDecision,
  liveExited: PositionRecord | undefined,
): PaperLadderPlan | null {
  const sizeUsd = decision.positionSizeUsd ?? 0;
  const poolCount = positionsForPool(deps.trackedPositions, decision.poolAddress).length;
  if (!deps.ladderEnabled || liveExited || sizeUsd < 20 || !ladderCapacityOk(deps, poolCount)) {
    return null;
  }
  const halves = ladderRangeHalves(
    deps.entryRangeHalfWidth,
    deps.ladderTightMult,
    deps.ladderWideMult,
  );
  return { halfSize: sizeUsd / 2, tightHalf: halves.tightHalf, wideHalf: halves.wideHalf };
}

/** Persist one paper ladder leg (record + baseline + ENTER event). */
function savePaperLadderLeg(
  deps: PaperExecDeps,
  decision: AgentDecision,
  pool: PaperExecPool,
  entryStrategySpec: EntryStrategySpec,
  signalTimestamp: number | undefined,
  signalSnapshotId: number | undefined,
  lowerBinId: number,
  upperBinId: number,
  halfSize: number,
  label: "tight" | "wide",
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const pos = makePaperPositionRecord({
      decision,
      pool,
      positionId: `paper-${decision.poolAddress}-${randomUUID()}`,
      positionPubKey: null,
      depositedUsd: halfSize,
      fullSizeUsd: halfSize,
      activeBinId: pool.activeBinId,
      lowerBinId,
      upperBinId,
      entryStrategySpec,
      entryDipOffsetBins: deps.entryDipOffsetBins,
      signalTimestamp,
      signalSnapshotId,
    });
    deps.trackedPositions.set(pos.positionId, pos);
    yield* persist(`savePosition ${pos.positionId}`, deps.db.savePosition(pos));
    if (pos.positionMode !== "launch") {
      yield* persistMetadataIfSupported(
        deps.db,
        `yieldbase:${pos.positionId}`,
        JSON.stringify({ entryAprPct: deps.entryAprPct ?? 0, at: Date.now() }),
      );
    }
    yield* deps.db
      .savePositionEvent({
        id: randomUUID(),
        poolAddress: decision.poolAddress,
        positionPubKey: pos.positionPubKey,
        positionId: pos.positionId,
        event: "ENTER",
        valueUsd: halfSize,
        feesUsd: null,
        price: pool.currentPrice,
        metadata: {
          lowerBinId: pos.lowerBinId,
          upperBinId: pos.upperBinId,
          strategySpec: entryStrategySpec,
          ladder: label,
        },
        createdAt: Date.now(),
      })
      .pipe(Effect.catch(() => Effect.void));
  });
}

/** Paper ENTER: laddered tight+wide pair or a single position (paper/live parity range). */
function executePaperEnter(
  deps: PaperExecDeps,
  decision: AgentDecision,
  pool: PaperExecPool,
  entryStrategySpec: EntryStrategySpec,
  signalTimestamp: number | undefined,
  signalSnapshotId: number | undefined,
): Effect.Effect<{ executed: boolean; error: string | undefined }, never> {
  return Effect.gen(function* () {
    // Legacy parity: re-entering a pool whose live position was paper-exited
    // keeps the live identity so the rows merge instead of duplicating.
    const liveExited = positionsForPool(deps.trackedPositions, decision.poolAddress).find(
      (p) => p.paperExitedAt !== null && p.positionPubKey !== null,
    );
    // Laddering: tight+wide split (paper-first, OFF by default). Reuses existing
    // MAX_POSITIONS_PER_POOL capacity; tight harvests fees, wide survives chop.
    // Fail-closed: single position when capacity, size, or live-identity would break the invariant.
    const ladderPlan = paperLadderPlan(deps, decision, liveExited);
    if (ladderPlan) {
      const { halfSize } = ladderPlan;
      const tightRange = deps.strategy.recommendBinRange(
        pool.activeBinId,
        pool.binStep,
        ladderPlan.tightHalf,
        deps.entryDipOffsetBins,
      );
      const wideRange = deps.strategy.recommendBinRange(
        pool.activeBinId,
        pool.binStep,
        ladderPlan.wideHalf,
        deps.entryDipOffsetBins,
      );
      for (const [range, label] of [[tightRange, "tight"] as const, [wideRange, "wide"] as const]) {
        yield* savePaperLadderLeg(
          deps,
          decision,
          pool,
          entryStrategySpec,
          signalTimestamp,
          signalSnapshotId,
          range.lowerBinId,
          range.upperBinId,
          halfSize,
          label,
        );
      }
      return { executed: true, error: undefined };
    }
    // Paper/live parity: the simulated range comes from the same
    // recommendBinRange live entries use, so paper validates real behavior.
    const recommended = deps.strategy.recommendBinRange(
      pool.activeBinId,
      pool.binStep,
      deps.entryRangeHalfWidth,
      deps.entryDipOffsetBins,
    );
    const positionSizeUsd = decision.positionSizeUsd ?? 0;
    const pos = makePaperPositionRecord({
      decision,
      pool,
      positionId: liveExited
        ? liveExited.positionPubKey!
        : `paper-${decision.poolAddress}-${randomUUID()}`,
      positionPubKey: liveExited ? liveExited.positionPubKey : null,
      depositedUsd: positionSizeUsd,
      fullSizeUsd: positionSizeUsd,
      activeBinId: pool.activeBinId,
      lowerBinId: recommended.lowerBinId,
      upperBinId: recommended.upperBinId,
      entryStrategySpec,
      entryDipOffsetBins: deps.entryDipOffsetBins,
      signalTimestamp,
      signalSnapshotId,
      paperExitedAt: liveExited ? liveExited.paperExitedAt : null,
    });
    deps.trackedPositions.set(pos.positionId, pos);
    yield* persist(`savePosition ${pos.positionId}`, deps.db.savePosition(pos));
    if (pos.positionMode !== "launch") {
      yield* persistMetadataIfSupported(
        deps.db,
        `yieldbase:${pos.positionId}`,
        JSON.stringify({ entryAprPct: deps.entryAprPct ?? 0, at: Date.now() }),
      );
    }
    yield* deps.db
      .savePositionEvent({
        id: randomUUID(),
        poolAddress: decision.poolAddress,
        positionPubKey: pos.positionPubKey,
        positionId: pos.positionId,
        event: "ENTER",
        valueUsd: positionSizeUsd,
        feesUsd: null,
        price: pool.currentPrice,
        metadata: {
          lowerBinId: pos.lowerBinId,
          upperBinId: pos.upperBinId,
          strategySpec: entryStrategySpec,
        },
        createdAt: Date.now(),
      })
      .pipe(Effect.catch(() => Effect.void));
    return { executed: true, error: undefined };
  });
}

/** G2 rotation-arm re-check: a Rotation EXIT executes only while its arm is
 * fresh and the runner still qualifies — cancel-and-preserve otherwise. */
function checkRotationArm(
  deps: RotationArmDeps,
  decision: AgentDecision,
): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    const armRaw = yield* deps.db
      .getMetadata(`rotarm:${decision.poolAddress}`)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    let armValid = false;
    if (armRaw) {
      try {
        // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
        const arm = JSON.parse(armRaw) as { runner: string; at: number };
        const armFresh = Date.now() - arm.at < (deps.rotationArmMs ?? 1_800_000);
        const runnerApr = deps.poolAprByAddress?.get(arm.runner)?.feeAprPct ?? 0;
        armValid = armFresh && runnerApr >= (deps.runnerMinFeeApr ?? 500);
      } catch {
        armValid = false;
      }
    }
    yield* persistMetadataIfSupported(deps.db, `rotarm:${decision.poolAddress}`, "");
    if (!armValid) {
      console.warn(
        `[rotation-canceled] EXIT skipped on ${decision.poolAddress} — runner no longer qualifies; incumbent preserved`,
      );
    }
    return armValid;
  });
}

/** Paper EXIT: rotation-arm gate, live-position guard, ledger close + rug arm. */
function executePaperExit(
  deps: PaperExecDeps,
  decision: AgentDecision,
  pool: PaperExecPool,
): Effect.Effect<{ executed: boolean; error: string | undefined }, never> {
  return Effect.gen(function* () {
    const rotationBlocked = yield* isExitRotationBlocked(deps, decision);
    if (rotationBlocked) {
      return { executed: false, error: "rotation canceled — incumbent preserved" };
    }
    const pos = resolveTargetPosition(deps.trackedPositions, decision);
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
    if (pos) {
      const realizedPnlUsd = computeRealizedPnlUsd(
        pos.currentValueUsd,
        pos.cumulativeFeesClaimedUsd,
        pos.depositedUsd,
        pos.cumulativeRewardsClaimedUsd,
      );
      yield* deps.db
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
        .pipe(Effect.catch(() => Effect.void));
      yield* persist(
        `closePosition ${pos.positionId}`,
        deps.db.closePosition(pos.positionId, realizedPnlUsd),
      );
      // Rug detection: a paper position closed at a catastrophic loss arms
      // `token_rug_block` for its non-stable legs so the engine never
      // re-enters a drained token (mirrors the live executor's gate).
      const rugMints = rugBlockMints({
        realizedPnlUsd,
        depositedUsd: pos.depositedUsd,
        rugExitLossPct: deps.rugExitLossPct ?? 0.5,
        stablecoinMints: deps.stablecoinMints,
        tokenX: pool.tokenX,
        tokenY: pool.tokenY,
      });
      yield* persistPaperExitRugBlocks(
        deps.db,
        decision.poolAddress,
        rugMints,
        deps.rugTokenBlockMs,
      );
      if (pos.entrySignalSnapshotId != null) {
        yield* deps.db
          .recordSignalOutcome(pos.entrySignalSnapshotId, realizedPnlUsd)
          .pipe(Effect.catch(() => Effect.void));
      }
      yield* persist(`markPaperExited ${pos.positionId}`, deps.db.markPaperExited(pos.positionId));
      deps.trackedPositions.delete(pos.positionId);
    }
    return { executed: true, error: undefined };
  });
}

/** Paper REBALANCE: reshape the tracked row (runner scale-in grows the basis). */
function executePaperRebalance(
  deps: PaperExecDeps,
  decision: AgentDecision,
  pool: PaperExecPool,
): Effect.Effect<{ executed: boolean; error: string | undefined }, never> {
  const params = decision.rebalanceParams;
  if (!params) return Effect.succeed({ executed: true, error: undefined });
  return Effect.gen(function* () {
    const current = resolveTargetPosition(deps.trackedPositions, decision);
    if (current) {
      // Runner scale-in: the top-up is FRESH capital — grow the cost basis
      // and the mark in lockstep (same invariant the live executor applies)
      // and advance the band anchor + step count.
      const topUpUsd = params.topUpUsd ?? 0;
      const scaled = applyCompoundToCostBasis({
        depositedUsd: current.depositedUsd,
        currentValueUsd: current.currentValueUsd,
        highestValueUsd: current.highestValueUsd,
        compoundedFeesUsd: topUpUsd,
      });
      const updated: PositionRecord = {
        ...current,
        ...scaled,
        entryAmountXUsd:
          current.launchRunner === true
            ? (current.entryAmountXUsd ?? 0) + topUpUsd
            : current.entryAmountXUsd,
        lowerBinId: params.newLowerBinId,
        upperBinId: params.newUpperBinId,
        ...(current.launchRunner === true && params.topUp !== undefined
          ? {
              launchRunnerAnchorPrice: pool.currentPrice,
              launchRunnerSteps: (current.launchRunnerSteps ?? 0) + 1,
            }
          : undefined),
        lastRebalanceAt: Date.now(),
      };
      deps.trackedPositions.set(updated.positionId, updated);
      yield* persist(`savePosition ${updated.positionId}`, deps.db.savePosition(updated));
      yield* deps.db
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
            newLowerBinId: params.newLowerBinId,
            newUpperBinId: params.newUpperBinId,
            ...(params.topUp !== undefined ? { scaleIn: true, topUpUsd } : undefined),
          },
          createdAt: Date.now(),
        })
        .pipe(Effect.catch(() => Effect.void));
    }
    return { executed: true, error: undefined };
  });
}

export function executePaper(
  deps: {
    db: DbApi;
    trackedPositions: Map<string, PositionRecord>;
    strategy: StrategyApi;
    entryStrategySpec: EntryStrategySpec;
    entryRangeHalfWidth?: number;
    /** Laddering: tight+wide split (OFF by default, paper-first). */
    ladderEnabled?: boolean;
    ladderTightMult?: number;
    ladderWideMult?: number;
    maxOpenPositions?: number;
    maxPositionsPerPool?: number;
    entryDipOffsetBins?: number;
    /** G2 rotation-arm + yield-baseline wiring (market-runner lane). */
    rotationArmMs?: number;
    runnerMinFeeApr?: number;
    entryAprPct?: number;
    poolAprByAddress?: ReadonlyMap<string, { feeAprPct: number; tvlUsd: number }>;
    /** G4 economic harvest gate values (executors have no AppConfig). */
    harvestMinNetUsd?: number;
    harvestMaxCostPct?: number;
    harvestTxCostUsdEst?: number;
    /** Rug detection: arm `token_rug_block` on a catastrophic realized loss. */
    rugExitLossPct?: number;
    rugTokenBlockMs?: number;
    stablecoinMints?: ReadonlySet<string>;
  },
  decision: AgentDecision,
  pool: {
    activeBinId: number;
    binStep: number;
    tokenXSymbol: string;
    tokenYSymbol: string;
    tokenX?: string;
    tokenY?: string;
    currentPrice: number;
  },
  signalTimestamp?: number,
  signalSnapshotId?: number,
): Effect.Effect<{ executed: boolean; error: string | undefined }, never> {
  return Effect.gen(function* () {
    if (decision.action === "ENTER" && decision.positionSizeUsd) {
      return yield* executePaperEnter(
        deps,
        decision,
        pool,
        deps.entryStrategySpec,
        signalTimestamp,
        signalSnapshotId,
      );
    }
    if (decision.action === "EXIT") {
      return yield* executePaperExit(deps, decision, pool);
    }
    if (decision.action === "REBALANCE" && decision.rebalanceParams) {
      return yield* executePaperRebalance(deps, decision, pool);
    }
    return { executed: true, error: undefined };
  });
}

// ─── Live execution ──────────────────────────────────────────────────────────

interface AutonomousExecutionContext {
  readonly mode: Exclude<AutonomousTokenMode, "off">;
  readonly walletAddress: string;
  readonly agentInstanceId: string;
  readonly settlementMaxPendingMs: number;
  readonly settlementDustUsd: number;
}

function operationRecord(input: {
  readonly context: AutonomousExecutionContext;
  readonly id: string;
  readonly candidateId: string | null;
  readonly positionId: string | null;
  readonly poolAddress: string;
  readonly tokenMint: string;
  readonly operationType: ExecutionOperationRecord["operationType"];
  readonly status: ExecutionOperationRecord["status"];
  readonly amountAtomic: string | null;
  readonly txSignature: string | null;
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}): ExecutionOperationRecord {
  return {
    id: input.id,
    walletAddress: input.context.walletAddress,
    agentInstanceId: input.context.agentInstanceId,
    candidateId: input.candidateId,
    positionId: input.positionId,
    poolAddress: input.poolAddress,
    tokenMint: input.tokenMint,
    operationType: input.operationType,
    status: input.status,
    amountAtomic: input.amountAtomic,
    txSignature: input.txSignature,
    error: input.error,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

function settlementJobsForReceipts(input: {
  readonly context: AutonomousExecutionContext;
  readonly positionId: string;
  readonly poolAddress: string;
  readonly receipts: EntryPreparationOutcome["receipts"];
  readonly now: number;
}): ReadonlyArray<SettlementJobRecord> {
  return input.receipts.map((receipt) => ({
    id: randomUUID(),
    walletAddress: input.context.walletAddress,
    agentInstanceId: input.context.agentInstanceId,
    positionId: input.positionId,
    poolAddress: input.poolAddress,
    tokenMint: receipt.outputMint,
    amountAtomic: receipt.acquiredAmountAtomic.toString(),
    destinationAsset: "SOL",
    status: "pending",
    attempts: 0,
    nextRetryAt: input.now,
    txSignature: null,
    confirmedOutputAtomic: null,
    outputUsd: null,
    executionCostUsd: null,
    finalizedAt: null,
    realizedPnlUsd: null,
    expiresAt: input.now + input.context.settlementMaxPendingMs,
    error: null,
    createdAt: input.now,
    updatedAt: input.now,
  }));
}

/**
 * Execute a live decision. `entryPrep` is only used for ENTER actions; callers
 * must still provide it because the function signature does not conditionally
 * expose the dependency.
 */
/** Live-execution dependency and pool shapes (mirrors executeLive's contract). */
type LiveExecDeps = Parameters<typeof executeLive>[0];
type LiveExecPool = Parameters<typeof executeLive>[2];

/** Minimal rotation-arm dependency surface (shared by the paper + live EXIT paths). */
interface RotationArmDeps {
  readonly db: LiveExecDeps["db"];
  readonly rotationArmMs?: number | undefined;
  readonly poolAprByAddress?: ReadonlyMap<string, { feeAprPct: number }> | undefined;
  readonly runnerMinFeeApr?: number | undefined;
}

/** Live EXIT result data (adapter withdrawal + sweep accounting). */
type LiveExitResultData = Effect.Success<ReturnType<AdapterApi["exitPosition"]>>;

/**
 * Rug detection: a live position closed at a catastrophic realized loss arms
 * `token_rug_block` for its non-stable legs. A metadata write failure fails
 * open (warn) — it must never block the close or the cycle.
 */
function armLiveRugBlocks(input: {
  readonly db: LiveExecDeps["db"];
  readonly poolAddress: string;
  readonly realizedPnlUsd: number | null;
  readonly depositedUsd: number;
  readonly rugExitLossPct?: number | undefined;
  readonly rugTokenBlockMs?: number | undefined;
  readonly stablecoinMints?: ReadonlySet<string> | undefined;
  readonly tokenX?: string | undefined;
  readonly tokenY?: string | undefined;
}): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const mints = rugBlockMints({
      realizedPnlUsd: input.realizedPnlUsd,
      depositedUsd: input.depositedUsd,
      rugExitLossPct: input.rugExitLossPct ?? 0.5,
      stablecoinMints: input.stablecoinMints,
      tokenX: input.tokenX,
      tokenY: input.tokenY,
    });
    if (mints.length === 0) return;
    const expiresAt = Date.now() + (input.rugTokenBlockMs ?? 604_800_000);
    for (const mint of mints) {
      yield* input.db.setMetadata(`token_rug_block:${mint}`, String(expiresAt)).pipe(
        Effect.catch((err) =>
          Effect.sync(() =>
            logger.warn("Failed to record rug-token block", {
              pool: input.poolAddress,
              mint,
              error: String(err),
            }),
          ),
        ),
      );
    }
  });
}

/** Planned entry-operation ledger row (autonomous mode only). Null = skipped. */
function planLiveEntryOperation(
  deps: LiveExecDeps,
  decision: AgentDecision,
  poolTokenX: string | undefined,
): Effect.Effect<
  { readonly operation: ExecutionOperationRecord | null; readonly fatalError: string | null },
  never
> {
  const autonomous = deps.autonomous;
  if (!(decision.action === "ENTER" && decision.positionSizeUsd && autonomous && poolTokenX)) {
    return Effect.succeed({ operation: null, fatalError: null });
  }
  return Effect.gen(function* () {
    const now = Date.now();
    const operation = operationRecord({
      context: autonomous,
      id: randomUUID(),
      candidateId: null,
      positionId: null,
      poolAddress: decision.poolAddress,
      tokenMint: poolTokenX,
      operationType: "entry",
      status: "planned",
      amountAtomic: null,
      txSignature: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });
    const persisted = yield* deps.db.saveExecutionOperation(operation).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
    if (!persisted) {
      return {
        operation: null,
        fatalError: "Unable to persist entry operation before execution",
      };
    }
    return { operation, fatalError: null };
  });
}

/** Live SOL gate: deficit-sized top-up swap, balance read, entry minimum.
 * A planned entry operation is failed-closed here so the ledger never keeps
 * a dangling 'planned' row. */
/**
 * Align the automatic top-up with the live-entry SOL reserve, sized to the
 * ACTUAL DEFICIT (plus a slippage/fee buffer), not the full reserve. When the
 * balance read fails (null), skip the top-up entirely.
 */
function topUpSolReserve(
  adapter: AdapterApi,
  entryReserveSol: number,
  solPriceUsd: number,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const preSwapSol = yield* adapter.getNativeSolBalance().pipe(
      Effect.map((lamports) => Number(lamports) / 1e9),
      Effect.catch(() => Effect.succeed(null)),
    );
    if (preSwapSol === null || preSwapSol >= entryReserveSol) return;
    const deficitSol = entryReserveSol - preSwapSol;
    // Prefer a live SOL price from the adapter's price chain over the static
    // config fallback; a failed lookup falls back to the config value.
    const liveSolPrice = yield* adapter.getTokenPrices([SOL_MINT], { useFallback: false }).pipe(
      Effect.map((prices) => prices[SOL_MINT]),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    const effectiveSolPrice = liveSolPrice != null && liveSolPrice > 0 ? liveSolPrice : solPriceUsd;
    const topUpUsdc =
      effectiveSolPrice > 0
        ? Math.max(GAS_TOP_UP_USDC, Math.ceil(deficitSol * effectiveSolPrice * 1.2))
        : GAS_TOP_UP_USDC;
    yield* adapter.swapUSDCForSOL(entryReserveSol, topUpUsdc).pipe(Effect.catch(() => Effect.void));
  });
}

/** Abandon a planned entry operation (failed) so the ledger keeps no dangling row. */
function failPlannedEntryOp(
  db: DbApi,
  operation: ExecutionOperationRecord,
  error: string,
): Effect.Effect<void, never> {
  return db
    .saveExecutionOperation({
      ...operation,
      status: "failed",
      error,
      updatedAt: Date.now(),
    })
    .pipe(Effect.catch(() => Effect.void));
}

function checkLiveEntrySolGate(
  deps: LiveExecDeps,
  decision: AgentDecision,
  solPriceUsd: number,
  entryOperation: ExecutionOperationRecord | null,
): Effect.Effect<{ readonly fatalError: string | null }, never> {
  const autonomous = deps.autonomous;
  return Effect.gen(function* () {
    // Align the automatic top-up with the live-entry SOL reserve, but size the
    // swap to the ACTUAL DEFICIT (plus a slippage/fee buffer), not the full
    // reserve. When the balance read fails (null), skip the top-up entirely.
    const entryReserveSol = Number(SOL_GAS_TOP_UP_THRESHOLD_LAMPORTS) / 1e9;
    yield* topUpSolReserve(deps.adapter, entryReserveSol, solPriceUsd);
    const nativeBalance = yield* deps.adapter.getNativeSolBalance().pipe(
      // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
      Effect.map((lamports) => ({ value: lamports, error: undefined as string | undefined })),
      Effect.catch((err) =>
        Effect.succeed({
          value: null,
          error: `Unable to read native SOL balance: ${err instanceof Error ? err.message : String(err)}`,
        }),
      ),
    );
    // A planned entry operation is abandoned here — the ENTER is rejected by
    // the SOL gate before any on-chain action. Close it out (failed) so the
    // execution_operations ledger does not retain a dangling 'planned' row.
    if (nativeBalance.value === null) {
      const error = nativeBalance.error ?? "Unable to read native SOL balance";
      if (autonomous && entryOperation) {
        yield* failPlannedEntryOp(deps.db, entryOperation, error);
      }
      return { fatalError: error };
    }
    const solBalance = nativeBalance.value;
    if (solBalance < MIN_SOL_FOR_ENTRY_LAMPORTS) {
      const availableLamports = Number(solBalance);
      const neededLamports = Number(MIN_SOL_FOR_ENTRY_LAMPORTS);
      const reserve = neededLamports - Number(MIN_SOL_FOR_GAS_LAMPORTS);
      const availableHuman = (availableLamports / 1e9).toFixed(4);
      const neededHuman = (neededLamports / 1e9).toFixed(4);
      const reserveHuman = (reserve / 1e9).toFixed(4);
      console.warn(
        `Insufficient SOL for ENTER — available ${availableHuman} SOL, need ${neededHuman} SOL ` +
          `(gas ${(Number(MIN_SOL_FOR_GAS_LAMPORTS) / 1e9).toFixed(4)} + rent/fee reserve ${reserveHuman})`,
      );
      const error =
        `Insufficient SOL for ENTER — available: ${availableHuman} SOL, ` +
        `needed: ${neededHuman} SOL, ` +
        `reserve: ${reserveHuman} SOL`;
      if (autonomous && entryOperation) {
        yield* failPlannedEntryOp(deps.db, entryOperation, error);
      }
      return { fatalError: error };
    }
    return { fatalError: null };
  });
}

/** Persist rollback settlement jobs + the rollback operation row. Returns persistence ok. */
function persistRollbackSettlements(
  deps: LiveExecDeps,
  decision: AgentDecision,
  autonomous: AutonomousExecutionContext,
  entryOperation: ExecutionOperationRecord,
  rollbackPositionId: string,
  receipts: EntryPreparationOutcome["receipts"],
  opStatus: "retryable" | "failed",
  opError: string,
  now: number,
): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    let settlementPersisted = true;
    for (const job of settlementJobsForReceipts({
      context: autonomous,
      positionId: rollbackPositionId,
      poolAddress: decision.poolAddress,
      receipts,
      now,
    })) {
      yield* deps.db.saveSettlementJob(job).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            settlementPersisted = false;
          }),
        ),
      );
      if (!settlementPersisted) {
        deps.reconcileRequestedPools?.add(decision.poolAddress);
        yield* deps.db
          .saveSafetyPause({
            walletAddress: autonomous.walletAddress,
            agentInstanceId: autonomous.agentInstanceId,
            reason: "settlement_persistence_failed",
            triggeredAt: now,
            resolvedAt: null,
          })
          .pipe(Effect.catch(() => Effect.void));
        break;
      }
    }
    if (settlementPersisted) {
      yield* deps.db
        .saveExecutionOperation({
          ...entryOperation,
          operationType: "rollback",
          status: opStatus,
          error: opError,
          updatedAt: now,
        })
        .pipe(
          Effect.catch(() =>
            Effect.sync(() => {
              settlementPersisted = false;
            }),
          ),
        );
    }
    if (!settlementPersisted) {
      deps.reconcileRequestedPools?.add(decision.poolAddress);
      yield* deps.db
        .saveSafetyPause({
          walletAddress: autonomous.walletAddress,
          agentInstanceId: autonomous.agentInstanceId,
          reason: "settlement_persistence_failed",
          triggeredAt: now,
          resolvedAt: null,
        })
        .pipe(Effect.catch(() => Effect.void));
    }
    return settlementPersisted;
  });
}

/** Fund the ENTER legs via entry-prep; failed funding persists rollback settlements.
 * A failed prep never reaches the chain — the ENTER is rejected deterministically. */
function prepareLiveEntryTokens(
  deps: LiveExecDeps,
  decision: AgentDecision,
  runnerSingleSidedX: boolean | undefined,
  entryOperation: ExecutionOperationRecord | null,
): Effect.Effect<
  {
    readonly preparation: EntryPreparationOutcome | null;
    readonly fatalError: string | null;
  },
  never
> {
  const autonomous = deps.autonomous;
  return Effect.gen(function* () {
    const prepSizeUsd = decision.positionSizeUsd ?? 0;
    const prepResult = yield* deps.entryPrep
      .prepareEntryTokens(
        decision.poolAddress,
        prepSizeUsd,
        runnerSingleSidedX === true ? { xOnly: true } : undefined,
      )
      .pipe(
        Effect.matchEffect({
          onSuccess: (outcome) =>
            Effect.succeed({
              outcome: outcome ?? null,
              partial: null,
              // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
              error: undefined as string | undefined,
            }),
          onFailure: (err) => {
            const partial = err instanceof EntryPrepError ? (err.partialPreparation ?? null) : null;
            return Effect.succeed({
              outcome: null,
              partial,
              error: `Entry token preparation failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          },
        }),
      );
    if (prepResult.error) {
      if (autonomous && entryOperation) {
        const now = Date.now();
        yield* persistRollbackSettlements(
          deps,
          decision,
          autonomous,
          entryOperation,
          `rollback:${entryOperation.id}`,
          prepResult.partial?.receipts ?? [],
          prepResult.partial ? "retryable" : "failed",
          prepResult.error,
          now,
        );
      }
      console.warn(prepResult.error, { pool: decision.poolAddress });
      return { preparation: null, fatalError: prepResult.error };
    }
    if (entryOperation) {
      const preparedOperation = {
        ...entryOperation,
        status: "prepared" as const,
        updatedAt: Date.now(),
      };
      yield* deps.db
        .saveExecutionOperation(preparedOperation)
        .pipe(Effect.catch(() => Effect.void));
    }
    return { preparation: prepResult.outcome, fatalError: null };
  });
}

/** Owner contract for the live ENTER position record. */
interface LivePositionInput {
  readonly decision: AgentDecision;
  readonly pool: LiveExecPool;
  readonly positionPubKey: string;
  readonly depositedUsd: number;
  readonly amountXUsd: number;
  readonly amountYUsd: number;
  readonly lowerBinId: number;
  readonly upperBinId: number;
  readonly entryDipOffsetBins?: number | undefined;
  readonly signalTimestamp?: number | undefined;
  readonly signalSnapshotId?: number | undefined;
}

/** Build the live ENTER PositionRecord from the adapter's executed deposit. */
function makeLivePositionRecord(input: LivePositionInput): PositionRecord {
  const { decision, pool } = input;
  const dipEntry = (input.entryDipOffsetBins ?? 0) !== 0;
  return {
    positionId: input.positionPubKey,
    poolAddress: decision.poolAddress,
    positionPubKey: input.positionPubKey,
    depositedUsd: input.depositedUsd,
    currentValueUsd: input.depositedUsd,
    tokenXSymbol: pool.tokenXSymbol,
    tokenYSymbol: pool.tokenYSymbol,
    activeBinId: pool.activeBinId,
    lowerBinId: input.lowerBinId,
    upperBinId: input.upperBinId,
    timestamp: Date.now(),
    outOfRangeSince: null,
    oorCycleCount: 0,
    lastFeeClaimAt: Date.now(),
    trailingStopThreshold: null,
    highestValueUsd: null,
    lastRebalanceAt: 0,
    paperExitedAt: null,
    entrySignalTimestamp: input.signalTimestamp ?? null,
    entrySignalSnapshotId: input.signalSnapshotId ?? null,
    entryPriceUsd: pool.currentPrice,
    entryAmountXUsd: input.amountXUsd,
    entryAmountYUsd: input.amountYUsd,
    cumulativeFeesClaimedUsd: 0,
    cumulativeRewardsClaimedUsd: 0,
    closedAt: null,
    realizedPnlUsd: null,
    positionMode: decision.positionMode ?? null,
    tpLadderJson: decision.tpLadderJson ?? null,
    invalidationStopPrice: decision.invalidationStopPrice ?? null,
    launchRunner: dipEntry ? true : null,
    launchRunnerSteps: dipEntry ? 0 : null,
    launchRunnerAnchorPrice: dipEntry ? pool.currentPrice : null,
  };
}

/**
 * Adapter ENTER attempt with success/error settlement (never throws: the
 * caller branches on result nullability).
 */
function enterPositionAttempt(
  adapter: AdapterApi,
  poolAddress: string,
  lowerBinId: number,
  upperBinId: number,
  positionSizeUsd: number,
  entryStrategySpec: EntryStrategySpec,
  runnerSingleSidedX: boolean | undefined,
) {
  return adapter
    .enterPosition(poolAddress, lowerBinId, upperBinId, positionSizeUsd, {
      strategySpec: entryStrategySpec,
      ...(runnerSingleSidedX === true ? { forceSingleSidedX: true } : undefined),
    })
    .pipe(
      Effect.tap((r) =>
        Effect.sync(() =>
          console.info("Live position entered", {
            pool: poolAddress,
            position: r.positionPubKey,
            tx: r.txSignature,
          }),
        ),
      ),
      // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
      Effect.map((r) => ({ result: r, error: undefined as string | undefined })),
      Effect.catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Live ENTER failed", {
          pool: poolAddress,
          err: msg,
        });
        return Effect.succeed({ result: null, error: msg });
      }),
    );
}

/** G7 yield-regression baseline for non-launch positions (launch has its own lifecycle). */
function recordYieldBaseline(
  db: DbApi,
  pos: PositionRecord,
  entryAprPct: number | undefined,
): Effect.Effect<void, never> {
  if (pos.positionMode === "launch") return Effect.void;
  return persistMetadataIfSupported(
    db,
    `yieldbase:${pos.positionId}`,
    JSON.stringify({ entryAprPct: entryAprPct ?? 0, at: Date.now() }),
  );
}

/** Confirm the planned entry operation on success (autonomous ledger continuity). */
function confirmEnterOperation(
  db: DbApi,
  entryOperation: ExecutionOperationRecord | null,
  positionId: string,
  txSignature: string,
): Effect.Effect<void, never> {
  if (!entryOperation) return Effect.void;
  return db
    .saveExecutionOperation({
      ...entryOperation,
      positionId,
      status: "confirmed",
      txSignature,
      updatedAt: Date.now(),
    })
    .pipe(Effect.catch(() => Effect.void));
}

/** Roll back a failed ENTER (autonomous mode with funding receipts only). */
function rollbackFailedEnter(
  deps: LiveExecDeps,
  decision: AgentDecision,
  autonomous: AutonomousExecutionContext | null | undefined,
  entryOperation: ExecutionOperationRecord | null,
  preparation: EntryPreparationOutcome | null,
  error: string | undefined,
): Effect.Effect<void, never> {
  if (!autonomous || !entryOperation || !preparation) return Effect.void;
  return persistRollbackSettlements(
    deps,
    decision,
    autonomous,
    entryOperation,
    `rollback:${entryOperation.id}`,
    preparation.receipts,
    "retryable",
    error ?? "Position entry failed after funding swaps",
    Date.now(),
  ).pipe(Effect.map(() => undefined));
}

/** Execute the live ENTER: range, deposit, ledger row, failure rollback. */
function executeLiveEnterPosition(
  deps: LiveExecDeps,
  decision: AgentDecision,
  pool: LiveExecPool,
  entryStrategySpec: EntryStrategySpec,
  entryRangeHalfWidth: number | undefined,
  entryDipOffsetBins: number | undefined,
  runnerSingleSidedX: boolean | undefined,
  signalTimestamp: number | undefined,
  signalSnapshotId: number | undefined,
  preparation: EntryPreparationOutcome | null,
  entryOperation: ExecutionOperationRecord | null,
): Effect.Effect<{ executed: boolean; error: string | undefined }, never> {
  const autonomous = deps.autonomous;
  return Effect.gen(function* () {
    const positionSizeUsd = decision.positionSizeUsd ?? 0;
    const recommended = deps.strategy.recommendBinRange(
      pool.activeBinId,
      pool.binStep,
      entryRangeHalfWidth,
      entryDipOffsetBins,
    );
    const enterResult = yield* enterPositionAttempt(
      deps.adapter,
      decision.poolAddress,
      recommended.lowerBinId,
      recommended.upperBinId,
      positionSizeUsd,
      entryStrategySpec,
      runnerSingleSidedX,
    );
    if (!enterResult.result) {
      yield* rollbackFailedEnter(
        deps,
        decision,
        autonomous,
        entryOperation,
        preparation,
        enterResult.error,
      );
      return { executed: false, error: enterResult.error };
    }
    const pos = makeLivePositionRecord({
      decision,
      pool,
      positionPubKey: enterResult.result.positionPubKey,
      depositedUsd: positionSizeUsd,
      amountXUsd: enterResult.result.amountXUsd,
      amountYUsd: enterResult.result.amountYUsd,
      lowerBinId: recommended.lowerBinId,
      upperBinId: recommended.upperBinId,
      entryDipOffsetBins,
      signalTimestamp,
      signalSnapshotId,
    });
    deps.trackedPositions.set(pos.positionId, pos);
    yield* persist(`savePosition ${pos.positionId}`, deps.db.savePosition(pos));
    // G7 yield-regression baseline: the entry-time fee APR, recorded for
    // non-launch positions (launch has its own lifecycle).
    yield* recordYieldBaseline(deps.db, pos, deps.entryAprPct);
    yield* deps.db
      .savePositionEvent({
        id: randomUUID(),
        poolAddress: decision.poolAddress,
        positionPubKey: pos.positionPubKey,
        positionId: pos.positionId,
        event: "ENTER",
        valueUsd: positionSizeUsd,
        feesUsd: null,
        price: pool.currentPrice,
        metadata: {
          lowerBinId: pos.lowerBinId,
          upperBinId: pos.upperBinId,
          txSignature: enterResult.result.txSignature,
          depositMode: enterResult.result.depositMode,
          strategySpec: entryStrategySpec,
        },
        createdAt: Date.now(),
      })
      .pipe(Effect.catch(() => Effect.void));
    yield* confirmEnterOperation(
      deps.db,
      entryOperation,
      pos.positionId,
      enterResult.result.txSignature,
    );
    return { executed: true, error: undefined };
  });
}

/** Planned exit-operation ledger row (autonomous mode only). */
function planLiveExitOperation(
  deps: LiveExecDeps,
  decision: AgentDecision,
  pool: LiveExecPool,
  pos: PositionRecord | undefined,
): Effect.Effect<
  {
    readonly exitOperation: ExecutionOperationRecord | null;
    readonly fatalError: string | null;
  },
  never
> {
  const autonomous = deps.autonomous;
  if (!autonomous || !pos || !pool.tokenX) {
    return Effect.succeed({ exitOperation: null, fatalError: null });
  }
  const tokenX = pool.tokenX;
  return Effect.gen(function* () {
    const now = Date.now();
    const exitOperation = operationRecord({
      context: autonomous,
      id: randomUUID(),
      candidateId: deps.candidateId ?? null,
      positionId: pos.positionId,
      poolAddress: decision.poolAddress,
      tokenMint: tokenX,
      operationType: "exit",
      status: "planned",
      amountAtomic: null,
      txSignature: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });
    const persisted = yield* deps.db.saveExecutionOperation(exitOperation).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
    if (!persisted) {
      return {
        exitOperation: null,
        fatalError: "Unable to persist exit operation before execution",
      };
    }
    return { exitOperation, fatalError: null };
  });
}

/** Run the on-chain EXIT + confirm/fail bookkeeping for a live position row. */
function runLiveExitPosition(
  deps: LiveExecDeps,
  decision: AgentDecision,
  pos: PositionRecord,
  positionPubKey: string,
  exitOperation: ExecutionOperationRecord | null,
): Effect.Effect<
  {
    readonly exited: boolean;
    readonly exitError: string | undefined;
    readonly exitResultData: LiveExitResultData | null;
  },
  never
> {
  return Effect.gen(function* () {
    const exitResult = yield* deps.adapter.exitPosition(decision.poolAddress, positionPubKey).pipe(
      Effect.tap(() =>
        Effect.sync(() =>
          console.info("Live position exited", {
            pool: decision.poolAddress,
            position: pos.positionPubKey,
          }),
        ),
      ),
      // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
      Effect.map((r) => ({ result: r, error: undefined as string | undefined })),
      Effect.catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Live EXIT failed", {
          pool: decision.poolAddress,
          err: msg,
        });
        return Effect.succeed({ result: null, error: msg });
      }),
    );
    const exited = exitResult.result !== null;
    const exitError = exitResult.error;
    const exitResultData = exitResult.result;
    if (exitOperation && exitResult.result) {
      const confirmedOperation = {
        ...exitOperation,
        status: "confirmed" as const,
        txSignature: exitResult.result.txSignature,
        updatedAt: Date.now(),
      };
      yield* deps.db
        .saveExecutionOperation(confirmedOperation)
        .pipe(Effect.catch(() => Effect.void));
    }
    if (!exited) {
      if (exitOperation) {
        yield* deps.db
          .saveExecutionOperation({
            ...exitOperation,
            status: "failed",
            error: exitError ?? "Live EXIT failed",
            updatedAt: Date.now(),
          })
          .pipe(Effect.catch(() => Effect.void));
      }
      // A failed close may have left the position half-closed on-chain
      // (the $27 phantom-row candidate: wallet holds withdrawn funds while
      // the row still counts in Σpositions). Flag the pool so the next
      // cycle's reconcile re-reads the wallet's real positions and drops
      // the row if it is gone — mirroring the atomic-rebalance failure path.
      deps.reconcileRequestedPools?.add(decision.poolAddress);
    }
    return { exited, exitError, exitResultData };
  });
}

/** Settlement-attributable EXIT: persist sale settlements, book the sweep CLAIMs,
 * realize withdrawal-based PnL, tombstone empty reaps, arm rug blocks, EXIT event. */
/** Tombstone a reaped-empty pubkey so reconcile never re-discovers the ghost
 * account. Bounded so a later legit refill is eventually re-admitted. */
function tombstoneReapedEmpty(
  db: LiveExecDeps["db"],
  positionPubKey: string | null,
  isEmptyReap: boolean | undefined,
): Effect.Effect<void, never> {
  if (isEmptyReap !== true || positionPubKey == null) return Effect.void;
  return persist(
    `tombstone empty ${positionPubKey}`,
    db.setMetadata(
      `reaped_empty:${positionPubKey}`,
      String(Date.now() + EMPTY_REAP_REDISCOVERY_COOLDOWN_MS),
    ),
  );
}

/** Warn + memory-flag an EXIT that closed without USD pricing. */
function warnUnpricedExit(
  deps: LiveExecDeps,
  decision: AgentDecision,
  pos: PositionRecord,
): Effect.Effect<void, never> {
  deps.unpricedExitWarnedPools?.add(decision.poolAddress);
  logger.warn(
    "EXIT closed without USD pricing (price feeds unresolved) — realized PnL recorded as n/a; raw amounts in event metadata",
    { pool: decision.poolAddress, position: pos.positionId },
  );
  return deps.memory
    ? deps.memory
        .upsert({
          category: "warning",
          content: `EXIT on ${decision.poolAddress} closed without USD pricing (price feeds unresolved) — realized PnL recorded as n/a; raw amounts in event metadata`,
          poolAddress: decision.poolAddress,
        })
        .pipe(Effect.catch(() => Effect.void))
    : Effect.void;
}

/** Positive exit attributions: withdrawn legs + known-mint rewards above zero. */
function positiveAttributions(exitResultData: LiveExitResultData, tokenX: string, tokenY: string) {
  return [
    { mint: tokenX, amountAtomic: exitResultData.withdrawnXAtomic ?? "0" },
    { mint: tokenY, amountAtomic: exitResultData.withdrawnYAtomic ?? "0" },
    ...(exitResultData.sweptRewards ?? [])
      .filter((reward) => reward.mint !== "unknown")
      .map((reward) => ({ mint: reward.mint, amountAtomic: String(reward.amountAtomic) })),
  ].filter(({ amountAtomic }) => {
    try {
      return BigInt(amountAtomic) > 0n;
    } catch {
      return false;
    }
  });
}

/** Persist one exit settlement job (true when stored). */
function persistExitSettlement(
  deps: LiveExecDeps,
  autonomous: AutonomousExecutionContext,
  decision: AgentDecision,
  pos: PositionRecord,
  item: { readonly mint: string; readonly amountAtomic: string },
  now: number,
): Effect.Effect<boolean, never> {
  const job: SettlementJobRecord = {
    id: randomUUID(),
    walletAddress: autonomous.walletAddress,
    agentInstanceId: autonomous.agentInstanceId,
    positionId: pos.positionId,
    poolAddress: decision.poolAddress,
    tokenMint: item.mint,
    amountAtomic: String(item.amountAtomic),
    destinationAsset: "SOL",
    status: "pending",
    attempts: 0,
    nextRetryAt: now,
    txSignature: null,
    confirmedOutputAtomic: null,
    outputUsd: null,
    executionCostUsd: null,
    finalizedAt: null,
    realizedPnlUsd: null,
    expiresAt: now + autonomous.settlementMaxPendingMs,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  return deps.db.saveSettlementJob(job).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );
}

/** Flag a settlement-persistence failure for reconcile (never blocks the exit). */
function flagSettlementPersistenceFailure(
  deps: LiveExecDeps,
  autonomous: AutonomousExecutionContext,
  decision: AgentDecision,
  now: number,
): Effect.Effect<void, never> {
  deps.reconcileRequestedPools?.add(decision.poolAddress);
  return deps.db
    .saveSafetyPause({
      walletAddress: autonomous.walletAddress,
      agentInstanceId: autonomous.agentInstanceId,
      reason: "settlement_persistence_failed",
      triggeredAt: now,
      resolvedAt: null,
    })
    .pipe(Effect.catch(() => Effect.void));
}

/**
 * Exit-sweep CLAIM events: pending-fee sweep and swept-reward rollup
 * (best-effort rows, delivery failures swallowed).
 */
function recordExitSweepEvents(
  deps: LiveExecDeps,
  decision: AgentDecision,
  pool: LiveExecPool,
  pos: PositionRecord,
  exitResultData: LiveExitResultData,
  now: number,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const pendingFeeUsd = exitResultData.pendingFeeUsd;
    if (pendingFeeUsd != null) {
      yield* deps.db
        .savePositionEvent({
          id: randomUUID(),
          poolAddress: decision.poolAddress,
          positionPubKey: pos.positionPubKey,
          positionId: pos.positionId,
          event: "CLAIM",
          valueUsd: null,
          feesUsd: pendingFeeUsd,
          price: pool.currentPrice,
          metadata: { kind: "exit_sweep" },
          createdAt: now,
        })
        .pipe(Effect.catch(() => Effect.void));
    }
    if ((exitResultData.sweptRewards ?? []).length > 0) {
      yield* deps.db
        .savePositionEvent({
          id: randomUUID(),
          poolAddress: decision.poolAddress,
          positionPubKey: pos.positionPubKey,
          positionId: pos.positionId,
          event: "CLAIM",
          valueUsd:
            (exitResultData.sweptRewards ?? []).reduce(
              (sum, reward) => sum + (reward.amountUsd ?? 0),
              0,
            ) || null,
          feesUsd: null,
          price: pool.currentPrice,
          metadata: { kind: "exit_sweep_reward" },
          createdAt: now,
        })
        .pipe(Effect.catch(() => Effect.void));
    }
  });
}

function settleLiveExitAttribution(
  deps: LiveExecDeps,
  decision: AgentDecision,
  pool: LiveExecPool,
  pos: PositionRecord,
  exitResultData: LiveExitResultData,
  tokenX: string,
  tokenY: string,
  autonomous: AutonomousExecutionContext,
): Effect.Effect<{ readonly fatal: string | null }, never> {
  return Effect.gen(function* () {
    const now = Date.now();
    const attributable = positiveAttributions(exitResultData, tokenX, tokenY);
    let settlementPersisted = true;
    for (const item of attributable) {
      settlementPersisted = yield* persistExitSettlement(
        deps,
        autonomous,
        decision,
        pos,
        item,
        now,
      );
      if (!settlementPersisted) {
        yield* flagSettlementPersistenceFailure(deps, autonomous, decision, now);
        break;
      }
    }
    if (!settlementPersisted) {
      return {
        fatal: "Unable to persist all exit settlement jobs; reconciliation required",
      };
    }
    yield* recordExitSweepEvents(deps, decision, pool, pos, exitResultData, now);
    const withdrawnUsd = exitResultData.withdrawnUsd ?? null;
    const pricingUnresolved = withdrawnUsd === null;
    const realizedPnlUsd = exitResultData.isEmptyReap
      ? 0
      : pricingUnresolved || attributable.length > 0
        ? null
        : computeRealizedPnlUsd(
            withdrawnUsd,
            pos.cumulativeFeesClaimedUsd,
            pos.depositedUsd,
            pos.cumulativeRewardsClaimedUsd,
          );
    yield* persist(`savePosition ${pos.positionId}`, deps.db.savePosition(pos));
    yield* persist(
      `closePosition ${pos.positionId}`,
      deps.db.closePosition(pos.positionId, realizedPnlUsd),
    );
    yield* tombstoneReapedEmpty(deps.db, pos.positionPubKey, exitResultData.isEmptyReap);
    yield* armLiveRugBlocks({
      db: deps.db,
      poolAddress: decision.poolAddress,
      realizedPnlUsd,
      depositedUsd: pos.depositedUsd,
      rugExitLossPct: deps.rugExitLossPct,
      stablecoinMints: deps.stablecoinMints,
      tokenX: pool.tokenX,
      tokenY: pool.tokenY,
    });
    deps.trackedPositions.delete(pos.positionId);
    yield* deps.db
      .savePositionEvent({
        id: randomUUID(),
        poolAddress: decision.poolAddress,
        positionPubKey: pos.positionPubKey,
        positionId: pos.positionId,
        event: "EXIT",
        valueUsd: exitResultData.withdrawnUsd ?? null,
        feesUsd: pos.cumulativeFeesClaimedUsd,
        price: pool.currentPrice,
        metadata: {
          settlementPending: attributable.length,
          txSignature: exitResultData.txSignature,
        },
        createdAt: now,
      })
      .pipe(Effect.catch(() => Effect.void));
    return { fatal: null };
  });
}

/** Locked realized-PnL inputs for the non-attributed EXIT ledger path. */
/** Realized-PnL inputs computed for the non-attributed EXIT ledger path. */
interface LedgerExitRealized {
  readonly realizedPnlUsd: number | null;
  readonly pricedSweptRewardUsd: number;
  readonly withdrawnUsd: number | null;
  readonly pricingUnresolved: boolean;
  readonly isEmptyReap: boolean;
}

function computeLedgerExitRealized(
  pos: PositionRecord,
  exitResultData: LiveExitResultData | null,
): LedgerExitRealized {
  // ── Locked realized-PnL ordering (Oracle-locked) ──────────────────
  // 1. finalValue = the adapter's mint-priced withdrawn USD (incl. the
  //    unswept fees the close batch claims). When pricing is unresolved
  //    (null / amounts absent) there is NO trusted value → NULL path:
  //    realized recorded n/a, never the mark, never 0.
  const withdrawnUsd = exitResultData?.withdrawnUsd ?? null;
  const pricingUnresolved = withdrawnUsd === null;
  const sweptRewards = exitResultData?.sweptRewards ?? [];
  const pricedSweptRewardUsd = sweptRewards.reduce(
    (acc, r) => (r.amountUsd != null ? acc + r.amountUsd : acc),
    0,
  );
  const isEmptyReap = exitResultData?.isEmptyReap ?? false;
  // 2. Compute on the PRIOR cumulatives only — the exit sweep is credited
  //    AFTER this (step 4) so it is never double-counted.
  const realizedPnlUsd = isEmptyReap
    ? 0
    : pricingUnresolved
      ? null
      : computeRealizedPnlUsd(
          withdrawnUsd,
          pos.cumulativeFeesClaimedUsd,
          pos.depositedUsd,
          pos.cumulativeRewardsClaimedUsd + pricedSweptRewardUsd,
        );
  return { realizedPnlUsd, pricedSweptRewardUsd, withdrawnUsd, pricingUnresolved, isEmptyReap };
}

/** Swept-reward credit rollup: USD accrual plus an unpriced flag for the warn path. */
interface SweptRewardCredit {
  readonly sweptRewardUsd: number;
  readonly unpricedReward: boolean;
}
function creditSweptRewards(
  pos: PositionRecord,
  sweptRewards:
    | ReadonlyArray<{
        readonly mint: string;
        readonly amountAtomic: number;
        readonly amountUsd: number | null;
      }>
    | null
    | undefined,
): SweptRewardCredit {
  let sweptRewardUsd = 0;
  let unpricedReward = false;
  for (const reward of sweptRewards ?? []) {
    if (reward.amountUsd != null) {
      pos.cumulativeRewardsClaimedUsd += reward.amountUsd;
      sweptRewardUsd += reward.amountUsd;
    } else {
      unpricedReward = true;
    }
  }
  return { sweptRewardUsd, unpricedReward };
}

/**
 * Exit-sweep fee booking: fee_claims row plus the mirrored CLAIM event,
 * gated on a positive sweep with a known position pubkey.
 */
function recordExitSweepFeeClaim(
  deps: LiveExecDeps,
  decision: AgentDecision,
  pool: LiveExecPool,
  pos: PositionRecord,
  pendingFeeUsd: number,
  pendingFeeX: number,
  pendingFeeY: number,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if ((pendingFeeX > 0 || pendingFeeY > 0) && pos.positionPubKey != null) {
      const sweepTxSignature = `exit-sweep:${pos.positionId}`;
      yield* deps.db
        .saveFeeClaim({
          id: randomUUID(),
          poolAddress: decision.poolAddress,
          positionPubkey: pos.positionPubKey,
          feeX: pendingFeeX,
          feeY: pendingFeeY,
          platformFeeX: 0,
          platformFeeY: 0,
          netFeeX: pendingFeeX,
          netFeeY: pendingFeeY,
          operatorFeeX: 0,
          operatorFeeY: 0,
          txSignature: sweepTxSignature,
          feeTransferTxSignature: null,
          reportedToApi: false,
          createdAt: Date.now(),
        })
        .pipe(Effect.catch(() => Effect.void));
      // CLAIM event mirrors every other fee booking (a CLAIM row beside
      // the fee_claims record), tagged kind exit_sweep so the swept-fee
      // leg is distinguishable from periodic claims in the event log.
      yield* deps.db
        .savePositionEvent({
          id: randomUUID(),
          poolAddress: decision.poolAddress,
          positionPubKey: pos.positionPubKey,
          positionId: pos.positionId,
          event: "CLAIM",
          valueUsd: null,
          feesUsd: pendingFeeUsd,
          price: pool.currentPrice,
          metadata: { kind: "exit_sweep", txSignature: sweepTxSignature },
          createdAt: Date.now(),
        })
        .pipe(Effect.catch(() => Effect.void));
    }
  });
}

/** Swept-reward CLAIM rollup event (best-effort row, delivery failure swallowed). */
function recordSweptRewardEvent(
  deps: LiveExecDeps,
  decision: AgentDecision,
  pool: LiveExecPool,
  pos: PositionRecord,
  sweptRewards: ReadonlyArray<{
    readonly mint: string;
    readonly amountAtomic: number;
    readonly amountUsd: number | null;
  }>,
  sweptRewardUsd: number,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (sweptRewards.length === 0) return;
    yield* deps.db
      .savePositionEvent({
        id: randomUUID(),
        poolAddress: decision.poolAddress,
        positionPubKey: pos.positionPubKey,
        positionId: pos.positionId,
        event: "CLAIM",
        valueUsd: sweptRewardUsd > 0 ? sweptRewardUsd : null,
        feesUsd: null,
        price: pool.currentPrice,
        metadata: {
          kind: "exit_sweep_reward",
          rewards: sweptRewards.map((r) => ({
            mint: r.mint,
            amountAtomic: r.amountAtomic,
            amountUsd: r.amountUsd,
          })),
        },
        createdAt: Date.now(),
      })
      .pipe(Effect.catch(() => Effect.void));
  });
}
/** Pending-fee sweep reads (null USD = no sweep, zero atomics = nothing to book). */
interface ExitSweepFees {
  readonly feeUsd: number | null;
  readonly feeX: number;
  readonly feeY: number;
}
function readExitSweepFees(exitResultData: LiveExitResultData | null): ExitSweepFees {
  return {
    feeUsd: exitResultData?.pendingFeeUsd ?? null,
    feeX: Number(exitResultData?.pendingFeeXAtomic ?? "0"),
    feeY: Number(exitResultData?.pendingFeeYAtomic ?? "0"),
  };
}
/** Credit the exit sweep post-compute (fee-APR/display/event continuity only). */

function creditExitSweep(
  deps: LiveExecDeps,
  decision: AgentDecision,
  pool: LiveExecPool,
  pos: PositionRecord,
  exitResultData: LiveExitResultData | null,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const sweep = readExitSweepFees(exitResultData);
    if (sweep.feeUsd != null) {
      pos.cumulativeFeesClaimedUsd += sweep.feeUsd;
      yield* recordExitSweepFeeClaim(
        deps,
        decision,
        pool,
        pos,
        sweep.feeUsd,
        sweep.feeX,
        sweep.feeY,
      );
    }
    const credit = creditSweptRewards(pos, exitResultData?.sweptRewards);
    if (credit.unpricedReward) {
      logger.warn("Exit sweep included an unpriceable LM reward — recorded with null USD", {
        pool: decision.poolAddress,
        position: pos.positionId,
      });
    }
    yield* recordSweptRewardEvent(
      deps,
      decision,
      pool,
      pos,
      exitResultData?.sweptRewards ?? [],
      credit.sweptRewardUsd,
    );
  });
}

/** Record the entry-signal outcome when both the signal id and PnL are known. */
function recordSignalOutcomeIfKnown(
  db: DbApi,
  entrySignalSnapshotId: number | null | undefined,
  realizedPnlUsd: number | null,
): Effect.Effect<void, never> {
  if (entrySignalSnapshotId == null || realizedPnlUsd == null) return Effect.void;
  return db
    .recordSignalOutcome(entrySignalSnapshotId, realizedPnlUsd)
    .pipe(Effect.catch(() => Effect.void));
}

/** EXIT event metadata: full forensics when pricing is unresolved, PnL alone otherwise. */
function buildExitMetadata(
  realizedPnlUsd: number | null,
  pricingUnresolved: boolean,
  currentValueUsd: number,
  exitResultData: LiveExitResultData | null,
) {
  if (!pricingUnresolved) return { realizedPnlUsd };
  return {
    realizedPnlUsd,
    pricing: "unresolved",
    lastMarkUsd: currentValueUsd,
    raw: {
      withdrawnXAtomic: exitResultData?.withdrawnXAtomic ?? null,
      withdrawnYAtomic: exitResultData?.withdrawnYAtomic ?? null,
      pendingFeeXAtomic: exitResultData?.pendingFeeXAtomic ?? null,
      pendingFeeYAtomic: exitResultData?.pendingFeeYAtomic ?? null,
    },
  };
}

/** One-time unpriced-exit warning per pool (warned set lives in deps). */
function warnUnpricedExitOnce(
  deps: LiveExecDeps,
  decision: AgentDecision,
  pos: PositionRecord,
  pricingUnresolved: boolean,
): Effect.Effect<void, never> {
  if (!pricingUnresolved) return Effect.void;
  if (deps.unpricedExitWarnedPools?.has(decision.poolAddress) ?? false) return Effect.void;
  return warnUnpricedExit(deps, decision, pos);
}

/** Close the ledger for a non-attributed EXIT: persist, tombstone, rug arm,
 * signal outcome, EXIT event, unpriced warning. */
function finalizeLiveExitLedger(
  deps: LiveExecDeps,
  decision: AgentDecision,
  pool: LiveExecPool,
  pos: PositionRecord,
  exitResultData: LiveExitResultData | null,
  realizedPnlUsd: number | null,
  pricingUnresolved: boolean,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    // Persist the credited cumulatives onto the (still-open) row, THEN
    // close — closePosition runs last so the savePosition upsert (which
    // writes closed_at) cannot resurrect the row; it sets closed_at +
    // realized without touching the fee/reward columns just written.
    yield* persist(`savePosition ${pos.positionId}`, deps.db.savePosition(pos));
    yield* persist(
      `closePosition ${pos.positionId}`,
      deps.db.closePosition(pos.positionId, realizedPnlUsd),
    );
    yield* tombstoneReapedEmpty(deps.db, pos.positionPubKey, exitResultData?.isEmptyReap);
    yield* armLiveRugBlocks({
      db: deps.db,
      poolAddress: decision.poolAddress,
      realizedPnlUsd,
      depositedUsd: pos.depositedUsd,
      rugExitLossPct: deps.rugExitLossPct,
      stablecoinMints: deps.stablecoinMints,
      tokenX: pool.tokenX,
      tokenY: pool.tokenY,
    });
    yield* recordSignalOutcomeIfKnown(deps.db, pos.entrySignalSnapshotId, realizedPnlUsd);
    const withdrawnUsd = exitResultData?.withdrawnUsd ?? null;
    // 5. EXIT event: withdrawn USD (or null) + post-credit lifetime fees.
    const exitMetadata = buildExitMetadata(
      realizedPnlUsd,
      pricingUnresolved,
      pos.currentValueUsd,
      exitResultData,
    );
    yield* deps.db
      .savePositionEvent({
        id: randomUUID(),
        poolAddress: decision.poolAddress,
        positionPubKey: pos.positionPubKey,
        positionId: pos.positionId,
        event: "EXIT",
        valueUsd: withdrawnUsd,
        feesUsd: pos.cumulativeFeesClaimedUsd,
        price: pool.currentPrice,
        metadata: exitMetadata,
        createdAt: Date.now(),
      })
      .pipe(Effect.catch(() => Effect.void));
    yield* warnUnpricedExitOnce(deps, decision, pos, pricingUnresolved);
    deps.trackedPositions.delete(pos.positionId);
  });
}

/** Rotation EXIT gate: true when the arm lapsed and the incumbent is preserved. */
function isExitRotationBlocked(
  deps: RotationArmDeps,
  decision: AgentDecision,
): Effect.Effect<boolean, never> {
  if (!decision.reasoning.startsWith("Rotation:")) return Effect.succeed(false);
  return checkRotationArm(deps, decision).pipe(Effect.map((armValid) => !armValid));
}

/** Persist rug-token blocks after a catastrophic paper EXIT. */
function persistPaperExitRugBlocks(
  db: PaperExecDeps["db"],
  poolAddress: string,
  rugMints: ReadonlyArray<string>,
  rugTokenBlockMs: number | undefined,
): Effect.Effect<void, never> {
  if (rugMints.length === 0) return Effect.void;
  return Effect.gen(function* () {
    const rugExpiresAt = Date.now() + (rugTokenBlockMs ?? 604_800_000);
    for (const mint of rugMints) {
      yield* db.setMetadata(`token_rug_block:${mint}`, String(rugExpiresAt)).pipe(
        Effect.catch((err) =>
          Effect.sync(() =>
            logger.warn("Failed to record rug-token block", {
              pool: poolAddress,
              mint,
              error: String(err),
            }),
          ),
        ),
      );
    }
  });
}

/** Harvest-gate cost overrides forwarded from the executor deps (all optional). */
function harvestGateOverrides(deps: LiveExecDeps) {
  return {
    ...(deps.harvestMinNetUsd !== undefined
      ? { harvestMinNetUsd: deps.harvestMinNetUsd }
      : undefined),
    ...(deps.harvestMaxCostPct !== undefined
      ? { harvestMaxCostPct: deps.harvestMaxCostPct }
      : undefined),
    ...(deps.harvestTxCostUsdEst !== undefined
      ? { harvestTxCostUsdEst: deps.harvestTxCostUsdEst }
      : undefined),
  };
}

/** Daily drawdown pct vs the day baseline (0 when baseline unknown). */
function computeDailyDrawdownPct(baselineEquityUsd: number, equityUsd: number): number {
  return baselineEquityUsd > 0 && equityUsd < baselineEquityUsd
    ? ((baselineEquityUsd - equityUsd) / baselineEquityUsd) * 100
    : 0;
}

/** Redeploy capture site: capped pool still passing candidate gates. */
function isRedeployCaptureSite(
  idleRedeployEnabled: boolean | undefined,
  poolExitFired: boolean,
  poolPositionCount: number,
  maxPositionsPerPool: number,
  unresolved: boolean,
  managed: boolean,
): boolean {
  return (
    idleRedeployEnabled === true &&
    !poolExitFired &&
    poolPositionCount >= maxPositionsPerPool &&
    !unresolved &&
    managed
  );
}

/** Launch-lane membership for the redeploy capture site. */
function isRedeployLaunchPool(
  launchScanEnabled: boolean | undefined,
  launchExecutionEnabled: boolean | undefined,
  inLaunchScan: boolean,
): boolean {
  return launchScanEnabled === true && launchExecutionEnabled === true && inLaunchScan;
}

/** Idle-redeploy pass gate (opt-in, candidates, no live-entry block). */
function shouldRunIdleRedeploy(
  idleRedeployEnabled: boolean | undefined,
  candidateCount: number,
  entriesBlocked: boolean,
): boolean {
  return idleRedeployEnabled === true && candidateCount > 0 && !entriesBlocked;
}

/** Consecutive core-data-failure counter (full-cycle failure increments). */
function updateCoreDataFailureCounter(
  consecutive: number,
  poolsScanned: number,
  failuresThisCycle: number,
): number {
  return poolsScanned > 0 && failuresThisCycle >= poolsScanned ? consecutive + 1 : 0;
}

/** Safety-pause armed check (autonomous with an unresolved pause). */
function isSafetyPauseArmed(
  autonomousExecution: AutonomousExecutionContext | null,
  activeSafetyPause: { readonly resolvedAt: number | null } | null,
): autonomousExecution is AutonomousExecutionContext {
  return autonomousExecution !== null && activeSafetyPause?.resolvedAt !== null;
}

/** Aggregate unrealized PnL across tracked positions (PnL formula parity). */
function computeCycleUnrealizedPnl(trackedPositions: ReadonlyMap<string, PositionRecord>): number {
  let pnl = 0;
  for (const p of trackedPositions.values()) {
    pnl +=
      p.currentValueUsd +
      p.cumulativeFeesClaimedUsd +
      p.cumulativeRewardsClaimedUsd -
      p.depositedUsd;
  }
  return pnl;
}

/** Kill-switch re-arm skip: same observation or longer cooldown already set. */
function shouldSkipKillSwitchRearm(
  existing: { readonly reason: string; readonly cooldownUntil: number } | null,
  observationMarker: string,
  desiredUntil: number,
): boolean {
  if (!existing) return false;
  if (existing.reason.startsWith(observationMarker)) return true;
  return existing.cooldownUntil >= desiredUntil;
}

/** Kill-switch cooldown row for a fresh trip. */
function buildKillSwitchCooldown(
  tripPoolAddress: string,
  tripPositionIdsLength: number,
  tripRealizedPnlUsd: number,
  existing: { readonly cooldownUntil: number; readonly consecutiveOorExits: number } | null,
  desiredUntil: number,
  thresholdUsd: number | undefined,
  observationMarker: string,
) {
  return {
    poolAddress: tripPoolAddress,
    cooldownUntil: Math.max(existing?.cooldownUntil ?? 0, desiredUntil),
    reason:
      `${observationMarker} trailing ${tripPositionIdsLength} known closes ` +
      `net $${tripRealizedPnlUsd.toFixed(2)} below ` +
      `$${(thresholdUsd ?? -15).toFixed(2)}`,
    consecutiveOorExits: existing?.consecutiveOorExits ?? 0,
  };
}

/** Market-scan gate config with operator defaults. */
function resolveMarketScanConfig(config: AppConfig) {
  return {
    minTvlUsd: config.marketScanMinTvlUsd ?? 250_000,
    minFeeApr: config.marketScanMinFeeApr ?? 25,
    minFees24hUsd: config.marketScanMinFees24hUsd,
    minVolume24hUsd: config.marketScanMinVolume24hUsd,
    minHolders: config.marketScanMinHolders ?? 1000,
    minPoolAgeHours: config.marketScanMinPoolAgeHours ?? 24,
    minBinStep: config.marketScanMinBinStep ?? 2,
    maxBinStep: config.marketScanMaxBinStep ?? 200,
    stablecoinMints: config.stablecoinMints ?? new Set<string>(),
  };
}

/** Active market-scan set size (top-K bounded by the max pool cap). */
function resolveMarketActiveCount(config: AppConfig): number {
  return Math.min(config.marketScanTopK ?? 30, config.marketScanMaxPools ?? 60);
}

/** Redeploy portfolio value (paper seed vs wallet + positions). */
function resolveRedeployPortfolioValueUsd(
  paperTrading: boolean,
  hasWallet: boolean,
  paperPortfolioUsd: number,
  lastWalletBalanceUsd: number,
  openPositions: ReadonlyArray<Position>,
): number {
  if (paperTrading || !hasWallet) return paperPortfolioUsd;
  return lastWalletBalanceUsd + openPositions.reduce((sum, pos) => sum + pos.currentValueUsd, 0);
}

/** Queue/sync source for an adopted redeploy proposal. */
function resolveRedeployProposalSource(
  agentProposal: AgentProposal | null,
): "queue" | "sync" | undefined {
  return agentProposal ? "queue" : undefined;
}

/** Sync-proposal eligibility (transport + breaker + backoff + latency). */
function isSyncProposalEligible(
  hasTransport: boolean,
  breakerCanTry: boolean,
  backoffActive: boolean,
  latencySkipped: boolean,
): boolean {
  return hasTransport && breakerCanTry && !backoffActive && !latencySkipped;
}

/** Routable mints from probe results (positional parallel arrays). */
function collectRoutableMints(
  nonSolMints: ReadonlyArray<string>,
  routeAvailableResults: ReadonlyArray<boolean>,
): Set<string> {
  const routable = new Set<string>();
  for (let i = 0; i < nonSolMints.length; i++) {
    const mint = nonSolMints[i];
    if (mint && routeAvailableResults[i]) routable.add(mint);
  }
  return routable;
}

/** Pools needing price-scale backfill (position pools + snapshot pools). */
function collectBackfillPools(
  positions: ReadonlyArray<{ readonly poolAddress: string; readonly entryPriceUsd: number | null }>,
  snapshotPools: ReadonlyArray<string>,
): Set<string> {
  const pools = new Set<string>();
  for (const pos of positions) {
    if (pos.entryPriceUsd != null) pools.add(pos.poolAddress);
  }
  for (const pool of snapshotPools) pools.add(pool);
  return pools;
}

/** Cached-or-fetched price-scale factor for one pool (fails on invalid). */
function resolveBackfillFactor(
  db: DbApi,
  adapter: AdapterApi,
  pool: string,
): Effect.Effect<number, Error> {
  return Effect.gen(function* () {
    const key = priceScaleFactorKey(pool);
    const cached = yield* db.getMetadata(key).pipe(Effect.catch(() => Effect.succeed(null)));
    if (cached != null) {
      const cachedFactor = Number(cached);
      if (Number.isFinite(cachedFactor) && cachedFactor > 0) return cachedFactor;
    }
    const factor = adapter.getPriceScale ? yield* adapter.getPriceScale(pool) : 1;
    if (!Number.isFinite(factor) || factor <= 0) {
      return yield* Effect.fail(
        new Error(`Price-scale backfill: invalid factor ${factor} for ${pool}`),
      );
    }
    yield* db.setMetadata(key, String(factor)).pipe(Effect.catch(() => Effect.void));
    return factor;
  });
}

/** Autonomous execution context (null outside canary/live with a wallet). */
function resolveAutonomousExecution(
  config: AppConfig,
  executionWalletAddress: string | null,
): AutonomousExecutionContext | null {
  if (config.autonomousTokenMode === "off" || executionWalletAddress === null) return null;
  return {
    mode: config.autonomousTokenMode,
    walletAddress: executionWalletAddress,
    agentInstanceId: config.agentInstanceId,
    settlementMaxPendingMs: config.settlementMaxPendingMs,
    settlementDustUsd: config.settlementDustUsd,
  };
}

/** SOL-funded entry mode (autonomous canary/live spend native SOL for legs). */
function isSolFundedEntryMode(autonomousTokenMode: AppConfig["autonomousTokenMode"]): boolean {
  return autonomousTokenMode === "canary" || autonomousTokenMode === "live";
}

/** Candidate wallet identity ("paper" when walletless). */
function resolveCandidateWallet(executionWalletAddress: string | null): string {
  return executionWalletAddress ?? "paper";
}

/** Exempted-leg labels for the trusted-stablecoin freeze exemption. */
function describeExemptedFreezeLegs(
  pool: PoolState,
  freezeEnabledX: boolean,
  trustedX: boolean,
  freezeEnabledY: boolean,
  trustedY: boolean,
): string {
  return [
    freezeEnabledX && trustedX ? `${pool.tokenXSymbol} (${pool.tokenX})` : null,
    freezeEnabledY && trustedY ? `${pool.tokenYSymbol} (${pool.tokenY})` : null,
  ]
    .filter((s) => s !== null)
    .join(" and ");
}

/** Freeze authority enabled via Data API flag or on-chain authority. */
function isFreezeAuthorityEnabled(
  freezeDisabledFlag: boolean | null | undefined,
  onChainFreezeAuthority: string | null | undefined,
): boolean {
  return freezeDisabledFlag === false || onChainFreezeAuthority != null;
}

/** Stablecoin-allowlist trust for a token leg. */
function isTrustedMint(stablecoinMints: ReadonlySet<string> | undefined, mint: string): boolean {
  return stablecoinMints?.has(mint) === true;
}

/** Freeze-enabled leg outside the trust allowlist. */
function hasUntrustedFreeze(freezeEnabled: boolean, trusted: boolean): boolean {
  return freezeEnabled && !trusted;
}

/** Mint authority for blacklist screening (undefined when unknown). */
function resolveMintAuthority(
  auth: { readonly mintAuthority?: string | null } | null,
): string | undefined {
  return auth?.mintAuthority ?? undefined;
}

/** Measured-APR self-outlier flag for runner classification. */
function resolveRunnerAprOutlier(
  outlierEnabled: boolean | undefined,
  priorAprs: ReadonlyArray<number>,
  currentApr: number,
  outlierPercentile: number | undefined,
): boolean {
  return outlierEnabled === true && isAprSelfOutlier({ priorAprs, currentApr, outlierPercentile });
}

/** Hot-window size band with operator defaults. */
function resolveHotWindowSizeBand(
  entrySizeUsd: number | undefined,
  maxPoolTvlUsd: number | undefined,
  minPoolTvlUsd: number | undefined,
  printingRatio1h: number | undefined,
) {
  return {
    entrySizeUsd: entrySizeUsd ?? 30,
    maxPoolTvlUsd: maxPoolTvlUsd ?? 25_000,
    minPoolTvlUsd: minPoolTvlUsd ?? 500,
    printingRatio1h: printingRatio1h ?? 1,
  };
}

/** Flash volume-trigger config (undefined when the trigger is off). */
function buildHotWindowVolumeSpike(
  flashVolumeTriggerEnabled: boolean | undefined,
  flashBaselineWindow: number | undefined,
  flashMinSpikeRatio: number | undefined,
  flashMinVolumeUsd: number | undefined,
):
  | {
      readonly baselineWindow: number;
      readonly spikeRatio: number;
      readonly minPoints: number;
      readonly minVolumeUsd: number;
    }
  | undefined {
  if (flashVolumeTriggerEnabled !== true) return undefined;
  return {
    baselineWindow: flashBaselineWindow ?? 8,
    spikeRatio: flashMinSpikeRatio ?? 2.5,
    minPoints: 5,
    minVolumeUsd: flashMinVolumeUsd ?? 10_000,
  };
}

/** Burst entry: measured spike above the printing floor. */
function isHotBurstEntry(
  volumeSpikeVerdict: VolumeSpikeResult | null,
  feeTvlRatio1h: number | null | undefined,
  printingRatio1h: number,
): boolean {
  return (
    volumeSpikeVerdict !== null &&
    volumeSpikeVerdict.isSpike &&
    (feeTvlRatio1h ?? 0) < printingRatio1h
  );
}

/** Hot-window ENTER reasoning (burst vs printing trigger). */
function buildHotEnterReasoning(
  burstEntry: boolean,
  volumeSpikeRatio: number | null,
  feeTvlRatio1h: number | null | undefined,
  tvlUsd: number,
  sizeUsd: number,
  tripsToday: number,
  maxTripsPerDay: number,
): string {
  const trigger = burstEntry
    ? `:burst] volume burst x${(volumeSpikeRatio ?? 0).toFixed(1)} vs baseline`
    : `] pool printing (1h ratio ${(feeTvlRatio1h ?? 0).toFixed(2)}%/h)`;
  return `[hot-window${trigger}, depth $${tvlUsd.toFixed(0)}, size $${sizeUsd.toFixed(0)}, trips ${tripsToday}/${maxTripsPerDay}`;
}

/** SOL cost of a runner scale-in top-up (0 outside SOL-funded mode). */
function resolveScaleInSolCost(
  solFundedEntryMode: boolean,
  topUpUsd: number,
  solPriceUsd: number,
  poolHasSolLeg: boolean,
): bigint {
  return solFundedEntryMode
    ? estimateEntrySolLamports({
        positionSizeUsd: topUpUsd,
        solPriceUsd,
        poolHasSolLeg,
        solFunded: true,
      })
    : 0n;
}

/** Scale-in trigger inputs with operator defaults. */
function resolveScaleInTrigger(
  anchorPrice: number | null | undefined,
  currentPrice: number,
  stepPct: number | undefined,
  steps: number | null | undefined,
  maxSteps: number | undefined,
) {
  return {
    anchorPrice: anchorPrice ?? 0,
    currentPrice,
    stepPct: stepPct ?? 0.05,
    steps: steps ?? 0,
    maxSteps: maxSteps ?? 3,
  };
}

/** Measured 1h launch fees (null unless datapi-measured over positive TVL). */
function measureCurrentLaunchFees1h(
  statsSource: PoolState["statsSource"],
  feeTvlRatio1h: number | null,
  tvlUsd: number,
): number | null {
  if (
    statsSource !== "datapi" ||
    feeTvlRatio1h === null ||
    !Number.isFinite(feeTvlRatio1h) ||
    tvlUsd <= 0
  ) {
    return null;
  }
  return (feeTvlRatio1h / 100) * tvlUsd;
}

/** Track the per-position peak 1h fees; returns the stored peak. */
function trackLaunchFeePeak(
  peaks: Map<string, number>,
  positionId: string,
  currentFees1hUsd: number | null,
): number | null {
  const prevPeak = peaks.get(positionId);
  if (currentFees1hUsd !== null && (prevPeak === undefined || currentFees1hUsd > prevPeak)) {
    peaks.set(positionId, currentFees1hUsd);
  }
  return peaks.get(positionId) ?? null;
}

/** Time-box leg of a launch-lifecycle exit reason. */
function describeLaunchTimeboxExit(
  positionTimestamp: number,
  timeboxHours: number | undefined,
): string {
  return `age ${((Date.now() - positionTimestamp) / 3.6e6).toFixed(1)}h >= ${timeboxHours ?? 6}h`;
}

/** Volume-decay leg of a launch-lifecycle exit reason. */
function describeLaunchVolumeDecayExit(
  currentFees1hUsd: number | null,
  volumeDecayExitPct: number | undefined,
  peakFees1hUsd: number | null,
): string {
  return `1h fees $${(currentFees1hUsd ?? 0).toFixed(2)} < ${(volumeDecayExitPct ?? 0.1) * 100}% of peak $${(peakFees1hUsd ?? 0).toFixed(2)}`;
}

/** Drawdown pct for a launch position (shakeout-tolerant for runners). */
function resolveLaunchDrawdownPct(
  launchRunner: boolean | null | undefined,
  runnerDrawdownPct: number | undefined,
  exitDrawdownPct: number | undefined,
): number {
  return launchRunner === true ? (runnerDrawdownPct ?? 0.25) : (exitDrawdownPct ?? 0.25);
}

/** Drawdown leg of a launch-lifecycle exit reason. */
function describeLaunchDrawdownExit(
  currentValueUsd: number,
  drawdownPct: number,
  peakValueUsd: number | null,
): string {
  return `value $${currentValueUsd.toFixed(2)} <= ${(1 - drawdownPct) * 100}% of peak $${(peakValueUsd ?? 0).toFixed(2)}`;
}

/** IL-dominance trigger: IL exceeds fees by factor and floor. */
function isIlDominant(
  ilUsd: number,
  feesClaimedUsd: number,
  exitFactor: number | undefined,
  minUsd: number | undefined,
): boolean {
  return ilUsd > 0 && ilUsd > feesClaimedUsd * (exitFactor ?? 2) && ilUsd > (minUsd ?? 5);
}

/** Runner net-bleed candidacy (measured fees only; unmeasured size fails closed). */
function isNetBleedCandidate(
  launchRunner: boolean | null | undefined,
  positionMode: string | null | undefined,
  runnerEnabled: boolean | undefined,
  feeIlRatioKnown: boolean,
  currentValueUsd: number,
  depositedUsd: number,
): boolean {
  return (
    launchRunner === true &&
    positionMode === "launch" &&
    runnerEnabled === true &&
    feeIlRatioKnown &&
    (currentValueUsd ?? depositedUsd ?? 0) > 0
  );
}

/** Runner size for net-yield math (0 when unmeasurable). */
function resolveRunnerSizeUsd(currentValueUsd: number, depositedUsd: number): number {
  return currentValueUsd ?? depositedUsd ?? 0;
}

/** Runner half-width (finite positive override, else the pool width). */
function resolveRunnerHalfWidth(positionHalfWidth: number, rangeHalfWidth: number): number {
  return Number.isFinite(positionHalfWidth) && positionHalfWidth > 0
    ? positionHalfWidth
    : rangeHalfWidth;
}

/** Peak + drawdown from the trailing-stop mark. */
function computeTrailingDrawdown(
  currentValueUsd: number,
  highestValueUsd: number | null,
  depositedUsd: number,
) {
  const highest = highestValueUsd ?? depositedUsd;
  return { highest, drawdown: highest > 0 ? (highest - currentValueUsd) / highest : 0 };
}

/** Unrealized PnL fraction (0 when the deposit is unknown). */
function computeUnrealizedPnlPct(depositedUsd: number, estimatedValue: number): number {
  return depositedUsd > 0 ? (estimatedValue - depositedUsd) / depositedUsd : 0;
}

/** EXIT cooldown trigger class (null = churn-throttle path). */
function classifyExitCooldownTrigger(
  exitReasoning: string,
  position: PositionRecord | undefined,
  oorGracePeriodCycles: number,
): "oor" | "low-yield" | null {
  if (
    exitReasoning.includes("volatility") ||
    (position !== undefined &&
      position.oorCycleCount >= oorGracePeriodCycles &&
      position.oorCycleCount > 0)
  ) {
    return "oor";
  }
  if (exitReasoning.includes("Fee/IL ratio") || exitReasoning.includes("Volume authenticity")) {
    return "low-yield";
  }
  return null;
}

/** Measured fee density per day (null unless datapi-measured). */
function resolveFeeDensityPerDay(
  statsSource: PoolState["statsSource"],
  tvlUsd: number,
  fees24hUsd: number,
): number | null {
  return statsSource === "datapi" && tvlUsd > 0 && Number.isFinite(fees24hUsd) && fees24hUsd >= 0
    ? fees24hUsd / tvlUsd
    : null;
}

/** W15 fast-EXIT reasoning from present signals. */
function buildW15ExitReasoning(
  depeg: DepegLiquiditySignals["depeg"],
  liquidityDrain: DepegLiquiditySignals["liquidityDrain"],
): string {
  return `W15 fast EXIT: ${[
    depeg ? "stablecoin depeg" : null,
    liquidityDrain ? "liquidity drain" : null,
  ]
    .filter(Boolean)
    .join(" + ")}`;
}

/** Dust-cleanup EXIT gate: REAL mark below the dust threshold. */
function isDustExit(dustExitUsd: number | undefined, currentValueUsd: number): boolean {
  return (dustExitUsd ?? 0) > 0 && currentValueUsd < (dustExitUsd ?? 0);
}

/** Dust-cleanup EXIT reasoning. */
function buildDustExitReasoning(currentValueUsd: number, dustExitUsd: number | undefined): string {
  return `[dust-cleanup] Position value $${currentValueUsd.toFixed(2)} below $${(dustExitUsd ?? 0).toFixed(2)} dust threshold — reclaiming slot`;
}

/** Single-rung TP ladder for a normal ENTER (null when disabled). */
function resolveNormalEnterTpLadder(
  currentPrice: number,
  takeProfitEnabled: boolean | undefined,
  takeProfitPct: number | undefined,
  trailingStopPct: number | undefined,
): ReturnType<typeof buildTpLadder> | null {
  if (takeProfitEnabled !== true) return null;
  return buildTpLadder(currentPrice, {
    rungs: [takeProfitPct ?? 0.15],
    fractions: [1],
    invalidationStopPct: trailingStopPct ?? 0.1,
  });
}

/** Momentum-boosted normal ENTER confidence with operator defaults. */
function resolveNormalEntryConfidence(
  feeIlRatio: number,
  netDriftBins: number,
  referenceBins: number | undefined,
  confBoost: number | undefined,
): number {
  return normalEntryConfidence(feeIlRatio, netDriftBins, {
    referenceBins: referenceBins ?? DEFAULT_MOMENTUM_REFERENCE_BINS,
    confBoost: confBoost ?? DEFAULT_MOMENTUM_CONF_BOOST,
  });
}

/** TP-ladder spread for an ENTER decision (undefined when no ladder). */
function resolveTpLadderSpread(
  tpLadder: ReturnType<typeof buildTpLadder> | null,
):
  | { readonly tpLadderJson: string | undefined; readonly invalidationStopPrice: number }
  | undefined {
  if (tpLadder === null) return undefined;
  return {
    tpLadderJson: serializeTpLadder(tpLadder.ladder) ?? undefined,
    invalidationStopPrice: tpLadder.invalidationPrice,
  };
}

/** Net-daily-yield after churn/IL/swap costs for a candidate position size. */
function computePositionNetDailyPct(
  fees24hUsd: number,
  poolTvlUsd: number,
  positionSizeUsd: number,
  halfWidthBins: number,
  binStep: number,
  volatilityStddev: number,
  swapCostPct: number | undefined,
  harvestCostUsd: number | undefined,
  scanIntervalMs: number | undefined,
): number {
  return runnerNetDailyPctAfterCosts({
    fees24hUsd,
    poolTvlUsd,
    positionSizeUsd,
    rangeHalfWidthBins: halfWidthBins,
    binStep,
    volatilityStddev,
    swapCostPct: swapCostPct ?? 0.005,
    harvestCostUsd: harvestCostUsd ?? 0.01,
    timeInRangePct: 1,
    maxExitsPerDay: 86_400_000 / (scanIntervalMs ?? 600_000),
  });
}

/** Hard-risk reason for one token leg (null = clean). */
function resolveLegRiskReason(
  risks: ReadonlyMap<string, TokenRiskSignal>,
  mint: string,
  symbol: string,
): string | null {
  const signal = risks.get(mint);
  if (signal === undefined) return null;
  if (signal.isSus) {
    return `${symbol} (${mint}): Jupiter audit flags suspicious (isSus)`;
  }
  if (signal.goPlusHardRisk != null) {
    return `${symbol} (${mint}): GoPlus ${signal.goPlusHardRisk}`;
  }
  if (signal.organicScoreLabel === "low") {
    return `${symbol} (${mint}): Jupiter organic score is low`;
  }
  return null;
}

/** Rotation comparison costs with operator defaults. */
function resolveRotationCosts(
  launchPositionMaxSizeUsd: number | undefined,
  harvestCostUsd: number | undefined,
  conversionCostPct: number | undefined,
  minYieldExitAgeMs: number | undefined,
) {
  return {
    runnerSizeUsd: launchPositionMaxSizeUsd ?? 100,
    harvestCostUsd: harvestCostUsd ?? 0.01,
    conversionCostPct: conversionCostPct ?? 0.05,
    minAgeMs: minYieldExitAgeMs ?? 14_400_000,
  };
}

/** Incumbent position size for rotation comparison (100 default when unknown). */
function resolveIncumbentSizeUsd(incumbentPos: PositionRecord | undefined): number {
  return incumbentPos?.currentValueUsd ?? incumbentPos?.depositedUsd ?? 100;
}

/** Rotation superiority multiple (doubled on euphoria-damper spikes). */
function resolveRotationAprMult(
  runnerAprOutlier: boolean,
  rotationAprMult: number | undefined,
): number | undefined {
  return runnerAprOutlier ? (rotationAprMult ?? DEFAULT_ROTATION_APR_MULT) * 2 : rotationAprMult;
}

/** Measured-only ENTER candidate conditions (modeled fee/IL never votes). */
function passesMeasuredCandidateGates(
  feeIlRatioKnown: boolean,
  feeIlRatio: number,
  minFeeIlRatio: number,
  volumeAuthKnown: boolean,
  volumeAuth: number,
  binUtilKnown: boolean,
  binUtilization: number,
  tvlUsd: number,
  minPoolTvlUsd: number,
): boolean {
  const feeIlGate = feeIlRatioKnown ? feeIlRatio > minFeeIlRatio * 1.5 : true;
  return (
    feeIlGate &&
    volumeAuthKnown &&
    volumeAuth > 0.8 &&
    binUtilKnown &&
    binUtilization > 0.4 &&
    tvlUsd > minPoolTvlUsd * 2
  );
}

/** Momentum-score tuning with operator defaults. */
function resolveMomentumScoreArgs(
  referenceBins: number | undefined,
  scoreWeight: number | undefined,
) {
  return {
    referenceBins: referenceBins ?? DEFAULT_MOMENTUM_REFERENCE_BINS,
    scoreWeight: scoreWeight ?? DEFAULT_MOMENTUM_SCORE_WEIGHT,
  };
}

/** Fallen-angel TP ladder with operator defaults. */
function resolveFallenAngelLadder(
  currentPrice: number,
  tpRungs: ReadonlyArray<number> | undefined,
  tpFractions: ReadonlyArray<number> | undefined,
  invalidationStopPct: number | undefined,
): ReturnType<typeof buildTpLadder> {
  return buildTpLadder(currentPrice, {
    rungs: tpRungs ?? [0.15, 0.3, 0.5],
    fractions: tpFractions ?? [0.4, 0.3, 0.3],
    invalidationStopPct: invalidationStopPct ?? 0.25,
  });
}

/** Position share of pool TVL, capped at 100% (0 when unmeasurable). */
function resolvePositionSharePct(tvlUsd: number, currentValueUsd: number): number {
  return tvlUsd > 0 && currentValueUsd > 0 ? Math.min(currentValueUsd / tvlUsd, 1) : 0;
}

/** Tracked position targeted by a REBALANCE capital-gate re-check. */
function resolveRebalanceGatePosition(
  adjustedPositionId: string | undefined,
  decisionPositionId: string | undefined,
  trackedPositions: ReadonlyMap<string, PositionRecord>,
): PositionRecord | undefined {
  const gatePosId = adjustedPositionId ?? decisionPositionId;
  return gatePosId !== undefined ? trackedPositions.get(gatePosId) : undefined;
}

/** Preserve the launch lane marker across an advisor echo/resize. */
function preserveLaunchMarker(
  deterministic: AgentDecision,
  adjusted: AgentDecision,
): AgentDecision {
  if (deterministic.positionMode !== undefined && deterministic.action === "ENTER") {
    return { ...deterministic, positionMode: deterministic.positionMode };
  }
  return adjusted;
}

/** Preserve deterministic EXIT reasoning across an advisor echo. */
function preserveExitReasoning(
  originalAction: ActionType,
  decisionAction: ActionType,
  deterministicReasoning: string,
  decision: AgentDecision,
): AgentDecision {
  if (originalAction === "EXIT" && decisionAction === "EXIT" && deterministicReasoning.length > 0) {
    return { ...decision, reasoning: deterministicReasoning };
  }
  return decision;
}

/** Fee/IL leg of the proposal hard floor (null = pass). */
function feeIlHardFloorReason(
  ilProtectionEnabled: boolean | undefined,
  feeIlRatioKnown: boolean,
  feeIlRatio: number,
  minFeeIlRatio: number,
): string | null {
  if (ilProtectionEnabled === true && feeIlRatioKnown && feeIlRatio < minFeeIlRatio) {
    return `[fee-il-gate] Fee/IL ${feeIlRatio.toFixed(2)} below ${minFeeIlRatio}`;
  }
  return null;
}

/** Drift leg of the proposal hard floor (null = pass). */
function driftHardFloorReason(
  inLaunchScan: boolean,
  runner: boolean,
  netDriftBins: number,
  maxNegativeDriftBins: number | undefined,
): string | null {
  if (
    !inLaunchScan &&
    !runner &&
    driftGateRejected(netDriftBins, maxNegativeDriftBins ?? DEFAULT_MAX_NEGATIVE_DRIFT_BINS)
  ) {
    return `[drift-gate] net drift ${netDriftBins} < ${maxNegativeDriftBins ?? DEFAULT_MAX_NEGATIVE_DRIFT_BINS}`;
  }
  return null;
}

/** Launch-drift leg of the proposal hard floor (null = pass). */
function launchDriftHardFloorReason(
  launchScanEnabled: boolean | undefined,
  netDriftBins: number,
  minDriftBins: number | undefined,
): string | null {
  if (
    launchScanEnabled === true &&
    netDriftBins < (minDriftBins ?? DEFAULT_RUNNER_MIN_DRIFT_BINS)
  ) {
    return `[launch-drift-gate] net drift ${netDriftBins} < ${minDriftBins ?? DEFAULT_RUNNER_MIN_DRIFT_BINS}`;
  }
  return null;
}

/** Queued proposal id carried by an applied queue proposal (undefined otherwise). */
function resolveRedeployAppliedProposalId(
  proposalSource: "queue" | "sync" | undefined,
  proposalId: string | undefined,
): string | undefined {
  return proposalSource === "queue" && proposalId ? proposalId : undefined;
}

/** Proposal with deterministic originals backfilled for validation. */
function buildProposalToEvaluate(
  agentProposal: AgentProposal,
  decisionAction: ActionType,
  decisionConfidence: number,
): AgentProposal {
  return {
    ...agentProposal,
    ...(agentProposal.originalAction === undefined
      ? { originalAction: decisionAction }
      : undefined),
    ...(agentProposal.originalConfidence === undefined
      ? { originalConfidence: decisionConfidence }
      : undefined),
  };
}

/** Runner-lane entry shape: dip-anchored below-market ladder for LAUNCH entries. */
function isRunnerLaunchEntry(
  launchRunnerModeEnabled: boolean | undefined,
  positionMode: AgentDecision["positionMode"],
  inLaunchScan: boolean,
  runner: boolean,
): boolean {
  return launchRunnerModeEnabled === true && positionMode === "launch" && (inLaunchScan || runner);
}

/** Eligible autonomous candidate id for a pool (entered or eligible). */
function findEligibleAutonomousCandidateId(
  candidates: ReadonlyMap<string, TokenCandidateRecord>,
  poolAddress: string,
): string | undefined {
  return [...candidates.values()].find(
    (candidate) =>
      candidate.poolAddress === poolAddress &&
      (candidate.state === "eligible" || candidate.state === "entered"),
  )?.id;
}

/** Dip offset below the active bin for a runner-lane entry. */
function resolveRunnerDipOffset(binStep: number, dipPct: number | undefined): number {
  return dipOffsetBinsForPct(binStep, dipPct ?? 0.12);
}

/** Runner half-width within the operator risk cap and below the active bin. */
function clampRunnerHalfWidth(
  dipOffsetBins: number,
  halfWidthBins: number | undefined,
  maxRebalanceRangeBins: number | undefined,
): number {
  return Math.max(
    1,
    Math.min(
      halfWidthBins ?? 5,
      Math.abs(dipOffsetBins) - 1,
      Math.floor((maxRebalanceRangeBins ?? 100) / 2),
    ),
  );
}

/** SOL-funded ENTER failing on a funding condition: capacity, not an error. */
function isCapacityExecutionFailure(
  action: ActionType,
  solFunded: boolean,
  executionError: string | undefined,
): boolean {
  return action === "ENTER" && solFunded && isInsufficientTokenBalanceError(executionError);
}

/** Post-execution check-in trigger for executed ENTER/EXIT/REBALANCE. */
function shouldSendPostExecutionCheckin(executed: boolean, action: ActionType): boolean {
  return executed && (action === "ENTER" || action === "EXIT" || action === "REBALANCE");
}

/** True when a fee claim carries a platform/operator split worth reporting. */
function hasPlatformFeeSplit(claim: Effect.Success<ReturnType<AdapterApi["claimFees"]>>): boolean {
  return (
    claim.platformFeeX > 0 ||
    claim.platformFeeY > 0 ||
    (claim.operatorFeeX ?? 0) > 0 ||
    (claim.operatorFeeY ?? 0) > 0
  );
}

/** Fee-claim ledger row shared by the pre-rebalance and periodic claim paths. */
function buildFeeClaimRow(
  poolAddress: string,
  positionPubKey: string,
  claim: Effect.Success<ReturnType<AdapterApi["claimFees"]>>,
): Parameters<DbApi["saveFeeClaim"]>[0] {
  return {
    id: randomUUID(),
    poolAddress,
    positionPubkey: positionPubKey,
    feeX: claim.feeX,
    feeY: claim.feeY,
    platformFeeX: claim.platformFeeX,
    platformFeeY: claim.platformFeeY,
    netFeeX: claim.netFeeX,
    netFeeY: claim.netFeeY,
    operatorFeeX: claim.operatorFeeX ?? 0,
    operatorFeeY: claim.operatorFeeY ?? 0,
    txSignature: claim.txSignature,
    feeTransferTxSignature: claim.feeTransferTxSignature ?? null,
    createdAt: Date.now(),
    reportedToApi: false,
  };
}

/** True when the claim interval elapsed since the last claim for a position. */
function isClaimIntervalElapsed(
  lastFeeClaimAt: number,
  nowMs: number,
  feeClaimIntervalMs: number,
): boolean {
  return nowMs - lastFeeClaimAt > feeClaimIntervalMs;
}

/** True when a claimFees outcome holds nonzero legs worth booking. */
function hasClaimableFees(
  result: Effect.Success<ReturnType<AdapterApi["claimFees"]>> | null,
): result is Effect.Success<ReturnType<AdapterApi["claimFees"]>> {
  return result !== null && (result.feeX !== 0 || result.feeY !== 0);
}

/** True when a fee claim carries a platform/operator split worth reporting. */
function hasReportablePlatformFees(
  claimResult: Effect.Success<ReturnType<AdapterApi["claimFees"]>>,
): boolean {
  return (
    claimResult.platformFeeX > 0 ||
    claimResult.platformFeeY > 0 ||
    (claimResult.operatorFeeX ?? 0) > 0 ||
    (claimResult.operatorFeeY ?? 0) > 0
  );
}
/** Pre-rebalance fee claim behind the G4 harvest gate (rebalance always completes). */
/** Book a pre-rebalance claim: fee row, CLAIM event, platform-fee report. */

function bookPreRebalanceClaim(
  deps: LiveExecDeps,
  decision: AgentDecision,
  pool: LiveExecPool,
  pos: PositionRecord,
  positionPubKey: string,
  claimResult: Effect.Success<ReturnType<AdapterApi["claimFees"]>>,
  tier: string,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    yield* deps.db
      .saveFeeClaim(buildFeeClaimRow(decision.poolAddress, positionPubKey, claimResult))
      .pipe(Effect.catch(() => Effect.void));
    // Mint-based net-fee USD priced inside the adapter (mirrors
    // simulateRebalance). Null → 0 fails closed so an unpriceable claim
    // never inflates cumulative fees or the compound gate.
    const claimedFeesUsd = claimResult.netFeesUsd ?? 0;
    pos.cumulativeFeesClaimedUsd += claimedFeesUsd;
    yield* deps.db
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
      .pipe(Effect.catch(() => Effect.void));
    if (hasReportablePlatformFees(claimResult)) {
      yield* Effect.forkChild(
        deps.adapter
          .reportFeeCollection({
            poolAddress: decision.poolAddress,
            ...(positionPubKey != null && { positionPubkey: positionPubKey }),
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
            Effect.catchCause((cause) =>
              Effect.sync(() =>
                console.error("reportFeeCollection failed", { cause: String(cause) }),
              ),
            ),
          ),
      ).pipe(Effect.asVoid);
    }
  });
}

/**
 * G4 harvest-gate read for the pre-rebalance claim (rule: never spend $0.80
 * to realize $1.00). Fail open on unknown pending — null means no gate.
 */
function readRebalanceHarvestGate(deps: LiveExecDeps, poolAddress: string, positionPubKey: string) {
  if (!deps.adapter.getClaimableFeesUsd) return Effect.succeed(null);
  return deps.adapter.getClaimableFeesUsd(poolAddress, positionPubKey).pipe(
    Effect.map((netUsd) => evaluateHarvestGate(netUsd, harvestGateOverrides(deps))),
    Effect.catch(() =>
      Effect.succeed({
        approved: true,
        reason: "[harvest-gate] pending read failed — fail open (claim anyway)",
      }),
    ),
  );
}

/** Adapter atomic-rebalance attempt with success/error settlement (never throws). */
function attemptAtomicRebalance(
  deps: LiveExecDeps,
  decision: AgentDecision,
  positionPubKey: string,
  rebalanceParams: NonNullable<AgentDecision["rebalanceParams"]>,
) {
  return deps.adapter
    .rebalancePosition(
      decision.poolAddress,
      positionPubKey,
      rebalanceParams.newLowerBinId,
      rebalanceParams.newUpperBinId,
      rebalanceParams.topUp,
    )
    .pipe(
      Effect.tap((r) =>
        Effect.sync(() =>
          console.info("Live position rebalanced atomically", {
            pool: decision.poolAddress,
            position: r.positionPubKey,
            txSignatures: r.txSignatures.length,
          }),
        ),
      ),
      // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
      Effect.map((r) => ({ result: r, error: undefined as string | undefined })),
      Effect.catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Live atomic REBALANCE failed", {
          pool: decision.poolAddress,
          err: msg,
        });
        return Effect.succeed({ result: null, error: msg });
      }),
    );
}

/**
 * Post-rebalance record: the top-up is FRESH capital — grow the cost basis
 * and the mark in lockstep (currentValue + topUp = the post-rebalance
 * on-chain value; depositedUsd tracks the added capital so PnL never treats
 * it as profit), credit the X basis and advance the band anchor + step count.
 * Atomic rebalance preserves the position account: the pubkey, entry basis
 * and cumulative fee accounting all survive.
 */
function buildRebalancedRecord(
  pos: PositionRecord,
  currentPrice: number,
  rebalanceParams: NonNullable<AgentDecision["rebalanceParams"]>,
  resultPubkey: string,
): PositionRecord {
  const topUpUsd = rebalanceParams.topUpUsd ?? 0;
  const scaled = applyCompoundToCostBasis({
    depositedUsd: pos.depositedUsd,
    currentValueUsd: pos.currentValueUsd,
    highestValueUsd: pos.highestValueUsd,
    compoundedFeesUsd: topUpUsd,
  });
  return {
    ...pos,
    ...scaled,
    entryAmountXUsd:
      pos.launchRunner === true ? (pos.entryAmountXUsd ?? 0) + topUpUsd : pos.entryAmountXUsd,
    positionId: resultPubkey,
    positionPubKey: resultPubkey,
    lowerBinId: rebalanceParams.newLowerBinId,
    upperBinId: rebalanceParams.newUpperBinId,
    ...(rebalanceParams.topUp !== undefined
      ? {
          launchRunnerAnchorPrice: currentPrice,
          launchRunnerSteps: (pos.launchRunnerSteps ?? 0) + 1,
        }
      : undefined),
    lastFeeClaimAt: Date.now(),
    lastRebalanceAt: Date.now(),
  };
}

function claimPreRebalanceFees(
  deps: LiveExecDeps,
  decision: AgentDecision,
  pool: LiveExecPool,
  pos: PositionRecord,
  positionPubKey: string,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const revenueConfigResult = yield* deps.revenueConfigSvc.getConfig();
    // G4 economic harvest gate (rule: never spend $0.80 to realize
    // $1.00): skip the pre-rebalance fee claim when the PENDING net
    // fees don't clear the floor / cost gate. The rebalance itself
    // always completes — only the fee claim is skipped (it rides the
    // normal cadence path next scan). Fail open on unknown pending.
    let claimResult: Effect.Success<ReturnType<AdapterApi["claimFees"]>> | null = null;
    const rebalanceHarvestGate = yield* readRebalanceHarvestGate(
      deps,
      decision.poolAddress,
      positionPubKey,
    );
    if (rebalanceHarvestGate && !rebalanceHarvestGate.approved) {
      console.warn(
        `[harvest-gate] pre-rebalance claim skipped on ${decision.poolAddress}: ${rebalanceHarvestGate.reason}`,
      );
    } else {
      claimResult = yield* deps.adapter
        .claimFees(
          decision.poolAddress,
          positionPubKey,
          revenueConfigResult.platformFeeRate,
          revenueConfigResult.revenueShareEnabled,
          revenueConfigResult.revenueShareOperatorPct,
          revenueConfigResult.feeWalletAddress,
        )
        .pipe(Effect.catch(() => Effect.succeed(null)));
    }
    if (claimResult && (claimResult.feeX > 0 || claimResult.feeY > 0)) {
      yield* bookPreRebalanceClaim(
        deps,
        decision,
        pool,
        pos,
        positionPubKey,
        claimResult,
        revenueConfigResult.tier,
      );
    }
  });
}

/** Live REBALANCE: pre-claim, atomic reshape, defensive re-key on pubkey drift. */
function executeLiveRebalance(
  deps: LiveExecDeps,
  decision: AgentDecision,
  pool: LiveExecPool,
  rebalanceParams: NonNullable<AgentDecision["rebalanceParams"]>,
): Effect.Effect<{ executed: boolean; error: string | undefined }, never> {
  return Effect.gen(function* () {
    const pos = resolveTargetPosition(deps.trackedPositions, decision);
    if (!pos?.positionPubKey) {
      return { executed: false, error: "REBALANCE requires an existing live position" };
    }
    yield* claimPreRebalanceFees(deps, decision, pool, pos, pos.positionPubKey);
    const rebalanceResult = yield* attemptAtomicRebalance(
      deps,
      decision,
      pos.positionPubKey,
      rebalanceParams,
    );
    if (rebalanceResult.result) {
      const updated = buildRebalancedRecord(
        pos,
        pool.currentPrice,
        rebalanceParams,
        rebalanceResult.result.positionPubKey,
      );
      if (updated.positionId !== pos.positionId) {
        // Defensive re-key: the SDK preserves the account, but if the
        // pubkey ever changed, the identity and its row must move with it
        // — otherwise the stale row would linger as a phantom position.
        deps.trackedPositions.delete(pos.positionId);
        yield* persist(`deletePosition ${pos.positionId}`, deps.db.deletePosition(pos.positionId));
      }
      deps.trackedPositions.set(updated.positionId, updated);
      yield* persist(`savePosition ${updated.positionId}`, deps.db.savePosition(updated));
      yield* deps.db
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
            newLowerBinId: rebalanceParams.newLowerBinId,
            newUpperBinId: rebalanceParams.newUpperBinId,
            txSignatures: rebalanceResult.result.txSignatures,
          },
          createdAt: Date.now(),
        })
        .pipe(Effect.catch(() => Effect.void));
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
  });
}

/**
 * Run the on-chain close when a live pubkey exists; a position without one
 * is already gone, so the EXIT marks done with no chain action.
 */
function runExitOrMarkExited(
  deps: LiveExecDeps,
  decision: AgentDecision,
  pos: PositionRecord | undefined,
  exitOperation: ExecutionOperationRecord | null,
) {
  if (!pos?.positionPubKey) {
    return Effect.succeed({ exited: true, exitError: undefined, exitResultData: null });
  }
  return runLiveExitPosition(deps, decision, pos, pos.positionPubKey, exitOperation);
}

/** Validated attribution inputs: every leg present, chain attribution owns the EXIT. */
interface LiveAttributionInputs {
  readonly autonomous: AutonomousExecutionContext;
  readonly pos: PositionRecord;
  readonly exitResultData: LiveExitResultData;
  readonly tokenX: string;
  readonly tokenY: string;
}
function liveAttributionInputs(
  autonomous: AutonomousExecutionContext | null | undefined,
  pos: PositionRecord | undefined,
  exitResultData: LiveExitResultData | null,
  tokenX: string | undefined,
  tokenY: string | undefined,
): LiveAttributionInputs | null {
  if (
    autonomous == null ||
    pos === undefined ||
    exitResultData === null ||
    tokenX === undefined ||
    tokenY === undefined
  ) {
    return null;
  }
  return { autonomous, pos, exitResultData, tokenX, tokenY };
}

/** Live EXIT: rotation-arm gate, planned op, on-chain close, settlement/ledger paths. */
function executeLiveExit(
  deps: LiveExecDeps,
  decision: AgentDecision,
  pool: LiveExecPool,
): Effect.Effect<{ executed: boolean; error: string | undefined }, never> {
  return Effect.gen(function* () {
    const rotationBlocked = yield* isExitRotationBlocked(deps, decision);
    if (rotationBlocked) {
      return { executed: false, error: "rotation canceled — incumbent preserved" };
    }
    const pos = resolveTargetPosition(deps.trackedPositions, decision);
    const planned = yield* planLiveExitOperation(deps, decision, pool, pos);
    if (planned.fatalError) {
      return { executed: false, error: planned.fatalError };
    }
    const exitRun = yield* runExitOrMarkExited(deps, decision, pos, planned.exitOperation);
    const exited = exitRun.exited;
    const exitError = exitRun.exitError;
    const exitResultData = exitRun.exitResultData;
    if (!exited) {
      return { executed: false, error: exitError };
    }
    const autonomous = deps.autonomous;
    const attribution = liveAttributionInputs(
      autonomous,
      pos,
      exitResultData,
      pool.tokenX,
      pool.tokenY,
    );
    if (attribution) {
      const settled = yield* settleLiveExitAttribution(
        deps,
        decision,
        pool,
        attribution.pos,
        attribution.exitResultData,
        attribution.tokenX,
        attribution.tokenY,
        attribution.autonomous,
      );
      if (settled.fatal) {
        return { executed: false, error: settled.fatal };
      }
      return { executed: true, error: undefined };
    }
    if (pos) {
      const computed = computeLedgerExitRealized(pos, exitResultData);
      yield* creditExitSweep(deps, decision, pool, pos, exitResultData);
      yield* finalizeLiveExitLedger(
        deps,
        decision,
        pool,
        pos,
        exitResultData,
        computed.realizedPnlUsd,
        computed.pricingUnresolved,
      );
    }
    return { executed: true, error: undefined };
  });
}

/**
 * Live ENTER pipeline: plan → SOL gate → fund → execute, fail-fast on the
 * first fatal gate (the planned row is failed-closed inside each gate).
 */
function executeLiveEnterPipeline(
  deps: LiveExecDeps,
  decision: AgentDecision,
  pool: LiveExecPool,
  signalTimestamp: number | undefined,
  signalSnapshotId: number | undefined,
): Effect.Effect<{ executed: boolean; error: string | undefined }, never> {
  return Effect.gen(function* () {
    const planned = yield* planLiveEntryOperation(deps, decision, pool.tokenX);
    if (planned.fatalError) {
      return { executed: false, error: planned.fatalError };
    }
    const gated = yield* checkLiveEntrySolGate(deps, decision, deps.solPriceUsd, planned.operation);
    if (gated.fatalError) {
      return { executed: false, error: gated.fatalError };
    }
    const funded = yield* prepareLiveEntryTokens(
      deps,
      decision,
      deps.runnerSingleSidedX,
      planned.operation,
    );
    if (funded.fatalError) {
      return { executed: false, error: funded.fatalError };
    }
    return yield* executeLiveEnterPosition(
      deps,
      decision,
      pool,
      deps.entryStrategySpec,
      deps.entryRangeHalfWidth,
      deps.entryDipOffsetBins,
      deps.runnerSingleSidedX,
      signalTimestamp,
      signalSnapshotId,
      funded.preparation,
      planned.operation,
    );
  });
}

export function executeLive(
  deps: {
    adapter: AdapterApi;
    strategy: StrategyApi;
    db: DbApi;
    revenueConfigSvc: RevenueConfigApi;
    trackedPositions: Map<string, PositionRecord>;
    entryPrep: EntryPrepApi;
    solPriceUsd: number;
    entryStrategySpec: EntryStrategySpec;
    entryRangeHalfWidth?: number;
    entryDipOffsetBins?: number;
    runnerSingleSidedX?: boolean;
    reconcileRequestedPools?: Set<string>;
    memory?: MemoryApi;
    unpricedExitWarnedPools?: Set<string>;
    autonomous?: AutonomousExecutionContext;
    candidateId?: string;
    /** G2 rotation-arm + yield-baseline wiring (market-runner lane). */
    rotationArmMs?: number;
    runnerMinFeeApr?: number;
    entryAprPct?: number;
    poolAprByAddress?: ReadonlyMap<string, { feeAprPct: number; tvlUsd: number }>;
    /** G4 economic harvest gate values (executors have no AppConfig). */
    harvestMinNetUsd?: number;
    harvestMaxCostPct?: number;
    harvestTxCostUsdEst?: number;
    /** Rug detection: arm `token_rug_block` on a catastrophic realized loss. */
    rugExitLossPct?: number;
    rugTokenBlockMs?: number;
    stablecoinMints?: ReadonlySet<string>;
  },
  decision: AgentDecision,
  pool: {
    activeBinId: number;
    binStep: number;
    tokenXSymbol: string;
    tokenYSymbol: string;
    tokenX?: string;
    tokenY?: string;
    currentPrice: number;
  },
  signalTimestamp?: number,
  signalSnapshotId?: number,
): Effect.Effect<{ executed: boolean; error: string | undefined }, never, never> {
  return Effect.gen(function* () {
    if (!deps.adapter.hasWallet()) {
      console.error("Live trading enabled but no wallet configured");
      return { executed: false, error: "Live trading enabled but no wallet configured" };
    }
    if (decision.action === "ENTER" && decision.positionSizeUsd) {
      return yield* executeLiveEnterPipeline(
        deps,
        decision,
        pool,
        signalTimestamp,
        signalSnapshotId,
      );
    }
    if (decision.action === "ENTER") {
      return { executed: false, error: "ENTER decision missing position size" };
    }
    if (decision.action === "EXIT") {
      return yield* executeLiveExit(deps, decision, pool);
    }
    if (decision.action === "REBALANCE" && decision.rebalanceParams) {
      return yield* executeLiveRebalance(deps, decision, pool, decision.rebalanceParams);
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
    // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
    lastAction: (p.lastRebalanceAt > p.timestamp ? "REBALANCE" : "ENTER") as
      | "ENTER"
      | "EXIT"
      | "REBALANCE"
      | "HOLD",
    lastActionAt: p.lastRebalanceAt > p.timestamp ? p.lastRebalanceAt : p.timestamp,
    hoursHeld: (Date.now() - p.timestamp) / 3_600_000,
  }));

/**
 * One-time legacy raw-price → real-price backfill. `getPoolState` now reports
 * `pricePerToken` (real human price); legacy rows stored the raw geometric
 * `pricePerLamport` (SOL/USDC showed ~0.0758 instead of ~$76). Each pool's
 * stored prices are rescaled by its per-pool constant (pricePerToken / price)
 * exactly once. FAIL-CLOSED: every factor must resolve (one RPC failure fails
 * the program before the scan loop starts — the engine must never evaluate a
 * position with raw `entry_price_usd` against real `currentPrice`, which would
 * fabricate a ~1000x HODL/IL signal), then ONE transaction applies the rescale
 * + flag so a crash mid-apply rolls back and the next startup retries.
 */
const PRICE_SCALE_FACTOR_PREFIX = "price_scale_factor:";

function priceScaleFactorKey(poolAddress: string): string {
  return `${PRICE_SCALE_FACTOR_PREFIX}${poolAddress}`;
}

function runPriceScaleBackfill(db: DbApi, adapter: AdapterApi): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const applied = yield* db.getMetadata(PRICE_SCALE_MIGRATION_KEY);
    if (applied === "applied") return;

    const positions = yield* db.getAllPositions();
    const snapshotPools = yield* db.getSnapshotPools();
    const pools = collectBackfillPools(positions, snapshotPools);

    // Resolve each pool's scale factor, reusing the persistent per-pool cache so
    // a transient RPC failure on one pool never discards the factors already
    // resolved for the rest (progress survives restarts). The factor is a
    // per-pool constant (token decimals), so caching it is exact.
    const updates: Array<{ poolAddress: string; factor: number }> = [];
    for (const pool of pools) {
      updates.push({
        poolAddress: pool,
        factor: yield* resolveBackfillFactor(db, adapter, pool),
      });
    }

    const result = db.applyPriceScaleMigration
      ? yield* db.applyPriceScaleMigration(updates)
      : { positions: 0, snapshots: 0 };
    if (result.positions > 0 || result.snapshots > 0) {
      logger.warn("Price-scale backfill applied (legacy raw prices rescaled to real)", {
        pools: pools.size,
        positions: result.positions,
        snapshots: result.snapshots,
      });
    }
  });
}

/**
 * Reconcile paper-exited rows from a previous paper-trading run into live mode:
 * live-identity rows are kept (so the engine will not re-enter a pool whose
 * on-chain position is still open), paper-only rows are deleted.
 */
function cleanupLegacyPaperPositions(
  config: AppConfig,
  db: DbApi,
  trackedPositions: Map<string, PositionRecord>,
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    if (config.paperTrading) return;
    const paperExited = yield* db
      .getPaperExitedPositions()
      .pipe(Effect.catch(() => Effect.succeed([])));
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
          yield* persist(`deletePosition ${pos.positionId}`, db.deletePosition(pos.positionId));
        }
      }
    }

    for (const [positionId, pos] of trackedPositions) {
      if (!pos.positionPubKey) {
        trackedPositions.delete(positionId);
        yield* persist(`deletePosition ${positionId}`, db.deletePosition(positionId));
      }
    }
  });
}

function loadPersistedCandidates(
  config: AppConfig,
  db: DbApi,
  walletAddress: string,
  candidates: Map<string, TokenCandidateRecord>,
  candidatePools: Set<string>,
  candidatePoolAddresses: Set<string>,
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    if (config.autonomousTokenMode === "off") return;
    const persistedCandidates = yield* db
      .listTokenCandidates(walletAddress, config.agentInstanceId)
      .pipe(Effect.catch(() => Effect.succeed([])));
    for (const candidate of persistedCandidates) {
      candidates.set(candidate.id, candidate);
      candidatePools.add(candidate.poolAddress);
      candidatePoolAddresses.add(candidate.poolAddress);
    }
  });
}

/**
 * Opt-in one-shot discovery (ENABLE_POOL_DISCOVERY, non-market-scan mode):
 * top-3 screened candidates extend the watchlist. A discovery-transport error
 * falls back to watchlist-only mode; any other error propagates so the cycle
 * fails loudly instead of masking bugs as an empty discovery result.
 */
function loadDiscoveryPools(
  config: AppConfig,
  screener: ScreenerApi,
  poolsToScan: Array<string>,
): Effect.Effect<void, Error, never> {
  return Effect.gen(function* () {
    if (!shouldDiscoverPools(config) && config.enablePoolDiscovery) {
      logger.warn(
        "Live pool discovery is disabled; configure WATCHLIST_POOLS for approved pools.",
        {
          paperTrading: config.paperTrading,
        },
      );
    }
    if (!shouldDiscoverPools(config) || config.autonomousTokenMode !== "off") return;
    const screened = yield* screener.screenPools().pipe(
      Effect.catch((err) => {
        if (
          err instanceof DiscoverPoolsError ||
          // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
          (err as { _tag?: string })?._tag === "DiscoverPoolsError"
        ) {
          console.warn(
            "Pool discovery failed; falling back to watchlist-only mode:",
            err instanceof Error ? err.message : String(err),
          );
          // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
          return Effect.succeed([] as ReadonlyArray<ScreenedPool>);
        }
        // Non-discovery error: let it propagate so the cycle fails loudly
        // instead of silently masking bugs as an empty discovery result.
        return Effect.fail(err);
      }),
    );
    if (screened.length === 0) return;
    console.info(`Discovered ${screened.length} candidate pools`);
    for (const pool of screened.slice(0, 3)) {
      console.info(`  Candidate: ${pool.address} (fee/IL: ${pool.feeIlRatio.toFixed(2)})`);
      if (!poolsToScan.includes(pool.address)) {
        poolsToScan.push(pool.address);
      }
    }
  });
}

function launchGateConfig(config: AppConfig, now: number): LaunchGateConfig {
  return {
    minTvlUsd: config.launchScanMinTvlUsd ?? 5_000,
    maxTvlUsd: config.launchScanMaxTvlUsd ?? 1_000_000,
    maxAgeHours: config.launchScanMaxAgeHours ?? 6,
    minVolume1hUsd: config.launchScanMinVolume1hUsd ?? 50_000,
    minBaseFeePct: config.launchScanMinBaseFeePct ?? 1,
    minBinStep: config.launchScanMinBinStep ?? 50,
    maxBinStep: config.launchScanMaxBinStep ?? 200,
    maxVolumeTurnover: 50,
    minHolders: 1000,
    stablecoinMints: config.stablecoinMints ?? new Set<string>(),
    now,
  };
}

/**
 * Launch Mode v2 wash forensics: per-pool evidence fetched during the radar
 * refresh (one Helius call per admitted pool) and consumed by the launch
 * ENTER gate. Stale evidence must not outlive its pool: a pool that left the
 * top-K, or a refresh whose fetch failed (null), drops its entry — otherwise
 * an old suspicious flag would gate ENTER forever. Fail-open: evidence for
 * pools beyond the fetch width stays undefined.
 */
function refreshWashEvidence(
  config: AppConfig,
  adapter: AdapterApi,
  ranked: ReadonlyArray<LaunchPoolRank>,
  washEvidenceByPool: Map<string, WashEvidence>,
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    if (config.launchWashForensicsEnabled !== true) return;
    if (adapter.getPoolWashEvidence === undefined) return;
    washEvidenceByPool.clear();
    // Bound both the fetch WIDTH (top-30 by fee yield — the pools most
    // likely to reach ENTER; evidence for the rest fails open) and the
    // CONCURRENCY (5): 200 pools at unbounded concurrency would burst
    // the Helius rate tier and 429 everything to null.
    const topK = ranked.slice(0, Math.min(config.launchScanTopK ?? 30, 30));
    const evidences = yield* Effect.forEach(
      topK,
      (r) =>
        adapter.getPoolWashEvidence!(r.pool.address).pipe(Effect.catch(() => Effect.succeed(null))),
      { concurrency: 5 },
    );
    for (let i = 0; i < topK.length; i++) {
      const evidence = evidences[i];
      if (evidence !== null && evidence !== undefined) {
        washEvidenceByPool.set(topK[i]!.pool.address, evidence);
      }
    }
  });
}

export const program = Effect.gen(function* () {
  const config = yield* ConfigService;
  const adapter = yield* AdapterService;
  const executionWalletAddress = adapter.getWalletAddress();
  const autonomousExecution: AutonomousExecutionContext | null = resolveAutonomousExecution(
    config,
    executionWalletAddress,
  );
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
  const gecko = yield* GeckoTerminalService;
  // DexScreener is an optional resilience fallback (mirrors the optional
  // CopySignalService): layers that don't provide it (e.g. older test fixtures)
  // still scan normally — the service handle is only used when a pool actually
  // needs the dexscreener fallback and the layer provided it.
  const dexscreenerOption = yield* Effect.serviceOption(DexScreenerService);
  const alertSvc = yield* AlertService;
  const copySignalsOption = yield* Effect.serviceOption(CopySignalService);

  // Rescale legacy raw prices to real units exactly once BEFORE positions are
  // loaded into memory, so trackedPositions sees the same real prices the DB
  // now holds (idempotent, all-or-nothing; see runPriceScaleBackfill).
  yield* runPriceScaleBackfill(db, adapter);

  // Load persisted positions at startup (keyed by position identity — a pool
  // may hold several positions).
  const allPositions = yield* db.getAllPositions().pipe(Effect.catch(() => Effect.succeed([])));
  const trackedPositions = new Map<string, PositionRecord>();
  for (const pos of allPositions) {
    trackedPositions.set(pos.positionId, pos);
  }

  const entryFailureBackoff = new Map<string, EntryFailureBackoff>();
  let activeSafetyPause =
    autonomousExecution === null
      ? null
      : yield* db
          .getSafetyPause(autonomousExecution.walletAddress, autonomousExecution.agentInstanceId)
          .pipe(Effect.catch(() => Effect.succeed(null)));
  let consecutiveCoreDataFailures = 0;
  let consecutiveExecutionFailures = 0;
  // Execution failures recorded in the CURRENT scan cycle (reset at cycle
  // start) — the recovery signal for the issue #182 execution_failures
  // pause auto-resolution: while the pause blocks ENTER/REBALANCE the
  // consecutive counter cannot decay on its own, so a quiet cycle is what
  // proves the spike passed.
  let executionFailuresThisCycle = 0;
  let coreDataFailuresThisCycle = 0;
  // Regime-gate verdict for the CURRENT cycle, recomputed at the top of
  // runScanCycle (module scope: the ENTER gate chain lives in a sibling
  // function). Advisory-only — see the runScanCycle block for semantics.
  let cycleHerdingBlock = false;
  const dailyBaselineScope = {
    walletAddress: resolveCandidateWallet(executionWalletAddress),
    agentInstanceId: config.agentInstanceId,
  };
  const dailyBaseline = yield* loadDailyEquityBaseline(db, dailyBaselineScope);
  let dailyBaselineDay = dailyBaseline.day;
  let dailyBaselineEquityUsd = dailyBaseline.equityUsd;
  let dailyDrawdownPct = 0;

  // Agent check-in state
  const programStartTime = Date.now();
  let scanCount = 0;
  let lastAgentCheckinAt = 0;
  let lastWalletBalanceUsd = config.paperPortfolioUsd;
  // False until the first SUCCESSFUL live chain wallet read. The session-local
  // seed (config.paperPortfolioUsd, default $10,000) is fictional for live mode;
  // this flag keeps it from ever authorizing a live entry during an RPC outage
  // before any real balance is known.
  let walletEverReadSuccessfully = false;
  // Set when a post-transaction wallet re-read FAILS after a successful LIVE
  // ENTER: trackedPositions already holds the new position while the cycle-top
  // balance still includes the deployed capital, so the next pool would
  // double-count (wallet + position) and could authorize exposure above the
  // allocation cap. Blocks all further entries for the rest of the cycle;
  // reset at the top wallet read every cycle. EXIT-origin failures do NOT set
  // it (a stale balance under-counts → gates tighten → the safe direction).
  let liveEntriesBlockedRestOfCycle = false;
  // Issue #170: per-cycle native-SOL budget for SOL-funded (autonomous
  // canary/live) entries. Read once at cycle start; each live ENTER commits
  // its estimated SOL cost and is refreshed from chain after every live
  // ENTER/EXIT attempt. When unknown (read failed), the gate skips entries
  // fail-closed — never commit SOL the engine cannot confirm exists.
  let entrySolBudgetLamports = 0n;
  let entrySolBudgetKnown = false;
  // Live SOL price the estimate keys off (0 = unknown → budget unknown →
  // entries skipped fail-closed). Set together with the budget at cycle start.
  let entrySolPriceUsd = 0;
  // SOL-funded entries (autonomous canary/live) buy pool-token deficits with
  // SOL swaps; plain live entries are USDC-funded and only need SOL for gas,
  // which the top-up mechanism handles per entry. The batch reserve gate
  // applies only to the SOL-funded mode (the issue #170 drain scenario).
  const solFundedEntryMode = isSolFundedEntryMode(config.autonomousTokenMode);
  const recordExecutionOutcome = (executed: boolean): void => {
    consecutiveExecutionFailures = executed ? 0 : consecutiveExecutionFailures + 1;
    if (!executed) executionFailuresThisCycle++;
  };

  // Token-level breaker: a genuine live EXIT failure arms `token_block:<mint>`
  // and a catastrophic realized loss (rug/drain) arms `token_rug_block:<mint>`.
  // Every ENTER gate checks both legs against active blocks, so a broken exit
  // route or a drained token blocks new deployment into that TOKEN (any pool
  // holding it), not just into the pool that failed/rugged. Both keys store an
  // EXPIRY timestamp (now + window) so each block reason can carry its own
  // window (failure = tokenFailureBlockMs, rug = rugTokenBlockMs). Reads fail
  // open (null on error) — a broken read must never freeze entry; a set block
  // fails closed.
  const findBlockedToken = (pool: {
    readonly tokenX: string;
    readonly tokenY: string;
  }): Effect.Effect<{ mint: string; kind: "execution-failure" | "rug" } | null, never> =>
    Effect.gen(function* () {
      const now = Date.now();
      for (const mint of [pool.tokenX, pool.tokenY]) {
        const failureRaw = yield* db
          .getMetadata(`token_block:${mint}`)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (failureRaw !== null && now < Number(failureRaw)) {
          return { mint, kind: "execution-failure" };
        }
        const rugRaw = yield* db
          .getMetadata(`token_rug_block:${mint}`)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (rugRaw !== null && now < Number(rugRaw)) {
          return { mint, kind: "rug" };
        }
      }
      return null;
    });
  let lastSnapshotPruneAt = 0;

  // F2: per-pool recent active-bin history (in-memory ring buffer; resets on restart)
  const binHistoryCap = Math.max(
    config.volatilityLookbackSnapshots,
    config.oorRecoveryLookbackCycles,
    2,
  );
  const binHistory = new Map<string, number[]>();
  // Latest bin step per pool (regime-gate needs it to convert bin deltas into
  // price-return space; refreshed alongside the bin history).
  const binStepByAddress = new Map<string, number>();
  // Issue #196 follow-up: route-probe results cache. The autonomous-candidate
  // refresh probes every non-SOL candidate mint in both directions (SOL→token
  // and token→SOL) with FIXED probe amounts — identical requests repeated
  // every cycle, up to ~80 quote calls per cycle (the dominant Jupiter
  // traffic term, ~70% of the self-inflicted keyless rate-limit pressure).
  // Successful probes are cached for one scan interval (min 10 min): route
  // availability is stable, and a miss only re-probes. Failures are NOT
  // cached — during a Jupiter 429 cooldown the gate fails them fast with
  // zero network, so a transient ban can never poison route availability.
  const routeProbeResults = new Map<string, { available: boolean; expiresAt: number }>();
  const routeProbeCacheTtlMs = Math.max(config.scanIntervalMs, 10 * 60_000);
  const readRouteProbeCache = (key: string): boolean | null => {
    const entry = routeProbeResults.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt > Date.now()) return entry.available;
    routeProbeResults.delete(key);
    return null;
  };
  const pruneRouteProbeCache = (): void => {
    // Discovery keeps finding new mints; without a sweep, expired entries for
    // old mints would accumulate for the process lifetime.
    const now = Date.now();
    for (const [key, entry] of routeProbeResults) {
      if (entry.expiresAt <= now) routeProbeResults.delete(key);
    }
  };
  const writeRouteProbeCache = (key: string, available: boolean): void => {
    if (available) {
      routeProbeResults.set(key, { available, expiresAt: Date.now() + routeProbeCacheTtlMs });
    }
  };
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
      .pipe(Effect.catch(() => Effect.succeed(null)));
    const today = todayIso();
    if (lastDay === today) return 0;
    const stored = yield* db
      .getMetadata(PAPER_DAYS_KEY)
      .pipe(Effect.catch(() => Effect.succeed("0")));
    const current = Number(stored) || 0;
    const next = current + 1;
    yield* db
      .setMetadataBatch([
        { key: PAPER_DAYS_KEY, value: String(next) },
        { key: PAPER_DAYS_LAST_KEY, value: today },
      ])
      .pipe(Effect.catch(() => Effect.void));
    if (next % 7 === 0) {
      console.info(`[paper-validation] ${next} paper days accumulated`);
    }
    return next;
  });

  const readPaperDays = Effect.gen(function* () {
    const stored = yield* db
      .getMetadata(PAPER_DAYS_KEY)
      .pipe(Effect.catch(() => Effect.succeed("0")));
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
    const stored = yield* db.getEvolvedThresholds().pipe(Effect.catch(() => Effect.succeed(null)));
    if (stored) {
      evolvedThresholds = stored;
    }
  });

  yield* loadEvolvedThresholds;

  const tryEvolveThresholds = Effect.gen(function* () {
    const countStr = yield* db
      .getMetadata(EVOLUTION_COUNT_KEY)
      .pipe(Effect.catch(() => Effect.succeed("0")));
    const count = Number(countStr) || 0;

    if (count < config.evolutionInterval) return;

    const outcomes = yield* db
      .getClosedPositionOutcomes(1000)
      .pipe(Effect.catch(() => Effect.succeed([])));

    const result = evolveThresholds(outcomes, evolvedThresholds, {
      maxChangePct: config.evolutionMaxChangePct,
      minOutcomes: config.evolutionInterval,
    });

    if (result.changed) {
      evolvedThresholds = result.thresholds;
      yield* db.saveEvolvedThresholds(result.thresholds).pipe(Effect.catch(() => Effect.void));
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
        yield* db.saveSignalWeights(newWeights).pipe(Effect.catch(() => Effect.void));
        console.info("[signal-weights] Recomputed weights", {
          feeIlRatio: newWeights.feeIlRatio.toFixed(3),
          volumeAuthenticity: newWeights.volumeAuthenticity.toFixed(3),
          binUtilization: newWeights.binUtilization.toFixed(3),
          tvlUsd: newWeights.tvlUsd.toFixed(3),
          tvlVelocity: newWeights.tvlVelocity.toFixed(3),
        });
      }
    }
    yield* db.setMetadata(EVOLUTION_COUNT_KEY, "0").pipe(Effect.catch(() => Effect.void));
  });

  const incrementEvolutionCount = Effect.gen(function* () {
    const countStr = yield* db
      .getMetadata(EVOLUTION_COUNT_KEY)
      .pipe(Effect.catch(() => Effect.succeed("0")));
    const count = Number(countStr) || 0;
    yield* db
      .setMetadata(EVOLUTION_COUNT_KEY, String(count + 1))
      .pipe(Effect.catch(() => Effect.void));
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
    const stored = yield* db.getSignalWeights().pipe(Effect.catch(() => Effect.succeed(null)));
    if (stored) {
      signalWeights = stored;
    }
  });

  yield* loadSignalWeights;

  yield* cleanupLegacyPaperPositions(config, db, trackedPositions);

  // ─── Pool discovery ────────────────────────────────────────────────────────

  let poolsToScan = [...config.watchlistPools];
  const autonomousCandidateWallet = resolveCandidateWallet(executionWalletAddress);
  const autonomousCandidates = new Map<string, TokenCandidateRecord>();
  const autonomousCandidatePools = new Set<string>();
  // Fallen-angel candidates (Wave 19): pools that cleared the fallen-angel
  // gate (RugCheck security + GeckoTerminal drawdown/vol). Opt-in, inert when
  // FALLEN_ANGEL_ENABLED is off. `fallenAngelSignals` carries the per-pool
  // qualification so the ENTER gate can re-confirm without re-fetching.
  const fallenAngelCandidatePools = new Set<string>();
  const fallenAngelSignals = new Map<
    string,
    { readonly assetMint: string; readonly drawdownPct: number }
  >();
  const autonomousCandidatePoolAddresses = new Set<string>();

  yield* loadPersistedCandidates(
    config,
    db,
    autonomousCandidateWallet,
    autonomousCandidates,
    autonomousCandidatePools,
    autonomousCandidatePoolAddresses,
  );

  yield* loadDiscoveryPools(config, screener, poolsToScan);

  const approvedPoolAddresses = [...poolsToScan];
  let unresolvedPoolAddresses = new Set<string>();
  // Pools whose atomic rebalance failed mid-execution — re-read on-chain
  // state at the next cycle's reconcile before deciding again.
  const reconcileRequestedPools = new Set<string>();
  // Pools already warned about an unpriced EXIT this session, so the warning
  // + memory entry fire once per pool instead of every cycle.
  const unpricedExitWarnedPools = new Set<string>();
  // Paper notional-fee accrual clock: positionId → last accrual timestamp.
  // Session-local (no schema change) so a restart re-establishes the first
  // cycle as the baseline; downtime catch-up is capped at 2× scan interval.
  const paperFeeAccrualAt = new Map<string, number>();
  // Trailing-stop phantom-EXIT guard (#153): consecutive cycles the drawdown
  // has breached the stop. EXIT fires only after the breach persists for
  // TRAILING_STOP_CONFIRM_CYCLES cycles, so a single noisy snapshot read
  // (unstable tracked-peak / value) cannot trigger EXIT churn. Session-local.
  const trailingStopBreachCount = new Map<string, number>();

  // ─── Market-scan state (universe-driven trading, no manual watchlist) ────
  // The ranked universe snapshot from the last gate refresh, the addresses of
  // the top-K pools actively scanned this cycle, and the last refresh time.
  // When MARKET_SCAN_ENABLED, the watchlist is an OPTIONAL overlay: the
  // active set is rebuilt each cycle from these + eligible candidates + held
  // positions (exits must never stall).
  let marketRankedPools: ReadonlyArray<MarketPoolRank> = [];
  let lastMarketRefreshAt = 0;
  const marketScanPools = new Set<string>();
  // Per-cycle fee APR (fees24h × 365 / tvl) keyed by pool address, populated
  // during each pool's evaluation. The market-runner rotation compares a
  // candidate runner's APR against the LOWEST-APR held position's APR.
  const poolFeeAprByAddress = new Map<string, { feeAprPct: number; tvlUsd: number }>();
  // Dispatch-deps builders shared by the in-slot tail and the idle-redeploy
  // pass: the executor wiring (entry APR, rotation arm, runner floor, harvest
  // values) must not drift between lanes. exactOptionalPropertyTypes-safe.
  const runnerDispatchDeps = (poolAddress: string) => {
    const entryAprPct = poolFeeAprByAddress.get(poolAddress)?.feeAprPct;
    return {
      ...(entryAprPct !== undefined ? { entryAprPct } : undefined),
      poolAprByAddress: poolFeeAprByAddress,
      ...(config.marketScanRotationArmMs !== undefined
        ? { rotationArmMs: config.marketScanRotationArmMs }
        : undefined),
      ...(config.marketScanRunnerMinFeeApr !== undefined
        ? { runnerMinFeeApr: config.marketScanRunnerMinFeeApr }
        : undefined),
    };
  };
  const harvestDispatchDeps = () => ({
    ...(config.harvestMinNetUsd !== undefined
      ? { harvestMinNetUsd: config.harvestMinNetUsd }
      : undefined),
    ...(config.harvestMaxCostPct !== undefined
      ? { harvestMaxCostPct: config.harvestMaxCostPct }
      : undefined),
    ...(config.harvestTxCostUsdEst !== undefined
      ? { harvestTxCostUsdEst: config.harvestTxCostUsdEst }
      : undefined),
  });
  const rugDispatchDeps = () => ({
    ...(config.rugExitLossPct !== undefined
      ? { rugExitLossPct: config.rugExitLossPct }
      : undefined),
    ...(config.rugTokenBlockMs !== undefined
      ? { rugTokenBlockMs: config.rugTokenBlockMs }
      : undefined),
    ...(config.stablecoinMints !== undefined
      ? { stablecoinMints: config.stablecoinMints }
      : undefined),
  });

  // ─── Launch-mode execution state (Launch Mode v2) ────────────────────────
  // The launch radar's admitted pool set, populated by refreshLaunchScan ONLY
  // when both launchScanEnabled AND launchExecutionEnabled are on (the default
  // path never fills it, so the scan loop and ENTER gates below stay
  // behavior-identical). Launch pools ride the FULL existing gate chain —
  // blacklist/freeze/token-risk, metrics, pre-filter, risk tail — plus the
  // launch-specific ENTER criteria.
  const launchScanPools = new Set<string>();
  // Wash forensics: per-pool evidence fetched during the radar refresh
  // (one Helius call per admitted pool) and consumed by the launch ENTER
  // gate. Stale-by-one-refresh is fine — the evidence is a trend signal.
  const washEvidenceByPool = new Map<string, WashEvidence>();
  // In-memory per-position peak 1h fees (USD) for the volume-decay exit.
  // Session-local by design: a restart resets it and the time-box exit
  // backstops the gap (contract: no persistence for the peak tracker).
  const launchPeakFees1h = new Map<string, number>();

  // Rebuild the active scan set: the approved (watchlist) snapshot, the
  // market-scan top-K (ranked by the freshest gate), eligible autonomous
  // candidates and fallen-angel candidates. Called after every reconcile AND
  // right after the market universe refresh so a fresh gate is never blocked
  // by a stale set.
  const rebuildPoolsToScan = (): void => {
    poolsToScan = [...approvedPoolAddresses];
    for (const poolAddress of marketScanPools) {
      if (!poolsToScan.includes(poolAddress)) poolsToScan.push(poolAddress);
    }
    for (const poolAddress of autonomousCandidatePools) {
      if (!poolsToScan.includes(poolAddress)) poolsToScan.push(poolAddress);
    }
    for (const poolAddress of fallenAngelCandidatePools) {
      if (!poolsToScan.includes(poolAddress)) poolsToScan.push(poolAddress);
    }
    // Launch pools (Launch Mode v2): empty unless BOTH launchScanEnabled and
    // launchExecutionEnabled are on, so the default path is unchanged.
    for (const poolAddress of launchScanPools) {
      if (!poolsToScan.includes(poolAddress)) poolsToScan.push(poolAddress);
    }
  };
  const refreshPoolsToScan = (reconcileResult: PositionReconcileResult) => {
    unresolvedPoolAddresses = new Set(reconcileResult.unresolvedPoolAddresses);
    rebuildPoolsToScan();
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

  const refreshAutonomousCandidates = (scanOrdinal: number): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      if (config.autonomousTokenMode === "off") return;
      // Market-scan mode replaces the rotating single-page discovery with the
      // ranked universe snapshot (refreshed on MARKET_SCAN_REFRESH_INTERVAL_MS),
      // so candidates always mirror the freshest gate — no manual whitelist.
      const screened: ReadonlyArray<ScreenedPool> =
        config.marketScanEnabled === true && marketRankedPools.length > 0
          ? marketRankedPools.slice(0, config.candidateScanLimit).map((rank) => ({
              address: rank.pool.address,
              tvlUsd: rank.pool.tvlUsd,
              volume24hUsd: rank.pool.volume24hUsd,
              fees24hUsd: rank.pool.fees24hUsd,
              apr: rank.pool.apr,
              // Same convention as the screener: annualized fee/TVL.
              feeIlRatio: rank.feeAprPct / 100,
              volumeAuth: 1,
              binUtilization: 0,
              tokenX: rank.pool.tokenX,
              tokenY: rank.pool.tokenY,
              ...(rank.pool.createdAtMs === undefined
                ? undefined
                : { createdAtMs: rank.pool.createdAtMs }),
            }))
          : yield* screener.screenPools(scanOrdinal).pipe(
              Effect.catch((error) => {
                logger.warn("Autonomous candidate discovery failed", {
                  error: String(error),
                });
                // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
                return Effect.succeed([] as ReadonlyArray<ScreenedPool>);
              }),
            );
      const now = Date.now();
      function settleCoolingCandidates(now: number): Effect.Effect<void, never> {
        return Effect.gen(function* () {
          for (const candidate of autonomousCandidates.values()) {
            if (candidate.state === "cooling_down" && candidate.cooldownUntil !== null) {
              const advancedCandidate = transitionCandidate(
                candidate,
                { kind: "cooldown_elapsed", occurredAt: now },
                {
                  minHealthyScans: config.candidateMinHealthyScans,
                  minObservationMs: config.candidateMinObservationMs,
                },
              );
              if (advancedCandidate !== candidate) {
                autonomousCandidates.set(advancedCandidate.id, advancedCandidate);
                yield* db
                  .saveTokenCandidate(advancedCandidate)
                  .pipe(Effect.catch(() => Effect.void));
              }
            }
          }
        });
      }

      yield* settleCoolingCandidates(now);
      const candidatePools = screened
        .filter(
          (pool) =>
            config.candidateMinPoolAgeMs <= 0 ||
            (pool.createdAtMs !== undefined &&
              now - pool.createdAtMs >= config.candidateMinPoolAgeMs),
        )
        .slice(0, config.candidateScanLimit);
      const mints = [...new Set(candidatePools.flatMap((pool) => [pool.tokenX, pool.tokenY]))];
      const priceEvidence =
        adapter.getTokenPriceEvidence === undefined
          ? []
          : yield* adapter
              .getTokenPriceEvidence(mints)
              .pipe(Effect.catch(() => Effect.succeed([])));
      function fetchSolPriceUsd(): Effect.Effect<number, never> {
        return Effect.gen(function* () {
          const prices = yield* adapter
            .getTokenPrices([SOL_MINT], { useFallback: false })
            .pipe(Effect.catch(() => Effect.succeed<Record<string, number>>({})));
          return prices[SOL_MINT] ?? 0;
        });
      }

      function fetchProbeDecimals(nonSolMints: ReadonlyArray<string>) {
        return Effect.gen(function* () {
          const decimalsByMint = new Map<string, number>();
          for (const mint of nonSolMints) {
            const decimals = yield* adapter
              .getTokenDecimals(mint)
              .pipe(Effect.catch(() => Effect.succeed(null)));
            if (decimals !== null) decimalsByMint.set(mint, decimals);
          }
          return decimalsByMint;
        });
      }

      let routeAvailableMints = new Set<string>();
      if (adapter.quoteSwap !== undefined) {
        const quoteSwap = adapter.quoteSwap;
        const nonSolMints = mints.filter((mint) => mint !== SOL_MINT);
        const solPrice = yield* fetchSolPriceUsd();
        const tokenPrices = new Map(
          priceEvidence.map((evidence) => [evidence.mint, evidence.priceUsd]),
        );
        const decimalsByMint = yield* fetchProbeDecimals(nonSolMints);
        // Sweep expired route-probe cache entries once per refresh: discovery
        // keeps finding new mints, so without pruning expired keys would
        // accumulate for the process lifetime.
        pruneRouteProbeCache();
        const routeProbes = nonSolMints.map((mint) => {
          const tokenPrice = tokenPrices.get(mint) ?? 0;
          const decimals = decimalsByMint.get(mint);
          const solAtomic = routeProbeAmountAtomic(solPrice, 9);
          const tokenAtomic =
            decimals === undefined ? 0n : routeProbeAmountAtomic(tokenPrice, decimals);
          if (solAtomic === 0n || tokenAtomic === 0n) return Effect.succeed(false);
          const probeRoute = (
            direction: "sol-to-token" | "token-to-sol",
            quote: Effect.Effect<unknown, Error>,
          ): Effect.Effect<boolean, never> => {
            const key = `${direction}:${mint}`;
            const cached = readRouteProbeCache(key);
            if (cached !== null) return Effect.succeed(cached);
            // catchCause, not catch: a defect (e.g. a sync throw from a
            // malformed mint in the quote path) must degrade to "route
            // unavailable" for this probe, never fail the whole refresh.
            return quote.pipe(
              Effect.as(true),
              Effect.catchCause(() => Effect.succeed(false)),
              Effect.tap((available) => Effect.sync(() => writeRouteProbeCache(key, available))),
            );
          };
          return Effect.all(
            [
              probeRoute(
                "sol-to-token",
                quoteSwap({
                  inputMint: SOL_MINT,
                  outputMint: mint,
                  amountAtomic: solAtomic,
                  slippageBps: config.maxSwapSlippageBps,
                }),
              ),
              probeRoute(
                "token-to-sol",
                quoteSwap({
                  inputMint: mint,
                  outputMint: SOL_MINT,
                  amountAtomic: tokenAtomic,
                  slippageBps: config.maxSwapSlippageBps,
                }),
              ),
            ],
            { concurrency: 4 },
          ).pipe(Effect.map(([solToToken, tokenToSol]) => solToToken && tokenToSol));
        });
        const routeAvailableResults = yield* Effect.all(routeProbes, { concurrency: 4 });
        routeAvailableMints = collectRoutableMints(nonSolMints, routeAvailableResults);
      }
      const advanced = advanceScreenedCandidates({
        walletAddress: autonomousCandidateWallet,
        agentInstanceId: config.agentInstanceId,
        screenedPools: candidatePools,
        existingCandidates: Array.from(autonomousCandidates.values()),
        priceEvidence,
        routeAvailableMints,
        now: Date.now(),
        policy: {
          minHealthyScans: config.candidateMinHealthyScans,
          minObservationMs: config.candidateMinObservationMs,
        },
        maxMarketDataAgeMs: config.maxMarketDataAgeMs,
      });
      for (const candidate of advanced.updatedCandidates) {
        autonomousCandidatePoolAddresses.add(candidate.poolAddress);
        yield* db.saveTokenCandidate(candidate).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              autonomousCandidates.set(candidate.id, candidate);
            }),
          ),
          Effect.catch((error) =>
            Effect.sync(() => {
              logger.warn("Autonomous candidate persistence failed", {
                candidate: candidate.id,
                error: String(error),
              });
            }),
          ),
        );
      }
      autonomousCandidatePools.clear();
      for (const poolAddress of advanced.eligiblePoolAddresses) {
        autonomousCandidatePools.add(poolAddress);
        if (!poolsToScan.includes(poolAddress)) poolsToScan.push(poolAddress);
      }
    });

  // Fallen-angel discovery refresh (Wave 19). Opt-in via FALLEN_ANGEL_ENABLED.
  // Re-runs the gate each cycle over a fresh discovery page (any TVL above
  // fallenAngelMinTvlUsd) and feeds qualified pools into poolsToScan. RugCheck
  // reports are cached per mint for the process lifetime so repeat pages do
  // not re-fetch; the gecko OHLCV fetch is shared with the main stats path and
  // bounded by the discovery page size.
  const refreshFallenAngelCandidates = (scanOrdinal: number): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      if (config.fallenAngelEnabled !== true || !shouldDiscoverPools(config)) return;
      // SAFETY: The enclosing statement has validated or constructed the asserted contract before this value is consumed.
      const discovered = yield* adapter
        .discoverPools(scanOrdinal)
        // SAFETY: The runtime guard or typed fixture immediately above this assertion establishes the required invariant.
        // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
        .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<DiscoveredPool>)));
      if (discovered.length === 0) return;

      const rugcheckCache = new Map<string, RugCheckReport | null>();
      const fetchSignals = async (pool: {
        readonly address: string;
        readonly tokenX: string;
        readonly tokenY: string;
      }) => {
        // Single-sourced asset-leg resolution (same helper the gate uses), so
        // the RugCheck report is fetched for the exact mint the gate evaluates.
        const assetMint = identifyAssetMint(
          pool.tokenX,
          pool.tokenY,
          config.stablecoinMints,
          SOL_MINT,
        );
        const ohlcv: GeckoOhlcvSignals | null = await getGeckoPoolOhlcv(pool.address);
        let rugcheck: RugCheckReport | null = null;
        if (assetMint) {
          if (!rugcheckCache.has(assetMint)) {
            rugcheckCache.set(assetMint, await getRugCheckReport(assetMint));
          }
          rugcheck = rugcheckCache.get(assetMint) ?? null;
        }
        return { ohlcv, rugcheck };
      };

      const result = yield* Effect.promise(() =>
        evaluateFallenAngelDiscovery(
          discovered.filter(
            (p) => Number.isFinite(p.tvlUsd) && p.tvlUsd >= (config.fallenAngelMinTvlUsd ?? 0),
          ),
          {
            minTvlUsd: config.fallenAngelMinTvlUsd ?? 0,
            minDrawdownPct: config.fallenAngelMinDrawdownPct ?? 0.6,
            maxDrawdownPct: config.fallenAngelMaxDrawdownPct ?? 0.95,
            volBaselineMin: config.fallenAngelVolBaselineMin ?? 0.02,
            volBaselineMax: config.fallenAngelVolBaselineMax ?? 0.35,
            maxRugcheckScore: config.fallenAngelMaxRugcheckScore ?? 60,
            minHolders: config.fallenAngelMinHolders ?? 300,
            maxTop10HolderPct: config.fallenAngelMaxTop10HolderPct ?? 0.5,
          },
          config.stablecoinMints,
          SOL_MINT,
          fetchSignals,
        ),
      );

      fallenAngelCandidatePools.clear();
      fallenAngelSignals.clear();
      for (const qualified of result.qualified) {
        fallenAngelCandidatePools.add(qualified.poolAddress);
        fallenAngelSignals.set(qualified.poolAddress, {
          assetMint: qualified.assetMint,
          drawdownPct: qualified.drawdownPct,
        });
        if (!poolsToScan.includes(qualified.poolAddress)) {
          poolsToScan.push(qualified.poolAddress);
        }
      }
      if (result.qualified.length > 0) {
        logger.info(`Fallen-angel discovery: ${result.qualified.length} qualified pool(s)`, {
          pools: result.qualified.map((q) => q.poolAddress),
        });
      }
      for (const rejected of result.rejected.slice(0, 5)) {
        logger.debug("Fallen-angel candidate rejected", {
          pool: rejected.poolAddress,
          reasons: rejected.reasons,
        });
      }
    });

  const initialReconcileResult = yield* reconcilePositions(adapter, db, memory, trackedPositions, [
    ...new Set([...approvedPoolAddresses, ...marketScanPools, ...autonomousCandidatePools]),
  ]);
  refreshPoolsToScan(initialReconcileResult);

  // Seed the agent state snapshot with current positions before exposing the
  // HTTP/MCP interfaces, so /propose can accept proposals for held pools
  // immediately after startup (not just after the first scan cycle).
  yield* agentState
    .updateSnapshot({ positions: buildPositionSnapshots(trackedPositions.values()) })
    .pipe(Effect.catch(() => Effect.void));

  // Start agent-facing servers (MCP and HTTP fallback)
  yield* mcpServer.start().pipe(Effect.catch(() => Effect.void));
  yield* httpStatusServer.start().pipe(Effect.catch(() => Effect.void));

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
        .pipe(Effect.catch(() => Effect.succeed(initialSnapshot)));
      const positions = buildPositionSnapshots(trackedPositions.values());
      const positionsValueUsd = positions.reduce((sum, p) => sum + p.currentValueUsd, 0);
      const unrealizedPnlUsd = positions.reduce(
        (sum, p) => sum + (p.currentValueUsd - p.depositedUsd),
        0,
      );
      const recentDecisions = yield* audit
        .getRecentDecisions(20)
        .pipe(Effect.catch(() => Effect.succeed([])));

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

  // ─── Idle-capital auto-redeploy pass (opt-in) ─────────────────────────────

  /**
   * Deploy idle wallet capital into the cycle's best qualified entry
   * candidate at a wider (still fully capped) size. Candidates passed their
   * in-pool ENTER gates this cycle; this pass re-runs
   * evaluatePerPoolAllocation and the risk tail VERBATIM before execution —
   * caps can reject or shrink, the pass never bypasses a gate, and never
   * re-runs pool screening (cooldown, wallet-read, paper-validation and
   * token-risk stand as decided in-pool). At most one redeploy ENTER per
   * cycle. Failures degrade to an audited skip.
   */
  /** Shared per-candidate context for the idle-redeploy walk. */
  interface RedeployCandidateContext {
    readonly candidate: IdleRedeployCandidate;
    readonly cycleId: string;
    readonly executedExitPools: ReadonlySet<string>;
    readonly idleCapitalUsd: number;
    readonly portfolioValueUsd: number;
    readonly openPositions: ReadonlyArray<Position>;
    readonly recentPnlUsd: number;
    readonly rollingRealizedPnlHalted: boolean;
  }

  /** Result of the overlay + risk + execution pipeline for one candidate. */
  type RedeployCandidateVerdict = { readonly verdict: "next" } | { readonly verdict: "done" };

  // Follow-up 3655288395: every per-candidate rejection records its own audit
  // decision; cycle-global aborts and dispatched executions end the walk.
  function recordRedeploySkip(
    candidate: IdleRedeployCandidate,
    cycleId: string,
    reasoning: string,
    riskReason: string,
  ): Effect.Effect<void, never> {
    return audit
      .recordDecision({
        timestamp: Date.now(),
        cycleId,
        poolAddress: candidate.poolAddress,
        action: "ENTER",
        confidence: 0,
        reasoning,
        metrics: candidate.metrics,
        riskResult: { approved: false, reason: riskReason },
        executed: false,
        paperTrading: config.paperTrading,
      })
      .pipe(Effect.catch(() => Effect.void));
  }

  // Fresh per-candidate gates: exit-pool exclusion, entry-backoff honor,
  // open-position cap, widened-size floor, allocation headroom. "next" walks
  // to the next candidate, "done" aborts the pass, "go" carries the capped size.
  function checkRedeployEligibility(
    ctx: RedeployCandidateContext,
  ): Effect.Effect<
    | RedeployCandidateVerdict
    | { readonly verdict: "go"; readonly allocation: PerPoolAllocationResult },
    never
  > {
    const { candidate, cycleId } = ctx;
    return Effect.gen(function* () {
      // Follow-up 3655404926: a pool whose EXIT executed earlier THIS cycle may
      // NOT re-enter in the same cycle — the no-exit-and-reenter invariant.
      if (ctx.executedExitPools.has(candidate.poolAddress)) {
        yield* recordRedeploySkip(
          candidate,
          cycleId,
          "[idle-redeploy] skipped — an EXIT executed on this pool earlier this cycle (no exit-and-reenter)",
          "[idle-redeploy] pool exited earlier this cycle",
        );
        return { verdict: "next" } as const;
      }
      // P2 (3654054425, entry backoff): honor the SAME active-backoff predicate
      // the normal ENTER gate uses — retrying at the widened size would repeat
      // a known-doomed entry.
      const redeployEntryBackoff = entryFailureBackoff.get(candidate.poolAddress);
      if (redeployEntryBackoff && redeployEntryBackoff.nextAttemptAt > Date.now()) {
        yield* recordRedeploySkip(
          candidate,
          cycleId,
          `[idle-redeploy] skipped — entry backoff active (insufficient token balance; retry in ${Math.ceil((redeployEntryBackoff.nextAttemptAt - Date.now()) / 60_000)} minutes)`,
          "[idle-redeploy] entry-failure backoff active",
        );
        return { verdict: "next" } as const;
      }
      // The pass never pushes past the hard open-position cap.
      if (ctx.openPositions.length >= config.maxOpenPositions) {
        yield* recordRedeploySkip(
          candidate,
          cycleId,
          `[idle-redeploy] skipped — max open positions reached (${ctx.openPositions.length}/${config.maxOpenPositions})`,
          `[idle-redeploy] max open positions reached (${ctx.openPositions.length}/${config.maxOpenPositions})`,
        );
        return { verdict: "done" } as const;
      }
      // Wider size: half the idle capital, bounded by the per-pool allocation
      // share of the portfolio AND the configured idle ceiling.
      const proposedSizeUsd = computeIdleRedeploySizeUsd({
        idleCapitalUsd: ctx.idleCapitalUsd,
        portfolioValueUsd: ctx.portfolioValueUsd,
        maxPerPoolAllocationPct: config.maxPerPoolAllocationPct,
        maxSizeUsd: config.idleRedeployMaxSizeUsd,
      });
      if (proposedSizeUsd < ENTRY_SIZE_FLOOR_USD) {
        yield* recordRedeploySkip(
          candidate,
          cycleId,
          `[idle-redeploy] skipped — widened size $${proposedSizeUsd.toFixed(2)} below $${ENTRY_SIZE_FLOOR_USD} floor`,
          "[idle-redeploy] proposed size below entry floor",
        );
        return { verdict: "done" } as const;
      }
      const allocation = evaluatePerPoolAllocation({
        proposedDepositUsd: proposedSizeUsd,
        portfolioValueUsd: ctx.portfolioValueUsd,
        openPositions: ctx.openPositions,
        maxPerPoolAllocationPct: config.maxPerPoolAllocationPct,
        maxOpenPositions: config.maxOpenPositions,
        poolAddress: candidate.poolAddress,
        maxPositionsPerPool: config.maxPositionsPerPool,
      });
      if (!allocation.approved) {
        idleRedeployLogger.info("Idle redeploy capped by allocation", {
          pool: candidate.poolAddress,
          reason: allocation.reason,
        });
        yield* recordRedeploySkip(
          candidate,
          cycleId,
          `[idle-redeploy] capped — ${allocation.reason}`,
          `[idle-redeploy] ${allocation.reason}`,
        );
        return { verdict: "next" } as const;
      }
      return { verdict: "go", allocation } as const;
    });
  }

  // Build the redeploy ENTER decision (same single-rung TP ladder as the
  // in-slot normal ENTER when TAKE_PROFIT_ENABLED).
  function buildRedeployDecision(
    ctx: RedeployCandidateContext,
    allocation: PerPoolAllocationResult,
  ): AgentDecision {
    const { candidate } = ctx;
    return {
      action: "ENTER",
      poolAddress: candidate.poolAddress,
      // P2 (3654054423) + follow-up 3655288403: a modeled fee/IL ratio
      // (gecko, feeIlRatioKnown=false) gets NO fee vote; when fee/IL is
      // unknown confidence is derived from the signals that ARE known.
      confidence: computeIdleRedeployConfidence({
        feeIlRatio: candidate.feeIlRatio,
        feeIlRatioKnown: candidate.metrics.feeIlRatioKnown,
        volumeAuthenticity: candidate.metrics.volumeAuthenticity,
        volumeAuthenticityKnown: candidate.metrics.volumeAuthenticityKnown,
        binUtilization: candidate.metrics.binUtilization,
        binUtilizationKnown: candidate.metrics.binUtilizationKnown,
      }),
      reasoning: `[idle-redeploy] Deploying $${ctx.idleCapitalUsd.toFixed(0)} idle capital — Fee/IL ${candidate.feeIlRatio.toFixed(2)}, score ${candidate.entryScore.toFixed(3)}, TVL $${candidate.pool.tvlUsd.toFixed(0)}`,
      positionSizeUsd: allocation.adjustedDepositUsd,
      // Mirror the in-slot normal ENTER: a redeployed position carries the
      // same single-rung TP ladder when TAKE_PROFIT_ENABLED (CodeRabbit P2).
      ...((config.takeProfitEnabled ?? false) === true
        ? (() => {
            const tpLadder = buildTpLadder(candidate.pool.currentPrice, {
              rungs: [config.takeProfitPct ?? 0.15],
              fractions: [1],
              invalidationStopPct: config.trailingStopPct ?? 0.1,
            });
            if (tpLadder === null) return {};
            return {
              tpLadderJson: serializeTpLadder(tpLadder.ladder) ?? undefined,
              invalidationStopPrice: tpLadder.invalidationPrice,
            };
          })()
        : undefined),
    };
  }

  /** Mutable overlay outcome threaded through the redeploy agent-overlay stages. */
  interface RedeployOverlayState {
    readonly decision: AgentDecision;
    readonly overlaySkip: boolean;
    readonly appliedProposalId: string | undefined;
    readonly preApplyDecision: AgentDecision | undefined;
    readonly appliedAgentProposal: boolean;
    readonly proposalValidated: boolean;
  }

  /** Agent-overlay proposal fetch: veto override or queued/synced proposal. */
  function fetchRedeployAgentProposal(
    ctx: RedeployCandidateContext,
    decision: AgentDecision,
  ): Effect.Effect<
    {
      readonly decision: AgentDecision;
      readonly agentProposal: AgentProposal | null;
      readonly proposalSource: "queue" | "sync" | undefined;
    },
    never
  > {
    const { candidate } = ctx;
    const overlayPoolAddress = candidate.poolAddress;
    return Effect.gen(function* () {
      let current = decision;
      const overlayHasOpenPosition =
        positionsForPool(trackedPositions, overlayPoolAddress).length > 0;
      const overlayWarnings = yield* memory
        .getRelevantContext(`warnings for pool ${overlayPoolAddress}`, 3, overlayPoolAddress)
        .pipe(Effect.catch(() => Effect.succeed([])));
      const overlayRecentDecisions = yield* audit
        .getRecentDecisions(10)
        .pipe(Effect.catch(() => Effect.succeed([])));
      const proposalMode = config.agentProposalMode;
      const now = Date.now();
      if (proposalMode === "veto") {
        // Veto is a safety overlay, applied fail-open exactly as the tail does.
        const enhanced = yield* agent
          .enhanceDecision(current, {
            decision: current,
            pool: candidate.pool,
            metrics: candidate.metrics,
            warnings: overlayWarnings,
            recentDecisions: overlayRecentDecisions,
            hasOpenPosition: overlayHasOpenPosition,
          })
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (enhanced) {
          idleRedeployLogger.info("Agent veto override on idle-redeploy", {
            pool: overlayPoolAddress,
            from: current.action,
            to: enhanced.action,
            fromConfidence: current.confidence.toFixed(2),
            toConfidence: enhanced.confidence.toFixed(2),
          });
          current = enhanced;
        }
        return { decision: current, agentProposal: null, proposalSource: undefined } as const;
      }
      // suggest | supervised | full — resolve a queued proposal first
      // (supervised NEVER syncs, mirroring the tail's `!== "supervised"` guard).
      const snapshot = yield* agentState.getSnapshot();
      function resolveQueuedRedeployProposal(): AgentProposal | null {
        return (
          findPendingProposal(
            snapshot.pendingProposals,
            overlayPoolAddress,
            proposalMode,
            config.agentProposalStaleMs,
            now,
          ) ?? null
        );
      }
      let agentProposal: AgentProposal | null = resolveQueuedRedeployProposal();
      let proposalSource: "queue" | "sync" | undefined =
        resolveRedeployProposalSource(agentProposal);
      if (!agentProposal && proposalMode !== "supervised") {
        const agentStatus = yield* agent.getStatus().pipe(
          Effect.catch(() =>
            Effect.succeed({
              connected: false,
              transport: null,
              lastPromptAt: null,
              errorCount: 0,
            }),
          ),
        );
        const latencySkipped = yield* agent.shouldSkipSyncProposal();
        if (
          isSyncProposalEligible(
            hasSyncProposalTransport(agentStatus),
            getPoolCircuitBreaker(overlayPoolAddress).canTry(now),
            isProposalBackoffActive(proposalBackoff.get(overlayPoolAddress), now),
            latencySkipped,
          )
        ) {
          const syncProposal = yield* agent
            .enhanceDecision(current, {
              decision: current,
              pool: candidate.pool,
              metrics: candidate.metrics,
              warnings: overlayWarnings,
              recentDecisions: overlayRecentDecisions,
              hasOpenPosition: overlayHasOpenPosition,
            })
            .pipe(
              // Outer deadline mirrors the tail: a stalled reconnect must not
              // stall the redeploy pass past the proposal budget.
              Effect.timeoutOrElse({
                duration: `${config.agentProposalTimeoutMs} millis`,
                orElse: () =>
                  Effect.fail(
                    new Error(
                      `Agent proposal sync timed out after ${config.agentProposalTimeoutMs}ms`,
                    ),
                  ),
              }),
              Effect.catch(() => Effect.succeed(null)),
            );
          if (syncProposal && isAgentProposal(syncProposal)) {
            agentProposal = syncProposal;
            proposalSource = "sync";
          }
        }
      }
      return { decision: current, agentProposal, proposalSource } as const;
    });
  }

  // Apply a resolved proposal to the redeploy decision: suggest stays advisory,
  // an ENTER must clear the proposal hard floor, anything else cancels.
  function applyRedeployProposalValidation(
    ctx: RedeployCandidateContext,
    decision: AgentDecision,
    agentProposal: AgentProposal | null,
    proposalSource: "queue" | "sync" | undefined,
  ): Effect.Effect<RedeployOverlayState, never> {
    const { candidate } = ctx;
    const overlayPoolAddress = candidate.poolAddress;
    const idle: RedeployOverlayState = {
      decision,
      overlaySkip: false,
      appliedProposalId: undefined,
      preApplyDecision: undefined,
      appliedAgentProposal: false,
      proposalValidated: false,
    };
    if (!agentProposal) return Effect.succeed(idle);
    return Effect.gen(function* () {
      const proposalMode = config.agentProposalMode;
      const now = Date.now();
      const proposalToEvaluate: AgentProposal = buildProposalToEvaluate(
        agentProposal,
        decision.action,
        decision.confidence,
      );
      const validation = evaluateAgentProposal(
        proposalToEvaluate,
        {
          openPositions: ctx.openPositions,
          portfolioValueUsd: ctx.portfolioValueUsd,
          recentPnlUsd: ctx.recentPnlUsd,
          poolAddress: overlayPoolAddress,
          originalDecision: decision,
          activeBinId: candidate.pool.activeBinId,
        },
        config,
      );
      if (validation.valid && validation.adjustedDecision) {
        if (proposalMode === "suggest") {
          // Advisory only — the deterministic redeploy decision is kept.
          idleRedeployLogger.info("Agent proposal suggested (advisory) on idle-redeploy", {
            source: proposalSource,
            pool: overlayPoolAddress,
            suggested: validation.adjustedDecision.action,
          });
          return { ...idle, proposalValidated: true };
        }
        if (validation.adjustedDecision.action === "ENTER") {
          // Proposal hard-floor (0.2.27): the idle-redeploy overlay can also
          // apply an agent ENTER — it must not bypass the engine's hard
          // rejections. Re-run the same predicates the in-slot tail enforces.
          const candidateMetrics = candidate.metrics;
          const candidateDrift = candidate.netDriftBins;
          const hardRejectReason: string | null =
            feeIlHardFloorReason(
              config.ilProtectionEnabled,
              candidateMetrics.feeIlRatioKnown,
              candidateMetrics.feeIlRatio,
              config.minFeeIlRatio,
            ) ??
            // No lane exemptions on the redeploy floor: the drift gate fires
            // unconditionally, mirroring the in-slot tail's hard rejections.
            driftHardFloorReason(
              false,
              false,
              candidateDrift,
              config.marketScanMaxNegativeDriftBins,
            );
          if (hardRejectReason !== null) {
            idleRedeployLogger.warn("Agent proposal ENTER blocked by hard floor on idle-redeploy", {
              pool: overlayPoolAddress,
              reason: hardRejectReason,
            });
            yield* recordRedeploySkip(
              candidate,
              ctx.cycleId,
              `[proposal-hard-floor] ${hardRejectReason} — agent-proposed redeploy ENTER overridden`,
              `[proposal-hard-floor] ${hardRejectReason}`,
            );
            return { ...idle, overlaySkip: true };
          }
          idleRedeployLogger.info("Agent proposal applied to idle-redeploy", {
            source: proposalSource,
            pool: overlayPoolAddress,
            to: validation.adjustedDecision.action,
          });
          // Follow-up 3655404920: capture the pre-apply decision and flag a
          // real executable change so a later deterministic risk denial can
          // penalize the advisor exactly as the in-slot tail does.
          const applied = validation.adjustedDecision;
          const changed = decisionChangesExecutableBehavior(
            decision,
            applied,
            config.confidenceThreshold,
          );
          return {
            decision: applied,
            overlaySkip: false,
            appliedProposalId: resolveRedeployAppliedProposalId(
              proposalSource,
              agentProposal.proposalId,
            ),
            preApplyDecision: decision,
            appliedAgentProposal: changed,
            proposalValidated: true,
          };
        }
        idleRedeployLogger.info("Agent proposal cancelled idle-redeploy", {
          source: proposalSource,
          pool: overlayPoolAddress,
          to: validation.adjustedDecision.action,
        });
        yield* recordRedeploySkip(
          candidate,
          ctx.cycleId,
          `[idle-redeploy] [${proposalMode}] agent proposal adjusted to ${validation.adjustedDecision.action} — redeploy cancelled`,
          `[idle-redeploy] agent proposal adjusted to ${validation.adjustedDecision.action}`,
        );
        return { ...idle, overlaySkip: true };
      }
      // An invalid full/supervised/suggest proposal must not let the redeploy
      // proceed as if unconstrained; arm backoff (mirrors the tail) and skip.
      idleRedeployLogger.warn("Agent proposal rejected on idle-redeploy", {
        source: proposalSource,
        pool: overlayPoolAddress,
        reason: validation.reason,
      });
      proposalBackoff.set(
        overlayPoolAddress,
        nextProposalBackoff(proposalBackoff.get(overlayPoolAddress), now, {
          baseMs: config.agentProposalBackoffBaseMs,
          maxMs: config.agentProposalBackoffMaxMs,
        }),
      );
      getPoolCircuitBreaker(overlayPoolAddress).recordFailure(now);
      if (proposalSource === "queue" && agentProposal.proposalId) {
        yield* agentState
          .rejectProposal(agentProposal.proposalId)
          .pipe(Effect.catch(() => Effect.void));
      }
      return idle;
    });
  }

  // Supervised approval hold + non-ENTER overlay outcomes both skip the
  // redeploy (it has no HOLD/EXIT execution path).
  function finishRedeployOverlay(
    ctx: RedeployCandidateContext,
    state: RedeployOverlayState,
  ): Effect.Effect<RedeployOverlayState, never> {
    const { candidate } = ctx;
    const overlayPoolAddress = candidate.poolAddress;
    return Effect.gen(function* () {
      // Supervised mode gates execution on human approval: without an applied
      // approved queued proposal an ENTER (the redeploy) is held — and the
      // redeploy has no HOLD execution path, so a held redeploy is a skip.
      if (
        !state.overlaySkip &&
        shouldHoldForSupervisedApproval(
          config.agentiveMode,
          config.agentProposalMode,
          state.appliedProposalId !== undefined,
          state.decision.action,
        )
      ) {
        idleRedeployLogger.info("Supervised mode: holding idle-redeploy pending approval", {
          pool: overlayPoolAddress,
        });
        yield* recordRedeploySkip(
          candidate,
          ctx.cycleId,
          `[idle-redeploy] [supervised] awaiting approved proposal — redeploy held (${state.decision.action})`,
          "[idle-redeploy] supervised mode requires an approved proposal",
        );
        return { ...state, overlaySkip: true };
      }
      // A veto/proposal that forces HOLD means "don't enter"; a defensive
      // non-ENTER override (EXIT/REBALANCE) has no position to act on.
      if (!state.overlaySkip && state.decision.action !== "ENTER") {
        idleRedeployLogger.info("Idle-redeploy overlay forced non-ENTER — skipping", {
          pool: overlayPoolAddress,
          action: state.decision.action,
        });
        yield* recordRedeploySkip(
          candidate,
          ctx.cycleId,
          state.decision.action === "HOLD"
            ? "[idle-redeploy] vetoed to HOLD by agent overlay — redeploy skipped"
            : `[idle-redeploy] agent overlay adjusted to ${state.decision.action} — redeploy skipped`,
          state.decision.action === "HOLD"
            ? "[idle-redeploy] agent overlay forced HOLD"
            : `[idle-redeploy] agent overlay adjusted to ${state.decision.action}`,
        );
        return { ...state, overlaySkip: true };
      }
      return state;
    });
  }

  // Agent overlay entry: AGENTIC_MODE=false skips the whole block (zero
  // behavior change); otherwise fetch → validate/apply → supervised/non-ENTER.
  function applyRedeployOverlay(
    ctx: RedeployCandidateContext,
    decision: AgentDecision,
  ): Effect.Effect<RedeployOverlayState, never> {
    if (config.agentiveMode !== true) {
      return Effect.succeed({
        decision,
        overlaySkip: false,
        appliedProposalId: undefined,
        preApplyDecision: undefined,
        appliedAgentProposal: false,
        proposalValidated: false,
      });
    }
    return Effect.gen(function* () {
      const fetched = yield* fetchRedeployAgentProposal(ctx, decision);
      const applied = yield* applyRedeployProposalValidation(
        ctx,
        fetched.decision,
        fetched.agentProposal,
        fetched.proposalSource,
      );
      return yield* finishRedeployOverlay(ctx, applied);
    });
  }

  // Follow-up 3655404912: the SAME bounded allowlisted copy-signal boost the
  // in-slot tail applies before risk evaluation.
  function applyRedeployCopyBoost(
    ctx: RedeployCandidateContext,
    decision: AgentDecision,
  ): Effect.Effect<AgentDecision, never> {
    return Effect.gen(function* () {
      const redeployCopySignalResult =
        copySignalsOption._tag === "Some"
          ? yield* copySignalsOption.value.getBoost(ctx.candidate.poolAddress, Date.now())
          : { boost: 0, wallets: [], ignored: 0 };
      if (redeployCopySignalResult.boost > 0 && decision.action !== "EXIT") {
        const boosted = applyCopySignalBoost(
          decision,
          redeployCopySignalResult,
          config.copySignalsMaxBoost ?? 0.05,
        );
        idleRedeployLogger.info("Applied bounded copy-trading signal boost on idle-redeploy", {
          pool: ctx.candidate.poolAddress,
          boost: redeployCopySignalResult.boost,
          wallets: redeployCopySignalResult.wallets.length,
          ignored: redeployCopySignalResult.ignored,
        });
        return boosted;
      }
      return decision;
    });
  }

  // Risk evaluation for the redeploy ENTER (same gates as a normal ENTER).
  // A denial records the rejection and walks on; approval carries the
  // (possibly resized) decision forward.
  function evaluateRedeployRisk(
    ctx: RedeployCandidateContext,
    state: RedeployOverlayState,
  ): Effect.Effect<
    | RedeployCandidateVerdict
    | {
        readonly verdict: "go";
        readonly decision: AgentDecision;
        readonly riskResult: RiskResult;
      },
    never
  > {
    return Effect.gen(function* () {
      let decision = state.decision;
      const riskCtx = {
        openPositions: ctx.openPositions,
        portfolioValueUsd: ctx.portfolioValueUsd,
        recentPnlUsd: ctx.recentPnlUsd,
        poolAddress: ctx.candidate.poolAddress,
        activeBinId: ctx.candidate.pool.activeBinId,
        rollingRealizedPnlHalted: ctx.rollingRealizedPnlHalted,
        // Issue #201 review (P1): launch entries stay subject to the
        // portfolio-wide MAX_OPEN_POSITIONS — the launch lane adds its own
        // launchMaxOpenPositions sub-cap on top; it must not let the total
        // exceed the configured global cap.
        ...(decision.action === "ENTER" && decision.positionMode === "launch"
          ? { maxOpenPositions: config.maxOpenPositions }
          : undefined),
      };
      // Issue #148: the wallet safety pause is informational in shadow mode
      // (no-send by design) — it must never block a decision there.
      const pauseBlockReason = safetyPauseBlockReason(
        autonomousExecution?.mode,
        activeSafetyPause,
        decision.action,
      );
      const riskResult: RiskResult =
        pauseBlockReason === null
          ? risk.evaluate(decision, riskCtx)
          : {
              approved: false,
              reason: pauseBlockReason,
            };
      if (riskResult.adjustedSizeUsd) {
        decision = {
          ...decision,
          positionSizeUsd: riskResult.adjustedSizeUsd,
          reasoning: `${decision.reasoning} (size capped to $${riskResult.adjustedSizeUsd.toFixed(0)})`,
        };
      }
      if (!riskResult.approved) {
        idleRedeployLogger.info("Idle redeploy rejected by risk gate", {
          pool: ctx.candidate.poolAddress,
          reason: riskResult.reason,
        });
        yield* alertSvc.sendAlert({
          type: "risk_rejection",
          severity: "warning",
          message: `Risk gate rejected idle-redeploy ENTER on ${ctx.candidate.pool.tokenXSymbol}/${ctx.candidate.pool.tokenYSymbol}: ${riskResult.reason}`,
          poolAddress: ctx.candidate.poolAddress,
          data: { action: "ENTER", reason: riskResult.reason },
        });
        yield* audit
          .recordDecision({
            timestamp: Date.now(),
            cycleId: ctx.cycleId,
            poolAddress: ctx.candidate.poolAddress,
            action: "ENTER",
            confidence: decision.confidence,
            reasoning: decision.reasoning,
            metrics: ctx.candidate.metrics,
            riskResult,
            executed: false,
            paperTrading: config.paperTrading,
          })
          .pipe(Effect.catch(() => Effect.void));
        // Follow-up 3655404920: mirror the in-slot tail — a deterministic risk
        // denial after an applied full/supervised proposal rejects the queued
        // proposal and arms backoff / circuit breaker.
        const penalizeAppliedProposal = shouldPenalizeAppliedProposalDenial({
          appliedAgentProposal: state.appliedAgentProposal,
          preApplyDecision: state.preApplyDecision,
          appliedDecision: decision,
          isPreApplyRiskApproved: () =>
            state.preApplyDecision !== undefined &&
            risk.evaluate(state.preApplyDecision, riskCtx).approved,
        });
        yield* recordAppliedProposalRiskDenial(agentState, {
          penalizeAdvisor: penalizeAppliedProposal,
          appliedQueuedProposalId: state.appliedProposalId,
          proposalBackoff,
          recordCircuitFailure: penalizeAppliedProposal
            ? (t) => getPoolCircuitBreaker(ctx.candidate.poolAddress).recordFailure(t)
            : undefined,
          poolAddress: ctx.candidate.poolAddress,
          now: Date.now(),
          backoff: {
            baseMs: config.agentProposalBackoffBaseMs,
            maxMs: config.agentProposalBackoffMaxMs,
          },
        });
        return { verdict: "next" } as const;
      }
      // Follow-up 3655404920: a validated proposal that survives risk is a
      // usable advisor response — clear per-pool backoff and reset the breaker.
      recordAppliedProposalRiskApproval({
        proposalValidated: state.proposalValidated,
        proposalBackoff,
        recordCircuitSuccess: () =>
          getPoolCircuitBreaker(ctx.candidate.poolAddress).recordSuccess(),
        poolAddress: ctx.candidate.poolAddress,
      });
      return { verdict: "go", decision, riskResult } as const;
    });
  }

  // Widened-size guard (must strictly exceed the normal entry), fresh signal
  // snapshot, and the token-level execution-failure breaker.
  function checkRedeploySizeAndSnapshot(
    ctx: RedeployCandidateContext,
    decision: AgentDecision,
  ): Effect.Effect<
    | RedeployCandidateVerdict
    | {
        readonly verdict: "go";
        readonly signalTimestamp: number;
        readonly signalSnapshotId: number | null;
      },
    never
  > {
    const { candidate } = ctx;
    return Effect.gen(function* () {
      // P2 (3654054429, widened size): compare against the POST-CAP deposit the
      // redeploy would actually deploy, not the raw proposed figure. A
      // modeled/unknown size (undefined) fails closed to 0 → skip.
      const finalRedeploySizeUsd = decision.positionSizeUsd ?? 0;
      if (finalRedeploySizeUsd <= candidate.normalEntrySizeUsd) {
        idleRedeployLogger.info("Idle redeploy widened size does not exceed normal entry", {
          pool: candidate.poolAddress,
          finalSizeUsd: finalRedeploySizeUsd,
          normalEntrySizeUsd: candidate.normalEntrySizeUsd,
        });
        yield* recordRedeploySkip(
          candidate,
          ctx.cycleId,
          `[idle-redeploy] widened size $${finalRedeploySizeUsd.toFixed(2)} does not exceed normal entry $${candidate.normalEntrySizeUsd.toFixed(2)} — skipped`,
          "[idle-redeploy] widened size does not exceed normal entry size",
        );
        return { verdict: "next" } as const;
      }
      const signalTimestamp = Date.now();
      const signalSnapshotId = yield* db
        .saveSignalSnapshot({
          poolAddress: candidate.poolAddress,
          timestamp: signalTimestamp,
          feeIlRatio: candidate.metrics.feeIlRatio,
          volumeAuthenticity: candidate.metrics.volumeAuthenticity,
          binUtilization: candidate.metrics.binUtilization,
          tvlUsd: candidate.pool.tvlUsd,
          tvlVelocity: candidate.metrics.tvlVelocity,
          volatilityStddev: candidate.volatilityStddev,
          binStep: candidate.pool.binStep,
          action: decision.action,
          confidence: decision.confidence,
        })
        .pipe(Effect.catch(() => Effect.succeed(null)));
      // Token-level execution-failure breaker (Robinhood rule 12): a redeploy
      // is a live ENTER — the same per-leg block gate as the in-slot ENTER path.
      const blockedToken = yield* findBlockedToken(candidate.pool);
      if (blockedToken !== null) {
        const blockLabel =
          blockedToken.kind === "rug" ? "rug/drain block" : "execution-failure block";
        idleRedeployLogger.warn(`Idle redeploy blocked by token ${blockLabel}`, {
          pool: candidate.poolAddress,
          token: blockedToken.mint,
        });
        yield* recordRedeploySkip(
          candidate,
          ctx.cycleId,
          `[idle-redeploy] [token-block] token ${blockedToken.mint} under ${blockLabel} — redeploy ENTER rejected`,
          `[token-block] token ${blockedToken.mint} under ${blockLabel}`,
        );
        return { verdict: "next" } as const;
      }
      return { verdict: "go", signalTimestamp, signalSnapshotId } as const;
    });
  }

  /** Execution-plan shape for a redeploy ENTER (range + dip offset). */
  interface RedeployExecutionPlan {
    readonly entryStrategySpec: EntryStrategySpec;
    readonly entryDipOffsetBins: number;
    readonly effectiveEntryHalfWidth: number;
  }

  /** Pure execution-plan resolution for a redeploy ENTER (shape + range + dip offset). */
  function resolveRedeployExecutionPlan(
    ctx: RedeployCandidateContext,
    decision: AgentDecision,
  ): RedeployExecutionPlan {
    const { candidate } = ctx;
    // Same entry-shape / range-width resolution the in-slot tail uses.
    const entryStrategySpec: EntryStrategySpec =
      config.entryStrategyType === "auto"
        ? recommendStrategy({
            volatilityStddev: candidate.volatilityStddev,
            highVolThreshold: config.volatilityExitStddev,
            netDriftBins: candidate.netDriftBins,
          })
        : config.entryStrategyType;
    const entryRangeHalfWidth = resolveRangeHalfWidth({
      binStep: candidate.pool.binStep,
      configuredBaseHalfWidth: config.entryRangeHalfWidthBins,
      adaptiveEnabled: config.volatilityAdaptiveRanges,
      volatilityStddev: candidate.volatilityStddev,
      maxFullRangeBins: config.maxRebalanceRangeBins,
      minPriceCoveragePct: config.minRangeHalfWidthPct,
    });
    // Runner mode (Heart Attack): LAUNCH-lane entries anchor the range below
    // the active bin. Zero offset otherwise.
    const isRunnerLaunchEntry =
      config.launchRunnerModeEnabled === true &&
      decision.positionMode === "launch" &&
      launchScanPools.has(candidate.pool.address);
    const entryDipOffsetBins = isRunnerLaunchEntry
      ? dipOffsetBinsForPct(candidate.pool.binStep, config.launchRunnerDipPct ?? 0.12)
      : 0;
    // Runner width stays within the operator's risk cap AND wholly below the
    // active bin (width clamped to |dip offset| - 1).
    const effectiveEntryHalfWidth = isRunnerLaunchEntry
      ? Math.max(
          1,
          Math.min(
            config.launchRunnerHalfWidthBins ?? 5,
            Math.abs(entryDipOffsetBins) - 1,
            Math.floor((config.maxRebalanceRangeBins ?? 100) / 2),
          ),
        )
      : entryRangeHalfWidth;
    return { entryStrategySpec, entryDipOffsetBins, effectiveEntryHalfWidth };
  }

  // Dispatch the redeploy ENTER down the paper / shadow / live paths (same
  // shape, range and budget gates as the in-slot tail).
  /** Uniform dispatch outcome: verdict gates the walk, fields valid on "go". */
  interface RedeployDispatchOutcome {
    readonly verdict: "next" | "done" | "go";
    readonly executed: boolean;
    readonly executionError: string | undefined;
  }

  function dispatchRedeployExecution(
    ctx: RedeployCandidateContext,
    decision: AgentDecision,
    signalTimestamp: number,
    signalSnapshotId: number | null,
  ): Effect.Effect<RedeployDispatchOutcome, never, EntryPrepService> {
    const { candidate } = ctx;
    return Effect.gen(function* () {
      const plan = resolveRedeployExecutionPlan(ctx, decision);
      const snapshotId = signalSnapshotId ?? undefined;
      let executed = false;
      let executionError: string | undefined = undefined;
      if (config.paperTrading) {
        const paperResult = yield* executePaper(
          {
            db,
            trackedPositions,
            strategy,
            entryStrategySpec: plan.entryStrategySpec,
            entryRangeHalfWidth: plan.effectiveEntryHalfWidth,
            entryDipOffsetBins: plan.entryDipOffsetBins,
            ladderEnabled: config.ladderEnabled ?? false,
            ladderTightMult: config.ladderTightMult ?? 0.6,
            ladderWideMult: config.ladderWideMult ?? 1.6,
            maxOpenPositions: config.maxOpenPositions,
            maxPositionsPerPool: config.maxPositionsPerPool,
            ...runnerDispatchDeps(decision.poolAddress),
            ...rugDispatchDeps(),
          },
          decision,
          candidate.pool,
          signalTimestamp,
          snapshotId,
        );
        executed = paperResult.executed;
        executionError = paperResult.error;
      } else if (config.autonomousTokenMode === "shadow") {
        // Shadow mode is no-send for live execution — the redeploy has no HOLD
        // execution path, so the shadow-skipped redeploy is a recorded skip.
        idleRedeployLogger.info("Shadow mode: idle redeploy skipped (no-send)", {
          pool: candidate.poolAddress,
        });
        yield* recordRedeploySkip(
          candidate,
          ctx.cycleId,
          "[idle-redeploy] skipped — AUTONOMOUS_TOKEN_MODE=shadow blocks live execution (no-send)",
          "[idle-redeploy] shadow mode is no-send for live entries",
        );
        return { verdict: "next", executed: false, executionError: undefined };
      } else {
        // The live path runs the unchanged paper-validation gate first, then
        // the batch SOL reserve gate, execution, and post-tx refresh.
        function dispatchRedeployLive(): Effect.Effect<
          RedeployDispatchOutcome,
          never,
          EntryPrepService
        > {
          return Effect.gen(function* () {
            let executed = false;
            let executionError: string | undefined = undefined;
            // The live path runs the unchanged paper-validation gate first.
            const paperDays = yield* readPaperDays;
            const validation = evaluatePaperValidation({
              paperTrading: false,
              paperDaysAccumulated: paperDays,
              minDays: config.paperValidationMinDays,
              enforce: config.paperValidationEnforce,
            });
            if (!validation.approved) {
              idleRedeployLogger.warn("Idle redeploy blocked by paper-validation gate", {
                pool: candidate.poolAddress,
                reason: validation.reason,
              });
              yield* recordRedeploySkip(
                candidate,
                ctx.cycleId,
                `[idle-redeploy] [paper-validation] ${validation.reason}`,
                validation.reason,
              );
              return { verdict: "done", executed: false, executionError: undefined };
            }
            // Issue #170: the same batch wallet-reserve gate as the in-slot ENTER
            // path — skip capacity-limited; the next cycle re-evaluates.
            if (solFundedEntryMode) {
              const redeploySizeUsd = decision.positionSizeUsd;
              if (redeploySizeUsd !== undefined) {
                const neededLamports = estimateEntrySolLamports({
                  positionSizeUsd: redeploySizeUsd,
                  solPriceUsd: entrySolPriceUsd,
                  poolHasSolLeg: hasNativeSolLeg(candidate.pool),
                  solFunded: true,
                });
                if (!entrySolBudgetKnown || neededLamports > entrySolBudgetLamports) {
                  const budgetHuman = entrySolBudgetKnown
                    ? (Number(entrySolBudgetLamports) / 1e9).toFixed(4)
                    : "unknown";
                  const neededHuman = (Number(neededLamports) / 1e9).toFixed(4);
                  idleRedeployLogger.info(
                    "Idle redeploy skipped — free SOL below entry estimate (wallet reserve)",
                    {
                      pool: candidate.poolAddress,
                      freeSol: budgetHuman,
                      neededSol: neededHuman,
                    },
                  );
                  yield* recordRedeploySkip(
                    candidate,
                    ctx.cycleId,
                    `[idle-redeploy] skipped — free SOL ${budgetHuman} < needed ${neededHuman} (wallet-reserve gate, capacity-limited)`,
                    "[idle-redeploy] wallet SOL reserve insufficient",
                  );
                  yield* finalizeAppliedProposal(agentState, undefined, false, decision.action);
                  return { verdict: "next", executed: false, executionError: undefined };
                }
                entrySolBudgetLamports -= neededLamports;
              }
            }
            const entryPrep = yield* EntryPrepService;
            const liveResult = yield* executeLive(
              {
                adapter,
                strategy,
                db,
                revenueConfigSvc,
                trackedPositions,
                entryPrep,
                solPriceUsd: config.solPriceUsd,
                entryStrategySpec: plan.entryStrategySpec,
                entryRangeHalfWidth: plan.effectiveEntryHalfWidth,
                entryDipOffsetBins: plan.entryDipOffsetBins,
                runnerSingleSidedX: plan.entryDipOffsetBins !== 0,
                reconcileRequestedPools,
                memory,
                unpricedExitWarnedPools,
                ...runnerDispatchDeps(decision.poolAddress),
                ...harvestDispatchDeps(),
                ...rugDispatchDeps(),
                ...(autonomousExecution ? { autonomous: autonomousExecution } : undefined),
              },
              decision,
              candidate.pool,
              signalTimestamp,
              snapshotId,
            );
            executed = liveResult.executed;
            executionError = liveResult.error;
            // A live redeploy moved funds out of the wallet: re-read so the rest
            // of the engine sees the post-transaction balance (mirrors the in-slot
            // tail). A failed re-read blocks further entries this cycle.
            if (executed) {
              lastWalletBalanceUsd = yield* adapter.getWalletBalanceUsd().pipe(
                Effect.catch(() => {
                  liveEntriesBlockedRestOfCycle = true;
                  idleRedeployLogger.warn(
                    "Wallet balance refresh failed after live idle-redeploy entry — blocking further entries this cycle",
                    { pool: candidate.poolAddress },
                  );
                  return Effect.succeed(lastWalletBalanceUsd);
                }),
              );
            }
            // Issue #170: refresh the batch SOL budget after the live redeploy
            // attempt (executed or failed — a partial prep swap may have spent
            // SOL). Fail closed on read failure.
            if (solFundedEntryMode) {
              entrySolBudgetLamports = yield* adapter.getNativeSolBalance().pipe(
                Effect.map((lamports) => freeEntrySolLamports(lamports)),
                Effect.catch(() => Effect.succeed(0n)),
              );
              entrySolBudgetKnown = true;
            }
            return { verdict: "go", executed, executionError };
          });
        }

        return yield* dispatchRedeployLive();
      }
      return { verdict: "go", executed, executionError } as const;
    });
  }

  // Post-execution bookkeeping: entry-failure backoff, proposal finalization,
  // execution counters, and the dispatch audit record.
  function finalizeRedeployOutcome(
    ctx: RedeployCandidateContext,
    cycle: AgentCycle,
    decision: AgentDecision,
    riskResult: RiskResult,
    appliedProposalId: string | undefined,
    executed: boolean,
    executionError: string | undefined,
  ): Effect.Effect<void, never> {
    const { candidate } = ctx;
    return Effect.gen(function* () {
      if (isInsufficientTokenBalanceError(executionError)) {
        const backoff = nextEntryFailureBackoff(entryFailureBackoff.get(candidate.poolAddress));
        entryFailureBackoff.set(candidate.poolAddress, backoff);
      } else if (executed) {
        entryFailureBackoff.delete(candidate.poolAddress);
        if (autonomousExecution) {
          const autonomousCandidate = [...autonomousCandidates.values()].find(
            (item) => item.poolAddress === candidate.poolAddress && item.state === "eligible",
          );
          if (autonomousCandidate) {
            const enteredCandidate = transitionCandidate(
              autonomousCandidate,
              { kind: "entry_confirmed", occurredAt: Date.now() },
              {
                minHealthyScans: config.candidateMinHealthyScans,
                minObservationMs: config.candidateMinObservationMs,
              },
            );
            autonomousCandidates.set(enteredCandidate.id, enteredCandidate);
            yield* db.saveTokenCandidate(enteredCandidate).pipe(Effect.catch(() => Effect.void));
          }
        }
      }
      // Consume an approved queued proposal (supervised) once the redeploy
      // outcome is final — same helper the in-slot tail uses. A failed
      // execution retains it for retry next cycle.
      yield* finalizeAppliedProposal(agentState, appliedProposalId, executed, decision.action);
      if (executed) {
        cycle.poolsExecuted++;
        recordExecutionOutcome(true);
        sessionEntriesExecuted++;
        idleRedeployLogger.info("Idle capital redeployed", {
          pool: candidate.poolAddress,
          sizeUsd: decision.positionSizeUsd,
          idleCapitalUsd: ctx.idleCapitalUsd,
          paperTrading: config.paperTrading,
        });
      } else if (!(solFundedEntryMode && isInsufficientTokenBalanceError(executionError))) {
        // Issue #170: in SOL-funded mode a redeploy failing on a funding
        // condition is a wallet-capacity outcome — never arms the
        // execution_failures pause (plain live keeps its pause-breaker teeth).
        cycle.poolsFailed++;
        recordExecutionOutcome(false);
      }
      yield* audit
        .recordDecision({
          timestamp: Date.now(),
          cycleId: ctx.cycleId,
          poolAddress: candidate.poolAddress,
          action: "ENTER",
          confidence: decision.confidence,
          reasoning: decision.reasoning,
          metrics: candidate.metrics,
          riskResult,
          executed,
          error: executionError,
          paperTrading: config.paperTrading,
        })
        .pipe(Effect.catch(() => Effect.void));
      cycle.decisions.push(decision);
    });
  }

  const runIdleRedeployPass = (
    candidates: ReadonlyArray<IdleRedeployCandidate>,
    cycle: AgentCycle,
    executedExitPools: ReadonlySet<string>,
  ): Effect.Effect<void, never, EntryPrepService> =>
    Effect.gen(function* () {
      const cycleId = cycle.cycleId;

      // Idle capital: live = USDC wallet holdings at par (the adapter read
      // shares the balance cache — no extra RPC); paper = the portfolio seed
      // minus deployed value. A failed live holdings read degrades to "no
      // idle detected" (fail-open — the cycle never fails and never deploys
      // on stale data).
      const deployedUsd = Array.from(trackedPositions.values()).reduce(
        (sum, pos) => sum + pos.currentValueUsd,
        0,
      );
      // Idle capital: live = USDC wallet holdings at par (the adapter read
      // shares the balance cache — no extra RPC); paper = the portfolio seed
      // minus deployed value. A failed live holdings read degrades to "no
      // idle detected" (fail-open — the cycle never fails and never deploys
      // on stale data).
      function readIdleCapitalUsd(deployedUsd: number): Effect.Effect<number, never> {
        return Effect.gen(function* () {
          if (config.paperTrading || !adapter.hasWallet()) {
            return Math.max(config.paperPortfolioUsd - deployedUsd, 0);
          }
          const holdings = yield* adapter.getWalletHoldings().pipe(
            Effect.catch((err) => {
              idleRedeployLogger.warn(
                "Wallet holdings read failed — idle redeploy skipped this cycle",
                { error: String(err) },
              );
              return Effect.succeed(
                new Map<string, { readonly amountAtomic: bigint; readonly decimals: number }>(),
              );
            }),
          );
          const usdcHolding = holdings.get(USDC_MINT);
          return usdcHolding === undefined
            ? 0
            : Number(usdcHolding.amountAtomic) / 10 ** usdcHolding.decimals;
        });
      }

      const idleCapitalUsd = yield* readIdleCapitalUsd(deployedUsd);

      if (idleCapitalUsd <= config.idleRedeployThresholdUsd) {
        idleRedeployLogger.debug("Idle capital below redeploy threshold", {
          idleCapitalUsd,
          thresholdUsd: config.idleRedeployThresholdUsd,
          candidates: candidates.length,
        });
        return;
      }

      // Fresh portfolio context — positions moved during the pools loop, so
      // the gates measure current state, not the cycle-top capture.
      const openPositions = Array.from(trackedPositions.values()).map(toRiskPosition);
      // Follow-up 3655288389: in paper mode (and walletless live) the paper seed
      // IS the modeled total portfolio — paper never decrements the wallet when
      // capital deploys (see AGENTS.md §wallet-balance), so `lastWalletBalanceUsd
      // === config.paperPortfolioUsd` is a STATIC seed. Adding deployed positions
      // onto it double-counts: a $10k seed with $3k deployed would evaluate as
      // $13k, growing a 40% cap to 52% of the real paper portfolio. Use the seed
      // itself — consistent with the idleCapitalUsd calc above, which treats the
      // seed as the total (seed − deployed). Live keeps wallet + positions
      // (the wallet read genuinely shrinks as capital deploys).
      const portfolioValueUsd = resolveRedeployPortfolioValueUsd(
        config.paperTrading,
        adapter.hasWallet(),
        config.paperPortfolioUsd,
        lastWalletBalanceUsd,
        openPositions,
      );
      const recentPnlUsd = openPositions.reduce((sum, pos) => sum + pos.unrealizedPnlUsd, 0);

      // Follow-up 3655288395: walk candidates in score order and dispatch the
      // FIRST one that survives every fresh gate. A per-candidate rejection
      // (backoff, allocation headroom, widened-size, overlay, risk) `continue`s
      // to the next candidate with its own audit record; a cycle-global abort
      // (max open positions, size floor, live paper-validation) or a dispatched
      // execution `return`s. At most one redeploy ENTER per cycle.
      const sortedCandidates = [...candidates].sort((a, b) => b.entryScore - a.entryScore);
      function walkRedeployCandidates(): Effect.Effect<void, never, EntryPrepService> {
        return Effect.gen(function* () {
          for (const candidate of sortedCandidates) {
            const cctx: RedeployCandidateContext = {
              candidate,
              cycleId,
              executedExitPools,
              idleCapitalUsd,
              portfolioValueUsd,
              openPositions,
              recentPnlUsd,
              rollingRealizedPnlHalted: cycle.rollingRealizedPnlHalted,
            };
            const eligibility = yield* checkRedeployEligibility(cctx);
            if (eligibility.verdict !== "go") {
              if (eligibility.verdict === "done") return;
              continue;
            }
            const overlay = yield* applyRedeployOverlay(
              cctx,
              buildRedeployDecision(cctx, eligibility.allocation),
            );
            if (overlay.overlaySkip) continue;
            const boosted = yield* applyRedeployCopyBoost(cctx, overlay.decision);
            const gated = yield* evaluateRedeployRisk(cctx, { ...overlay, decision: boosted });
            if (gated.verdict !== "go") continue;
            const sized = yield* checkRedeploySizeAndSnapshot(cctx, gated.decision);
            if (sized.verdict !== "go") continue;
            const outcome = yield* dispatchRedeployExecution(
              cctx,
              gated.decision,
              sized.signalTimestamp,
              sized.signalSnapshotId,
            );
            if (outcome.verdict !== "go") continue;
            yield* finalizeRedeployOutcome(
              cctx,
              cycle,
              gated.decision,
              gated.riskResult,
              overlay.appliedProposalId,
              outcome.executed,
              outcome.executionError,
            );
            // This candidate survived every fresh gate and was dispatched (whether or
            // not the tx landed) — the walk stops here. At most one redeploy ENTER per
            // cycle; a failed execution retries next cycle, not against a sibling.
            return;
          }
        });
      }

      yield* walkRedeployCandidates();
    });

  // ─── Market-scan universe refresh ─────────────────────────────────────────
  // Re-runs the market gate on MARKET_SCAN_REFRESH_INTERVAL_MS: fetch the
  // top-N pages of the TVL-ranked Meteora universe, gate by TVL / fee APR /
  // volume turnover / token safety / bin step, and rebuild the active
  // top-K set. Pools that stop qualifying drop out of the active set next
  // cycle (held positions stay scanned via refreshPoolsToScan). Every
  // failure path fails open: the last ranked set keeps serving.
  const refreshMarketUniverse = (now: number): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      if (config.marketScanEnabled !== true) return;
      if (adapter.discoverPoolsTopPages === undefined) {
        logger.warn("Market scan: adapter does not expose discoverPoolsTopPages — disabled");
        return;
      }
      if (now - lastMarketRefreshAt < (config.marketScanRefreshIntervalMs ?? 1_800_000)) return;
      lastMarketRefreshAt = now;
      // SAFETY: The enclosing statement has validated or constructed the asserted contract before this value is consumed.
      const discovered = yield* adapter
        .discoverPoolsTopPages(config.marketScanUniversePages ?? 3)
        // SAFETY: The runtime guard or typed fixture immediately above this assertion establishes the required invariant.
        // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
        .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<DiscoveredPool>)));
      if (discovered.length === 0) {
        logger.warn("Market scan: universe fetch returned nothing — keeping last ranked set");
        return;
      }
      const marketCfg = resolveMarketScanConfig(config);
      const { ranked } = gateAndRankMarketPools(discovered, {
        ...marketCfg,
        minVolumeTurnover: 0.02,
        maxVolumeTurnover: 50,
      });
      marketRankedPools = ranked;
      const activeCount = resolveMarketActiveCount(config);
      marketScanPools.clear();
      for (const rank of ranked.slice(0, activeCount)) {
        marketScanPools.add(rank.pool.address);
      }
      logger.info("Market scan: universe gate refreshed", {
        universe: discovered.length,
        passed: ranked.length,
        active: marketScanPools.size,
        top: ranked
          .slice(0, 5)
          .map(
            (r) =>
              `${r.pool.tokenXSymbol ?? "?"}/${r.pool.tokenYSymbol ?? "?"} ${r.feeAprPct.toFixed(1)}%APR`,
          )
          .join(", "),
      });
    });

  // ─── Launch-mode radar refresh ─────────────────────────────────────────
  // When LAUNCH_SCAN_ENABLED, re-runs the launch gate on
  // LAUNCH_SCAN_REFRESH_INTERVAL_MS (clamped to >= 10s): fetch the hot-pool
  // shortlist (sorted by 24h fee/TVL ratio desc), gate it by age / TVL band /
  // 1h volume / base fee / bin step / token safety, and log the top-K radar
  // (fee yield, 1h volume, age). Discovery + screening ONLY — v1 wires no
  // execution lane. Every failure path fails open and the default
  // (launchScanEnabled=false) path is behavior-identical.
  let lastLaunchScanAt = 0;
  const refreshLaunchScan = (now: number): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      if (config.launchScanEnabled !== true) return;
      if (adapter.discoverHotPools === undefined) {
        logger.warn("Launch radar: adapter does not expose discoverHotPools — disabled");
        return;
      }
      const intervalMs = Math.max(config.launchScanRefreshIntervalMs ?? 120_000, 10_000);
      if (now - lastLaunchScanAt < intervalMs) return;
      lastLaunchScanAt = now;
      const discovered = yield* adapter.discoverHotPools(config.launchScanUniverseSize ?? 500);
      function handleEmptyLaunchUniverse(): void {
        logger.warn("Launch radar: hot-pool fetch returned nothing");
        // Fail closed for new launch entries (issue #201 review P2): the
        // executable snapshot could not be refreshed — a stale set must not
        // keep pools executable past their launch age or after they lose the
        // launch gate's base-fee/volume/token-safety qualifications (those
        // predicates are not rechecked by the per-pool decision chain).
        if (config.launchExecutionEnabled === true) {
          launchScanPools.clear();
        }
      }

      if (discovered.length === 0) {
        handleEmptyLaunchUniverse();
        return;
      }
      const gateResult = gateAndRankLaunchPools(discovered, launchGateConfig(config, now));
      gateAndRankLaunchPools(discovered, launchGateConfig(config, now));
      // The radar's observable answer to "why nothing admitted": top
      // rejection reasons with counts. A 100%-rejection universe is
      // diagnosable (age cap vs TVL cap vs token-safety floor) instead of a
      // black box.
      const rejections = summarizeLaunchRejections(gateResult.rejected);
      if (gateResult.ranked.length === 0) {
        logger.info("Launch radar: nothing admitted", {
          universe: discovered.length,
          rejections,
        });
      }
      // v2 execution lane: the admitted radar set becomes the executable
      // launch pool set, bounded to the top-K by fee yield so the per-cycle
      // RPC/decision cost stays proportional to LAUNCH_SCAN_TOP_K, not the
      // full admitted universe. Only when BOTH flags are on — the v1
      // radar-only path leaves launchScanPools empty and behavior-identical.
      function admitLaunchExecutionPools(
        ranked: ReadonlyArray<{ readonly pool: { readonly address: string } }>,
      ): void {
        if (config.launchExecutionEnabled !== true) return;
        launchScanPools.clear();
        for (const r of ranked.slice(0, config.launchScanTopK ?? 30)) {
          launchScanPools.add(r.pool.address);
        }
      }

      admitLaunchExecutionPools(gateResult.ranked);
      yield* refreshWashEvidence(config, adapter, gateResult.ranked, washEvidenceByPool);
      logger.info("Launch radar", {
        universe: discovered.length,
        admitted: gateResult.ranked.length,
        rejected: discovered.length - gateResult.ranked.length,
        rejections,
        top: gateResult.ranked.slice(0, config.launchScanTopK ?? 30).map((r) => {
          const evidence = washEvidenceByPool.get(r.pool.address);
          return {
            address: r.pool.address,
            pool: `${r.pool.tokenXSymbol ?? "?"}/${r.pool.tokenYSymbol ?? "?"}`,
            feeYield1hPct: r.feeYield1hPct,
            feeYieldWindows: r.pool.feeYieldWindows,
            volumeWindows: r.pool.volumeWindows,
            volume1hUsd: r.volume1hUsd,
            ageHours:
              r.pool.createdAtMs === undefined
                ? null
                : Math.max(0, (now - r.pool.createdAtMs) / 3_600_000),
            ...(evidence !== undefined
              ? {
                  wash: {
                    suspicious: evidence.suspicious,
                    reason: evidence.reason,
                    distinctPayers: evidence.distinctPayers,
                    tradeCount: evidence.tradeCount,
                    uniquePayerRate: evidence.uniquePayerRate,
                    txsPerSecond: evidence.txsPerSecond,
                    feeCv: evidence.feeCv,
                  },
                }
              : undefined),
          };
        }),
      });
    });

  // ─── Rotation metrics (session-scoped) ─────────────────────────────────
  // Counters since process start for the high-frequency-rotation profile:
  // ENTER/EXIT executions and the average age of tracked positions. Logged
  // at the end of every cycle so throughput is measurable, not guessed.
  let sessionEntriesExecuted = 0;
  let sessionExitsExecuted = 0;

  // ─── Scan cycle ────────────────────────────────────────────────────────

  /** Once-per-cycle closed-ledger snapshot for the PnL guards (fail-open read). */
  function readClosedLedgerForCycle(): Effect.Effect<
    Effect.Success<ReturnType<typeof db.getClosedPositions>>,
    never
  > {
    // The closed ledger is newest-first. Reuse one per-cycle snapshot for
    // both portfolio-wide and pool-local PnL guards. A read failure fails
    // open here; it must not prevent existing positions from reaching EXIT
    // evaluation.
    const needsClosedLedger =
      (config.realizedPnLHaltEnabled ?? false) || (config.poolPnlKillSwitchEnabled ?? false);
    if (!needsClosedLedger) return Effect.succeed([]);
    return db.getClosedPositions().pipe(Effect.catch(() => Effect.succeed([])));
  }

  // ── Regime gate: once-per-cycle herding assessment ──────────────────
  // ORCA (arXiv:2604.17251): systemic stress shows up as cross-asset
  // correlation collapse into lockstep BEFORE price indicators react.
  // Computed from the in-memory per-pool bin history (bin ids map
  // monotonically to price, so deltaBins × ln(1+binStep/1e4) is the
  // per-cycle return — no oracle needed). Advisory-only: an unknown or
  // sub-threshold regime changes nothing; a herding regime blocks NEW
  // ENTERs for THIS cycle only (exits are never touched). Fail-open by
  // construction: too few comparable pools → known:false → no block.
  function assessCycleHerding(): void {
    cycleHerdingBlock = false;
    if (config.regimeHerdingGateEnabled === true) {
      const seriesByPool = new Map<string, ReturnSeries>();
      for (const [addr, bins] of binHistory) {
        const bs = binStepByAddress.get(addr) ?? 0;
        if (!Number.isFinite(bs) || bs <= 0 || bins.length < 2) continue;
        const factor = Math.log(1 + bs / 10_000);
        seriesByPool.set(
          addr,
          bins.slice(1).map((b, i) => (b - bins[i]!) * factor),
        );
      }
      // The bin-history ring caps at max(VOLATILITY_LOOKBACK_SNAPSHOTS,
      // OOR_RECOVERY_LOOKBACK_CYCLES, 2) entries = cap−1 return points per
      // pool. Derive the minimum from the REAL cap — demanding more points
      // than the ring can ever hold would keep the assessment permanently
      // unknown (silent fail-open dead code). Floor 6: fewer points make
      // pairwise correlation noise; below that stay unknown instead.
      const herdingMinPoints = Math.min(12, Math.max(6, binHistoryCap - 1));
      const herding = assessHerding(seriesByPool, { minPoints: herdingMinPoints });
      cycleHerdingBlock =
        herding.known &&
        herdingBlocksEntry(herding, {
          edgeDensityThreshold: config.regimeHerdingEdgeThreshold,
          meanCorrThreshold: config.regimeHerdingCorrThreshold,
        });
      if (herding.known) {
        console.info(
          `[regime-gate] herding known: pairs=${herding.pairCount} meanCorr=${herding.meanCorrelation.toFixed(3)} edgeDensity=${herding.edgeDensity.toFixed(2)} block=${cycleHerdingBlock}`,
        );
      }
    }
  }

  // Rolling realized-PnL loss halt (REALIZED_PNL_HALT_*): computed ONCE per
  // cycle from the closed-position ledger so a single cycle shares one
  // consistent verdict across every ENTER lane (the risk gate consumes it
  // for normal/market/runner/launch/idle-redeploy/fallen-angel/proposals).
  // The anti-bleed breaker for churn lanes that burn swap/spread cost + IL
  // faster than fee capture. Recomputed next cycle → auto-lifts when the
  // strategy nets back above the threshold. Fail-open on a DB read failure
  // (leaves the flag false — no unexpected freeze) with a warning.
  function evaluateCycleRealizedPnlHalt(
    closedPositionsForCycle: Effect.Success<ReturnType<typeof db.getClosedPositions>>,
  ): boolean {
    if (config.realizedPnLHaltEnabled ?? false) {
      const halted = rollingRealizedPnlHaltSignal(
        closedPositionsForCycle.map((p) => p.realizedPnlUsd),
        config.realizedPnLHaltWindow ?? 100,
        config.realizedPnLHaltThresholdUsd ?? -20,
      );
      if (halted) {
        console.warn(
          `[rolling-pnl-halt] trailing realized PnL across last ${config.realizedPnLHaltWindow ?? 100} closes < $${(config.realizedPnLHaltThresholdUsd ?? -20).toFixed(0)} — pausing new ENTERs; EXIT/REBALANCE remain free`,
        );
      }
      return halted;
    }
    return false;
  }

  // Pool-local realized-PnL kill switch. This only arms a persisted
  // ENTER cooldown; open positions remain in the active scan set and
  // continue through the normal EXIT/REBALANCE path. The latest position
  // id is included in the reason so an expired cooldown is not repeatedly
  // re-armed from the exact same stale ledger observation.
  function runPoolPnlKillSwitch(
    closedPositionsForCycle: Effect.Success<ReturnType<typeof db.getClosedPositions>>,
  ): Effect.Effect<void, never> {
    if (!(config.poolPnlKillSwitchEnabled ?? false)) return Effect.void;
    return Effect.gen(function* () {
      const trips = findPoolPnlKillSwitchTrips(closedPositionsForCycle, {
        minClosedPositions: config.poolPnlKillSwitchMinClosedPositions ?? 10,
        thresholdUsd: config.poolPnlKillSwitchThresholdUsd ?? -15,
      });
      for (const trip of trips) {
        const now = Date.now();
        const existing = yield* db
          .getPoolCooldown(trip.poolAddress)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        const latestPositionId = trip.positionIds[0] ?? "unknown";
        const observationMarker = `[pool-pnl-kill-switch] ${latestPositionId}`;
        // Do not re-arm forever from an unchanged trailing window after the
        // cooldown expires. A newer close changes the marker and can trip it
        // again with fresh evidence.
        const desiredUntil = now + (config.poolPnlKillSwitchCooldownMs ?? 48 * 60 * 60 * 1000);
        if (shouldSkipKillSwitchRearm(existing, observationMarker, desiredUntil)) continue;
        const cooldown = buildKillSwitchCooldown(
          trip.poolAddress,
          trip.positionIds.length,
          trip.realizedPnlUsd,
          existing,
          desiredUntil,
          config.poolPnlKillSwitchThresholdUsd,
          observationMarker,
        );
        yield* db.setPoolCooldown(cooldown).pipe(Effect.catch(() => Effect.void));
        console.warn(
          `[pool-pnl-kill-switch] Pool ${trip.poolAddress} cooled down until ${new Date(cooldown.cooldownUntil).toISOString()} — trailing realized PnL $${trip.realizedPnlUsd.toFixed(2)} across ${trip.positionIds.length} closes`,
        );
      }
    });
  }

  /** Autonomous settlement phase: orphan sweep, job processing, overdue pause.
   * Returns the oldest stuck-settlement age for the cycle safety evaluation. */
  function runCycleSettlementPhase(): Effect.Effect<number, never> {
    if (!autonomousExecution) return Effect.succeed(0);
    return Effect.gen(function* () {
      const settlementNow = Date.now();
      const settlementJobs: SettlementJobRecord[] = [
        ...(yield* db
          .listSettlementJobs(
            autonomousExecution.walletAddress,
            autonomousExecution.agentInstanceId,
          )
          .pipe(Effect.catch(() => Effect.succeed([])))),
      ];
      // Issue #166: sweep wallet tokens with no backing position or active
      // settlement job into fresh sell jobs, so a stranded token gets
      // re-queued automatically. New jobs process this cycle.
      if (autonomousExecution.mode !== "shadow") {
        const orphanJobs = yield* sweepOrphanSettlements({
          adapter,
          db,
          walletAddress: autonomousExecution.walletAddress,
          agentInstanceId: autonomousExecution.agentInstanceId,
          settlementMaxPendingMs: autonomousExecution.settlementMaxPendingMs,
          settlementDustUsd: autonomousExecution.settlementDustUsd,
          now: settlementNow,
        });
        for (const job of orphanJobs) {
          yield* db.saveSettlementJob(job).pipe(Effect.catch(() => Effect.void));
        }
        settlementJobs.push(...orphanJobs);
      }
      const processedJobs = yield* processSettlementJobs({
        adapter,
        db,
        jobs: settlementJobs,
        mode: autonomousExecution.mode,
        now: settlementNow,
        maxSwapSlippageBps: config.maxSwapSlippageBps,
        settlementDustUsd: autonomousExecution.settlementDustUsd,
      });
      // Issue #196 (clock skew): evaluate the overdue age against the SAME
      // clock the retry scheduling used (settlementNow) — a retry stamped
      // this cycle must never read as already-past against a fresher clock.
      const oldestSettlementAgeMs = oldestActiveSettlementAgeMs(processedJobs, settlementNow);
      const pauseAction = settlementOverduePauseAction({
        oldestStuckAgeMs: oldestSettlementAgeMs,
        settlementMaxPendingMs: config.settlementMaxPendingMs,
        activePauseReason: activeSafetyPause?.reason ?? null,
        activePauseResolved: activeSafetyPause === null || activeSafetyPause.resolvedAt !== null,
      });
      if (pauseAction.kind === "arm") {
        activeSafetyPause = {
          walletAddress: autonomousExecution.walletAddress,
          agentInstanceId: autonomousExecution.agentInstanceId,
          reason: "settlement_overdue",
          triggeredAt: settlementNow,
          resolvedAt: null,
        };
        yield* db.saveSafetyPause(activeSafetyPause).pipe(Effect.catch(() => Effect.void));
      } else if (pauseAction.kind === "resolve" && activeSafetyPause !== null) {
        // Issue #166/#196: a settlement_overdue pause must not outlive the
        // settlements that raised it — auto-resolve once nothing is in
        // flight or every job is still progressing per policy.
        activeSafetyPause = { ...activeSafetyPause, resolvedAt: settlementNow };
        yield* db.saveSafetyPause(activeSafetyPause).pipe(Effect.catch(() => Effect.void));
      }
      activeSafetyPause = yield* db
        .getSafetyPause(autonomousExecution.walletAddress, autonomousExecution.agentInstanceId)
        .pipe(Effect.catch(() => Effect.succeed(activeSafetyPause)));
      return oldestSettlementAgeMs;
    });
  }

  // Issue #182: an armed execution_failures pause must not outlive the
  // failure spike that raised it. Runs at the TOP of the cycle, before
  // any pool is decided — a resolved latch must not block the very cycle
  // that clears it. `prism resume` remains an operator override.
  function resolveCycleExecutionFailuresPause(): Effect.Effect<void, never> {
    const pause = activeSafetyPause;
    if (
      autonomousExecution &&
      pause !== null &&
      pause.resolvedAt === null &&
      pause.reason === "execution_failures" &&
      shouldAutoResolveExecutionFailuresPause({
        mode: autonomousExecution.mode,
        consecutiveExecutionFailures,
        maxConsecutiveExecutionFailures: config.maxConsecutiveExecutionFailures,
      })
    ) {
      return Effect.gen(function* () {
        activeSafetyPause = { ...pause, resolvedAt: Date.now() };
        yield* db.saveSafetyPause(activeSafetyPause).pipe(Effect.catch(() => Effect.void));
      });
    }
    return Effect.void;
  }

  // Single chain reconciliation of the wallet value for this cycle. Read
  // ONCE here and reuse for every pool's risk/sizing context — a per-pool
  // read both wasted RPC and let a transient failure blank individual
  // pools. Paper mode (and walletless live) uses the configured paper
  // portfolio as the single source of truth.
  function reconcileCycleWallet(): Effect.Effect<void, never> {
    return Effect.gen(function* () {
      let walletDegradationWarned = false;
      // Fresh cycle: a previous cycle's blocked-entry state must not leak in.
      liveEntriesBlockedRestOfCycle = false;
      if (adapter.hasWallet() && !config.paperTrading) {
        lastWalletBalanceUsd = yield* adapter.getWalletBalanceUsd().pipe(
          // Runs only on the success channel: a failed read skips this and the
          // catch below reuses the (possibly fictional) stale value, so the
          // ENTER gate stays fail-closed until a real balance is observed.
          Effect.tap(() =>
            Effect.sync(() => {
              walletEverReadSuccessfully = true;
            }),
          ),
          Effect.catch((err) => {
            // Live degradation only: a transient wallet read must never fail a
            // pool or blank a cycle's screening. Reuse the last known value
            // (stale) and warn once for this cycle, then keep evaluating.
            if (!walletDegradationWarned) {
              walletDegradationWarned = true;
              console.error("Live wallet balance unavailable; reusing last known value", {
                error: String(err),
              });
            }
            return Effect.succeed(lastWalletBalanceUsd);
          }),
        );
      } else {
        lastWalletBalanceUsd = config.paperPortfolioUsd;
      }
      // Throughput-throttle surface: unpriced wallet tokens silently shrink
      // portfolioValueUsd (fail-closed), so every ENTER is sized smaller and
      // new entries appear to "pause" with no log. Surface it once per cycle
      // when the adapter has accumulated unpriced mints (live only).
      if (!config.paperTrading) {
        const unpricedCount = getUnpricedWalletMintCount();
        if (unpricedCount > 0) {
          logger.warn("Wallet balance excludes unpriced tokens — throughput may be throttled", {
            unpricedMintCount: unpricedCount,
            walletBalanceUsd: lastWalletBalanceUsd.toFixed(2),
            paperPortfolioUsd: config.paperPortfolioUsd.toFixed(2),
          });
        }
      }
    });
  }

  // Issue #170: batch wallet-reserve gate — refresh the per-cycle native
  // SOL budget for SOL-funded entries. One read, reused by every ENTER
  // gate this cycle; a failed read leaves the budget UNKNOWN and the gate
  // skips entries fail-closed (never commit SOL the engine cannot confirm).
  function refreshCycleSolBudget(): Effect.Effect<void, never> {
    return Effect.gen(function* () {
      // The USD→lamports estimate keys off the LIVE SOL price (conservatively
      // floored at config.solPriceUsd): entry-prep sizes swaps at live prices,
      // so a stale-high SOL_PRICE_USD would under-reserve and let entries past
      // the gate fail in prep instead of being skipped. A failed live price
      // read fails closed with the balance read (price-cache hit when the
      // cycle-top wallet snapshot already priced SOL).
      entrySolBudgetLamports = 0n;
      entrySolPriceUsd = 0;
      if (adapter.hasWallet() && !config.paperTrading && solFundedEntryMode) {
        const nativeSol = yield* adapter.getNativeSolBalance().pipe(
          Effect.map((lamports) => ({ ok: true as const, lamports })),
          Effect.catch(() => Effect.succeed({ ok: false as const, lamports: 0n })),
        );
        const liveSolPrice = yield* adapter.getTokenPrices([SOL_MINT], { useFallback: false }).pipe(
          Effect.map((prices) => prices[SOL_MINT]),
          Effect.catch(() => Effect.succeed(undefined)),
        );
        const priceOk =
          liveSolPrice != null &&
          Number.isFinite(liveSolPrice) &&
          liveSolPrice > 0 &&
          // config.solPriceUsd is validated with min 0 (0 = unset); a zero
          // config price would zero the USD→lamports reservation below and
          // let entries past the gate that consume the full position size.
          config.solPriceUsd > 0;
        if (nativeSol.ok && priceOk) {
          entrySolBudgetLamports = freeEntrySolLamports(nativeSol.lamports);
          // min(config, live) is the conservative direction: a lower price
          // prices the same USD entry at MORE lamports (over-estimate is safe).
          entrySolPriceUsd = Math.min(config.solPriceUsd, liveSolPrice);
          entrySolBudgetKnown = true;
        } else {
          entrySolBudgetKnown = false;
          logger.warn(
            !nativeSol.ok
              ? "Native SOL balance unavailable — SOL-funded entries skipped this cycle (fail closed)"
              : "SOL price unavailable or unset — SOL-funded entries skipped this cycle (fail closed)",
          );
        }
      } else {
        entrySolBudgetKnown = false;
      }
    });
  }

  // Periodic wallet composition log for drift auditability (every 10 cycles).
  function logWalletComposition(): Effect.Effect<void, never> {
    if (!(adapter.hasWallet() && !config.paperTrading && scanCount % 10 === 0)) {
      return Effect.void;
    }
    return Effect.forkChild(
      Effect.gen(function* () {
        const raw = yield* Effect.all([
          adapter.getWalletHoldings().pipe(Effect.catch(() => Effect.succeed(null))),
          adapter.getNativeSolBalance().pipe(Effect.catch(() => Effect.succeed(null))),
        ]);
        const [holdings, nativeSolLamports] = raw;
        if (holdings === null || nativeSolLamports === null) {
          return;
        }
        const breakdown: Array<{ mint: string; amount: string }> = [];
        if (nativeSolLamports > 0n) {
          breakdown.push({
            mint: "(native SOL)",
            amount: (Number(nativeSolLamports) / 1e9).toFixed(6),
          });
        }
        for (const [mint, bal] of holdings.entries()) {
          breakdown.push({
            mint: `${mint.slice(0, 8)}...`,
            amount: (Number(bal.amountAtomic) / 10 ** bal.decimals).toFixed(
              Math.min(bal.decimals, 6),
            ),
          });
        }
        if (breakdown.length > 0) {
          logger.info("Wallet composition snapshot (every 10 cycles)", {
            totalUsd: lastWalletBalanceUsd.toFixed(2),
            tokens: breakdown,
            scanCount,
          });
        }
      }).pipe(Effect.catch(() => Effect.void)),
    ).pipe(Effect.asVoid);
  }

  // Per-pool decision loop: one decision per held position plus at most one
  // ENTER per pool. A processing failure fails the pool, never the cycle.
  function decidePoolsInCycle(
    cycle: AgentCycle,
    idleRedeployCandidates: IdleRedeployCandidate[],
    executedExitPools: Set<string>,
  ): Effect.Effect<void, never, EntryPrepService> {
    return Effect.gen(function* () {
      for (const poolAddress of poolsToScan) {
        // A pool yields one decision per held position plus at most one ENTER.
        const decisions = yield* evaluatePool(
          poolAddress,
          cycle,
          idleRedeployCandidates,
          executedExitPools,
        ).pipe(
          Effect.catch((err) => {
            cycle.poolsFailed++;
            coreDataFailuresThisCycle++;
            console.error("Error processing pool", { poolAddress, err: String(err) });
            try {
              errorReporter.report(err instanceof Error ? err : new Error(String(err)), {
                severity: "medium",
                cycleId: cycle.cycleId,
                poolAddress,
              });
            } catch (telemetryError) {
              console.warn("Error reporter failed while recording pool failure", {
                poolAddress,
                error: String(telemetryError),
              });
            }
            return Effect.succeed(null);
          }),
        );
        if (decisions && decisions.length > 0) {
          cycle.decisions.push(...decisions);
          cycle.poolsDecided++;
        }
        cycle.poolsScanned++;
      }
    });
  }

  // Cycle tail: redeploy pass, failure counters, safety-pause arm, pruning,
  // status report, and check-in/refresh for the next cycle.
  function finalizeScanCycle(
    cycle: AgentCycle,
    idleRedeployCandidates: IdleRedeployCandidate[],
    executedExitPools: Set<string>,
    oldestSettlementAgeMs: number,
  ): Effect.Effect<void, never, EntryPrepService> {
    return Effect.gen(function* () {
      // Idle-capital auto-redeploy pass (opt-in): when idle wallet capital
      // exceeds the threshold and qualified candidates exist, deploy into the
      // top-scored one — routed through the UNCHANGED allocation + risk tail,
      // so caps can reject/shrink but no gate is bypassed. A live-entry block
      // (failed post-tx wallet re-read earlier this cycle) skips the pass so
      // allocation math never runs on a stale balance.
      if (
        shouldRunIdleRedeploy(
          config.idleRedeployEnabled,
          idleRedeployCandidates.length,
          liveEntriesBlockedRestOfCycle,
        )
      ) {
        yield* runIdleRedeployPass(idleRedeployCandidates, cycle, executedExitPools);
      }
      consecutiveCoreDataFailures = updateCoreDataFailureCounter(
        consecutiveCoreDataFailures,
        cycle.poolsScanned,
        coreDataFailuresThisCycle,
      );
      // Issue #182: quiet-cycle decay BEFORE the arm evaluates — a cycle with
      // no execution failures resets the consecutive counter, so a stale
      // breach from a previous spike can never re-arm the pause in the same
      // pass the cycle-top resolver cleared it (which would toggle the latch
      // every cycle instead of letting it stay resolved).
      consecutiveExecutionFailures = decayExecutionFailureCounter(
        consecutiveExecutionFailures,
        executionFailuresThisCycle,
      );
      if (isSafetyPauseArmed(autonomousExecution, activeSafetyPause)) {
        const pauseReason = shouldTriggerSafetyPause({
          dailyDrawdownPct,
          maxDailyDrawdownPct: config.maxDailyDrawdownPct,
          consecutiveCoreDataFailures,
          consecutiveExecutionFailures,
          maxConsecutiveExecutionFailures: config.maxConsecutiveExecutionFailures,
          oldestSettlementAgeMs,
          settlementMaxPendingMs: config.settlementMaxPendingMs,
        });
        if (pauseReason) {
          activeSafetyPause = {
            walletAddress: autonomousExecution.walletAddress,
            agentInstanceId: autonomousExecution.agentInstanceId,
            reason: pauseReason,
            triggeredAt: Date.now(),
            resolvedAt: null,
          };
          yield* db.saveSafetyPause(activeSafetyPause).pipe(Effect.catch(() => Effect.void));
        }
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
        rotation: {
          entriesExecuted: sessionEntriesExecuted,
          exitsExecuted: sessionExitsExecuted,
          avgPositionAgeMin: Number(
            avgTrackedPositionAgeMin(trackedPositions, Date.now()).toFixed(1),
          ),
        },
      });
      // Prune expired memories after each cycle
      yield* memory.pruneExpired().pipe(Effect.catch(() => Effect.void));
      // Prune pool_snapshots past the retention window (they grow every
      // cycle). Runs at most once per day; the first cycle prunes immediately.
      const nowForPrune = Date.now();
      if (nowForPrune - lastSnapshotPruneAt > SNAPSHOT_PRUNE_INTERVAL_MS) {
        lastSnapshotPruneAt = nowForPrune;
        const cutoff = nowForPrune - config.snapshotRetentionDays * 86_400_000;
        const pruned = yield* db.pruneSnapshots(cutoff).pipe(Effect.catch(() => Effect.succeed(0)));
        if (pruned > 0) {
          console.info("[snapshot-retention] Pruned old pool snapshots", {
            pruned,
            retentionDays: config.snapshotRetentionDays,
          });
        }
      }
      // Report engine status to the Prism Cloud API after every scan cycle.
      // PnL is the aggregate UNREALIZED figure across tracked positions and
      // INCLUDES claimed fees + claimed rewards (which live on PositionRecord, not
      // the reduced PositionSnapshot), matching the canonical unrealized-PnL
      // formula in engine/pnl.ts. Forked fire-and-forget so a transient report
      // never blocks the cycle.
      {
        const pnl = computeCycleUnrealizedPnl(trackedPositions);
        yield* Effect.forkChild(postEngineStatus("running", trackedPositions.size, pnl)).pipe(
          Effect.asVoid,
        );
      }
      scanCount += 1;
      yield* maybeSendAgentCheckin("periodic").pipe(Effect.catch(() => Effect.void));
      yield* refreshAgentState();
    });
  }

  const runScanCycle = (): Effect.Effect<void, never, EntryPrepService> =>
    Effect.gen(function* () {
      coreDataFailuresThisCycle = 0;
      assessCycleHerding();
      const closedPositionsForCycle = yield* readClosedLedgerForCycle();
      const cycleRealizedPnlHalted = evaluateCycleRealizedPnlHalt(closedPositionsForCycle);
      yield* runPoolPnlKillSwitch(closedPositionsForCycle);

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
        rollingRealizedPnlHalted: cycleRealizedPnlHalted,
      };

      console.info("Scan cycle started", { cycleId: cycle.cycleId });

      yield* refreshAutonomousCandidates(scanCount);
      yield* refreshFallenAngelCandidates(scanCount);
      yield* refreshMarketUniverse(Date.now());
      yield* refreshLaunchScan(Date.now());
      // The universe refresh may have rebuilt the market top-K — make the
      // fresh active set visible to the "no pools" check and the scan loop.
      rebuildPoolsToScan();
      const oldestSettlementAgeMs = yield* runCycleSettlementPhase();

      yield* resolveCycleExecutionFailuresPause();
      if (poolsToScan.length === 0) {
        console.info("No pools configured — skipping cycle");
        // Issue #182: a skipped cycle is a quiet cycle — no execution failure
        // was possible, so the consecutive counter decays like any other
        // quiet cycle (otherwise recovery lags behind skipped cycles).
        executionFailuresThisCycle = 0;
        consecutiveExecutionFailures = decayExecutionFailureCounter(
          consecutiveExecutionFailures,
          executionFailuresThisCycle,
        );
        cycle.completedAt = Date.now();
        return;
      }

      // F6: tick paper-trading day counter once per cycle.
      if (config.paperTrading) {
        yield* tickPaperDays;
      }

      yield* reconcileCycleWallet();
      yield* refreshCycleSolBudget();
      yield* logWalletComposition();

      // Qualified-but-unconsumed ENTER candidates for the opt-in idle-capital
      // redeploy pass (empty and never read when the feature is off).
      const idleRedeployCandidates: IdleRedeployCandidate[] = [];
      // Follow-up 3655404926: every pool whose EXIT actually executes this cycle
      // (paper + live, deterministic or agent-adjusted). The redeploy pass
      // excludes these so an exit can never be followed by a same-cycle re-entry
      // — the no-exit-and-reenter invariant (AGENTS.md §multiple-positions).
      const executedExitPools = new Set<string>();
      // Reset AFTER the issue #182 resolve block above: the resolver reads the
      // PREVIOUS cycle's failure count, and this cycle's failures start counting
      // from here (recordExecutionOutcome increments it during the pool loop).
      executionFailuresThisCycle = 0;

      yield* decidePoolsInCycle(cycle, idleRedeployCandidates, executedExitPools);

      yield* finalizeScanCycle(
        cycle,
        idleRedeployCandidates,
        executedExitPools,
        oldestSettlementAgeMs,
      );
    });

  // ─── Agent check-ins ────────────────────────────────────────────────────────

  const buildAgentCheckin = (
    trigger: AgentRuntimeCheckin["trigger"],
  ): Effect.Effect<AgentRuntimeCheckin, Error> =>
    Effect.gen(function* () {
      const recentDecisions = yield* audit
        .getRecentDecisions(20)
        .pipe(Effect.catch(() => Effect.succeed([])));
      const warnings = config.agentCheckinIncludeHistory
        ? yield* memory
            .getRelevantContext("recent warnings", 10)
            .pipe(Effect.catch(() => Effect.succeed([])))
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
  ): Effect.Effect<void, Error> =>
    Effect.gen(function* () {
      if (!config.agentiveMode) return;
      if (trigger === "periodic") {
        const since = Date.now() - lastAgentCheckinAt;
        if (lastAgentCheckinAt > 0 && since < config.agentCheckinIntervalMs) return;
      } else if (!config.agentCheckinOnEvents) {
        return;
      }
      const checkin = yield* buildAgentCheckin(trigger);
      yield* agent.sendCheckin(checkin).pipe(Effect.catch(() => Effect.void));
      lastAgentCheckinAt = Date.now();
    });

  const sendAgentAlert = (
    severity: AgentRuntimeAlert["severity"],
    category: AgentRuntimeAlert["category"],
    message: string,
    ctx: { pool: PoolState; metrics: PoolMetrics; position: PositionRecord | undefined },
  ): Effect.Effect<void, Error> =>
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
        ...(position ? { position } : undefined),
      };
      yield* agent.sendAlert(alert).pipe(Effect.catch(() => Effect.void));
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

  /** Enriched pool stats + runner classification inputs for one pool-cycle. */
  interface PoolStatsOutcome {
    readonly pool: PoolState;
    readonly binArray: Effect.Success<ReturnType<typeof adapter.getBinArray>>;
    readonly datapiStats: MeteoraPoolStats | null;
    readonly poolFeeAprPct: number;
    readonly runnerAprOutlier: boolean;
    readonly runnerConsecutiveCount: number;
  }

  /** Record this cycle's fee-APR observation; persistence across the
   * confirm window keeps single-cycle spikes from qualifying a runner. */
  function recordRunnerAprObservation(
    poolAddress: string,
    poolFeeAprPct: number,
    runnerFloorApr: number,
  ): Effect.Effect<{ readonly consecutiveCount: number; readonly priorAprs: number[] }, never> {
    return Effect.gen(function* () {
      // G1: runner admission + rotation superiority must PERSIST across
      // consecutive above-floor observations — a single-cycle fee spike never
      // qualifies. The per-pool observation ring lives in the metadata table
      // (`aprob:<pool>`, newest-first, max 4). Fail-open: a metadata read
      // error yields an empty history, so a cold-start pool builds
      // observations before it can qualify.
      const RUNNER_OBS_RING = 4;
      const aprObsRaw = yield* db
        .getMetadata(`aprob:${poolAddress}`)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      let aprObs: Array<{ at: number; apr: number }> = [];
      if (aprObsRaw) {
        try {
          // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
          const parsed = JSON.parse(aprObsRaw) as Array<{ at: number; apr: number }>;
          if (Array.isArray(parsed)) aprObs = parsed;
        } catch {
          aprObs = [];
        }
      }
      const obsNow = Date.now();
      const aprObservations = [{ at: obsNow, apr: poolFeeAprPct }, ...aprObs].slice(
        0,
        RUNNER_OBS_RING,
      );
      yield* db
        .setMetadata(`aprob:${poolAddress}`, JSON.stringify(aprObservations))
        .pipe(Effect.catch(() => Effect.void));
      const runnerMaxGapMs = (config.scanIntervalMs ?? 600_000) * 3;
      return {
        consecutiveCount: consecutiveAboveFloorObservations(
          aprObservations,
          runnerFloorApr,
          obsNow,
          runnerMaxGapMs,
        ),
        priorAprs: aprObs.map((o) => o.apr),
      };
    });
  }

  // Real pool stats, resolved datapi (primary) > geckoterminal (secondary)
  // > dexscreener (secondary resilience) > the adapter's fabricated
  // heuristic (last-resort safety net). The chosen source is tagged onto the
  // pool so the volume/fee gates skip heuristic fiction instead of acting on
  // it. Data-API-exclusive safety signals are never sourced from gecko or
  // dexscreener: they stay null and the screener fails open on null.
  function resolvePoolStats(poolAddress: string): Effect.Effect<PoolStatsOutcome, Error> {
    return Effect.gen(function* () {
      const rawPool = yield* adapter.getPoolState(poolAddress);
      const binArray = yield* adapter.getBinArray(poolAddress);
      pushBinHistory(poolAddress, rawPool.activeBinId);
      binStepByAddress.set(poolAddress, rawPool.binStep);
      const datapiStats = yield* meteoraDatapi.getPoolData(poolAddress);
      function fetchSecondaryPoolStats(priceFeeRate: number) {
        return Effect.gen(function* () {
          const geckoStats =
            datapiStats === null && config.geckoTerminalEnabled !== false
              ? yield* gecko.getPoolStats(poolAddress, priceFeeRate)
              : null;
          const dexscreenerStats =
            datapiStats === null &&
            geckoStats === null &&
            config.dexscreenerEnabled !== false &&
            dexscreenerOption._tag === "Some"
              ? yield* dexscreenerOption.value.getPoolStats(poolAddress, priceFeeRate)
              : null;
          return { geckoStats, dexscreenerStats };
        });
      }

      // Gecko remains the preferred secondary source (dexscreener is only tried
      // when gecko itself is unavailable) so the two keyless reserves never
      // compete for the same quota.
      const { geckoStats, dexscreenerStats } = yield* fetchSecondaryPoolStats(
        0.0025 + rawPool.binStep / 10_000,
      );
      // The gecko* fee rate is the pool's binStep-derived base fee applied to
      // REAL volume (gecko's own pool_fee_percentage is null for every CL pool,
      // and DexScreener exposes no fee field at all). DexScreener carries
      // the SAME trust posture as gecko (measured volume/TVL, modeled fees, NO
      // safety signals) and is enriched through the same `enrichPoolFromGecko`
      // path, so no new `statsSource` value ripples through the trust model.
      const pool =
        datapiStats !== null
          ? enrichPoolWithDatapi(rawPool, datapiStats)
          : geckoStats !== null
            ? enrichPoolFromGecko(rawPool, geckoStats)
            : dexscreenerStats !== null
              ? enrichPoolFromGecko(rawPool, dexscreenerStats)
              : rawPool;
      // A market-scan pool whose MEASURED (datapi) fee APR clears the runner
      // floor enters with the LAUNCH posture instead of the flat normal
      // posture. Modeled gecko / heuristic fees never classify a runner.
      const poolFeeAprPct = pool.tvlUsd > 0 ? (pool.fees24hUsd * 365 * 100) / pool.tvlUsd : 0;
      const runnerFloorApr = config.marketScanRunnerMinFeeApr ?? DEFAULT_RUNNER_MIN_FEE_APR;
      const runnerAprObservation = yield* recordRunnerAprObservation(
        poolAddress,
        poolFeeAprPct,
        runnerFloorApr,
      );
      const runnerConsecutiveCount = runnerAprObservation.consecutiveCount;
      poolFeeAprByAddress.set(poolAddress, { feeAprPct: poolFeeAprPct, tvlUsd: pool.tvlUsd });
      // Euphoria damper (ORCA's strongest sell signal — confidence-at-extreme
      // marks tops, not continuation): a runner whose CURRENT measured APR is
      // a vertical spike vs its OWN recent history is suppressed from BOTH
      // admission and rotation superiority. A cold-start pool (<3 prior obs)
      // fail-opens. When the spike proves durable the self-rank falls as
      // history catches up and the pool classifies again.
      const runnerAprOutlier = resolveRunnerAprOutlier(
        config.runnerAprOutlierEnabled,
        runnerAprObservation.priorAprs,
        poolFeeAprPct,
        config.runnerAprOutlierPercentile,
      );
      if (runnerAprOutlier) {
        console.info(
          `[regime-gate] runner APR self-outlier ${poolAddress} — ${poolFeeAprPct.toFixed(0)}% sits at the top of its own recent history; runner classification suppressed`,
        );
      }
      return {
        pool,
        binArray,
        datapiStats,
        poolFeeAprPct,
        runnerAprOutlier,
        runnerConsecutiveCount,
      };
    });
  }

  /** Per-cycle snapshot + W15 depeg/drain signals for one pool. */
  function capturePoolSnapshot(
    poolAddress: string,
    pool: PoolState,
    binArray: Effect.Success<ReturnType<typeof adapter.getBinArray>>,
  ) {
    return Effect.gen(function* () {
      // TVL velocity + IL price-drift need a previous reference point, so the
      // previous snapshot must be read BEFORE persisting the current one.
      // SAFETY: The enclosing statement has validated or constructed the asserted contract before this value is consumed.
      const previousSnapshots = yield* db
        .getSnapshots(poolAddress, pool.timestamp - PREVIOUS_SNAPSHOT_WINDOW_MS, pool.timestamp)
        // SAFETY: The runtime guard or typed fixture immediately above this assertion establishes the required invariant.
        // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
        .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<PoolSnapshot>)));
      const previousSnapshot =
        previousSnapshots.length > 0 ? previousSnapshots[previousSnapshots.length - 1] : undefined;
      const w15Signals = detectDepegAndLiquidityDrain(pool, previousSnapshots, config);
      // Persist a snapshot every cycle (both paper and live): TVL velocity and
      // the TVL-drop EXIT are dead code without per-cycle history. The full
      // bin-array detail is only stored under ENABLE_SNAPSHOT_CAPTURE (paper)
      // as before; routine rows stay lightweight.
      yield* db
        .saveSnapshot({
          poolAddress: poolAddress,
          timestamp: pool.timestamp,
          activeBinId: pool.activeBinId,
          tvlUsd: pool.tvlUsd,
          volume24hUsd: pool.volume24hUsd,
          fees24hUsd: pool.fees24hUsd,
          apr: pool.apr,
          currentPrice: pool.currentPrice,
          binStep: pool.binStep,
          statsSource: pool.statsSource,
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
          Effect.catch((err) => {
            console.warn("Snapshot save failed", { pool: poolAddress, err });
            return Effect.void;
          }),
        );
      return { previousSnapshot, previousSnapshots, w15Signals };
    });
  }

  /** Freeze-leg adjudication status from the token-risk overlay. */
  /** Freeze-enablement + stablecoin-trust classification per leg. */
  interface FreezeTrustClassification {
    readonly freezeEnabledX: boolean;
    readonly freezeEnabledY: boolean;
    readonly trustedX: boolean;
    readonly trustedY: boolean;
    readonly untrustedFreezeX: boolean;
    readonly untrustedFreezeY: boolean;
  }

  function classifyFreezeTrust(
    pool: PoolState,
    datapiStats: MeteoraPoolStats | null,
    authX: Effect.Success<ReturnType<typeof adapter.getMintAuthorities>> | null,
    authY: Effect.Success<ReturnType<typeof adapter.getMintAuthorities>> | null,
  ): FreezeTrustClassification {
    const freezeEnabledX = isFreezeAuthorityEnabled(
      datapiStats?.tokenXFreezeAuthorityDisabled,
      authX?.freezeAuthority,
    );
    const freezeEnabledY = isFreezeAuthorityEnabled(
      datapiStats?.tokenYFreezeAuthorityDisabled,
      authY?.freezeAuthority,
    );
    const trustedX = isTrustedMint(config.stablecoinMints, pool.tokenX);
    const trustedY = isTrustedMint(config.stablecoinMints, pool.tokenY);
    return {
      freezeEnabledX,
      freezeEnabledY,
      trustedX,
      trustedY,
      untrustedFreezeX: hasUntrustedFreeze(freezeEnabledX, trustedX),
      untrustedFreezeY: hasUntrustedFreeze(freezeEnabledY, trustedY),
    };
  }
  type FreezeLegStatus = "datapiVerified" | "sus" | "goPlusRisk" | "jupiterVerified" | "unknown";

  // Safety screening (fail-closed on positive signals, fail-open on
  // transport errors): Data-API flags, on-chain authorities, blacklists,
  // freeze-authority screening via the token-risk overlay. Returns a
  // rejected HOLD decision, or null when the pool passes.
  function screenPoolSafety(
    poolAddress: string,
    cycleId: string,
    pool: PoolState,
    datapiStats: MeteoraPoolStats | null,
  ): Effect.Effect<ReadonlyArray<AgentDecision> | null, never> {
    const recordSafetyWarning = (content: string) =>
      memory
        .upsert({ category: "warning", content, poolAddress })
        .pipe(Effect.catch(() => Effect.void));
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
          .pipe(Effect.catch(() => Effect.void));
        yield* recordSafetyWarning(`Safety screening rejected ${poolAddress}: ${reason}`);
        return [];
      });
    return Effect.gen(function* () {
      // 1. Meteora Data API flags: is_blacklisted, freeze_authority_disabled.
      if (datapiStats?.isBlacklisted === true) {
        return yield* rejectForSafety("Meteora Data API flags pool as blacklisted");
      }
      // 2. On-chain mint accounts: mint authority doubles as the documented
      //    deployer fallback for the deployer blacklist.
      const fetchAuthorities = (mint: string) =>
        adapter.getMintAuthorities(mint).pipe(
          Effect.catch((err) => {
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
      // G5 transfer-tax screen (rule: abnormal transfer taxes are
      // inadmissible — high fees never override a failed safety gate).
      function checkTransferFeeLegs(): Effect.Effect<string | null, never> {
        if (config.allowTransferFeeTokens === true) return Effect.succeed(null);
        const feeLegs = [
          { mint: pool.tokenX, symbol: pool.tokenXSymbol, auth: authX },
          { mint: pool.tokenY, symbol: pool.tokenYSymbol, auth: authY },
        ];
        const feeChargingLegs = feeLegs.filter((leg) => leg.auth?.transferFeeEnabled === true);
        if (feeChargingLegs.length === 0) return Effect.succeed(null);
        return Effect.succeed(
          `leg ${feeChargingLegs
            .map((leg) => leg.symbol)
            .join(", ")} charges a transfer fee (ALLOW_TRANSFER_FEE_TOKENS not enabled)`,
        );
      }

      const feeReject = yield* checkTransferFeeLegs();
      if (feeReject) return yield* rejectForSafety(feeReject);
      // ─── Hot-lane rug precondition — mint authority (market-scan/runner) ──
      // A non-trusted leg with a live mint authority (not renounced) lets the
      // dev mint+dump. Trusted legs (stables + SOL) are exempt.
      function checkMintAuthorityGate(): Effect.Effect<string | null, never> {
        if (!marketScanPools.has(poolAddress)) return Effect.succeed(null);
        return Effect.succeed(
          mintAuthorityRejectReason(
            [
              {
                symbol: pool.tokenXSymbol,
                mint: pool.tokenX,
                mintAuthority: authX?.mintAuthority,
                verified: datapiStats?.tokenXVerified ?? undefined,
              },
              {
                symbol: pool.tokenYSymbol,
                mint: pool.tokenY,
                mintAuthority: authY?.mintAuthority,
                verified: datapiStats?.tokenYVerified ?? undefined,
              },
            ],
            config.stablecoinMints ?? new Set<string>(),
            config.marketScanRequireRenouncedMint,
            config.marketScanVerifiedExemptMinTvlUsd,
            pool.tvlUsd,
          ),
        );
      }

      const mintReject = yield* checkMintAuthorityGate();
      if (mintReject) return yield* rejectForSafety(mintReject);
      // Deterministic local rejection precedes any network lookup: a pool
      // whose token or deployer is already in the loaded blacklist rejects
      // here, without consuming the token-risk overlay's fetch budget/timeout.
      const blacklistRejection = yield* blacklist
        .checkPool(
          poolAddress,
          pool.tokenX,
          pool.tokenY,
          resolveMintAuthority(authX),
          resolveMintAuthority(authY),
        )
        .pipe(
          // SAFETY: The preceding branch or fixture establishes the asserted contract before this operation.
          Effect.as(null as string | null),
          Effect.catchIf(
            (err): err is BlacklistError => err instanceof BlacklistError,
            (err) => Effect.succeed(err.message),
          ),
          Effect.catch((err) => {
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

      // 4. Freeze authority screening: a freeze-enabled untrusted leg is
      //    adjudicated by the lazy Jupiter/Data-API token-risk overlay.
      return yield* screenFreezeAuthority(poolAddress, cycleId, pool, datapiStats, authX, authY);
    });
  }

  // Per-leg trust exemption: a freeze-enabled leg is exempt when its mint is
  // on the trusted stablecoin allowlist (STABLECOIN_MINTS). The pool is
  // rejected only when a NON-trusted leg has freeze authority enabled. Data
  // API blacklisting above stays fail-closed — the allowlist never exempts it.
  function screenFreezeAuthority(
    poolAddress: string,
    cycleId: string,
    pool: PoolState,
    datapiStats: MeteoraPoolStats | null,
    authX: Effect.Success<ReturnType<typeof adapter.getMintAuthorities>> | null,
    authY: Effect.Success<ReturnType<typeof adapter.getMintAuthorities>> | null,
  ): Effect.Effect<ReadonlyArray<AgentDecision> | null, never> {
    const recordSafetyWarning = (content: string) =>
      memory
        .upsert({ category: "warning", content, poolAddress })
        .pipe(Effect.catch(() => Effect.void));
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
          .pipe(Effect.catch(() => Effect.void));
        yield* recordSafetyWarning(`Safety screening rejected ${poolAddress}: ${reason}`);
        return [];
      });
    return Effect.gen(function* () {
      const {
        freezeEnabledX,
        freezeEnabledY,
        trustedX,
        trustedY,
        untrustedFreezeX,
        untrustedFreezeY,
      } = classifyFreezeTrust(pool, datapiStats, authX, authY);
      if (!(freezeEnabledX || freezeEnabledY)) return null;
      if (!untrustedFreezeX && !untrustedFreezeY) {
        // Every freeze-enabled leg is a trusted stablecoin — exempt.
        const exempted = describeExemptedFreezeLegs(
          pool,
          freezeEnabledX,
          trustedX,
          freezeEnabledY,
          trustedY,
        );
        logger.info("Freeze authority exempted via trusted stablecoin allowlist", {
          pool: poolAddress,
          exempted,
        });
        return null;
      }
      // Token-risk overlay (Wave 18): smart detection for UNTRUSTED
      // freeze-enabled legs. LAZY — Jupiter is consulted only when the
      // overlay is enabled AND an untrusted leg is freeze-enabled.
      function consultFreezeRiskOverlay(): Effect.Effect<
        ReadonlyMap<string, TokenRiskSignal>,
        never
      > {
        if (config.jupiterTokenRiskEnabled === false) {
          return Effect.succeed(new Map<string, TokenRiskSignal>());
        }
        return Effect.promise(() => consultTokenRisks([pool.tokenX, pool.tokenY], config));
      }

      const riskByMint = yield* consultFreezeRiskOverlay();
      const flaggedLegs = classifyFreezeLegs(
        pool,
        datapiStats,
        untrustedFreezeX,
        untrustedFreezeY,
        riskByMint,
      );
      const susLegs = flaggedLegs.filter((leg) => leg.status === "sus");
      if (susLegs.length > 0) {
        return yield* rejectForSafety(
          `Jupiter token audit flags ${describeFreezeLegs(susLegs)} as suspicious (isSus) with freeze authority enabled`,
        );
      }
      const goPlusLegs = flaggedLegs.filter((leg) => leg.status === "goPlusRisk");
      if (goPlusLegs.length > 0) {
        return yield* rejectForSafety(
          `GoPlus token security flags ${describeFreezeLegs(goPlusLegs)} as a contract-level risk with freeze authority enabled`,
        );
      }
      return yield* resolveUnknownFreezeLegs(poolAddress, cycleId, pool, flaggedLegs);
    });
  }

  /** Adjudicate untrusted freeze-enabled legs (isSus first — no exemption cancels it). */
  function classifyFreezeLegs(
    pool: PoolState,
    datapiStats: MeteoraPoolStats | null,
    untrustedFreezeX: boolean,
    untrustedFreezeY: boolean,
    riskByMint: ReadonlyMap<string, TokenRiskSignal>,
  ): Array<{ symbol: string; mint: string; status: FreezeLegStatus }> {
    // isSus and GoPlus hard-risk are checked BEFORE any exemption: a
    // flagged token is rejected even if the Data API marks it verified —
    // one spoofed positive must not cancel the only hard rejects.
    const classifyLeg = (
      flagged: boolean,
      datapiVerified: boolean,
      mint: string,
    ): FreezeLegStatus | null => {
      if (!flagged) return null;
      const signal = riskByMint.get(mint);
      if (signal?.isSus === true) return "sus";
      if (signal?.goPlusHardRisk != null) return "goPlusRisk";
      if (datapiVerified) return "datapiVerified";
      if (signal?.isVerified === true) return "jupiterVerified";
      return "unknown";
    };
    const flaggedLegs: Array<{ symbol: string; mint: string; status: FreezeLegStatus }> = [];
    const legXStatus = classifyLeg(
      untrustedFreezeX,
      datapiStats?.tokenXVerified === true,
      pool.tokenX,
    );
    if (legXStatus !== null) {
      flaggedLegs.push({ symbol: pool.tokenXSymbol, mint: pool.tokenX, status: legXStatus });
    }
    const legYStatus = classifyLeg(
      untrustedFreezeY,
      datapiStats?.tokenYVerified === true,
      pool.tokenY,
    );
    if (legYStatus !== null) {
      flaggedLegs.push({ symbol: pool.tokenYSymbol, mint: pool.tokenY, status: legYStatus });
    }
    return flaggedLegs;
  }

  /** Describe flagged legs for audit strings. */
  function describeFreezeLegs(legs: ReadonlyArray<{ symbol: string; mint: string }>): string {
    return legs.map((leg) => `${leg.symbol} (${leg.mint})`).join(" and ");
  }

  /** Verified legs pass with provenance; unknown legs smart-screen or strictly reject. */
  function resolveUnknownFreezeLegs(
    poolAddress: string,
    cycleId: string,
    pool: PoolState,
    flaggedLegs: Array<{ symbol: string; mint: string; status: FreezeLegStatus }>,
  ): Effect.Effect<ReadonlyArray<AgentDecision> | null, never> {
    const recordSafetyWarning = (content: string) =>
      memory
        .upsert({ category: "warning", content, poolAddress })
        .pipe(Effect.catch(() => Effect.void));
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
          .pipe(Effect.catch(() => Effect.void));
        yield* recordSafetyWarning(`Safety screening rejected ${poolAddress}: ${reason}`);
        return [];
      });
    return Effect.gen(function* () {
      for (const leg of flaggedLegs) {
        if (leg.status === "datapiVerified") {
          logger.warn("Freeze authority exempted via Data API verification", {
            pool: poolAddress,
            token: `${leg.symbol} (${leg.mint})`,
          });
          yield* recordSafetyWarning(
            `${leg.symbol} (${leg.mint}) is a verified token (Meteora Data API) with freeze authority — exempted`,
          );
        } else if (leg.status === "jupiterVerified") {
          logger.warn("Freeze authority passed via Jupiter verification", {
            pool: poolAddress,
            token: `${leg.symbol} (${leg.mint})`,
          });
          yield* recordSafetyWarning(
            `${leg.symbol} (${leg.mint}) is a Jupiter Verified token with freeze authority — passed by risk overlay`,
          );
        }
      }
      const unknownLegs = flaggedLegs.filter((leg) => leg.status === "unknown");
      if (unknownLegs.length > 0) {
        if (config.freezeSmartScreening === true) {
          // Smart screening: pass the untrusted freeze-enabled pool through to
          // the quality pipeline (pre-filters / confidence / risk gates remain
          // the backstop). No rejected [safety] HOLD audit — the pool genuinely
          // continues processing.
          logger.warn("Freeze authority passed to quality pipeline (smart screening)", {
            pool: poolAddress,
            freezeEnabled: describeFreezeLegs(unknownLegs),
          });
          yield* recordSafetyWarning(
            `Freeze authority enabled on ${describeFreezeLegs(unknownLegs)} for ${poolAddress}; FREEZE_SMART_SCREENING active — quality pipeline decides`,
          );
        } else {
          return yield* rejectForSafety(
            `Freeze authority enabled on ${describeFreezeLegs(unknownLegs)}; add trusted stablecoin mints to STABLECOIN_MINTS to exempt, or set FREEZE_SMART_SCREENING=true`,
          );
        }
      }
      return null;
    });
  }

  /** Pre-filter + memory recall (null = pre-filtered, pool skipped). Metrics
   * are computed inline by the caller so the hot-window lane keeps its
   * original position between the metric warning and the pre-filter. */
  function gatePoolQuality(poolAddress: string, pool: PoolState, metrics: PoolMetrics) {
    return Effect.gen(function* () {
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
        return null;
      }
      // Check memory for warnings
      const warnings = yield* memory
        .getRelevantContext(`warnings for pool ${poolAddress}`, 3, poolAddress)
        .pipe(Effect.catch(() => Effect.succeed([])));
      const hasRecentWarning = warnings.some(
        (w) => w.category === "warning" && w.createdAt > Date.now() - 7 * 24 * 60 * 60 * 1000,
      );
      return { metrics, warnings, hasRecentWarning };
    });
  }

  /** Hot-window daily state: loss-halt flag, day key, consumed trip budget. */
  function readHotWindowDayState(nowMs: number, dailyLossHaltUsd: number) {
    return Effect.gen(function* () {
      // Daily loss halt: sum today's closed hot-window realized PnL.
      let halted = false;
      const closedHot = yield* db.getClosedPositions().pipe(
        Effect.catch(() =>
          Effect.succeed(
            // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
            [] as ReadonlyArray<{
              positionMode?: string | null;
              closedAt: number | null;
              paperExitedAt: number | null;
              realizedPnlUsd: number | null;
            }>,
          ),
        ),
      );
      const todayClosed: Array<{ at: number; realized: number }> = closedHot
        .filter((r) => r.positionMode === "hot-window")
        .map((r) => ({
          at: r.closedAt ?? r.paperExitedAt ?? 0,
          realized: r.realizedPnlUsd ?? 0,
        }));
      const dayKey = hotWindowDayKey(nowMs);
      let todaysRealizedHot = 0;
      for (const r of todayClosed)
        if (hotWindowDayKey(r.at) === dayKey) todaysRealizedHot += r.realized;
      if (todaysRealizedHot < -dailyLossHaltUsd) halted = true;
      // Trip budget for today.
      const tripsRaw = yield* db
        .getMetadata(`hot_trips:${dayKey}`)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      const tripsToday = tripsRaw === null ? 0 : Number(tripsRaw) || 0;
      return { halted, dayKey, tripsToday };
    });
  }

  /** Hot-window config bundle for one pool-cycle. */
  interface HotWindowCycleConfig {
    readonly enabled: true;
    readonly entrySizeUsd: number;
    readonly maxPoolTvlUsd: number;
    readonly minPoolTvlUsd: number;
    readonly printingRatio1h: number;
    readonly minSharePct: number;
    readonly maxSharePct: number;
    readonly holdMaxMs: number;
    readonly maxTripsPerDay: number;
    readonly dailyLossHaltUsd: number;
    readonly maxOpen: number;
    readonly volumeSpike:
      | {
          readonly baselineWindow: number;
          readonly spikeRatio: number;
          readonly minPoints: number;
          readonly minVolumeUsd: number;
        }
      | undefined;
  }

  /** Exit lifecycle for held hot positions. */
  function evaluateHotWindowExits(
    hotPositions: PositionRecord[],
    hotCfg: HotWindowCycleConfig,
    nowMs: number,
    halted: boolean,
  ): AgentDecision[] {
    const hotDecisions: Array<AgentDecision> = [];
    for (const p of hotPositions) {
      const exitEval = evaluateHotWindowExit({
        config: hotCfg,
        ageMs: nowMs - p.timestamp,
        outOfRangeSince: p.outOfRangeSince,
        halted,
      });
      if (exitEval.exit) {
        hotDecisions.push({
          action: "EXIT",
          poolAddress: p.poolAddress,
          positionId: p.positionId,
          confidence: 1,
          reasoning: `[hot-window:${exitEval.reason}] ${p.positionId} (halted=${halted}, age ${((nowMs - p.timestamp) / 60_000).toFixed(0)}m, hold ${hotCfg.holdMaxMs / 60_000}m)`,
        });
      }
    }
    return hotDecisions;
  }

  /** ENTER a currently-printing, correctly-sized pool (no hot held, no non-hot held). */
  function qualifyHotWindowEnter(
    poolAddress: string,
    pool: PoolState,
    datapiStats: MeteoraPoolStats | null,
    hotCfg: HotWindowCycleConfig,
    nowMs: number,
    tripsToday: number,
  ): Effect.Effect<
    { readonly hotEnter: AgentDecision | null; readonly hotSkipReason: string },
    never
  > {
    return Effect.gen(function* () {
      // Flash trigger B (volume burst): fees lag volume, so a measured
      // burst against the pool's OWN trailing snapshot baseline is the
      // EARLY entry signal while the 1h fee ratio still lags its floor.
      // Measured stats only (datapi/gecko rows); modeled heuristic volume
      // never classifies. Fail-open: thin history or unmeasured source →
      // no verdict → trigger A rules alone.
      function detectHotVolumeBurst(): Effect.Effect<
        { readonly verdict: VolumeSpikeResult | null; readonly measuredVolume24h: number | null },
        never
      > {
        return Effect.gen(function* () {
          if (
            hotCfg.volumeSpike === undefined ||
            (pool.statsSource !== "datapi" && pool.statsSource !== "geckoterminal")
          ) {
            return { verdict: null, measuredVolume24h: null };
          }
          const volWindowMs = Math.max(
            30 * 60_000,
            (hotCfg.volumeSpike.baselineWindow + 3) * (config.scanIntervalMs ?? 600_000),
          );
          const volSnaps = yield* db.getSnapshots(poolAddress, nowMs - volWindowMs, nowMs).pipe(
            Effect.catch(() =>
              // SAFETY: The fallback literal satisfies the declared readonly array type.
              Effect.succeed([] as ReadonlyArray<PoolSnapshot>),
            ),
          );
          const measuredVols = volSnaps
            .filter((s) => s.statsSource === "datapi" || s.statsSource === "geckoterminal")
            .map((s) => s.volume24hUsd);
          if (measuredVols.length === 0) {
            return { verdict: null, measuredVolume24h: null };
          }
          return {
            verdict: detectVolumeSpike({
              volumes: measuredVols,
              baselineWindow: hotCfg.volumeSpike.baselineWindow,
              spikeRatio: hotCfg.volumeSpike.spikeRatio,
              minPoints: hotCfg.volumeSpike.minPoints,
            }),
            measuredVolume24h: pool.volume24hUsd,
          };
        });
      }

      const burst = yield* detectHotVolumeBurst();
      const volumeSpikeVerdict = burst.verdict;
      const measuredVolume24h = burst.measuredVolume24h;
      const enterEval = evaluateHotWindowEnter({
        config: hotCfg,
        feeTvlRatio1h: datapiStats?.feeTvlRatio1h ?? null,
        tvlUsd: pool.tvlUsd,
        volumeSpike: volumeSpikeVerdict,
        volume24hUsd: measuredVolume24h,
      });
      if (enterEval.qualify) {
        const burstEntry = isHotBurstEntry(
          volumeSpikeVerdict,
          datapiStats?.feeTvlRatio1h,
          hotCfg.printingRatio1h,
        );
        return {
          hotEnter: {
            action: "ENTER",
            poolAddress,
            confidence: 0.7,
            reasoning: buildHotEnterReasoning(
              burstEntry,
              volumeSpikeVerdict?.ratio ?? null,
              datapiStats?.feeTvlRatio1h,
              pool.tvlUsd,
              enterEval.sizeUsd,
              tripsToday,
              hotCfg.maxTripsPerDay,
            ),
            positionSizeUsd: enterEval.sizeUsd,
            positionMode: "hot-window",
          } as const,
          hotSkipReason: "",
        };
      }
      return { hotEnter: null, hotSkipReason: enterEval.rejectReason ?? "rejected" };
    });
  }

  // ── Hot-window capture lane ──────────────────────────────────────────
  // A config-gated high-frequency lane that ONLY enters a pool currently
  // printing fees within a depth band so a tiny entry captures a meaningful
  // share. It fully owns any pool it holds a hot position on or is about to
  // enter — the generic loop is skipped for owned pools (no double-entry).
  // Returns decisions to emit, or null to fall through to the generic loop.
  /** Build the hot-window config bundle from operator config (pure). */
  function buildHotWindowConfig(): HotWindowCycleConfig {
    return {
      enabled: true,
      ...resolveHotWindowSizeBand(
        config.hotWindowEntrySizeUsd,
        config.hotWindowMaxPoolTvlUsd,
        config.hotWindowMinPoolTvlUsd,
        config.hotWindowPrintingRatio1h,
      ),
      minSharePct: config.hotWindowMinSharePct ?? 0.005,
      maxSharePct: config.hotWindowMaxSharePct ?? 0.05,
      holdMaxMs: config.hotWindowHoldMaxMs ?? 1_800_000,
      maxTripsPerDay: config.hotWindowMaxTripsPerDay ?? 30,
      dailyLossHaltUsd: config.hotWindowDailyLossHaltUsd ?? 3,
      maxOpen: config.hotWindowMaxOpen ?? 2,
      volumeSpike: buildHotWindowVolumeSpike(
        config.flashVolumeTriggerEnabled,
        config.flashBaselineWindow,
        config.flashMinSpikeRatio,
        config.flashMinVolumeUsd,
      ),
    };
  }

  function runHotWindowLane(
    poolAddress: string,
    pool: PoolState,
    datapiStats: MeteoraPoolStats | null,
  ): Effect.Effect<ReadonlyArray<AgentDecision> | null, never> {
    if (config.hotWindowEnabled !== true) return Effect.succeed(null);
    return Effect.gen(function* () {
      const nowMs = Date.now();
      const allPoolPositions = positionsForPool(trackedPositions, poolAddress);
      const hotPositions = allPoolPositions.filter((p) => p.positionMode === "hot-window");
      const nonHotHeld = allPoolPositions.filter((p) => p.positionMode !== "hot-window").length > 0;
      const hotCfg = buildHotWindowConfig();
      const dayState = yield* readHotWindowDayState(nowMs, hotCfg.dailyLossHaltUsd);
      // Exit lifecycle for held hot positions.
      const hotDecisions = evaluateHotWindowExits(hotPositions, hotCfg, nowMs, dayState.halted);
      // ENTER a currently-printing, correctly-sized pool (only when this pool
      // holds no hot position and carries no non-hot position this cycle).
      function resolveHotEnter(
        hotPositions: PositionRecord[],
        nonHotHeld: boolean,
        dayState: { readonly halted: boolean; readonly tripsToday: number },
        hotCfg: HotWindowCycleConfig,
        nowMs: number,
      ): Effect.Effect<
        { readonly hotEnter: AgentDecision | null; readonly hotSkipReason: string | null },
        never
      > {
        return Effect.gen(function* () {
          if (hotPositions.length > 0) {
            return { hotEnter: null, hotSkipReason: "already-holding-hot" };
          }
          if (dayState.halted) {
            return { hotEnter: null, hotSkipReason: "daily-loss-halt" };
          }
          if (nonHotHeld) {
            return { hotEnter: null, hotSkipReason: "non-hot-held" };
          }
          const openHot = Array.from(trackedPositions.values()).filter(
            (p) => p.positionMode === "hot-window",
          ).length;
          if (openHot >= hotCfg.maxOpen) {
            return { hotEnter: null, hotSkipReason: "open-cap" };
          }
          if (dayState.tripsToday >= hotCfg.maxTripsPerDay) {
            return { hotEnter: null, hotSkipReason: "trip-budget" };
          }
          const entered = yield* qualifyHotWindowEnter(
            poolAddress,
            pool,
            datapiStats,
            hotCfg,
            nowMs,
            dayState.tripsToday,
          );
          return {
            hotEnter: entered.hotEnter,
            hotSkipReason: entered.hotEnter ? null : entered.hotSkipReason,
          };
        });
      }

      const hotEnterState = yield* resolveHotEnter(
        hotPositions,
        nonHotHeld,
        dayState,
        hotCfg,
        nowMs,
      );
      const hotEnter = hotEnterState.hotEnter;
      const hotSkipReason = hotEnterState.hotSkipReason;
      // Funnel audit: every pool the lane does not enter gets one
      // attributable skip line so the idle lane is never a silent black box.
      if (hotSkipReason !== null) {
        logger.info("Hot-window skip", {
          pool: poolAddress,
          reason: hotSkipReason,
          feeTvlRatio1h: datapiStats?.feeTvlRatio1h ?? null,
          tvlUsd: pool.tvlUsd,
          tripsToday: dayState.tripsToday,
          openHot: Array.from(trackedPositions.values()).filter(
            (p) => p.positionMode === "hot-window",
          ).length,
        });
      }
      // The hot lane fully owns any pool it holds a hot position on or is
      // about to enter — return its decisions and skip the generic loop so a
      // hot pool cannot also be traded by the normal run (double-entry/double
      // decision). Pools that also hold a non-hot position fall through to the
      // generic loop (rare; the hot EXIT above is still emitted).
      if (nonHotHeld === false && (hotPositions.length > 0 || hotEnter !== null)) {
        if (hotEnter !== null) {
          yield* db
            .setMetadata(`hot_trips:${hotWindowDayKey(nowMs)}`, String(dayState.tripsToday + 1))
            .pipe(Effect.catch(() => Effect.void));
          hotDecisions.push(hotEnter);
        }
        return hotDecisions;
      }
      return null;
    });
  }

  /** Net active-bin drift + realized volatility over the recent-bin ring. */
  interface PoolDriftMetrics {
    readonly netDriftBins: number;
    readonly volatilityStddev: number;
    readonly volatilityBins: ReadonlyArray<number>;
    readonly recentBins: ReadonlyArray<number>;
  }
  function resolvePoolDriftMetrics(
    binHistory: ReadonlyMap<string, ReadonlyArray<number>>,
    poolAddress: string,
    volatilityLookbackSnapshots: number,
  ): PoolDriftMetrics {
    const recentBins = binHistory.get(poolAddress) ?? [];
    // Net active-bin drift over the recent-bin ring — the momentum signal
    // shared by the entry-shape resolution, the drift gate, and runner
    // admission. Null when the pool has no bin history (cold start): runner
    // admission fails OPEN on unknown drift (it cannot prove a decline).
    const netDriftBins =
      recentBins.length >= 2 ? recentBins[recentBins.length - 1]! - recentBins[0]! : 0;
    const lookback = Math.max(2, volatilityLookbackSnapshots);
    const volatilityBins =
      recentBins.length > lookback ? recentBins.slice(recentBins.length - lookback) : recentBins;
    return {
      netDriftBins,
      volatilityStddev: computeBinVolatilityStddev(volatilityBins),
      volatilityBins,
      recentBins,
    };
  }
  /** Deposit distribution for entries: configured shape as-is; auto picks from volatility regime. */
  function resolveEntryStrategySpec(
    entryStrategyType: EntryStrategyType,
    volatilityStddev: number,
    highVolThreshold: number,
    netDriftBins: number,
  ): EntryStrategySpec {
    if (entryStrategyType !== "auto") return entryStrategyType;
    return recommendStrategy({ volatilityStddev, highVolThreshold, netDriftBins });
  }

  /** Tail target: the decision's position plus pool-level open state. */
  interface TailPosition {
    readonly pos: PositionRecord | undefined;
    readonly hasOpenPosition: boolean;
  }
  function resolveTailPosition(
    trackedPositions: Map<string, PositionRecord>,
    decision: AgentDecision,
    poolAddress: string,
  ): TailPosition {
    return {
      pos:
        decision.positionId !== undefined ? trackedPositions.get(decision.positionId) : undefined,
      hasOpenPosition: positionsForPool(trackedPositions, poolAddress).length > 0,
    };
  }

  /**
   * Per-decision tail: overlay → supervised → risk → execution → audit.
   * Decisions run sequentially so a queued proposal consumed by one decision
   * is gone for the next, and executions mutate tracking deterministically
   * (per-position decisions first, ENTER last). An empty hold short-circuits.
   */
  function processDecisionTail(
    rawDecisions: ReadonlyArray<AgentDecision>,
    poolAddress: string,
    trackedPositions: Map<string, PositionRecord>,
    finalDecisions: Array<AgentDecision>,
    proposalBackoff: Map<string, ProposalBackoff>,
    getPoolCircuitBreaker: (poolAddress: string) => ProposalCircuitBreaker,
    runDecisionPreRisk: (
      decision: AgentDecision,
      pos: PositionRecord | undefined,
      hasOpenPosition: boolean,
    ) => Effect.Effect<
      {
        decision: AgentDecision;
        appliedQueuedProposalId: string | undefined;
        appliedAgentProposal: boolean;
        proposalValidated: boolean;
        preApplyDecision: AgentDecision | undefined;
      },
      Error
    >,
    evaluateDecisionRisk: (
      decision: AgentDecision,
      pos: PositionRecord | undefined,
      appliedAgentProposal: boolean,
      preApplyDecision: AgentDecision | undefined,
      appliedQueuedProposalId: string | undefined,
    ) => Effect.Effect<{ decision: AgentDecision; riskResult: RiskResult; denied: boolean }, Error>,
    executeDecisionTail: (
      decision: AgentDecision,
      riskResult: RiskResult,
      pos: PositionRecord | undefined,
      appliedQueuedProposalId: string | undefined,
    ) => Effect.Effect<
      {
        done: boolean;
        executed: boolean;
        executionError: string | undefined;
        executionSkipped: boolean;
        movedLiveFunds: boolean;
        movedLiveFundsFromEnter: boolean;
      },
      Error
    >,
    refreshPostExecutionWallet: (
      decision: AgentDecision,
      executed: boolean,
      movedLiveFunds: boolean,
      movedLiveFundsFromEnter: boolean,
    ) => Effect.Effect<void, Error>,
    recordPostExecutionAudit: (
      decision: AgentDecision,
      executed: boolean,
      executionError: string | undefined,
      executionSkipped: boolean,
    ) => Effect.Effect<void, Error>,
    updatePostExecutionBookkeeping: (
      decision: AgentDecision,
      executed: boolean,
      executionError: string | undefined,
      pos: PositionRecord | undefined,
      appliedQueuedProposalId: string | undefined,
      riskResult: RiskResult,
    ) => Effect.Effect<void, Error>,
  ): Effect.Effect<void, Error> {
    return Effect.gen(function* () {
      for (const rawDecision of rawDecisions) {
        let decision = rawDecision;
        // The position this decision targets (EXIT/REBALANCE/HOLD). ENTER and
        // the default positionless HOLD have none. Re-resolved against the
        // live map so executions always act on current state.
        const { pos, hasOpenPosition } = resolveTailPosition(
          trackedPositions,
          decision,
          poolAddress,
        );
        const preRisk = yield* runDecisionPreRisk(decision, pos, hasOpenPosition);
        decision = preRisk.decision;
        const riskOutcome = yield* evaluateDecisionRisk(
          decision,
          pos,
          preRisk.appliedAgentProposal,
          preRisk.preApplyDecision,
          preRisk.appliedQueuedProposalId,
        );
        decision = riskOutcome.decision;
        const riskResult = riskOutcome.riskResult;
        if (riskOutcome.denied) continue;
        // Any validated proposal that survives risk is a usable advisor response:
        // clear per-pool backoff and reset the breaker, including no-op echoes.
        recordAppliedProposalRiskApproval({
          proposalValidated: preRisk.proposalValidated,
          proposalBackoff,
          recordCircuitSuccess: () => getPoolCircuitBreaker(poolAddress).recordSuccess(),
          poolAddress,
        });
        const execResult = yield* executeDecisionTail(
          decision,
          riskResult,
          pos,
          preRisk.appliedQueuedProposalId,
        );
        if (execResult.done) continue;
        yield* refreshPostExecutionWallet(
          decision,
          execResult.executed,
          execResult.movedLiveFunds,
          execResult.movedLiveFundsFromEnter,
        );
        yield* recordPostExecutionAudit(
          decision,
          execResult.executed,
          execResult.executionError,
          execResult.executionSkipped,
        );
        yield* updatePostExecutionBookkeeping(
          decision,
          execResult.executed,
          execResult.executionError,
          pos,
          preRisk.appliedQueuedProposalId,
          riskResult,
        );
        finalDecisions.push(decision);
      }
    });
  }

  const evaluatePool = (
    poolAddress: string,
    cycle: AgentCycle,
    idleRedeployCandidates: IdleRedeployCandidate[],
    executedExitPools: Set<string>,
  ): Effect.Effect<ReadonlyArray<AgentDecision>, Error, EntryPrepService> =>
    Effect.gen(function* () {
      const cycleId = cycle.cycleId;
      const entryGates = yield* runPoolEntryGates();
      if (entryGates.halt) return entryGates.halt;
      const metrics = entryGates.metrics;
      const { warnings, hasRecentWarning } = entryGates.quality;
      const pool = entryGates.pool;
      const binArray = entryGates.binArray;
      const datapiStats = entryGates.datapiStats;
      const poolFeeAprPct = entryGates.poolFeeAprPct;
      const runnerAprOutlier = entryGates.runnerAprOutlier;
      const isMarketRunner = entryGates.isMarketRunner;
      const w15Signals = entryGates.w15Signals;

      // Decision rules
      const feeIlRatio = metrics.feeIlRatio;
      const volumeAuth = metrics.volumeAuthenticity;
      const tvlVelocity = metrics.tvlVelocity;
      const binUtilization = metrics.binUtilization;

      /** IL-dominance signal (null = gate does not apply this cycle). */
      interface IlDominanceSignal {
        readonly ilUsd: number;
        readonly hodlValueUsd: number;
        readonly feesClaimedUsd: number;
      }

      /** Lifecycle exit verdict (fallen-angel / launch / take-profit lanes). */
      interface LifecycleExit {
        readonly reasoning: string;
      }

      /** Measured 1h launch fees + tracked peak for the volume-decay gate. */
      interface LaunchFees1h {
        readonly currentFees1hUsd: number | null;
        readonly peakFees1hUsd: number | null;
      }

      // OOR tracking must run before EXIT conditions so that out-of-range
      // cycle counts accumulate even when fee/IL triggers an EXIT.
      function trackPositionRange(pos: PositionRecord): Effect.Effect<void, never> {
        return Effect.gen(function* () {
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
        });
      }

      // Per-cycle external-close reconcile: one position fetch per pool,
      // matched per position pubkey so a sibling's external close only
      // removes its own record. Returns the surviving positions.
      function reconcileExternalCloses(
        poolPositions: ReadonlyArray<PositionRecord>,
      ): Effect.Effect<PositionRecord[], never> {
        if (!(adapter.hasWallet() && poolPositions.some((p) => p.positionPubKey !== null))) {
          return Effect.succeed([...poolPositions]);
        }
        return Effect.gen(function* () {
          const walletAddress = adapter.getWalletAddress();
          if (!walletAddress) return [...poolPositions];
          const onChainPositions = yield* adapter.getPositions(poolAddress, walletAddress).pipe(
            Effect.catch((err) => {
              console.error("Per-cycle reconcile: failed to fetch positions — skipping", {
                pool: poolAddress,
                err: String(err),
              });
              return Effect.succeed(null);
            }),
          );
          if (onChainPositions === null) return [...poolPositions];
          const survivors: PositionRecord[] = [];
          for (const pos of poolPositions) {
            if (pos.positionPubKey && !onChainPositions.some((p) => p.id === pos.positionPubKey)) {
              console.warn(
                `Per-cycle reconcile: position ${pos.positionId} on ${poolAddress} no longer on-chain — removing from tracking`,
              );
              trackedPositions.delete(pos.positionId);
              yield* persist(`deletePosition ${pos.positionId}`, db.deletePosition(pos.positionId));
              yield* memory
                .upsert({
                  category: "warning",
                  content: `Position ${pos.positionId} on ${poolAddress} was closed externally during this cycle. Removed from tracking.`,
                  poolAddress,
                })
                .pipe(Effect.catch(() => Effect.void));
            } else {
              survivors.push(pos);
            }
          }
          return survivors;
        });
      }

      // Value estimation per position (feeds the trailing stop and the
      // REBALANCE gas gate). PRIMARY mark: the real on-chain position value;
      // FALLBACK: the HODL-anchored mark (or cost basis when entry legs are
      // unknown). Paper notional-fee accrual books Data-API-measured CLAIM
      // income only — never modeled or fabricated fees.
      function refreshPositionValue(pos: PositionRecord): Effect.Effect<void, never> {
        return Effect.gen(function* () {
          const realMark =
            pos.positionPubKey != null && adapter.getPositionValueUsd != null
              ? yield* adapter
                  .getPositionValueUsd(poolAddress, pos.positionPubKey)
                  .pipe(Effect.catch(() => Effect.succeed(null)))
              : null;
          // Explicit null check (not `??`): the adapter contract returns null
          // when the mark is unavailable, never 0 — a genuine 0-valued position
          // is real data (dust) and must not silently fall back to the
          // price-anchored mark.
          const estimatedValue = realMark !== null ? realMark : estimatePositionValue(pos, pool);
          pos.currentValueUsd = estimatedValue;
          const highest = pos.highestValueUsd ?? pos.depositedUsd;
          if (estimatedValue > highest) {
            pos.highestValueUsd = estimatedValue;
          }
          // Paper notional-fee accrual (parity with live): a paper position
          // never claims on-chain, so accrue its proportional share of the
          // pool's real 24h fees while the active bin sits in range. Do NOT
          // touch currentValueUsd: unrealized PnL already sums claimed fees
          // (pnl.ts), so crediting the value column too would double-add.
          function accruePaperPositionFees(): Effect.Effect<void, never> {
            return Effect.gen(function* () {
              if (
                !(
                  config.paperTrading &&
                  pos.positionPubKey == null &&
                  pool.statsSource === "datapi"
                )
              ) {
                return;
              }
              const now = Date.now();
              const lastAccrualAt = paperFeeAccrualAt.get(pos.positionId);
              paperFeeAccrualAt.set(pos.positionId, now);
              const deltaFeesUsd = computePaperFeeAccrualUsd({
                fees24hUsd: pool.fees24hUsd,
                tvlUsd: pool.tvlUsd,
                depositedUsd: pos.depositedUsd,
                activeBinId: pool.activeBinId,
                lowerBinId: pos.lowerBinId,
                upperBinId: pos.upperBinId,
                firstCycle: lastAccrualAt == null,
                elapsedMs: lastAccrualAt == null ? 0 : now - lastAccrualAt,
                scanIntervalMs: config.scanIntervalMs,
              });
              if (deltaFeesUsd <= 0) return;
              pos.cumulativeFeesClaimedUsd += deltaFeesUsd;
              yield* db
                .savePositionEvent({
                  id: randomUUID(),
                  poolAddress,
                  positionPubKey: pos.positionPubKey,
                  positionId: pos.positionId,
                  event: "CLAIM",
                  valueUsd: deltaFeesUsd,
                  feesUsd: deltaFeesUsd,
                  price: pool.currentPrice,
                  metadata: { kind: "paper_accrual" },
                  createdAt: now,
                })
                .pipe(Effect.catch(() => Effect.void));
            });
          }

          yield* accruePaperPositionFees();
          yield* persist(`savePosition ${pos.positionId}`, db.savePosition(pos));
        });
      }

      // Launch peak-fee pruning (Launch Mode v2): drop entries whose position
      // closed or left the launch lane. In-memory only — the time-box
      // exit backstops a restart.
      function pruneLaunchPeakFees(): void {
        if (config.launchScanEnabled === true && config.launchExecutionEnabled === true) {
          for (const pid of launchPeakFees1h.keys()) {
            const tracked = trackedPositions.get(pid);
            if (tracked === undefined || tracked.positionMode !== "launch") {
              launchPeakFees1h.delete(pid);
            }
          }
        }
      }

      // IL-dominance pre-check: fires only when IL protection is enabled, the
      // position is actively out of range (fees stopped accruing → pure IL
      // bleed), entry legs are known, and unrealized IL exceeds cumulative
      // fees by the configured factor and the USD floor.
      function computeIlDominance(pos: PositionRecord): IlDominanceSignal | null {
        if (
          config.ilProtectionEnabled === true &&
          pos.outOfRangeSince !== null &&
          pos.entryAmountXUsd != null &&
          pos.entryAmountYUsd != null &&
          pos.entryPriceUsd != null
        ) {
          // currentValueUsd is the heuristic estimatePositionValue mark
          // refreshed in the per-position value loop above, not an oracle
          // price; the HODL benchmark is the real on-chain entry legs.
          const hodlValueUsd = computeHodlValueUsd(
            pos.entryAmountXUsd,
            pos.entryAmountYUsd,
            pos.entryPriceUsd,
            pool.currentPrice,
          );
          if (hodlValueUsd !== null) {
            const ilUsd = hodlValueUsd - pos.currentValueUsd;
            const feesClaimedUsd = pos.cumulativeFeesClaimedUsd;
            if (
              isIlDominant(
                ilUsd,
                feesClaimedUsd,
                config.ilDominanceExitFactor,
                config.ilDominanceMinUsd,
              )
            ) {
              return { ilUsd, hodlValueUsd, feesClaimedUsd };
            }
          }
        }
        return null;
      }

      // Fallen-angel lifecycle (Wave 19): TP-ladder rung or invalidation stop.
      function evaluateFallenAngelExit(pos: PositionRecord): LifecycleExit | null {
        if (config.fallenAngelEnabled === true && pos.positionMode === "fallen-angel") {
          const faLadderParsed = parseTpLadder(pos.tpLadderJson);
          if (faLadderParsed !== null && pos.invalidationStopPrice != null) {
            const faEval = evaluateTpLadder(
              pool.currentPrice,
              faLadderParsed,
              pos.invalidationStopPrice,
            );
            if (faEval.status === "invalidation") {
              return {
                reasoning: `[fa-invalidation] Price ${pool.currentPrice.toFixed(6)} <= invalidation stop ${pos.invalidationStopPrice.toFixed(6)} — thesis broken`,
              };
            }
            if (faEval.status === "tp" && faEval.rungReached) {
              return {
                reasoning: `[fa-tp-ladder] Price ${pool.currentPrice.toFixed(6)} reached target ${faEval.rungReached.targetPrice.toFixed(6)} — scale out ${(faEval.scaleOutFraction ?? 0) * 100}%`,
              };
            }
          }
        }
        return null;
      }

      // Normal-lane take-profit: a non-FA position carrying a single-rung TP
      // ladder exits deterministically at its rung — profits lock BEFORE the
      // loss-side exits. The ladder's "invalidation" status fires nothing here.
      function evaluateTpTargetExit(pos: PositionRecord): LifecycleExit | null {
        if (
          pos.positionMode !== "fallen-angel" &&
          pos.tpLadderJson != null &&
          (config.takeProfitEnabled ?? false)
        ) {
          const tpLadderParsed = parseTpLadder(pos.tpLadderJson);
          if (tpLadderParsed !== null) {
            const tpEval = evaluateTpLadder(
              pool.currentPrice,
              tpLadderParsed,
              // The normal lane stores an invalidation price (entry ×
              // (1 − trailingStopPct)), so evaluateTpLadder can return
              // "invalidation". This branch deliberately ignores that status:
              // the trailing stop and the loss-side exits own the downside.
              // 0 is only the fallback for a legacy row with no stored price.
              pos.invalidationStopPrice ?? 0,
            );
            if (tpEval.status === "tp" && tpEval.rungReached) {
              return {
                reasoning: `[tp-target] Price ${pool.currentPrice.toFixed(6)} reached target ${tpEval.rungReached.targetPrice.toFixed(6)} — take profit`,
              };
            }
          }
        }
        return null;
      }

      // Launch 1h-fee measurement (datapi only) + tracked-peak update for the
      // volume-decay gate. A non-datapi source degrades the gate with a bounded
      // per-position warning; datapi-up-but-window-missing is routine debug.
      function measureLaunchFees1h(pos: PositionRecord): LaunchFees1h {
        const currentFees1hUsd = measureCurrentLaunchFees1h(
          pool.statsSource,
          datapiStats?.feeTvlRatio1h ?? null,
          pool.tvlUsd,
        );
        if (currentFees1hUsd === null) {
          if (pool.statsSource !== "datapi") {
            logger.warn("Launch position: 1h fees unmeasured — volume-decay gate degraded", {
              pool: pos.poolAddress,
              position: pos.positionId,
              statsSource: pool.statsSource,
            });
          } else {
            logger.debug("Launch position: 1h fees unmeasured — volume-decay gate skipped", {
              pool: pos.poolAddress,
              position: pos.positionId,
            });
          }
        }
        const peakFees1hUsd = trackLaunchFeePeak(
          launchPeakFees1h,
          pos.positionId,
          currentFees1hUsd,
        );
        return { currentFees1hUsd, peakFees1hUsd };
      }

      // Launch lifecycle (Launch Mode v2): time-box, 1h-fee volume-decay,
      // peak-value drawdown, fee/IL floor. Runs whenever a stored position is
      // a launch position — INDEPENDENT of the entry flags.
      /** Human-readable detail for a launch-lifecycle exit reason. */
      function describeLaunchExitReason(
        launchReason: string,
        pos: PositionRecord,
        fees: LaunchFees1h,
      ): string {
        if (launchReason === "timebox") {
          return describeLaunchTimeboxExit(pos.timestamp, config.launchTimeboxHours);
        }
        if (launchReason === "volume-decay") {
          return describeLaunchVolumeDecayExit(
            fees.currentFees1hUsd,
            config.launchVolumeDecayExitPct,
            fees.peakFees1hUsd,
          );
        }
        if (launchReason === "drawdown") {
          return describeLaunchDrawdownExit(
            pos.currentValueUsd,
            resolveLaunchDrawdownPct(
              pos.launchRunner,
              config.launchRunnerDrawdownPct,
              config.launchExitDrawdownPct,
            ),
            pos.highestValueUsd,
          );
        }
        if (launchReason === "fee-il") {
          return `fee/IL ${metrics.feeIlRatio.toFixed(2)} < 0.5`;
        }
        return "exit";
      }

      function evaluateLaunchExit(pos: PositionRecord, fees: LaunchFees1h): LifecycleExit | null {
        if (pos.positionMode !== "launch") return null;
        const launchExitEval = launchPositionExit({
          createdAtMs: pos.timestamp,
          now: Date.now(),
          timeboxHours: config.launchTimeboxHours ?? 6,
          volumeDecayExitPct: config.launchVolumeDecayExitPct ?? 0.1,
          // Runner mode uses the shakeout-tolerant drawdown; otherwise the crash
          // calibration applies.
          drawdownPct: resolveLaunchDrawdownPct(
            pos.launchRunner,
            config.launchRunnerDrawdownPct,
            config.launchExitDrawdownPct,
          ),
          currentFees1hUsd: fees.currentFees1hUsd,
          peakFees1hUsd: fees.peakFees1hUsd,
          currentValueUsd: pos.currentValueUsd,
          // Seed the drawdown peak from the deposit: highestValueUsd stays
          // null until the position appreciates, so an initial 25% loss
          // would otherwise never trip the drawdown gate.
          peakValueUsd: pos.highestValueUsd ?? pos.depositedUsd,
          // Fee-purity: a modeled ratio (gecko/heuristic, feeIlRatioKnown
          // false) must never fire the launch fee-il exit — null skips the
          // rule, mirroring the normal chain's feeIlRatioKnown guard.
          feeIlRatio: metrics.feeIlRatioKnown ? metrics.feeIlRatio : null,
        });
        if (!launchExitEval.exit) return null;
        // The peak is NOT deleted here: the exit decision may still be
        // blocked downstream — the peak stays until the position actually
        // closes (see the launchPeakFees1h prune in the close path).
        const launchReason = launchExitEval.reason ?? "exit";
        return {
          reasoning: `[launch-${launchReason}] ${describeLaunchExitReason(launchReason, pos, fees)}`,
        };
      }

      // Runner scale-in (Heart Attack step 2): the dip band TRACKS the falling
      // price — re-anchor at dip% below the NEW price and top up with fresh
      // quote capital via the atomic rebalance. Runs only when the launch exit
      // did NOT fire this cycle — never scale into a dying position.
      /** Size a runner scale-in top-up in quote-token atomics (live price only).
       * Unavailable decimals/price top out at 0 and the top-up is skipped. */
      function sizeScaleInTopUp(topUpUsd: number): Effect.Effect<bigint, never> {
        return Effect.gen(function* () {
          const tokenXDecimals = yield* adapter
            .getTokenDecimals(pool.tokenX)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          // Live price only — a hardcoded fallback must never size a
          // top-up (useFallback: false; an unavailable price tops out at
          // 0 and the top-up is skipped).
          const priceX = (yield* adapter
            .getTokenPrices([pool.tokenX], { useFallback: false })
            .pipe(Effect.catch(() => Effect.succeed(EMPTY_TOKEN_PRICES))))[pool.tokenX];
          if (tokenXDecimals === null || priceX == null || priceX <= 0) return 0n;
          return BigInt(Math.floor((topUpUsd / priceX) * 10 ** tokenXDecimals));
        });
      }

      /** Emit the scale-in REBALANCE (SOL-reserved, dip-anchored, width-capped).
       * Null when the batch SOL budget cannot cover the top-up.
       */
      function emitScaleInDecision(
        pos: PositionRecord,
        topUpUsd: number,
        topUpAtomicX: bigint,
        scaleInReason: string | null | undefined,
      ): Effect.Effect<AgentDecision | null, never> {
        return Effect.gen(function* () {
          // Reserve the SOL the top-up costs (autonomous canary/live
          // swaps SOL for a non-SOL quote leg): skip — never force —
          // when the batch budget cannot cover it, exactly like ENTER.
          const solCostLamports = resolveScaleInSolCost(
            solFundedEntryMode,
            topUpUsd,
            config.solPriceUsd,
            pool.tokenX === SOL_MINT || pool.tokenY === SOL_MINT,
          );
          function reserveScaleInSol(solCostLamports: bigint): boolean {
            if (solCostLamports <= 0n) return true;
            if (entrySolBudgetLamports < solCostLamports) return false;
            entrySolBudgetLamports -= solCostLamports;
            return true;
          }
          if (!reserveScaleInSol(solCostLamports)) {
            logger.info("Runner scale-in skipped — SOL budget insufficient", {
              pool: poolAddress,
              position: pos.positionId,
            });
            return null;
          }
          const dipOffset = resolveRunnerDipOffset(pool.binStep, config.launchRunnerDipPct);
          const runnerWidth = clampRunnerHalfWidth(
            dipOffset,
            config.launchRunnerHalfWidthBins,
            config.maxRebalanceRangeBins,
          );
          // EMIT a position-targeted REBALANCE decision: the normal
          // executor runs it through risk.evaluate (safety pause),
          // the agent overlay and the paper/live dispatch — after every
          // exit gate has had its say this cycle.
          return {
            action: "REBALANCE",
            poolAddress,
            positionId: pos.positionId,
            confidence: 1,
            reasoning: `[launch-scale-in] ${scaleInReason ?? "price step reached"}`,
            rebalanceParams: {
              newLowerBinId: pool.activeBinId - runnerWidth + dipOffset,
              newUpperBinId: pool.activeBinId + runnerWidth + dipOffset,
              slippageBps: config.maxSwapSlippageBps ?? 50,
              topUp: { amountXAtomic: topUpAtomicX, amountYAtomic: 0n },
              topUpUsd,
            },
          } as const;
        });
      }

      function maybeScaleInRunner(
        pos: PositionRecord,
        launchLifecycle: LifecycleExit | null,
      ): Effect.Effect<AgentDecision | null, never> {
        if (launchLifecycle !== null) return Effect.succeed(null);
        if (!(pos.launchRunner === true && config.launchRunnerScaleInEnabled !== false)) {
          return Effect.succeed(null);
        }
        function sizeRunnerTopUp(): number {
          // Per-pool allocation headroom: a scale-in ADDS new capital to
          // the pool's aggregate exposure — the same cap the risk tail
          // applies to entries.
          const poolExposureUsd = Array.from(trackedPositions.values())
            .filter((p) => p.poolAddress === poolAddress)
            .reduce((sum, p) => sum + p.currentValueUsd, 0);
          const portfolioValueUsd =
            lastWalletBalanceUsd +
            Array.from(trackedPositions.values()).reduce((sum, p) => sum + p.currentValueUsd, 0);
          const poolCapUsd = Math.max(
            0,
            (config.maxPerPoolAllocationPct ?? 0.4) * portfolioValueUsd - poolExposureUsd,
          );
          return scaleInTopUpUsd({
            walletUsd: lastWalletBalanceUsd,
            sizePct: config.launchRunnerScaleInSizePct ?? 0.25,
            poolCapUsd,
            maxTopUpUsd: config.launchPositionMaxSizeUsd ?? 100,
          });
        }

        return Effect.gen(function* () {
          const scaleInDecision = shouldScaleInRunner(
            resolveScaleInTrigger(
              pos.launchRunnerAnchorPrice,
              pool.currentPrice,
              config.launchRunnerScaleInStepPct,
              pos.launchRunnerSteps,
              config.launchRunnerScaleInMaxSteps,
            ),
          );
          if (scaleInDecision.scale && pos.positionPubKey !== null) {
            const topUpUsd = sizeRunnerTopUp();
            const topUpAtomicX = yield* sizeScaleInTopUp(topUpUsd);
            if (topUpUsd >= 5 && topUpAtomicX > 0n) {
              return yield* emitScaleInDecision(
                pos,
                topUpUsd,
                topUpAtomicX,
                scaleInDecision.reason,
              );
            }
          }
          return null;
        });
      }

      /** Lifecycle + pool-degradation EXIT gates (fa → launch → tp → W15 → IL → dust → TVL). */
      function checkDeterministicExits(
        pos: PositionRecord,
        faLifecycle: LifecycleExit | null,
        launchLifecycle: LifecycleExit | null,
        tpTargetLifecycle: LifecycleExit | null,
        ilDominance: IlDominanceSignal | null,
      ): Effect.Effect<AgentDecision | null, Error> {
        return Effect.gen(function* () {
          if (faLifecycle) {
            return {
              action: "EXIT",
              poolAddress,
              positionId: pos.positionId,
              confidence: 1,
              reasoning: faLifecycle.reasoning,
            } as const;
          }
          if (launchLifecycle) {
            return {
              action: "EXIT",
              poolAddress,
              positionId: pos.positionId,
              confidence: 1,
              reasoning: launchLifecycle.reasoning,
            } as const;
          }
          if (tpTargetLifecycle) {
            return {
              action: "EXIT",
              poolAddress,
              positionId: pos.positionId,
              confidence: 1,
              reasoning: tpTargetLifecycle.reasoning,
            } as const;
          }
          if (w15Signals.depeg || w15Signals.liquidityDrain) {
            return {
              action: "EXIT",
              poolAddress,
              positionId: pos.positionId,
              confidence: 1,
              reasoning: buildW15ExitReasoning(w15Signals.depeg, w15Signals.liquidityDrain),
            } as const;
          }
          function checkIlDominanceExit(): Effect.Effect<AgentDecision | null, Error> {
            return Effect.gen(function* () {
              if (!ilDominance) return null;
              yield* alertSvc.sendAlert({
                type: "il_dominance",
                severity: "critical",
                message: `IL dominance EXIT on ${pool.tokenXSymbol}/${pool.tokenYSymbol} position ${pos.positionId}: IL $${ilDominance.ilUsd.toFixed(2)} exceeds ${config.ilDominanceExitFactor ?? 2}× fees ($${ilDominance.feesClaimedUsd.toFixed(2)})`,
                poolAddress,
                positionId: pos.positionId,
                data: {
                  ilUsd: ilDominance.ilUsd,
                  hodlValueUsd: ilDominance.hodlValueUsd,
                  feesClaimedUsd: ilDominance.feesClaimedUsd,
                },
              });
              return {
                action: "EXIT",
                poolAddress,
                positionId: pos.positionId,
                confidence: 1,
                reasoning: `IL dominance: $${ilDominance.ilUsd.toFixed(2)} IL exceeds ${config.ilDominanceExitFactor ?? 2}× cumulative fees ($${ilDominance.feesClaimedUsd.toFixed(2)}) while out of range`,
              } as const;
            });
          }

          const ilExit = yield* checkIlDominanceExit();
          if (ilExit) return ilExit;
          if (isDustExit(config.dustExitUsd, pos.currentValueUsd)) {
            // Dust cleanup: a position whose REAL mark fell below the dust
            // threshold is dead capital — reclaim the slot for a real position.
            // Shadow mode records it; live mode closes it.
            return {
              action: "EXIT",
              poolAddress,
              positionId: pos.positionId,
              confidence: 1,
              reasoning: buildDustExitReasoning(pos.currentValueUsd, config.dustExitUsd),
            } as const;
          }
          function checkTvlDropExit(): Effect.Effect<AgentDecision | null, Error> {
            return Effect.gen(function* () {
              if (!(tvlVelocity < -config.tvlDropExitPct)) return null;
              if (!poolExitFired) {
                yield* memory
                  .upsert({
                    category: "warning",
                    content: `Pool ${poolAddress} TVL dropped sharply. Exit triggered.`,
                    poolAddress,
                  })
                  .pipe(Effect.catch(() => Effect.void));
              }
              yield* sendAgentAlert(
                "critical",
                "tvl_drop",
                `TVL dropped ${(Math.abs(tvlVelocity) * 100).toFixed(1)}% on ${pool.tokenXSymbol}/${pool.tokenYSymbol} — capital protection EXIT triggered`,
                { pool, metrics, position: pos },
              );
              return {
                action: "EXIT",
                poolAddress,
                positionId: pos.positionId,
                confidence: 0.85,
                reasoning: `TVL dropped ${(Math.abs(tvlVelocity) * 100).toFixed(1)}% — capital protection exit`,
              } as const;
            });
          }

          const tvlExit = yield* checkTvlDropExit();
          if (tvlExit) return tvlExit;
          return null;
        });
      }

      // Volume-authenticity EXIT (fee-trend signal, not capital danger):
      // hold-bias suppresses it for in-range positions still harvesting.
      function checkVolumeAuthExit(
        pos: PositionRecord,
      ): Effect.Effect<AgentDecision | null, Error> {
        if (metrics.volumeAuthenticityKnown && volumeAuth < evolvedThresholds.volumeAuthThreshold) {
          // Hold-bias (HOLD_BIAS_ENABLED): the volume-authenticity EXIT is a
          // fee-TREND signal — under hold-bias an in-range position keeps
          // collecting fees instead of being recycled through spread cost.
          if (config.holdBiasEnabled === true && pos.outOfRangeSince === null) {
            console.info(
              `[hold-bias] suppressing volume-auth EXIT ${poolAddress} — in-range position keeps harvesting`,
            );
            return Effect.succeed(null);
          }
          return Effect.gen(function* () {
            yield* sendAgentAlert(
              "warning",
              "risk_rejected",
              `Volume authenticity ${volumeAuth.toFixed(2)} below threshold on ${pool.tokenXSymbol}/${pool.tokenYSymbol} — EXIT`,
              { pool, metrics, position: pos },
            );
            return {
              action: "EXIT",
              poolAddress,
              positionId: pos.positionId,
              confidence: 0.8,
              reasoning: `Volume authenticity ${volumeAuth.toFixed(2)} below threshold`,
            } as const;
          });
        }
        return Effect.succeed(null);
      }

      // Fee/IL EXIT (immature positions exempt — the ratio is near-zero before
      // fees accrue): hold-bias suppresses in-range wobbles above -10%.
      function checkFeeIlExit(pos: PositionRecord): Effect.Effect<AgentDecision | null, Error> {
        if (
          Date.now() - pos.timestamp >= (config.minYieldExitAgeMs ?? 14_400_000) &&
          metrics.feeIlRatioKnown &&
          feeIlRatio < 0.5
        ) {
          // feeIlRatioUnknown (heuristic) → skip: a fabricated-low ratio must
          // not force an exit.
          if (
            config.holdBiasEnabled === true &&
            pos.outOfRangeSince === null &&
            pos.currentValueUsd >= pos.depositedUsd * 0.9
          ) {
            // Hold-bias: a fee/IL dip on an in-range position not yet down
            // >10% is a fee-trend wobble, not capital danger — keep harvesting.
            console.info(
              `[hold-bias] suppressing fee/IL EXIT ${poolAddress} — in-range, drawdown ${(100 - (pos.currentValueUsd / Math.max(pos.depositedUsd, 0.01)) * 100).toFixed(1)}% within tolerance`,
            );
            return Effect.succeed(null);
          }
          return Effect.gen(function* () {
            yield* sendAgentAlert(
              "warning",
              "risk_rejected",
              `Fee/IL ratio ${feeIlRatio.toFixed(2)} below 0.5 on ${pool.tokenXSymbol}/${pool.tokenYSymbol} — EXIT`,
              { pool, metrics, position: pos },
            );
            return {
              action: "EXIT",
              poolAddress,
              positionId: pos.positionId,
              confidence: 0.75,
              reasoning: `Fee/IL ratio ${feeIlRatio.toFixed(2)} below 0.5`,
            } as const;
          });
        }
        return Effect.succeed(null);
      }

      // G7 yield-regression: a tracked position whose MEASURED fee APR fell
      // below its entry-time APR × threshold is dead capital (launch excluded).
      function checkYieldRegressionExit(
        pos: PositionRecord,
      ): Effect.Effect<AgentDecision | null, Error> {
        const yieldWindowMature =
          Date.now() - pos.timestamp >= (config.minYieldExitAgeMs ?? 14_400_000);
        if (
          !(
            yieldWindowMature &&
            pos.positionMode !== "launch" &&
            pool.statsSource === "datapi" &&
            poolFeeAprPct > 0
          )
        ) {
          return Effect.succeed(null);
        }
        return Effect.gen(function* () {
          // Measured (datapi) only; the entry baseline is recorded at ENTER
          // execution (`yieldbase:<positionId>`). Launch positions have their
          // own timebox lifecycle — excluded here.
          const baselineRaw = yield* db
            .getMetadata(`yieldbase:${pos.positionId}`)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          let entryAprPct: number | null = null;
          if (baselineRaw) {
            try {
              // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
              entryAprPct = (JSON.parse(baselineRaw) as { entryAprPct: number }).entryAprPct;
            } catch {
              entryAprPct = null;
            }
          }
          const regressionPct = config.yieldRegressionExitPct ?? 0.5;
          if (
            entryAprPct !== null &&
            entryAprPct > 0 &&
            poolFeeAprPct < entryAprPct * regressionPct
          ) {
            if (
              config.holdBiasEnabled === true &&
              pos.outOfRangeSince === null &&
              pos.currentValueUsd >= pos.depositedUsd * 0.9
            ) {
              // Hold-bias: APR decay alone doesn't sell an in-range position
              // that isn't materially underwater — fees still accrue.
              console.info(
                `[hold-bias] suppressing yield-regression EXIT ${poolAddress} — in-range, APR decay only`,
              );
              return null;
            }
            return {
              action: "EXIT",
              poolAddress,
              positionId: pos.positionId,
              confidence: 1,
              reasoning: `[yield-regression] APR ${poolFeeAprPct.toFixed(0)}% < ${(regressionPct * 100).toFixed(0)}% of entry ${entryAprPct.toFixed(0)}%`,
            } as const;
          }
          return null;
        });
      }

      // Trailing stop (profit protection): breach must persist across
      // consecutive cycles (#153) — a single noisy snapshot never fires.
      function checkTrailingStopExit(
        pos: PositionRecord,
      ): Effect.Effect<AgentDecision | null, Error> {
        function trackTrailingBreach(breached: boolean): number {
          if (!breached) {
            trailingStopBreachCount.delete(pos.positionId);
            return 0;
          }
          const breaches = (trailingStopBreachCount.get(pos.positionId) ?? 0) + 1;
          trailingStopBreachCount.set(pos.positionId, breaches);
          return breaches;
        }

        return Effect.gen(function* () {
          const estimatedValue = pos.currentValueUsd;
          const { highest, drawdown } = computeTrailingDrawdown(
            pos.currentValueUsd,
            pos.highestValueUsd,
            pos.depositedUsd,
          );
          const breached = drawdown > config.trailingStopPct;
          const breaches = trackTrailingBreach(breached);
          if (breached && breaches >= config.trailingStopConfirmCycles) {
            return {
              action: "EXIT",
              poolAddress,
              positionId: pos.positionId,
              confidence: 0.8,
              reasoning: `Trailing stop: value dropped ${(drawdown * 100).toFixed(1)}% from peak $${highest.toFixed(2)} (${breaches}/${config.trailingStopConfirmCycles} cycles)`,
            } as const;
          }
          if (!breached) {
            // Only a genuinely non-breaching cycle emits the large-pnl warning;
            // a breached-but-unconfirmed cycle is on the path to a trailing-stop
            // EXIT and the confirmed critical alert — no warning spam first.
            const pnlPct = computeUnrealizedPnlPct(pos.depositedUsd, estimatedValue);
            if (pnlPct < -0.15) {
              yield* sendAgentAlert(
                "warning",
                "large_pnl_swing",
                `Large unrealized loss on ${pool.tokenXSymbol}/${pool.tokenYSymbol}: ${(pnlPct * 100).toFixed(1)}% ($${(estimatedValue - pos.depositedUsd).toFixed(2)})`,
                { pool, metrics, position: pos },
              );
            }
          }
          return null;
        });
      }

      // EXIT decision for one position: deterministic gates first (each may
      // still be suppressed by hold-bias), then the trailing stop. An EXIT
      // from any gate wins over a scale-in REBALANCE.
      function decidePositionExit(
        pos: PositionRecord,
        faLifecycle: LifecycleExit | null,
        launchLifecycle: LifecycleExit | null,
        tpTargetLifecycle: LifecycleExit | null,
        ilDominance: IlDominanceSignal | null,
      ): Effect.Effect<AgentDecision | null, Error> {
        return Effect.gen(function* () {
          const scaleIn = yield* maybeScaleInRunner(pos, launchLifecycle);
          const exitDecision =
            (yield* checkDeterministicExits(
              pos,
              faLifecycle,
              launchLifecycle,
              tpTargetLifecycle,
              ilDominance,
            )) ??
            (yield* checkVolumeAuthExit(pos)) ??
            (yield* checkFeeIlExit(pos)) ??
            (yield* checkYieldRegressionExit(pos)) ??
            (yield* checkTrailingStopExit(pos));
          return exitDecision ?? scaleIn;
        });
      }

      // W15 fast-EXIT pre-alert (fires whenever the signals are present,
      // independent of any single position's exit decision).
      function alertW15Signals(): Effect.Effect<void, never> {
        if (!(w15Signals.depeg || w15Signals.liquidityDrain)) return Effect.void;
        return Effect.gen(function* () {
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
            type: w15Signals.liquidityDrain ? "liquidity_drain" : "stablecoin_depeg",
            severity: "critical",
            message: `Fast EXIT signal on ${pool.tokenXSymbol}/${pool.tokenYSymbol}: ${reasons.join("; ")}`,
            poolAddress,
            data: { ...w15Signals },
          });
        });
      }

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
        yield* trackPositionRange(pos);
      }

      // Per-cycle external-close reconcile: one position fetch per pool,
      // matched per position pubkey so a sibling's external close only
      // removes its own record.
      poolPositions = yield* reconcileExternalCloses(poolPositions);

      const { netDriftBins, volatilityStddev, volatilityBins, recentBins } =
        resolvePoolDriftMetrics(binHistory, poolAddress, config.volatilityLookbackSnapshots);

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
        minPriceCoveragePct: config.minRangeHalfWidthPct,
      });

      // Value estimation per position (feeds the trailing stop and the
      // REBALANCE gas gate); OOR counters above are persisted by the same save.
      //
      // PRIMARY mark: the real on-chain position value (adapter reads the
      // position's actual X/Y bin holdings and prices them — captures genuine
      // IL). FALLBACK: the HODL-anchored mark (price revaluation of the
      // recorded entry legs) or, when entry legs are unknown, the cost basis.
      // The old bin-drift heuristic is gone: it fabricated 10-40% drawdowns
      // from sub-1% price moves, so the trailing stop fired every cycle and
      // churned positions open/closed with ~zero realized P&L (live
      // deployments saw 340+ positions in 2.5 weeks and −$218 of churn).
      // getPositionValueUsd is optional in the service contract (test mocks)
      // and never fails — null falls through to the price-anchored mark.
      for (const pos of poolPositions) {
        yield* refreshPositionValue(pos);
      }

      // ── Phase 1: EXIT evaluation per position ───────────────────────────
      // Pool-level degradation (TVL drop, fake volume, low fee/IL) exits
      // every position on the pool; the trailing stop is per position.
      const rawDecisions: AgentDecision[] = [];
      let poolExitFired = false;

      yield* alertW15Signals();

      // Launch peak-fee pruning (Launch Mode v2): drop entries whose position
      // closed or left the launch lane (EXIT execution deletes the row from
      // trackedPositions in the decision tail). In-memory only — the time-box
      // exit backstops a restart.
      pruneLaunchPeakFees();

      yield* runPhase1ExitEvaluation();

      const resolveExitCooldown = (
        exitDecision: AgentDecision,
        position: PositionRecord | undefined,
      ): Effect.Effect<
        {
          poolAddress: string;
          cooldownUntil: number;
          reason: string;
          consecutiveOorExits: number;
        } | null,
        Error
      > =>
        Effect.gen(function* () {
          if (exitDecision.action !== "EXIT") return null;

          const existingCooldown = yield* db
            .getPoolCooldown(poolAddress)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          const existingOorCount = existingCooldown?.consecutiveOorExits ?? 0;
          const cooldownTrigger = classifyExitCooldownTrigger(
            exitDecision.reasoning,
            position,
            config.oorGracePeriodCycles,
          );

          if (cooldownTrigger === "oor") {
            const newOorCount = existingOorCount + 1;
            const cooldownDuration = computeCooldownForExit({
              trigger: "oor",
              consecutiveOorExits: existingOorCount,
              config,
              feeDensityPerDay: null,
            });
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
          } else if (cooldownTrigger === "low-yield") {
            // Fee density is trusted ONLY from the Data API (the only source
            // of measured per-pool fees — same precedent as the paper fee
            // accrual gate above). Gecko fees are a binStep base-rate MODEL
            // on real volume and heuristic fees are fabricated, so by repo
            // convention modeled/fabricated numbers get no gate vote: only
            // datapi feeds the density scaling, everything else passes null
            // and keeps the static legacy duration. Deliberately NOT
            // isMeasuredStatsSource(), which would admit gecko.
            const feeDensityPerDay = resolveFeeDensityPerDay(
              pool.statsSource,
              pool.tvlUsd,
              pool.fees24hUsd,
            );
            const cooldownDuration = computeCooldownForExit({
              trigger: "low-yield",
              consecutiveOorExits: existingOorCount,
              config,
              feeDensityPerDay,
            });
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

          // Same-pool re-entry churn throttle (MIN_REENTRY_COOLDOWN_MS): arm a
          // cooldown on EVERY exit, not just OOR/low-yield (which returned
          // above, possibly longer). All other exit types — trailing-stop,
          // rotation, take-profit, yield-regression, W15, fallen-angel —
          // armed NOTHING before, so a hot pool could exit and re-admit the
          // same pool minutes later. Live forensics (2026-08): 5rCf1 re-entered
          // the same pool every ~10 min — 221 round-trips / 2 days, −$163 of
          // pure swap/spread cost drag at ~50% win rate. A 2h throttle blocks
          // ~90% of that churn class. 0 disables.
          const minReentryMs = config.minReentryCooldownMs ?? 0;
          if (minReentryMs > 0) {
            const cooldownUntil = Date.now() + minReentryMs;
            const hours = (minReentryMs / 3_600_000).toFixed(1);
            console.info(
              `[cooldown] Pool ${poolAddress} on churn-throttle cooldown for ${hours}h — re-entry buffer after exit`,
            );
            return {
              poolAddress,
              cooldownUntil,
              reason: "Re-entry cooldown after exit (churn throttle)",
              consecutiveOorExits: existingOorCount,
            };
          }
          return null;
        });

      // Single persist point happened per position above (OOR + value updates).
      // The wallet value was reconciled once at the top of this cycle; reuse it
      // here so every pool in the cycle shares one consistent figure for the
      // risk/sizing context (a transient read already degraded at cycle top and
      // never fails an individual pool).
      const walletBalanceUsd = lastWalletBalanceUsd;

      // Portfolio value = wallet + open positions (mirrors refreshAgentState).
      // Using the wallet alone shrinks the drawdown/allocation/size gates as
      // positions grow, tightening risk limits exactly when capital is deployed.
      const openPositions = Array.from(trackedPositions.values()).map(toRiskPosition);
      const portfolioValueUsd =
        walletBalanceUsd + openPositions.reduce((sum, p) => sum + p.currentValueUsd, 0);
      const dayStart = new Date(Date.now()).setUTCHours(0, 0, 0, 0);
      const dayKey = new Date(dayStart).toISOString().slice(0, 10);
      const closedToday = yield* db
        .getClosedPositions()
        .pipe(Effect.catch(() => Effect.succeed([])));
      const realizedTodayUsd = closedToday.reduce(
        (sum, position) =>
          position.closedAt !== null &&
          position.closedAt >= dayStart &&
          position.realizedPnlUsd !== null
            ? sum + position.realizedPnlUsd
            : sum,
        0,
      );
      const drawdownOutcome = yield* evaluateDailyDrawdown();
      dailyDrawdownPct = drawdownOutcome.dailyDrawdownPct;
      const recentPnlUsd = openPositions.reduce((sum, pos) => sum + pos.unrealizedPnlUsd, 0);

      /** Cost-aware runner net-bleed signal. */
      interface RunnerNetBleed {
        readonly bleed: boolean;
        readonly reason: string;
      }

      function evaluateRunnerNetBleed(
        pos: PositionRecord,
        positionHalfWidth: number,
      ): RunnerNetBleed {
        // Cost-aware runner guard ("no bleeds at all"): the launch lifecycle owns
        // a runner's timebox / volume-decay / drawdown exits, but NONE of those
        // name the churn cost of a volatile pool — a runner can sit in-range,
        // accrue fees, and still net-negative once OOR-exit swap cost + realized
        // IL are charged. When a launched runner no longer clears its
        // net-daily-yield floor after churn/IL/swap costs, exit it rather than
        // keep bleeding. Measured fees only; unmeasured size fails closed.
        if (
          !isNetBleedCandidate(
            pos.launchRunner,
            pos.positionMode,
            config.marketScanRunnerEnabled,
            metrics.feeIlRatioKnown,
            pos.currentValueUsd,
            pos.depositedUsd,
          )
        ) {
          return { bleed: false, reason: "" };
        }
        {
          const sizeUsd = resolveRunnerSizeUsd(pos.currentValueUsd, pos.depositedUsd);
          const posHalfWidth = resolveRunnerHalfWidth(positionHalfWidth, rangeHalfWidth);
          const floorPct = config.runnerNetFloorPct ?? 1;
          const netPct = computePositionNetDailyPct(
            pool.fees24hUsd,
            pool.tvlUsd,
            sizeUsd,
            posHalfWidth,
            pool.binStep,
            volatilityStddev,
            config.runnerSwapCostPct,
            config.feeCaptureHarvestCostUsd,
            config.scanIntervalMs,
          );
          if (netPct < floorPct) {
            return {
              bleed: true,
              reason: `[net-bleed] runner net ${netPct.toFixed(2)}%/day < floor ${floorPct}%/day after churn/IL/swap cost — exiting to stop the bleed`,
            };
          }
        }
        return { bleed: false, reason: "" };
      }

      /** Net-bleed + volatility EXIT gates for Phase 2 (runners exempt from vol). */
      function decidePhase2Exit(
        pos: PositionRecord,
        isRunnerPosition: boolean,
        highVol: boolean,
        driftPct: number,
        timeSinceRebal: number,
        oorGraceExpired: boolean,
        runnerNetBleed: boolean,
        runnerNetBleedReason: string,
      ): Effect.Effect<AgentDecision | null, Error> {
        return Effect.gen(function* () {
          if (runnerNetBleed) {
            console.info(
              `[net-bleed] EXITING ${poolAddress} (${pos.positionId}) — ${runnerNetBleedReason}`,
            );
            if (!poolExitFired) {
              yield* memory
                .upsert({
                  category: "warning",
                  content: `Cost-aware runner exit for ${poolAddress}: ${runnerNetBleedReason}`,
                  poolAddress,
                })
                .pipe(Effect.catch(() => Effect.void));
            }
            return {
              action: "EXIT",
              poolAddress,
              positionId: pos.positionId,
              confidence: 1,
              reasoning: runnerNetBleedReason,
            } as const;
          }
          if (
            !isRunnerPosition &&
            highVol &&
            driftPct > 0.6 &&
            (timeSinceRebal >= config.minRebalanceIntervalMs || oorGraceExpired)
          ) {
            console.info(
              `[vol-gate] EXITING ${poolAddress} (${pos.positionId}) — high volatility (stddev=${volatilityStddev.toFixed(2)}, threshold=${config.volatilityExitStddev}). Drift=${(driftPct * 100).toFixed(0)}%`,
            );
            if (!poolExitFired) {
              yield* memory
                .upsert({
                  category: "warning",
                  content: `Volatility-gate EXIT for ${poolAddress}: stddev=${volatilityStddev.toFixed(2)} over ${volatilityBins.length} snapshots`,
                  poolAddress,
                })
                .pipe(Effect.catch(() => Effect.void));
            }
            yield* sendAgentAlert(
              "warning",
              "high_volatility",
              `High volatility exit on ${pool.tokenXSymbol}/${pool.tokenYSymbol}: σ=${volatilityStddev.toFixed(2)}, drift=${(driftPct * 100).toFixed(0)}%`,
              { pool, metrics, position: pos },
            );
            return {
              action: "EXIT",
              poolAddress,
              positionId: pos.positionId,
              confidence: 0.8,
              reasoning: `High volatility (σ=${volatilityStddev.toFixed(2)}) + ${(driftPct * 100).toFixed(0)}% drift — exit to wallet rather than rebalancing into new range`,
            } as const;
          }
          return null;
        });
      }

      /** REBALANCE evaluation for Phase 2 (simulation-first, gas + recovery gates). */
      function runPhase2Rebalance(
        pos: PositionRecord,
        driftPct: number,
        timeSinceRebal: number,
        oorGraceExpired: boolean,
        positionCenter: number,
      ): Effect.Effect<AgentDecision | null, never> {
        return Effect.gen(function* () {
          // Wave 9: adaptive mode replaces the binary high-vol widening with
          // the continuous σ-scaled width; disabled keeps the legacy behavior.
          function recommendRebalanceRange() {
            if (config.volatilityAdaptiveRanges) {
              return strategy.recommendBinRange(pool.activeBinId, pool.binStep, rangeHalfWidth);
            }
            if (!highVol) {
              return strategy.recommendBinRange(pool.activeBinId, pool.binStep, rangeHalfWidth);
            }
            return recommendBinRangeForVolatility(
              pool.activeBinId,
              pool.binStep,
              true,
              config.volatilityWideHalfWidthBins,
              config.entryRangeHalfWidthBins > 0 ? config.entryRangeHalfWidthBins : undefined,
            );
          }

          const recommended = recommendRebalanceRange();
          // Simulation-first: live mode runs the SDK's atomic-rebalance
          // simulation against the real position; on any simulation/transport
          // failure the gate fails closed (no rebalance this cycle).
          function simulateRebalanceOutcome(recommended: {
            readonly lowerBinId: number;
            readonly upperBinId: number;
          }) {
            if (config.paperTrading) {
              return Effect.succeed(
                estimatePaperRebalanceBenefit({
                  fees24hUsd: pool.fees24hUsd,
                  newLowerBinId: recommended.lowerBinId,
                  newUpperBinId: recommended.upperBinId,
                }),
              );
            }
            if (!pos.positionPubKey) return Effect.succeed(null);
            return adapter
              .simulateRebalance(
                poolAddress,
                pos.positionPubKey,
                recommended.lowerBinId,
                recommended.upperBinId,
              )
              .pipe(
                Effect.catch((err) =>
                  Effect.sync(() => {
                    logger.warn("Rebalance simulation failed — holding position (fail-closed)", {
                      pool: poolAddress,
                      error: err instanceof Error ? err.message : String(err),
                    });
                    return null;
                  }),
                ),
              );
          }

          const sim = yield* simulateRebalanceOutcome(recommended);
          if (sim === null) {
            yield* memory
              .upsert({
                category: "warning",
                content: `Rebalance simulation unavailable for ${poolAddress} — rebalance skipped this cycle`,
                poolAddress,
              })
              .pipe(Effect.catch(() => Effect.void));
            return null;
          }
          console.info(
            `[rebalance-sim] ${poolAddress} source=${sim.source} fees=$${sim.estimatedFeesUsd.toFixed(2)} cost=$${sim.estimatedCostUsd.toFixed(2)} net=$${sim.netBenefitUsd.toFixed(2)}`,
          );
          // F1: gas-aware gate — skip rebalance when gas cost > N days of position fees
          // Use currentValueUsd (not depositedUsd) so the share reflects the
          // position's present value. Unknown value falls back to 0 which
          // makes the gas gate reject — a conservative default.
          const positionSharePct = resolvePositionSharePct(pool.tvlUsd, pos.currentValueUsd);
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
              .pipe(Effect.catch(() => Effect.void));
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
              .pipe(Effect.catch(() => Effect.void));
            return null;
          }
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
              .pipe(Effect.catch(() => Effect.void));
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
              .pipe(Effect.catch(() => Effect.void));
            return null;
          }
          function buildPhase2RebalanceDecision(
            recoveryProb: number,
            netBenefitUsd: number,
          ): AgentDecision | null {
            if (
              netBenefitUsd <= config.minRebalanceNetBenefitUsd &&
              recoveryProb > config.oorRecoveryForceRebalanceThreshold
            ) {
              return null;
            }
            const forceRebalance = recoveryProb <= config.oorRecoveryForceRebalanceThreshold;
            return {
              action: "REBALANCE",
              poolAddress,
              positionId: pos.positionId,
              confidence: Math.min(0.7 + feeIlRatio * 0.1, 0.9),
              reasoning: forceRebalance
                ? `[recovery-gate] force-rebalance — probability ${recoveryProb.toFixed(2)} <= ${config.oorRecoveryForceRebalanceThreshold}. Drift ${(driftPct * 100).toFixed(0)}%`
                : `Drift ${(driftPct * 100).toFixed(0)}%. Net benefit: $${netBenefitUsd.toFixed(2)}`,
              rebalanceParams: {
                newLowerBinId: recommended.lowerBinId,
                newUpperBinId: recommended.upperBinId,
                slippageBps: 50,
              },
            } as const;
          }

          return buildPhase2RebalanceDecision(recoveryProb, sim.netBenefitUsd);
        });
      }

      /** HOLD — a healthy fee/IL position with no recent warnings stays put. */
      function decidePhase2Hold(
        pos: PositionRecord,
        decision: AgentDecision | null,
      ): AgentDecision | null {
        // HOLD — a held position with a healthy fee/IL and no recent warnings
        // stays put; anything else falls through to the pool's default HOLD.
        if (!decision && feeIlRatio > evolvedThresholds.minFeeIlRatio && !hasRecentWarning) {
          return {
            action: "HOLD",
            poolAddress,
            positionId: pos.positionId,
            confidence: Math.min(0.6 + feeIlRatio * 0.05, 0.9),
            reasoning: `Fee/IL ${feeIlRatio.toFixed(2)} above threshold. Holding.`,
          };
        }
        return decision;
      }

      /** Phase 2 decision for one position: net-bleed/vol EXITs, rebalance, HOLD. */
      function decidePhase2Position(
        pos: PositionRecord,
      ): Effect.Effect<AgentDecision | null, Error> {
        const positionCenter = (pos.lowerBinId + pos.upperBinId) / 2;
        const positionHalfWidth = (pos.upperBinId - pos.lowerBinId) / 2;
        const driftPct = Math.abs(pool.activeBinId - positionCenter) / (positionHalfWidth || 1);
        const timeSinceRebal = Date.now() - pos.lastRebalanceAt;
        const oorGraceExpired = pos.oorCycleCount >= config.oorGracePeriodCycles;
        // Runner (Heart Attack): the dip band is deliberately below market —
        // the generic OOR/vol/rebalance machinery would see the position as
        // out-of-range and rebalance it back around the active bin, defeating
        // the ladder before it fills. The launch lifecycle owns pre-fill
        // runner exits; the trailing stop stays as a generic safety net.
        const isRunnerPosition = pos.launchRunner === true && pos.positionMode === "launch";
        return Effect.gen(function* () {
          const bleed = evaluateRunnerNetBleed(pos, positionHalfWidth);
          const exitDecision = yield* decidePhase2Exit(
            pos,
            isRunnerPosition,
            highVol,
            driftPct,
            timeSinceRebal,
            oorGraceExpired,
            bleed.bleed,
            bleed.reason,
          );
          if (exitDecision) return exitDecision;
          if (
            !isRunnerPosition &&
            (driftPct > 0.6 || oorGraceExpired) &&
            (timeSinceRebal >= config.minRebalanceIntervalMs || oorGraceExpired)
          ) {
            const rebalanced = yield* runPhase2Rebalance(
              pos,
              driftPct,
              timeSinceRebal,
              oorGraceExpired,
              positionCenter,
            );
            if (rebalanced) return rebalanced;
          }
          return decidePhase2Hold(pos, null);
        });
      }

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

      yield* runPhase2Evaluation();

      // Momentum-aware metrics for the weighted score: the momentum term reads
      // netDriftBins, which is only known after metrics construction, so it
      // rides on a derived copy (audit rows keep the original metrics).
      const momentumMetrics = { ...metrics, netDriftBins };

      // Idle-redeploy capture helper (opt-in): the candidate conditions +
      // weighted-score gate, evaluated for a pool whose ENTER slot was skipped
      // by the per-pool position cap. Allocation and token-risk are NOT
      // checked here — dispatch from the pass is structurally impossible for
      // a pool AT the per-pool cap (risk gate 3a and allocation gate 2 re-run
      // and re-reject verbatim), so no gate they guard can be bypassed.
      const evaluateIdleRedeployCandidate = (): IdleRedeployCandidate | null => {
        if (
          passesMeasuredCandidateGates(
            metrics.feeIlRatioKnown,
            feeIlRatio,
            evolvedThresholds.minFeeIlRatio,
            metrics.volumeAuthenticityKnown,
            volumeAuth,
            metrics.binUtilizationKnown,
            binUtilization,
            pool.tvlUsd,
            config.minPoolTvlUsd,
          )
        ) {
          const entryScore = weightedEntryScore(
            momentumMetrics,
            signalWeights,
            resolveMomentumScoreArgs(
              config.entryMomentumReferenceBins,
              config.entryMomentumScoreWeight,
            ),
          );
          if (entryScore > config.weightedEntryScoreThreshold) {
            return {
              poolAddress,
              pool,
              metrics,
              entryScore,
              feeIlRatio,
              normalEntrySizeUsd: computeEntrySizeUsd({
                walletBalanceUsd,
                tvlUsd: pool.tvlUsd,
                maxSizeUsd: config.maxEntrySizeUsd,
              }),
              volatilityStddev,
              netDriftBins,
            };
          }
        }
        return null;
      };

      /** ENTER-slot pool eligibility: no same-cycle exit, cap headroom, managed pool. */
      function checkEnterPoolEligibility(): boolean {
        // A pool already exiting this cycle never re-enters in the same cycle;
        // the count cap (MAX_POSITIONS_PER_POOL) bounds stacked positions while
        // the allocation gate bounds their aggregate exposure.
        if (poolExitFired || poolPositions.length >= config.maxPositionsPerPool) return false;
        if (unresolvedPoolAddresses.has(poolAddress)) {
          logger.warn("Skipping ENTER for unresolved pool", { pool: poolAddress });
          return false;
        }
        if (
          !approvedPoolAddresses.includes(poolAddress) &&
          !autonomousCandidatePools.has(poolAddress) &&
          !marketScanPools.has(poolAddress) &&
          // Launch Mode v2: launch-gated pools are managed pools once the
          // execution lane is enabled (empty set on the default path).
          !launchScanPools.has(poolAddress)
        ) {
          logger.info("Skipping ENTER for unmanaged pool", { pool: poolAddress });
          return false;
        }
        return true;
      }

      // Fail-closed live-entry gate: until the first SUCCESSFUL chain wallet
      // read lands, the session seed (config.paperPortfolioUsd) is fiction
      // and must not size/authorize a live entry (e.g. during an RPC outage
      // at startup). EXIT is never gated here — capital protection is free.
      function checkEnterWalletReadGate(enterGateRejected: boolean): Effect.Effect<boolean, never> {
        if (enterGateRejected) return Effect.succeed(true);
        if (config.paperTrading || walletEverReadSuccessfully) return Effect.succeed(false);
        return Effect.gen(function* () {
          cycle.poolsDecided++;
          yield* audit
            .recordDecision({
              timestamp: Date.now(),
              cycleId,
              poolAddress,
              action: "ENTER",
              confidence: 0,
              reasoning:
                "[wallet-read] No successful wallet balance read yet — live entries blocked until chain balance is known",
              metrics,
              riskResult: {
                approved: false,
                reason: "[wallet-read] No successful wallet balance read yet",
              },
              executed: false,
              paperTrading: config.paperTrading,
            })
            .pipe(Effect.catch(() => Effect.void));
          return true;
        });
      }

      // Fail-closed live-entry gate: if a post-transaction wallet re-read
      // failed after a successful LIVE ENTER earlier this cycle, the stale
      // cycle-top balance still counts the deployed capital alongside the
      // already-tracked new position. Block further entries until re-read.
      function checkEnterWalletRefreshGate(
        enterGateRejected: boolean,
      ): Effect.Effect<boolean, never> {
        if (enterGateRejected) return Effect.succeed(true);
        if (config.paperTrading || !liveEntriesBlockedRestOfCycle) return Effect.succeed(false);
        return Effect.gen(function* () {
          cycle.poolsDecided++;
          yield* audit
            .recordDecision({
              timestamp: Date.now(),
              cycleId,
              poolAddress,
              action: "ENTER",
              confidence: 0,
              reasoning:
                "[wallet-refresh] Wallet balance refresh failed after a live entry this cycle — further entries blocked until the next cycle keeps allocation caps honest",
              metrics,
              riskResult: {
                approved: false,
                reason:
                  "[wallet-refresh] Wallet balance refresh failed after a live entry this cycle",
              },
              executed: false,
              paperTrading: config.paperTrading,
            })
            .pipe(Effect.catch(() => Effect.void));
          return true;
        });
      }

      // P2 entry backoff: a pool whose normal ENTER failed with an
      // insufficient-token-balance error retries on backoff, not immediately.
      function checkEnterBackoffGate(enterGateRejected: boolean): Effect.Effect<boolean, never> {
        if (enterGateRejected) return Effect.succeed(true);
        const entryBackoff = entryFailureBackoff.get(poolAddress);
        if (!(entryBackoff && entryBackoff.nextAttemptAt > Date.now()))
          return Effect.succeed(false);
        return Effect.gen(function* () {
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
            .pipe(Effect.catch(() => Effect.void));
          yield* memory
            .upsert({
              category: "warning",
              content: `Entry suppressed for ${poolAddress} after insufficient token balance; retry in ${Math.ceil(retryAfterMs / 60_000)} minutes.`,
              poolAddress,
            })
            .pipe(Effect.catch(() => Effect.void));
          return true;
        });
      }

      // F7: pool cooldown check — skip ENTER if this pool is on cooldown.
      function checkEnterCooldownGate(enterGateRejected: boolean): Effect.Effect<boolean, never> {
        if (enterGateRejected) return Effect.succeed(true);
        return Effect.gen(function* () {
          const cooldown = yield* db
            .getPoolCooldown(poolAddress)
            .pipe(Effect.catch(() => Effect.succeed(null)));
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
              .pipe(Effect.catch(() => Effect.void));
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
              .pipe(Effect.catch(() => Effect.void));
            return true;
          }
          return false;
        });
      }

      // Churn circuit breaker (CHURN_MAX_ENTRIES_PER_POOL_PER_DAY): cap
      // same-pool re-entries per UTC day BEFORE losses accumulate. Exits are
      // never restricted; hot-window positions are exempt. Fail-open when
      // the cap is 0 or history is unreadable.
      function checkEnterChurnGate(enterGateRejected: boolean): Effect.Effect<boolean, never> {
        if (enterGateRejected) return Effect.succeed(true);
        if (launchScanPools.has(poolAddress) || (config.churnMaxEntriesPerPoolPerDay ?? 0) <= 0) {
          return Effect.succeed(false);
        }
        return Effect.gen(function* () {
          const closedLedger = yield* db.getClosedPositions().pipe(
            Effect.catch(() =>
              // SAFETY: The fallback literal satisfies the declared readonly array type.
              Effect.succeed([] as ReadonlyArray<PositionRecord>),
            ),
          );
          // Count BOTH closed rows and currently-open tracked positions on
          // this pool — an ENTER made earlier today that is still open must
          // consume the daily budget too.
          const churnHistory: Array<ChurnEntry> = closedLedger
            .filter((p) => p.poolAddress === poolAddress)
            .map((p) => ({ openedAt: p.timestamp, closed: true }));
          for (const p of trackedPositions.values()) {
            if (p.poolAddress === poolAddress && p.positionMode !== "hot-window") {
              churnHistory.push({ openedAt: p.timestamp, closed: false });
            }
          }
          const churnVerdict = evaluateChurnGuard({
            history: churnHistory,
            maxEntriesPerPoolPerDay: config.churnMaxEntriesPerPoolPerDay ?? 0,
            nowMs: Date.now(),
          });
          if (!churnVerdict.blocked) return false;
          console.info(
            `[churn-guard] Skipping ENTER ${poolAddress} — ${churnVerdict.todayCount} entries today >= cap ${config.churnMaxEntriesPerPoolPerDay}`,
          );
          yield* memory
            .upsert({
              category: "warning",
              content: `Churn guard blocked ENTER on ${poolAddress}: ${churnVerdict.todayCount} entries today >= daily cap ${config.churnMaxEntriesPerPoolPerDay}`,
              poolAddress,
            })
            .pipe(Effect.catch(() => Effect.void));
          yield* audit
            .recordDecision({
              timestamp: Date.now(),
              cycleId,
              poolAddress,
              action: "ENTER",
              confidence: 0,
              reasoning: `[churn-guard] ${churnVerdict.todayCount} entries today >= cap ${config.churnMaxEntriesPerPoolPerDay} — re-entry rationed`,
              metrics,
              riskResult: {
                approved: false,
                reason: `[churn-guard] daily cap ${config.churnMaxEntriesPerPoolPerDay}`,
              },
              executed: false,
              paperTrading: config.paperTrading,
            })
            .pipe(Effect.catch(() => Effect.void));
          return true;
        });
      }

      // Token-level execution-failure breaker (Robinhood rule 12): a
      // genuine live EXIT failure on ANY pool armed `token_block:<mint>`
      // for its legs — new deployment into a blocked token is rejected
      // here, before every specialized ENTER branch. Fail-closed on a set
      // block; fail-open on metadata read errors.
      function checkEnterTokenBlockGate(enterGateRejected: boolean): Effect.Effect<boolean, never> {
        if (enterGateRejected) return Effect.succeed(true);
        return Effect.gen(function* () {
          const blockedToken = yield* findBlockedToken(pool);
          if (blockedToken === null) return false;
          cycle.poolsDecided++;
          const reason =
            blockedToken.kind === "rug"
              ? `[token-block] token ${blockedToken.mint} under rug/drain block — ENTER rejected (prior catastrophic loss on a pool holding this leg)`
              : `[token-block] token ${blockedToken.mint} under execution-failure block — ENTER rejected (failed EXIT route on a pool holding this leg)`;
          yield* audit
            .recordDecision({
              timestamp: Date.now(),
              cycleId,
              poolAddress,
              action: "ENTER",
              confidence: 0,
              reasoning: reason,
              metrics,
              riskResult: { approved: false, reason },
              executed: false,
              paperTrading: config.paperTrading,
            })
            .pipe(Effect.catch(() => Effect.void));
          const blockKindLabel =
            blockedToken.kind === "rug" ? "rug/drain block" : "execution-failure block";
          yield* memory
            .upsert({
              category: "warning",
              content: `Entry blocked for ${poolAddress}: leg token ${blockedToken.mint} is under a ${blockKindLabel}.`,
              poolAddress,
            })
            .pipe(Effect.catch(() => Effect.void));
          return true;
        });
      }

      // [wash-forensics] launch ENTER gate — egregious wash evidence
      // rejects before capital enters a honeypot's volume. Advisory by
      // default; null (fetch failed, switch off, no sample) fails open.
      // Runs BEFORE every specialized ENTER branch, only for launch pools.
      function checkEnterWashGate(enterGateRejected: boolean): Effect.Effect<boolean, never> {
        if (enterGateRejected) return Effect.succeed(true);
        const washEvidence = washEvidenceByPool.get(poolAddress);
        if (
          config.launchWashForensicsEnabled !== true ||
          config.launchScanEnabled !== true ||
          config.launchExecutionEnabled !== true ||
          !launchScanPools.has(poolAddress) ||
          washEvidence === undefined ||
          !washEvidence.suspicious
        ) {
          return Effect.succeed(false);
        }
        return Effect.gen(function* () {
          yield* audit
            .recordDecision({
              timestamp: Date.now(),
              cycleId,
              poolAddress,
              action: "ENTER",
              confidence: 0,
              reasoning: `[wash-forensics] ${washEvidence.reason}`,
              metrics,
              riskResult: {
                approved: false,
                reason: `[wash-forensics] ${washEvidence.reason}`,
              },
              executed: false,
              paperTrading: config.paperTrading,
            })
            .pipe(Effect.catch(() => Effect.void));
          return true;
        });
      }

      // ── ENTER slot: one per pool per cycle, under the per-pool cap ──────
      // A pool already exiting this cycle never re-enters in the same cycle;
      // the count cap (MAX_POSITIONS_PER_POOL) bounds stacked positions while
      // the allocation gate bounds their aggregate exposure.
      let enterGateRejected = !checkEnterPoolEligibility();
      enterGateRejected = yield* checkEnterWalletReadGate(enterGateRejected);
      enterGateRejected = yield* checkEnterWalletRefreshGate(enterGateRejected);
      enterGateRejected = yield* checkEnterBackoffGate(enterGateRejected);
      enterGateRejected = yield* checkEnterCooldownGate(enterGateRejected);
      enterGateRejected = yield* checkEnterChurnGate(enterGateRejected);
      enterGateRejected = yield* checkEnterTokenBlockGate(enterGateRejected);
      enterGateRejected = yield* checkEnterWashGate(enterGateRejected);
      enterGateRejected = yield* evaluateFallenAngelEnter(enterGateRejected);

      // ── Fallen-angel ENTER (Wave 19) ───────────────────────────────
      // A pool that cleared the fallen-angel gate enters on the MEAN-REVERSION
      // thesis: the fee-harvesting quality gates below do not apply — a deeply
      // drawn-down token has thin fee/IL by construction. Allocation,
      // token-risk and the risk tail still run verbatim. The decision
      // carries the FA lifecycle (ladder + invalidation) so execution
      // stamps the position row.
      function evaluateFallenAngelEnter(enterGateRejected: boolean): Effect.Effect<boolean, never> {
        if (enterGateRejected) return Effect.succeed(true);
        return Effect.gen(function* () {
          const faSignal = fallenAngelSignals.get(poolAddress);
          const openFaPositions = Array.from(trackedPositions.values()).filter(
            (p) => p.positionMode === "fallen-angel",
          ).length;
          const faMaxPositions = config.fallenAngelMaxPositions ?? 2;
          if (
            config.fallenAngelEnabled !== true ||
            faSignal === undefined ||
            openFaPositions >= faMaxPositions
          ) {
            return false;
          }
          const faLadder = resolveFallenAngelLadder(
            pool.currentPrice,
            config.fallenAngelTpRungs,
            config.fallenAngelTpFractions,
            config.fallenAngelInvalidationStopPct,
          );
          const faProposedSizeUsd = computeEntrySizeUsd({
            walletBalanceUsd,
            tvlUsd: pool.tvlUsd,
            maxSizeUsd: config.maxEntrySizeUsd,
          });
          const faAllocation = evaluatePerPoolAllocation({
            proposedDepositUsd: faProposedSizeUsd,
            portfolioValueUsd,
            openPositions,
            maxPerPoolAllocationPct: config.maxPerPoolAllocationPct,
            maxOpenPositions: config.maxOpenPositions,
            poolAddress,
            maxPositionsPerPool: config.maxPositionsPerPool,
          });
          if (!faAllocation.approved) {
            console.info(
              `[fa-alloc-gate] Skipping FA ENTER ${poolAddress} — ${faAllocation.reason}`,
            );
            yield* audit
              .recordDecision({
                timestamp: Date.now(),
                cycleId,
                poolAddress,
                action: "ENTER",
                confidence: 0,
                reasoning: `[fa-alloc-gate] ${faAllocation.reason}`,
                metrics,
                riskResult: { approved: false, reason: `[fa-alloc-gate] ${faAllocation.reason}` },
                executed: false,
                paperTrading: config.paperTrading,
              })
              .pipe(Effect.catch(() => Effect.void));
            return true;
          }
          if (faLadder === null) return false;
          rawDecisions.push({
            action: "ENTER",
            poolAddress,
            confidence: 0.75,
            reasoning: `Fallen-angel: ${faSignal.assetMint} down ${(faSignal.drawdownPct * 100).toFixed(0)}% from ATH, RugCheck-clean, TVL $${pool.tvlUsd.toFixed(0)}`,
            positionSizeUsd: faAllocation.adjustedDepositUsd,
            positionMode: "fallen-angel",
            tpLadderJson: serializeTpLadder(faLadder.ladder) ?? undefined,
            invalidationStopPrice: faLadder.invalidationPrice,
          });
          // Consume the ENTER slot: the FA branch already pushed the
          // decision, so the quality gates below must not run and push a
          // duplicate ENTER for the same pool this cycle.
          return true;
        });
      }

      // Runner-drift / regime / drift / fee-IL quality gates for ENTER.
      function checkEnterQualityGates(enterGateRejected: boolean): Effect.Effect<boolean, never> {
        if (enterGateRejected) return Effect.succeed(true);
        return Effect.gen(function* () {
          // [runner-drift-gate] a drift-exempt market-runner candidate that is
          // itself a sustained decliner is rejected with an explicit audit row.
          // The runner lane's dip-ladder premise is buying the shakeout WITHIN
          // a healthy rising pool, not buying a pool already bleeding for
          // hours. This mirrors the normal-lane drift gate's signal so the
          // rejection is attributable instead of the pool silently falling
          // through to the generic gate.
          function checkRunnerDriftGate(): Effect.Effect<boolean, never> {
            return Effect.gen(function* () {
              if (
                !(
                  isMarketRunner(poolAddress) &&
                  netDriftBins <
                    (config.marketScanRunnerMinDriftBins ?? DEFAULT_RUNNER_MIN_DRIFT_BINS)
                )
              ) {
                return false;
              }
              console.info(
                `[runner-drift-gate] Rejecting runner ENTER ${poolAddress} — net drift ${netDriftBins} bins < ${config.marketScanRunnerMinDriftBins ?? DEFAULT_RUNNER_MIN_DRIFT_BINS}`,
              );
              yield* audit
                .recordDecision({
                  timestamp: Date.now(),
                  cycleId,
                  poolAddress,
                  action: "ENTER",
                  confidence: 0,
                  reasoning: `[runner-drift-gate] runner net drift ${netDriftBins} bins below ${config.marketScanRunnerMinDriftBins ?? DEFAULT_RUNNER_MIN_DRIFT_BINS} — sustained decliner, not a dip`,
                  metrics,
                  riskResult: {
                    approved: false,
                    reason: `[runner-drift-gate] drift ${netDriftBins} < ${config.marketScanRunnerMinDriftBins ?? DEFAULT_RUNNER_MIN_DRIFT_BINS}`,
                  },
                  executed: false,
                  paperTrading: config.paperTrading,
                })
                .pipe(Effect.catch(() => Effect.void));
              return true;
            });
          }

          if (yield* checkRunnerDriftGate()) return true;

          // [regime-gate] herding ENTER damper — ORCA's crash signature:
          // scanned pools moving in lockstep (high pairwise correlation /
          // edge density) marks systemic stress, exactly when rugs cluster
          // and freshly opened LP positions bleed. Blocks NEW entries for
          // THIS cycle only, every lane (a rotation executed under herding
          // churns capital twice inside the danger window); EXIT/REBALANCE
          // are untouched. Fail-open: unknown regime never blocks.
          function checkRegimeEnterGate(): Effect.Effect<boolean, never> {
            return Effect.gen(function* () {
              if (!cycleHerdingBlock) return false;
              console.info(
                `[regime-gate] Blocking ENTER ${poolAddress} — cross-pool herding above threshold`,
              );
              yield* audit
                .recordDecision({
                  timestamp: Date.now(),
                  cycleId,
                  poolAddress,
                  action: "ENTER",
                  confidence: 0,
                  reasoning:
                    "[regime-gate] cross-pool herding above threshold — systemic-stress window, no new capital",
                  metrics,
                  riskResult: {
                    approved: false,
                    reason: "[regime-gate] herding",
                  },
                  executed: false,
                  paperTrading: config.paperTrading,
                })
                .pipe(Effect.catch(() => Effect.void));
              return true;
            });
          }

          if (yield* checkRegimeEnterGate()) return true;

          // [drift-gate] negative-drift ENTER rejection — a pool trending DOWN
          // hard (net active-bin drift below MARKET_SCAN_MAX_NEGATIVE_DRIFT_BINS
          // over the recent-bin window) is not a momentum entry; reject BEFORE
          // the candidate conditions so a falling pool cannot clear the
          // fee/IL quality gates on fees earned before the slide. EXEMPT:
          // market-runner entries — the dip-ladder fills ON dips by design —
          // BUT the runner lane now enforces its own drift floor in
          // `isMarketRunnerPool` (MARKET_SCAN_RUNNER_MIN_DRIFT_BINS), so a
          // runner below that floor is never admitted here and falls through
          // to this gate. Launch-lane entries (young pools have no bin history
          // to drift) stay exempt; fallen-angel consumed the slot above — its
          // thesis IS post-drawdown entry. Applies to the NORMAL/market lane only.
          function checkDriftEnterGate(): Effect.Effect<boolean, never> {
            return Effect.gen(function* () {
              if (
                !(
                  !isMarketRunner(poolAddress) &&
                  !launchScanPools.has(poolAddress) &&
                  driftGateRejected(
                    netDriftBins,
                    config.marketScanMaxNegativeDriftBins ?? DEFAULT_MAX_NEGATIVE_DRIFT_BINS,
                  )
                )
              ) {
                return false;
              }
              console.info(
                `[drift-gate] Rejecting ENTER ${poolAddress} — net drift ${netDriftBins} bins < ${config.marketScanMaxNegativeDriftBins ?? DEFAULT_MAX_NEGATIVE_DRIFT_BINS}`,
              );
              yield* audit
                .recordDecision({
                  timestamp: Date.now(),
                  cycleId,
                  poolAddress,
                  action: "ENTER",
                  confidence: 0,
                  reasoning: `[drift-gate] net drift ${netDriftBins} bins below ${config.marketScanMaxNegativeDriftBins ?? DEFAULT_MAX_NEGATIVE_DRIFT_BINS} — falling price, no momentum entry`,
                  metrics,
                  riskResult: {
                    approved: false,
                    reason: `[drift-gate] drift ${netDriftBins} < ${config.marketScanMaxNegativeDriftBins ?? DEFAULT_MAX_NEGATIVE_DRIFT_BINS}`,
                  },
                  executed: false,
                  paperTrading: config.paperTrading,
                })
                .pipe(Effect.catch(() => Effect.void));
              return true;
            });
          }

          if (yield* checkDriftEnterGate()) return true;

          // [fee-il-gate] hard ENTER floor — expected fees must beat IL. Active
          // only when IL protection is enabled. feeIlRatio is never null
          // (0-20, strategy-service.ts) so the numeric compare is fail-closed
          // on 0 for REAL stats; a pool whose fees cannot cover estimated IL
          // never enters. FULL PRINCIPLE — modeled/fabricated fee/IL is EXCLUDED
          // from EVERY ENTER gate when feeIlRatioKnown=false (datapi-only).
          function checkFeeIlEnterGate(): Effect.Effect<boolean, never> {
            return Effect.gen(function* () {
              if (
                !(
                  config.ilProtectionEnabled === true &&
                  metrics.feeIlRatioKnown &&
                  feeIlRatio < config.minFeeIlRatio
                )
              ) {
                return false;
              }
              yield* audit
                .recordDecision({
                  timestamp: Date.now(),
                  cycleId,
                  poolAddress,
                  action: "ENTER",
                  confidence: 0,
                  reasoning: `[fee-il-gate] Fee/IL ratio ${feeIlRatio.toFixed(2)} below minimum ${config.minFeeIlRatio} — would-be conf ${normalEntryConfidence(feeIlRatio, netDriftBins, { referenceBins: config.entryMomentumReferenceBins ?? 20, confBoost: config.entryMomentumConfBoost ?? 0.05 }).toFixed(2)}`,
                  metrics,
                  riskResult: {
                    approved: false,
                    reason: `[fee-il-gate] Fee/IL ${feeIlRatio.toFixed(2)} < ${config.minFeeIlRatio}`,
                  },
                  executed: false,
                  paperTrading: config.paperTrading,
                })
                .pipe(Effect.catch(() => Effect.void));
              return true;
            });
          }

          if (yield* checkFeeIlEnterGate()) return true;
          return false;
        });
      }

      // (quality gates moved above; dispatch continues below)
      enterGateRejected = yield* checkEnterQualityGates(enterGateRejected);

      // Modeled/fabricated fee/IL (feeIlRatioKnown=false — gecko's binStep
      // base-rate model, or heuristic) never gates the candidate in EITHER
      // direction: the Data API exposes per-pool baseFeePct, so the generic
      // model can OVERSTATE a pool's base fee and the modeled ratio can
      // OVERSTATE economics — a modeled number gets no vote here. The fee/IL
      // conjunct is therefore conditional (true when the ratio is unknown) and
      // the pool is admitted on the MEASURED conditions only — real volume
      // authenticity, on-chain bin utilization, and TVL. This matches the
      // [fee-il-gate] floor and the weightedEntryScore fee term above/below,
      // which also skip the modeled ratio. A heuristic pool still cannot enter:
      // it fails volumeAuthenticityKnown below.
      // Measured-candidate + weighted-score gate: admitted on MEASURED conditions only.
      function evaluateEnterCandidate(enterGateRejected: boolean): Effect.Effect<
        {
          readonly rejected: boolean;
          readonly qualified: boolean;
          readonly entryScore: number | null;
        },
        never
      > {
        if (enterGateRejected)
          return Effect.succeed({ rejected: true, qualified: false, entryScore: null });
        function recordWeightedScoreRejection(entryScore: number): Effect.Effect<void, never> {
          return Effect.gen(function* () {
            yield* audit
              .recordDecision({
                timestamp: Date.now(),
                cycleId,
                poolAddress,
                action: "ENTER",
                confidence: 0,
                reasoning: `[weighted-score] score ${entryScore.toFixed(3)} <= threshold ${config.weightedEntryScoreThreshold} (would-be conf ${normalEntryConfidence(feeIlRatio, netDriftBins, { referenceBins: config.entryMomentumReferenceBins ?? 20, confBoost: config.entryMomentumConfBoost ?? 0.05 }).toFixed(2)})`,
                metrics,
                riskResult: {
                  approved: false,
                  reason: `[weighted-score] ${entryScore.toFixed(3)} <= ${config.weightedEntryScoreThreshold}`,
                },
                executed: false,
                paperTrading: config.paperTrading,
              })
              .pipe(Effect.catch(() => Effect.void));
          });
        }

        return Effect.gen(function* () {
          if (
            passesMeasuredCandidateGates(
              metrics.feeIlRatioKnown,
              feeIlRatio,
              evolvedThresholds.minFeeIlRatio,
              metrics.volumeAuthenticityKnown,
              volumeAuth,
              metrics.binUtilizationKnown,
              binUtilization,
              pool.tvlUsd,
              config.minPoolTvlUsd,
            )
          ) {
            const entryScore = weightedEntryScore(
              momentumMetrics,
              signalWeights,
              resolveMomentumScoreArgs(
                config.entryMomentumReferenceBins,
                config.entryMomentumScoreWeight,
              ),
            );
            if (entryScore <= config.weightedEntryScoreThreshold) {
              yield* recordWeightedScoreRejection(entryScore);
              return { rejected: true, qualified: false, entryScore: null };
            }
            return { rejected: false, qualified: true, entryScore };
          }
          return { rejected: false, qualified: false, entryScore: null };
        });
      }

      const enterCandidate = yield* evaluateEnterCandidate(enterGateRejected);
      enterGateRejected = enterCandidate.rejected;
      if (enterCandidate.qualified) {
        // ── Launch ENTER (Launch Mode v2) ─────────────────────────────
        // Moved intact from the ENTER slot; motivates in code comments below.
        // ── Launch ENTER (Launch Mode v2) ─────────────────────────────
        // Moved intact from the ENTER slot; motivates in code comments below.
        // ── Launch ENTER (Launch Mode v2) ─────────────────────────────
        // Moved intact from the ENTER slot; motivates in code comments below.
        // Rotation (market-runner lane only): the portfolio is full and a much
        // hotter runner is available — exit the LOWEST-APR held position so the
        // freed slot admits the runner next cycle. Fire-and-forget: the ENTER
        // is still consumed this cycle.
        function maybeRotateForRunnerLaunch(portfolioFull: boolean): Effect.Effect<void, never> {
          if (!portfolioFull) return Effect.void;
          return Effect.gen(function* () {
            if (
              portfolioFull &&
              config.marketScanRotationEnabled === true &&
              isMarketRunner(poolAddress)
            ) {
              const rotationCosts = resolveRotationCosts(
                config.launchPositionMaxSizeUsd,
                config.feeCaptureHarvestCostUsd,
                config.feeCaptureConversionCostPct,
                config.minYieldExitAgeMs,
              );
              const worst = lowestAprHeldPosition(
                Array.from(trackedPositions.values(), (p) => ({
                  poolAddress: p.poolAddress,
                  openedAt: p.timestamp,
                })),
                poolFeeAprByAddress,
                poolAddress, // never rotate out of the candidate runner
                // Economic-exit maturity gate: a minutes-old entry is
                // never a rotation target (same MIN_YIELD_EXIT_AGE_MS
                // class as the yield-regression exit).
                { minAgeMs: rotationCosts.minAgeMs, nowMs: Date.now() },
              );
              if (worst) {
                // G3 net-fee comparison (rule: measure practical
                // position output, not raw APR): both sides are
                // discounted by their capture share (position size vs
                // pool TVL — small entries on deep pools collect a
                // fraction of the headline APR), conversion cost and
                // harvest cost. Uniform share model on both sides (the
                // activeShareEstimate range/concentration model is
                // reserved for entry sizing); the comparison stays
                // size-aware and deliberately conservative.
                const incumbentPos = Array.from(trackedPositions.values()).find(
                  (p) => p.poolAddress === worst.poolAddress,
                );
                const incumbentSizeUsd = resolveIncumbentSizeUsd(incumbentPos);
                const runnerSizeUsd = rotationCosts.runnerSizeUsd;
                const shareFor = (sizeUsd: number, tvlUsd: number): number =>
                  tvlUsd > 0 && sizeUsd > 0 ? Math.min(sizeUsd / tvlUsd, 1) : 0;
                const harvestCostUsd = rotationCosts.harvestCostUsd;
                const conversionCostPct = rotationCosts.conversionCostPct;
                const runnerNetApr = runnerNetAprPct({
                  grossAprPct: poolFeeAprPct,
                  shareEstimate: shareFor(runnerSizeUsd, pool.tvlUsd),
                  harvestCostUsd,
                  conversionCostPct,
                  positionSizeUsd: runnerSizeUsd,
                  timeInRangePct: 1,
                });
                const incumbentNetApr = runnerNetAprPct({
                  grossAprPct: worst.feeAprPct,
                  shareEstimate: shareFor(incumbentSizeUsd, worst.tvlUsd),
                  harvestCostUsd,
                  conversionCostPct,
                  positionSizeUsd: incumbentSizeUsd,
                  timeInRangePct: 1,
                });
                if (
                  shouldRotate(
                    runnerNetApr,
                    {
                      poolAddress: worst.poolAddress,
                      feeAprPct: incumbentNetApr,
                      tvlUsd: worst.tvlUsd,
                    },
                    // Euphoria damper: when the challenger's headline APR
                    // is a self-history spike, demanding double the
                    // superiority keeps a blow-off top from buying an
                    // exit of a durable incumbent at the top tick.
                    resolveRotationAprMult(runnerAprOutlier, config.marketScanRotationAprMult),
                  )
                ) {
                  rawDecisions.push({
                    action: "EXIT",
                    poolAddress: worst.poolAddress,
                    confidence: 1,
                    reasoning: `Rotation: runner net ${runnerNetApr.toFixed(0)}% APR >= ${config.marketScanRotationAprMult ?? 5}x held net ${incumbentNetApr.toFixed(0)}%`,
                  });
                  // G2 rotation arm (TTL): the EXIT executes only while
                  // the arm is fresh and the runner still qualifies —
                  // cancel-and-preserve when the challenger evaporates.
                  yield* db
                    .setMetadata(
                      `rotarm:${worst.poolAddress}`,
                      JSON.stringify({
                        runner: poolAddress,
                        at: Date.now(),
                        apr: poolFeeAprPct,
                      }),
                    )
                    .pipe(Effect.catch(() => Effect.void));
                }
              }
            }
          });
        }

        // Launch gates: drift floor + cap (with rotation) for the drift-exempt lane.
        function checkLaunchGates(
          isLaunchPool: boolean,
          openLaunchPositions: number,
          launchMaxOpenPositions: number,
        ): Effect.Effect<boolean, never> {
          if (!isLaunchPool) return Effect.succeed(false);
          return Effect.gen(function* () {
            const totalOpenPositions = trackedPositions.size;
            const portfolioFull = totalOpenPositions >= (config.maxOpenPositions ?? 3);
            // [launch-drift-gate] a launch/runner candidate that is itself
            // a sustained decliner is rejected with an explicit audit row —
            // the same drift floor the normal lane enforces, applied to the
            // drift-exempt launch lane. A young pool can absolutely already
            // be bleeding for hours (the 2026-08 5A15QU field incident: a
            // 24h-old pool at −20 bins tripped the daily drawdown pause),
            // and the launch timebox is not a momentum filter. Unknown
            // drift (cold start, <2 bin snapshots) fails OPEN — a young
            // pool with no history cannot prove a decline.
            function checkLaunchDriftGate(): Effect.Effect<boolean, never> {
              return Effect.gen(function* () {
                if (
                  !(
                    config.launchScanEnabled === true &&
                    netDriftBins <
                      (config.marketScanRunnerMinDriftBins ?? DEFAULT_RUNNER_MIN_DRIFT_BINS)
                  )
                ) {
                  return false;
                }
                console.info(
                  `[launch-drift-gate] Rejecting launch ENTER ${poolAddress} — net drift ${netDriftBins} bins < ${config.marketScanRunnerMinDriftBins ?? DEFAULT_RUNNER_MIN_DRIFT_BINS}`,
                );
                yield* audit
                  .recordDecision({
                    timestamp: Date.now(),
                    cycleId,
                    poolAddress,
                    action: "ENTER",
                    confidence: 0,
                    reasoning: `[launch-drift-gate] launch net drift ${netDriftBins} bins below ${config.marketScanRunnerMinDriftBins ?? DEFAULT_RUNNER_MIN_DRIFT_BINS} — sustained decliner, not a dip`,
                    metrics,
                    riskResult: {
                      approved: false,
                      reason: `[launch-drift-gate] drift ${netDriftBins} < ${config.marketScanRunnerMinDriftBins ?? DEFAULT_RUNNER_MIN_DRIFT_BINS}`,
                    },
                    executed: false,
                    paperTrading: config.paperTrading,
                  })
                  .pipe(Effect.catch(() => Effect.void));
                return true;
              });
            }

            if (yield* checkLaunchDriftGate()) return true;
            if (openLaunchPositions >= launchMaxOpenPositions || portfolioFull) {
              // Two triggers share this branch: the launch cap being full,
              // or the portfolio-wide cap being full. The audit row below
              // names WHICH one fired — a bare "0 launch positions >= 2"
              // line when the real trigger was portfolio-full sent the
              // 2026-08-21 forensics down the wrong path.
              const launchCapFull = openLaunchPositions >= launchMaxOpenPositions;
              // Rotation (market-runner lane only): the portfolio is full
              // and a much hotter runner is available — exit the LOWEST-
              // APR held position so the freed slot admits the runner next
              // cycle. This is the "hold high-yield INSTEAD of flat
              // majors" mechanism: rotating existing exposure, never
              // adding. The exit is deterministic (confidence 1) and the
              // ENTER is still consumed this cycle (no exit-and-reenter in
              // one pass).
              yield* maybeRotateForRunnerLaunch(portfolioFull);
              // Launch cap full: reject the ENTER for this pool — it must
              // NOT fall through to the normal lane, which would size it
              // with the uncapped normal entry sizing.
              const launchBlockReason = launchCapFull
                ? `${openLaunchPositions} launch positions >= cap ${launchMaxOpenPositions}`
                : `portfolio full ${totalOpenPositions}/${config.maxOpenPositions ?? 3}`;
              yield* audit
                .recordDecision({
                  timestamp: Date.now(),
                  cycleId,
                  poolAddress,
                  action: "ENTER",
                  confidence: 0,
                  reasoning: `[launch-cap] ${launchBlockReason} — no launch slot`,
                  metrics,
                  riskResult: {
                    approved: false,
                    reason: `[launch-cap] ${launchBlockReason}`,
                  },
                  executed: false,
                  paperTrading: config.paperTrading,
                })
                .pipe(Effect.catch(() => Effect.void));
              return true;
            }
            return false;
          });
        }

        // Launch dispatch: sizing + allocation + net-gate + token-risk + ENTER push.
        function dispatchLaunchEnter(): Effect.Effect<boolean, never> {
          return Effect.gen(function* () {
            const launchSizeUsd = launchEntrySizeUsd({
              walletUsd: walletBalanceUsd,
              poolTvlUsd: pool.tvlUsd,
              maxSizeUsd: config.launchPositionMaxSizeUsd ?? 100,
            });
            if (launchSizeUsd <= 0) {
              // Degenerate sizing (zero TVL or wallet) — no entry.
              // Consume the slot so the normal lane cannot substitute
              // its own sizing for a launch-gated pool.
              yield* audit
                .recordDecision({
                  timestamp: Date.now(),
                  cycleId,
                  poolAddress,
                  action: "ENTER",
                  confidence: 0,
                  reasoning: "[launch-size] Launch entry size rounds to zero",
                  metrics,
                  riskResult: {
                    approved: false,
                    reason: "[launch-size] Launch entry size rounds to zero",
                  },
                  executed: false,
                  paperTrading: config.paperTrading,
                })
                .pipe(Effect.catch(() => Effect.void));
              return true;
            } else {
              const launchAllocation = evaluatePerPoolAllocation({
                proposedDepositUsd: launchSizeUsd,
                portfolioValueUsd,
                openPositions,
                maxPerPoolAllocationPct: config.maxPerPoolAllocationPct,
                maxOpenPositions: config.maxOpenPositions,
                poolAddress,
                maxPositionsPerPool: config.maxPositionsPerPool,
              });
              if (!launchAllocation.approved) {
                console.info(
                  `[launch-alloc-gate] Skipping launch ENTER ${poolAddress} — ${launchAllocation.reason}`,
                );
                yield* audit
                  .recordDecision({
                    timestamp: Date.now(),
                    cycleId,
                    poolAddress,
                    action: "ENTER",
                    confidence: 0,
                    reasoning: `[launch-alloc-gate] ${launchAllocation.reason}`,
                    metrics,
                    riskResult: {
                      approved: false,
                      reason: `[launch-alloc-gate] ${launchAllocation.reason}`,
                    },
                    executed: false,
                    paperTrading: config.paperTrading,
                  })
                  .pipe(Effect.catch(() => Effect.void));
                return true;
              } else {
                // [entry-net-gate] ENTER-side feasibility for the
                // runner/hot lane: a candidate must clear its net-daily
                // yield floor AFTER churn/IL/swap cost BEFORE entering —
                // otherwise we spend an entry+exit round-trip to discover
                // the pool doesn't pay for its own churn (the deep-but-slow
                // pool thrash). This is the mirror of the [net-bleed] EXIT
                // guard: measured fees only (runner pools are datapi-only
                // via `statsSource === "datapi"`); fails open does not
                // block when the fees are unmeasured or the runner lane is
                // off, so legacy/non-runner entries are unaffected.
                function checkLaunchEntryNetGate(
                  launchSizeUsd: number,
                ): Effect.Effect<boolean, never> {
                  return Effect.gen(function* () {
                    if (
                      !(
                        config.marketScanRunnerEnabled === true &&
                        metrics.feeIlRatioKnown &&
                        launchSizeUsd > 0
                      )
                    ) {
                      return false;
                    }
                    const entryNetPct = computePositionNetDailyPct(
                      pool.fees24hUsd,
                      pool.tvlUsd,
                      launchSizeUsd,
                      rangeHalfWidth,
                      pool.binStep,
                      volatilityStddev,
                      config.runnerSwapCostPct,
                      config.feeCaptureHarvestCostUsd,
                      config.scanIntervalMs,
                    );
                    if (entryNetPct >= (config.runnerNetFloorPct ?? 1)) return false;
                    yield* audit
                      .recordDecision({
                        timestamp: Date.now(),
                        cycleId,
                        poolAddress,
                        action: "ENTER",
                        confidence: 0,
                        reasoning: `[entry-net-gate] runner net ${entryNetPct.toFixed(2)}%/day < floor ${config.runnerNetFloorPct ?? 1}%/day after churn/IL/swap cost — entering would not be economical`,
                        metrics,
                        riskResult: {
                          approved: false,
                          reason: `[entry-net-gate] net ${entryNetPct.toFixed(2)}%/day < ${config.runnerNetFloorPct ?? 1}%/day`,
                        },
                        executed: false,
                        paperTrading: config.paperTrading,
                      })
                      .pipe(Effect.catch(() => Effect.void));
                    return true;
                  });
                }

                if (yield* checkLaunchEntryNetGate(launchSizeUsd)) return true;

                // [token-risk] launch ENTER gate — the same advisory overlay
                // as the normal lane: blocks when either leg carries a hard
                // risk signal; unknown/disabled/failed signals never block.
                function checkLaunchTokenRisk(): Effect.Effect<boolean, never> {
                  return Effect.gen(function* () {
                    if (config.jupiterTokenRiskEnabled === false) return false;
                    const launchRisk = yield* Effect.promise(() =>
                      consultTokenRisks([pool.tokenX, pool.tokenY], config),
                    );
                    const launchRiskReasons = [
                      resolveLegRiskReason(launchRisk, pool.tokenX, pool.tokenXSymbol),
                      resolveLegRiskReason(launchRisk, pool.tokenY, pool.tokenYSymbol),
                    ].filter((reason): reason is string => reason !== null);
                    if (launchRiskReasons.length === 0) return false;
                    yield* audit
                      .recordDecision({
                        timestamp: Date.now(),
                        cycleId,
                        poolAddress,
                        action: "ENTER",
                        confidence: 0,
                        reasoning: `[token-risk] ${launchRiskReasons.join("; ")} — launch ENTER blocked`,
                        metrics,
                        riskResult: {
                          approved: false,
                          reason: `[token-risk] ${launchRiskReasons.join("; ")}`,
                        },
                        executed: false,
                        paperTrading: config.paperTrading,
                      })
                      .pipe(Effect.catch(() => Effect.void));
                    return true;
                  });
                }

                if (yield* checkLaunchTokenRisk()) return true;
                rawDecisions.push({
                  action: "ENTER",
                  poolAddress,
                  confidence: Math.min(0.5 + feeIlRatio * 0.05, 0.85),
                  reasoning: `Launch: launch-gated hot pool — time-boxed entry, $${launchAllocation.adjustedDepositUsd.toFixed(0)}`,
                  positionSizeUsd: launchAllocation.adjustedDepositUsd,
                  positionMode: "launch",
                });
                // Consume the ENTER slot: the launch branch pushed the
                // decision, so the normal ENTER below must not duplicate.
                return true;
              }
            }
          });
        }

        // ── Normal ENTER ─────────────────────────────────────────
        // Standard fee-harvesting entry: allocation, idle-redeploy capture,
        // token-risk overlay, take-profit ladder, ENTER push.
        // Idle-redeploy capture: a fully-vetted pool stays deployable for the
        // redeploy pass (second position or risk-tail rejection). Launch pools
        // are EXCLUDED — the redeploy pass emits STANDARD decisions.
        function captureIdleRedeployCandidate(
          normalEntrySizeUsd: number,
        ): Effect.Effect<void, never> {
          if (!config.idleRedeployEnabled) return Effect.void;
          return Effect.gen(function* () {
            let redeployTokenRiskClean = true;
            if (config.jupiterTokenRiskEnabled !== false) {
              const redeployLegRisks = yield* Effect.promise(() =>
                consultTokenRisks([pool.tokenX, pool.tokenY], config),
              );
              for (const legMint of [pool.tokenX, pool.tokenY]) {
                const legSignal = redeployLegRisks.get(legMint);
                if (
                  legSignal !== undefined &&
                  (legSignal.isSus ||
                    legSignal.goPlusHardRisk != null ||
                    legSignal.organicScoreLabel === "low")
                ) {
                  redeployTokenRiskClean = false;
                  break;
                }
              }
            }
            if (redeployTokenRiskClean && !isLaunchPool) {
              // Launch pools are EXCLUDED from the idle-redeploy queue:
              // the redeploy pass emits a STANDARD decision (no
              // positionMode: "launch"), so a redeploy entry would carry
              // neither the launch timebox/decay/drawdown protection
              // nor the runner dip shape. The launch lane's own ENTER
              // branch owns launch entries.
              idleRedeployCandidates.push({
                poolAddress,
                pool,
                metrics,
                entryScore: enterCandidate.entryScore ?? 0,
                feeIlRatio,
                normalEntrySizeUsd,
                volatilityStddev,
                netDriftBins,
              });
            }
          });
        }

        function evaluateNormalEnter(enterGateRejected: boolean): Effect.Effect<boolean, never> {
          if (enterGateRejected) return Effect.succeed(true);
          return Effect.gen(function* () {
            const proposedSizeUsd = computeEntrySizeUsd({
              walletBalanceUsd,
              tvlUsd: pool.tvlUsd,
              maxSizeUsd: config.maxEntrySizeUsd,
            });

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
                .pipe(Effect.catch(() => Effect.void));
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
                .pipe(Effect.catch(() => Effect.void));
              // Idle-redeploy capture: candidate conditions + score passed
              // but allocation has no headroom (typically MAX_OPEN_POSITIONS
              // reached — a slot can free mid-cycle when a LATER pool exits).
              // The pass could dispatch this pool, so consult token-risk
              // first EXACTLY as the in-slot gate does: a hard-risk signal
              // disqualifies the candidate. Reuses the per-cycle token-risk
              // cache, so this costs no round-trip when the screening seam
              // already fetched these mints.
              yield* captureIdleRedeployCandidate(proposedSizeUsd);
              return true;
            } else {
              // [token-risk] ENTER gate (Wave 18): Jupiter advisory overlay —
              // the FINAL ENTER gate. Runs only AFTER every local predicate and
              // the allocation cap have passed, so an allocation-dead pool (no
              // headroom, or MAX_OPEN_POSITIONS reached) never pays the Jupiter
              // round-trip — when Jupiter is down that was up to a 10s serial
              // timeout per allocation-dead pool per cycle. Blocks entry when
              // either leg carries a hard-risk signal — Jupiter isSus
              // (aggregated RugCheck+Blockaid) or a "low" organic score.
              // Advisory and fail-open: unknown, disabled or failed signals
              // never block entry. Audit-reason precedence: allocation
              // rejections log alloc-gate and consult nothing; token-risk
              // rejections only fire for candidates that survived every local
              // gate. Reuses the per-cycle token-risk cache, so a second
              // consult costs no network call when the screening seam already
              // fetched these mints.
              function checkNormalEnterTokenRisk(): Effect.Effect<boolean, never> {
                return Effect.gen(function* () {
                  if (config.jupiterTokenRiskEnabled === false) return false;
                  const enterRisk = yield* Effect.promise(() =>
                    consultTokenRisks([pool.tokenX, pool.tokenY], config),
                  );
                  const riskReasons = [
                    resolveLegRiskReason(enterRisk, pool.tokenX, pool.tokenXSymbol),
                    resolveLegRiskReason(enterRisk, pool.tokenY, pool.tokenYSymbol),
                  ].filter((reason): reason is string => reason !== null);
                  if (riskReasons.length === 0) return false;
                  yield* audit
                    .recordDecision({
                      timestamp: Date.now(),
                      cycleId,
                      poolAddress,
                      action: "ENTER",
                      confidence: 0,
                      reasoning: `[token-risk] ${riskReasons.join("; ")} — ENTER blocked`,
                      metrics,
                      riskResult: {
                        approved: false,
                        reason: `[token-risk] ${riskReasons.join("; ")}`,
                      },
                      executed: false,
                      paperTrading: config.paperTrading,
                    })
                    .pipe(Effect.catch(() => Effect.void));
                  return true;
                });
              }

              if (yield* checkNormalEnterTokenRisk()) return true;

              const positionSizeUsd = allocation.adjustedDepositUsd;
              // Normal-lane take-profit (winrate fix): when enabled, every
              // normal ENTER carries a single-rung TP ladder at
              // TAKE_PROFIT_PCT above entry; the invalidation leg uses the
              // existing trailing-stop pct (the normal lane's downside rule).
              const tpLadder = resolveNormalEnterTpLadder(
                pool.currentPrice,
                config.takeProfitEnabled,
                config.takeProfitPct,
                config.trailingStopPct,
              );
              rawDecisions.push({
                action: "ENTER",
                poolAddress,
                // Momentum boost: positive drift earns up to
                // ENTRY_MOMENTUM_CONF_BOOST on the static base confidence
                // (negative → 0), still capped at 0.85. Runner/launch lanes
                // keep the static formula — this is the normal lane only.
                confidence: resolveNormalEntryConfidence(
                  feeIlRatio,
                  netDriftBins,
                  config.entryMomentumReferenceBins,
                  config.entryMomentumConfBoost,
                ),
                reasoning: `Strong pool: Fee/IL ${feeIlRatio.toFixed(2)}, auth ${volumeAuth.toFixed(2)}, TVL $${pool.tvlUsd.toFixed(0)}`,
                positionSizeUsd,
                ...resolveTpLadderSpread(tpLadder),
              });
              // Idle-redeploy capture: the pool passed every in-slot gate
              // (conditions, score, allocation, token-risk), so it is a
              // fully-vetted candidate whether or not this ENTER executes
              // — a second position on the same pool (Wave 10) or a
              // risk-tail rejection both leave idle capital deployable.
              yield* captureIdleRedeployCandidate(positionSizeUsd);
            }
            return true;
          });
        }

        function evaluateLaunchEnter(
          enterGateRejected: boolean,
          isLaunchPool: boolean,
          openLaunchPositions: number,
          launchMaxOpenPositions: number,
        ): Effect.Effect<boolean, never> {
          if (enterGateRejected) return Effect.succeed(true);
          return Effect.gen(function* () {
            const gatesRejected = yield* checkLaunchGates(
              isLaunchPool,
              openLaunchPositions,
              launchMaxOpenPositions,
            );
            if (gatesRejected) return true;
            if (!isLaunchPool) return false;
            return yield* dispatchLaunchEnter();
          });
        }

        const openLaunchPositions = Array.from(trackedPositions.values()).filter(
          (p) => p.positionMode === "launch",
        ).length;
        const launchMaxOpenPositions = config.launchMaxOpenPositions ?? 3;
        const isLaunchPool =
          (config.launchScanEnabled === true &&
            config.launchExecutionEnabled === true &&
            launchScanPools.has(poolAddress)) ||
          isMarketRunner(poolAddress);
        enterGateRejected = yield* evaluateLaunchEnter(
          enterGateRejected,
          isLaunchPool,
          openLaunchPositions,
          launchMaxOpenPositions,
        );

        enterGateRejected = yield* evaluateNormalEnter(enterGateRejected);
      }

      yield* runIdleRedeploySite();

      // An empty hold needs no short-circuit: the tail below iterates
      // rawDecisions and yields [] when there is nothing to decide.
      yield* pushDefaultHold(enterGateRejected);

      // ── Per-decision tail: overlay → supervised → risk → execution → audit.
      // Decisions run sequentially so a queued proposal consumed by one
      // decision is gone for the next, and so executions mutate tracking in
      // a deterministic order (per-position decisions first, ENTER last).
      const finalDecisions: AgentDecision[] = [];
      const entryPrep = yield* EntryPrepService;

      // Resolve the deposit distribution for entries: a concrete configured
      // shape is used as-is; `auto` picks per pool from the recent volatility
      // regime (see recommendStrategy). `spot` is the default.
      const entryStrategySpec: EntryStrategySpec = resolveEntryStrategySpec(
        config.entryStrategyType,
        volatilityStddev,
        config.volatilityExitStddev,
        netDriftBins,
      );

      // Veto safety overlay: fail-open enhanceDecision with throttled warnings.
      // Returns the (possibly overridden) decision.
      function fetchVetoOverride(
        decision: AgentDecision,
        pos: PositionRecord | undefined,
        hasOpenPosition: boolean,
      ): Effect.Effect<AgentDecision, never> {
        return Effect.gen(function* () {
          let current = decision;
          // Veto is a safety overlay: it runs independently of the proposal
          // backoff/circuit-breaker path so a transient failure cannot silence it.
          let vetoFetchFailed = false;
          let vetoWarnEligible = false;
          const vetoStartedAt = Date.now();
          const enhanced = yield* agent
            .enhanceDecision(decision, {
              decision,
              pool,
              metrics,
              warnings,
              recentDecisions: yield* audit
                .getRecentDecisions(10)
                .pipe(Effect.catch(() => Effect.succeed([]))),
              hasOpenPosition,
              ...(pos !== undefined
                ? { position: toAgentPositionState(pos, Date.now()) }
                : undefined),
            })
            .pipe(
              // Bound the ENTIRE veto op by the veto deadline, CONNECT included.
              // sendPrompt's per-request timer only starts AFTER the transport
              // (re)connects (Gateway ~10s handshake; ACP ensureSession on the
              // general AGENT_PROMPT_TIMEOUT_MS), so an outer deadline is the only
              // thing keeping a stalled reconnect from delaying a capital-protecting
              // EXIT past AGENT_VETO_TIMEOUT_MS. Fails open via the catch below.
              Effect.timeoutOrElse({
                duration: `${config.agentVetoTimeoutMs} millis`,
                orElse: () =>
                  Effect.fail(
                    new Error(
                      `Agent veto review timed out after ${config.agentVetoTimeoutMs}ms (transport connect/session establishment + prompt exceeded the veto budget)`,
                    ),
                  ),
              }),
              Effect.catch((err) => {
                vetoFetchFailed = true;
                const elapsedMs = Date.now() - vetoStartedAt;
                const message = underlyingErrorMessage(err);
                // Compute throttle eligibility ONCE: the catch owns the single
                // throttle read+set so the warn log and the memory warning below
                // fire together exactly once per veto-warning window
                // (agentProposalStaleMs, per pool). The memory block reuses
                // vetoWarnEligible instead of re-reading the map — a second read
                // would see the just-set timestamp and skip the memory write.
                // Suppressed occurrences stay at debug with no memory entry.
                // Fail-open preserved: always resolves to null, decision unchanged.
                vetoWarnEligible =
                  Date.now() - (vetoWarningThrottle.get(poolAddress) ?? 0) >
                  config.agentProposalStaleMs;
                if (vetoWarnEligible) {
                  vetoWarningThrottle.set(poolAddress, Date.now());
                  logger.warn("Agent veto fetch failed", {
                    pool: poolAddress,
                    error: message,
                    elapsedMs,
                    timeoutMs: config.agentVetoTimeoutMs,
                    gatewayUrl: config.agentGatewayUrl,
                  });
                } else {
                  logger.debug("Agent veto fetch failed (throttled)", {
                    pool: poolAddress,
                    error: message,
                    elapsedMs,
                  });
                }
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
            current = enhanced;
          } else if (vetoFetchFailed && vetoWarnEligible) {
            // Throttle already consumed in the catch above: this fires
            // together with the warn log, exactly once per window.
            yield* memory
              .upsert({
                category: "warning",
                content: `Agent veto fetch failed for ${poolAddress}`,
                poolAddress,
              })
              .pipe(Effect.catch(() => Effect.void));
          }
          return current;
        });
      }

      // Proposal resolve: adopt a queued proposal, else sync-fetch (non-supervised).
      function resolveDecisionProposal(
        decision: AgentDecision,
        proposalMode: AgentProposalMode,
        poolCircuitBreaker: ReturnType<typeof getPoolCircuitBreaker>,
        pos: PositionRecord | undefined,
        hasOpenPosition: boolean,
        now: number,
      ): Effect.Effect<
        {
          agentProposal: AgentProposal | null;
          proposalSource: "queue" | "sync" | undefined;
          syncFetchFailed: boolean;
        },
        never
      > {
        function fetchSyncDecisionProposal(
          decision: AgentDecision,
          poolCircuitBreaker: ReturnType<typeof getPoolCircuitBreaker>,
          pos: PositionRecord | undefined,
          hasOpenPosition: boolean,
          now: number,
        ): Effect.Effect<
          {
            agentProposal: AgentProposal | null;
            proposalSource: "queue" | "sync" | undefined;
            syncFetchFailed: boolean;
          } | null,
          never
        > {
          return Effect.gen(function* () {
            const agentStatus = yield* agent.getStatus().pipe(
              Effect.catch(() =>
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
              return null;
            }
            if (!poolCircuitBreaker.canTry(now)) {
              logger.info("Agent proposal circuit breaker open — skipping sync", {
                pool: poolAddress,
              });
              return null;
            }
            if (isProposalBackoffActive(proposalBackoff.get(poolAddress), now)) {
              logger.info("Agent proposal sync skipped — backoff active", {
                pool: poolAddress,
              });
              return null;
            }
            // Latency skip mirrors the veto path: when the rolling p95 of
            // proposal latencies exceeds the proposal budget, skip the
            // round trip fail-open WITHOUT arming backoff/circuit failure
            // (a slow model is not a bad advisor).
            const latencySkipped = yield* agent.shouldSkipSyncProposal();
            if (latencySkipped) {
              logger.info(
                "Agent proposal sync skipped — rolling p95 latency exceeds proposal budget",
                { pool: poolAddress },
              );
              return null;
            }
            let syncFetchFailed = false;
            const syncProposal = yield* agent
              .enhanceDecision(decision, {
                decision,
                pool,
                metrics,
                warnings,
                recentDecisions: yield* audit
                  .getRecentDecisions(10)
                  .pipe(Effect.catch(() => Effect.succeed([]))),
                hasOpenPosition,
                ...(pos !== undefined
                  ? { position: toAgentPositionState(pos, Date.now()) }
                  : undefined),
              })
              .pipe(
                // Outer deadline mirrors the veto path: sendPrompt's own
                // timer starts only AFTER transport (re)connect, so a
                // stalled reconnect must not hold the decision loop past
                // the proposal budget.
                Effect.timeoutOrElse({
                  duration: `${config.agentProposalTimeoutMs} millis`,
                  orElse: () =>
                    Effect.fail(
                      new Error(
                        `Agent proposal sync timed out after ${config.agentProposalTimeoutMs}ms`,
                      ),
                    ),
                }),
                Effect.catch((err) => {
                  syncFetchFailed = true;
                  logger.warn("Agent proposal fetch failed", {
                    pool: poolAddress,
                    error: String(err),
                  });
                  return Effect.succeed(null);
                }),
              );
            if (syncProposal && isAgentProposal(syncProposal)) {
              return {
                agentProposal: syncProposal,
                proposalSource: "sync",
                syncFetchFailed,
              } as const;
            }
            // Real transport attempt returned null (parse/timeout/etc.).
            return {
              agentProposal: null,
              proposalSource: undefined,
              syncFetchFailed: syncFetchFailed || syncProposal === null,
            };
          });
        }

        return Effect.gen(function* () {
          let agentProposal: AgentProposal | null = null;
          let proposalSource: "queue" | "sync" | undefined;
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
            const synced = yield* fetchSyncDecisionProposal(
              decision,
              poolCircuitBreaker,
              pos,
              hasOpenPosition,
              now,
            );
            if (synced) {
              agentProposal = synced.agentProposal;
              proposalSource = synced.proposalSource;
              syncFetchFailed = synced.syncFetchFailed;
            }
          }
          return { agentProposal, proposalSource, syncFetchFailed };
        });
      }

      // Proposal apply: validate an adopted proposal and apply its adjustment.
      function applyDecisionProposal(
        decision: AgentDecision,
        agentProposal: AgentProposal,
        proposalSource: "queue" | "sync" | undefined,
        now: number,
        proposalMode: AgentProposalMode,
        poolCircuitBreaker: ReturnType<typeof getPoolCircuitBreaker>,
      ): Effect.Effect<
        {
          decision: AgentDecision;
          preApplyDecision: AgentDecision | undefined;
          proposalValidated: boolean;
          appliedAgentProposal: boolean;
          appliedQueuedProposalId: string | undefined;
        },
        never
      > {
        return Effect.gen(function* () {
          let current = decision;
          let preApplyDecision: AgentDecision | undefined;
          let proposalValidated = false;
          let appliedAgentProposal = false;
          let appliedQueuedProposalId: string | undefined;

          // Suggest mode: advisory log + dequeue, never changes the decision.
          function applySuggestProposal(
            adjustedDecision: AgentDecision,
          ): Effect.Effect<void, never> {
            return Effect.gen(function* () {
              logger.info("Agent proposal suggested (advisory)", {
                source: proposalSource,
                pool: poolAddress,
                from: decision.action,
                suggested: adjustedDecision.action,
              });
              yield* memory
                .upsert({
                  category: "pattern",
                  content: `Advisory suggestion for ${poolAddress}: ${adjustedDecision.action} (confidence ${adjustedDecision.confidence.toFixed(2)})`,
                  poolAddress,
                })
                .pipe(Effect.catch(() => Effect.void));

              proposalBackoff.delete(poolAddress);
              poolCircuitBreaker.recordSuccess();

              const queuedProposalId = resolveRedeployAppliedProposalId(
                proposalSource,
                agentProposal.proposalId,
              );
              if (queuedProposalId !== undefined) {
                yield* agentState
                  .dequeueProposals([queuedProposalId])
                  .pipe(Effect.catch(() => Effect.void));
              }
            });
          }

          // Full/veto/supervised commit: apply the validated adjustment.
          function commitProposalAdjustment(
            adjustedDecision: AgentDecision,
          ): Effect.Effect<void, never> {
            return Effect.gen(function* () {
              logger.info("Agent proposal applied", {
                source: proposalSource,
                pool: poolAddress,
                from: decision.action,
                to: adjustedDecision.action,
              });
              preApplyDecision = decision;
              const originalAction = decision.action;
              const deterministicReasoning = decision.reasoning;
              // Preserve the launch lane marker: an advisor that echoes or
              // resizes a launch ENTER must not silently drop positionMode
              // — the launch timebox/decay/drawdown exits key off it.
              current = preserveLaunchMarker(decision, adjustedDecision);
              current = preserveExitReasoning(
                originalAction,
                decision.action,
                deterministicReasoning,
                current,
              );
              // Proposal hard-floor (0.2.27): a proposal-applied ENTER must
              // not bypass the engine's deterministic hard rejections. The
              // harness (full/supervised) may only operate WITHIN the same
              // safety envelope the deterministic chain enforces — it can
              // downgrade, resize, or echo, but it cannot enter a pool the
              // engine would hard-reject (drift, fee/IL, launch drift).
              // Re-run the same predicates against the ADJUSTED decision;
              // any hit forces HOLD with an audited reason.
              if (decision.action === "ENTER") {
                const hardRejectReason =
                  feeIlHardFloorReason(
                    config.ilProtectionEnabled,
                    metrics.feeIlRatioKnown,
                    feeIlRatio,
                    config.minFeeIlRatio,
                  ) ??
                  driftHardFloorReason(
                    launchScanPools.has(poolAddress),
                    isMarketRunner(poolAddress),
                    netDriftBins,
                    config.marketScanMaxNegativeDriftBins,
                  ) ??
                  launchDriftHardFloorReason(
                    config.launchScanEnabled,
                    netDriftBins,
                    config.marketScanRunnerMinDriftBins,
                  );
                if (hardRejectReason !== null) {
                  logger.warn("Agent proposal ENTER blocked by hard floor — forcing HOLD", {
                    pool: poolAddress,
                    reason: hardRejectReason,
                  });
                  yield* audit
                    .recordDecision({
                      timestamp: Date.now(),
                      cycleId,
                      poolAddress,
                      action: "HOLD",
                      confidence: 0,
                      reasoning: `[proposal-hard-floor] ${hardRejectReason} — agent-proposed ENTER overridden to HOLD`,
                      metrics,
                      riskResult: {
                        approved: false,
                        reason: `[proposal-hard-floor] ${hardRejectReason}`,
                      },
                      executed: false,
                      paperTrading: config.paperTrading,
                    })
                    .pipe(Effect.catch(() => Effect.void));
                  current = {
                    action: "HOLD",
                    poolAddress,
                    confidence: 0,
                    reasoning: `[proposal-hard-floor] ${hardRejectReason} — agent-proposed ENTER overridden to HOLD`,
                  };
                }
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
              appliedQueuedProposalId =
                resolveRedeployAppliedProposalId(proposalSource, agentProposal.proposalId) ??
                appliedQueuedProposalId;
            });
          }

          const poolBackoff = proposalBackoff.get(poolAddress);
          const proposalToEvaluate = buildProposalToEvaluate(
            agentProposal,
            decision.action,
            decision.confidence,
          );
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
          validation = yield* checkProposalRebalanceGates(validation, decision, now);

          function checkProposalRebalanceGates(
            validation: ReturnType<typeof evaluateAgentProposal>,
            decision: AgentDecision,
            now: number,
          ): Effect.Effect<ReturnType<typeof evaluateAgentProposal>, never> {
            return Effect.gen(function* () {
              const gatePos = resolveRebalanceGatePosition(
                validation.adjustedDecision?.positionId,
                decision.positionId,
                trackedPositions,
              );
              if (
                !(
                  validation.valid &&
                  validation.adjustedDecision?.action === "REBALANCE" &&
                  gatePos !== undefined
                )
              ) {
                return validation;
              }
              const positionCenter = (gatePos.lowerBinId + gatePos.upperBinId) / 2;
              const oorGraceExpired = gatePos.oorCycleCount >= config.oorGracePeriodCycles;
              const recoveryProb = estimateRecoveryProbability(
                recoveryBins,
                Math.abs(pool.activeBinId - positionCenter),
              );
              const positionSharePct = resolvePositionSharePct(
                pool.tvlUsd,
                gatePos.currentValueUsd,
              );
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
                return { valid: false, reason: capitalGate.reason };
              }
              return validation;
            });
          }

          function recordProposalRejection(reason: string | undefined): Effect.Effect<void, never> {
            return Effect.gen(function* () {
              logger.warn("Agent proposal rejected", {
                source: proposalSource,
                pool: poolAddress,
                reason,
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
                  content: `Agent proposal rejected for ${poolAddress}: ${reason}`,
                  poolAddress,
                })
                .pipe(Effect.catch(() => Effect.void));
              const queuedProposalId = resolveRedeployAppliedProposalId(
                proposalSource,
                agentProposal.proposalId,
              );
              if (queuedProposalId !== undefined) {
                yield* agentState
                  .rejectProposal(queuedProposalId)
                  .pipe(Effect.catch(() => Effect.void));
              }
              yield* agentState
                .setAgentPolicy({ lastProposalAt: now })
                .pipe(Effect.catch(() => Effect.void));
            });
          }

          if (validation.valid && validation.adjustedDecision) {
            if (proposalMode === "suggest") {
              yield* applySuggestProposal(validation.adjustedDecision);
            } else {
              yield* commitProposalAdjustment(validation.adjustedDecision);
              yield* agentState
                .setAgentPolicy({ lastProposalAt: now })
                .pipe(Effect.catch(() => Effect.void));
            }
          } else {
            yield* recordProposalRejection(validation.reason);
          }
          return {
            decision: current,
            preApplyDecision,
            proposalValidated,
            appliedAgentProposal,
            appliedQueuedProposalId,
          };
        });
      }

      // Proposal fetch-failure record: backoff + circuit-breaker + memory note.
      function recordProposalFetchFailure(
        now: number,
        poolCircuitBreaker: ReturnType<typeof getPoolCircuitBreaker>,
      ): Effect.Effect<void, never> {
        return Effect.gen(function* () {
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
            .pipe(Effect.catch(() => Effect.void));
        });
      }

      // Supervised mode: hold ENTER/REBALANCE without an approved proposal.
      function checkSupervisedHold(
        decision: AgentDecision,
        appliedQueuedProposalId: string | undefined,
      ): Effect.Effect<AgentDecision, never> {
        return Effect.gen(function* () {
          let current = decision;
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
            current = {
              ...decision,
              action: "HOLD",
              reasoning: `Supervised mode: awaiting approved proposal (held ${decision.action}: ${decision.reasoning})`,
            };
          }
          return current;
        });
      }

      // Copy-signal boost: bounded advisory confidence boost (never EXIT).
      function applyCopySignalBoostStep(
        decision: AgentDecision,
      ): Effect.Effect<AgentDecision, never> {
        return Effect.gen(function* () {
          let current = decision;
          const copySignalResult =
            copySignalsOption._tag === "Some"
              ? yield* copySignalsOption.value.getBoost(poolAddress, Date.now())
              : { boost: 0, wallets: [], ignored: 0 };
          if (copySignalResult.boost > 0 && decision.action !== "EXIT") {
            current = applyCopySignalBoost(
              decision,
              copySignalResult,
              config.copySignalsMaxBoost ?? 0.05,
            );
            logger.info("Applied bounded copy-trading signal boost", {
              pool: poolAddress,
              boost: copySignalResult.boost,
              wallets: copySignalResult.wallets.length,
              ignored: copySignalResult.ignored,
              paperTrading: config.paperTrading,
            });
          }
          return current;
        });
      }

      // Risk evaluation: ctx + evaluate + resize + denial (denied skips execution).
      function evaluateDecisionRisk(
        decision: AgentDecision,
        pos: PositionRecord | undefined,
        appliedAgentProposal: boolean,
        preApplyDecision: AgentDecision | undefined,
        appliedQueuedProposalId: string | undefined,
      ): Effect.Effect<
        { decision: AgentDecision; riskResult: RiskResult; denied: boolean },
        Error
      > {
        return Effect.gen(function* () {
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
            rollingRealizedPnlHalted: cycle.rollingRealizedPnlHalted,
          };
          // Issue #148: the wallet safety pause is informational in shadow mode
          // (no-send by design) — it must never block a decision there.
          const pauseBlockReason = safetyPauseBlockReason(
            autonomousExecution?.mode,
            activeSafetyPause,
            decision.action,
          );
          const riskResult: RiskResult =
            pauseBlockReason === null
              ? decision.action === "HOLD"
                ? { approved: true, reason: "HOLD — no execution; risk gates skipped" }
                : risk.evaluate(decision, riskCtx)
              : { approved: false, reason: pauseBlockReason };

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
              ...(pos !== undefined ? { positionId: pos.positionId } : undefined),
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
              .pipe(Effect.catch(() => Effect.void));
            yield* memory
              .upsert({
                category: "warning",
                content: `Decision rejected: ${riskResult.reason}. Action: ${decision.action}`,
                poolAddress,
              })
              .pipe(Effect.catch(() => Effect.void));

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
            const denied: boolean = true;
            return { decision, riskResult, denied };
          }
          return { decision, riskResult, denied: false };
        });
      }

      // ENTER execution prep: live wallet gate, strategy/range logs, SOL budget gate.
      // done=true means the decision was fully handled (pushed + audited); skip the rest.
      function prepareEnterExecution(
        decision: AgentDecision,
        pos: PositionRecord | undefined,
        appliedQueuedProposalId: string | undefined,
      ): Effect.Effect<{ done: boolean }, never> {
        return Effect.gen(function* () {
          function checkPaperValidationEnter(): Effect.Effect<{ done: boolean } | null, never> {
            return Effect.gen(function* () {
              if (config.paperTrading || decision.action !== "ENTER") return null;
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
              if (validation.approved) return null;
              console.warn(
                `[paper-validation] Blocking live ENTER on ${poolAddress} — ${validation.reason}`,
              );
              yield* memory
                .upsert({
                  category: "warning",
                  content: `Paper validation gate blocked live ENTER on ${poolAddress}: ${validation.reason}`,
                  poolAddress,
                })
                .pipe(Effect.catch(() => Effect.void));
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
                .pipe(Effect.catch(() => Effect.void));
              finalDecisions.push(decision);
              return { done: true };
            });
          }

          const paperGate = yield* checkPaperValidationEnter();
          if (paperGate) return paperGate;

          function logEnterTelemetry(): void {
            if (decision.action === "ENTER" && config.entryStrategyType === "auto") {
              console.info(
                `[strategy-shape] auto resolved ${entryStrategySpec} for ${poolAddress}`,
                {
                  volatilityStddev,
                  netDriftBins,
                },
              );
            }
            if (decision.action === "ENTER" && config.volatilityAdaptiveRanges) {
              logger.info(`[adaptive-range] ${poolAddress} halfWidth=${rangeHalfWidth}`, {
                volatilityStddev,
                binStep: pool.binStep,
                configuredBaseHalfWidth: config.entryRangeHalfWidthBins,
              });
            }
          }

          logEnterTelemetry();

          // Issue #170: batch wallet-reserve gate. In SOL-funded (autonomous
          // canary/live) mode the entry spends native SOL for its legs, and
          // without a batch-level budget the first 1-2 swaps of a qualifying
          // batch drain the wallet and every later entry fails
          // INSUFFICIENT_BALANCE_AFTER_SWAP — arming the execution_failures
          // safety pause and pausing the whole agent. Gate each live ENTER
          // against the per-cycle SOL budget (free SOL = wallet SOL minus gas
          // reserve, refreshed after every live mutation): entries that do not
          // fit are SKIPPED as capacity-limited (audited, never counted as
          // execution failures), and the pool re-qualifies next cycle. Pools
          // are scanned in fee-APR-ranked order in market-scan mode, so the
          // budget funds the highest-APR qualifiers first.
          function checkEnterSolReserve(): Effect.Effect<{ done: boolean } | null, never> {
            return Effect.gen(function* () {
              if (config.paperTrading || !solFundedEntryMode || decision.action !== "ENTER") {
                return null;
              }
              const entrySizeUsd = decision.positionSizeUsd;
              if (entrySizeUsd === undefined) return null;
              const neededLamports = estimateEntrySolLamports({
                positionSizeUsd: entrySizeUsd,
                solPriceUsd: entrySolPriceUsd,
                poolHasSolLeg: hasNativeSolLeg(pool),
                solFunded: true,
              });
              if (entrySolBudgetKnown && neededLamports <= entrySolBudgetLamports) {
                // Commit the estimate; the budget refreshes from chain after the
                // live mutation (or fails closed on read failure).
                entrySolBudgetLamports -= neededLamports;
                return null;
              }
              const budgetHuman = entrySolBudgetKnown
                ? (Number(entrySolBudgetLamports) / 1e9).toFixed(4)
                : "unknown";
              const neededHuman = (Number(neededLamports) / 1e9).toFixed(4);
              const reason = `[wallet-reserve] free SOL ${budgetHuman} < needed ${neededHuman} — entry skipped (capacity-limited, not an error)`;
              yield* audit
                .recordDecision({
                  timestamp: Date.now(),
                  cycleId,
                  poolAddress,
                  action: "ENTER",
                  confidence: decision.confidence,
                  reasoning: reason,
                  metrics,
                  riskResult: { approved: false, reason },
                  executed: false,
                  paperTrading: config.paperTrading,
                })
                .pipe(Effect.catch(() => Effect.void));
              yield* memory
                .upsert({
                  category: "warning",
                  content: `Entry skipped for ${poolAddress}: free SOL ${budgetHuman} < needed ${neededHuman} — wallet cannot fund the batch; skipped without retry backoff.`,
                  poolAddress,
                })
                .pipe(Effect.catch(() => Effect.void));
              // An applied queued proposal follows the failed-execution
              // contract: retained (executed=false) for retry next cycle —
              // capacity may free up (EXIT, fee accrual, top-up).
              yield* finalizeAppliedProposal(
                agentState,
                appliedQueuedProposalId,
                false,
                decision.action,
              );
              finalDecisions.push(decision);
              return { done: true };
            });
          }

          const solGate = yield* checkEnterSolReserve();
          if (solGate) return solGate;
          return { done: false };
        });
      }

      // Decision execution: EXIT cooldown, signal snapshot, ENTER prep, dispatch.
      // done=true means the decision was fully handled; skip the rest.
      function executeDecisionTail(
        decision: AgentDecision,
        riskResult: RiskResult,
        pos: PositionRecord | undefined,
        appliedQueuedProposalId: string | undefined,
      ): Effect.Effect<
        {
          done: boolean;
          executed: boolean;
          executionError: string | undefined;
          executionSkipped: boolean;
          movedLiveFunds: boolean;
          movedLiveFundsFromEnter: boolean;
        },
        Error
      > {
        return Effect.gen(function* () {
          // EXIT cooldown: persist the post-exit re-entry cooldown.
          function resolveDecisionExitCooldown(): Effect.Effect<void, Error> {
            return Effect.gen(function* () {
              const pendingCooldown = yield* resolveExitCooldown(decision, pos);
              if (pendingCooldown) {
                yield* db.setPoolCooldown(pendingCooldown).pipe(Effect.catch(() => Effect.void));
              }
            });
          }

          if (decision.action === "EXIT") yield* resolveDecisionExitCooldown();

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
            .pipe(Effect.catch(() => Effect.succeed(null)));

          // Execute
          let executed = false;
          let executionError: string | undefined = undefined;
          let executionSkipped = false;

          // F6: paper-trading validation gate — only blocks ENTER, runs only in live mode
          const enterPrep = yield* prepareEnterExecution(decision, pos, appliedQueuedProposalId);
          if (enterPrep.done)
            return {
              done: true,
              executed: false,
              executionError: undefined,
              executionSkipped: false,
              movedLiveFunds: false,
              movedLiveFundsFromEnter: false,
            };

          const paperExitShouldGoLive =
            config.paperTrading &&
            decision.action === "EXIT" &&
            pos?.positionPubKey &&
            config.paperModeExitLive;

          // True when this decision ran through the live executor and therefore
          // may have moved funds wallet<->position; only then do we re-read the
          // wallet so later pools in the same cycle don't double-count capital.
          let movedLiveFunds = false;
          // True only when the live mutation was an ENTER. A failed post-ENTER
          // re-read must block further entries this cycle (the deployed capital
          // is still in the stale balance → double-count); a failed post-EXIT
          // re-read is safe (stale balance under-counts → gates tighten).
          let movedLiveFundsFromEnter = false;
          const dispatchDerived = resolveDispatchDerived();
          const autonomousCandidateId = dispatchDerived.autonomousCandidateId;
          const entryDipOffsetBins = dispatchDerived.entryDipOffsetBins;
          const effectiveEntryHalfWidth = dispatchDerived.effectiveEntryHalfWidth;

          // Hybrid live EXIT for a paper-tracked position.
          function runPaperExitLive(): Effect.Effect<void, Error> {
            return Effect.gen(function* () {
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
                  entryStrategySpec,
                  entryRangeHalfWidth: effectiveEntryHalfWidth,
                  entryDipOffsetBins,
                  runnerSingleSidedX: entryDipOffsetBins !== 0,
                  reconcileRequestedPools,
                  memory,
                  unpricedExitWarnedPools,
                  ...runnerDispatchDeps(decision.poolAddress),
                  ...harvestDispatchDeps(),
                  ...rugDispatchDeps(),
                  ...(autonomousCandidateId !== undefined
                    ? { candidateId: autonomousCandidateId }
                    : undefined),
                  ...(autonomousExecution ? { autonomous: autonomousExecution } : undefined),
                },
                decision,
                pool,
                signalTimestamp,
                signalSnapshotId ?? undefined,
              );
              executed = liveResult.executed;
              executionError = liveResult.error;
              movedLiveFunds = true;
            });
          }

          // Paper executor (no chain interaction).
          function runPaperExecution(): Effect.Effect<void, Error> {
            return Effect.gen(function* () {
              console.info("[PAPER] Would execute", {
                action: decision.action,
                pool: poolAddress,
              });
              const paperResult = yield* executePaper(
                {
                  db,
                  trackedPositions,
                  strategy,
                  entryStrategySpec,
                  entryRangeHalfWidth: effectiveEntryHalfWidth,
                  entryDipOffsetBins,
                  ladderEnabled: config.ladderEnabled ?? false,
                  ladderTightMult: config.ladderTightMult ?? 0.6,
                  ladderWideMult: config.ladderWideMult ?? 1.6,
                  maxOpenPositions: config.maxOpenPositions,
                  maxPositionsPerPool: config.maxPositionsPerPool,
                  ...runnerDispatchDeps(decision.poolAddress),
                  ...rugDispatchDeps(),
                },
                decision,
                pool,
                signalTimestamp,
                signalSnapshotId ?? undefined,
              );
              executed = paperResult.executed;
              executionError = paperResult.error;
            });
          }

          // Live executor (chain interaction).
          function runLiveExecution(): Effect.Effect<void, Error> {
            return Effect.gen(function* () {
              const liveResult = yield* executeLive(
                {
                  adapter,
                  strategy,
                  db,
                  revenueConfigSvc,
                  trackedPositions,
                  entryPrep,
                  solPriceUsd: config.solPriceUsd,
                  entryStrategySpec,
                  entryRangeHalfWidth: effectiveEntryHalfWidth,
                  entryDipOffsetBins,
                  runnerSingleSidedX: entryDipOffsetBins !== 0,
                  reconcileRequestedPools,
                  memory,
                  unpricedExitWarnedPools,
                  ...runnerDispatchDeps(decision.poolAddress),
                  ...harvestDispatchDeps(),
                  ...rugDispatchDeps(),
                  ...(autonomousCandidateId !== undefined
                    ? { candidateId: autonomousCandidateId }
                    : undefined),
                  ...(autonomousExecution ? { autonomous: autonomousExecution } : undefined),
                },
                decision,
                pool,
                signalTimestamp,
                signalSnapshotId ?? undefined,
              );
              executed = liveResult.executed;
              executionError = liveResult.error;
              movedLiveFunds = true;
              movedLiveFundsFromEnter = decision.action === "ENTER";
            });
          }

          // Dispatch derived values: candidate id + runner-lane entry shape.
          function resolveDispatchDerived() {
            const autonomousCandidateId = autonomousExecution
              ? findEligibleAutonomousCandidateId(autonomousCandidates, poolAddress)
              : undefined;

            // Runner mode (Heart Attack): LAUNCH-lane ENTERs anchor the range
            // below the active bin (a below-market bid ladder that fills on
            // shakeouts) with a tight half-width band, clamped to the same
            // full-range cap as the normal entry. Zero offset when off or the
            // decision is not a launch entry — the conservative lane is unchanged.
            const runnerLaunchEntry = isRunnerLaunchEntry(
              config.launchRunnerModeEnabled,
              decision.positionMode,
              launchScanPools.has(poolAddress),
              isMarketRunner(poolAddress),
            );
            const entryDipOffsetBins = runnerLaunchEntry
              ? resolveRunnerDipOffset(pool.binStep, config.launchRunnerDipPct)
              : 0;
            const effectiveEntryHalfWidth = runnerLaunchEntry
              ? clampRunnerHalfWidth(
                  entryDipOffsetBins,
                  config.launchRunnerHalfWidthBins,
                  config.maxRebalanceRangeBins,
                )
              : rangeHalfWidth;
            return {
              autonomousCandidateId,
              entryDipOffsetBins,
              effectiveEntryHalfWidth,
            };
          }

          function dispatchDecisionExecution(): Effect.Effect<void, Error> {
            return Effect.gen(function* () {
              if (paperExitShouldGoLive) {
                yield* runPaperExitLive();
              } else if (config.paperTrading) {
                yield* runPaperExecution();
              } else if (config.autonomousTokenMode === "shadow" && decision.action !== "HOLD") {
                executionSkipped = true;
              } else {
                yield* runLiveExecution();
              }
            });
          }

          yield* dispatchDecisionExecution();
          return {
            done: false,
            executed,
            executionError,
            executionSkipped,
            movedLiveFunds,
            movedLiveFundsFromEnter,
          };
        });
      }

      // Post-execution wallet refresh (live mutations only).
      function refreshPostExecutionWallet(
        decision: AgentDecision,
        executed: boolean,
        movedLiveFunds: boolean,
        movedLiveFundsFromEnter: boolean,
      ): Effect.Effect<void, Error> {
        return Effect.gen(function* () {
          // After a SUCCESSFUL live ENTER/EXIT, funds moved wallet<->position but
          // later pools still hold the cycle-top wallet capture (which includes
          // the just-deployed/returned funds) alongside the already-updated
          // trackedPositions — counting that capital twice. Re-read the wallet so
          // the next pool's portfolioValue sees the post-mutation balance. The
          // post-tx cache invalidation in the adapter guarantees a fresh chain
          // read. REBALANCE moves no NET funds wallet<->position, so skip it.
          // Paper cycles never refresh from chain — gated on !paperTrading so a
          // hybrid live EXIT (PAPER_MODE_EXIT_LIVE) cannot replace the paper
          // portfolio with real chain funds mid-cycle and size later paper pools
          // against an unrelated wallet balance.
          if (
            !config.paperTrading &&
            movedLiveFunds &&
            executed &&
            (decision.action === "ENTER" || decision.action === "EXIT")
          ) {
            lastWalletBalanceUsd = yield* adapter.getWalletBalanceUsd().pipe(
              Effect.catch(() => {
                if (movedLiveFundsFromEnter) {
                  // Fail closed: the new position is already in trackedPositions
                  // while the stale balance still counts its deployed capital, so
                  // later pools would double-count and breach the allocation cap.
                  // Block further entries until the next cycle re-reads the wallet.
                  liveEntriesBlockedRestOfCycle = true;
                  logger.warn(
                    "Wallet balance refresh failed after a live entry — blocking further entries this cycle",
                    { pool: poolAddress },
                  );
                } else {
                  logger.warn(
                    "Wallet re-read after live execution failed; keeping cycle-top balance",
                    { pool: poolAddress },
                  );
                }
                return Effect.succeed(lastWalletBalanceUsd);
              }),
            );
          }

          // Issue #170: refresh the batch SOL budget from chain after ANY live
          // ENTER/EXIT attempt — executed entries consumed SOL (committed below),
          // a failed ENTER may still have landed a partial prep swap, and an
          // EXIT may have returned SOL. The adapter invalidates balance caches
          // after mutating txs, so this is one fresh read when funds moved and a
          // cache hit otherwise. A failed read fails closed: budget 0 blocks
          // further SOL-funded entries this cycle rather than over-committing.
          if (!config.paperTrading && solFundedEntryMode && movedLiveFunds) {
            entrySolBudgetLamports = yield* adapter.getNativeSolBalance().pipe(
              Effect.map((lamports) => freeEntrySolLamports(lamports)),
              Effect.catch(() => Effect.succeed(0n)),
            );
            entrySolBudgetKnown = true;
          }
        });
      }

      // Post-execution candidate + audit record.
      function recordPostExecutionAudit(
        decision: AgentDecision,
        executed: boolean,
        executionError: string | undefined,
        executionSkipped: boolean,
      ): Effect.Effect<void, Error> {
        return Effect.gen(function* () {
          function confirmEnteredCandidate(): Effect.Effect<void, Error> {
            return Effect.gen(function* () {
              if (!(executed && decision.action === "ENTER" && autonomousExecution)) return;
              const candidate = [...autonomousCandidates.values()].find(
                (item) => item.poolAddress === poolAddress && item.state === "eligible",
              );
              if (!candidate) return;
              const enteredCandidate = transitionCandidate(
                candidate,
                { kind: "entry_confirmed", occurredAt: Date.now() },
                {
                  minHealthyScans: config.candidateMinHealthyScans,
                  minObservationMs: config.candidateMinObservationMs,
                },
              );
              autonomousCandidates.set(enteredCandidate.id, enteredCandidate);
              yield* db.saveTokenCandidate(enteredCandidate).pipe(Effect.catch(() => Effect.void));
            });
          }

          yield* confirmEnteredCandidate();
          // Token-level execution-failure breaker (Robinhood rule 12): arm
          // `token_block:<mint>` for both legs after a genuine live EXIT failure.
          function armTokenFailureBlock(): Effect.Effect<void, Error> {
            return Effect.gen(function* () {
              if (decision.action !== "EXIT" || config.paperTrading) return;
              const expiresAt = Date.now() + (config.tokenFailureBlockMs ?? 3_600_000);
              for (const mint of [pool.tokenX, pool.tokenY]) {
                yield* db.setMetadata(`token_block:${mint}`, String(expiresAt)).pipe(
                  Effect.catch((err) =>
                    Effect.sync(() =>
                      logger.warn("Failed to record token execution-failure block", {
                        pool: poolAddress,
                        mint,
                        error: String(err),
                      }),
                    ),
                  ),
                );
              }
            });
          }

          if (decision.action !== "HOLD" && !executionSkipped) {
            if (executed) {
              cycle.poolsExecuted++;
              recordExecutionOutcome(true);
              if (decision.action === "ENTER") sessionEntriesExecuted++;
              else if (decision.action === "EXIT") sessionExitsExecuted++;
            } else if (
              // Issue #170: in SOL-funded mode, an ENTER failing on a funding
              // condition (insufficient token balance after swap / insufficient
              // SOL / insufficient USDC) is a wallet-capacity outcome, not an
              // execution error — the batch wallet-reserve gate prevents the
              // over-commitment that used to cause it, and what remains is a
              // race or a small-wallet reality. It must NOT arm the
              // execution_failures safety pause (which paused the whole agent
              // for hours on a $54 wallet) and is not counted as a pool failure.
              // The entry-failure backoff still arms below, so the pool is not
              // retried for 30min-6h. Scoped to solFundedEntryMode: in plain
              // live (USDC-funded) mode the batch gate does not run, so funding
              // failures there keep their pause-breaker teeth.
              !isCapacityExecutionFailure(decision.action, solFundedEntryMode, executionError)
            ) {
              cycle.poolsFailed++;
              recordExecutionOutcome(false);
              // Token-level execution-failure breaker (Robinhood rule 12): a
              // genuine live EXIT failure means the route OUT of this pool's
              // legs is broken — block new deployment into ANY pool holding
              // either leg for the configured window (see findBlockedToken on
              // the ENTER gates). Stores the block EXPIRY so the failure window
              // and the rug window can differ per key. Paper skips and
              // risk/capacity outcomes never reach this branch; only the same
              // classification that arms the execution_failures pause. A
              // metadata write failure fails open (warn) — never breaks a cycle.
              yield* armTokenFailureBlock();
            }
          }
        });
      }

      // Post-execution bookkeeping: EXIT settle, backoff, candidates.
      function updatePostExecutionBookkeeping(
        decision: AgentDecision,
        executed: boolean,
        executionError: string | undefined,
        pos: PositionRecord | undefined,
        appliedQueuedProposalId: string | undefined,
        riskResult: RiskResult,
      ): Effect.Effect<void, Error> {
        return Effect.gen(function* () {
          function coolExitCandidate(): Effect.Effect<void, Error> {
            return Effect.gen(function* () {
              if (!(executed && decision.action === "EXIT")) return;
              const candidate = [...autonomousCandidates.values()].find(
                (item) => item.poolAddress === poolAddress && item.state === "entered",
              );
              if (candidate) {
                const coolingCandidate = transitionCandidate(
                  candidate,
                  {
                    kind: "cooldown_started",
                    occurredAt: Date.now(),
                    cooldownUntil: Date.now() + config.oorCooldownMs,
                  },
                  {
                    minHealthyScans: config.candidateMinHealthyScans,
                    minObservationMs: config.candidateMinObservationMs,
                  },
                );
                autonomousCandidates.set(coolingCandidate.id, coolingCandidate);
                yield* db
                  .saveTokenCandidate(coolingCandidate)
                  .pipe(Effect.catch(() => Effect.void));
              }
              // Follow-up 3655404926: record every executed EXIT (deterministic or
              // agent-adjusted) so the redeploy pass cannot re-enter this pool the
              // same cycle once the freed slot re-passes the position-count checks.
              executedExitPools.add(poolAddress);
              yield* alertSvc.sendAlert({
                type: "exit_executed",
                severity: "critical",
                message: `EXIT executed on ${pool.tokenXSymbol}/${pool.tokenYSymbol}: ${decision.reasoning}`,
                poolAddress,
                ...(pos !== undefined ? { positionId: pos.positionId } : undefined),
                data: { reasoning: decision.reasoning, paperTrading: config.paperTrading },
              });
            });
          }

          yield* coolExitCandidate();
          function syncEntryPostExecution(): Effect.Effect<void, Error> {
            return Effect.gen(function* () {
              if (decision.action === "ENTER" && isInsufficientTokenBalanceError(executionError)) {
                const backoff = nextEntryFailureBackoff(entryFailureBackoff.get(poolAddress));
                entryFailureBackoff.set(poolAddress, backoff);
                logger.warn("Entry suppressed after insufficient token balance", {
                  pool: poolAddress,
                  retryAfterMs: backoff.nextAttemptAt - Date.now(),
                  failures: backoff.failures,
                });
                return;
              }
              if (!(decision.action === "ENTER" && executed)) return;
              entryFailureBackoff.delete(poolAddress);
              // Follow-up 3655404934: the candidate captured this pool's normal entry
              // size BEFORE the overlay; `full` mode can enlarge and execute it. Sync
              // the FINAL executed size (post-overlay, post-risk-cap) back onto the
              // candidate so the redeploy widened-size guard compares against the
              // position really opened, not a stale pre-overlay figure.
              const executedSizeUsd = decision.positionSizeUsd;
              if (executedSizeUsd === undefined) return;
              const redeployCandidate = idleRedeployCandidates.find(
                (c) => c.poolAddress === poolAddress,
              );
              if (redeployCandidate) redeployCandidate.normalEntrySizeUsd = executedSizeUsd;
            });
          }

          yield* syncEntryPostExecution();

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
            .pipe(Effect.catch(() => Effect.void));

          // Threshold evolution: increment counter on EXIT, try evolve at interval
          if (decision.action === "EXIT" && executed) {
            yield* incrementEvolutionCount.pipe(Effect.catch(() => Effect.void));
            yield* tryEvolveThresholds.pipe(Effect.catch(() => Effect.void));
          }

          if (shouldSendPostExecutionCheckin(executed, decision.action)) {
            // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
            const trigger = decision.action.toLowerCase() as AgentRuntimeCheckin["trigger"];
            yield* maybeSendAgentCheckin(trigger).pipe(Effect.catch(() => Effect.void));
          }
        });
      }

      // Decision pre-risk: agent overlay (veto/queue/sync/apply) + supervised + copy-signal.
      function runDecisionPreRisk(
        decision: AgentDecision,
        pos: PositionRecord | undefined,
        hasOpenPosition: boolean,
      ): Effect.Effect<
        {
          decision: AgentDecision;
          appliedQueuedProposalId: string | undefined;
          appliedAgentProposal: boolean;
          proposalValidated: boolean;
          preApplyDecision: AgentDecision | undefined;
        },
        Error
      > {
        return Effect.gen(function* () {
          let agentProposal: AgentProposal | null = null;
          let proposalSource: "queue" | "sync" | undefined;
          let appliedQueuedProposalId: string | undefined;
          let appliedAgentProposal = false;
          let proposalValidated = false;
          let preApplyDecision: AgentDecision | undefined;
          let syncFetchFailed = false;
          if (config.agentiveMode) {
            const proposalMode = config.agentProposalMode;
            const now = Date.now();

            if (proposalMode === "veto") {
              decision = yield* fetchVetoOverride(decision, pos, hasOpenPosition);
            } else {
              // suggest | supervised | full
              // HTTP queue consumption is independent of sync advisor backoff /
              // circuit-breaker state so AgentNoOp and failed local runtimes cannot
              // suppress already-enqueued /propose proposals.
              const poolCircuitBreaker = getPoolCircuitBreaker(poolAddress);
              const resolvedProposal = yield* resolveDecisionProposal(
                decision,
                proposalMode,
                poolCircuitBreaker,
                pos,
                hasOpenPosition,
                now,
              );
              agentProposal = resolvedProposal.agentProposal;
              proposalSource = resolvedProposal.proposalSource;
              syncFetchFailed = resolvedProposal.syncFetchFailed;

              if (agentProposal) {
                const applied = yield* applyDecisionProposal(
                  decision,
                  agentProposal,
                  proposalSource,
                  now,
                  proposalMode,
                  poolCircuitBreaker,
                );
                decision = applied.decision;
                preApplyDecision = applied.preApplyDecision;
                proposalValidated = applied.proposalValidated;
                appliedAgentProposal = applied.appliedAgentProposal;
                appliedQueuedProposalId = applied.appliedQueuedProposalId;
              } else if (syncFetchFailed) {
                yield* recordProposalFetchFailure(now, poolCircuitBreaker);
              }
            }
          }

          // Supervised mode gates execution on human approval: without an applied
          // approved proposal, ENTER/REBALANCE decisions are held until one is
          // available. Deterministic EXITs are exempt — they are safety actions
          // the engine keeps final authority over.
          decision = yield* checkSupervisedHold(decision, appliedQueuedProposalId);

          decision = yield* applyCopySignalBoostStep(decision);
          return {
            decision,
            appliedQueuedProposalId,
            appliedAgentProposal,
            proposalValidated,
            preApplyDecision,
          };
        });
      }

      // Daily drawdown: rollover reset + safety-pause arm/resolve.
      function evaluateDailyDrawdown(): Effect.Effect<{ dailyDrawdownPct: number }, Error> {
        return Effect.gen(function* () {
          const dayRolledOver = dailyBaselineDay !== dayKey;
          if (dayRolledOver) {
            dailyBaselineDay = dayKey;
            dailyBaselineEquityUsd = portfolioValueUsd - realizedTodayUsd;
            yield* persistDailyEquityBaseline(db, dailyBaselineScope, {
              day: dailyBaselineDay,
              equityUsd: dailyBaselineEquityUsd,
            });
          }
          dailyDrawdownPct = computeDailyDrawdownPct(dailyBaselineEquityUsd, portfolioValueUsd);
          // Issue #148: a latched daily_drawdown pause must not outlive the
          // condition that raised it. The daily baseline re-seeds on rollover but
          // the pause itself only cleared via `prism resume` — auto-resolve it
          // mode-aware so a fresh-day baseline (or a recovered drawdown) does not
          // leave the agent silently paused. The trigger block below re-arms it
          // when the recomputed drawdown still breaches the threshold.
          function resolveDailyDrawdownPause(dayRolledOver: boolean): Effect.Effect<void, Error> {
            return Effect.gen(function* () {
              if (
                autonomousExecution &&
                activeSafetyPause !== null &&
                activeSafetyPause.resolvedAt === null &&
                activeSafetyPause.reason === "daily_drawdown" &&
                shouldAutoResolveDailyDrawdownPause({
                  mode: autonomousExecution.mode,
                  dailyDrawdownPct,
                  maxDailyDrawdownPct: config.maxDailyDrawdownPct,
                  dayRolledOver,
                })
              ) {
                activeSafetyPause = { ...activeSafetyPause, resolvedAt: Date.now() };
                yield* db.saveSafetyPause(activeSafetyPause).pipe(Effect.catch(() => Effect.void));
              }
            });
          }

          function armDailyDrawdownPause(): Effect.Effect<void, Error> {
            return Effect.gen(function* () {
              if (
                !(
                  autonomousExecution &&
                  activeSafetyPause?.resolvedAt !== null &&
                  config.maxDailyDrawdownPct > 0 &&
                  dailyDrawdownPct >= config.maxDailyDrawdownPct
                )
              ) {
                return;
              }
              activeSafetyPause = {
                walletAddress: autonomousExecution.walletAddress,
                agentInstanceId: autonomousExecution.agentInstanceId,
                reason: "daily_drawdown",
                triggeredAt: Date.now(),
                resolvedAt: null,
              };
              yield* db.saveSafetyPause(activeSafetyPause).pipe(Effect.catch(() => Effect.void));
            });
          }

          yield* resolveDailyDrawdownPause(dayRolledOver);
          yield* armDailyDrawdownPause();
          return { dailyDrawdownPct };
        });
      }

      // Idle-redeploy site: capture a vetted-but-capped pool + dispatch the pass.
      function runIdleRedeploySite(): Effect.Effect<void, Error> {
        return Effect.gen(function* () {
          // Idle-redeploy capture: the per-pool position cap skipped the ENTER
          // slot entirely. A pool that still passes the candidate conditions +
          // score keeps the pass's ranking honest; dispatch is structurally
          // impossible this cycle (the cap did not move — allocation gate and risk
          // gate 3a re-run and re-reject verbatim), so no skipped gate can bite.
          if (
            !isRedeployCaptureSite(
              config.idleRedeployEnabled,
              poolExitFired,
              poolPositions.length,
              config.maxPositionsPerPool,
              unresolvedPoolAddresses.has(poolAddress),
              approvedPoolAddresses.includes(poolAddress) || marketScanPools.has(poolAddress),
            )
          ) {
            return;
          }
          // isLaunchPool is scoped to the ENTER branch above — recompute the
          // launch-lane membership for this capture site.
          const redeployPoolIsLaunch = isRedeployLaunchPool(
            config.launchScanEnabled,
            config.launchExecutionEnabled,
            launchScanPools.has(poolAddress),
          );
          const redeployCandidate = evaluateIdleRedeployCandidate();
          if (redeployCandidate && !redeployPoolIsLaunch) {
            idleRedeployCandidates.push(redeployCandidate);
          }
        });
      }

      // Pool entry gates: stats, safety screen, metrics, hot-lane, quality.
      // halt is non-null when evaluation must stop for this pool.
      function runPoolEntryGates() {
        return Effect.gen(function* () {
          const stats = yield* resolvePoolStats(poolAddress);
          const {
            pool,
            binArray,
            datapiStats,
            poolFeeAprPct,
            runnerAprOutlier,
            runnerConsecutiveCount,
          } = stats;
          const isMarketRunner = (addr: string): boolean =>
            !runnerAprOutlier &&
            isMarketRunnerPool({
              enabled: config.marketScanRunnerEnabled === true,
              marketScanPools,
              poolAddress: addr,
              statsSource: pool.statsSource,
              feeAprPct: poolFeeAprPct,
              runnerMinFeeApr: config.marketScanRunnerMinFeeApr,
              netDriftBins,
              runnerMinDriftBins: config.marketScanRunnerMinDriftBins,
            }) &&
            runnerConsecutiveCount >= (config.marketScanRunnerConfirmCycles ?? 2);

          const snap = yield* capturePoolSnapshot(poolAddress, pool, binArray);
          const { previousSnapshot, w15Signals } = snap;
          // Safety screening (fail-closed on positive signals, fail-open on
          // transport errors):
          // 1. Meteora Data API flags: is_blacklisted, freeze_authority_disabled.
          // 2. On-chain mint accounts: mint authority doubles as the documented
          //    deployer fallback for the deployer blacklist.
          // 3. Token + deployer blacklist (deterministic local gate): a loaded
          //    blacklist hit rejects the pool BEFORE the network-dependent
          //    token-risk overlay consult; only unexpected transport/IO errors
          //    are swallowed.
          // 4. Freeze authority screening: a freeze-enabled untrusted leg is
          //    adjudicated by the lazy Jupiter/Data-API token-risk overlay.
          const safetyRejection = yield* screenPoolSafety(poolAddress, cycleId, pool, datapiStats);
          if (safetyRejection) return { halt: safetyRejection };

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

          if (
            !metrics.volumeAuthenticityKnown ||
            !metrics.binUtilizationKnown ||
            !metrics.feeIlRatioKnown
          ) {
            logger.warn("Metric data unavailable — skipping the affected gates for this pool", {
              pool: poolAddress,
              volumeAuthenticityKnown: metrics.volumeAuthenticityKnown,
              binUtilizationKnown: metrics.binUtilizationKnown,
              feeIlRatioKnown: metrics.feeIlRatioKnown,
            });
          }

          // ── Hot-window capture lane ──────────────────────────────────────────
          // A config-gated high-frequency lane that ONLY enters a pool currently
          // printing fees (measured 1h Data-API fee ratio) within a depth band so
          // a tiny entry captures a meaningful share, holds at most a short
          // timebox, and exits — bounded by a daily trip budget and a daily loss
          // halt. It runs on pools that already cleared the safety screen above
          // (rug/mint-renounce/age/holder gates), reuses the full risk tail for
          // execution, and is OFF unless HOT_WINDOW_ENABLED=true. It fully owns
          // any pool it holds a hot position on or is about to enter.
          const hotLane = yield* runHotWindowLane(poolAddress, pool, datapiStats);
          if (hotLane) return { halt: hotLane };

          const quality = yield* gatePoolQuality(poolAddress, pool, metrics);
          if (!quality) {
            const halt: AgentDecision[] = [];
            return { halt };
          }
          return {
            halt: null,
            metrics,
            quality,
            pool,
            binArray,
            datapiStats,
            poolFeeAprPct,
            runnerAprOutlier,
            isMarketRunner,
            w15Signals,
          };
        });
      }

      // Phase 1: per-position EXIT evaluation.
      function runPhase1ExitEvaluation(): Effect.Effect<void, Error> {
        return Effect.gen(function* () {
          for (const pos of poolPositions) {
            const ilDominance = computeIlDominance(pos);
            const faLifecycle = evaluateFallenAngelExit(pos);
            const launchFees = measureLaunchFees1h(pos);
            const launchLifecycle = evaluateLaunchExit(pos, launchFees);
            const tpTargetLifecycle = evaluateTpTargetExit(pos);
            const decision = yield* decidePositionExit(
              pos,
              faLifecycle,
              launchLifecycle,
              tpTargetLifecycle,
              ilDominance,
            );
            if (decision) {
              rawDecisions.push(decision);
              if (decision.action === "EXIT") poolExitFired = true;
            }
          }
        });
      }

      // Phase 2: runner net-bleed/vol evaluation per undecided position.
      function runPhase2Evaluation(): Effect.Effect<void, Error> {
        return Effect.gen(function* () {
          for (const pos of poolPositions) {
            if (decidedPositionIds.has(pos.positionId)) continue;
            const decision = yield* decidePhase2Position(pos);
            if (decision) {
              rawDecisions.push(decision);
              if (decision.action === "EXIT") poolExitFired = true;
            }
          }
        });
      }

      // Default HOLD: no decision produced anything — hold (or stop when gated).
      function pushDefaultHold(
        enterGateRejected: boolean,
      ): Effect.Effect<{ empty: boolean }, never> {
        return Effect.gen(function* () {
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
            return { empty: true };
          }
          return { empty: false };
        });
      }

      yield* processDecisionTail(
        rawDecisions,
        poolAddress,
        trackedPositions,
        finalDecisions,
        proposalBackoff,
        getPoolCircuitBreaker,
        runDecisionPreRisk,
        evaluateDecisionRisk,
        executeDecisionTail,
        refreshPostExecutionWallet,
        recordPostExecutionAudit,
        updatePostExecutionBookkeeping,
      );
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

      // Non-null claimFees outcome shared by the per-position claim helpers.
      type ClaimFeesResult = Exclude<Effect.Success<ReturnType<typeof adapter.claimFees>>, null>;
      // LM farm rewards ride the same periodic cadence as swap-fee claims.
      // Extracted so the per-position claim flow stays readable.
      function settlePositionRewards(pos: PositionRecord): Effect.Effect<void, never> {
        return Effect.gen(function* () {
          const poolAddress = pos.poolAddress;
          if (!pos.positionPubKey || !config.farmRewardsEnabled) return;
          const rewardResult = yield* adapter
            .claimRewards(poolAddress, pos.positionPubKey)
            .pipe(Effect.catch(() => Effect.succeed(null)));
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
            yield* persist(`savePosition ${pos.positionId}`, db.savePosition(pos));
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
              .pipe(Effect.catch(() => Effect.void));
            if (rewardSummary.unpricedCount > 0) {
              yield* memory
                .upsert({
                  category: "warning",
                  content: `Claimed ${rewardSummary.unpricedCount} farm reward(s) for ${poolAddress} without USD pricing — raw amounts recorded in position_events.`,
                  poolAddress,
                })
                .pipe(Effect.catch(() => Effect.void));
            }
          }
        });
      }

      // G4 economic harvest gate (rule: never spend $0.80 to realize $1.00).
      // Returns false when the on-chain claim must be skipped this cycle.
      function checkHarvestGate(pos: PositionRecord): Effect.Effect<boolean, never> {
        const poolAddress = pos.poolAddress;
        const positionPubKey = pos.positionPubKey;
        if (!positionPubKey) return Effect.succeed(true);
        return Effect.gen(function* () {
          const gate = adapter.getClaimableFeesUsd
            ? yield* adapter.getClaimableFeesUsd(poolAddress, positionPubKey).pipe(
                Effect.map((netUsd) => evaluateHarvestGate(netUsd, config)),
                Effect.catch(() =>
                  Effect.succeed({
                    approved: true,
                    reason: "[harvest-gate] pending read failed — fail open (claim anyway)",
                  }),
                ),
              )
            : null;
          if (gate && !gate.approved) {
            console.warn(
              `[harvest-gate] claim skipped on ${poolAddress} (${pos.positionId}): ${gate.reason}`,
            );
            return false;
          }
          return true;
        });
      }

      // One position's full claim cycle: rewards, harvest gate, swap-fee
      // claim, optional accumulation destination, optional auto-compound.
      function claimPositionFees(pos: PositionRecord): Effect.Effect<void, never> {
        // Fire-and-forget platform-fee report; a delivery failure never blocks the cycle.
        function reportCollectedFees(
          poolAddress: string,
          result: ClaimFeesResult,
        ): Effect.Effect<void, never> {
          if (!hasPlatformFeeSplit(result)) return Effect.void;
          return Effect.forkChild(
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
                Effect.catchCause((cause) =>
                  Effect.sync(() =>
                    console.error("reportFeeCollection failed", { cause: String(cause) }),
                  ),
                ),
              ),
          ).pipe(Effect.asVoid);
        }

        function convertClaimedFees(
          poolAddress: string,
          result: ClaimFeesResult,
          feeDestination: "accumulate-quote" | "accumulate-sol",
        ): Effect.Effect<void, never> {
          return Effect.gen(function* () {
            const liveConversion = adapter.convertClaimedFees
              ? adapter
                  .convertClaimedFees(poolAddress, feeDestination, result.netFeeX, result.netFeeY)
                  .pipe(Effect.catch(() => Effect.succeed(null)))
              : Effect.succeed(null);
            const conversion = config.paperTrading
              ? Effect.succeed({
                  destination: feeDestination,
                  outputAtomic: 0n,
                  outputUsd: null,
                  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
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
                .pipe(Effect.catch(() => Effect.void));
            }
          });
        }

        // F3: fee compounding — if AUTO_COMPOUND_FEES is on and the net
        // fees cleared the cost threshold, redeposit them into the same range.
        function compoundPositionFees(
          poolAddress: string,
          netFeesUsd: number,
          netFeeX: number,
          netFeeY: number,
        ): Effect.Effect<void, never> {
          return Effect.gen(function* () {
            const positionPubKey = pos.positionPubKey;
            if (!positionPubKey) return;
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
                  amountXAtomic: BigInt(Math.max(Math.trunc(netFeeX), 0)),
                  amountYAtomic: BigInt(Math.max(Math.trunc(netFeeY), 0)),
                };
                const compoundResult =
                  topUp.amountXAtomic === 0n && topUp.amountYAtomic === 0n
                    ? null
                    : yield* adapter
                        .rebalancePosition(
                          poolAddress,
                          positionPubKey,
                          pos.lowerBinId,
                          pos.upperBinId,
                          topUp,
                        )
                        .pipe(
                          Effect.tap((r) =>
                            Effect.sync(() =>
                              console.info("Compound rebalance succeeded", {
                                pool: poolAddress,
                                position: r.positionPubKey,
                              }),
                            ),
                          ),
                          Effect.catch((err) => {
                            console.warn("Compound rebalance failed", {
                              pool: poolAddress,
                              err: err instanceof Error ? err.message : String(err),
                            });
                            return Effect.succeed(null);
                          }),
                        );
                if (compoundResult) {
                  if (compoundResult.positionPubKey !== pos.positionId) {
                    // Defensive re-key (same contract as the atomic rebalance
                    // path): the identity and its row move with the pubkey.
                    trackedPositions.delete(pos.positionId);
                    yield* persist(
                      `deletePosition ${pos.positionId}`,
                      db.deletePosition(pos.positionId),
                    );
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
                  yield* persist(`savePosition ${pos.positionId}`, db.savePosition(pos));
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
                    .pipe(Effect.catch(() => Effect.void));
                  yield* memory
                    .upsert({
                      category: "pattern",
                      content: `Auto-compounded $${netFeesUsd.toFixed(2)} fees into ${poolAddress} (savings $${compoundGate.savingsUsd.toFixed(2)})`,
                      poolAddress,
                    })
                    .pipe(Effect.catch(() => Effect.void));
                }
              }
            }
          });
        }

        return Effect.gen(function* () {
          const poolAddress = pos.poolAddress;
          if (
            pos.positionPubKey &&
            isClaimIntervalElapsed(pos.lastFeeClaimAt, Date.now(), config.feeClaimIntervalMs)
          ) {
            yield* settlePositionRewards(pos);
            const proceed = yield* checkHarvestGate(pos);
            if (!proceed) return;
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
                  Effect.sync(() =>
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
                ),
                Effect.catch(() => Effect.succeed(null)),
              );
            if (!hasClaimableFees(result)) {
              return;
            }
            // Mint-based net-fee USD from the adapter; null → 0 fails the
            // compound gate closed (see convertClaimFeesToUsd deprecation).
            const netFeesUsd = result.netFeesUsd ?? 0;
            yield* db
              .saveFeeClaim(buildFeeClaimRow(poolAddress, pos.positionPubKey, result))
              .pipe(Effect.catch(() => Effect.void));
            pos.lastFeeClaimAt = Date.now();
            pos.cumulativeFeesClaimedUsd += netFeesUsd;
            yield* persist(`savePosition ${pos.positionId}`, db.savePosition(pos));

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
              .pipe(Effect.catch(() => Effect.void));

            yield* reportCollectedFees(poolAddress, result);
            yield* alertSvc.recordFeeClaim(poolAddress, netFeesUsd);
            const feeDestination = config.feeDestination ?? "compound";
            if (feeDestination !== "compound") {
              yield* convertClaimedFees(poolAddress, result, feeDestination);
              return;
            }
            yield* compoundPositionFees(poolAddress, netFeesUsd, result.netFeeX, result.netFeeY);
          }
        });
      }

      for (const pos of trackedPositions.values()) {
        yield* claimPositionFees(pos);
      }
    });

  // ─── Run initial cycle and schedule ────────────────────────────────────────

  yield* memory.initialize().pipe(Effect.catch(() => Effect.void));

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
    const reconcileResult = yield* reconcilePositions(adapter, db, memory, trackedPositions, [
      ...new Set([
        ...approvedPoolAddresses,
        ...marketScanPools,
        ...autonomousCandidatePoolAddresses,
      ]),
    ]);
    reconcileRequestedPools.clear();
    refreshPoolsToScan(reconcileResult);
    yield* claimAllFees();
    yield* checkForAutoUpdate(config, db);
    yield* runScanCycle();
  }).pipe(
    Effect.catch((err) =>
      Effect.sync(() => {
        console.error("Cycle error:", err);
      }),
    ),
  );

  const schedulerFiber = yield* Effect.forkChild(
    Effect.forever(Effect.sleep(config.scanIntervalMs).pipe(Effect.andThen(runScheduledCycle))),
  );

  const gracefulShutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`Received ${signal} — shutting down`);
    // Report a final "stopped" heartbeat so Telegram /status does not keep serving
    // a stale "running" until the 30-minute KV TTL expires. Awaited inline (with a
    // hard timeout) BEFORE process.exit so the fetch is not killed mid-flight; the
    // per-cycle "running" report stays fire-and-forget.
    const pnl = computeCycleUnrealizedPnl(trackedPositions);
    Effect.runFork(
      Fiber.interrupt(schedulerFiber).pipe(
        Effect.andThen(agent.disconnect()),
        Effect.andThen(
          postEngineStatus("stopped", trackedPositions.size, pnl).pipe(
            Effect.timeout("4 seconds"),
            Effect.catch(() => Effect.void),
          ),
        ),
        Effect.ensuring(Effect.sync(() => process.exit(0))),
      ),
    );
  };

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

  return yield* Fiber.join(schedulerFiber);
});
