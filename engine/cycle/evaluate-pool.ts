import { evaluateRisk, type RiskConfig } from "../risk-service.js";
import type { ActionType, AgentDecision, PoolMetrics, Position } from "../types.js";
import type { RiskContext } from "../services.js";

export interface ReplayPosition {
  readonly positionPubKey: string;
  readonly poolAddress: string;
  readonly lowerBinId: number;
  readonly upperBinId: number;
  readonly depositedUsd: number;
  readonly currentValueUsd: number;
  readonly highestValueUsd: number;
  /**
   * IL-dominance fast-EXIT inputs, mirroring the live engine's W15 seam. All
   * optional so legacy replay callers (which don't mark a position with IL
   * context) behave exactly as before — the exit simply never fires.
   */
  readonly outOfRange?: boolean;
  /** HODL benchmark value at the current price (see engine/pnl.ts). */
  readonly hodlValueUsd?: number;
  /** Cumulative swap fees claimed over the position's lifecycle (USD). */
  readonly cumulativeFeesClaimedUsd?: number;
}

export interface ReplayEvaluationInput {
  readonly poolAddress: string;
  readonly activeBinId: number;
  readonly metrics: PoolMetrics;
  readonly position: ReplayPosition | undefined;
  readonly openPositions: readonly ReplayPosition[];
  readonly portfolioValueUsd: number;
  readonly recentPnlUsd: number;
  readonly memoryWarningCount: number;
  readonly confidenceThreshold: number;
  readonly trailingStopPct: number;
  readonly risk: RiskConfig;
  readonly proposedSizeUsd: number;
  /** Master switch for the IL-dominance fast EXIT (default false = off). */
  readonly ilProtectionEnabled?: boolean;
  /** Multiply cumulative fees: exit when IL exceeds fees × factor. */
  readonly ilDominanceExitFactor?: number;
  /** Absolute USD floor before the IL-dominance exit may fire. */
  readonly ilDominanceMinUsd?: number;
}

export interface ReplayEvaluation {
  readonly decision: AgentDecision;
  readonly riskApproved: boolean;
  readonly riskReason: string;
  readonly adjustedSizeUsd: number;
  /**
   * Audit tag for the admit/reject census, set only when riskApproved is false.
   * Speaks the live chain's tag vocabulary where the gates overlap
   * ([alloc-gate] for allocation/cap/dust), [risk-gate] otherwise.
   */
  readonly rejectTag?: string;
}

/** Mutable build of a ReplayEvaluation, for conditional reject-tag attachment. */
interface RiskAssessmentBuild {
  decision: AgentDecision;
  riskApproved: boolean;
  riskReason: string;
  adjustedSizeUsd: number;
  rejectTag?: string;
}

function tagRiskRejection(reason: string): string {
  // Allocation, exposure-cap, position-cap, and dust rejections map to the live
  // [alloc-gate] audit tag so the replay census groups identically to the live
  // chain; the replay kernel's other rejections (confidence, drawdown,
  // stop-loss, non-finite data) have no live ENTER-tag equivalent and get the
  // generic [risk-gate].
  return /allocat|exposure|position cap|open positions|entry size|headroom/i.test(reason)
    ? "[alloc-gate]"
    : "[risk-gate]";
}

const toRiskPosition = (position: ReplayPosition): Position => ({
  id: position.positionPubKey,
  poolAddress: position.poolAddress,
  poolName: position.poolAddress,
  lowerBinId: position.lowerBinId,
  upperBinId: position.upperBinId,
  liquidityShares: 0n,
  depositedUsd: position.depositedUsd,
  currentValueUsd: position.currentValueUsd,
  unrealizedPnlUsd: position.currentValueUsd - position.depositedUsd,
  feesEarnedUsd: 0,
  openedAt: 0,
});

/** W15 IL-dominance seam: reason string when cumulative fees no longer cover
 *  the out-of-range bleed, null otherwise (fail-open on missing inputs). */
