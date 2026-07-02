import { describe, it, expect } from "vitest";
import {
  computeBinVolatilityStddev,
  isHighVolatility,
  recommendBinRangeForVolatility,
} from "../engine/strategy-service.js";

describe("computeBinVolatilityStddev (F2)", () => {
  it("returns 0 for a single observation", () => {
    expect(computeBinVolatilityStddev([5000])).toBe(0);
  });

  it("returns 0 for an empty series", () => {
    expect(computeBinVolatilityStddev([])).toBe(0);
  });

  it("returns 0 for a perfectly stable series", () => {
    expect(computeBinVolatilityStddev([5000, 5000, 5000, 5000])).toBe(0);
  });

  it("computes stddev correctly for a small drift series", () => {
    // values [5000, 5001, 5002] → mean=5001, deviations [-1,0,1]
    // sample variance = 2 / (3-1) = 1, sample stddev = 1
    const s = computeBinVolatilityStddev([5000, 5001, 5002]);
    expect(s).toBeCloseTo(1, 5);
  });

  it("computes larger stddev for a high-volatility series", () => {
    // [5000, 5050, 4950, 5080, 4920] — wildly oscillating
    const s = computeBinVolatilityStddev([5000, 5050, 4950, 5080, 4920]);
    expect(s).toBeGreaterThan(50);
  });

  it("treats outlier gracefully (does not divide by zero)", () => {
    const s = computeBinVolatilityStddev([0, 1, 2]);
    expect(Number.isFinite(s)).toBe(true);
  });
});

describe("isHighVolatility (F2)", () => {
  it("returns false below threshold", () => {
    expect(isHighVolatility(2.5, 5)).toBe(false);
  });

  it("returns true at or above threshold", () => {
    expect(isHighVolatility(5, 5)).toBe(true);
    expect(isHighVolatility(7.2, 5)).toBe(true);
  });
});

describe("recommendBinRangeForVolatility (F2)", () => {
  it("returns tight range for low volatility", () => {
    const r = recommendBinRangeForVolatility(5000, 10, false);
    expect(r.halfWidth).toBe(25); // matches binStep ≤ 10
    expect(r.lowerBinId).toBe(4975);
    expect(r.upperBinId).toBe(5025);
  });

  it("returns wider range when high volatility detected", () => {
    const r = recommendBinRangeForVolatility(5000, 10, true);
    expect(r.halfWidth).toBeGreaterThan(25);
    expect(r.lowerBinId).toBeLessThan(4975);
    expect(r.upperBinId).toBeGreaterThan(5025);
  });

  it("uses ±20 base width for binStep at the 25 breakpoint (low volatility)", () => {
    const r = recommendBinRangeForVolatility(5000, 25, false);
    expect(r.halfWidth).toBe(20);
    expect(r.lowerBinId).toBe(4980);
    expect(r.upperBinId).toBe(5020);
  });

  it("widens to the configured wideHalfWidth for binStep at the 25 breakpoint (high volatility)", () => {
    const r = recommendBinRangeForVolatility(5000, 25, true, 50);
    expect(r.halfWidth).toBe(50);
    expect(r.lowerBinId).toBe(4950);
    expect(r.upperBinId).toBe(5050);
  });

  it("uses ±15 base width for binStep just above the 25 breakpoint (low volatility)", () => {
    const r = recommendBinRangeForVolatility(5000, 26, false);
    expect(r.halfWidth).toBe(15);
    expect(r.lowerBinId).toBe(4985);
    expect(r.upperBinId).toBe(5015);
  });

  it("widens to the configured wideHalfWidth for binStep just above the 25 breakpoint (high volatility)", () => {
    const r = recommendBinRangeForVolatility(5000, 26, true, 50);
    expect(r.halfWidth).toBe(50);
    expect(r.lowerBinId).toBe(4950);
    expect(r.upperBinId).toBe(5050);
  });
});