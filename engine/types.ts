// ─── Pool & Bin ──────────────────────────────────────────────────────────────

export interface BinData {
  binId: number;
  price: number;
  reserveX: bigint;
  reserveY: bigint;
  liquiditySupply: bigint;
}

export interface BinArray {
  lowerBinId: number;
  upperBinId: number;
  bins: BinData[];
  activeBinId: number;
  binStep?: number;
  /**
   * False when per-bin reserves were NOT fetched from on-chain bin arrays
   * (e.g. the SDK call failed). Metrics must treat bin-derived signals as
   * "unknown" rather than fabricating them. Undefined is treated as known
   * for backward compatibility with stored snapshots and test fixtures.
   */
  reservesKnown?: boolean | undefined;
}

export interface PoolState {
  address: string;
  tokenX: string;
  tokenY: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  tvlUsd: number;
  volume24hUsd: number;
  fees24hUsd: number;
  apr: number;
  activeBinId: number;
  binStep: number;
  currentPrice: number;
  timestamp: number;
  /**
   * Where tvl/volume/fees came from. "datapi" = real Meteora Data API values;
   * "heuristic" = on-chain reserves × price with modeled turnover (fabricated
   * volume/fees). Volume-authenticity is only meaningful for "datapi" stats.
   */
  statsSource?: "datapi" | "heuristic" | undefined;
  /**
   * Whether the pool has an LM farm, from the Data API's `has_farm`. Only set
   * when statsSource is "datapi"; undefined otherwise (unknown).
   */
  hasFarm?: boolean | null | undefined;
  /**
   * Farm reward APR (annualized percent) from the Data API's `farm_apr`.
   * Null/undefined when the pool has no farm or the APR is unknown.
   */
  farmAprPct?: number | null | undefined;
}

export interface PoolSnapshot {
  poolAddress: string;
  timestamp: number;
  activeBinId: number;
  tvlUsd: number;
  volume24hUsd: number;
  fees24hUsd: number;
  apr: number;
  currentPrice: number;
  binStep: number;
  tokenXSymbol: string;
  tokenYSymbol: string;
  binArray: BinArray;
}

export interface PoolMetrics {
  pool: PoolState;
  binArray: BinArray;
  tvlVelocity: number; // % change in TVL over last N intervals
  feeIlRatio: number;
  volumeAuthenticity: number; // 0–1 score (0 when unknown)
  binUtilization: number; // active bins / total bins (0 when unknown)
  /** False when volume/fees are heuristic estimates — auth gates must skip. */
  readonly volumeAuthenticityKnown: boolean;
  /** False when real per-bin reserves were unavailable — util gates must skip. */
  readonly binUtilizationKnown: boolean;
  /**
   * Farm reward APR (annualized percent) for scoring. Null when the pool has
   * no farm or farm status is unknown (heuristic stats); a farm pool with an
   * unknown APR reports 0 (known farm, no current reward rate).
   */
  readonly farmAprPct: number | null;
}

/** Recent price reference used to estimate impermanent loss from drift. */
export interface PriceDriftContext {
  readonly previousPrice?: number | undefined;
  readonly previousTimestamp?: number | undefined;
}

// ─── Signal Staging ──────────────────────────────────────────────────────────

export interface SignalSnapshot {
  readonly poolAddress: string;
  readonly timestamp: number;
  readonly feeIlRatio: number;
  readonly volumeAuthenticity: number;
  readonly binUtilization: number;
  readonly tvlUsd: number;
  readonly tvlVelocity: number;
  readonly volatilityStddev: number;
  readonly binStep: number;
  readonly action: ActionType;
  readonly confidence: number;
}

// ─── Position ────────────────────────────────────────────────────────────────

export interface Position {
  id: string;
  poolAddress: string;
  poolName: string;
  lowerBinId: number;
  upperBinId: number;
  liquidityShares: bigint;
  depositedUsd: number;
  currentValueUsd: number;
  unrealizedPnlUsd: number;
  feesEarnedUsd: number;
  openedAt: number;
}

// ─── Agent Decision ───────────────────────────────────────────────────────────

export type ActionType = "HOLD" | "REBALANCE" | "EXIT" | "ENTER";

// ─── DLMM entry strategy shapes (Meteora StrategyType) ───────────────────────

/**
 * Concrete Meteora DLMM deposit distribution for position creation:
 * - `spot` — uniform across the range (StrategyType.Spot).
 * - `curve` — concentrated around the active bin (StrategyType.Curve); suits
 *   calm, mean-reverting pools.
 * - `bidask` — weighted toward the range edges (StrategyType.BidAsk); suits
 *   trending / one-sided-leaning deployment.
 */
export type EntryStrategyShape = "spot" | "curve" | "bidask";

