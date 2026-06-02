import { describe, it, expect } from "vitest";
import { DLMMStrategy } from "../engine/strategy-service.js";
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
  describe("checkVolumeAuthenticity", () => {
    it("returns high score for normal volume", () => {
      const pool = makePool({ tvlUsd: 100_000, volume24hUsd: 30_000, fees24hUsd: 300 });
      const result = DLMMStrategy.checkVolumeAuthenticity(pool);
      expect(result.score).toBeGreaterThanOrEqual(0.8);
      expect(result.flags).toHaveLength(0);
    });

    it("penalizes volume/TVL ratio > 10x", () => {
      const pool = makePool({ tvlUsd: 10_000, volume24hUsd: 200_000, fees24hUsd: 1000 });
      const result = DLMMStrategy.checkVolumeAuthenticity(pool);
      expect(result.score).toBeLessThan(0.8);
      expect(result.flags.some((f: string) => f.includes("suspicious"))).toBe(true);
    });

    it("returns 0 for zero TVL pool", () => {
      const pool = makePool({ tvlUsd: 0 });
      const result = DLMMStrategy.checkVolumeAuthenticity(pool);
      expect(result.score).toBe(0);
    });

    it("flags low-tvl high-volume wash pattern", () => {
      const pool = makePool({ tvlUsd: 2_000, volume24hUsd: 500_000, fees24hUsd: 100 });
      const result = DLMMStrategy.checkVolumeAuthenticity(pool);
      expect(result.score).toBeLessThan(0.3);
      expect(result.flags.some((f: string) => f.includes("wash"))).toBe(true);
    });

    it("flags outlier fee rate (too low)", () => {
      const pool = makePool({ volume24hUsd: 100_000, fees24hUsd: 5 });
      const result = DLMMStrategy.checkVolumeAuthenticity(pool);
      expect(result.flags.some((f: string) => f.includes("outlier"))).toBe(true);
    });

    it("flags outlier fee rate (too high)", () => {
      const pool = makePool({ volume24hUsd: 100_000, fees24hUsd: 5_000 });
      const result = DLMMStrategy.checkVolumeAuthenticity(pool);
      expect(result.flags.some((f: string) => f.includes("outlier"))).toBe(true);
    });

    it("flags elevated vol/tvl ratio", () => {
      const pool = makePool({ tvlUsd: 50_000, volume24hUsd: 300_000 });
      const result = DLMMStrategy.checkVolumeAuthenticity(pool);
      expect(result.score).toBeLessThan(1.0);
      expect(result.flags.some((f: string) => f.includes("elevated"))).toBe(true);
    });
  });

  describe("passesPreFilter", () => {
    it("returns true for valid pool", () => {
      const pool = makePool({ tvlUsd: 100_000 });
      expect(DLMMStrategy.passesPreFilter(pool, 0.8, 0.5)).toBe(true);
    });

    it("returns false for zero TVL", () => {
      const pool = makePool({ tvlUsd: 0 });
      expect(DLMMStrategy.passesPreFilter(pool, 0.8, 0.5)).toBe(false);
    });

    it("returns false for negative auth score", () => {
      const pool = makePool({ tvlUsd: 100_000 });
      expect(DLMMStrategy.passesPreFilter(pool, -0.1, 0.5)).toBe(false);
    });

    it("returns false for negative bin utilization", () => {
      const pool = makePool({ tvlUsd: 100_000 });
      expect(DLMMStrategy.passesPreFilter(pool, 0.8, -0.1)).toBe(false);
    });

    it("respects threshold parameters", () => {
      const pool = makePool({ tvlUsd: 100_000 });
      expect(DLMMStrategy.passesPreFilter(pool, 0.8, 0.5, 200_000, 0.7, 0.3)).toBe(false);
      expect(DLMMStrategy.passesPreFilter(pool, 0.6, 0.2, 50_000, 0.5, 0.1)).toBe(true);
    });
  });

  describe("computeBinUtilization", () => {
    it("returns 1.0 when all bins have liquidity", () => {
      const binArray = makeBinArray();
      const utilization = DLMMStrategy.computeBinUtilization(binArray);
      expect(utilization).toBe(1.0);
    });

    it("returns 0 for empty bin array", () => {
      const binArray: BinArray = {
        lowerBinId: 5000,
        upperBinId: 5040,
        bins: [],
        activeBinId: 5020,
      };
      expect(DLMMStrategy.computeBinUtilization(binArray)).toBe(0);
    });

    it("correctly calculates partial utilization", () => {
      const binArray = makeBinArray();
      binArray.bins.slice(20).forEach((b) => {
        b.reserveX = 0n;
        b.reserveY = 0n;
        b.liquiditySupply = 0n;
      });
      const util = DLMMStrategy.computeBinUtilization(binArray);
      expect(util).toBe(0.5);
    });
  });

  describe("computeFeeIlRatio", () => {
    it("returns high ratio when fees significantly exceed IL", () => {
      const pool = makePool({ fees24hUsd: 1000 });
      const binArray = makeBinArray(5000);
      const ratio = DLMMStrategy.computeFeeIlRatio(pool, binArray);
      expect(ratio).toBeGreaterThan(1.0);
    });
  });

  describe("recommendBinRange", () => {
    it("uses wider range for low bin step", () => {
      const narrow = DLMMStrategy.recommendBinRange(5000, 5);
      const wide = DLMMStrategy.recommendBinRange(5000, 50);
      const narrowWidth = narrow.upperBinId - narrow.lowerBinId;
      const wideWidth = wide.upperBinId - wide.lowerBinId;
      expect(narrowWidth).toBeGreaterThan(wideWidth);
    });

    it("centers range on active bin", () => {
      const range = DLMMStrategy.recommendBinRange(5000, 10);
      const center = (range.lowerBinId + range.upperBinId) / 2;
      expect(center).toBe(5000);
    });
  });
});
