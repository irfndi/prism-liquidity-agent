/**
 * Backtest — replays historical pool data through the DLMM strategy
 * to evaluate decision quality without spending real capital.
 *
 * Two sources:
 *   - synthetic: deterministic mock generator (regression baseline)
 *   - replay:    snapshots stored in SQLite by a live paper run
 *                (set ENABLE_SNAPSHOT_CAPTURE=true on the agent)
 *
 * Usage:
 *   bun run backtest                                          # default: synthetic, 7d
 *   bun run ops/backtest.ts --days 30 --pools <addr1,addr2>
 *   bun run ops/backtest.ts --source replay --db ./prism.db
 */
import { Effect } from "effect";
import { createLogger } from "../engine/logger.js";
import { DLMMStrategy } from "../engine/strategy-service.js";
import { DbLive } from "../engine/db-service.js";
import { DbService } from "../engine/services.js";
import type { BacktestResult, BinArray, PoolSnapshot, PoolState } from "../engine/types.js";

const log = createLogger("Backtest");

// ─── CLI parsing ─────────────────────────────────────────────────────────────

interface CliArgs {
  days: number;
  pools: ReadonlyArray<string>;
  source: "synthetic" | "replay";
  dbPath: string;
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const out: CliArgs = {
    days: 7,
    pools: ["5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6"],
    source: "synthetic",
    dbPath: "./prism.db",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--days" && next) {
      out.days = Number(next);
      i++;
    } else if (a === "--pools" && next) {
      out.pools = next.split(",").map((s) => s.trim()).filter(Boolean);
      i++;
    } else if (a === "--source" && (next === "synthetic" || next === "replay")) {
      out.source = next;
      i++;
    } else if (a === "--db" && next) {
      out.dbPath = next;
      i++;
    }
  }
  return out;
}

// ─── Synthetic data (regression baseline) ────────────────────────────────────

interface HistoryTick {
  pool: PoolState;
  binArray: BinArray;
}

function generateMockHistory(poolAddress: string, days: number, startTvl: number): HistoryTick[] {
  const history: HistoryTick[] = [];
  const intervalMs = 10 * 60 * 1000; // 10 min
  const ticks = (days * 24 * 60 * 60 * 1000) / intervalMs;

  let tvl = startTvl;
  let price = 100;
  let activeBin = 5000;
  let trend = 0;
  let volatility = 0.015;

  for (let i = 0; i < ticks; i++) {
    const timestamp = Date.now() - (ticks - i) * intervalMs;

    if (i % 720 === 0) {
      volatility = 0.005 + Math.random() * 0.025;
      trend = (Math.random() - 0.5) * 0.004;
    }

    if (Math.random() < 0.02) {
      const jump = (Math.random() - 0.5) * 0.08;
      price *= 1 + jump;
      activeBin += Math.floor(jump * 200);
    }

    const shock = (Math.random() - 0.5) * volatility * 2;
    tvl *= 1 + (Math.random() - 0.49) * 0.02;
    price *= 1 + trend + shock;
    activeBin += Math.floor(trend * 200 + shock * 100 + (Math.random() - 0.5) * 10);

    const pool: PoolState = {
      address: poolAddress,
      tokenX: "So11111111111111111111111111111111111111112",
      tokenY: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      tokenXSymbol: "SOL",
      tokenYSymbol: "USDC",
      tvlUsd: Math.max(tvl, 1000),
      volume24hUsd: tvl * (0.3 + Math.random() * 0.5),
      fees24hUsd: tvl * 0.003 * (0.5 + Math.random() * 0.5),
      apr: 40 + Math.random() * 80,
      activeBinId: activeBin,
      binStep: 10,
      currentPrice: price,
      timestamp,
    };

    const bins = Array.from({ length: 40 }, (_, j) => ({
      binId: activeBin - 20 + j,
      price: price * (1 + (j - 20) * 0.001),
      reserveX: BigInt(Math.floor(Math.random() * 1e9)),
      reserveY: BigInt(Math.floor(Math.random() * 1e9)),
      liquiditySupply: BigInt(Math.floor(Math.random() * 1e12)),
    }));

    const binArray: BinArray = {
      lowerBinId: activeBin - 20,
      upperBinId: activeBin + 20,
      bins,
      activeBinId: activeBin,
    };

    history.push({ pool, binArray });
  }

  return history;
}

// ─── Snapshot loading (replay source) ─────────────────────────────────────────

