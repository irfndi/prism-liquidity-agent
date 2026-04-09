import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import type { AgentDecision, AgentCycle, PoolMetrics } from "./types.js";
import { AgentMemory } from "./memory/store.js";
import { MeteoraAdapter } from "./adapters/meteora.js";
import { DLMMStrategy } from "./probes/dlmm.js";
import { RiskEngine } from "./risk/gate.js";
import { createMCPServer, METEORA_TOOLS } from "./tools/index.js";
import { randomUUID } from "crypto";

const log = createLogger("Main");
const trackedPaperPositions = new Map<
  string,
  PoolMetrics["pool"] & { currentValueUsd: number; depositedUsd: number }
>();

const SYSTEM_PROMPT = `You are an autonomous DLMM liquidity rebalancing agent for Meteora pools on Solana.

Your decision cycle for each pool:
1. Call memory_query to retrieve relevant past patterns and warnings for this pool
2. Call meteora_get_pool_state to get current TVL, volume, fees, APR
3. Call meteora_get_bin_array to understand bin utilization and active bin position
4. Call volume_authenticity_check to verify volume is genuine
5. Reason through: fee/IL ratio, TVL velocity, bin drift, volume authenticity
6. If considering REBALANCE: call meteora_simulate_rebalance first
7. Call memory_write to record any new pattern or warning you observe
8. Call meteora_decision with your final verdict: HOLD | REBALANCE | EXIT | ENTER

Decision rules:
- HOLD: fee/IL ratio > ${config.MIN_FEE_IL_RATIO} AND position is still in profitable range AND no red flags
- REBALANCE: active bin has drifted > 60% toward edge of range AND simulation shows net positive
- EXIT: TVL dropped > ${(config.TVL_DROP_EXIT_PCT * 100).toFixed(0)}% OR volume authenticity < ${config.VOLUME_AUTH_THRESHOLD} OR fee/IL ratio < 0.5
- ENTER: new pool passes all quality gates AND portfolio has capacity

Always set confidence as a genuine probability estimate, not 1.0.
Be conservative — a HOLD is better than a bad REBALANCE.`;

