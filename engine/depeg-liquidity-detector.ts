import type { PoolSnapshot, PoolState } from "./types.js";

export interface DepegLiquidityConfig {
  readonly stablecoinMints?: ReadonlySet<string>;
  readonly depegAbsoluteUsd?: number;
  readonly depegRelativePct?: number;
  readonly liquidityDrainPct?: number;
  readonly liquidityDrainLookbackSnapshots?: number;
}

export interface DepegLiquiditySignals {
  readonly depeg: { readonly tokenMint: string; readonly deviationUsd: number } | null;
  readonly liquidityDrain: { readonly tvlPct: number; readonly volumePct: number } | null;
}

const finitePositive = (value: number): boolean => Number.isFinite(value) && value > 0;

export function detectDepegAndLiquidityDrain(
  pool: PoolState,
  history: ReadonlyArray<PoolSnapshot>,
  config: DepegLiquidityConfig,
): DepegLiquiditySignals {
  const stablecoinMints = [pool.tokenX, pool.tokenY].filter(
    (mint) => config.stablecoinMints?.has(mint) === true,
  );
  const depegThreshold = config.depegAbsoluteUsd ?? 0.02;
  const relativeThreshold = config.depegRelativePct ?? 0.02;
  const drainThreshold = config.liquidityDrainPct ?? 0.5;
  const depeg =
    // Only stable/stable pairs expose a depeg: pool.currentPrice is the ratio
    // between the two legs, so for a volatile/stable pair (e.g. SOL/USDC) the
    // "stablecoin price" derived from it is the volatile asset's price, which
    // would false-trigger a depeg on every cycle. Skip unless both legs are
    // stablecoins. Liquidity-drain detection below is independent and unaffected.
    (stablecoinMints.length === 2 ? stablecoinMints : [])
      .map((tokenMint) => {
        const stablecoinPrice =
          tokenMint === pool.tokenX ? pool.currentPrice : 1 / pool.currentPrice;
        return { tokenMint, deviationUsd: Math.abs(stablecoinPrice - 1) };
      })
      .find(
        (signal) =>
          finitePositive(pool.currentPrice) &&
          (signal.deviationUsd >= depegThreshold || signal.deviationUsd >= relativeThreshold),
      ) ?? null;

  const lookback = Math.max(1, Math.floor(config.liquidityDrainLookbackSnapshots ?? 2));
  const reference = history.length >= lookback ? history[history.length - lookback] : undefined;
  const tvlPct =
    reference && finitePositive(reference.tvlUsd)
      ? (pool.tvlUsd - reference.tvlUsd) / reference.tvlUsd
      : null;
  const volumePct =
    reference && finitePositive(reference.volume24hUsd)
      ? (pool.volume24hUsd - reference.volume24hUsd) / reference.volume24hUsd
      : null;
  const liquidityDrain =
    tvlPct !== null &&
    volumePct !== null &&
    tvlPct <= -drainThreshold &&
    volumePct <= -drainThreshold
      ? { tvlPct, volumePct }
      : null;

  return { depeg, liquidityDrain };
}
