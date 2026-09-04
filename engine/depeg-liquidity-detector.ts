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

function stablePairLegs(
  tokenX: string,
  tokenY: string,
  stablecoinMints: ReadonlySet<string> | undefined,
): ReadonlyArray<string> {
  if (stablecoinMints === undefined) return [];
  return [tokenX, tokenY].filter((mint) => stablecoinMints.has(mint));
}

function stablecoinDeviation(tokenMint: string, tokenX: string, currentPrice: number): number {
  const price = tokenMint === tokenX ? currentPrice : 1 / currentPrice;
  return Math.abs(price - 1);
}

function findDepegSignal(
  legs: ReadonlyArray<string>,
  tokenX: string,
  currentPrice: number,
  absoluteThreshold: number,
  relativeThreshold: number,
): { readonly tokenMint: string; readonly deviationUsd: number } | null {
  // Only stable/stable pairs expose a depeg: pool.currentPrice is the ratio
  // between the two legs, so for a volatile/stable pair (e.g. SOL/USDC) the
  // "stablecoin price" derived from it is the volatile asset's price, which
  // would false-trigger a depeg on every cycle. Skip unless both legs are
  // stablecoins. Liquidity-drain detection below is independent and unaffected.
  if (!finitePositive(currentPrice) || legs.length !== 2) return null;
  for (const tokenMint of legs) {
    const deviationUsd = stablecoinDeviation(tokenMint, tokenX, currentPrice);
    if (deviationUsd >= absoluteThreshold || deviationUsd >= relativeThreshold) {
      return { tokenMint, deviationUsd };
    }
  }
  return null;
}

function referenceAt(
  history: ReadonlyArray<PoolSnapshot>,
  lookback: number,
): PoolSnapshot | undefined {
  if (history.length < lookback) return undefined;
  return history[history.length - lookback];
}

function relativeChange(current: number, reference: number): number | null {
  if (!finitePositive(reference)) return null;
  return (current - reference) / reference;
}

function drainSignal(
  tvlPct: number | null,
  volumePct: number | null,
  drainThreshold: number,
): { readonly tvlPct: number; readonly volumePct: number } | null {
  if (tvlPct === null || volumePct === null) return null;
  if (tvlPct > -drainThreshold || volumePct > -drainThreshold) return null;
  return { tvlPct, volumePct };
}

const finitePositive = (value: number): boolean => Number.isFinite(value) && value > 0;

export function detectDepegAndLiquidityDrain(
  pool: PoolState,
  history: ReadonlyArray<PoolSnapshot>,
  config: DepegLiquidityConfig,
): DepegLiquiditySignals {
  const legs = stablePairLegs(pool.tokenX, pool.tokenY, config.stablecoinMints);
  const depeg = findDepegSignal(
    legs,
    pool.tokenX,
    pool.currentPrice,
    config.depegAbsoluteUsd ?? 0.02,
    config.depegRelativePct ?? 0.02,
  );

  const lookback = Math.max(1, Math.floor(config.liquidityDrainLookbackSnapshots ?? 2));
  const reference = referenceAt(history, lookback);
  const tvlPct = reference === undefined ? null : relativeChange(pool.tvlUsd, reference.tvlUsd);
  const volumePct =
    reference === undefined ? null : relativeChange(pool.volume24hUsd, reference.volume24hUsd);
  const liquidityDrain = drainSignal(tvlPct, volumePct, config.liquidityDrainPct ?? 0.5);

  return { depeg, liquidityDrain };
}
