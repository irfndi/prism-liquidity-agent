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
} from "./risk-service.js";
import {
  computeBinVolatilityStddev,
  isHighVolatility,
  recommendBinRangeForVolatility,
  dipOffsetBinsForPct,
  recommendStrategyShape,
  resolveRangeHalfWidth,
  estimateRecoveryProbability,
  shouldHoldForRecovery,
  evolveThresholds,
  computeSignalWeights,
  weightedEntryScore,
  entryMomentumBoost,
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
import { ScreenerLive } from "./screener-service.js";
import { DbLive, PRICE_SCALE_MIGRATION_KEY } from "./db-service.js";
import { RevenueConfigServiceLive } from "./revenue-config-service.js";
import { AgentStateMutable, initialSnapshot, type PositionSnapshot } from "./state-service.js";
import { McpServerLive } from "./mcp-server.js";
import { HttpStatusServerLive } from "./http-status-server.js";
import { EntryPrepLive } from "./entry-prep-service.js";
import { shouldDiscoverPools } from "./pool-policy.js";
import {
  DEFAULT_RUNNER_MIN_FEE_APR,
  consecutiveAboveFloorObservations,
  isMarketRunnerPool,
  lowestAprHeldPosition,
  shouldRotate,
} from "./market-runner.js";
import { runnerNetAprPct } from "./fee-capture.js";
import { advanceScreenedCandidates } from "./candidate-discovery.js";
import { gateAndRankMarketPools, type MarketPoolRank } from "./market-gate.js";
import { gateAndRankLaunchPools, summarizeLaunchRejections } from "./launch-gate.js";
import type { WashEvidence } from "./wash-forensics.js";
import { transitionCandidate } from "./candidate-policy.js";
import { getPrismUserConfigDir } from "./paths.js";

import { checkForAutoUpdate } from "./update-check.js";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { PositionRecord } from "./db-service.js";
import { applyCompoundToCostBasis, computeHodlValueUsd, computeRealizedPnlUsd } from "./pnl.js";
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
  type DbApi,
  type MemoryApi,
  type RiskResult,
  type ScreenedPool,
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
import { detectDepegAndLiquidityDrain } from "./depeg-liquidity-detector.js";
import { consultTokenRisks, type TokenRiskSignal } from "./token-risk-service.js";
import { CopySignalLive, applyCopySignalBoost } from "./copy-trading-signals.js";
import { evaluateFallenAngelDiscovery } from "./fallen-angel-discovery.js";
import { identifyAssetMint } from "./fallen-angel-service.js";
import { buildTpLadder, evaluateTpLadder, parseTpLadder, serializeTpLadder } from "./tp-ladder.js";
import { getGeckoPoolOhlcv, type GeckoOhlcvSignals } from "./gecko-ohlcv-service.js";
import { getRugCheckReport, type RugCheckReport } from "./rugcheck-service.js";
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
  EntryStrategyShape,
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
      Object.prototype.toString.call((parsed as { apiKey?: unknown }).apiKey) === "[object String]"
      ? (parsed as { apiKey: string }).apiKey
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

export function estimatePositionValue(pos: PositionRecord, pool: PoolState): number {
  const entryPriceUsd = pos.entryPriceUsd;
  if (
    entryPriceUsd != null &&
    entryPriceUsd > 0 &&
    pos.entryAmountXUsd != null &&
    pos.entryAmountYUsd != null &&
    Number.isFinite(pos.entryAmountXUsd) &&
    Number.isFinite(pos.entryAmountYUsd) &&
    Number.isFinite(pool.currentPrice) &&
    pool.currentPrice > 0
  ) {
    const hodl = computeHodlValueUsd(
      pos.entryAmountXUsd,
      pos.entryAmountYUsd,
      entryPriceUsd,
      pool.currentPrice,
    );
    if (hodl !== null && Number.isFinite(hodl) && hodl > 0) return hodl;
  }
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
        if (
          source === "chain" &&
          (tracked.lowerBinId !== onChainPos.lowerBinId ||
            tracked.upperBinId !== onChainPos.upperBinId)
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
          yield* persist(`savePosition ${updated.positionId}`, db.savePosition(updated));
          yield* memory
            .upsert({
              category: "warning",
              content: `Position ${onChainPos.positionPubKey} on ${onChainPos.poolAddress} range synced to on-chain state (${onChainPos.lowerBinId}-${onChainPos.upperBinId}).`,
              poolAddress: onChainPos.poolAddress,
            })
            .pipe(Effect.catch(() => Effect.void));
        }
        continue;
      }
      if (watchedPoolSet.has(onChainPos.poolAddress)) {
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
          continue;
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
          yield* persist(`savePosition ${pos.positionId}`, db.savePosition(pos));
          yield* memory
            .upsert({
              category: "warning",
              content: `External position ${onChainPos.positionPubKey} detected in ${onChainPos.poolAddress} and added to tracking.`,
              poolAddress: onChainPos.poolAddress,
            })
            .pipe(Effect.catch(() => Effect.void));
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
  | GeckoTerminalService
  | DexScreenerService
  | PythPriceService
  | AlertService
  | CopySignalService;

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

  const merged12 = Layer.merge(merged11e, agentLayer);
  const merged13 = Layer.merge(merged12, agentStateLayer);
  const merged14 = Layer.merge(merged13, mcpLayer);
  const merged15 = Layer.merge(merged14, httpLayer);

  const alertDeps = Layer.merge(dbLayer, configLayer);
  const alertLayer = Layer.provide(AlertLive, alertDeps);
  const merged16 = Layer.merge(merged15, alertLayer);
  const copySignalLayer = Layer.provide(CopySignalLive, configLayer);
  const merged17 = Layer.merge(merged16, copySignalLayer);

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

export function executePaper(
  deps: {
    db: DbApi;
    trackedPositions: Map<string, PositionRecord>;
    strategy: StrategyApi;
    entryStrategyShape: EntryStrategyShape;
    entryRangeHalfWidth?: number;
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
    const {
      db,
      trackedPositions,
      strategy,
      entryStrategyShape,
      entryRangeHalfWidth,
      entryDipOffsetBins,
    } = deps;
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
        entryDipOffsetBins,
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
        // Paper/live parity for runner entries: live deposits the FULL size
        // in X (single-sided) — the paper legs must model the same exposure
        // or PnL/HODL validation drifts from real behavior.
        entryAmountXUsd:
          (entryDipOffsetBins ?? 0) !== 0 ? decision.positionSizeUsd : decision.positionSizeUsd / 2,
        entryAmountYUsd: (entryDipOffsetBins ?? 0) !== 0 ? 0 : decision.positionSizeUsd / 2,
        cumulativeFeesClaimedUsd: 0,
        cumulativeRewardsClaimedUsd: 0,
        closedAt: null,
        realizedPnlUsd: null,
        positionMode: decision.positionMode ?? null,
        tpLadderJson: decision.tpLadderJson ?? null,
        invalidationStopPrice: decision.invalidationStopPrice ?? null,
        launchRunner: (entryDipOffsetBins ?? 0) !== 0 ? true : null,
        launchRunnerSteps: (entryDipOffsetBins ?? 0) !== 0 ? 0 : null,
        launchRunnerAnchorPrice: (entryDipOffsetBins ?? 0) !== 0 ? pool.currentPrice : null,
      };
      trackedPositions.set(pos.positionId, pos);
      yield* persist(`savePosition ${pos.positionId}`, db.savePosition(pos));
      // G7 yield-regression baseline: the entry-time fee APR, recorded for
      // non-launch positions (launch has its own lifecycle).
      if (pos.positionMode !== "launch") {
        yield* persistMetadataIfSupported(
          db,
          `yieldbase:${pos.positionId}`,
          JSON.stringify({ entryAprPct: deps.entryAprPct ?? 0, at: Date.now() }),
        );
      }
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
        .pipe(Effect.catch(() => Effect.void));
    } else if (decision.action === "EXIT") {
      // G2 rotation-arm re-check: a Rotation EXIT executes only while its
      // arm is fresh and the runner still qualifies — cancel-and-preserve
      // when the challenger evaporated.
      if (decision.reasoning.startsWith("Rotation:")) {
        const armRaw = yield* db
          .getMetadata(`rotarm:${decision.poolAddress}`)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        let armValid = false;
        if (armRaw) {
          try {
            const arm = JSON.parse(armRaw) as { runner: string; at: number };
            const armFresh = Date.now() - arm.at < (deps.rotationArmMs ?? 1_800_000);
            const runnerApr = deps.poolAprByAddress?.get(arm.runner)?.feeAprPct ?? 0;
            armValid = armFresh && runnerApr >= (deps.runnerMinFeeApr ?? 500);
          } catch {
            armValid = false;
          }
        }
        yield* persistMetadataIfSupported(db, `rotarm:${decision.poolAddress}`, "");
        if (!armValid) {
          console.warn(
            `[rotation-canceled] EXIT skipped on ${decision.poolAddress} — runner no longer qualifies; incumbent preserved`,
          );
          return { executed: false, error: "rotation canceled — incumbent preserved" };
        }
      }
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
          .pipe(Effect.catch(() => Effect.void));
        yield* persist(
          `closePosition ${pos.positionId}`,
          db.closePosition(pos.positionId, realizedPnlUsd),
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
        if (rugMints.length > 0) {
          const rugExpiresAt = Date.now() + (deps.rugTokenBlockMs ?? 604_800_000);
          for (const mint of rugMints) {
            yield* db.setMetadata(`token_rug_block:${mint}`, String(rugExpiresAt)).pipe(
              Effect.catch((err) =>
                Effect.sync(() =>
                  logger.warn("Failed to record rug-token block", {
                    pool: decision.poolAddress,
                    mint,
                    error: String(err),
                  }),
                ),
              ),
            );
          }
        }
        if (pos.entrySignalSnapshotId != null) {
          yield* db
            .recordSignalOutcome(pos.entrySignalSnapshotId, realizedPnlUsd)
            .pipe(Effect.catch(() => Effect.void));
        }
        yield* persist(`markPaperExited ${pos.positionId}`, db.markPaperExited(pos.positionId));
        trackedPositions.delete(pos.positionId);
      }
    } else if (decision.action === "REBALANCE" && decision.rebalanceParams) {
      const current = resolveTargetPosition(trackedPositions, decision);
      if (current) {
        // Runner scale-in: the top-up is FRESH capital — grow the cost basis
        // and the mark in lockstep (same invariant the live executor applies)
        // and advance the band anchor + step count.
        const topUpUsd = decision.rebalanceParams.topUpUsd ?? 0;
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
          lowerBinId: decision.rebalanceParams.newLowerBinId,
          upperBinId: decision.rebalanceParams.newUpperBinId,
          ...(current.launchRunner === true && decision.rebalanceParams.topUp !== undefined
            ? {
                launchRunnerAnchorPrice: pool.currentPrice,
                launchRunnerSteps: (current.launchRunnerSteps ?? 0) + 1,
              }
            : undefined),
          lastRebalanceAt: Date.now(),
        };
        trackedPositions.set(updated.positionId, updated);
        yield* persist(`savePosition ${updated.positionId}`, db.savePosition(updated));
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
              ...(decision.rebalanceParams.topUp !== undefined
                ? { scaleIn: true, topUpUsd }
                : undefined),
            },
            createdAt: Date.now(),
          })
          .pipe(Effect.catch(() => Effect.void));
      }
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
      entryDipOffsetBins,
      runnerSingleSidedX,
    } = deps;
    const autonomous = deps.autonomous;

    if (!adapter.hasWallet()) {
      console.error("Live trading enabled but no wallet configured");
      return { executed: false, error: "Live trading enabled but no wallet configured" };
    }

    // Rug detection: a live position closed at a catastrophic realized loss
    // arms `token_rug_block` for its non-stable legs. Reused by both live EXIT
    // paths (direct and settlement-attributable). A metadata write failure
    // fails open (warn) — it must never block the close or the cycle.
    const armRugBlocks = (realizedPnlUsd: number | null, depositedUsd: number) =>
      Effect.gen(function* () {
        const mints = rugBlockMints({
          realizedPnlUsd,
          depositedUsd,
          rugExitLossPct: deps.rugExitLossPct ?? 0.5,
          stablecoinMints: deps.stablecoinMints,
          tokenX: pool.tokenX,
          tokenY: pool.tokenY,
        });
        if (mints.length === 0) return;
        const expiresAt = Date.now() + (deps.rugTokenBlockMs ?? 604_800_000);
        for (const mint of mints) {
          yield* db.setMetadata(`token_rug_block:${mint}`, String(expiresAt)).pipe(
            Effect.catch((err) =>
              Effect.sync(() =>
                logger.warn("Failed to record rug-token block", {
                  pool: decision.poolAddress,
                  mint,
                  error: String(err),
                }),
              ),
            ),
          );
        }
      });

    // F5 allocation gate already caps the number of simultaneously open
    // positions via evaluatePerPoolAllocation (rejected in the decision
    // flow before we reach executeLive). No additional hard cap here so
    // live mode honors maxOpenPositions.

    let entryOperation: ExecutionOperationRecord | null = null;
    if (decision.action === "ENTER" && decision.positionSizeUsd && autonomous && pool.tokenX) {
      const now = Date.now();
      entryOperation = operationRecord({
        context: autonomous,
        id: randomUUID(),
        candidateId: null,
        positionId: null,
        poolAddress: decision.poolAddress,
        tokenMint: pool.tokenX,
        operationType: "entry",
        status: "planned",
        amountAtomic: null,
        txSignature: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      });
      const persisted = yield* db.saveExecutionOperation(entryOperation).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
      if (!persisted) {
        return { executed: false, error: "Unable to persist entry operation before execution" };
      }
    }

    if (decision.action === "ENTER") {
      // Align the automatic top-up with the live-entry SOL reserve, but size the
      // swap to the ACTUAL DEFICIT (plus a slippage/fee buffer), not the full
      // reserve: swapping the whole reserve when the wallet is only slightly
      // below it wastes USDC that token preparation downstream still needs, and
      // can fail an otherwise fundable ENTER. SOL_GAS_TOP_UP_THRESHOLD_LAMPORTS
      // aliases the reserve, so the swap trigger and the entry gate share one
      // value. When the balance read fails (null), skip the top-up entirely —
      // the post-swap recheck below will independently reject the ENTER if the
      // SOL balance cannot be confirmed.
      const entryReserveSol = Number(SOL_GAS_TOP_UP_THRESHOLD_LAMPORTS) / 1e9;
      const preSwapSol = yield* adapter.getNativeSolBalance().pipe(
        Effect.map((lamports) => Number(lamports) / 1e9),
        Effect.catch(() => Effect.succeed(null)),
      );
      if (preSwapSol !== null && preSwapSol < entryReserveSol) {
        const deficitSol = entryReserveSol - preSwapSol;
        // Prefer a live SOL price from the adapter's price chain over the static
        // config fallback: when the market price exceeds solPriceUsd (default
        // $150) by more than the 20% buffer, the static value underfunds the
        // swap and the post-swap balance check rejects an otherwise-fundable
        // ENTER. A failed price lookup falls back to the config value.
        const liveSolPrice = yield* adapter.getTokenPrices([SOL_MINT], { useFallback: false }).pipe(
          Effect.map((prices) => prices[SOL_MINT]),
          Effect.catch(() => Effect.succeed(undefined)),
        );
        const effectiveSolPrice =
          liveSolPrice != null && liveSolPrice > 0 ? liveSolPrice : solPriceUsd;
        const topUpUsdc =
          effectiveSolPrice > 0
            ? Math.max(GAS_TOP_UP_USDC, Math.ceil(deficitSol * effectiveSolPrice * 1.2))
            : GAS_TOP_UP_USDC;
        yield* adapter
          .swapUSDCForSOL(entryReserveSol, topUpUsdc)
          .pipe(Effect.catch(() => Effect.void));
      }

      const nativeBalance = yield* adapter.getNativeSolBalance().pipe(
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
      const failPlannedEntry = (operation: ExecutionOperationRecord, error: string) =>
        db
          .saveExecutionOperation({
            ...operation,
            status: "failed",
            error,
            updatedAt: Date.now(),
          })
          .pipe(Effect.catch(() => Effect.void));
      if (nativeBalance.value === null) {
        const error = nativeBalance.error ?? "Unable to read native SOL balance";
        if (autonomous && entryOperation) {
          yield* failPlannedEntry(entryOperation, error);
        }
        return { executed: false, error };
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
          yield* failPlannedEntry(entryOperation, error);
        }
        return { executed: false, error };
      }
    }

    let preparation: EntryPreparationOutcome | null = null;
    if (decision.action === "ENTER" && decision.positionSizeUsd) {
      const prepResult = yield* entryPrep
        .prepareEntryTokens(
          decision.poolAddress,
          decision.positionSizeUsd,
          runnerSingleSidedX === true ? { xOnly: true } : undefined,
        )
        .pipe(
          Effect.matchEffect({
            onSuccess: (outcome) =>
              Effect.succeed({
                outcome: outcome ?? null,
                partial: null,
                error: undefined as string | undefined,
              }),
            onFailure: (err) => {
              const partial =
                err instanceof EntryPrepError ? (err.partialPreparation ?? null) : null;
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
          let settlementPersisted = true;
          for (const job of settlementJobsForReceipts({
            context: autonomous,
            positionId: `rollback:${entryOperation.id}`,
            poolAddress: decision.poolAddress,
            receipts: prepResult.partial?.receipts ?? [],
            now,
          })) {
            yield* db.saveSettlementJob(job).pipe(
              Effect.catch(() =>
                Effect.sync(() => {
                  settlementPersisted = false;
                }),
              ),
            );
            if (!settlementPersisted) {
              deps.reconcileRequestedPools?.add(decision.poolAddress);
              yield* db
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
            yield* db
              .saveExecutionOperation({
                ...entryOperation,
                operationType: "rollback",
                status: prepResult.partial ? "retryable" : "failed",
                error: prepResult.error,
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
            yield* db
              .saveSafetyPause({
                walletAddress: autonomous.walletAddress,
                agentInstanceId: autonomous.agentInstanceId,
                reason: "settlement_persistence_failed",
                triggeredAt: now,
                resolvedAt: null,
              })
              .pipe(Effect.catch(() => Effect.void));
          }
        }
        console.warn(prepResult.error, { pool: decision.poolAddress });
        return { executed: false, error: prepResult.error };
      }
      preparation = prepResult.outcome;
      if (entryOperation) {
        entryOperation = { ...entryOperation, status: "prepared", updatedAt: Date.now() };
        yield* db.saveExecutionOperation(entryOperation).pipe(Effect.catch(() => Effect.void));
      }
    }

    if (decision.action === "ENTER" && decision.positionSizeUsd) {
      const recommended = strategy.recommendBinRange(
        pool.activeBinId,
        pool.binStep,
        entryRangeHalfWidth,
        entryDipOffsetBins,
      );
      const enterResult = yield* adapter
        .enterPosition(
          decision.poolAddress,
          recommended.lowerBinId,
          recommended.upperBinId,
          decision.positionSizeUsd,
          {
            strategyShape: entryStrategyShape,
            ...(runnerSingleSidedX === true ? { forceSingleSidedX: true } : undefined),
          },
        )
        .pipe(
          Effect.tap((r) =>
            Effect.sync(() =>
              console.info("Live position entered", {
                pool: decision.poolAddress,
                position: r.positionPubKey,
                tx: r.txSignature,
              }),
            ),
          ),
          Effect.map((r) => ({ result: r, error: undefined as string | undefined })),
          Effect.catch((err) => {
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
          positionMode: decision.positionMode ?? null,
          tpLadderJson: decision.tpLadderJson ?? null,
          invalidationStopPrice: decision.invalidationStopPrice ?? null,
          launchRunner: (entryDipOffsetBins ?? 0) !== 0 ? true : null,
          launchRunnerSteps: (entryDipOffsetBins ?? 0) !== 0 ? 0 : null,
          launchRunnerAnchorPrice: (entryDipOffsetBins ?? 0) !== 0 ? pool.currentPrice : null,
        };
        trackedPositions.set(pos.positionId, pos);
        yield* persist(`savePosition ${pos.positionId}`, db.savePosition(pos));
        // G7 yield-regression baseline: the entry-time fee APR, recorded for
        // non-launch positions (launch has its own lifecycle).
        if (pos.positionMode !== "launch") {
          yield* persistMetadataIfSupported(
            db,
            `yieldbase:${pos.positionId}`,
            JSON.stringify({ entryAprPct: deps.entryAprPct ?? 0, at: Date.now() }),
          );
        }
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
          .pipe(Effect.catch(() => Effect.void));
        if (entryOperation) {
          yield* db
            .saveExecutionOperation({
              ...entryOperation,
              positionId: pos.positionId,
              status: "confirmed",
              txSignature: enterResult.result.txSignature,
              updatedAt: Date.now(),
            })
            .pipe(Effect.catch(() => Effect.void));
        }
        return { executed: true, error: undefined };
      }
      if (autonomous && entryOperation && preparation) {
        const now = Date.now();
        let settlementPersisted = true;
        for (const job of settlementJobsForReceipts({
          context: autonomous,
          positionId: `rollback:${entryOperation.id}`,
          poolAddress: decision.poolAddress,
          receipts: preparation.receipts,
          now,
        })) {
          yield* db.saveSettlementJob(job).pipe(
            Effect.catch(() =>
              Effect.sync(() => {
                settlementPersisted = false;
              }),
            ),
          );
          if (!settlementPersisted) {
            deps.reconcileRequestedPools?.add(decision.poolAddress);
            yield* db
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
          yield* db
            .saveExecutionOperation({
              ...entryOperation,
              operationType: "rollback",
              status: "retryable",
              error: enterResult.error ?? "Position entry failed after funding swaps",
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
          yield* db
            .saveSafetyPause({
              walletAddress: autonomous.walletAddress,
              agentInstanceId: autonomous.agentInstanceId,
              reason: "settlement_persistence_failed",
              triggeredAt: now,
              resolvedAt: null,
            })
            .pipe(Effect.catch(() => Effect.void));
        }
      }
      return { executed: false, error: enterResult.error };
    } else if (decision.action === "ENTER") {
      return { executed: false, error: "ENTER decision missing position size" };
    } else if (decision.action === "EXIT") {
      // G2 rotation-arm re-check: a Rotation EXIT executes only while its
      // arm is fresh and the runner still qualifies — cancel-and-preserve
      // when the challenger evaporated.
      if (decision.reasoning.startsWith("Rotation:")) {
        const armRaw = yield* db
          .getMetadata(`rotarm:${decision.poolAddress}`)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        let armValid = false;
        if (armRaw) {
          try {
            const arm = JSON.parse(armRaw) as { runner: string; at: number };
            const armFresh = Date.now() - arm.at < (deps.rotationArmMs ?? 1_800_000);
            const runnerApr = deps.poolAprByAddress?.get(arm.runner)?.feeAprPct ?? 0;
            armValid = armFresh && runnerApr >= (deps.runnerMinFeeApr ?? 500);
          } catch {
            armValid = false;
          }
        }
        yield* persistMetadataIfSupported(db, `rotarm:${decision.poolAddress}`, "");
        if (!armValid) {
          console.warn(
            `[rotation-canceled] EXIT skipped on ${decision.poolAddress} — runner no longer qualifies; incumbent preserved`,
          );
          return { executed: false, error: "rotation canceled — incumbent preserved" };
        }
      }
      const pos = resolveTargetPosition(trackedPositions, decision);
      let exitOperation: ExecutionOperationRecord | null = null;
      if (autonomous && pos && pool.tokenX) {
        const now = Date.now();
        exitOperation = operationRecord({
          context: autonomous,
          id: randomUUID(),
          candidateId: deps.candidateId ?? null,
          positionId: pos.positionId,
          poolAddress: decision.poolAddress,
          tokenMint: pool.tokenX ?? null,
          operationType: "exit",
          status: "planned",
          amountAtomic: null,
          txSignature: null,
          error: null,
          createdAt: now,
          updatedAt: now,
        });
        const persisted = yield* db.saveExecutionOperation(exitOperation).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        );
        if (!persisted) {
          return { executed: false, error: "Unable to persist exit operation before execution" };
        }
      }
      let exited = false;
      let exitError: string | undefined = undefined;
      let exitResultData: Effect.Success<ReturnType<AdapterApi["exitPosition"]>> | null = null;
      if (pos?.positionPubKey) {
        const exitResult = yield* adapter
          .exitPosition(decision.poolAddress, pos.positionPubKey)
          .pipe(
            Effect.tap(() =>
              Effect.sync(() =>
                console.info("Live position exited", {
                  pool: decision.poolAddress,
                  position: pos.positionPubKey,
                }),
              ),
            ),
            Effect.map((r) => ({ result: r, error: undefined as string | undefined })),
            Effect.catch((err) => {
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
        exitResultData = exitResult.result;
        if (exitOperation && exitResult.result) {
          exitOperation = {
            ...exitOperation,
            status: "confirmed",
            txSignature: exitResult.result.txSignature,
            updatedAt: Date.now(),
          };
          yield* db.saveExecutionOperation(exitOperation).pipe(Effect.catch(() => Effect.void));
        }
        if (!exited) {
          // A failed close may have left the position half-closed on-chain
          // (the $27 phantom-row candidate: wallet holds withdrawn funds while
          // the row still counts in Σpositions). Flag the pool so the next
          // cycle's reconcile re-reads the wallet's real positions and drops
          // the row if it is gone — mirroring the atomic-rebalance failure path.
          deps.reconcileRequestedPools?.add(decision.poolAddress);
        }
      } else {
        exited = true;
      }
      if (exited) {
        if (
          autonomous &&
          pos &&
          exitResultData &&
          pool.tokenX !== undefined &&
          pool.tokenY !== undefined
        ) {
          const now = Date.now();
          const attributable = [
            {
              mint: pool.tokenX,
              amountAtomic: exitResultData.withdrawnXAtomic ?? "0",
            },
            {
              mint: pool.tokenY,
              amountAtomic: exitResultData.withdrawnYAtomic ?? "0",
            },
            ...(exitResultData.sweptRewards ?? [])
              .filter((reward) => reward.mint !== "unknown")
              .map((reward) => ({
                mint: reward.mint,
                amountAtomic: reward.amountAtomic,
              })),
          ].filter(({ amountAtomic }) => {
            try {
              return BigInt(amountAtomic) > 0n;
            } catch {
              return false;
            }
          });
          let settlementPersisted = true;
          for (const item of attributable) {
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
            yield* db.saveSettlementJob(job).pipe(
              Effect.catch(() =>
                Effect.sync(() => {
                  settlementPersisted = false;
                }),
              ),
            );
            if (!settlementPersisted) {
              deps.reconcileRequestedPools?.add(decision.poolAddress);
              yield* db
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
          if (!settlementPersisted) {
            return {
              executed: false,
              error: "Unable to persist all exit settlement jobs; reconciliation required",
            };
          }
          const pendingFeeUsd = exitResultData.pendingFeeUsd;
          if (pendingFeeUsd != null) {
            yield* db
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
            yield* db
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
          const withdrawnUsd = exitResultData.withdrawnUsd ?? null;
          const pricingUnresolved = withdrawnUsd === null;
          const realizedPnlUsd =
            exitResultData.isEmptyReap
              ? 0
              : pricingUnresolved || attributable.length > 0
                ? null
                : computeRealizedPnlUsd(
                    withdrawnUsd,
                    pos.cumulativeFeesClaimedUsd,
                    pos.depositedUsd,
                    pos.cumulativeRewardsClaimedUsd,
                  );
          yield* persist(`savePosition ${pos.positionId}`, db.savePosition(pos));
          yield* persist(
            `closePosition ${pos.positionId}`,
            db.closePosition(pos.positionId, realizedPnlUsd),
          );
          if (exitResultData?.isEmptyReap === true && pos.positionPubKey != null) {
            // Tombstone the reaped-empty pubkey so reconcile never re-discovers
            // the ghost account (rent reclaim may have failed, leaving it
            // on-chain) and re-adds a phantom row every cycle. Bounded so a
            // later legit refill is eventually re-admitted.
            yield* persist(
              `tombstone empty ${pos.positionPubKey}`,
              db.setMetadata(
                `reaped_empty:${pos.positionPubKey}`,
                String(Date.now() + EMPTY_REAP_REDISCOVERY_COOLDOWN_MS),
              ),
            );
          }
          yield* armRugBlocks(realizedPnlUsd, pos.depositedUsd);
          trackedPositions.delete(pos.positionId);
          yield* db
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
          return { executed: true, error: undefined };
        }
        if (pos) {
          // ── Locked realized-PnL ordering (Oracle-locked) ──────────────────
          // 1. finalValue = the adapter's mint-priced withdrawn USD (incl. the
          //    unswept fees the close batch claims). When pricing is unresolved
          //    (null / amounts absent) there is NO trusted value → NULL path:
          //    realized recorded n/a, never the mark, never 0.
          const withdrawnUsd = exitResultData?.withdrawnUsd ?? null;
          const pricingUnresolved = withdrawnUsd === null;
          // The close batch also claims any pending LM rewards on-chain. The
          // PRICED swept rewards are part of the withdrawal, so they must enter
          // realized exactly once — folded into the rewards ARGUMENT computed
          // here, BEFORE the post-compute credit (step 4) touches the cumulative
          // (which is APR/display only and never re-summed into this realized).
          // Unpriceable swept rewards (amountUsd null) contribute 0 here — see
          // the claim-path consistency rationale at the credit block below.
          const sweptRewards = exitResultData?.sweptRewards ?? [];
          const pricedSweptRewardUsd = sweptRewards.reduce(
            (acc, r) => (r.amountUsd != null ? acc + r.amountUsd : acc),
            0,
          );
          const isEmptyReap = exitResultData?.isEmptyReap ?? false;
          // 2. Compute on the PRIOR cumulatives only — the exit sweep is
          //    credited AFTER this (step 4) so it is never double-counted.
          //    withdrawn already embeds unswept + recompounded fees; prior
          //    cumulatives cover earlier claims; basis embeds recompounded fees
          //    → exactly-once across every FEE_DESTINATION mode. An empty-reap
          //    (zero-liquidity on-chain account, see AdapterApi.exitPosition)
          //    realizes 0: the heuristic mark was phantom, so no loss against
          //    the (suspect) deposited basis and no rug-block is booked.
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
          // 3. Credit the sweep post-compute — fee-APR / display / event
          //    continuity only, never a realized input.
          const pendingFeeUsd = exitResultData?.pendingFeeUsd ?? null;
          const pendingFeeX = Number(exitResultData?.pendingFeeXAtomic ?? "0");
          const pendingFeeY = Number(exitResultData?.pendingFeeYAtomic ?? "0");
          if (pendingFeeUsd != null) {
            pos.cumulativeFeesClaimedUsd += pendingFeeUsd;
            if ((pendingFeeX > 0 || pendingFeeY > 0) && pos.positionPubKey != null) {
              const sweepTxSignature = `exit-sweep:${pos.positionId}`;
              yield* db
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
              yield* db
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
          }
          let sweptRewardUsd = 0;
          let unpricedReward = false;
          for (const reward of sweptRewards) {
            if (reward.amountUsd != null) {
              pos.cumulativeRewardsClaimedUsd += reward.amountUsd;
              sweptRewardUsd += reward.amountUsd;
            } else {
              unpricedReward = true;
            }
          }
          if (unpricedReward) {
            logger.warn("Exit sweep included an unpriceable LM reward — recorded with null USD", {
              pool: decision.poolAddress,
              position: pos.positionId,
            });
          }
          if (sweptRewards.length > 0) {
            yield* db
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
          }
          // Persist the credited cumulatives onto the (still-open) row, THEN
          // close — closePosition runs last so the savePosition upsert (which
          // writes closed_at) cannot resurrect the row; it sets closed_at +
          // realized without touching the fee/reward columns just written.
          yield* persist(`savePosition ${pos.positionId}`, db.savePosition(pos));
          yield* persist(
            `closePosition ${pos.positionId}`,
            db.closePosition(pos.positionId, realizedPnlUsd),
          );
          if (exitResultData?.isEmptyReap === true && pos.positionPubKey != null) {
            // Tombstone the reaped-empty pubkey so reconcile never re-discovers
            // the ghost account (rent reclaim may have failed, leaving it
            // on-chain) and re-adds a phantom row every cycle. Bounded so a
            // later legit refill is eventually re-admitted.
            yield* persist(
              `tombstone empty ${pos.positionPubKey}`,
              db.setMetadata(
                `reaped_empty:${pos.positionPubKey}`,
                String(Date.now() + EMPTY_REAP_REDISCOVERY_COOLDOWN_MS),
              ),
            );
          }
          yield* armRugBlocks(realizedPnlUsd, pos.depositedUsd);
          if (pos.entrySignalSnapshotId != null && realizedPnlUsd != null) {
            yield* db
              .recordSignalOutcome(pos.entrySignalSnapshotId, realizedPnlUsd)
              .pipe(Effect.catch(() => Effect.void));
          }
          // 5. EXIT event: withdrawn USD (or null) + post-credit lifetime fees.
          const exitMetadata = pricingUnresolved
            ? {
                realizedPnlUsd,
                pricing: "unresolved",
                lastMarkUsd: pos.currentValueUsd,
                raw: {
                  withdrawnXAtomic: exitResultData?.withdrawnXAtomic ?? null,
                  withdrawnYAtomic: exitResultData?.withdrawnYAtomic ?? null,
                  pendingFeeXAtomic: exitResultData?.pendingFeeXAtomic ?? null,
                  pendingFeeYAtomic: exitResultData?.pendingFeeYAtomic ?? null,
                },
              }
            : { realizedPnlUsd };
          yield* db
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
          if (
            pricingUnresolved &&
            !(deps.unpricedExitWarnedPools?.has(decision.poolAddress) ?? false)
          ) {
            deps.unpricedExitWarnedPools?.add(decision.poolAddress);
            logger.warn(
              "EXIT closed without USD pricing (price feeds unresolved) — realized PnL recorded as n/a; raw amounts in event metadata",
              { pool: decision.poolAddress, position: pos.positionId },
            );
            yield* deps.memory
              ? deps.memory
                  .upsert({
                    category: "warning",
                    content: `EXIT on ${decision.poolAddress} closed without USD pricing (price feeds unresolved) — realized PnL recorded as n/a; raw amounts in event metadata`,
                    poolAddress: decision.poolAddress,
                  })
                  .pipe(Effect.catch(() => Effect.void))
              : Effect.void;
          }
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

        // G4 economic harvest gate (rule: never spend $0.80 to realize
        // $1.00): skip the pre-rebalance fee claim when the PENDING net
        // fees don't clear the floor / cost gate. The rebalance itself
        // always completes — only the fee claim is skipped (it rides the
        // normal cadence path next scan). Fail open on unknown pending.
        let claimResult: Effect.Success<ReturnType<AdapterApi["claimFees"]>> | null = null;
        const rebalanceHarvestGate = adapter.getClaimableFeesUsd
          ? yield* adapter.getClaimableFeesUsd(decision.poolAddress, pos.positionPubKey).pipe(
              Effect.map((netUsd) =>
                evaluateHarvestGate(netUsd, {
                  ...(deps.harvestMinNetUsd !== undefined
                    ? { harvestMinNetUsd: deps.harvestMinNetUsd }
                    : undefined),
                  ...(deps.harvestMaxCostPct !== undefined
                    ? { harvestMaxCostPct: deps.harvestMaxCostPct }
                    : undefined),
                  ...(deps.harvestTxCostUsdEst !== undefined
                    ? { harvestTxCostUsdEst: deps.harvestTxCostUsdEst }
                    : undefined),
                }),
              ),
              Effect.catch(() =>
                Effect.succeed({
                  approved: true,
                  reason: "[harvest-gate] pending read failed — fail open (claim anyway)",
                }),
              ),
            )
          : null;
        if (rebalanceHarvestGate && !rebalanceHarvestGate.approved) {
          console.warn(
            `[harvest-gate] pre-rebalance claim skipped on ${decision.poolAddress} (${pos.positionId}): ${rebalanceHarvestGate.reason}`,
          );
        } else {
          claimResult = yield* adapter
            .claimFees(
              decision.poolAddress,
              pos.positionPubKey,
              platformFeeRate,
              revenueShareEnabled,
              revenueShareOperatorPct,
              revenueConfigResult.feeWalletAddress,
            )
            .pipe(Effect.catch(() => Effect.succeed(null)));
        }

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
            .pipe(Effect.catch(() => Effect.void));

          // Mint-based net-fee USD priced inside the adapter (mirrors
          // simulateRebalance). Null → 0 fails closed so an unpriceable claim
          // never inflates cumulative fees or the compound gate.
          const claimedFeesUsd = claimResult.netFeesUsd ?? 0;
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
            .pipe(Effect.catch(() => Effect.void));

          if (
            claimResult.platformFeeX > 0 ||
            claimResult.platformFeeY > 0 ||
            (claimResult.operatorFeeX ?? 0) > 0 ||
            (claimResult.operatorFeeY ?? 0) > 0
          ) {
            yield* Effect.forkChild(
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
                  Effect.catchCause((cause) =>
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
            decision.rebalanceParams.topUp,
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
            Effect.map((r) => ({ result: r, error: undefined as string | undefined })),
            Effect.catch((err) => {
              const msg = (err as { message?: string }).message ?? String(err);
              console.error("Live atomic REBALANCE failed", {
                pool: decision.poolAddress,
                err: msg,
              });
              return Effect.succeed({ result: null, error: msg });
            }),
          );

        if (rebalanceResult.result) {
          // Runner scale-in: the top-up is FRESH capital — grow the cost
          // basis and the mark in lockstep (currentValue + topUp = the
          // post-rebalance on-chain value; depositedUsd tracks the added
          // capital so PnL never treats it as profit), credit the X basis and
          // advance the band anchor + step count.
          const topUpUsd = decision.rebalanceParams.topUpUsd ?? 0;
          const scaled = applyCompoundToCostBasis({
            depositedUsd: pos.depositedUsd,
            currentValueUsd: pos.currentValueUsd,
            highestValueUsd: pos.highestValueUsd,
            compoundedFeesUsd: topUpUsd,
          });
          const updated: PositionRecord = {
            ...pos,
            ...scaled,
            entryAmountXUsd:
              decision.rebalanceParams.topUp !== undefined
                ? (pos.entryAmountXUsd ?? 0) + topUpUsd
                : pos.entryAmountXUsd,
            // Atomic rebalance preserves the position account: the pubkey,
            // entry basis and cumulative fee accounting all survive.
            positionId: rebalanceResult.result.positionPubKey,
            positionPubKey: rebalanceResult.result.positionPubKey,
            lowerBinId: decision.rebalanceParams.newLowerBinId,
            upperBinId: decision.rebalanceParams.newUpperBinId,
            ...(decision.rebalanceParams.topUp !== undefined
              ? {
                  launchRunnerAnchorPrice: pool.currentPrice,
                  launchRunnerSteps: (pos.launchRunnerSteps ?? 0) + 1,
                }
              : undefined),
            lastFeeClaimAt: Date.now(),
            lastRebalanceAt: Date.now(),
          };
          if (updated.positionId !== pos.positionId) {
            // Defensive re-key: the SDK preserves the account, but if the
            // pubkey ever changed, the identity and its row must move with it
            // — otherwise the stale row would linger as a phantom position.
            trackedPositions.delete(pos.positionId);
            yield* persist(`deletePosition ${pos.positionId}`, db.deletePosition(pos.positionId));
          }
          trackedPositions.set(updated.positionId, updated);
          yield* persist(`savePosition ${updated.positionId}`, db.savePosition(updated));
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
    const pools = new Set<string>();
    for (const pos of positions) {
      if (pos.entryPriceUsd != null) pools.add(pos.poolAddress);
    }
    for (const pool of snapshotPools) pools.add(pool);

    // Resolve each pool's scale factor, reusing the persistent per-pool cache so
    // a transient RPC failure on one pool never discards the factors already
    // resolved for the rest (progress survives restarts). The factor is a
    // per-pool constant (token decimals), so caching it is exact.
    const updates: Array<{ poolAddress: string; factor: number }> = [];
    for (const pool of pools) {
      const key = priceScaleFactorKey(pool);
      const cached = yield* db.getMetadata(key).pipe(Effect.catch(() => Effect.succeed(null)));
      if (cached != null) {
        const cachedFactor = Number(cached);
        if (Number.isFinite(cachedFactor) && cachedFactor > 0) {
          updates.push({ poolAddress: pool, factor: cachedFactor });
          continue;
        }
      }
      const factor = adapter.getPriceScale ? yield* adapter.getPriceScale(pool) : 1;
      if (!Number.isFinite(factor) || factor <= 0) {
        return yield* Effect.fail(
          new Error(`Price-scale backfill: invalid factor ${factor} for ${pool}`),
        );
      }
      yield* db.setMetadata(key, String(factor)).pipe(Effect.catch(() => Effect.void));
      updates.push({ poolAddress: pool, factor });
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

export const program = Effect.gen(function* () {
  const config = yield* ConfigService;
  const adapter = yield* AdapterService;
  const executionWalletAddress = adapter.getWalletAddress();
  const autonomousExecution: AutonomousExecutionContext | null =
    config.autonomousTokenMode !== "off" && executionWalletAddress !== null
      ? {
          mode: config.autonomousTokenMode,
          walletAddress: executionWalletAddress,
          agentInstanceId: config.agentInstanceId,
          settlementMaxPendingMs: config.settlementMaxPendingMs,
          settlementDustUsd: config.settlementDustUsd,
        }
      : null;
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
  const dailyBaselineScope = {
    walletAddress: executionWalletAddress ?? "paper",
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
  const solFundedEntryMode =
    config.autonomousTokenMode === "canary" || config.autonomousTokenMode === "live";
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

  if (!config.paperTrading) {
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
  }

  // ─── Pool discovery ────────────────────────────────────────────────────────

  let poolsToScan = [...config.watchlistPools];
  const autonomousCandidateWallet = executionWalletAddress ?? "paper";
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

  if (config.autonomousTokenMode !== "off") {
    const persistedCandidates = yield* db
      .listTokenCandidates(autonomousCandidateWallet, config.agentInstanceId)
      .pipe(Effect.catch(() => Effect.succeed([])));
    for (const candidate of persistedCandidates) {
      autonomousCandidates.set(candidate.id, candidate);
      autonomousCandidatePools.add(candidate.poolAddress);
      autonomousCandidatePoolAddresses.add(candidate.poolAddress);
    }
  }

  if (!shouldDiscoverPools(config) && config.enablePoolDiscovery) {
    logger.warn("Live pool discovery is disabled; configure WATCHLIST_POOLS for approved pools.", {
      paperTrading: config.paperTrading,
    });
  }

  if (shouldDiscoverPools(config) && config.autonomousTokenMode === "off") {
    const screened = yield* screener.screenPools().pipe(
      Effect.catch((err) => {
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
                return Effect.succeed([] as ReadonlyArray<ScreenedPool>);
              }),
            );
      const now = Date.now();
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
            yield* db.saveTokenCandidate(advancedCandidate).pipe(Effect.catch(() => Effect.void));
          }
        }
      }
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
      const routeAvailableMints = new Set<string>();
      if (adapter.quoteSwap !== undefined) {
        const quoteSwap = adapter.quoteSwap;
        const nonSolMints = mints.filter((mint) => mint !== SOL_MINT);
        const prices = yield* adapter
          .getTokenPrices([SOL_MINT], { useFallback: false })
          .pipe(Effect.catch(() => Effect.succeed<Record<string, number>>({})));
        const solPrice = prices[SOL_MINT] ?? 0;
        const tokenPrices = new Map(
          priceEvidence.map((evidence) => [evidence.mint, evidence.priceUsd]),
        );
        const decimalsByMint = new Map<string, number>();
        for (const mint of nonSolMints) {
          const decimals = yield* adapter
            .getTokenDecimals(mint)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (decimals !== null) decimalsByMint.set(mint, decimals);
        }
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
        for (let i = 0; i < nonSolMints.length; i++) {
          const mint = nonSolMints[i];
          if (mint && routeAvailableResults[i]) routeAvailableMints.add(mint);
        }
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
      const discovered = yield* adapter
        .discoverPools(scanOrdinal)
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
      let idleCapitalUsd: number;
      if (config.paperTrading || !adapter.hasWallet()) {
        idleCapitalUsd = Math.max(config.paperPortfolioUsd - deployedUsd, 0);
      } else {
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
        idleCapitalUsd =
          usdcHolding === undefined
            ? 0
            : Number(usdcHolding.amountAtomic) / 10 ** usdcHolding.decimals;
      }

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
      const portfolioValueUsd =
        config.paperTrading || !adapter.hasWallet()
          ? config.paperPortfolioUsd
          : lastWalletBalanceUsd + openPositions.reduce((sum, pos) => sum + pos.currentValueUsd, 0);
      const recentPnlUsd = openPositions.reduce((sum, pos) => sum + pos.unrealizedPnlUsd, 0);

      // Follow-up 3655288395: walk candidates in score order and dispatch the
      // FIRST one that survives every fresh gate. A per-candidate rejection
      // (backoff, allocation headroom, widened-size, overlay, risk) `continue`s
      // to the next candidate with its own audit record; a cycle-global abort
      // (max open positions, size floor, live paper-validation) or a dispatched
      // execution `return`s. At most one redeploy ENTER per cycle.
      const sortedCandidates = [...candidates].sort((a, b) => b.entryScore - a.entryScore);
      for (const candidate of sortedCandidates) {
        // Follow-up 3655404926: a pool whose EXIT actually executed earlier THIS
        // cycle (raw deterministic OR an agent overlay that flipped HOLD→EXIT and
        // executed it after this candidate was captured) may NOT re-enter in the
        // same cycle — the no-exit-and-reenter invariant (AGENTS.md §multiple-
        // positions). The fresh position-count gates alone miss it: the exit freed
        // the slot, so the count re-check passes. Exclude by executed-exit pool.
        if (executedExitPools.has(candidate.poolAddress)) {
          yield* audit
            .recordDecision({
              timestamp: Date.now(),
              cycleId,
              poolAddress: candidate.poolAddress,
              action: "ENTER",
              confidence: 0,
              reasoning:
                "[idle-redeploy] skipped — an EXIT executed on this pool earlier this cycle (no exit-and-reenter)",
              metrics: candidate.metrics,
              riskResult: {
                approved: false,
                reason: "[idle-redeploy] pool exited earlier this cycle",
              },
              executed: false,
              paperTrading: config.paperTrading,
            })
            .pipe(Effect.catch(() => Effect.void));
          continue;
        }

        const recordRedeploySkip = (reasoning: string, riskReason: string) =>
          audit
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

        // P2 (3654054425, entry backoff): if this pool's normal ENTER failed with
        // an insufficient-token-balance error earlier THIS cycle (or earlier),
        // entryFailureBackoff was armed. Retrying the redeploy at the larger
        // widened size would repeat a known-doomed entry and amplify RPC/tx work.
        // Honor the SAME active-backoff predicate the normal ENTER gate uses
        // (evaluatePool's `[entry-backoff]` block) — an active entry backoff on
        // THIS candidate skips it and the walk continues to the next candidate.
        const redeployEntryBackoff = entryFailureBackoff.get(candidate.poolAddress);
        if (redeployEntryBackoff && redeployEntryBackoff.nextAttemptAt > Date.now()) {
          yield* recordRedeploySkip(
            `[idle-redeploy] skipped — entry backoff active (insufficient token balance; retry in ${Math.ceil((redeployEntryBackoff.nextAttemptAt - Date.now()) / 60_000)} minutes)`,
            "[idle-redeploy] entry-failure backoff active",
          );
          continue;
        }

        // The pass never pushes past the hard open-position cap; the same count
        // is re-checked against fresh state by allocation below and by risk
        // gate 6 at execution.
        if (openPositions.length >= config.maxOpenPositions) {
          yield* recordRedeploySkip(
            `[idle-redeploy] skipped — max open positions reached (${openPositions.length}/${config.maxOpenPositions})`,
            `[idle-redeploy] max open positions reached (${openPositions.length}/${config.maxOpenPositions})`,
          );
          return;
        }

        // Wider size: half the idle capital, bounded by the per-pool allocation
        // share of the portfolio AND the configured idle ceiling.
        // evaluatePerPoolAllocation shrinks it to the pool's real remaining
        // headroom and risk gate 6 caps it again before execution.
        const proposedSizeUsd = computeIdleRedeploySizeUsd({
          idleCapitalUsd,
          portfolioValueUsd,
          maxPerPoolAllocationPct: config.maxPerPoolAllocationPct,
          maxSizeUsd: config.idleRedeployMaxSizeUsd,
        });
        if (proposedSizeUsd < ENTRY_SIZE_FLOOR_USD) {
          yield* recordRedeploySkip(
            `[idle-redeploy] skipped — widened size $${proposedSizeUsd.toFixed(2)} below $${ENTRY_SIZE_FLOOR_USD} floor`,
            "[idle-redeploy] proposed size below entry floor",
          );
          return;
        }

        const allocation = evaluatePerPoolAllocation({
          proposedDepositUsd: proposedSizeUsd,
          portfolioValueUsd,
          openPositions,
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
            `[idle-redeploy] capped — ${allocation.reason}`,
            `[idle-redeploy] ${allocation.reason}`,
          );
          continue;
        }

        let decision: AgentDecision = {
          action: "ENTER",
          poolAddress: candidate.poolAddress,
          // P2 (3654054423) + follow-up 3655288403: a modeled fee/IL ratio
          // (gecko, feeIlRatioKnown=false) gets NO fee vote; when fee/IL is
          // unknown confidence is derived from the signals that ARE known
          // (measured volume authenticity + on-chain bin utilization) instead of a
          // flat fail-closed constant — see computeIdleRedeployConfidence.
          confidence: computeIdleRedeployConfidence({
            feeIlRatio: candidate.feeIlRatio,
            feeIlRatioKnown: candidate.metrics.feeIlRatioKnown,
            volumeAuthenticity: candidate.metrics.volumeAuthenticity,
            volumeAuthenticityKnown: candidate.metrics.volumeAuthenticityKnown,
            binUtilization: candidate.metrics.binUtilization,
            binUtilizationKnown: candidate.metrics.binUtilizationKnown,
          }),
          reasoning: `[idle-redeploy] Deploying $${idleCapitalUsd.toFixed(0)} idle capital — Fee/IL ${candidate.feeIlRatio.toFixed(2)}, score ${candidate.entryScore.toFixed(3)}, TVL $${candidate.pool.tvlUsd.toFixed(0)}`,
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

        // ── Agent overlay (P1 3654054419): the redeploy deploys capital exactly
        // like a normal ENTER, so under AGENTIC_MODE it must pass through the SAME
        // per-decision overlay evaluatePool's tail uses, BEFORE risk evaluation —
        // supervised requires an approved queued proposal, veto may lower
        // confidence or force HOLD, and full/suggest are honored within their
        // documented bounds. The overlay can only CONSTRAIN an already-qualified
        // candidate (proceed, adjust-within-bounds, or skip); it never promotes
        // the redeploy past what a normal ENTER would be allowed. Invokes the SAME
        // shared functions in the SAME order as the in-slot tail. AGENTIC_MODE=false
        // (default) skips the whole block → zero behavior change.
        let overlayAppliedProposalId: string | undefined;
        // Follow-up 3655404920: mirror the in-slot tail's risk-deny bookkeeping —
        // capture the pre-apply decision and whether an applied proposal changed
        // executable behavior so a deterministic risk denial after an applied
        // full/supervised proposal can reject the queued proposal and arm backoff
        // / circuit breaker (otherwise the same approved low-confidence proposal
        // stays selectable and retries every eligible cycle).
        let overlayPreApplyDecision: AgentDecision | undefined;
        let overlayAppliedAgentProposal = false;
        let overlayProposalValidated = false;
        if (config.agentiveMode) {
          const proposalMode = config.agentProposalMode;
          const now = Date.now();
          const overlayPoolAddress = candidate.poolAddress;
          const overlayHasOpenPosition =
            positionsForPool(trackedPositions, overlayPoolAddress).length > 0;
          const overlayWarnings = yield* memory
            .getRelevantContext(`warnings for pool ${overlayPoolAddress}`, 3, overlayPoolAddress)
            .pipe(Effect.catch(() => Effect.succeed([])));
          const overlayRecentDecisions = yield* audit
            .getRecentDecisions(10)
            .pipe(Effect.catch(() => Effect.succeed([])));
          let overlaySkip = false;

          if (proposalMode === "veto") {
            // Veto is a safety overlay, applied fail-open exactly as the tail does:
            // a fetch failure leaves the decision unchanged; a returned override is
            // adopted (it may lower confidence or force HOLD).
            const enhanced = yield* agent
              .enhanceDecision(decision, {
                decision,
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
                from: decision.action,
                to: enhanced.action,
                fromConfidence: decision.confidence.toFixed(2),
                toConfidence: enhanced.confidence.toFixed(2),
              });
              decision = enhanced;
            }
          } else {
            // suggest | supervised | full — resolve a queued proposal first
            // (supervised NEVER syncs, mirroring the tail's `!== "supervised"`
            // guard); for full/suggest a sync advisor proposal is attempted within
            // circuit-breaker / backoff bounds. A validated proposal is applied only
            // while the redeploy stays an ENTER; any other adjusted action cancels
            // the redeploy (the overlay constrains, it never turns the redeploy into
            // a different lifecycle action).
            const snapshot = yield* agentState.getSnapshot();
            let agentProposal: AgentProposal | null =
              findPendingProposal(
                snapshot.pendingProposals,
                overlayPoolAddress,
                proposalMode,
                config.agentProposalStaleMs,
                now,
              ) ?? null;
            let proposalSource: "queue" | "sync" | undefined = agentProposal ? "queue" : undefined;

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
                hasSyncProposalTransport(agentStatus) &&
                getPoolCircuitBreaker(overlayPoolAddress).canTry(now) &&
                !isProposalBackoffActive(proposalBackoff.get(overlayPoolAddress), now) &&
                !latencySkipped
              ) {
                const syncProposal = yield* agent
                  .enhanceDecision(decision, {
                    decision,
                    pool: candidate.pool,
                    metrics: candidate.metrics,
                    warnings: overlayWarnings,
                    recentDecisions: overlayRecentDecisions,
                    hasOpenPosition: overlayHasOpenPosition,
                  })
                  .pipe(
                    // Outer deadline mirrors the tail: a stalled reconnect
                    // must not stall the redeploy pass past the proposal
                    // budget.
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

            if (agentProposal) {
              const proposalToEvaluate: AgentProposal = {
                ...agentProposal,
                ...(agentProposal.originalAction === undefined
                  ? { originalAction: decision.action }
                  : undefined),
                ...(agentProposal.originalConfidence === undefined
                  ? { originalConfidence: decision.confidence }
                  : undefined),
              };
              const validation = evaluateAgentProposal(
                proposalToEvaluate,
                {
                  openPositions,
                  portfolioValueUsd,
                  recentPnlUsd,
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
                } else if (validation.adjustedDecision.action === "ENTER") {
                  idleRedeployLogger.info("Agent proposal applied to idle-redeploy", {
                    source: proposalSource,
                    pool: overlayPoolAddress,
                    to: validation.adjustedDecision.action,
                  });
                  // Follow-up 3655404920: capture the pre-apply decision and flag a
                  // real executable change so a later deterministic risk denial can
                  // penalize the advisor exactly as the in-slot tail does.
                  overlayPreApplyDecision = decision;
                  decision = validation.adjustedDecision;
                  overlayProposalValidated = true;
                  if (
                    decisionChangesExecutableBehavior(
                      overlayPreApplyDecision,
                      decision,
                      config.confidenceThreshold,
                    )
                  ) {
                    overlayAppliedAgentProposal = true;
                  }
                  if (proposalSource === "queue" && agentProposal.proposalId) {
                    overlayAppliedProposalId = agentProposal.proposalId;
                  }
                } else {
                  idleRedeployLogger.info("Agent proposal cancelled idle-redeploy", {
                    source: proposalSource,
                    pool: overlayPoolAddress,
                    to: validation.adjustedDecision.action,
                  });
                  yield* recordRedeploySkip(
                    `[idle-redeploy] [${proposalMode}] agent proposal adjusted to ${validation.adjustedDecision.action} — redeploy cancelled`,
                    `[idle-redeploy] agent proposal adjusted to ${validation.adjustedDecision.action}`,
                  );
                  overlaySkip = true;
                }
              } else {
                // An invalid full/supervised/suggest proposal must not let the
                // redeploy proceed as if unconstrained; arm backoff (mirrors the
                // tail) and skip.
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
              }
            }
          }

          // Supervised mode gates execution on human approval: without an applied
          // approved queued proposal an ENTER (the redeploy) is held — and the
          // redeploy has no HOLD execution path, so a held redeploy is a skip. Same
          // shared predicate the in-slot tail uses.
          if (
            !overlaySkip &&
            shouldHoldForSupervisedApproval(
              config.agentiveMode,
              config.agentProposalMode,
              overlayAppliedProposalId !== undefined,
              decision.action,
            )
          ) {
            idleRedeployLogger.info("Supervised mode: holding idle-redeploy pending approval", {
              pool: overlayPoolAddress,
            });
            yield* recordRedeploySkip(
              `[idle-redeploy] [supervised] awaiting approved proposal — redeploy held (${decision.action})`,
              "[idle-redeploy] supervised mode requires an approved proposal",
            );
            overlaySkip = true;
          }

          // A veto/proposal that forces HOLD means "don't enter"; a defensive
          // non-ENTER override (EXIT/REBALANCE) has no position to act on. The
          // redeploy has nothing to hold or exit, so either is a skip.
          if (!overlaySkip && decision.action !== "ENTER") {
            idleRedeployLogger.info("Idle-redeploy overlay forced non-ENTER — skipping", {
              pool: overlayPoolAddress,
              action: decision.action,
            });
            yield* recordRedeploySkip(
              decision.action === "HOLD"
                ? "[idle-redeploy] vetoed to HOLD by agent overlay — redeploy skipped"
                : `[idle-redeploy] agent overlay adjusted to ${decision.action} — redeploy skipped`,
              decision.action === "HOLD"
                ? "[idle-redeploy] agent overlay forced HOLD"
                : `[idle-redeploy] agent overlay adjusted to ${decision.action}`,
            );
            overlaySkip = true;
          }

          if (overlaySkip) {
            continue;
          }
        }

        // Follow-up 3655404912: apply the SAME bounded allowlisted copy-signal
        // boost the in-slot tail applies before risk evaluation. A redeploy
        // candidate whose base confidence sits just below CONFIDENCE_THRESHOLD
        // must get the same fresh-signal lift as its normal ENTER, or the widened
        // redeploy is rejected on the unboosted confidence while the normal entry
        // is approved. Copy trading disabled → the option is None → zero delta.
        const redeployCopySignalResult =
          copySignalsOption._tag === "Some"
            ? yield* copySignalsOption.value.getBoost(candidate.poolAddress, Date.now())
            : { boost: 0, wallets: [], ignored: 0 };
        if (redeployCopySignalResult.boost > 0 && decision.action !== "EXIT") {
          decision = applyCopySignalBoost(
            decision,
            redeployCopySignalResult,
            config.copySignalsMaxBoost ?? 0.05,
          );
          idleRedeployLogger.info("Applied bounded copy-trading signal boost on idle-redeploy", {
            pool: candidate.poolAddress,
            boost: redeployCopySignalResult.boost,
            wallets: redeployCopySignalResult.wallets.length,
            ignored: redeployCopySignalResult.ignored,
          });
        }

        const riskCtx = {
          openPositions,
          portfolioValueUsd,
          recentPnlUsd,
          poolAddress: candidate.poolAddress,
          activeBinId: candidate.pool.activeBinId,
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
            pool: candidate.poolAddress,
            reason: riskResult.reason,
          });
          yield* alertSvc.sendAlert({
            type: "risk_rejection",
            severity: "warning",
            message: `Risk gate rejected idle-redeploy ENTER on ${candidate.pool.tokenXSymbol}/${candidate.pool.tokenYSymbol}: ${riskResult.reason}`,
            poolAddress: candidate.poolAddress,
            data: { action: "ENTER", reason: riskResult.reason },
          });
          yield* audit
            .recordDecision({
              timestamp: Date.now(),
              cycleId,
              poolAddress: candidate.poolAddress,
              action: "ENTER",
              confidence: decision.confidence,
              reasoning: decision.reasoning,
              metrics: candidate.metrics,
              riskResult,
              executed: false,
              paperTrading: config.paperTrading,
            })
            .pipe(Effect.catch(() => Effect.void));
          // Follow-up 3655404920: mirror the in-slot tail — a deterministic risk
          // denial after an applied full/supervised proposal rejects the queued
          // proposal and arms backoff / circuit breaker, so the same approved
          // low-confidence proposal is not re-selected every eligible cycle.
          const penalizeAppliedProposal = shouldPenalizeAppliedProposalDenial({
            appliedAgentProposal: overlayAppliedAgentProposal,
            preApplyDecision: overlayPreApplyDecision,
            appliedDecision: decision,
            isPreApplyRiskApproved: () =>
              overlayPreApplyDecision !== undefined &&
              risk.evaluate(overlayPreApplyDecision, riskCtx).approved,
          });
          yield* recordAppliedProposalRiskDenial(agentState, {
            penalizeAdvisor: penalizeAppliedProposal,
            appliedQueuedProposalId: overlayAppliedProposalId,
            proposalBackoff,
            recordCircuitFailure: penalizeAppliedProposal
              ? (t) => getPoolCircuitBreaker(candidate.poolAddress).recordFailure(t)
              : undefined,
            poolAddress: candidate.poolAddress,
            now: Date.now(),
            backoff: {
              baseMs: config.agentProposalBackoffBaseMs,
              maxMs: config.agentProposalBackoffMaxMs,
            },
          });
          continue;
        }

        // Follow-up 3655404920: a validated proposal that survives risk is a usable
        // advisor response — clear per-pool backoff and reset the breaker, mirroring
        // the in-slot tail (recordAppliedProposalRiskApproval).
        recordAppliedProposalRiskApproval({
          proposalValidated: overlayProposalValidated,
          proposalBackoff,
          recordCircuitSuccess: () => getPoolCircuitBreaker(candidate.poolAddress).recordSuccess(),
          poolAddress: candidate.poolAddress,
        });

        // P2 (3654054429, widened size): the feature's promise is a WIDER entry on
        // an already-qualified pool. Comparison point is the POST-CAP deposit the
        // redeploy would actually deploy — decision.positionSizeUsd after risk
        // gate 6 caps it (riskResult.adjustedSizeUsd was applied above), not the raw
        // proposed/widened figure. It must STRICTLY EXCEED the candidate's normal
        // entry size; otherwise the pass would open a SMALLER second position that
        // consumes a slot and fragments capital despite the feature being a wider
        // entry. A modeled/unknown size (undefined) fails closed to 0 → skip.
        const finalRedeploySizeUsd = decision.positionSizeUsd ?? 0;
        if (finalRedeploySizeUsd <= candidate.normalEntrySizeUsd) {
          idleRedeployLogger.info("Idle redeploy widened size does not exceed normal entry", {
            pool: candidate.poolAddress,
            finalSizeUsd: finalRedeploySizeUsd,
            normalEntrySizeUsd: candidate.normalEntrySizeUsd,
          });
          yield* recordRedeploySkip(
            `[idle-redeploy] widened size $${finalRedeploySizeUsd.toFixed(2)} does not exceed normal entry $${candidate.normalEntrySizeUsd.toFixed(2)} — skipped`,
            "[idle-redeploy] widened size does not exceed normal entry size",
          );
          continue;
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

        // Token-level execution-failure breaker (Robinhood rule 12): a
        // redeploy is a live ENTER — the same per-leg block gate as the
        // in-slot ENTER path, so a failed EXIT route on another pool holding
        // a shared leg cannot slip idle capital back in this cycle.
        const blockedToken = yield* findBlockedToken(candidate.pool);
        if (blockedToken !== null) {
          const blockLabel =
            blockedToken.kind === "rug" ? "rug/drain block" : "execution-failure block";
          idleRedeployLogger.warn(`Idle redeploy blocked by token ${blockLabel}`, {
            pool: candidate.poolAddress,
            token: blockedToken.mint,
          });
          yield* recordRedeploySkip(
            `[idle-redeploy] [token-block] token ${blockedToken.mint} under ${blockLabel} — redeploy ENTER rejected`,
            `[token-block] token ${blockedToken.mint} under ${blockLabel}`,
          );
          continue;
        }

        // Same entry-shape / range-width resolution the in-slot tail uses.
        const entryStrategyShape: EntryStrategyShape =
          config.entryStrategyType === "auto"
            ? recommendStrategyShape({
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

        // Runner mode (Heart Attack): LAUNCH-lane entries anchor the range
        // below the active bin (a below-market bid ladder that fills on
        // shakeouts) with a tight half-width band. Gated on the decision's
        // lifecycle mode — a standard redeploy ENTER on a radar pool must not
        // inherit the dip shape (it would get neither the launch timebox nor
        // launch exits). Zero offset otherwise.
        const isRunnerLaunchEntry =
          config.launchRunnerModeEnabled === true &&
          decision.positionMode === "launch" &&
          launchScanPools.has(candidate.pool.address);
        const entryDipOffsetBins = isRunnerLaunchEntry
          ? dipOffsetBinsForPct(candidate.pool.binStep, config.launchRunnerDipPct ?? 0.12)
          : 0;
        // Runner width is clamped to the same full-range cap resolveRangeHalfWidth
        // enforces (floor(MAX_REBALANCE_RANGE_BINS / 2)) — the runner override
        // must not bypass the operator's risk cap.
        // The runner band must stay WHOLLY below the active bin: width is
        // clamped to |dip offset| - 1 as well as the range cap — a width
        // larger than the anchor would put the upper bin above market and
        // the forced single-sided-X funding would leave the above-market
        // part unfunded.
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

        let executed = false;
        let executionError: string | undefined = undefined;
        if (config.paperTrading) {
          const paperResult = yield* executePaper(
            {
              db,
              trackedPositions,
              strategy,
              entryStrategyShape,
              entryRangeHalfWidth: effectiveEntryHalfWidth,
              entryDipOffsetBins,
              ...runnerDispatchDeps(decision.poolAddress),
              ...rugDispatchDeps(),
            },
            decision,
            candidate.pool,
            signalTimestamp,
            signalSnapshotId ?? undefined,
          );
          executed = paperResult.executed;
          executionError = paperResult.error;
        } else if (config.autonomousTokenMode === "shadow") {
          // Shadow mode is no-send for live execution. The in-slot tail skips
          // every non-HOLD decision in shadow mode; the redeploy pass must apply
          // the same contract BEFORE dispatching — otherwise a shadow-mode live
          // setup (PAPER_TRADING=false) would fund and open a REAL position
          // through executeLive while the operator believes nothing sends (and
          // the autonomous context would even tag the tx as an autonomous
          // operation). The redeploy has no HOLD execution path, so the
          // shadow-skipped redeploy is a recorded skip, not a paper entry.
          idleRedeployLogger.info("Shadow mode: idle redeploy skipped (no-send)", {
            pool: candidate.poolAddress,
          });
          yield* recordRedeploySkip(
            "[idle-redeploy] skipped — AUTONOMOUS_TOKEN_MODE=shadow blocks live execution (no-send)",
            "[idle-redeploy] shadow mode is no-send for live entries",
          );
          continue;
        } else {
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
              `[idle-redeploy] [paper-validation] ${validation.reason}`,
              validation.reason,
            );
            return;
          }
          // Issue #170: the same batch wallet-reserve gate as the in-slot ENTER
          // path — a redeploy is a live ENTER and must not spend SOL the batch
          // budget cannot cover (the widened size would make it worse). Skip
          // capacity-limited; the next cycle re-evaluates.
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
                  `[idle-redeploy] skipped — free SOL ${budgetHuman} < needed ${neededHuman} (wallet-reserve gate, capacity-limited)`,
                  "[idle-redeploy] wallet SOL reserve insufficient",
                );
                yield* finalizeAppliedProposal(
                  agentState,
                  overlayAppliedProposalId,
                  false,
                  decision.action,
                );
                continue;
              }
              entrySolBudgetLamports -= neededLamports;
            }
          }
          const entryPrep = yield* EntryPrepService;
          const dispatchEntryAprPct = poolFeeAprByAddress.get(decision.poolAddress)?.feeAprPct;
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
              entryRangeHalfWidth: effectiveEntryHalfWidth,
              entryDipOffsetBins,
              runnerSingleSidedX: entryDipOffsetBins !== 0,
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
            signalSnapshotId ?? undefined,
          );
          executed = liveResult.executed;
          executionError = liveResult.error;
          // A live redeploy moved funds out of the wallet: re-read so the rest
          // of the engine sees the post-transaction balance (mirrors the
          // in-slot tail). A failed re-read blocks further entries this cycle,
          // exactly as after a normal live ENTER.
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
          // SOL). Fail closed on read failure: budget 0 blocks further
          // SOL-funded entries this cycle.
          if (solFundedEntryMode) {
            entrySolBudgetLamports = yield* adapter.getNativeSolBalance().pipe(
              Effect.map((lamports) => freeEntrySolLamports(lamports)),
              Effect.catch(() => Effect.succeed(0n)),
            );
            entrySolBudgetKnown = true;
          }
        }

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
        // outcome is final — same helper the in-slot tail uses. A failed execution
        // retains it for retry next cycle.
        yield* finalizeAppliedProposal(
          agentState,
          overlayAppliedProposalId,
          executed,
          decision.action,
        );

        if (executed) {
          cycle.poolsExecuted++;
          recordExecutionOutcome(true);
          sessionEntriesExecuted++;
          idleRedeployLogger.info("Idle capital redeployed", {
            pool: candidate.poolAddress,
            sizeUsd: decision.positionSizeUsd,
            idleCapitalUsd,
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
            cycleId,
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
        // This candidate survived every fresh gate and was dispatched (whether or
        // not the tx landed) — the walk stops here. At most one redeploy ENTER per
        // cycle; a failed execution retries next cycle, not against a sibling.
        return;
      }
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
      const discovered = yield* adapter
        .discoverPoolsTopPages(config.marketScanUniversePages ?? 3)
        .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<DiscoveredPool>)));
      if (discovered.length === 0) {
        logger.warn("Market scan: universe fetch returned nothing — keeping last ranked set");
        return;
      }
      const marketCfg = {
        minTvlUsd: config.marketScanMinTvlUsd ?? 250_000,
        minFeeApr: config.marketScanMinFeeApr ?? 25,
        minHolders: config.marketScanMinHolders ?? 1000,
        minBinStep: config.marketScanMinBinStep ?? 2,
        maxBinStep: config.marketScanMaxBinStep ?? 200,
        stablecoinMints: config.stablecoinMints ?? new Set<string>(),
      };
      const { ranked } = gateAndRankMarketPools(discovered, {
        ...marketCfg,
        minVolumeTurnover: 0.02,
        maxVolumeTurnover: 50,
      });
      marketRankedPools = ranked;
      const activeCount = Math.min(config.marketScanTopK ?? 30, config.marketScanMaxPools ?? 60);
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
      if (discovered.length === 0) {
        logger.warn("Launch radar: hot-pool fetch returned nothing");
        // Fail closed for new launch entries (issue #201 review P2): the
        // executable snapshot could not be refreshed — a stale set must not
        // keep pools executable past their launch age or after they lose the
        // launch gate's base-fee/volume/token-safety qualifications (those
        // predicates are not rechecked by the per-pool decision chain).
        if (config.launchExecutionEnabled === true) {
          launchScanPools.clear();
        }
        return;
      }
      const gateResult = gateAndRankLaunchPools(discovered, {
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
      });
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
      if (config.launchExecutionEnabled === true) {
        launchScanPools.clear();
        for (const r of gateResult.ranked.slice(0, config.launchScanTopK ?? 30)) {
          launchScanPools.add(r.pool.address);
        }
      }
      if (config.launchWashForensicsEnabled === true && adapter.getPoolWashEvidence) {
        // Stale evidence must not outlive its pool: a pool that left the
        // top-K, or a refresh whose fetch failed (null), drops its entry —
        // otherwise an old suspicious flag would gate ENTER forever.
        washEvidenceByPool.clear();
        // Bound both the fetch WIDTH (top-30 by fee yield — the pools most
        // likely to reach ENTER; evidence for the rest fails open) and the
        // CONCURRENCY (5): 200 pools at unbounded concurrency would burst
        // the Helius rate tier and 429 everything to null.
        const topK = gateResult.ranked.slice(0, Math.min(config.launchScanTopK ?? 30, 30));
        const evidences = yield* Effect.forEach(
          topK,
          (r) =>
            adapter.getPoolWashEvidence!(r.pool.address).pipe(
              Effect.catch(() => Effect.succeed(null)),
            ),
          { concurrency: 5 },
        );
        for (let i = 0; i < topK.length; i++) {
          const evidence = evidences[i];
          if (evidence !== null && evidence !== undefined) {
            washEvidenceByPool.set(topK[i]!.pool.address, evidence);
          }
        }
      }
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

  const runScanCycle = (): Effect.Effect<void, never, EntryPrepService> =>
    Effect.gen(function* () {
      coreDataFailuresThisCycle = 0;
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

      let oldestSettlementAgeMs = 0;
      yield* refreshAutonomousCandidates(scanCount);
      yield* refreshFallenAngelCandidates(scanCount);
      yield* refreshMarketUniverse(Date.now());
      yield* refreshLaunchScan(Date.now());
      // The universe refresh may have rebuilt the market top-K — make the
      // fresh active set visible to the "no pools" check and the scan loop.
      rebuildPoolsToScan();
      if (autonomousExecution) {
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
        // settlement job (dead rollback settlements, failed swap-funded
        // entries) into fresh sell jobs, so a token stranded by a terminal
        // settlement gets re-queued automatically. New jobs process this cycle.
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
        // clock the retry scheduling used (settlementNow, captured before the
        // sweep/processing pass) — a retry stamped this cycle (1s/2s/4s
        // backoff for early attempts) must never read as already-past against
        // a fresher Date.now() and classify a freshly backed-off job as stuck.
        oldestSettlementAgeMs = oldestActiveSettlementAgeMs(processedJobs, settlementNow);
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
          // settlements that raised it. #166: once nothing is in flight (429
          // retries finally sold the token, or the orphan sweep recovered
          // it), auto-resolve instead of latching until `prism resume`.
          // #196: a job still PROGRESSING per policy — retryable with a
          // future nextRetryAt, which oldestActiveSettlementAgeMs now
          // excludes — is not overdue either: a sustained rate limit must
          // not halt trading while the scheduled retry waits. The pause
          // stays latched only while a job with NO scheduled retry is
          // genuinely stuck past the max-pending window.
          activeSafetyPause = { ...activeSafetyPause, resolvedAt: settlementNow };
          yield* db.saveSafetyPause(activeSafetyPause).pipe(Effect.catch(() => Effect.void));
        }
        activeSafetyPause = yield* db
          .getSafetyPause(autonomousExecution.walletAddress, autonomousExecution.agentInstanceId)
          .pipe(Effect.catch(() => Effect.succeed(activeSafetyPause)));
      }

      // Issue #182: an armed execution_failures pause must not outlive the
      // failure spike that raised it. Runs at the TOP of the cycle, before
      // any pool is decided — a resolved latch must not block the very cycle
      // that clears it (the daily_drawdown analog resolves per-pool before
      // that pool's decisions for the same reason). The counter is decayed
      // to 0 after every quiet cycle (see the end-of-cycle decay below), so
      // "below the threshold" is the recovery signal for restarts AND
      // mid-run spikes; the end-of-cycle arm block re-arms only when a cycle
      // genuinely breaches again. `prism resume` remains an operator override.
      if (
        autonomousExecution &&
        activeSafetyPause !== null &&
        activeSafetyPause.resolvedAt === null &&
        activeSafetyPause.reason === "execution_failures" &&
        shouldAutoResolveExecutionFailuresPause({
          mode: autonomousExecution.mode,
          consecutiveExecutionFailures,
          maxConsecutiveExecutionFailures: config.maxConsecutiveExecutionFailures,
        })
      ) {
        activeSafetyPause = { ...activeSafetyPause, resolvedAt: Date.now() };
        yield* db.saveSafetyPause(activeSafetyPause).pipe(Effect.catch(() => Effect.void));
      }

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

      // Single chain reconciliation of the wallet value for this cycle. Read
      // ONCE here and reuse for every pool's risk/sizing context — a per-pool
      // read both wasted RPC and let a transient failure blank individual
      // pools. Paper mode (and walletless live) uses the configured paper
      // portfolio as the single source of truth.
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

      // Issue #170: batch wallet-reserve gate — refresh the per-cycle native
      // SOL budget for SOL-funded entries. One read, reused by every ENTER
      // gate this cycle; a failed read leaves the budget UNKNOWN and the gate
      // skips entries fail-closed (never commit SOL the engine cannot confirm).
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

      // Periodic wallet composition log for drift auditability. Native SOL is
      // held by the System Program — not an SPL mint — so getWalletHoldings()
      // omits it. Read it separately and include it so SOL-heavy wallets
      // (including SOL-only wallets, which previously produced no snapshot at
      // all) are fully explained by the drift log.
      if (adapter.hasWallet() && !config.paperTrading && scanCount % 10 === 0) {
        yield* Effect.forkChild(
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
        );
      }

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

      // Idle-capital auto-redeploy pass (opt-in): when idle wallet capital
      // exceeds the threshold and qualified candidates exist, deploy into the
      // top-scored one — routed through the UNCHANGED allocation + risk tail,
      // so caps can reject/shrink but no gate is bypassed. A live-entry block
      // (failed post-tx wallet re-read earlier this cycle) skips the pass so
      // allocation math never runs on a stale balance.
      if (
        config.idleRedeployEnabled &&
        idleRedeployCandidates.length > 0 &&
        !liveEntriesBlockedRestOfCycle
      ) {
        yield* runIdleRedeployPass(idleRedeployCandidates, cycle, executedExitPools);
      }

      consecutiveCoreDataFailures =
        cycle.poolsScanned > 0 && coreDataFailuresThisCycle >= cycle.poolsScanned
          ? consecutiveCoreDataFailures + 1
          : 0;
      // Issue #182: quiet-cycle decay BEFORE the arm evaluates — a cycle with
      // no execution failures resets the consecutive counter, so a stale
      // breach from a previous spike can never re-arm the pause in the same
      // pass the cycle-top resolver cleared it (which would toggle the latch
      // every cycle instead of letting it stay resolved).
      consecutiveExecutionFailures = decayExecutionFailureCounter(
        consecutiveExecutionFailures,
        executionFailuresThisCycle,
      );
      if (autonomousExecution && activeSafetyPause?.resolvedAt !== null) {
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
        let pnl = 0;
        for (const p of trackedPositions.values()) {
          pnl +=
            p.currentValueUsd +
            p.cumulativeFeesClaimedUsd +
            p.cumulativeRewardsClaimedUsd -
            p.depositedUsd;
        }
        yield* Effect.forkChild(postEngineStatus("running", trackedPositions.size, pnl)).pipe(
          Effect.asVoid,
        );
      }

      scanCount += 1;
      yield* maybeSendAgentCheckin("periodic").pipe(Effect.catch(() => Effect.void));
      yield* refreshAgentState();
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

  const evaluatePool = (
    poolAddress: string,
    cycle: AgentCycle,
    idleRedeployCandidates: IdleRedeployCandidate[],
    executedExitPools: Set<string>,
  ): Effect.Effect<ReadonlyArray<AgentDecision>, Error, EntryPrepService> =>
    Effect.gen(function* () {
      const cycleId = cycle.cycleId;
      const rawPool = yield* adapter.getPoolState(poolAddress);
      const binArray = yield* adapter.getBinArray(poolAddress);
      pushBinHistory(poolAddress, rawPool.activeBinId);

      // Real pool stats, resolved datapi (primary) > geckoterminal (secondary)
      // > dexscreener (secondary resilience) > the adapter's fabricated
      // heuristic (last-resort safety net). The chosen source is tagged onto the
      // pool so the volume/fee gates skip heuristic fiction instead of acting on
      // it. The gecko* fee rate is the pool's binStep-derived base fee applied to
      // REAL volume (gecko's own pool_fee_percentage is null for every CL pool,
      // and DexScreener exposes no fee field at all — see
      // gecko-terminal-service.ts / dexscreener-service.ts). DexScreener carries
      // the SAME trust posture as gecko (measured volume/TVL, modeled fees, NO
      // safety signals) and is enriched through the same `enrichPoolFromGecko`
      // path, so no new `statsSource` value ripples through the trust model.
      // Data-API-exclusive safety signals are never sourced from gecko or
      // dexscreener: they stay null and the screener fails open on null.
      const datapiStats = yield* meteoraDatapi.getPoolData(poolAddress);
      // Gecko remains the preferred secondary source (dexscreener is only tried
      // when gecko itself is unavailable) so the two keyless reserves never
      // compete for the same quota.
      const geckoStats =
        datapiStats === null && config.geckoTerminalEnabled !== false
          ? yield* gecko.getPoolStats(poolAddress, 0.0025 + rawPool.binStep / 10_000)
          : null;
      const dexscreenerStats =
        datapiStats === null &&
        geckoStats === null &&
        config.dexscreenerEnabled !== false &&
        dexscreenerOption._tag === "Some"
          ? yield* dexscreenerOption.value.getPoolStats(
              poolAddress,
              0.0025 + rawPool.binStep / 10_000,
            )
          : null;
      const pool =
        datapiStats !== null
          ? enrichPoolWithDatapi(rawPool, datapiStats)
          : geckoStats !== null
            ? enrichPoolFromGecko(rawPool, geckoStats)
            : dexscreenerStats !== null
              ? enrichPoolFromGecko(rawPool, dexscreenerStats)
              : rawPool;

      // ── Market-runner lane ──────────────────────────────────────────────
      // A market-scan pool whose MEASURED (datapi) fee APR clears the runner
      // floor enters with the LAUNCH posture (time-boxed, dip-anchored,
      // scale-in) instead of the flat normal posture — rotating the existing
      // exposure INTO high-yield pools, not adding positions. Modeled gecko /
      // heuristic fees never classify a pool as a runner (the same
      // measured-only exclusion as paper fee accrual).
      const poolFeeAprPct = pool.tvlUsd > 0 ? (pool.fees24hUsd * 365 * 100) / pool.tvlUsd : 0;
      const runnerFloorApr = config.marketScanRunnerMinFeeApr ?? DEFAULT_RUNNER_MIN_FEE_APR;
      const RUNNER_OBS_RING = 4;
      // G1: runner admission + rotation superiority must PERSIST across
      // consecutive above-floor observations — a single-cycle fee spike never
      // qualifies (rule: require meaningful fee production across multiple
      // consecutive observations). The per-pool observation ring lives in the
      // metadata table (`aprob:<pool>`, newest-first, max 4). Fail-open: a
      // metadata read error yields an empty history, so a cold-start pool
      // builds observations before it can qualify.
      const aprObsRaw = yield* db
        .getMetadata(`aprob:${poolAddress}`)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      let aprObs: Array<{ at: number; apr: number }> = [];
      if (aprObsRaw) {
        try {
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
      const runnerConsecutiveCount = consecutiveAboveFloorObservations(
        aprObservations,
        runnerFloorApr,
        obsNow,
        runnerMaxGapMs,
      );
      const isMarketRunner = (addr: string): boolean =>
        isMarketRunnerPool({
          enabled: config.marketScanRunnerEnabled === true,
          marketScanPools,
          poolAddress: addr,
          statsSource: pool.statsSource,
          feeAprPct: poolFeeAprPct,
          runnerMinFeeApr: config.marketScanRunnerMinFeeApr,
        }) && runnerConsecutiveCount >= (config.marketScanRunnerConfirmCycles ?? 2);
      poolFeeAprByAddress.set(poolAddress, { feeAprPct: poolFeeAprPct, tvlUsd: pool.tvlUsd });

      // TVL velocity + IL price-drift need a previous reference point, so the
      // previous snapshot must be read BEFORE persisting the current one.
      const previousSnapshots = yield* db
        .getSnapshots(poolAddress, pool.timestamp - PREVIOUS_SNAPSHOT_WINDOW_MS, pool.timestamp)
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
          poolAddress,
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

      if (datapiStats?.isBlacklisted === true) {
        return yield* rejectForSafety("Meteora Data API flags pool as blacklisted");
      }

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
      // inadmissible — high fees never override a failed safety gate): a
      // leg with an enabled Token-2022 transfer-fee extension is a material
      // market-risk signal. Rejected unless explicitly allowed. Applies to
      // every lane (launch, market runner, fallen-angel, normal) — the
      // market gate separately pre-filters the universe admission.
      if (config.allowTransferFeeTokens !== true) {
        const feeLegs = [
          { mint: pool.tokenX, symbol: pool.tokenXSymbol, auth: authX },
          { mint: pool.tokenY, symbol: pool.tokenYSymbol, auth: authY },
        ];
        const feeChargingLegs = feeLegs.filter((leg) => leg.auth?.transferFeeEnabled === true);
        if (feeChargingLegs.length > 0) {
          return yield* rejectForSafety(
            `leg ${feeChargingLegs
              .map((leg) => leg.symbol)
              .join(", ")} charges a transfer fee (ALLOW_TRANSFER_FEE_TOKENS not enabled)`,
          );
        }
      }

      // Deterministic local rejection precedes any network lookup: a pool
      // whose token or deployer is already in the loaded blacklist rejects
      // here, without consuming the token-risk overlay's fetch budget/timeout.
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

      const freezeEnabledX =
        datapiStats?.tokenXFreezeAuthorityDisabled === false || authX?.freezeAuthority != null;
      const freezeEnabledY =
        datapiStats?.tokenYFreezeAuthorityDisabled === false || authY?.freezeAuthority != null;

      // Per-leg trust exemption: a freeze-enabled leg is exempt when its mint is
      // on the trusted stablecoin allowlist (STABLECOIN_MINTS). The pool is
      // rejected only when a NON-trusted leg has freeze authority enabled. Data
      // API blacklisting above stays fail-closed — the allowlist never exempts it.
      const trustedX = config.stablecoinMints?.has(pool.tokenX) === true;
      const trustedY = config.stablecoinMints?.has(pool.tokenY) === true;
      const untrustedFreezeX = freezeEnabledX && !trustedX;
      const untrustedFreezeY = freezeEnabledY && !trustedY;

      if (freezeEnabledX || freezeEnabledY) {
        if (!untrustedFreezeX && !untrustedFreezeY) {
          // Every freeze-enabled leg is a trusted stablecoin — exempt.
          const exempted = [
            freezeEnabledX && trustedX ? `${pool.tokenXSymbol} (${pool.tokenX})` : null,
            freezeEnabledY && trustedY ? `${pool.tokenYSymbol} (${pool.tokenY})` : null,
          ]
            .filter((s) => s !== null)
            .join(" and ");
          logger.info("Freeze authority exempted via trusted stablecoin allowlist", {
            pool: poolAddress,
            exempted,
          });
        } else {
          // Token-risk overlay (Wave 18): smart detection for UNTRUSTED
          // freeze-enabled legs. LAZY — Jupiter is consulted only when the
          // overlay is enabled (jupiterTokenRiskEnabled !== false) AND an
          // untrusted leg is freeze-enabled. Each flagged leg is adjudicated
          // (isSus is checked BEFORE any exemption — a Jupiter-flagged token is
          // rejected even if the Data API or Jupiter marks it verified, so one
          // spoofed positive cannot cancel the only hard reject):
          //   (a) Jupiter isSus → hard reject (aggregated RugCheck+Blockaid),
          //   (b) Data API is_verified → exempt,
          //   (c) Jupiter isVerified → pass via the overlay,
          //   (d) otherwise the leg is unknown → smart-screening or strict reject.
          // Trusted mints were already exempted above, so this only sees untrusted
          // legs. Every branch logs its provenance; signals are never fabricated.
          type LegStatus = "datapiVerified" | "sus" | "goPlusRisk" | "jupiterVerified" | "unknown";
          const riskByMint: ReadonlyMap<string, TokenRiskSignal> =
            config.jupiterTokenRiskEnabled !== false
              ? yield* Effect.promise(() => consultTokenRisks([pool.tokenX, pool.tokenY], config))
              : new Map<string, TokenRiskSignal>();

          const classifyLeg = (
            flagged: boolean,
            datapiVerified: boolean,
            mint: string,
          ): LegStatus | null => {
            if (!flagged) return null;
            // isSus and GoPlus hard-risk are checked BEFORE any exemption: a
            // flagged token is rejected even if the Data API marks it verified —
            // one spoofed positive must not cancel the only hard rejects.
            const signal = riskByMint.get(mint);
            if (signal?.isSus === true) return "sus";
            if (signal?.goPlusHardRisk != null) return "goPlusRisk";
            if (datapiVerified) return "datapiVerified";
            if (signal?.isVerified === true) return "jupiterVerified";
            return "unknown";
          };

          const flaggedLegs: Array<{ symbol: string; mint: string; status: LegStatus }> = [];
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
          const describe = (legs: ReadonlyArray<{ symbol: string; mint: string }>): string =>
            legs.map((leg) => `${leg.symbol} (${leg.mint})`).join(" and ");

          const susLegs = flaggedLegs.filter((leg) => leg.status === "sus");
          if (susLegs.length > 0) {
            return yield* rejectForSafety(
              `Jupiter token audit flags ${describe(susLegs)} as suspicious (isSus) with freeze authority enabled`,
            );
          }

          const goPlusLegs = flaggedLegs.filter((leg) => leg.status === "goPlusRisk");
          if (goPlusLegs.length > 0) {
            return yield* rejectForSafety(
              `GoPlus token security flags ${describe(goPlusLegs)} as a contract-level risk with freeze authority enabled`,
            );
          }

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
                freezeEnabled: describe(unknownLegs),
              });
              yield* recordSafetyWarning(
                `Freeze authority enabled on ${describe(unknownLegs)} for ${poolAddress}; FREEZE_SMART_SCREENING active — quality pipeline decides`,
              );
            } else {
              return yield* rejectForSafety(
                `Freeze authority enabled on ${describe(unknownLegs)}; add trusted stablecoin mints to STABLECOIN_MINTS to exempt, or set FREEZE_SMART_SCREENING=true`,
              );
            }
          }
        }
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
        .pipe(Effect.catch(() => Effect.succeed([])));
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
            Effect.catch((err) => {
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
                yield* persist(
                  `deletePosition ${pos.positionId}`,
                  db.deletePosition(pos.positionId),
                );
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
        // Fees are trusted ONLY from the Data API (real per-pool fee data).
        // Gecko fees are a binStep base-rate MODEL on real volume
        // (pool_fee_percentage is null for every CL pool) and heuristic fees
        // are fabricated — accrue from neither, so paper positions book only
        // Data-API-measured CLAIM income.
        if (config.paperTrading && pos.positionPubKey == null && pool.statsSource === "datapi") {
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
          if (deltaFeesUsd > 0) {
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
          }
        }
        yield* persist(`savePosition ${pos.positionId}`, db.savePosition(pos));
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
          type: w15Signals.liquidityDrain ? "liquidity_drain" : "stablecoin_depeg",
          severity: "critical",
          message: `Fast EXIT signal on ${pool.tokenXSymbol}/${pool.tokenYSymbol}: ${reasons.join("; ")}`,
          poolAddress,
          data: { ...w15Signals },
        });
      }

      // Launch peak-fee pruning (Launch Mode v2): drop entries whose position
      // closed or left the launch lane (EXIT execution deletes the row from
      // trackedPositions in the decision tail). In-memory only — the time-box
      // exit backstops a restart.
      if (config.launchScanEnabled === true && config.launchExecutionEnabled === true) {
        for (const pid of launchPeakFees1h.keys()) {
          const tracked = trackedPositions.get(pid);
          if (tracked === undefined || tracked.positionMode !== "launch") {
            launchPeakFees1h.delete(pid);
          }
        }
      }

      for (const pos of poolPositions) {
        let decision: AgentDecision | null = null;

        // IL-dominance pre-check: computed once before the exit chain so the
        // else-if below stays a clean boolean. Fires only when IL protection
        // is enabled, the position is actively out of range (fees stopped
        // accruing → pure IL bleed), entry legs are known (pre-v16 rows with
        // NULL legs skip silently = fail-open), and the unrealized IL exceeds
        // cumulative fees by the configured factor and the USD floor.
        let ilDominance: { ilUsd: number; hodlValueUsd: number; feesClaimedUsd: number } | null =
          null;
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
              ilUsd > 0 &&
              ilUsd > feesClaimedUsd * (config.ilDominanceExitFactor ?? 2) &&
              ilUsd > (config.ilDominanceMinUsd ?? 5)
            ) {
              ilDominance = { ilUsd, hodlValueUsd, feesClaimedUsd };
            }
          }
        }

        // ── Fallen-angel lifecycle (Wave 19) ─────────────────────────────
        // A fallen-angel position exits via its TP-ladder (a rung is hit —
        // scale out, close-and-reopen) or its invalidation stop (thesis
        // broken — capital protection at confidence 1). Both are
        // position-targeted deterministic exits and take precedence over the
        // ordinary EXIT chain below.
        let faLifecycle: { status: "tp" | "invalidation"; reasoning: string } | null = null;
        if (config.fallenAngelEnabled === true && pos.positionMode === "fallen-angel") {
          const faLadderParsed = parseTpLadder(pos.tpLadderJson);
          if (faLadderParsed !== null && pos.invalidationStopPrice != null) {
            const faEval = evaluateTpLadder(
              pool.currentPrice,
              faLadderParsed,
              pos.invalidationStopPrice,
            );
            if (faEval.status === "invalidation") {
              faLifecycle = {
                status: "invalidation",
                reasoning: `[fa-invalidation] Price ${pool.currentPrice.toFixed(6)} <= invalidation stop ${pos.invalidationStopPrice.toFixed(6)} — thesis broken`,
              };
            } else if (faEval.status === "tp" && faEval.rungReached) {
              faLifecycle = {
                status: "tp",
                reasoning: `[fa-tp-ladder] Price ${pool.currentPrice.toFixed(6)} reached target ${faEval.rungReached.targetPrice.toFixed(6)} — scale out ${(faEval.scaleOutFraction ?? 0) * 100}%`,
              };
            }
          }
        }

        // ── Normal-lane take-profit (winrate fix) ────────────────────────
        // A normal (non-FA) position that carries a single-rung TP ladder
        // exits deterministically when price reaches its rung — profits lock
        // BEFORE the loss-side exits below. Only the "tp" status acts here;
        // the downside stays owned by the trailing stop / loss-side exits
        // (the ladder's invalidation leg is the trailing-stop pct, but its
        // "invalidation" status deliberately fires nothing here — the
        // ordinary EXIT chain already covers it). Position-targeted,
        // confidence 1, same precedence as the FA/launch lifecycles.
        let tpTargetLifecycle: { reasoning: string } | null = null;
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
              tpTargetLifecycle = {
                reasoning: `[tp-target] Price ${pool.currentPrice.toFixed(6)} reached target ${tpEval.rungReached.targetPrice.toFixed(6)} — take profit`,
              };
            }
          }
        }

        // ── Launch lifecycle (Launch Mode v2) ─────────────────────────────
        // A launch position exits via launchPositionExit: time-box, 1h-fee
        // volume-decay, peak-value drawdown, fee/IL floor (pure policy in
        // launch-position.ts). Current 1h fees are MEASURED datapi only —
        // feeTvlRatio1h is the identical Data-API 1h fee/TVL ratio the launch
        // gate's feeYield1hPct mirrors, and the statsSource === "datapi"
        // guard enforces the fee-purity rule (gecko/heuristic → null, and a
        // null current fee never fires volume-decay). Position-targeted
        // deterministic exit with the same precedence as the FA lifecycle.
        let launchLifecycle: { reasoning: string } | null = null;
        if (
          // Launch exits run whenever a stored position is a launch position —
          // INDEPENDENT of the entry flags: an operator disabling the lane
          // must not silently remove the time-box/decay/drawdown protection
          // from positions that are already open.
          pos.positionMode === "launch"
        ) {
          const now = Date.now();
          const currentFees1hUsd =
            pool.statsSource === "datapi" &&
            datapiStats !== null &&
            datapiStats.feeTvlRatio1h !== null &&
            Number.isFinite(datapiStats.feeTvlRatio1h) &&
            pool.tvlUsd > 0
              ? (datapiStats.feeTvlRatio1h / 100) * pool.tvlUsd
              : null;
          if (currentFees1hUsd === null) {
            // Data-starved decay guard: the volume-decay rule needs MEASURED
            // datapi 1h fees. A non-datapi stats source (gecko/heuristic —
            // the Data API is down) is a protection-reducing outage for an
            // open launch position: warn per position (bounded: ≤ launch
            // slot count). Datapi-up-but-window-missing (a young zero-fee
            // pool or tvl <= 0) is routine — debug only.
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
          const prevPeak = launchPeakFees1h.get(pos.positionId);
          if (
            currentFees1hUsd !== null &&
            (prevPeak === undefined || currentFees1hUsd > prevPeak)
          ) {
            launchPeakFees1h.set(pos.positionId, currentFees1hUsd);
          }
          const peakFees1hUsd = launchPeakFees1h.get(pos.positionId) ?? null;
          const launchExitEval = launchPositionExit({
            createdAtMs: pos.timestamp,
            now,
            timeboxHours: config.launchTimeboxHours ?? 6,
            volumeDecayExitPct: config.launchVolumeDecayExitPct ?? 0.1,
            // Runner mode uses the shakeout-tolerant drawdown (a -15% intra-
            // hour shakeout is the fill, not the crash); otherwise the crash
            // calibration applies.
            drawdownPct:
              pos.launchRunner === true
                ? (config.launchRunnerDrawdownPct ?? 0.25)
                : (config.launchExitDrawdownPct ?? 0.25),
            currentFees1hUsd,
            peakFees1hUsd,
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
          if (launchExitEval.exit) {
            // The peak is NOT deleted here: the exit decision may still be
            // blocked downstream (approval gate, risk gate, execution) — the
            // peak stays until the position actually closes (see the
            // launchPeakFees1h prune in the close path).
            const launchReason = launchExitEval.reason ?? "exit";
            let detail = "";
            if (launchReason === "timebox") {
              detail = `age ${((now - pos.timestamp) / 3.6e6).toFixed(1)}h >= ${config.launchTimeboxHours ?? 6}h`;
            } else if (launchReason === "volume-decay") {
              detail = `1h fees $${(currentFees1hUsd ?? 0).toFixed(2)} < ${(config.launchVolumeDecayExitPct ?? 0.1) * 100}% of peak $${(peakFees1hUsd ?? 0).toFixed(2)}`;
            } else if (launchReason === "drawdown") {
              detail = `value $${pos.currentValueUsd.toFixed(2)} <= ${(1 - (pos.launchRunner === true ? (config.launchRunnerDrawdownPct ?? 0.25) : (config.launchExitDrawdownPct ?? 0.25))) * 100}% of peak $${(pos.highestValueUsd ?? 0).toFixed(2)}`;
            } else if (launchReason === "fee-il") {
              detail = `fee/IL ${metrics.feeIlRatio.toFixed(2)} < 0.5`;
            }
            launchLifecycle = { reasoning: `[launch-${launchReason}] ${detail}` };
          } else if (
            // ── Runner scale-in (Heart Attack step 2) ────────────────────────
            // The dip band TRACKS the falling price: when the price falls a
            // full step below the band's anchor, re-anchor at dip% below the
            // NEW price and top up with fresh quote capital via the atomic
            // rebalance (redeposits the mixed basket + top-up in one tx,
            // preserving the position pubkey). Runs only when the exit did NOT
            // fire this cycle — never scale into a dying position. Attached to
            // the INNER exit-if (this position's launch lifecycle), not the
            // outer launch-mode gate — otherwise it would run for non-launch
            // positions, which never carry launchRunner.
            pos.launchRunner === true &&
            config.launchRunnerScaleInEnabled !== false
          ) {
            const scaleInDecision = shouldScaleInRunner({
              anchorPrice: pos.launchRunnerAnchorPrice ?? 0,
              currentPrice: pool.currentPrice,
              stepPct: config.launchRunnerScaleInStepPct ?? 0.05,
              steps: pos.launchRunnerSteps ?? 0,
              maxSteps: config.launchRunnerScaleInMaxSteps ?? 3,
            });
            if (scaleInDecision.scale && pos.positionPubKey !== null) {
              // Per-pool allocation headroom: a scale-in ADDS new capital to
              // the pool's aggregate exposure — the same cap the risk tail
              // applies to entries.
              const poolExposureUsd = Array.from(trackedPositions.values())
                .filter((p) => p.poolAddress === poolAddress)
                .reduce((sum, p) => sum + p.currentValueUsd, 0);
              const portfolioValueUsd =
                lastWalletBalanceUsd +
                Array.from(trackedPositions.values()).reduce(
                  (sum, p) => sum + p.currentValueUsd,
                  0,
                );
              const poolCapUsd = Math.max(
                0,
                (config.maxPerPoolAllocationPct ?? 0.4) * portfolioValueUsd - poolExposureUsd,
              );
              const topUpUsd = scaleInTopUpUsd({
                walletUsd: lastWalletBalanceUsd,
                sizePct: config.launchRunnerScaleInSizePct ?? 0.25,
                poolCapUsd,
                maxTopUpUsd: config.launchPositionMaxSizeUsd ?? 100,
              });
              const tokenXDecimals = yield* adapter
                .getTokenDecimals(pool.tokenX)
                .pipe(Effect.catch(() => Effect.succeed(null)));
              // Live price only — a hardcoded fallback must never size a
              // top-up (useFallback: false; an unavailable price tops out at
              // 0 and the top-up is skipped).
              const priceX = (yield* adapter
                .getTokenPrices([pool.tokenX], { useFallback: false })
                .pipe(Effect.catch(() => Effect.succeed(EMPTY_TOKEN_PRICES))))[pool.tokenX];
              const topUpAtomicX =
                tokenXDecimals !== null && priceX != null && priceX > 0
                  ? BigInt(Math.floor((topUpUsd / priceX) * 10 ** tokenXDecimals))
                  : 0n;
              if (topUpUsd >= 5 && topUpAtomicX > 0n) {
                // Reserve the SOL the top-up costs (autonomous canary/live
                // swaps SOL for a non-SOL quote leg): skip — never force —
                // when the batch budget cannot cover it, exactly like ENTER.
                const solCostLamports = solFundedEntryMode
                  ? estimateEntrySolLamports({
                      positionSizeUsd: topUpUsd,
                      solPriceUsd: config.solPriceUsd,
                      poolHasSolLeg: pool.tokenX === SOL_MINT || pool.tokenY === SOL_MINT,
                      solFunded: true,
                    })
                  : 0n;
                if (solCostLamports > 0n && entrySolBudgetLamports < solCostLamports) {
                  logger.info("Runner scale-in skipped — SOL budget insufficient", {
                    pool: poolAddress,
                    position: pos.positionId,
                  });
                } else {
                  if (solCostLamports > 0n) entrySolBudgetLamports -= solCostLamports;
                  const dipOffset = dipOffsetBinsForPct(
                    pool.binStep,
                    config.launchRunnerDipPct ?? 0.12,
                  );
                  const runnerWidth = Math.max(
                    1,
                    Math.min(
                      config.launchRunnerHalfWidthBins ?? 5,
                      Math.abs(dipOffset) - 1,
                      Math.floor((config.maxRebalanceRangeBins ?? 100) / 2),
                    ),
                  );
                  // EMIT a position-targeted REBALANCE decision: the normal
                  // executor runs it through risk.evaluate (safety pause),
                  // the agent overlay (veto can HOLD it, supervised requires
                  // approval, full validates) and the paper/live dispatch —
                  // after every exit gate has had its say this cycle.
                  decision = {
                    action: "REBALANCE",
                    poolAddress,
                    positionId: pos.positionId,
                    confidence: 1,
                    reasoning: `[launch-scale-in] ${scaleInDecision.reason ?? "price step reached"}`,
                    rebalanceParams: {
                      newLowerBinId: pool.activeBinId - runnerWidth + dipOffset,
                      newUpperBinId: pool.activeBinId + runnerWidth + dipOffset,
                      slippageBps: config.maxSwapSlippageBps ?? 50,
                      topUp: { amountXAtomic: topUpAtomicX, amountYAtomic: 0n },
                      topUpUsd,
                    },
                  };
                }
              }
            }
          }
        }

        // Economic-exit maturity (forensics-driven, A-slice): the fee/IL and
        // yield-regression EXITs must NOT fire before fees can accrue — the
        // paper forensics showed 33-minute median holds exiting at a loss on
        // temporary IL that then reversed, arming cooldowns that starved the
        // ENTER lane. Capital-protection exits (W15, IL dominance, dust, TVL
        // drop, trailing stop, launch/FA lifecycles) stay age-free.
        const yieldExitMature =
          Date.now() - pos.timestamp >= (config.minYieldExitAgeMs ?? 14_400_000);

        if (faLifecycle) {
          decision = {
            action: "EXIT",
            poolAddress,
            positionId: pos.positionId,
            confidence: 1,
            reasoning: faLifecycle.reasoning,
          };
        } else if (launchLifecycle) {
          decision = {
            action: "EXIT",
            poolAddress,
            positionId: pos.positionId,
            confidence: 1,
            reasoning: launchLifecycle.reasoning,
          };
        } else if (tpTargetLifecycle) {
          decision = {
            action: "EXIT",
            poolAddress,
            positionId: pos.positionId,
            confidence: 1,
            reasoning: tpTargetLifecycle.reasoning,
          };
        } else if (w15Signals.depeg || w15Signals.liquidityDrain) {
          decision = {
            action: "EXIT",
            poolAddress,
            positionId: pos.positionId,
            confidence: 1,
            reasoning: `W15 fast EXIT: ${[
              w15Signals.depeg ? "stablecoin depeg" : null,
              w15Signals.liquidityDrain ? "liquidity drain" : null,
            ]
              .filter(Boolean)
              .join(" + ")}`,
          };
        } else if (ilDominance) {
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
          decision = {
            action: "EXIT",
            poolAddress,
            positionId: pos.positionId,
            confidence: 1,
            reasoning: `IL dominance: $${ilDominance.ilUsd.toFixed(2)} IL exceeds ${config.ilDominanceExitFactor ?? 2}× cumulative fees ($${ilDominance.feesClaimedUsd.toFixed(2)}) while out of range`,
          };
        } else if (
          (config.dustExitUsd ?? 0) > 0 &&
          pos.currentValueUsd < (config.dustExitUsd ?? 0)
        ) {
          // Dust cleanup: a position whose REAL mark fell below the dust
          // threshold is dead capital — it still occupies a per-pool position
          // slot and a risk/allocation budget, but can never pay its way
          // (fees scale with deposited value). Deterministic, position-
          // targeted, confidence 1: reclaim the slot for a real position.
          // Also auto-clears legacy dust positions (e.g. the $0.26 residual
          // entries older builds created by clamping entry size to leftover
          // per-pool headroom). Shadow mode records it; live mode closes it.
          decision = {
            action: "EXIT",
            poolAddress,
            positionId: pos.positionId,
            confidence: 1,
            reasoning: `[dust-cleanup] Position value $${pos.currentValueUsd.toFixed(2)} below $${(config.dustExitUsd ?? 0).toFixed(2)} dust threshold — reclaiming slot`,
          };
          yield* sendAgentAlert(
            "warning",
            "risk_rejected",
            `Dust position closed on ${pool.tokenXSymbol}/${pool.tokenYSymbol}: value $${pos.currentValueUsd.toFixed(2)} below $${(config.dustExitUsd ?? 0).toFixed(2)}`,
            { pool, metrics, position: pos },
          );
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
              .pipe(Effect.catch(() => Effect.void));
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
        } else if (yieldExitMature && metrics.feeIlRatioKnown && feeIlRatio < 0.5) {
          // feeIlRatioUnknown (heuristic) → skip: a fabricated-low ratio must
          // not force an exit. The metric-unavailability warn above logs the skip.
          // Immature positions (age < MIN_YIELD_EXIT_AGE_MS) are exempt: the
          // ratio is near-zero before fees accrue — exiting locks in temporary
          // IL that often reverses (forensics: median 33-min holds, pools that
          // pumped +24-32% within 24h of the paper loss exit).
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
        } else if (
          yieldExitMature &&
          pos.positionMode !== "launch" &&
          pool.statsSource === "datapi" &&
          poolFeeAprPct > 0
        ) {
          // G7 yield-regression: a tracked position whose MEASURED fee APR
          // fell below its entry-time APR × threshold is dead capital — the
          // engine self-heals out of flat majors without waiting for a
          // challenger. Measured (datapi) only; the entry baseline is
          // recorded at ENTER execution (`yieldbase:<positionId>`). Launch
          // positions have their own timebox lifecycle — excluded here.
          const baselineRaw = yield* db
            .getMetadata(`yieldbase:${pos.positionId}`)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          let entryAprPct: number | null = null;
          if (baselineRaw) {
            try {
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
            decision = {
              action: "EXIT",
              poolAddress,
              positionId: pos.positionId,
              confidence: 1,
              reasoning: `[yield-regression] APR ${poolFeeAprPct.toFixed(0)}% < ${(regressionPct * 100).toFixed(0)}% of entry ${entryAprPct.toFixed(0)}%`,
            };
          }
        }

        // Trailing exit (profit protection)
        if (!decision) {
          const estimatedValue = pos.currentValueUsd;
          const highest = pos.highestValueUsd ?? pos.depositedUsd;
          const drawdown = highest > 0 ? (highest - estimatedValue) / highest : 0;
          const breached = drawdown > config.trailingStopPct;
          const breaches = breached ? (trailingStopBreachCount.get(pos.positionId) ?? 0) + 1 : 0;
          if (breached) trailingStopBreachCount.set(pos.positionId, breaches);
          else trailingStopBreachCount.delete(pos.positionId);
          // #153: a single noisy snapshot (unstable tracked-peak/value) must
          // not fire EXIT — require the breach to persist across consecutive
          // cycles so phantom triggers churn into nothing instead of EXITs.
          if (breached && breaches >= config.trailingStopConfirmCycles) {
            decision = {
              action: "EXIT",
              poolAddress,
              positionId: pos.positionId,
              confidence: 0.8,
              reasoning: `Trailing stop: value dropped ${(drawdown * 100).toFixed(1)}% from peak $${highest.toFixed(2)} (${breaches}/${config.trailingStopConfirmCycles} cycles)`,
            };
            yield* sendAgentAlert(
              "critical",
              "trailing_stop",
              `Trailing stop triggered on ${pool.tokenXSymbol}/${pool.tokenYSymbol}: value dropped ${(drawdown * 100).toFixed(1)}% from peak $${highest.toFixed(2)} (confirmed ${breaches} cycles)`,
              { pool, metrics, position: pos },
            );
          } else if (!breached) {
            // Only a genuinely non-breaching cycle emits the large-pnl warning;
            // a breached-but-unconfirmed cycle is on the path to a trailing-stop
            // EXIT and the confirmed critical alert — no warning spam first.
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
          } else if (isLowYieldExit) {
            // Fee density is trusted ONLY from the Data API (the only source
            // of measured per-pool fees — same precedent as the paper fee
            // accrual gate above). Gecko fees are a binStep base-rate MODEL
            // on real volume and heuristic fees are fabricated, so by repo
            // convention modeled/fabricated numbers get no gate vote: only
            // datapi feeds the density scaling, everything else passes null
            // and keeps the static legacy duration. Deliberately NOT
            // isMeasuredStatsSource(), which would admit gecko.
            const feeDensityPerDay =
              pool.statsSource === "datapi" &&
              pool.tvlUsd > 0 &&
              Number.isFinite(pool.fees24hUsd) &&
              pool.fees24hUsd >= 0
                ? pool.fees24hUsd / pool.tvlUsd
                : null;
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
      const dayRolledOver = dailyBaselineDay !== dayKey;
      if (dayRolledOver) {
        dailyBaselineDay = dayKey;
        dailyBaselineEquityUsd = portfolioValueUsd - realizedTodayUsd;
        yield* persistDailyEquityBaseline(db, dailyBaselineScope, {
          day: dailyBaselineDay,
          equityUsd: dailyBaselineEquityUsd,
        });
      }
      const dailyEquityUsd = portfolioValueUsd;
      dailyDrawdownPct =
        dailyBaselineEquityUsd > 0 && dailyEquityUsd < dailyBaselineEquityUsd
          ? ((dailyBaselineEquityUsd - dailyEquityUsd) / dailyBaselineEquityUsd) * 100
          : 0;
      // Issue #148: a latched daily_drawdown pause must not outlive the
      // condition that raised it. The daily baseline re-seeds on rollover but
      // the pause itself only cleared via `prism resume` — auto-resolve it
      // mode-aware so a fresh-day baseline (or a recovered drawdown) does not
      // leave the agent silently paused. The trigger block below re-arms it
      // when the recomputed drawdown still breaches the threshold.
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
      if (
        autonomousExecution &&
        activeSafetyPause?.resolvedAt !== null &&
        config.maxDailyDrawdownPct > 0 &&
        dailyDrawdownPct >= config.maxDailyDrawdownPct
      ) {
        activeSafetyPause = {
          walletAddress: autonomousExecution.walletAddress,
          agentInstanceId: autonomousExecution.agentInstanceId,
          reason: "daily_drawdown",
          triggeredAt: Date.now(),
          resolvedAt: null,
        };
        yield* db.saveSafetyPause(activeSafetyPause).pipe(Effect.catch(() => Effect.void));
      }
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

        // Runner (Heart Attack): the dip band is deliberately below market —
        // the generic OOR/vol/rebalance machinery would see the position as
        // out-of-range (the active bin sits far above the band) and rebalance
        // it back around the active bin, defeating the ladder before it
        // fills. The launch lifecycle (timebox/volume-decay/drawdown) owns
        // pre-fill runner exits; the trailing stop below stays as a generic
        // safety net.
        const isRunnerPosition = pos.launchRunner === true && pos.positionMode === "launch";

        if (
          !isRunnerPosition &&
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
              .pipe(Effect.catch(() => Effect.void));
          }
          yield* sendAgentAlert(
            "warning",
            "high_volatility",
            `High volatility exit on ${pool.tokenXSymbol}/${pool.tokenYSymbol}: σ=${volatilityStddev.toFixed(2)}, drift=${(driftPct * 100).toFixed(0)}%`,
            { pool, metrics, position: pos },
          );
        } else if (
          !isRunnerPosition &&
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
                    Effect.catch((err) =>
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
              .pipe(Effect.catch(() => Effect.void));
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

      // Recent-bin drift shared by the entry-shape resolution and the
      // idle-redeploy capture (identical expression the shape path used inline).
      const netDriftBins =
        recentBins.length >= 2 ? recentBins[recentBins.length - 1]! - recentBins[0]! : 0;
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
          (metrics.feeIlRatioKnown ? feeIlRatio > evolvedThresholds.minFeeIlRatio * 1.5 : true) &&
          metrics.volumeAuthenticityKnown &&
          volumeAuth > 0.8 &&
          metrics.binUtilizationKnown &&
          binUtilization > 0.4 &&
          pool.tvlUsd > config.minPoolTvlUsd * 2
        ) {
          const entryScore = weightedEntryScore(momentumMetrics, signalWeights, {
            referenceBins: config.entryMomentumReferenceBins ?? DEFAULT_MOMENTUM_REFERENCE_BINS,
            scoreWeight: config.entryMomentumScoreWeight ?? DEFAULT_MOMENTUM_SCORE_WEIGHT,
          });
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

      // ── ENTER slot: one per pool per cycle, under the per-pool cap ──────
      // A pool already exiting this cycle never re-enters in the same cycle;
      // the count cap (MAX_POSITIONS_PER_POOL) bounds stacked positions while
      // the allocation gate bounds their aggregate exposure.
      let enterGateRejected = false;
      if (!poolExitFired && poolPositions.length < config.maxPositionsPerPool) {
        if (unresolvedPoolAddresses.has(poolAddress)) {
          logger.warn("Skipping ENTER for unresolved pool", { pool: poolAddress });
          enterGateRejected = true;
        } else if (
          !approvedPoolAddresses.includes(poolAddress) &&
          !autonomousCandidatePools.has(poolAddress) &&
          !marketScanPools.has(poolAddress) &&
          // Launch Mode v2: launch-gated pools are managed pools once the
          // execution lane is enabled (empty set on the default path).
          !launchScanPools.has(poolAddress)
        ) {
          logger.info("Skipping ENTER for unmanaged pool", { pool: poolAddress });
          enterGateRejected = true;
        } else {
          // Fail-closed live-entry gate: until the first SUCCESSFUL chain wallet
          // read lands, the session seed (config.paperPortfolioUsd) is fiction
          // and must not size/authorize a live entry (e.g. during an RPC outage
          // at startup). EXIT is never gated here — capital protection is free.
          if (!config.paperTrading && !walletEverReadSuccessfully) {
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
            enterGateRejected = true;
          }

          // Fail-closed live-entry gate: if a post-transaction wallet re-read
          // failed after a successful LIVE ENTER earlier this cycle, the stale
          // cycle-top balance still counts the deployed capital alongside the
          // already-tracked new position. Serving that to later pools'
          // allocation gates would authorize exposure above the cap, so block
          // further entries until the next cycle re-reads the wallet.
          if (!enterGateRejected && !config.paperTrading && liveEntriesBlockedRestOfCycle) {
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
            enterGateRejected = true;
          }

          const entryBackoff = entryFailureBackoff.get(poolAddress);
          if (!enterGateRejected && entryBackoff && entryBackoff.nextAttemptAt > Date.now()) {
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
            enterGateRejected = true;
          }

          // F7: pool cooldown check — skip ENTER if this pool is on cooldown
          if (!enterGateRejected) {
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
              enterGateRejected = true;
            }
          }

          // Token-level execution-failure breaker (Robinhood rule 12): a
          // genuine live EXIT failure on ANY pool armed `token_block:<mint>`
          // for its legs — new deployment into a blocked token is rejected
          // here, before every specialized ENTER branch (fallen-angel, launch,
          // normal) so no lane can route around it. Fail-closed on a set
          // block; fail-open on metadata read errors.
          if (!enterGateRejected) {
            const blockedToken = yield* findBlockedToken(pool);
            if (blockedToken !== null) {
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
              enterGateRejected = true;
            }
          }

          // ── Fallen-angel ENTER (Wave 19) ───────────────────────────────
          // A pool that cleared the fallen-angel gate (RugCheck security +
          // GeckoTerminal drawdown/vol) enters on the MEAN-REVERSION thesis:
          // the fee-harvesting quality gates below ([fee-il-gate], ×1.5
          // candidate conditions, weighted score) do not apply — a deeply
          // drawn-down token has thin fee/IL by construction. Allocation,
          // token-risk and the risk tail still run verbatim. The decision
          // carries the FA lifecycle (ladder + invalidation) so execution
          // stamps the position row.
          // [wash-forensics] launch ENTER gate — egregious wash evidence
          // (few wallets producing the whole recent sample at bot speed)
          // rejects before capital enters a honeypot's volume. Advisory by
          // default (switch off); the evidence comes from the radar refresh's
          // one Helius call per admitted pool — null (fetch failed, switch
          // off, no sample) fails open and never blocks. Runs BEFORE every
          // specialized ENTER branch (fallen-angel included) so no lane can
          // route around it, and only for actual launch-execution pools —
          // a watchlist/market pool that also appears in the launch top-K is
          // not wash-gated when entering through its own lane.
          const washEvidence = washEvidenceByPool.get(poolAddress);
          if (
            !enterGateRejected &&
            config.launchWashForensicsEnabled === true &&
            config.launchScanEnabled === true &&
            config.launchExecutionEnabled === true &&
            launchScanPools.has(poolAddress) &&
            washEvidence !== undefined &&
            washEvidence.suspicious
          ) {
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
            enterGateRejected = true;
          }

          const faSignal = fallenAngelSignals.get(poolAddress);
          const openFaPositions = Array.from(trackedPositions.values()).filter(
            (p) => p.positionMode === "fallen-angel",
          ).length;
          const faMaxPositions = config.fallenAngelMaxPositions ?? 2;
          if (
            !enterGateRejected &&
            config.fallenAngelEnabled === true &&
            faSignal !== undefined &&
            openFaPositions < faMaxPositions
          ) {
            const faLadder = buildTpLadder(pool.currentPrice, {
              rungs: config.fallenAngelTpRungs ?? [0.15, 0.3, 0.5],
              fractions: config.fallenAngelTpFractions ?? [0.4, 0.3, 0.3],
              invalidationStopPct: config.fallenAngelInvalidationStopPct ?? 0.25,
            });
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
              enterGateRejected = true;
            } else if (faLadder !== null) {
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
              enterGateRejected = true;
            }
          }

          // [drift-gate] negative-drift ENTER rejection — a pool trending DOWN
          // hard (net active-bin drift below MARKET_SCAN_MAX_NEGATIVE_DRIFT_BINS
          // over the recent-bin window) is not a momentum entry; reject BEFORE
          // the candidate conditions so a falling pool cannot clear the
          // fee/IL quality gates on fees earned before the slide. EXEMPT:
          // market-runner entries (the dip-ladder fills ON dips by design) and
          // launch-lane entries (young pools have no bin history to drift);
          // fallen-angel consumed the slot above — its thesis IS post-drawdown
          // entry. Applies to the NORMAL/market lane only.
          if (
            !enterGateRejected &&
            !isMarketRunner(poolAddress) &&
            !launchScanPools.has(poolAddress) &&
            driftGateRejected(
              netDriftBins,
              config.marketScanMaxNegativeDriftBins ?? DEFAULT_MAX_NEGATIVE_DRIFT_BINS,
            )
          ) {
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
            enterGateRejected = true;
          }

          // [fee-il-gate] hard ENTER floor — expected fees must beat IL. Active
          // only when IL protection is enabled. feeIlRatio is never null
          // (0-20, strategy-service.ts) so the numeric compare is fail-closed
          // on 0 for REAL stats; a pool whose fees cannot cover estimated IL
          // never enters. FULL PRINCIPLE — modeled/fabricated fee/IL is EXCLUDED
          // from EVERY ENTER gate when feeIlRatioKnown=false (datapi-only): this
          // hard floor, the ×1.5 candidate requirement below, and the
          // weightedEntryScore fee term all SKIP the modeled ratio. Exclusion,
          // not directional trust: gecko fees are a generic `0.0025 + binStep/1e4`
          // base-rate MODEL (pool_fee_percentage is null for every CL pool) and
          // the Data API exposes per-pool baseFeePct, so the generic model can
          // OVERSTATE a pool's real base fee — the modeled ratio can OVERSTATE
          // economics, so it must not vote in either direction. A gecko pool can
          // still ENTER via the measured candidate conditions below (its volume
          // IS real → volumeAuthenticityKnown=true). A heuristic pool still cannot
          // enter (volume-unknown blocks the candidate gate).
          if (
            !enterGateRejected &&
            config.ilProtectionEnabled === true &&
            metrics.feeIlRatioKnown &&
            feeIlRatio < config.minFeeIlRatio
          ) {
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
            enterGateRejected = true;
          }

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
          if (
            !enterGateRejected &&
            (metrics.feeIlRatioKnown ? feeIlRatio > evolvedThresholds.minFeeIlRatio * 1.5 : true) &&
            metrics.volumeAuthenticityKnown &&
            volumeAuth > 0.8 &&
            metrics.binUtilizationKnown &&
            binUtilization > 0.4 &&
            pool.tvlUsd > config.minPoolTvlUsd * 2
          ) {
            const entryScore = weightedEntryScore(momentumMetrics, signalWeights, {
              referenceBins: config.entryMomentumReferenceBins ?? DEFAULT_MOMENTUM_REFERENCE_BINS,
              scoreWeight: config.entryMomentumScoreWeight ?? DEFAULT_MOMENTUM_SCORE_WEIGHT,
            });
            if (entryScore <= config.weightedEntryScoreThreshold) {
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
              enterGateRejected = true;
            } else {
              // ── Launch ENTER (Launch Mode v2) ─────────────────────────────
              // A launch-gated pool that cleared the FULL chain above (safety
              // screen, [fee-il-gate] floor, measured candidate conditions +
              // weighted score) enters with launch-specific sizing and the
              // time-boxed launch lane. launchMaxOpenPositions is a SEPARATE
              // counter from MAX_OPEN_POSITIONS, but launch entries stay
              // subject to the portfolio-wide cap (issue #201 review P1) —
              // the total of normal + launch positions must never exceed
              // MAX_OPEN_POSITIONS; the per-pool count and per-pool exposure
              // caps (the risk tail) still run verbatim.
              const openLaunchPositions = Array.from(trackedPositions.values()).filter(
                (p) => p.positionMode === "launch",
              ).length;
              const launchMaxOpenPositions = config.launchMaxOpenPositions ?? 3;
              const isLaunchPool =
                (config.launchScanEnabled === true &&
                  config.launchExecutionEnabled === true &&
                  launchScanPools.has(poolAddress)) ||
                isMarketRunner(poolAddress);
              if (isLaunchPool) {
                const totalOpenPositions = trackedPositions.size;
                const portfolioFull = totalOpenPositions >= (config.maxOpenPositions ?? 3);
                if (openLaunchPositions >= launchMaxOpenPositions || portfolioFull) {
                  // Rotation (market-runner lane only): the portfolio is full
                  // and a much hotter runner is available — exit the LOWEST-
                  // APR held position so the freed slot admits the runner next
                  // cycle. This is the "hold high-yield INSTEAD of flat
                  // majors" mechanism: rotating existing exposure, never
                  // adding. The exit is deterministic (confidence 1) and the
                  // ENTER is still consumed this cycle (no exit-and-reenter in
                  // one pass).
                  if (
                    portfolioFull &&
                    config.marketScanRotationEnabled === true &&
                    isMarketRunner(poolAddress)
                  ) {
                    const worst = lowestAprHeldPosition(
                      trackedPositions.values(),
                      poolFeeAprByAddress,
                      poolAddress, // never rotate out of the candidate runner
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
                      const incumbentSizeUsd =
                        incumbentPos?.currentValueUsd ?? incumbentPos?.depositedUsd ?? 100;
                      const runnerSizeUsd = config.launchPositionMaxSizeUsd ?? 100;
                      const shareFor = (sizeUsd: number, tvlUsd: number): number =>
                        tvlUsd > 0 && sizeUsd > 0 ? Math.min(sizeUsd / tvlUsd, 1) : 0;
                      const harvestCostUsd = config.feeCaptureHarvestCostUsd ?? 0.01;
                      const conversionCostPct = config.feeCaptureConversionCostPct ?? 0.05;
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
                          config.marketScanRotationAprMult,
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
                  // Launch cap full: reject the ENTER for this pool — it must
                  // NOT fall through to the normal lane, which would size it
                  // with the uncapped normal entry sizing.
                  yield* audit
                    .recordDecision({
                      timestamp: Date.now(),
                      cycleId,
                      poolAddress,
                      action: "ENTER",
                      confidence: 0,
                      reasoning: `[launch-cap] ${openLaunchPositions} launch positions >= ${launchMaxOpenPositions}`,
                      metrics,
                      riskResult: {
                        approved: false,
                        reason: `[launch-cap] ${openLaunchPositions} >= ${launchMaxOpenPositions}`,
                      },
                      executed: false,
                      paperTrading: config.paperTrading,
                    })
                    .pipe(Effect.catch(() => Effect.void));
                  enterGateRejected = true;
                } else {
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
                    enterGateRejected = true;
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
                      enterGateRejected = true;
                    } else if (!enterGateRejected) {
                      // [token-risk] launch ENTER gate — the same advisory overlay
                      // as the normal lane: blocks when either leg carries a hard
                      // risk signal; unknown/disabled/failed signals never block.
                      if (config.jupiterTokenRiskEnabled !== false) {
                        const launchRisk = yield* Effect.promise(() =>
                          consultTokenRisks([pool.tokenX, pool.tokenY], config),
                        );
                        const launchLegRiskReason = (
                          mint: string,
                          symbol: string,
                        ): string | null => {
                          const signal = launchRisk.get(mint);
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
                        };
                        const launchRiskReasons = [
                          launchLegRiskReason(pool.tokenX, pool.tokenXSymbol),
                          launchLegRiskReason(pool.tokenY, pool.tokenYSymbol),
                        ].filter((reason): reason is string => reason !== null);
                        if (launchRiskReasons.length > 0) {
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
                          enterGateRejected = true;
                        }
                      }
                      if (!enterGateRejected) {
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
                        enterGateRejected = true;
                      }
                    }
                  }
                }
              }

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
                if (config.idleRedeployEnabled) {
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
                    // positionMode: "launch"), so a redeploy entry would get
                    // neither the launch timebox/decay/drawdown protection
                    // nor the runner dip shape. The launch lane's own ENTER
                    // branch owns launch entries.
                    idleRedeployCandidates.push({
                      poolAddress,
                      pool,
                      metrics,
                      entryScore,
                      feeIlRatio,
                      normalEntrySizeUsd: proposedSizeUsd,
                      volatilityStddev,
                      netDriftBins,
                    });
                  }
                }
                enterGateRejected = true;
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
                if (config.jupiterTokenRiskEnabled !== false) {
                  const enterRisk = yield* Effect.promise(() =>
                    consultTokenRisks([pool.tokenX, pool.tokenY], config),
                  );
                  const legRiskReason = (mint: string, symbol: string): string | null => {
                    const signal = enterRisk.get(mint);
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
                  };
                  const riskReasons = [
                    legRiskReason(pool.tokenX, pool.tokenXSymbol),
                    legRiskReason(pool.tokenY, pool.tokenYSymbol),
                  ].filter((reason): reason is string => reason !== null);
                  if (riskReasons.length > 0) {
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
                    enterGateRejected = true;
                  }
                }

                if (!enterGateRejected) {
                  const positionSizeUsd = allocation.adjustedDepositUsd;
                  // Normal-lane take-profit (winrate fix): when enabled, every
                  // normal ENTER carries a single-rung TP ladder at
                  // TAKE_PROFIT_PCT above entry; the invalidation leg uses the
                  // existing trailing-stop pct (the normal lane's downside rule).
                  const tpLadder =
                    (config.takeProfitEnabled ?? false) === true
                      ? buildTpLadder(pool.currentPrice, {
                          rungs: [config.takeProfitPct ?? 0.15],
                          fractions: [1],
                          invalidationStopPct: config.trailingStopPct ?? 0.1,
                        })
                      : null;
                  rawDecisions.push({
                    action: "ENTER",
                    poolAddress,
                    // Momentum boost: positive drift earns up to
                    // ENTRY_MOMENTUM_CONF_BOOST on the static base confidence
                    // (negative → 0), still capped at 0.85. Runner/launch lanes
                    // keep the static formula — this is the normal lane only.
                    confidence: normalEntryConfidence(feeIlRatio, netDriftBins, {
                      referenceBins:
                        config.entryMomentumReferenceBins ?? DEFAULT_MOMENTUM_REFERENCE_BINS,
                      confBoost: config.entryMomentumConfBoost ?? DEFAULT_MOMENTUM_CONF_BOOST,
                    }),
                    reasoning: `Strong pool: Fee/IL ${feeIlRatio.toFixed(2)}, auth ${volumeAuth.toFixed(2)}, TVL $${pool.tvlUsd.toFixed(0)}`,
                    positionSizeUsd,
                    ...(tpLadder !== null
                      ? {
                          tpLadderJson: serializeTpLadder(tpLadder.ladder) ?? undefined,
                          invalidationStopPrice: tpLadder.invalidationPrice,
                        }
                      : undefined),
                  });
                  // Idle-redeploy capture: the pool passed every in-slot gate
                  // (conditions, score, allocation, token-risk), so it is a
                  // fully-vetted candidate whether or not this ENTER executes
                  // — a second position on the same pool (Wave 10) or a
                  // risk-tail rejection both leave idle capital deployable.
                  if (config.idleRedeployEnabled && !isLaunchPool) {
                    // Same exclusion as the launch-branch capture: a launch
                    // pool must never enter through the standard redeploy lane.
                    idleRedeployCandidates.push({
                      poolAddress,
                      pool,
                      metrics,
                      entryScore,
                      feeIlRatio,
                      normalEntrySizeUsd: positionSizeUsd,
                      volatilityStddev,
                      netDriftBins,
                    });
                  }
                }
              }
            }
          }
        }
      }

      // Idle-redeploy capture: the per-pool position cap skipped the ENTER
      // slot entirely. A pool that still passes the candidate conditions +
      // score keeps the pass's ranking honest; dispatch is structurally
      // impossible this cycle (the cap did not move — allocation gate and risk
      // gate 3a re-run and re-reject verbatim), so no skipped gate can bite.
      if (
        config.idleRedeployEnabled &&
        !poolExitFired &&
        poolPositions.length >= config.maxPositionsPerPool &&
        !unresolvedPoolAddresses.has(poolAddress) &&
        (approvedPoolAddresses.includes(poolAddress) || marketScanPools.has(poolAddress))
      ) {
        // isLaunchPool is scoped to the ENTER branch above — recompute the
        // launch-lane membership for this capture site.
        const redeployPoolIsLaunch =
          config.launchScanEnabled === true &&
          config.launchExecutionEnabled === true &&
          launchScanPools.has(poolAddress);
        const redeployCandidate = evaluateIdleRedeployCandidate();
        if (redeployCandidate && !redeployPoolIsLaunch) {
          idleRedeployCandidates.push(redeployCandidate);
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
              netDriftBins,
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
                    now - (vetoWarningThrottle.get(poolAddress) ?? 0) > config.agentProposalStaleMs;
                  if (vetoWarnEligible) {
                    vetoWarningThrottle.set(poolAddress, now);
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
              decision = enhanced;
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
              } else if (!poolCircuitBreaker.canTry(now)) {
                logger.info("Agent proposal circuit breaker open — skipping sync", {
                  pool: poolAddress,
                });
              } else if (isProposalBackoffActive(proposalBackoff.get(poolAddress), now)) {
                logger.info("Agent proposal sync skipped — backoff active", {
                  pool: poolAddress,
                });
              } else {
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
                } else {
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
                    agentProposal = syncProposal;
                    proposalSource = "sync";
                  } else if (syncProposal === null) {
                    // Real transport attempt returned null (parse/timeout/etc.).
                    syncFetchFailed = true;
                  }
                }
              }
            }

            if (agentProposal) {
              const poolBackoff = proposalBackoff.get(poolAddress);
              const proposalToEvaluate = {
                ...agentProposal,
                ...(agentProposal.originalAction === undefined
                  ? { originalAction: decision.action }
                  : undefined),
                ...(agentProposal.originalConfidence === undefined
                  ? { originalConfidence: decision.confidence }
                  : undefined),
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
                    .pipe(Effect.catch(() => Effect.void));

                  proposalBackoff.delete(poolAddress);
                  poolCircuitBreaker.recordSuccess();

                  if (proposalSource === "queue" && agentProposal.proposalId) {
                    yield* agentState
                      .dequeueProposals([agentProposal.proposalId])
                      .pipe(Effect.catch(() => Effect.void));
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
                  // Preserve the launch lane marker: an advisor that echoes or
                  // resizes a launch ENTER must not silently drop positionMode
                  // — the launch timebox/decay/drawdown exits key off it.
                  if (preApplyDecision.positionMode !== undefined && decision.action === "ENTER") {
                    decision = { ...decision, positionMode: preApplyDecision.positionMode };
                  }
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
                  .pipe(Effect.catch(() => Effect.void));
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
                  .pipe(Effect.catch(() => Effect.void));

                if (proposalSource === "queue" && agentProposal.proposalId) {
                  yield* agentState
                    .rejectProposal(agentProposal.proposalId)
                    .pipe(Effect.catch(() => Effect.void));
                }
                yield* agentState
                  .setAgentPolicy({ lastProposalAt: now })
                  .pipe(Effect.catch(() => Effect.void));
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
                .pipe(Effect.catch(() => Effect.void));
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

        const copySignalResult =
          copySignalsOption._tag === "Some"
            ? yield* copySignalsOption.value.getBoost(poolAddress, Date.now())
            : { boost: 0, wallets: [], ignored: 0 };
        if (copySignalResult.boost > 0 && decision.action !== "EXIT") {
          decision = applyCopySignalBoost(
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
          const pendingCooldown = yield* resolveExitCooldown(decision, pos);
          if (pendingCooldown) {
            yield* db.setPoolCooldown(pendingCooldown).pipe(Effect.catch(() => Effect.void));
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
          .pipe(Effect.catch(() => Effect.succeed(null)));

        // Execute
        let executed = false;
        let executionError: string | undefined = undefined;
        let executionSkipped = false;

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
            netDriftBins,
          });
        }
        if (decision.action === "ENTER" && config.volatilityAdaptiveRanges) {
          logger.info(`[adaptive-range] ${poolAddress} halfWidth=${rangeHalfWidth}`, {
            volatilityStddev,
            binStep: pool.binStep,
            configuredBaseHalfWidth: config.entryRangeHalfWidthBins,
          });
        }

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
        if (!config.paperTrading && solFundedEntryMode && decision.action === "ENTER") {
          const entrySizeUsd = decision.positionSizeUsd;
          if (entrySizeUsd !== undefined) {
            const neededLamports = estimateEntrySolLamports({
              positionSizeUsd: entrySizeUsd,
              solPriceUsd: entrySolPriceUsd,
              poolHasSolLeg: hasNativeSolLeg(pool),
              solFunded: true,
            });
            if (!entrySolBudgetKnown || neededLamports > entrySolBudgetLamports) {
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
              continue;
            }
            // Commit the estimate; the budget refreshes from chain after the
            // live mutation (or fails closed on read failure).
            entrySolBudgetLamports -= neededLamports;
          }
        }

        // True when this decision ran through the live executor and therefore
        // may have moved funds wallet<->position; only then do we re-read the
        // wallet so later pools in the same cycle don't double-count capital.
        let movedLiveFunds = false;
        // True only when the live mutation was an ENTER. A failed post-ENTER
        // re-read must block further entries this cycle (the deployed capital
        // is still in the stale balance → double-count); a failed post-EXIT
        // re-read is safe (stale balance under-counts → gates tighten).
        let movedLiveFundsFromEnter = false;
        const autonomousCandidateId = autonomousExecution
          ? [...autonomousCandidates.values()].find(
              (candidate) =>
                candidate.poolAddress === poolAddress &&
                (candidate.state === "eligible" || candidate.state === "entered"),
            )?.id
          : undefined;

        // Runner mode (Heart Attack): LAUNCH-lane ENTERs anchor the range
        // below the active bin (a below-market bid ladder that fills on
        // shakeouts) with a tight half-width band, clamped to the same
        // full-range cap as the normal entry. Zero offset when off or the
        // decision is not a launch entry — the conservative lane is unchanged.
        const isRunnerLaunchEntry =
          config.launchRunnerModeEnabled === true &&
          decision.positionMode === "launch" &&
          (launchScanPools.has(poolAddress) || isMarketRunner(poolAddress));
        const entryDipOffsetBins = isRunnerLaunchEntry
          ? dipOffsetBinsForPct(pool.binStep, config.launchRunnerDipPct ?? 0.12)
          : 0;
        const effectiveEntryHalfWidth = isRunnerLaunchEntry
          ? Math.max(
              1,
              Math.min(
                config.launchRunnerHalfWidthBins ?? 5,
                Math.abs(entryDipOffsetBins) - 1,
                Math.floor((config.maxRebalanceRangeBins ?? 100) / 2),
              ),
            )
          : rangeHalfWidth;

        if (paperExitShouldGoLive) {
          console.warn(
            `[PAPER] PAPER_MODE_EXIT_LIVE is enabled — executing live EXIT for ${poolAddress}`,
          );
          const dispatchEntryAprPct = poolFeeAprByAddress.get(decision.poolAddress)?.feeAprPct;
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
        } else if (config.paperTrading) {
          console.info("[PAPER] Would execute", {
            action: decision.action,
            pool: poolAddress,
          });
          const dispatchEntryAprPct = poolFeeAprByAddress.get(decision.poolAddress)?.feeAprPct;
          const paperResult = yield* executePaper(
            {
              db,
              trackedPositions,
              strategy,
              entryStrategyShape,
              entryRangeHalfWidth: effectiveEntryHalfWidth,
              entryDipOffsetBins,
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
        } else if (config.autonomousTokenMode === "shadow" && decision.action !== "HOLD") {
          executionSkipped = true;
        } else {
          const dispatchEntryAprPct = poolFeeAprByAddress.get(decision.poolAddress)?.feeAprPct;
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
        }

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

        if (executed && decision.action === "ENTER" && autonomousExecution) {
          const candidate = [...autonomousCandidates.values()].find(
            (item) => item.poolAddress === poolAddress && item.state === "eligible",
          );
          if (candidate) {
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
          }
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
            !(
              decision.action === "ENTER" &&
              solFundedEntryMode &&
              isInsufficientTokenBalanceError(executionError)
            )
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
            if (decision.action === "EXIT" && !config.paperTrading) {
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
            }
          }
        }
        if (executed && decision.action === "EXIT") {
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
            yield* db.saveTokenCandidate(coolingCandidate).pipe(Effect.catch(() => Effect.void));
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
          // Follow-up 3655404934: the candidate captured this pool's normal entry
          // size BEFORE the overlay; `full` mode can enlarge and execute it. Sync
          // the FINAL executed size (post-overlay, post-risk-cap) back onto the
          // candidate so the redeploy widened-size guard compares against the
          // position really opened, not a stale pre-overlay figure.
          const executedSizeUsd = decision.positionSizeUsd;
          if (executedSizeUsd !== undefined) {
            const redeployCandidate = idleRedeployCandidates.find(
              (c) => c.poolAddress === poolAddress,
            );
            if (redeployCandidate) redeployCandidate.normalEntrySizeUsd = executedSizeUsd;
          }
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
          .pipe(Effect.catch(() => Effect.void));

        // Threshold evolution: increment counter on EXIT, try evolve at interval
        if (decision.action === "EXIT" && executed) {
          yield* incrementEvolutionCount.pipe(Effect.catch(() => Effect.void));
          yield* tryEvolveThresholds.pipe(Effect.catch(() => Effect.void));
        }

        if (
          executed &&
          (decision.action === "ENTER" ||
            decision.action === "EXIT" ||
            decision.action === "REBALANCE")
        ) {
          const trigger = decision.action.toLowerCase() as AgentRuntimeCheckin["trigger"];
          yield* maybeSendAgentCheckin(trigger).pipe(Effect.catch(() => Effect.void));
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
          }

          // G4 economic harvest gate (rule: never spend $0.80 to realize
          // $1.00): skip the on-chain swap-fee claim when the PENDING net
          // fees are below the floor or the estimated tx cost exceeds the
          // allowed fraction of gross. Pending amount unavailable (adapter
          // without getClaimableFeesUsd / unpriceable legs / read failure)
          // -> FAIL OPEN, claim anyway (fee capture is protective). A
          // skipped claim does NOT re-arm lastFeeClaimAt — it retries next
          // scan, same semantics as the zero-fee claim path. Paper accrual
          // never reaches here (no positionPubKey on paper positions).
          const harvestGate = adapter.getClaimableFeesUsd
            ? yield* adapter.getClaimableFeesUsd(poolAddress, pos.positionPubKey).pipe(
                Effect.map((netUsd) => evaluateHarvestGate(netUsd, config)),
                Effect.catch(() =>
                  Effect.succeed({
                    approved: true,
                    reason: "[harvest-gate] pending read failed — fail open (claim anyway)",
                  }),
                ),
              )
            : null;
          if (harvestGate && !harvestGate.approved) {
            console.warn(
              `[harvest-gate] claim skipped on ${poolAddress} (${pos.positionId}): ${harvestGate.reason}`,
            );
            continue;
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
          if (!result || (result.feeX === 0 && result.feeY === 0)) {
            continue;
          }

          // Mint-based net-fee USD from the adapter; null → 0 fails the
          // compound gate closed (see convertClaimFeesToUsd deprecation).
          const netFeesUsd = result.netFeesUsd ?? 0;

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
            .pipe(Effect.catch(() => Effect.void));

          if (
            result.platformFeeX > 0 ||
            result.platformFeeY > 0 ||
            (result.operatorFeeX ?? 0) > 0 ||
            (result.operatorFeeY ?? 0) > 0
          ) {
            yield* Effect.forkChild(
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

          yield* alertSvc.recordFeeClaim(poolAddress, netFeesUsd);

          const feeDestination = config.feeDestination ?? "compound";
          if (feeDestination !== "compound") {
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
            continue;
          }

          // F3: fee compounding — if AUTO_COMPOUND_FEES is on and the net fees
          // cleared the cost threshold, redeposit them into the same range.
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
        }
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
    let pnl = 0;
    for (const p of trackedPositions.values()) {
      pnl +=
        p.currentValueUsd +
        p.cumulativeFeesClaimedUsd +
        p.cumulativeRewardsClaimedUsd -
        p.depositedUsd;
    }
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
