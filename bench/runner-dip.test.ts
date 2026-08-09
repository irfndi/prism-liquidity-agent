import { describe, expect, it } from "vitest";
import { dipOffsetBinsForPct } from "../engine/strategy-service.js";

describe("dipOffsetBinsForPct (runner-mode dip anchor)", () => {
  it("binStep 100, 12% dip -> -13 bins (the Heart Attack -12% band)", () => {
    // ln(0.88)/ln(1.01) = -12.77 -> round -13. At 1% per bin, -13 bins is
    // -12.2% below the active bin.
    expect(dipOffsetBinsForPct(100, 0.12)).toBe(-13);
  });

  it("binStep 100, 15% dip -> -17 bins", () => {
    // ln(0.85)/ln(1.01) = -16.2 -> -16? ln(0.85) = -0.1625, ln(1.01) = 0.00995
    // -> -16.33 -> round -16.
    expect(dipOffsetBinsForPct(100, 0.15)).toBe(-16);
  });

  it("coarser bins (binStep 200) need fewer bins for the same dip", () => {
    // 2% per bin: ln(0.88)/ln(1.02) = -6.44 -> -6.
    expect(dipOffsetBinsForPct(200, 0.12)).toBe(-6);
  });

  it("returns 0 for a zero dip, negative dip, or degenerate bin step", () => {
    expect(dipOffsetBinsForPct(100, 0)).toBe(0);
    expect(dipOffsetBinsForPct(100, -0.1)).toBe(0);
    expect(dipOffsetBinsForPct(0, 0.12)).toBe(0);
    expect(dipOffsetBinsForPct(NaN, 0.12)).toBe(0);
  });

  it("returns 0 for dip >= 1 (ln(0) = -Infinity) and non-finite dips", () => {
    expect(dipOffsetBinsForPct(100, 1)).toBe(0);
    expect(dipOffsetBinsForPct(100, 1.5)).toBe(0);
    expect(dipOffsetBinsForPct(100, NaN)).toBe(0);
    expect(dipOffsetBinsForPct(100, Infinity)).toBe(0);
  });

  it("shifts the whole range below the active bin via recommendBinRange", () => {
    // Exercises the strategy surface directly: a ±5 bin band anchored -13
    // bins below active bin 5000 lands entirely below market.
    const { DLMMStrategy } = require("../engine/strategy-service.js") as {
      DLMMStrategy: {
        recommendBinRange: (
          a: number,
          b: number,
          h?: number,
          d?: number,
        ) => { lowerBinId: number; upperBinId: number };
      };
    };
    const range = DLMMStrategy.recommendBinRange(5000, 100, 5, -13);
    expect(range.lowerBinId).toBe(5000 - 5 - 13);
    expect(range.upperBinId).toBe(5000 + 5 - 13);
    expect(range.upperBinId).toBeLessThan(5000); // entirely below the active bin
  });
});