/**
 * ENTRY_STRATEGY_TYPE config value. `auto` resolves per pool from recent
 * volatility/trend metrics in the decision loop (see recommendStrategyShape);
 * anything else is used as-is. Default: `spot`.
 */
export type EntryStrategyType = EntryStrategyShape | "auto";

/** How a live entry was funded, as executed by the adapter. */
export type EntryDepositMode = "two-sided" | "single-sided-x" | "single-sided-y";

export interface RebalanceParams {
  newLowerBinId: number;
  newUpperBinId: number;
  slippageBps: number;
}

export interface AgentDecision {
  action: ActionType;
  poolAddress: string;
  confidence: number;
  reasoning: string;
  rebalanceParams?: RebalanceParams;
  positionSizeUsd?: number;
}

// ─── Agent Proposals ───────────────────────────────────────────────────────────

export type AgentProposalMode = "veto" | "suggest" | "supervised" | "full";

export interface AgentProposal extends AgentDecision {
  readonly proposalId: string;
  readonly proposedAt: number;
  readonly expiresAt: number;
  readonly source: "sync-prompt" | "http-queue";
  readonly originalAction?: ActionType;
  readonly originalConfidence?: number;
  readonly status: "pending" | "approved" | "rejected" | "executed";
}

export interface AgentPolicySnapshot {
  readonly mode: AgentProposalMode;
  readonly proposalsQueued: number;
  readonly lastProposalAt: number | null;
  readonly badProposalBackoffUntil: number | null;
  readonly circuitBreakerOpen: boolean;
  readonly hardCaps: {
    readonly maxPositionSizePct: number;
    readonly maxRebalanceRangeBins: number;
    readonly minProposalConfidence: number;
    readonly proposalStaleMs: number;
  };
}

export interface ProposalValidationResult {
  readonly valid: boolean;
  readonly reason?: string;
  readonly adjustedDecision?: AgentDecision;
}

// ─── Risk ─────────────────────────────────────────────────────────────────────

export interface RiskResult {
  approved: boolean;
  reason: string;
  adjustedSizeUsd?: number;
}

// ─── Memory ──────────────────────────────────────────────────────────────────

export type MemoryCategory = "pattern" | "warning" | "outcome";

export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  content: string;
  poolAddress?: string | undefined;
  outcome?: "profit" | "loss" | "neutral" | undefined;
  pnlUsd?: number | undefined;
  confidence?: number | undefined;
  createdAt: number;
  expiresAt: number;
}

// ─── Agent Cycle ──────────────────────────────────────────────────────────────

export interface AgentCycle {
  cycleId: string;
  startedAt: number;
  completedAt?: number;
  poolsScanned: number;
  poolsDecided: number;
  poolsExecuted: number;
  poolsFailed: number;
  decisions: AgentDecision[];
  totalGasCostSol: number;
  paperTrading: boolean;
}

// ─── Backtest ─────────────────────────────────────────────────────────────────

export interface BacktestResult {
  poolAddress: string;
  startDate: number;
  endDate: number;
  initialValueUsd: number;
  finalValueUsd: number;
  totalFeesUsd: number;
  totalIlUsd: number;
  netPnlUsd: number;
  totalRebalances: number;
  winRate: number;
  sharpeRatio: number;
}

// ─── Signal Weights (Darwinian weighting) ────────────────────────────────────

export interface SignalWeights {
  readonly feeIlRatio: number;
  readonly volumeAuthenticity: number;
  readonly binUtilization: number;
  readonly tvlUsd: number;
  readonly tvlVelocity: number;
  readonly updatedAt: number;
}

// ─── Pool Cooldown ──────────────────────────────────────────────────────────

export interface PoolCooldown {
  readonly poolAddress: string;
  readonly cooldownUntil: number;
  readonly reason: string;
  readonly consecutiveOorExits: number;
}

// ─── Revenue ────────────────────────────────────────────────────────────────

export interface FeeWalletResponse {
  address: string;
  source: "kv" | "env";
}

export interface RevenueLogRequest {
  poolAddress: string;
  positionPubkey: string;
  feeX: number;
  feeY: number;
  platformFeeX: number;
  platformFeeY: number;
  tier: string;
  txSignature: string;
  userId?: string;
  installId?: string;
}

export interface RevenueLogResponse {
  id: string;
}

export interface RevenueStatsResponse {
  totalEvents: number;
  totalPlatformFeeUsd: number;
  byTier: Record<string, { count: number; totalFeeUsd: number }>;
  recentEvents: Array<{
    id: string;
    poolAddress: string;
    tier: string;
    platformFeeX: number;
    platformFeeY: number;
    createdAt: string;
  }>;
}
