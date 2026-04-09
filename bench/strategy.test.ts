import { describe, it, expect, beforeEach } from "vitest";
import { DLMMStrategy } from "../engine/probes/dlmm.js";
import type { PoolState, BinArray } from "../engine/types.js";

function makePool(overrides: Partial<PoolState> = {}): PoolState {
  return {
    address: "TestPool111111111111111111111111111111111111",
    tokenX: "So11111111111111111111111111111111111111112",
    tokenY: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    tokenXSymbol: "SOL",
    tokenYSymbol: "USDC",
    tvlUsd: 100_000,
    volume24hUsd: 30_000,
    fees24hUsd: 300,
    apr: 60,
    activeBinId: 5000,
    binStep: 10,
    currentPrice: 150,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeBinArray(activeBinId = 5000, halfWidth = 20): BinArray {
  const bins = Array.from({ length: halfWidth * 2 }, (_, i) => ({
    binId: activeBinId - halfWidth + i,
    price: 150 + (i - halfWidth) * 0.1,
    reserveX: BigInt(1_000_000),
    reserveY: BigInt(1_000_000),
    liquiditySupply: BigInt(1_000_000_000),
  }));
  return {
    lowerBinId: activeBinId - halfWidth,
    upperBinId: activeBinId + halfWidth,
    bins,
    activeBinId,
  };
}

describe("DLMMStrategy", () => {
  let strategy: DLMMStrategy;

  beforeEach(() => {
    strategy = new DLMMStrategy();
  });

  describe("checkVolumeAuthenticity", () => {
    it("returns high score for normal volume", () => {
      const pool = makePool({ tvlUsd: 100_000, volume24hUsd: 30_000, fees24hUsd: 300 });
      const result = strategy.checkVolumeAuthenticity(pool);
      expect(result.score).toBeGreaterThanOrEqual(0.8);
      expect(result.flags).toHaveLength(0);
    });

    it("penalizes volume/TVL ratio > 10x", () => {
      const pool = makePool({ tvlUsd: 10_000, volume24hUsd: 200_000, fees24hUsd: 1000 });
      const result = strategy.checkVolumeAuthenticity(pool);
      expect(result.score).toBeLessThan(0.8);
      expect(result.flags.some((f) => f.includes("suspicious"))).toBe(true);
    });

    it("returns 0 for zero TVL pool", () => {
      const pool = makePool({ tvlUsd: 0 });
      const result = strategy.checkVolumeAuthenticity(pool);
      expect(result.score).toBe(0);
    });

    it("flags low-tvl high-volume wash pattern", () => {
      const pool = makePool({ tvlUsd: 2_000, volume24hUsd: 500_000, fees24hUsd: 100 });
      const result = strategy.checkVolumeAuthenticity(pool);
      expect(result.score).toBeLessThan(0.3);
      expect(result.flags.some((f) => f.includes("wash"))).toBe(true);
    });
  });

  describe("computeBinUtilization", () => {
    it("returns 1.0 when all bins have liquidity", () => {
      const binArray = makeBinArray();
      const utilization = strategy.computeBinUtilization(binArray);
      expect(utilization).toBe(1.0);
    });

    it("returns 0 for empty bin array", () => {
      const binArray: BinArray = {
        lowerBinId: 5000,
        upperBinId: 5040,
        bins: [],
        activeBinId: 5020,
      };
      expect(strategy.computeBinUtilization(binArray)).toBe(0);
    });

    it("correctly calculates partial utilization", () => {
      const binArray = makeBinArray();
      // Zero out half the bins
      binArray.bins.slice(20).forEach((b) => {
        b.reserveX = 0n;
        b.reserveY = 0n;
      });
      const util = strategy.computeBinUtilization(binArray);
      expect(util).toBe(0.5);
    });
  });

  describe("computeFeeIlRatio", () => {
    it("returns high ratio when fees significantly exceed IL", () => {
      const pool = makePool({ fees24hUsd: 1000 });
      const binArray = makeBinArray(5000); // active at center
      const ratio = strategy.computeFeeIlRatio(pool, binArray);
      expect(ratio).toBeGreaterThan(1.0);
    });
  });

  describe("passesPreFilter", () => {
    it("rejects pools below minimum TVL", () => {
      // config.MIN_POOL_TVL_USD defaults to 50000
      const pool = makePool({ tvlUsd: 10_000 });
      expect(strategy.passesPreFilter(pool, 0.9, 0.8)).toBe(false);
    });

    it("rejects pools with low volume authenticity", () => {
      const pool = makePool({ tvlUsd: 100_000 });
      expect(strategy.passesPreFilter(pool, 0.5, 0.8)).toBe(false);
    });

    it("passes pools meeting all criteria", () => {
      const pool = makePool({ tvlUsd: 100_000 });
      expect(strategy.passesPreFilter(pool, 0.9, 0.8)).toBe(true);
    });
  });

  describe("recommendBinRange", () => {
    it("uses wider range for low bin step", () => {
      const narrow = strategy.recommendBinRange(5000, 5);
      const wide = strategy.recommendBinRange(5000, 50);
      const narrowWidth = narrow.upperBinId - narrow.lowerBinId;
      const wideWidth = wide.upperBinId - wide.lowerBinId;
      expect(narrowWidth).toBeGreaterThan(wideWidth);
    });

    it("centers range on active bin", () => {
      const range = strategy.recommendBinRange(5000, 10);
      const center = (range.lowerBinId + range.upperBinId) / 2;
      expect(center).toBe(5000);
    });
  });
});

