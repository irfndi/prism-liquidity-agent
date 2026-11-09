import { describe, expect, it } from "vitest";
import {
  GAS_RESERVE_LAMPORTS,
  MIN_SOL_FOR_ENTRY_LAMPORTS,
  SOL_ENTRY_TRANSACTION_BUFFER_LAMPORTS,
  SOL_MINT,
} from "../engine/constants.js";
import {
  estimateEntrySolLamports,
  fitEntrySizeToSolBudget,
  freeEntrySolLamports,
  hasNativeSolLeg,
  usdToLamports,
} from "../engine/entry-sol-budget.js";

describe("estimateEntrySolLamports", () => {
  it("covers the full entry with SOL in solFunded mode (worst case) plus overhead and wSOL wrap", () => {
    // $27 entry at $270/SOL ≈ 0.101 SOL; + 0.18 overhead + 0.05 wrap buffer.
    expect(
      estimateEntrySolLamports({
        positionSizeUsd: 27,
        solPriceUsd: 270,
        poolHasSolLeg: true,
        solFunded: true,
      }),
    ).toBe(MIN_SOL_FOR_ENTRY_LAMPORTS + 101_000_000n + SOL_ENTRY_TRANSACTION_BUFFER_LAMPORTS);
  });

  it("skips the wSOL wrap buffer for SOL-funded pools without a SOL leg", () => {
    expect(
      estimateEntrySolLamports({
        positionSizeUsd: 27,
        solPriceUsd: 270,
        poolHasSolLeg: false,
        solFunded: true,
      }),
    ).toBe(MIN_SOL_FOR_ENTRY_LAMPORTS + 101_000_000n);
  });

  it("counts only the SOL leg (half the entry) when not solFunded", () => {
    expect(
      estimateEntrySolLamports({
        positionSizeUsd: 27,
        solPriceUsd: 270,
        poolHasSolLeg: true,
        solFunded: false,
      }),
    ).toBe(MIN_SOL_FOR_ENTRY_LAMPORTS + 50_500_000n + SOL_ENTRY_TRANSACTION_BUFFER_LAMPORTS);
  });

  it("is just the overhead for non-SOL pools outside solFunded mode", () => {
    expect(
      estimateEntrySolLamports({
        positionSizeUsd: 27,
        solPriceUsd: 270,
        poolHasSolLeg: false,
        solFunded: false,
      }),
    ).toBe(MIN_SOL_FOR_ENTRY_LAMPORTS);
  });

  it("never falls below the per-entry SOL floor (0.18) even for a zero-size entry", () => {
    expect(
      estimateEntrySolLamports({
        positionSizeUsd: 0,
        solPriceUsd: 270,
        poolHasSolLeg: false,
        solFunded: true,
      }),
    ).toBe(MIN_SOL_FOR_ENTRY_LAMPORTS);
  });

  it("fails closed to overhead when the SOL price is unknown", () => {
    expect(
      estimateEntrySolLamports({
        positionSizeUsd: 27,
        solPriceUsd: 0,
        poolHasSolLeg: true,
        solFunded: true,
      }),
    ).toBe(MIN_SOL_FOR_ENTRY_LAMPORTS + SOL_ENTRY_TRANSACTION_BUFFER_LAMPORTS);
  });

  it("estimates grow with the position size (10x size, solFunded, SOL-leg pool)", () => {
    const small = estimateEntrySolLamports({
      positionSizeUsd: 27,
      solPriceUsd: 270,
      poolHasSolLeg: true,
      solFunded: true,
    });
    const large = estimateEntrySolLamports({
      positionSizeUsd: 270,
      solPriceUsd: 270,
      poolHasSolLeg: true,
      solFunded: true,
    });
    // (270 − 27)/270 × 1.01 = 0.909 SOL difference.
    expect(large - small).toBe(909_000_000n);
  });
});

describe("fitEntrySizeToSolBudget", () => {
  const base = {
    solPriceUsd: 100,
    poolHasSolLeg: true,
    solFunded: true,
    minSizeUsd: 10,
  } as const;

  it("keeps the desired size when it fits", () => {
    expect(
      fitEntrySizeToSolBudget({ ...base, desiredSizeUsd: 20, freeSolLamports: 2_000_000_000n }),
    ).toBe(20);
  });

  it("shrinks to the largest whole-dollar size the free SOL can fund", () => {
    // fixed 0.23 SOL; 1.07 SOL left ≈ $107 → $105 entry after the 1.01 buffer.
    expect(
      fitEntrySizeToSolBudget({
        ...base,
        desiredSizeUsd: 500,
        freeSolLamports: 1_300_000_000n,
      }),
    ).toBe(105);
  });

  it("returns null when even the floor does not fit", () => {
    expect(
      fitEntrySizeToSolBudget({ ...base, desiredSizeUsd: 500, freeSolLamports: 240_000_000n }),
    ).toBeNull();
  });

  it("never returns a size below the floor or above the desired size", () => {
    const fitted = fitEntrySizeToSolBudget({
      ...base,
      desiredSizeUsd: 12,
      freeSolLamports: 400_000_000n,
    });
    expect(fitted).not.toBeNull();
    expect(fitted).toBeGreaterThanOrEqual(10);
    expect(fitted).toBeLessThanOrEqual(12);
  });

  it("returns null for unusable inputs (price, floor, free SOL)", () => {
    expect(
      fitEntrySizeToSolBudget({ ...base, desiredSizeUsd: 20, solPriceUsd: 0, freeSolLamports: 1n }),
    ).toBeNull();
    expect(
      fitEntrySizeToSolBudget({ ...base, desiredSizeUsd: 20, minSizeUsd: 0, freeSolLamports: 1n }),
    ).toBeNull();
    expect(
      fitEntrySizeToSolBudget({ ...base, desiredSizeUsd: 20, freeSolLamports: 0n }),
    ).toBeNull();
  });
});

describe("freeEntrySolLamports", () => {
  it("reserves the gas reserve for the rest of the cycle", () => {
    expect(freeEntrySolLamports(100_000_000n)).toBe(80_000_000n);
  });

  it("is zero when the balance cannot cover the gas reserve", () => {
    expect(freeEntrySolLamports(GAS_RESERVE_LAMPORTS)).toBe(0n);
    expect(freeEntrySolLamports(0n)).toBe(0n);
  });
});

describe("hasNativeSolLeg", () => {
  it("is true when either leg is native SOL", () => {
    expect(hasNativeSolLeg({ tokenX: SOL_MINT, tokenY: "other" })).toBe(true);
    expect(hasNativeSolLeg({ tokenX: "other", tokenY: SOL_MINT })).toBe(true);
  });

  it("is false for wSOL or non-SOL pairs", () => {
    expect(hasNativeSolLeg({ tokenX: "wSOL-mint", tokenY: "other" })).toBe(false);
    expect(hasNativeSolLeg({ tokenX: null, tokenY: null })).toBe(false);
  });
});

describe("usdToLamports", () => {
  it("converts USD to lamports at the SOL price", () => {
    expect(usdToLamports(1, 100)).toBe(10_000_000n);
  });

  it("rounds up so the estimate never under-counts", () => {
    expect(usdToLamports(0.01, 270)).toBe(37_038n); // 37037.037… → ceil
  });

  it("is zero for non-positive prices or amounts", () => {
    expect(usdToLamports(1, 0)).toBe(0n);
    expect(usdToLamports(0, 100)).toBe(0n);
    expect(usdToLamports(Number.NaN, 100)).toBe(0n);
  });
});
