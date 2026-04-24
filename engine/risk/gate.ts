import { createLogger } from "../logger.js";
import type { AgentDecision, Position, RiskResult } from "../types.js";
import { config } from "../config.js";

const log = createLogger("RiskEngine");

export interface RiskContext {
  openPositions: Position[];
  portfolioValueUsd: number;
  recentPnlUsd: number; // rolling 24h PnL
}

export class RiskEngine {
  evaluate(decision: AgentDecision, ctx: RiskContext): RiskResult {
    // 1. Confidence gate
    if (decision.confidence < config.CONFIDENCE_THRESHOLD) {
      return {
        approved: false,
        reason: `Confidence ${decision.confidence.toFixed(2)} below threshold ${config.CONFIDENCE_THRESHOLD}`,
      };
    }

    // 2. Concurrent positions cap
    if (
      decision.action === "ENTER" &&
      ctx.openPositions.length >= config.MAX_CONCURRENT_POSITIONS
    ) {
      return {
        approved: false,
        reason: `Max concurrent positions reached (${config.MAX_CONCURRENT_POSITIONS})`,
      };
    }

    // 2a. Duplicate pool guard — entering the same pool twice creates overlapping ranges
    // that compound IL exposure without adding fee capture. The agent can REBALANCE
    // an existing position; a second ENTER on the same pool is never correct.
    if (decision.action === "ENTER" && decision.poolAddress) {
      const duplicate = ctx.openPositions.find(
        (p) => p.poolAddress === decision.poolAddress
      );
      if (duplicate) {
        return {
          approved: false,
          reason: `Already holding position in pool ${decision.poolAddress} — use REBALANCE instead`,
        };
      }
    }

    // 3. TVL drop exit validation
    if (decision.action === "EXIT") {
      // EXIT decisions are always allowed through — protecting capital
      return { approved: true, reason: "EXIT approved: capital protection" };
    }

    // 4. Drawdown check — if recent PnL is deeply negative, pause entries
    if (decision.action === "ENTER" && ctx.portfolioValueUsd > 0) {
      const drawdownPct = Math.abs(ctx.recentPnlUsd) / ctx.portfolioValueUsd;
      if (ctx.recentPnlUsd < 0 && drawdownPct > 0.1) {
        return {
          approved: false,
          reason: `Portfolio drawdown ${(drawdownPct * 100).toFixed(1)}% exceeds 10% — pausing new entries`,
        };
      }
    }

    // 5. Position size validation for ENTER
    if (decision.action === "ENTER" && decision.positionSizeUsd !== undefined) {
      const maxSize = ctx.portfolioValueUsd * 0.3; // max 30% per position
      if (decision.positionSizeUsd > maxSize) {
        const adjustedSizeUsd = maxSize;
        log.warn("Position size capped", {
          requested: decision.positionSizeUsd,
          capped: adjustedSizeUsd,
        });
        return {
          approved: true,
          reason: `Size capped to 30% of portfolio ($${adjustedSizeUsd.toFixed(0)})`,
          adjustedSizeUsd,
        };
      }
    }

    // 6. REBALANCE: validate bin range makes sense
    if (decision.action === "REBALANCE" && decision.rebalanceParams) {
      const { newLowerBinId, newUpperBinId } = decision.rebalanceParams;
      if (newUpperBinId <= newLowerBinId) {
        return {
          approved: false,
          reason: "Invalid rebalance range: upperBinId must be > lowerBinId",
        };
      }
      const rangeWidth = newUpperBinId - newLowerBinId;
      if (rangeWidth > config.MAX_REBALANCE_RANGE_BINS) {
        return {
          approved: false,
          reason: `Rebalance range ${rangeWidth} bins is too wide: exceeds MAX_REBALANCE_RANGE_BINS (${config.MAX_REBALANCE_RANGE_BINS}) — too much capital spread across inactive bins`,
        };
      }
    }

    log.debug("Decision approved", {
      action: decision.action,
      pool: decision.poolAddress,
      confidence: decision.confidence,
    });

    return { approved: true, reason: "All risk checks passed" };
  }
}

