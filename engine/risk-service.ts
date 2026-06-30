import { Context, Layer } from "effect";
import { RiskService, type RiskApi, type RiskContext, type RiskResult } from "./services.js";
import type { AgentDecision } from "./types.js";

export interface RiskConfig {
  readonly confidenceThreshold: number;
  readonly maxConcurrentPositions: number;
  readonly maxRebalanceRangeBins: number;
  readonly stopLossPct: number;
}

export function evaluateRisk(
  riskConfig: RiskConfig,
  decision: AgentDecision,
  ctx: RiskContext,
): RiskResult {
  // 1. Confidence gate
  if (decision.confidence < riskConfig.confidenceThreshold) {
    return {
      approved: false,
      reason: `Confidence ${decision.confidence.toFixed(2)} below threshold ${riskConfig.confidenceThreshold}`,
    };
  }

  // 2. Concurrent positions cap
  if (
    decision.action === "ENTER" &&
    ctx.openPositions.length >= riskConfig.maxConcurrentPositions
  ) {
    return {
      approved: false,
      reason: `Max concurrent positions reached (${riskConfig.maxConcurrentPositions})`,
    };
  }

  // 2a. Duplicate pool guard
  if (decision.action === "ENTER" && decision.poolAddress) {
    const duplicate = ctx.openPositions.find((p) => p.poolAddress === decision.poolAddress);
    if (duplicate) {
      return {
        approved: false,
        reason: `Already holding position in pool ${decision.poolAddress} — use REBALANCE instead`,
      };
    }
  }

  // 3. EXIT always approved
  if (decision.action === "EXIT") {
    return { approved: true, reason: "EXIT approved: capital protection" };
  }

  // 4. Drawdown check
  if (decision.action === "ENTER" && ctx.portfolioValueUsd > 0) {
    const drawdownPct = Math.abs(ctx.recentPnlUsd) / ctx.portfolioValueUsd;
    if (ctx.recentPnlUsd < 0 && drawdownPct > 0.1) {
      return {
        approved: false,
        reason: `Portfolio drawdown ${(drawdownPct * 100).toFixed(1)}% exceeds 10% — pausing new entries`,
      };
    }
  }

  // 5. Stop-loss check
  if (decision.action === "HOLD" || decision.action === "REBALANCE") {
    const pos = ctx.openPositions.find((p) => p.poolAddress === decision.poolAddress);
    if (pos && pos.depositedUsd > 0) {
      const lossPct = (pos.currentValueUsd - pos.depositedUsd) / pos.depositedUsd;
      if (lossPct < -riskConfig.stopLossPct) {
        return {
          approved: false,
          reason: `Stop-loss triggered: position loss ${(Math.abs(lossPct) * 100).toFixed(1)}% exceeds ${(riskConfig.stopLossPct * 100).toFixed(0)}%`,
        };
      }
    }
  }

  // 6. Position size validation
  if (decision.action === "ENTER" && decision.positionSizeUsd !== undefined) {
    const maxSize = ctx.portfolioValueUsd * 0.3;
    if (decision.positionSizeUsd > maxSize) {
      const adjustedSizeUsd = maxSize;
      return {
        approved: true,
        reason: `Size capped to 30% of portfolio ($${adjustedSizeUsd.toFixed(0)})`,
        adjustedSizeUsd,
      };
    }
  }

  // 7. REBALANCE: validate bin range
  if (decision.action === "REBALANCE" && decision.rebalanceParams) {
    const { newLowerBinId, newUpperBinId } = decision.rebalanceParams;
    if (newUpperBinId <= newLowerBinId) {
      return {
        approved: false,
        reason: "Invalid rebalance range: upperBinId must be > lowerBinId",
      };
    }
    const rangeWidth = newUpperBinId - newLowerBinId;
    if (rangeWidth > riskConfig.maxRebalanceRangeBins) {
      return {
        approved: false,
        reason: `Rebalance range ${rangeWidth} bins exceeds max ${riskConfig.maxRebalanceRangeBins}`,
      };
    }
  }

  return { approved: true, reason: "All risk checks passed" };
}

export const RiskLive = (riskConfig: RiskConfig) =>
  Layer.succeed(
    RiskService,
    RiskService.of({
      evaluate(decision: AgentDecision, ctx: RiskContext): RiskResult {
        return evaluateRisk(riskConfig, decision, ctx);
      },
    } satisfies RiskApi),
  );

// ─── F1: Gas-aware rebalancing gate ──────────────────────────────────────────

export interface GasGateInput {
  readonly rebalanceGasCostSol: number;
  readonly solPriceUsd: number;
  readonly positionDailyFeesUsd: number;
  readonly minDaysOfFeesPaidAhead: number;
}

export interface GasGateResult {
  readonly approved: boolean;
  readonly reason: string;
  readonly gasCostUsd: number;
  readonly feesThresholdUsd: number;
}

/**
 * Gate REBALANCE on a cost-vs-benefit check: only rebalance if the on-chain
 * gas cost is recovered by N days of position fees. Zero-fee pools are always
 * rejected (let downstream risk gates handle those).
 */
export function evaluateGasGate(input: GasGateInput): GasGateResult {
  const gasCostUsd = input.rebalanceGasCostSol * input.solPriceUsd;
  const feesThresholdUsd = input.positionDailyFeesUsd * input.minDaysOfFeesPaidAhead;

  if (gasCostUsd <= 0) {
    return {
      approved: false,
      reason: `Invalid gas cost ${input.rebalanceGasCostSol} SOL — refusing rebalance`,
      gasCostUsd,
      feesThresholdUsd,
    };
  }

  if (input.positionDailyFeesUsd <= 0) {
    return {
      approved: false,
      reason: `Position earns no fees ($${input.positionDailyFeesUsd.toFixed(4)}/day) — rebalance gas not justified`,
      gasCostUsd,
      feesThresholdUsd,
    };
  }

  if (gasCostUsd > feesThresholdUsd) {
    return {
      approved: false,
      reason:
        `Gas cost $${gasCostUsd.toFixed(2)} > ${input.minDaysOfFeesPaidAhead}d fees $${feesThresholdUsd.toFixed(2)} ` +
        `— wait for accrued fees before rebalancing`,
      gasCostUsd,
      feesThresholdUsd,
    };
  }

  return {
    approved: true,
    reason: `Gas $${gasCostUsd.toFixed(2)} <= ${input.minDaysOfFeesPaidAhead}d fees $${feesThresholdUsd.toFixed(2)}`,
    gasCostUsd,
    feesThresholdUsd,
  };
}