async function loadSnapshots(
  dbPath: string,
  pool: string,
  endMs: number,
  days: number,
): Promise<ReadonlyArray<PoolSnapshot>> {
  const layer = DbLive(dbPath);
  const startMs = endMs - days * 24 * 60 * 60 * 1000;
  const effect = Effect.gen(function* () {
    const db = yield* DbService;
    return yield* db.getSnapshots(pool, startMs, endMs);
  });
  try {
    return await Effect.runPromise(Effect.provide(effect, layer));
  } catch (err) {
    log.error("Failed to load snapshots", { pool, dbPath, err });
    return [];
  }
}

// ─── Strategy params + run loop (shared by both sources) ─────────────────────

interface BacktestConfig {
  halfWidth: number;
  driftThreshold: number;
  minHoldTicks: number;
  minNetBenefitUsd: number;
  maxRebalances: number;
}

function runBacktestFromTicks(
  ticks: ReadonlyArray<HistoryTick>,
  cfg: BacktestConfig,
): BacktestResult {
  const strategy = DLMMStrategy;
  const initialValue = 10_000;
  let portfolioValue = initialValue;
  let rebalances = 0;
  let wins = 0;
  let totalFees = 0;
  let totalIl = 0;

  if (ticks.length === 0) {
    throw new Error("Empty history");
  }

  let previousTvl = ticks[0]!.pool.tvlUsd;
  let currentLowerBinId = ticks[0]!.pool.activeBinId - cfg.halfWidth;
  let currentUpperBinId = ticks[0]!.pool.activeBinId + cfg.halfWidth;
  let hasPosition = true;
  let lastRebalanceTick = -cfg.minHoldTicks;

  for (let i = 0; i < ticks.length; i++) {
    const tick = ticks[i]!;
    const metrics = strategy.computeMetrics(tick.pool, tick.binArray, previousTvl);
    const auth = strategy.checkVolumeAuthenticity(tick.pool);
    if (
      !strategy.passesPreFilter(
        tick.pool,
        auth.score,
        metrics.binUtilization,
        50_000,
        0.7,
        0.3,
      )
    ) {
      previousTvl = tick.pool.tvlUsd;
      continue;
    }

    const inRange =
      tick.pool.activeBinId >= currentLowerBinId && tick.pool.activeBinId <= currentUpperBinId;
    const feesThisTick = inRange ? tick.pool.fees24hUsd / (24 * 6) : 0;
    totalFees += feesThisTick;
    portfolioValue += feesThisTick;

    const positionCenter = (currentLowerBinId + currentUpperBinId) / 2;
    const positionHalfWidth = (currentUpperBinId - currentLowerBinId) / 2 || 1;
    const binDrift = Math.abs(tick.pool.activeBinId - positionCenter) / positionHalfWidth;

    const ticksSinceRebalance = i - lastRebalanceTick;
    const canRebalance =
      hasPosition && rebalances < cfg.maxRebalances && ticksSinceRebalance >= cfg.minHoldTicks;

    if (canRebalance && binDrift > cfg.driftThreshold) {
      const ilCost = portfolioValue * 0.001 * binDrift;
      const swapCost = portfolioValue * 0.0005;
      const totalCost = ilCost + swapCost;
      const expectedFeesAhead = feesThisTick * cfg.minHoldTicks * 0.7;
      const netBenefit = expectedFeesAhead - totalCost;

      if (netBenefit > cfg.minNetBenefitUsd) {
        rebalances++;
        totalIl += totalCost;
        portfolioValue -= totalCost;
        currentLowerBinId = tick.pool.activeBinId - cfg.halfWidth;
        currentUpperBinId = tick.pool.activeBinId + cfg.halfWidth;
        lastRebalanceTick = i;
        let feesInNextWindow = 0;
        for (let j = i + 1; j < Math.min(i + cfg.minHoldTicks, ticks.length); j++) {
          const nextTick = ticks[j]!;
          const nextInRange =
            nextTick.pool.activeBinId >= currentLowerBinId &&
            nextTick.pool.activeBinId <= currentUpperBinId;
          if (nextInRange) feesInNextWindow += nextTick.pool.fees24hUsd / (24 * 6);
        }
        if (feesInNextWindow > totalCost) wins++;
      }
    } else if (binDrift > 0.9 && hasPosition) {
      totalIl += portfolioValue * 0.002;
      portfolioValue *= 0.998;
      hasPosition = false;
    }

    previousTvl = tick.pool.tvlUsd;
  }

  const returns = ticks.map((_, i) => {
    if (i === 0) return 0;
    return (ticks[i]?.pool.fees24hUsd ?? 0) / (ticks[i - 1]?.pool.tvlUsd ?? 1);
  });
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
  const sharpe = variance > 0 ? mean / Math.sqrt(variance) : 0;

  return {
    poolAddress: ticks[0]!.pool.address,
    startDate: ticks[0]!.pool.timestamp,
    endDate: ticks[ticks.length - 1]!.pool.timestamp,
    initialValueUsd: initialValue,
    finalValueUsd: portfolioValue,
    totalFeesUsd: totalFees,
    totalIlUsd: totalIl,
    netPnlUsd: portfolioValue - initialValue,
    totalRebalances: rebalances,
    winRate: rebalances > 0 ? wins / rebalances : 0,
    sharpeRatio: sharpe,
  };
}

