import { config } from "./config.js";
import { createLogger } from "./logger.js";
import type { AgentDecision, AgentCycle, PoolMetrics } from "./types.js";
import { AgentMemory } from "./memory/store.js";
import { MeteoraAdapter } from "./adapters/meteora.js";
import { DLMMStrategy } from "./probes/dlmm.js";
import { RiskEngine } from "./risk/gate.js";
import { randomUUID } from "crypto";

const log = createLogger("Main");

interface TrackedPosition {
  poolAddress: string;
  positionPubKey: string | null; // null for paper trading
  depositedUsd: number;
  currentValueUsd: number;
  tokenXSymbol: string;
  tokenYSymbol: string;
  activeBinId: number;
  lowerBinId: number;
  upperBinId: number;
  timestamp: number;
}

const trackedPositions = new Map<string, TrackedPosition>();
const lastRebalanceTime = new Map<string, number>(); // poolAddress -> timestamp


/**
 * Rule-based decision engine — replaces the LLM agent when no API key is available.
 * Uses the same probes and metrics as the Claude agent, but applies the rules directly.
 */
async function runRuleBasedAgent(
  poolAddress: string,
  adapter: MeteoraAdapter,
  strategy: DLMMStrategy,
  memory: AgentMemory
): Promise<AgentDecision | null> {
  try {
    // 1. Fetch pool state
    const pool = await adapter.getPoolState(poolAddress);
    const binArray = await adapter.getBinArray(poolAddress);

    // 2. Compute metrics
    const previousTvl = 0; // Would track from history in full version
    const metrics = strategy.computeMetrics(pool, binArray, previousTvl);

    // 3. Check memory for past warnings
    const warnings = await memory.getRelevantContext(
      `warnings or failures for pool ${poolAddress}`,
      3
    );
    const hasRecentWarning = warnings.some(
      (w) => w.category === "warning" && w.createdAt > Date.now() - 7 * 24 * 60 * 60 * 1000
    );

    // 4. Check if pool passes pre-filter
    if (!strategy.passesPreFilter(pool, metrics.volumeAuthenticity, metrics.binUtilization)) {
      log.debug("Pool failed pre-filter", { pool: poolAddress });
      return {
        action: "EXIT",
        poolAddress,
        confidence: 0.9,
        reasoning: `Pool failed quality gates: TVL=$${pool.tvlUsd.toFixed(0)}, auth=${metrics.volumeAuthenticity.toFixed(2)}, binUtil=${metrics.binUtilization.toFixed(2)}`,
      };
    }

    // 5. Decision rules (from the original SYSTEM_PROMPT)
    const feeIlRatio = metrics.feeIlRatio;
    const volumeAuth = metrics.volumeAuthenticity;
    const tvlVelocity = metrics.tvlVelocity;
    const binUtilization = metrics.binUtilization;

    // Check for EXIT conditions first (capital protection)
    if (tvlVelocity < -config.TVL_DROP_EXIT_PCT) {
      const decision: AgentDecision = {
        action: "EXIT",
        poolAddress,
        confidence: 0.85,
        reasoning: `TVL dropped ${(Math.abs(tvlVelocity) * 100).toFixed(1)}% — capital protection exit`,
      };
      await memory.upsert({
        category: "warning",
        content: `Pool ${poolAddress} TVL dropped sharply. Exit triggered.`,
        poolAddress,
      });
      return decision;
    }

    if (volumeAuth < config.VOLUME_AUTH_THRESHOLD) {
      const decision: AgentDecision = {
        action: "EXIT",
        poolAddress,
        confidence: 0.8,
        reasoning: `Volume authenticity ${volumeAuth.toFixed(2)} below threshold ${config.VOLUME_AUTH_THRESHOLD} — possible wash trading`,
      };
      await memory.upsert({
        category: "warning",
        content: `Pool ${poolAddress} suspicious volume. Score: ${volumeAuth.toFixed(2)}`,
        poolAddress,
      });
      return decision;
    }

    if (feeIlRatio < 0.5) {
      const decision: AgentDecision = {
        action: "EXIT",
        poolAddress,
        confidence: 0.75,
        reasoning: `Fee/IL ratio ${feeIlRatio.toFixed(2)} below 0.5 — fees not covering impermanent loss`,
      };
      return decision;
    }

    // Check for REBALANCE
    const pos = trackedPositions.get(poolAddress);
    const hasPosition = !!pos;
    const currentLowerBinId = pos?.lowerBinId ?? pool.activeBinId - 20;
    const currentUpperBinId = pos?.upperBinId ?? pool.activeBinId + 20;
    const positionCenter = (currentLowerBinId + currentUpperBinId) / 2;
    const positionHalfWidth = (currentUpperBinId - currentLowerBinId) / 2;
    const driftPct = Math.abs(pool.activeBinId - positionCenter) / (positionHalfWidth || 1);
    const lastRebal = lastRebalanceTime.get(poolAddress) ?? 0;
    const timeSinceRebal = Date.now() - lastRebal;

    if (hasPosition && driftPct > 0.6 && timeSinceRebal >= config.MIN_REBALANCE_INTERVAL_MS) {
      const recommended = strategy.recommendBinRange(pool.activeBinId, pool.binStep);
      const sim = await adapter.simulateRebalance(
        poolAddress,
        recommended.lowerBinId,
        recommended.upperBinId
      );

      if (sim.netBenefitUsd > config.MIN_REBALANCE_NET_BENEFIT_USD) {
        const decision: AgentDecision = {
          action: "REBALANCE",
          poolAddress,
          confidence: Math.min(0.7 + feeIlRatio * 0.1, 0.9),
          reasoning: `Active bin drifted ${(driftPct * 100).toFixed(0)}% toward edge. Simulated net benefit: $${sim.netBenefitUsd.toFixed(2)} (min: $${config.MIN_REBALANCE_NET_BENEFIT_USD}). Fee/IL: ${feeIlRatio.toFixed(2)}. Last rebalance: ${(timeSinceRebal / 3600000).toFixed(1)}h ago.`,
          rebalanceParams: {
            newLowerBinId: recommended.lowerBinId,
            newUpperBinId: recommended.upperBinId,
            slippageBps: 50,
          },
        };
        return decision;
      }
    }

    // Default: HOLD for existing positions, ENTER for new ones
    if (hasPosition) {
      if (feeIlRatio > config.MIN_FEE_IL_RATIO && !hasRecentWarning) {
        return {
          action: "HOLD",
          poolAddress,
          confidence: Math.min(0.6 + feeIlRatio * 0.05, 0.9),
          reasoning: `Fee/IL ratio ${feeIlRatio.toFixed(2)} above threshold ${config.MIN_FEE_IL_RATIO}. Volume auth: ${volumeAuth.toFixed(2)}. Bin util: ${binUtilization.toFixed(2)}. Holding.`,
        };
      }
    } else {
      // ENTER logic for new pools
      if (
        feeIlRatio > config.MIN_FEE_IL_RATIO * 1.5 &&
        volumeAuth > 0.8 &&
        binUtilization > 0.4 &&
        pool.tvlUsd > config.MIN_POOL_TVL_USD * 2
      ) {
        // Use real wallet balance for position sizing in live mode
        const walletBalanceUsd = adapter.hasWallet() 
          ? await adapter.getWalletBalanceUsd() 
          : config.PAPER_PORTFOLIO_USD;
        const maxPositionSize = Math.min(
          walletBalanceUsd * 0.5, // Use 50% of wallet max per position
          pool.tvlUsd * 0.005,   // Max 0.5% of pool TVL
          500                     // Hard cap at $500 per position
        );
        const positionSizeUsd = Math.max(maxPositionSize, 10); // Minimum $10
        
        return {
          action: "ENTER",
          poolAddress,
          confidence: Math.min(0.5 + feeIlRatio * 0.05, 0.85),
          reasoning: `Strong pool: Fee/IL ${feeIlRatio.toFixed(2)}, volume auth ${volumeAuth.toFixed(2)}, TVL $${pool.tvlUsd.toFixed(0)}. Wallet $${walletBalanceUsd.toFixed(0)}. Entering with $${positionSizeUsd.toFixed(0)}.`,
          positionSizeUsd,
        };
      }
    }

    // Conservative fallback: HOLD
    return {
      action: "HOLD",
      poolAddress,
      confidence: 0.5,
      reasoning: `No strong signal. Fee/IL: ${feeIlRatio.toFixed(2)}, auth: ${volumeAuth.toFixed(2)}, util: ${binUtilization.toFixed(2)}. Holding position.`,
    };
  } catch (err) {
    log.error("Rule-based agent failed for pool", { poolAddress, err });
    return null;
  }
}

