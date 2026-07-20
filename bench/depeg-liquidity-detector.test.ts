import { describe, expect, it } from "vitest";
import { detectDepegAndLiquidityDrain } from "../engine/depeg-liquidity-detector.js";
import type { PoolSnapshot, PoolState } from "../engine/types.js";

const config = {
  stablecoinMints: new Set(["USDC", "USDT"]),
  depegAbsoluteUsd: 0.02,
  depegRelativePct: 0.02,
  liquidityDrainPct: 0.5,
  liquidityDrainLookbackSnapshots: 2,
};
const pool: PoolState = {
  address: "pool",
  tokenX: "USDC",
  tokenY: "USDT",
  tokenXSymbol: "USDC",
  tokenYSymbol: "USDT",
  tvlUsd: 400,
  volume24hUsd: 400,
  fees24hUsd: 1,
  apr: 1,
  activeBinId: 1,
  binStep: 10,
  currentPrice: 0.97,
  timestamp: 3,
};
const snapshot = (tvlUsd: number, volume24hUsd: number): PoolSnapshot => ({
  poolAddress: "pool",
  timestamp: 1,
  activeBinId: 1,
  tvlUsd,
  volume24hUsd,
  fees24hUsd: 1,
  apr: 1,
  currentPrice: 1,
  binStep: 10,
  tokenXSymbol: "USDC",
  tokenYSymbol: "USDT",
  binArray: { lowerBinId: 0, upperBinId: 1, bins: [], activeBinId: 1 },
});

describe("W15 depeg and liquidity signals", () => {
  it("detects an allowlisted stablecoin depeg at the configured boundary", () => {
    const result = detectDepegAndLiquidityDrain(pool, [], config);
    expect(result.depeg?.tokenMint).toBe("USDC");
  });

  it("does not classify an unallowlisted token or missing history", () => {
    const result = detectDepegAndLiquidityDrain({ ...pool, tokenX: "UNKNOWN" }, [], config);
    expect(result.depeg).toBeNull();
    expect(result.liquidityDrain).toBeNull();
  });

  it("detects a drain only with sufficient TVL and volume history", () => {
    const result = detectDepegAndLiquidityDrain(
      { ...pool, currentPrice: 1 },
      [snapshot(1000, 1000), snapshot(900, 900)],
      { ...config, liquidityDrainPct: 0.1, liquidityDrainLookbackSnapshots: 2 },
    );
    expect(result.liquidityDrain).toEqual({ tvlPct: -0.6, volumePct: -0.6 });
  });
});
