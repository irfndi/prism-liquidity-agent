import { describe, it, expect } from "vitest";
import { DLMMStrategy } from "../engine/strategy-service.js";
import type { BinArray } from "../engine/types.js";
import { makePool } from "./helpers.js";

// ─── Shared fixtures ─────────────────────────────────────────────────────────

/** Bin array as fabricated by the OLD adapter: every bin marked liquid. */
export function makeFabricatedBinArray(activeBinId = 5000, halfWidth = 20): BinArray {
  const bins = Array.from({ length: halfWidth * 2 + 1 }, (_, i) => ({
    binId: activeBinId - halfWidth + i,
    price: 150 * Math.pow(1.001, i - halfWidth),
    reserveX: 0n,
    reserveY: 0n,
    liquiditySupply: 1n, // synthetic marker — every bin counts as active
  }));
  return {
    lowerBinId: activeBinId - halfWidth,
    upperBinId: activeBinId + halfWidth,
    bins,
    activeBinId,
    binStep: 10,
    // Real bin reserves were never fetched — must surface as "unknown".
    reservesKnown: false,
  };
}

/** Bin array with liquidity concentrated in 3 of 41 bins (real reserves). */
export function makeConcentratedBinArray(activeBinId = 5000, halfWidth = 20): BinArray {
  const bins = Array.from({ length: halfWidth * 2 + 1 }, (_, i) => {
    const binId = activeBinId - halfWidth + i;
    const active = Math.abs(binId - activeBinId) <= 1;
    return {
      binId,
      price: 150 * Math.pow(1.001, binId - activeBinId),
      reserveX: active ? 1_000_000n : 0n,
      reserveY: active ? 1_000_000n : 0n,
      liquiditySupply: active ? 1_000_000_000n : 0n,
    };
  });
  return {
    lowerBinId: activeBinId - halfWidth,
    upperBinId: activeBinId + halfWidth,
    bins,
    activeBinId,
    binStep: 10,
    reservesKnown: true,
  };
}

// ─── (i)+(ii) feeIlRatio must be real, not the 999 sentinel ──────────────────

describe("computeFeeIlRatio with real drift data", () => {
  it("(i) low-fee / high-drift pool scores BELOW the default minFeeIlRatio", () => {
    // $50/day fees on $100k TVL; price drifted 3% in one 10-min cycle.
    const pool = makePool({
      tvlUsd: 100_000,
      fees24hUsd: 50,
      currentPrice: 154.5,
      timestamp: 1_800_000_000_000,
    });
    const binArray = makeConcentratedBinArray();
    const ratio = DLMMStrategy.computeFeeIlRatio(pool, binArray, {
      previousPrice: 150,
      previousTimestamp: 1_800_000_000_000 - 600_000,
    });
    // Old code returned the 999 sentinel whenever drift-from-range-center was 0.
    expect(ratio).not.toBe(999);
    expect(ratio).toBeLessThan(1.2); // default MIN_FEE_IL_RATIO
  });

  it("(ii) pools with different fee/drift profiles get DIFFERENT ratios", () => {
    const timestamp = 1_800_000_000_000;
    const calmPool = makePool({
      tvlUsd: 100_000,
      fees24hUsd: 500,
      currentPrice: 150.3,
      timestamp,
    });
    const wildPool = makePool({ tvlUsd: 100_000, fees24hUsd: 50, currentPrice: 157.5, timestamp });
    const binArray = makeConcentratedBinArray();
    const ctx = { previousPrice: 150, previousTimestamp: timestamp - 600_000 };

    const calmRatio = DLMMStrategy.computeFeeIlRatio(calmPool, binArray, ctx);
    const wildRatio = DLMMStrategy.computeFeeIlRatio(wildPool, binArray, ctx);

    expect(calmRatio).not.toBe(wildRatio);
    // High fees + low drift must outrank low fees + high drift.
    expect(calmRatio).toBeGreaterThan(wildRatio);
  });

  it("(ii-b) bin-step proxy varies across pools when no price history exists", () => {
    const pool = makePool({ tvlUsd: 100_000, fees24hUsd: 100 });
    const narrowStep = makeConcentratedBinArray();
    const wideStep: BinArray = { ...makeConcentratedBinArray(), binStep: 100 };
    const narrowRatio = DLMMStrategy.computeFeeIlRatio(pool, narrowStep);
    const wideRatio = DLMMStrategy.computeFeeIlRatio(pool, wideStep);
    expect(narrowRatio).not.toBe(wideRatio);
  });
});

// ─── (iv) bin utilization must not be fabricated to 1.0 ──────────────────────

describe("bin utilization with explicit unknown state", () => {
  it("(iv-a) concentrated real liquidity yields binUtilization < 1", () => {
    const pool = makePool();
    const metrics = DLMMStrategy.computeMetrics(pool, makeConcentratedBinArray(), 0);
    expect(metrics.binUtilization).toBeLessThan(1);
    expect(metrics.binUtilization).toBeCloseTo(3 / 41, 5);
    expect(metrics.binUtilizationKnown).toBe(true);
  });

  it("(iv-b) fabricated bin reserves surface as unknown — never 1.0", () => {
    const pool = makePool();
    const metrics = DLMMStrategy.computeMetrics(pool, makeFabricatedBinArray(), 0);
    expect(metrics.binUtilization).not.toBe(1.0);
    expect(metrics.binUtilizationKnown).toBe(false);
  });

  it("(iv-c) unknown bin utilization skips the pre-filter gate instead of passing it", () => {
    const pool = makePool({ tvlUsd: 100_000 });
    // Old behavior: fabricated 1.0 utilization passed every gate.
    // New behavior: unknown utilization skips the gate (with warning upstream).
    expect(DLMMStrategy.passesPreFilter(pool, 0.9, 0, 50_000, 0.7, 0.3, true, false)).toBe(true);
    // ...but a KNOWN low utilization still fails the gate.
    expect(DLMMStrategy.passesPreFilter(pool, 0.9, 0.1, 50_000, 0.7, 0.3, true, true)).toBe(false);
  });
});
