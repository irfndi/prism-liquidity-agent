import { describe, it, expect } from "vitest";
import { convertClaimFeesToUsd, tokenAmountToUsd, getTokenDecimals } from "../engine/risk-service.js";

describe("getTokenDecimals", () => {
  it("returns 9 for SOL and wrapped SOL", () => {
    expect(getTokenDecimals("SOL")).toBe(9);
    expect(getTokenDecimals("WSOL")).toBe(9);
  });

  it("returns 6 for USDC and USDT", () => {
    expect(getTokenDecimals("USDC")).toBe(6);
    expect(getTokenDecimals("USDT")).toBe(6);
  });

  it("returns -1 sentinel for unknown tokens (fail-closed)", () => {
    expect(getTokenDecimals("???")).toBe(-1);
    expect(getTokenDecimals("")).toBe(-1);
    expect(getTokenDecimals("BONK")).toBe(-1);
  });
});

describe("tokenAmountToUsd", () => {
  it("converts SOL raw amount to USD using solPriceUsd", () => {
    // 1.5 SOL raw = 1.5e9 lamports; solPrice = $150 → $225
    expect(tokenAmountToUsd(1_500_000_000, "SOL", 150)).toBeCloseTo(225);
  });

  it("converts USDC raw amount using par ($1)", () => {
    // 100 USDC raw = 100e6 base units → $100
    expect(tokenAmountToUsd(100_000_000, "USDC", 150)).toBeCloseTo(100);
  });

  it("treats USDT same as USDC", () => {
    expect(tokenAmountToUsd(50_000_000, "USDT", 150)).toBeCloseTo(50);
  });

  it("returns 0 for unknown tokens (fail-closed — do not estimate)", () => {
    expect(tokenAmountToUsd(2_000_000_000, "???", 150)).toBe(0);
    expect(tokenAmountToUsd(1_000_000_000, "BONK", 150)).toBe(0);
  });

  it("returns 0 for zero raw amount", () => {
    expect(tokenAmountToUsd(0, "SOL", 150)).toBe(0);
  });
});

describe("convertClaimFeesToUsd", () => {
  it("sums SOL + USDC fees using correct decimals per token", () => {
    // 0.5 SOL ($75 at $150) + 100 USDC ($100) = $175
    const usd = convertClaimFeesToUsd({
      netFeeXRaw: 500_000_000,
      netFeeYRaw: 100_000_000,
      tokenXSymbol: "SOL",
      tokenYSymbol: "USDC",
      solPriceUsd: 150,
    });
    expect(usd).toBeCloseTo(175);
  });

  it("handles reversed token order (USDC as X, SOL as Y)", () => {
    // 100 USDC ($100) + 0.5 SOL ($75) = $175
    const usd = convertClaimFeesToUsd({
      netFeeXRaw: 100_000_000,
      netFeeYRaw: 500_000_000,
      tokenXSymbol: "USDC",
      tokenYSymbol: "SOL",
      solPriceUsd: 150,
    });
    expect(usd).toBeCloseTo(175);
  });

  it("returns 0 when both fees are zero", () => {
    expect(
      convertClaimFeesToUsd({
        netFeeXRaw: 0,
        netFeeYRaw: 0,
        tokenXSymbol: "SOL",
        tokenYSymbol: "USDC",
        solPriceUsd: 150,
      }),
    ).toBe(0);
  });

  it("does NOT multiply SOL lamports by solPrice (the bug we're fixing)", () => {
    // Old buggy formula: (netFeeX + netFeeY) * solPrice
    // For 1 SOL + 100 USDC: (1e9 + 1e8) * 150 = 165 BILLION
    // Correct: 150 + 100 = 250
    const usd = convertClaimFeesToUsd({
      netFeeXRaw: 1_000_000_000,
      netFeeYRaw: 100_000_000,
      tokenXSymbol: "SOL",
      tokenYSymbol: "USDC",
      solPriceUsd: 150,
    });
    expect(usd).toBeLessThan(1000); // proves we're not producing billions
    expect(usd).toBeCloseTo(250);
  });

  it("returns 0 when X token is unknown (fail-closed)", () => {
    const usd = convertClaimFeesToUsd({
      netFeeXRaw: 1_000_000_000,
      netFeeYRaw: 100_000_000,
      tokenXSymbol: "BONK",
      tokenYSymbol: "USDC",
      solPriceUsd: 150,
    });
    expect(usd).toBe(0);
  });

  it("returns 0 when Y token is unknown (fail-closed)", () => {
    const usd = convertClaimFeesToUsd({
      netFeeXRaw: 1_000_000_000,
      netFeeYRaw: 100_000_000,
      tokenXSymbol: "SOL",
      tokenYSymbol: "WIF",
      solPriceUsd: 150,
    });
    expect(usd).toBe(0);
  });
});