function resolveIlDominanceReason(
  position: ReplayPosition | undefined,
  ilEnabled: boolean,
  factor: number,
  minUsd: number,
): string | null {
  if (
    !ilEnabled ||
    position === undefined ||
    position.outOfRange !== true ||
    position.hodlValueUsd === undefined ||
    position.currentValueUsd < 0
  ) {
    return null;
  }
  const ilUsd = position.hodlValueUsd - position.currentValueUsd;
  const feesUsd = position.cumulativeFeesClaimedUsd ?? 0;
  if (ilUsd > 0 && ilUsd > feesUsd * factor && ilUsd > minUsd) {
    return `IL dominance: $${ilUsd.toFixed(2)} IL exceeds ${factor}× cumulative fees ($${feesUsd.toFixed(2)}) while out of range`;
  }
  return null;
}

/** Trailing-stop exit beats HOLD beats ENTER; IL dominance exits first. */
function resolveReplayAction(
  position: ReplayPosition | undefined,
  drawdown: number,
  trailingStopPct: number,
  ilDominanceReason: string | null,
): ActionType {
  if (ilDominanceReason !== null) return "EXIT";
  if (position !== undefined && drawdown > trailingStopPct) return "EXIT";
  if (position !== undefined) return "HOLD";
  return "ENTER";
}

/** Human-readable reasoning mirroring the live engine's decision vocabulary. */
function describeReplayDecision(
  action: ActionType,
  ilDominanceReason: string | null,
  drawdown: number,
): string {
  if (ilDominanceReason !== null) return ilDominanceReason;
  if (action === "EXIT") {
    return `Trailing stop: value dropped ${(drawdown * 100).toFixed(1)}% from peak`;
  }
  if (action === "ENTER") return "Replay entry passed strategy gates";
  return "Replay position remains within trailing-stop limit";
}

export function evaluateReplayPool(input: ReplayEvaluationInput): ReplayEvaluation {
  const position = input.position;

  // ── IL-dominance fast EXIT (W15 seam) ────────────────────────────────────
  // Mirrors the live engine: fires only when IL protection is on, the position
  // is actively out of range (fees stopped accruing → pure bleed), IL is real
  // (HODL > LP value), and it exceeds both cumulative fees × factor and the USD
  // floor. Skipped (fail-open) whenever any input is missing or off  — the
  // default for legacy replay callers.
  const ilEnabled = input.ilProtectionEnabled === true;
  const factor = input.ilDominanceExitFactor ?? 2;
  const minUsd = input.ilDominanceMinUsd ?? 5;
  const ilDominanceReason = resolveIlDominanceReason(position, ilEnabled, factor, minUsd);

  const drawdown = position
    ? Math.max(0, (position.highestValueUsd - position.currentValueUsd) / position.highestValueUsd)
    : 0;
  const action = resolveReplayAction(position, drawdown, input.trailingStopPct, ilDominanceReason);
  const confidence = Math.max(
    0,
    Math.min(1, 0.75 - input.memoryWarningCount * 0.05 + (input.metrics.farmAprPct ?? 0) / 1000),
  );
  const decision: AgentDecision = {
    action,
    poolAddress: input.poolAddress,
    confidence,
    reasoning: describeReplayDecision(action, ilDominanceReason, drawdown),
    ...(action === "ENTER" && { positionSizeUsd: input.proposedSizeUsd }),
  };
  const openPositions = input.openPositions.map(toRiskPosition);
  const context: RiskContext = {
    openPositions,
    portfolioValueUsd: input.portfolioValueUsd,
    recentPnlUsd: input.recentPnlUsd,
    poolAddress: input.poolAddress,
    activeBinId: input.activeBinId,
  };
  const riskResult = evaluateRisk(input.risk, decision, context);
  const result: RiskAssessmentBuild = {
    decision,
    riskApproved: riskResult.approved,
    riskReason: riskResult.reason,
    adjustedSizeUsd: riskResult.adjustedSizeUsd ?? input.proposedSizeUsd,
  };
  if (!riskResult.approved) {
    result.rejectTag = tagRiskRejection(riskResult.reason);
  }
  return result;
}
