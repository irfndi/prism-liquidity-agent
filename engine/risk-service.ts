import { Context, Layer } from "effect";
import { RiskService, type RiskApi, type RiskContext, type RiskResult } from "./services.js";
import type { AppConfig } from "./config-service.js";
import type {
  ActionType,
  AgentDecision,
  AgentProposal,
  ProposalValidationResult,
  RebalanceParams,
} from "./types.js";
import { shouldHoldForRecovery } from "./strategy-service.js";

export interface RiskConfig {
  readonly confidenceThreshold: number;
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

  // 2. Concurrent positions cap is enforced upstream by evaluatePerPoolAllocation.

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

const VALID_ACTIONS: ReadonlyArray<ActionType> = ["HOLD", "REBALANCE", "EXIT", "ENTER"];

// Slippage is intentionally excluded: the proposal schema does not accept it
// (buildProposal hardcodes 0 while deterministic decisions use 50), and it is
// never read during execution — only the bin range alters execution.
const rebalanceParamsEqual = (a: RebalanceParams, b: RebalanceParams): boolean =>
  a.newLowerBinId === b.newLowerBinId && a.newUpperBinId === b.newUpperBinId;

export function evaluateAgentProposal(
  proposal: AgentProposal,
  ctx: RiskContext,
  config: AppConfig,
): ProposalValidationResult {
  // 1. Action must be a known decision action.
  if (!VALID_ACTIONS.includes(proposal.action)) {
    return { valid: false, reason: `Invalid action: ${proposal.action}` };
  }

  // 2. Proposal must target the pool currently being evaluated.
  if (proposal.poolAddress !== ctx.poolAddress) {
    return {
      valid: false,
      reason: `Proposal poolAddress ${proposal.poolAddress} does not match evaluated pool ${ctx.poolAddress}`,
    };
  }

  // 3. Safety EXIT cannot be downgraded to a less-defensive action.
  if (proposal.originalAction === "EXIT" && proposal.action !== "EXIT") {
    return {
      valid: false,
      reason: "Cannot downgrade a safety EXIT to a non-EXIT action",
    };
  }

  // 4. Non-ENTER actions may not be promoted to ENTER.
  // HOLD→REBALANCE and HOLD→EXIT are intentionally allowed when a position
  // exists (checked below). Callers in `full`/`supervised` must still re-run
  // capital-protection gates (min interval, gas, recovery) before applying
  // agent-originated REBALANCE — see evaluateAgentRebalanceCapitalGates.
  if (
    proposal.originalAction !== undefined &&
    proposal.originalAction !== "ENTER" &&
    proposal.action === "ENTER"
  ) {
    return {
      valid: false,
      reason: `Cannot promote ${proposal.originalAction} to ENTER`,
    };
  }

  // 5. Confidence must be finite and within [minConfidence, 1], unless the proposal
  //    preserves the original low-confidence decision unchanged — verified against
  //    the trusted original decision (same action, same confidence, same
  //    executable parameters). Without one, the waiver does not apply.
  const original = ctx.originalDecision;
  const preservesOriginalDecision =
    original !== undefined &&
    proposal.action === original.action &&
    Math.abs(proposal.confidence - original.confidence) < 0.005 &&
    (proposal.positionSizeUsd === undefined ||
      proposal.positionSizeUsd === original.positionSizeUsd) &&
    (proposal.rebalanceParams === undefined ||
      (original.rebalanceParams !== undefined &&
        rebalanceParamsEqual(proposal.rebalanceParams, original.rebalanceParams)));

  if (
    !preservesOriginalDecision &&
    (!Number.isFinite(proposal.confidence) ||
      proposal.confidence < config.agentProposalMinConfidence ||
      proposal.confidence > 1)
  ) {
    return {
      valid: false,
      reason:
        `Confidence ${proposal.confidence} must be finite and between ` +
        `${config.agentProposalMinConfidence} and 1`,
    };
  }

  // 7. Position size must be non-negative and capped to the stricter of the
  //    agent proposal limit and the existing per-pool allocation cap.
  let adjustedPositionSizeUsd = proposal.positionSizeUsd;

  if (proposal.action === "ENTER" && proposal.positionSizeUsd === undefined) {
    return { valid: false, reason: "ENTER proposals must include positionSizeUsd" };
  }

  if (proposal.action === "ENTER") {
    if (
      proposal.positionSizeUsd === undefined ||
      !Number.isFinite(proposal.positionSizeUsd) ||
      proposal.positionSizeUsd <= 0
    ) {
      return { valid: false, reason: "positionSizeUsd must be a positive finite number for ENTER" };
    }
  }

  if (proposal.action === "REBALANCE") {
    if (proposal.rebalanceParams === undefined) {
      return { valid: false, reason: "REBALANCE proposals must include rebalanceParams" };
    }
    const hasPosition = ctx.openPositions.some((p) => p.poolAddress === proposal.poolAddress);
    if (!hasPosition) {
      return {
        valid: false,
        reason: `Cannot REBALANCE pool ${proposal.poolAddress} — no open position`,
      };
    }
  }

  if (proposal.action === "EXIT") {
    const hasPosition = ctx.openPositions.some((p) => p.poolAddress === proposal.poolAddress);
    // An echoed deterministic EXIT on an unheld pool is a no-op, not a bad
    // proposal — only reject advisor-initiated exits with no position.
    if (!hasPosition && proposal.originalAction !== "EXIT") {
      return {
        valid: false,
        reason: `Cannot EXIT pool ${proposal.poolAddress} — no open position`,
      };
    }
  }

  if (proposal.positionSizeUsd !== undefined) {
    if (!Number.isFinite(proposal.positionSizeUsd) || proposal.positionSizeUsd < 0) {
      return { valid: false, reason: "positionSizeUsd must be a finite non-negative number" };
    }

    const agentMaxSizeUsd = ctx.portfolioValueUsd * config.agentProposalMaxPositionSizePct;
    const perPoolCapUsd = ctx.portfolioValueUsd * config.maxPerPoolAllocationPct;
    let cappedSizeUsd = Math.min(proposal.positionSizeUsd, agentMaxSizeUsd, perPoolCapUsd);

    if (proposal.action === "ENTER") {
      const duplicate = ctx.openPositions.find((p) => p.poolAddress === proposal.poolAddress);
      if (duplicate) {
        return {
          valid: false,
          reason: `Already holding position in pool ${proposal.poolAddress} — use REBALANCE instead`,
        };
      }

      const allocationResult = evaluatePerPoolAllocation({
        proposedDepositUsd: cappedSizeUsd,
        portfolioValueUsd: ctx.portfolioValueUsd,
        openPositions: ctx.openPositions,
        maxPerPoolAllocationPct: config.maxPerPoolAllocationPct,
        maxOpenPositions: config.maxOpenPositions,
      });

      if (!allocationResult.approved) {
        return { valid: false, reason: allocationResult.reason };
      }

      cappedSizeUsd = allocationResult.adjustedDepositUsd;
    }

    if (cappedSizeUsd !== proposal.positionSizeUsd) {
      adjustedPositionSizeUsd = cappedSizeUsd;
    }
  }

  // 8. REBALANCE parameters must form a valid, bounded bin range with integer IDs.
  if (proposal.rebalanceParams !== undefined) {
    const { newLowerBinId, newUpperBinId } = proposal.rebalanceParams;
    if (!Number.isInteger(newLowerBinId) || !Number.isInteger(newUpperBinId)) {
      return {
        valid: false,
        reason: "Rebalance bin IDs must be integers",
      };
    }
    if (newUpperBinId <= newLowerBinId) {
      return {
        valid: false,
        reason: "Invalid rebalance range: upperBinId must be > lowerBinId",
      };
    }
    const rangeWidth = newUpperBinId - newLowerBinId;
    if (rangeWidth > config.maxRebalanceRangeBins) {
      return {
        valid: false,
        reason: `Rebalance range ${rangeWidth} bins exceeds max ${config.maxRebalanceRangeBins}`,
      };
    }
  }

  const adjustedDecision: AgentDecision = {
    action: proposal.action,
    poolAddress: proposal.poolAddress,
    confidence: proposal.confidence,
    reasoning: proposal.reasoning,
    ...(adjustedPositionSizeUsd !== undefined && { positionSizeUsd: adjustedPositionSizeUsd }),
    ...(proposal.rebalanceParams !== undefined && { rebalanceParams: proposal.rebalanceParams }),
  };

  return {
    valid: true,
    reason: "Agent proposal validated",
    adjustedDecision,
  };
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

// ─── Agent-originated REBALANCE capital-protection gates ─────────────────────

export interface AgentRebalanceCapitalGateInput {
  readonly now: number;
  readonly lastRebalanceAt: number;
  readonly minRebalanceIntervalMs: number;
  /** When true (OOR grace expired), min-interval may be bypassed. */
  readonly oorGraceExpired: boolean;
  readonly rebalanceGasCostSol: number;
  readonly solPriceUsd: number;
  readonly positionDailyFeesUsd: number;
  readonly minDaysOfFeesPaidAhead: number;
  readonly recoveryProbability: number;
  readonly oorRecoveryHoldThreshold: number;
}

/**
 * Re-apply the deterministic REBALANCE capital-protection gates to an
 * agent-originated REBALANCE so advisors cannot bypass min-interval, gas, or
 * OOR recovery holds that protect the deterministic path.
 */
export function evaluateAgentRebalanceCapitalGates(input: AgentRebalanceCapitalGateInput): {
  readonly approved: boolean;
  readonly reason: string;
} {
  const timeSinceRebal = input.now - input.lastRebalanceAt;
  if (timeSinceRebal < input.minRebalanceIntervalMs && !input.oorGraceExpired) {
    return {
      approved: false,
      reason:
        `Agent REBALANCE blocked by min-interval: ${timeSinceRebal}ms < ` +
        `${input.minRebalanceIntervalMs}ms`,
    };
  }

  const gasGate = evaluateGasGate({
    rebalanceGasCostSol: input.rebalanceGasCostSol,
    solPriceUsd: input.solPriceUsd,
    positionDailyFeesUsd: input.positionDailyFeesUsd,
    minDaysOfFeesPaidAhead: input.minDaysOfFeesPaidAhead,
  });
  if (!gasGate.approved) {
    return {
      approved: false,
      reason: `Agent REBALANCE blocked by gas-gate: ${gasGate.reason}`,
    };
  }

  if (shouldHoldForRecovery(input.recoveryProbability, input.oorRecoveryHoldThreshold)) {
    return {
      approved: false,
      reason:
        `Agent REBALANCE blocked by recovery-gate: probability ` +
        `${input.recoveryProbability.toFixed(2)} >= ${input.oorRecoveryHoldThreshold}`,
    };
  }

  return { approved: true, reason: "Agent REBALANCE capital gates passed" };
}

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
      reason: `Gas cost must be positive (configured ${input.rebalanceGasCostSol} SOL) — refusing rebalance`,
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
export function evaluatePerPoolAllocation(input: PerPoolAllocationInput): PerPoolAllocationResult {
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
  const feeXUsd = tokenAmountToUsd(input.netFeeXRaw, input.tokenXSymbol, input.solPriceUsd);
  const feeYUsd = tokenAmountToUsd(input.netFeeYRaw, input.tokenYSymbol, input.solPriceUsd);
  return feeXUsd + feeYUsd;
}
