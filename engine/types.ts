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
}

export interface PoolMetrics {
  pool: PoolState;
  binArray: BinArray;
  tvlVelocity: number; // % change in TVL over last N intervals
  feeIlRatio: number;
  volumeAuthenticity: number; // 0–1 score
  binUtilization: number; // active bins / total bins
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
  poolAddress?: string;
  outcome?: "profit" | "loss" | "neutral";
  pnlUsd?: number;
  confidence?: number;
  createdAt: number;
  expiresAt: number;
}

// ─── Agent Cycle ──────────────────────────────────────────────────────────────

export interface AgentCycle {
  cycleId: string;
  startedAt: number;
  completedAt?: number;
  poolsScanned: number;
  poolsActioned: number;
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

