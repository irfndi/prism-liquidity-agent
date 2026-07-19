import { evaluateRisk, type RiskConfig } from "../risk-service.js";
import type { ActionType, AgentDecision, PoolMetrics, Position } from "../types.js";
import type { RiskContext } from "../services.js";

export interface ReplayPosition {
  readonly poolAddress: string;
  readonly lowerBinId: number;
  readonly upperBinId: number;
  readonly depositedUsd: number;
  readonly currentValueUsd: number;
  readonly highestValueUsd: number;
}

export interface ReplayEvaluationInput {
  readonly poolAddress: string;
  readonly activeBinId: number;
  readonly metrics: PoolMetrics;
  readonly position: ReplayPosition | undefined;
  readonly portfolioValueUsd: number;
  readonly recentPnlUsd: number;
  readonly memoryWarningCount: number;
  readonly confidenceThreshold: number;
  readonly trailingStopPct: number;
  readonly risk: RiskConfig;
  readonly proposedSizeUsd: number;
}

export interface ReplayEvaluation {
  readonly decision: AgentDecision;
  readonly riskApproved: boolean;
  readonly riskReason: string;
  readonly adjustedSizeUsd: number;
}

const toRiskPosition = (position: ReplayPosition): Position => ({
  id: position.poolAddress,
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

export function evaluateReplayPool(input: ReplayEvaluationInput): ReplayEvaluation {
  const position = input.position;
  const drawdown = position
    ? Math.max(0, (position.highestValueUsd - position.currentValueUsd) / position.highestValueUsd)
    : 0;
  const action: ActionType =
    position && drawdown > input.trailingStopPct ? "EXIT" : position ? "HOLD" : "ENTER";
  const confidence = Math.max(
    0,
    Math.min(1, 0.75 - input.memoryWarningCount * 0.05 + (input.metrics.farmAprPct ?? 0) / 1000),
  );
  const decision: AgentDecision = {
    action,
    poolAddress: input.poolAddress,
    confidence,
    reasoning:
      action === "EXIT"
        ? `Trailing stop: value dropped ${(drawdown * 100).toFixed(1)}% from peak`
        : action === "ENTER"
          ? "Replay entry passed strategy gates"
          : "Replay position remains within trailing-stop limit",
    ...(action === "ENTER" && { positionSizeUsd: input.proposedSizeUsd }),
  };
  const openPositions = position ? [toRiskPosition(position)] : [];
  const context: RiskContext = {
    openPositions,
    portfolioValueUsd: input.portfolioValueUsd,
    recentPnlUsd: input.recentPnlUsd,
    poolAddress: input.poolAddress,
    activeBinId: input.activeBinId,
  };
  const riskResult = evaluateRisk(input.risk, decision, context);
  return {
    decision,
    riskApproved: riskResult.approved,
    riskReason: riskResult.reason,
    adjustedSizeUsd: riskResult.adjustedSizeUsd ?? input.proposedSizeUsd,
  };
}
