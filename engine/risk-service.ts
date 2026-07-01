import { Context, Layer } from "effect";
import { RiskService, type RiskApi, type RiskContext, type RiskResult } from "./services.js";
import type { AgentDecision } from "./types.js";

export interface RiskConfig {
  readonly confidenceThreshold: number;
  readonly maxOpenPositions: number;
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
    ctx.openPositions.length >= riskConfig.maxOpenPositions
  ) {
    return {
      approved: false,
      reason: `Max concurrent positions reached (${riskConfig.maxOpenPositions})`,
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

// ─── F3: Fee compounding gate ────────────────────────────────────────────────

export interface CompoundGateInput {
  readonly netFeesUsd: number;
  readonly minCompoundFeesUsd: number;
  readonly compoundGasBufferUsd: number;
  readonly rebalanceGasCostUsd: number;
}

export interface CompoundGateResult {
  readonly approved: boolean;
  readonly reason: string;
  readonly thresholdUsd: number;
  readonly savingsUsd: number;
}

/**
 * Decide whether the accrued fees are worth claiming + re-depositing into the
 * same position. Reject if fees don't clear the gas cost + buffer + minimum
 * threshold. Threshold = minCompound + buffer + rebalanceGas (compound tx costs
 * roughly a rebalance's worth of gas).
 */
export function evaluateCompoundGate(input: CompoundGateInput): CompoundGateResult {
  const thresholdUsd =
    input.minCompoundFeesUsd + input.compoundGasBufferUsd + input.rebalanceGasCostUsd;
  const savingsUsd = input.netFeesUsd - thresholdUsd;

  if (input.netFeesUsd <= 0) {
    return {
      approved: false,
      reason: `Net fees $${input.netFeesUsd.toFixed(4)} — nothing to compound`,
      thresholdUsd,
      savingsUsd,
    };
  }

  if (savingsUsd <= 0) {
    return {
      approved: false,
      reason:
        `Net fees $${input.netFeesUsd.toFixed(2)} ≤ compound cost $${thresholdUsd.toFixed(2)} ` +
        `(min $${input.minCompoundFeesUsd.toFixed(2)} + buffer $${input.compoundGasBufferUsd.toFixed(2)} + gas $${input.rebalanceGasCostUsd.toFixed(2)})`,
      thresholdUsd,
      savingsUsd,
    };
  }

  return {
    approved: true,
    reason: `Net fees $${input.netFeesUsd.toFixed(2)} cover compound cost $${thresholdUsd.toFixed(2)} — savings $${savingsUsd.toFixed(2)}`,
    thresholdUsd,
    savingsUsd,
  };
}

// ─── F5: Multi-pool allocation gate ──────────────────────────────────────────

import type { Position } from "./types.js";

export interface PerPoolAllocationInput {
  readonly proposedDepositUsd: number;
  readonly portfolioValueUsd: number;
  readonly openPositions: ReadonlyArray<Position>;
  readonly maxPerPoolAllocationPct: number;
  readonly maxOpenPositions: number;
}

export interface PerPoolAllocationResult {
  readonly approved: boolean;
  readonly reason: string;
  readonly adjustedDepositUsd: number;
}

/**
 * Decide whether a proposed ENTER fits the per-pool allocation cap and the
 * hard cap on simultaneously open positions. The deposit is capped to the
 * per-pool limit; ENTER is rejected only when the position cap is reached.
 */
export function evaluatePerPoolAllocation(
  input: PerPoolAllocationInput,
): PerPoolAllocationResult {
  if (input.openPositions.length >= input.maxOpenPositions) {
    return {
      approved: false,
      reason: `Max open positions reached (${input.openPositions.length}/${input.maxOpenPositions}) — split across ${input.maxOpenPositions} pools max`,
      adjustedDepositUsd: 0,
    };
  }

  const perPoolCapUsd = Math.max(input.portfolioValueUsd * input.maxPerPoolAllocationPct, 0);
  const adjusted = Math.min(input.proposedDepositUsd, perPoolCapUsd);

  if (adjusted <= 0) {
    return {
      approved: false,
      reason: `Per-pool cap $${perPoolCapUsd.toFixed(2)} would zero out the proposed $${input.proposedDepositUsd.toFixed(2)} deposit`,
      adjustedDepositUsd: 0,
    };
  }

  return {
    approved: true,
    reason:
      adjusted < input.proposedDepositUsd
        ? `Capped to ${(input.maxPerPoolAllocationPct * 100).toFixed(0)}% of portfolio ($${adjusted.toFixed(0)})`
        : "Within per-pool allocation cap",
    adjustedDepositUsd: adjusted,
  };
}

// ─── F6: Paper-trading validation gate ───────────────────────────────────────

export interface PaperValidationInput {
  readonly paperTrading: boolean;
  readonly paperDaysAccumulated: number;
  readonly minDays: number;
  readonly enforce: boolean;
}

export interface PaperValidationResult {
  readonly approved: boolean;
  readonly reason: string;
  readonly warning?: string;
}

/**
 * Block live ENTER until the user has run the agent in paper mode for at
 * least `minDays` accumulated days. Skipped entirely in paper mode. When
 * enforce=false, the gate emits a warning instead of rejecting — useful for
 * opt-in enforcement during initial deployment.
 */
export function evaluatePaperValidation(input: PaperValidationInput): PaperValidationResult {
  if (input.paperTrading) {
    return {
      approved: true,
      reason: "Paper trading — validation does not apply",
    };
  }

  if (input.paperDaysAccumulated >= input.minDays) {
    return {
      approved: true,
      reason: `Paper validation passed (${input.paperDaysAccumulated}/${input.minDays} days)`,
    };
  }

  if (!input.enforce) {
    return {
      approved: true,
      reason: "Paper validation not enforced",
      warning:
        `Live trading with only ${input.paperDaysAccumulated} paper days — ` +
        `consider running paper for ${input.minDays} days before going live`,
    };
  }

  return {
    approved: false,
    reason:
      `Paper validation gate: only ${input.paperDaysAccumulated}/${input.minDays} paper days accumulated. ` +
      `Live ENTER requires at least ${input.minDays} days of paper trading. ` +
      `Set PAPER_VALIDATION_ENFORCE=false to override (not recommended).`,
  };
}

// ─── F3 fix: token-amount → USD conversion helpers ──────────────────────────

/**
 * Standard token decimals for the symbols we recognize. Unknown tokens
 * return the sentinel `-1` so callers can fail closed rather than guessing
 * decimals for an unrecognized asset. Only SOL/WSOL and USDC/USDT are
 * supported today; the agent is intentionally conservative about pricing
 * anything else because mis-pricing fees can bypass the compound gate.
 */
export function getTokenDecimals(symbol: string): number {
  const upper = symbol.toUpperCase();
  if (upper === "SOL" || upper === "WSOL") return 9;
  if (upper === "USDC" || upper === "USDT") return 6;
  return -1;
}

/**
 * Convert a raw token base-unit amount to a USD estimate. SOL uses
 * solPriceUsd; USDC/USDT use par ($1). Unknown tokens return 0 (fail closed)
 * so the compound gate rejects instead of compounding on a mis-priced fee.
 */
export function tokenAmountToUsd(
  rawAmount: number,
  tokenSymbol: string,
  solPriceUsd: number,
): number {
  if (rawAmount === 0) return 0;
  const decimals = getTokenDecimals(tokenSymbol);
  if (decimals < 0) return 0;
  const human = rawAmount / Math.pow(10, decimals);
  const upper = tokenSymbol.toUpperCase();
  if (upper === "USDC" || upper === "USDT") return human;
  return human * solPriceUsd;
}

export interface ClaimFeesUsdInput {
  readonly netFeeXRaw: number;
  readonly netFeeYRaw: number;
  readonly tokenXSymbol: string;
  readonly tokenYSymbol: string;
  readonly solPriceUsd: number;
}

/**
 * Convert both sides of a fee claim to USD using per-token decimals.
 * Returns 0 when either side is an unsupported token — this fails the
 * compound gate closed. Also fixes the F3 USD-estimation bug where
 * (rawX + rawY) * solPrice added lamports + base-units, producing
 * multi-billion-dollar estimates that bypassed the gate.
 */
export function convertClaimFeesToUsd(input: ClaimFeesUsdInput): number {
  const xDecimals = getTokenDecimals(input.tokenXSymbol);
  const yDecimals = getTokenDecimals(input.tokenYSymbol);
  if (xDecimals < 0 || yDecimals < 0) return 0;
  const feeXUsd = tokenAmountToUsd(
    input.netFeeXRaw,
    input.tokenXSymbol,
    input.solPriceUsd,
  );
  const feeYUsd = tokenAmountToUsd(
    input.netFeeYRaw,
    input.tokenYSymbol,
    input.solPriceUsd,
  );
  return feeXUsd + feeYUsd;
}