function snapshotsToTicks(snaps: ReadonlyArray<PoolSnapshot>): HistoryTick[] {
  return snaps.map((s) => {
    const pool: PoolState = {
      address: s.poolAddress,
      tokenX: "",
      tokenY: "",
      tokenXSymbol: s.tokenXSymbol,
      tokenYSymbol: s.tokenYSymbol,
      tvlUsd: s.tvlUsd,
      volume24hUsd: s.volume24hUsd,
      fees24hUsd: s.fees24hUsd,
      apr: s.apr,
      activeBinId: s.activeBinId,
      binStep: s.binStep,
      currentPrice: s.currentPrice,
      timestamp: s.timestamp,
    };
    return { pool, binArray: s.binArray };
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));

const configs: ReadonlyArray<{ name: string; cfg: BacktestConfig }> = [
  { name: "C1-conservative", cfg: { halfWidth: 25, driftThreshold: 0.75, minHoldTicks: 144, minNetBenefitUsd: 15, maxRebalances: 20 } },
  { name: "C2-balanced",     cfg: { halfWidth: 20, driftThreshold: 0.65, minHoldTicks: 72,  minNetBenefitUsd: 10, maxRebalances: 30 } },
  { name: "C3-aggressive",   cfg: { halfWidth: 15, driftThreshold: 0.55, minHoldTicks: 36,  minNetBenefitUsd: 5,  maxRebalances: 50 } },
  { name: "C4-wide-patient", cfg: { halfWidth: 35, driftThreshold: 0.8,  minHoldTicks: 288, minNetBenefitUsd: 25, maxRebalances: 10 } },
];

for (const pool of args.pools) {
  console.log(`\n=== Pool: ${pool} (source=${args.source}, days=${args.days}) ===\n`);

  let ticks: HistoryTick[];
  if (args.source === "synthetic") {
    ticks = generateMockHistory(pool, args.days, 100_000);
  } else {
    const endMs = Date.now();
    const snaps = await loadSnapshots(args.dbPath, pool, endMs, args.days);
    if (snaps.length === 0) {
      console.log(
        `  no snapshots for ${pool} in last ${args.days}d (db=${args.dbPath}). ` +
          `Did you run the agent with ENABLE_SNAPSHOT_CAPTURE=true?`,
      );
      continue;
    }
    ticks = snapshotsToTicks(snaps);
    console.log(`  loaded ${snaps.length} snapshots from ${args.dbPath}`);
  }

  const results = configs.map(({ name, cfg }) => ({
    name,
    result: runBacktestFromTicks(ticks, cfg),
  }));

  const table = results.map(({ name, result: r }) => ({
    Config: name,
    "Net PnL": `$${r.netPnlUsd.toFixed(0)}`,
    Fees: `$${r.totalFeesUsd.toFixed(0)}`,
    IL: `$${r.totalIlUsd.toFixed(0)}`,
    Rebal: r.totalRebalances,
    "Win %": `${(r.winRate * 100).toFixed(0)}%`,
    Sharpe: r.sharpeRatio.toFixed(2),
  }));
  console.table(table);

  const best = results.reduce((best, curr) => {
    if (curr.result.winRate > best.result.winRate) return curr;
    if (curr.result.winRate === best.result.winRate && curr.result.netPnlUsd > best.result.netPnlUsd) {
      return curr;
    }
    return best;
  });

  log.info("Best config", {
    pool,
    config: best.name,
    netPnlUsd: best.result.netPnlUsd.toFixed(2),
    winRate: (best.result.winRate * 100).toFixed(1) + "%",
    rebalances: best.result.totalRebalances,
  });
  console.log(`\n  Best: ${best.name} (net=$${best.result.netPnlUsd.toFixed(0)})`);
}