async function main() {
  log.info("Mantis agent starting (RULE-BASED MODE)", {
    paperTrading: config.PAPER_TRADING,
    scanIntervalMs: config.SCAN_INTERVAL_MS,
    pools: config.WATCHLIST_POOLS,
  });

  if (config.WATCHLIST_POOLS.length === 0) {
    log.warn("No pools in WATCHLIST_POOLS - set them in .env to begin scanning");
  }

  const memory = new AgentMemory();
  const adapter = new MeteoraAdapter();
  const strategy = new DLMMStrategy();
  const risk = new RiskEngine();

  await memory.initialize();

  try {
    const pruned = await memory.pruneExpired();
    if (pruned > 0) log.info("Pruned expired memories", { count: pruned });
  } catch (err) {
    log.warn("Initial memory prune failed", { err });
  }

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

    if (config.WATCHLIST_POOLS.length === 0) {
      log.info("Skipping scan cycle because no pools are configured");
      cycle.completedAt = Date.now();
      return;
    }

    for (const poolAddress of config.WATCHLIST_POOLS) {
      try {
        cycle.poolsScanned++;
        log.info("Analyzing pool", { pool: poolAddress });

        const decision = await runRuleBasedAgent(poolAddress, adapter, strategy, memory);

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

        const openPositions = Array.from(trackedPositions.values()).map((p) => ({
          id: p.poolAddress,
          poolAddress: p.poolAddress,
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
            trackedPositions.set(poolAddress, {
              poolAddress,
              positionPubKey: null,
              depositedUsd: decision.positionSizeUsd,
              currentValueUsd: decision.positionSizeUsd,
              tokenXSymbol: pool.tokenXSymbol,
              tokenYSymbol: pool.tokenYSymbol,
              activeBinId: pool.activeBinId,
              lowerBinId: pool.activeBinId - 20,
              upperBinId: pool.activeBinId + 20,
              timestamp: Date.now(),
            });
          } else if (decision.action === "EXIT") {
            trackedPositions.delete(poolAddress);
          } else if (decision.action === "REBALANCE" && trackedPositions.has(poolAddress)) {
            const current = trackedPositions.get(poolAddress)!;
            trackedPositions.set(poolAddress, {
              ...current,
              currentValueUsd: current.currentValueUsd,
              lowerBinId: decision.rebalanceParams?.newLowerBinId ?? current.lowerBinId,
              upperBinId: decision.rebalanceParams?.newUpperBinId ?? current.upperBinId,
            });
            lastRebalanceTime.set(poolAddress, Date.now());
          }
        } else {
          // ─── LIVE TRADING ───────────────────────────────────────────────
          if (!adapter.hasWallet()) {
            log.error("Live trading enabled but no wallet configured. Set WALLET_PRIVATE_KEY in .env");
            continue;
          }

          if (decision.action === "ENTER" && decision.positionSizeUsd) {
            // Only enter ONE position per cycle to conserve capital
            if (trackedPositions.size > 0) {
              log.info("Skipping ENTER — already have an active position", {
                pool: poolAddress,
                existingPositions: trackedPositions.size,
              });
              continue;
            }
            
            // Reserve 0.05 SOL for gas and position rent
            const solBalance = await adapter.getConnection().getBalance(adapter.getWalletPublicKey()!);
            if (solBalance < 0.05 * 1e9) {
              log.warn("Insufficient SOL for gas/position rent — skipping ENTER", {
                pool: poolAddress,
                solBalance: (solBalance / 1e9).toFixed(4),
              });
              continue;
            }
            
            const pool = await adapter.getPoolState(poolAddress);
            const recommended = strategy.recommendBinRange(pool.activeBinId, pool.binStep);
            const result = await adapter.enterPosition(
              poolAddress,
              recommended.lowerBinId,
              recommended.upperBinId,
              decision.positionSizeUsd
            );
            if (result) {
              trackedPositions.set(poolAddress, {
                poolAddress,
                positionPubKey: result.positionPubKey,
                depositedUsd: decision.positionSizeUsd,
                currentValueUsd: decision.positionSizeUsd,
                tokenXSymbol: pool.tokenXSymbol,
                tokenYSymbol: pool.tokenYSymbol,
                activeBinId: pool.activeBinId,
                lowerBinId: recommended.lowerBinId,
                upperBinId: recommended.upperBinId,
                timestamp: Date.now(),
              });
              log.info("Live position entered", {
                pool: poolAddress,
                position: result.positionPubKey,
                tx: result.txSignature,
              });
            } else {
              log.error("Live ENTER failed", { pool: poolAddress });
            }
          } else if (decision.action === "EXIT") {
            const pos = trackedPositions.get(poolAddress);
            if (pos?.positionPubKey) {
              const result = await adapter.exitPosition(poolAddress, pos.positionPubKey);
              if (result) {
                trackedPositions.delete(poolAddress);
                log.info("Live position exited", { pool: poolAddress, tx: result.txSignature });
              } else {
                log.error("Live EXIT failed", { pool: poolAddress });
              }
            } else {
              log.warn("No live position to exit", { pool: poolAddress });
              trackedPositions.delete(poolAddress);
            }
          } else if (decision.action === "REBALANCE" && decision.rebalanceParams) {
            const pos = trackedPositions.get(poolAddress);
            if (pos?.positionPubKey) {
              const result = await adapter.rebalancePosition(
                poolAddress,
                pos.positionPubKey,
                decision.rebalanceParams.newLowerBinId,
                decision.rebalanceParams.newUpperBinId
              );
              if (result) {
                trackedPositions.set(poolAddress, {
                  ...pos,
                  positionPubKey: result.newPositionPubKey,
                  lowerBinId: decision.rebalanceParams.newLowerBinId,
                  upperBinId: decision.rebalanceParams.newUpperBinId,
                });
                lastRebalanceTime.set(poolAddress, Date.now());
                log.info("Live position rebalanced", {
                  pool: poolAddress,
                  newPosition: result.newPositionPubKey,
                  txs: result.txSignatures,
                });
              } else {
                log.error("Live REBALANCE failed", { pool: poolAddress });
              }
            } else {
              log.warn("No live position to rebalance", { pool: poolAddress });
            }
          }
        }
      } catch (err) {
        log.error("Error processing pool", { pool: poolAddress, err });
      }
    }

    cycle.completedAt = Date.now();
    const durationMs = cycle.completedAt - cycle.startedAt;
    const durationSec = (durationMs / 1000).toFixed(1);
    log.info("Scan cycle complete", {
      cycleId: cycle.cycleId,
      scanned: cycle.poolsScanned,
      actioned: cycle.poolsActioned,
      durationSec,
    });

    if (durationMs > config.SCAN_INTERVAL_MS) {
      log.warn("Scan cycle exceeded configured interval", {
        cycleId: cycle.cycleId,
        durationMs,
        intervalMs: config.SCAN_INTERVAL_MS,
      });
    }

    try {
      const pruned = await memory.pruneExpired();
      if (pruned > 0) {
        log.info("Pruned expired memories after scan cycle", {
          cycleId: cycle.cycleId,
          count: pruned,
        });
      }
    } catch (err) {
      log.warn("Post-cycle memory prune failed", {
        cycleId: cycle.cycleId,
        err,
      });
    }
  };

  let cycleInFlight = false;
  let skippedCycles = 0;

  const tick = async () => {
    if (cycleInFlight) {
      skippedCycles++;
      log.warn("Skipping scan cycle because the previous cycle is still running", {
        skippedCycles,
      });
      return;
    }

    cycleInFlight = true;
    try {
      await runScanCycle();
    } finally {
      cycleInFlight = false;
    }
  };

  await tick();
  log.info(`Next scan in ${config.SCAN_INTERVAL_MS / 60000} minutes`);
  setInterval(() => {
    void tick();
  }, config.SCAN_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
