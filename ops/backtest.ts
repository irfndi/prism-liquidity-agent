/**
 * Backtest script — replays historical pool data through the DLMM strategy
 * to evaluate decision quality without spending real capital.
 *
 * Usage: bun run backtest
 */
import { createLogger } from "../engine/logger.js";
import { DLMMStrategy } from "../engine/probes/dlmm.js";
import type { BacktestResult, PoolState, BinArray } from "../engine/types.js";

const log = createLogger("Backtest");

// ─── Mock historical data generator ──────────────────────────────────────────

function generateMockHistory(
  poolAddress: string,
  days: number,
  startTvl: number
): Array<{ pool: PoolState; binArray: BinArray }> {
  const history = [];
  const now = Date.now();
  const intervalMs = 10 * 60 * 1000; // 10 min
  const ticks = (days * 24 * 60 * 60 * 1000) / intervalMs;

  let tvl = startTvl;
  let price = 100;
  let activeBin = 5000;

  for (let i = 0; i < ticks; i++) {
    const timestamp = now - (ticks - i) * intervalMs;

    // Random walk
    tvl *= 1 + (Math.random() - 0.49) * 0.02;
    price *= 1 + (Math.random() - 0.5) * 0.01;
    activeBin += Math.floor((Math.random() - 0.5) * 3);

    const pool: PoolState = {
      address: poolAddress,
      tokenX: "So11111111111111111111111111111111111111112",
      tokenY: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      tokenXSymbol: "SOL",
      tokenYSymbol: "USDC",
      tvlUsd: Math.max(tvl, 1000),
      volume24hUsd: tvl * (0.3 + Math.random() * 0.5),
      fees24hUsd: tvl * 0.001 * (0.3 + Math.random() * 0.5),
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

// ─── Run backtest ─────────────────────────────────────────────────────────────

async function runBacktest(poolAddress: string, days = 30): Promise<BacktestResult> {
  log.info("Starting backtest", { pool: poolAddress, days });

  const strategy = new DLMMStrategy();
  const history = generateMockHistory(poolAddress, days, 100_000);

  let rebalances = 0;
  let wins = 0;
  let totalFees = 0;
  let totalIl = 0;
  const initialValue = 10_000;
  let portfolioValue = initialValue;

  let previousTvl = history[0]?.pool.tvlUsd ?? 100_000;

  for (const tick of history) {
    const metrics = strategy.computeMetrics(tick.pool, tick.binArray, previousTvl);

    // Pre-filter
    const auth = strategy.checkVolumeAuthenticity(tick.pool);
    if (!strategy.passesPreFilter(tick.pool, auth.score)) {
      previousTvl = tick.pool.tvlUsd;
      continue;
    }

    // Simple rule-based simulation (no agent call — pure strategy layer)
    const feeIl = metrics.feeIlRatio;
    const binDrift =
      Math.abs(tick.binArray.activeBinId - (tick.binArray.lowerBinId + tick.binArray.upperBinId) / 2) /
      ((tick.binArray.upperBinId - tick.binArray.lowerBinId) / 2 || 1);

    if (binDrift > 0.6 && feeIl > 1.0) {
      rebalances++;
      const feesThisTick = tick.pool.fees24hUsd / (24 * 6); // per 10-min tick
      const ilThisTick = portfolioValue * 0.0001 * binDrift;
      totalFees += feesThisTick;
      totalIl += ilThisTick;
      portfolioValue += feesThisTick - ilThisTick;
      if (feesThisTick > ilThisTick) wins++;
    } else {
      const feesThisTick = tick.pool.fees24hUsd / (24 * 6);
      totalFees += feesThisTick;
      portfolioValue += feesThisTick;
    }

    previousTvl = tick.pool.tvlUsd;
  }

  const netPnl = portfolioValue - initialValue;
  const winRate = rebalances > 0 ? wins / rebalances : 0;
  const returns = history.map((_, i) => {
    if (i === 0) return 0;
    return (history[i]?.pool.fees24hUsd ?? 0) / (history[i - 1]?.pool.tvlUsd ?? 1);
  });
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
  const sharpe = variance > 0 ? mean / Math.sqrt(variance) : 0;

  const result: BacktestResult = {
    poolAddress,
    startDate: history[0]?.pool.timestamp ?? 0,
    endDate: history[history.length - 1]?.pool.timestamp ?? 0,
    initialValueUsd: initialValue,
    finalValueUsd: portfolioValue,
    totalFeesUsd: totalFees,
    totalIlUsd: totalIl,
    netPnlUsd: netPnl,
    totalRebalances: rebalances,
    winRate,
    sharpeRatio: sharpe,
  };

  log.info("Backtest complete", {
    netPnlUsd: netPnl.toFixed(2),
    totalRebalances: rebalances,
    winRate: (winRate * 100).toFixed(1) + "%",
    sharpeRatio: sharpe.toFixed(3),
  });

  return result;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const testPools = [
  "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6", // SOL/USDC (example)
];

for (const pool of testPools) {
  const result = await runBacktest(pool, 30);
  console.log("\n── Backtest Result ──");
  console.table({
    "Net PnL (USD)": result.netPnlUsd.toFixed(2),
    "Total Fees (USD)": result.totalFeesUsd.toFixed(2),
    "Total IL (USD)": result.totalIlUsd.toFixed(2),
    "Rebalances": result.totalRebalances,
    "Win Rate": (result.winRate * 100).toFixed(1) + "%",
    "Sharpe Ratio": result.sharpeRatio.toFixed(3),
  });
}