async function runAgentOnPool(
  poolAddress: string,
  client: Anthropic,
  mcp: ReturnType<typeof createMCPServer>
): Promise<AgentDecision | null> {
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Analyze Meteora DLMM pool ${poolAddress} and return your rebalancing decision.`,
    },
  ];

  let decision: AgentDecision | null = null;

  agentLoop: while (true) {
    const response = await client.messages.create({
      model: config.CLAUDE_MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: METEORA_TOOLS,
      messages,
    });

    log.debug("Agent response", {
      stop_reason: response.stop_reason,
      content_blocks: response.content.length,
    });

    if (response.stop_reason === "end_turn") {
      log.warn("Agent ended without decision", { pool: poolAddress });
      break agentLoop;
    }

    if (response.stop_reason === "tool_use") {
      const toolBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const tb of toolBlocks) {
        // Intercept the decision tool — do not execute on MCP
        if (tb.name === "meteora_decision") {
          const inp = tb.input as Record<string, unknown>;
          decision = {
            action: inp["action"] as AgentDecision["action"],
            poolAddress,
            confidence: Number(inp["confidence"]),
            reasoning: String(inp["reasoning"]),
            rebalanceParams:
              inp["action"] === "REBALANCE"
                ? {
                    newLowerBinId: Number(inp["new_lower_bin_id"]),
                    newUpperBinId: Number(inp["new_upper_bin_id"]),
                    slippageBps: 50,
                  }
                : undefined,
            positionSizeUsd:
              inp["action"] === "ENTER" ? Number(inp["position_size_usd"]) : undefined,
          };
          break agentLoop;
        }

        const result = await mcp.executeTool(tb.name, tb.input as Record<string, unknown>);
        toolResults.push({
          type: "tool_result",
          tool_use_id: tb.id,
          content: JSON.stringify(result),
        });
      }

      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    break agentLoop;
  }

  return decision;
}

async function main() {
  log.info("Mantis agent starting", {
    model: config.CLAUDE_MODEL,
    paperTrading: config.PAPER_TRADING,
    scanIntervalMs: config.SCAN_INTERVAL_MS,
    pools: config.WATCHLIST_POOLS,
  });

  if (config.WATCHLIST_POOLS.length === 0) {
    log.warn("No pools in WATCHLIST_POOLS — set them in .env to begin scanning");
  }

  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const memory = new AgentMemory();
  const adapter = new MeteoraAdapter();
  const strategy = new DLMMStrategy();
  const risk = new RiskEngine();
  const mcp = createMCPServer(adapter, strategy, memory);

  await memory.initialize();

  // Prune expired memories at startup
  const pruned = await memory.pruneExpired();
  if (pruned > 0) log.info("Pruned expired memories", { count: pruned });

  const runScanCycle = async () => {
    const cycle: AgentCycle = {
      cycleId: randomUUID(),
      startedAt: Date.now(),
      poolsScanned: 0,
      poolsActioned: 0,
      decisions: [],
      totalGasCostSol: 0,
      paperTrading: config.PAPER_TRADING,
    };

    log.info("Scan cycle started", { cycleId: cycle.cycleId });

    for (const poolAddress of config.WATCHLIST_POOLS) {
      try {
        cycle.poolsScanned++;
        log.info("Analyzing pool", { pool: poolAddress });

        const decision = await runAgentOnPool(poolAddress, client, mcp);

        if (!decision) {
          log.warn("No decision returned for pool", { pool: poolAddress });
          continue;
        }

        log.info("Agent decision", {
          pool: poolAddress,
          action: decision.action,
          confidence: decision.confidence,
          reasoning: decision.reasoning.slice(0, 120),
        });

        // Risk check
        const openPositions = Array.from(trackedPaperPositions.values()).map((p) => ({
          id: p.address,
          poolAddress: p.address,
          poolName: `${p.tokenXSymbol}/${p.tokenYSymbol}`,
          lowerBinId: p.activeBinId - 10,
          upperBinId: p.activeBinId + 10,
          liquidityShares: 0n,
          depositedUsd: p.depositedUsd,
          currentValueUsd: p.currentValueUsd,
          unrealizedPnlUsd: p.currentValueUsd - p.depositedUsd,
          feesEarnedUsd: 0,
          openedAt: p.timestamp,
        }));
        const portfolioValueUsd = Math.max(
          config.PAPER_PORTFOLIO_USD,
          openPositions.reduce((sum, position) => sum + position.currentValueUsd, 0)
        );
        const recentPnlUsd = openPositions.reduce(
          (sum, position) => sum + position.unrealizedPnlUsd + position.feesEarnedUsd,
          0
        );

        const riskResult = risk.evaluate(decision, {
          openPositions,
          portfolioValueUsd,
          recentPnlUsd,
        });

        if (!riskResult.approved) {
          log.warn("Risk engine rejected decision", {
            reason: riskResult.reason,
            pool: poolAddress,
          });
          await memory.upsert({
            category: "warning",
            content: `Decision rejected by risk engine: ${riskResult.reason}. Original action: ${decision.action}`,
            poolAddress,
          });
          continue;
        }

        cycle.decisions.push(decision);
        cycle.poolsActioned++;

        if (config.PAPER_TRADING) {
          log.info("[PAPER] Would execute", {
            action: decision.action,
            pool: poolAddress,
          });
          if (decision.action === "ENTER" && decision.positionSizeUsd) {
            const pool = await adapter.getPoolState(poolAddress);
            trackedPaperPositions.set(poolAddress, {
              ...pool,
              depositedUsd: decision.positionSizeUsd,
              currentValueUsd: decision.positionSizeUsd,
            });
          } else if (decision.action === "EXIT") {
            trackedPaperPositions.delete(poolAddress);
          } else if (decision.action === "REBALANCE" && trackedPaperPositions.has(poolAddress)) {
            const current = trackedPaperPositions.get(poolAddress)!;
            trackedPaperPositions.set(poolAddress, {
              ...current,
              currentValueUsd: current.currentValueUsd,
            });
          }
        } else {
          // Live execution would go here
          log.warn("Live trading not yet implemented — set PAPER_TRADING=true");
        }
      } catch (err) {
        log.error("Error processing pool", { pool: poolAddress, err });
      }
    }

    cycle.completedAt = Date.now();
    const duration = ((cycle.completedAt - cycle.startedAt) / 1000).toFixed(1);
    log.info("Scan cycle complete", {
      cycleId: cycle.cycleId,
      scanned: cycle.poolsScanned,
      actioned: cycle.poolsActioned,
      durationSec: duration,
    });
  };

  // Run first cycle immediately
  await runScanCycle();

  // Then run on interval
  log.info(`Next scan in ${config.SCAN_INTERVAL_MS / 60000} minutes`);
  setInterval(runScanCycle, config.SCAN_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
