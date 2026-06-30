import { describe, it, expect } from "vitest";
import { estimateRecoveryProbability, shouldHoldForRecovery } from "../engine/strategy-service.js";

describe("estimateRecoveryProbability (F4 OOR recovery)", () => {
  it("returns neutral 0.5 for empty history (no signal)", () => {
    const p = estimateRecoveryProbability([], 5);
    expect(p).toBeCloseTo(0.5);
  });

  it("returns high probability for a mean-reverting series", () => {
    // oscillates: 5000, 5050, 4950, 5040, 4960, 5030, 4970
    // mean ~ 5000, |Δ| small → mean-reverting → high recovery prob
    const p = estimateRecoveryProbability([5000, 5050, 4950, 5040, 4960, 5030, 4970], 10);
    expect(p).toBeGreaterThan(0.6);
  });

  it("returns low probability for a trending (drifting) series", () => {
    // monotonic upward drift → unlikely to revert in the short term
    // |Δ|=20 per step but current drift=100 → ratio = 20/(20+100) = 0.167
    const p = estimateRecoveryProbability([5000, 5020, 5040, 5060, 5080, 5100, 5120], 100);
    expect(p).toBeLessThan(0.3);
  });

  it("increases with shorter drift relative to mean-reversion amplitude", () => {
    // strong oscillation around mean → very high recovery
    const p = estimateRecoveryProbability([5000, 5100, 4900, 5100, 4900, 5100], 5);
    expect(p).toBeGreaterThan(0.7);
  });

  it("decreases when current drift exceeds the mean-reversion amplitude", () => {
    // tiny oscillation but very large current drift → unlikely to revert
    const p = estimateRecoveryProbability([5000, 5002, 4998, 5001, 4999], 100);
    expect(p).toBeLessThan(0.4);
  });
});

describe("shouldHoldForRecovery (F4 decision helper)", () => {
  it("returns HOLD when probability exceeds hold threshold", () => {
    expect(shouldHoldForRecovery(0.7, 0.6, 0.2)).toBe(true);
  });

  it("returns REBALANCE when probability below force threshold", () => {
    expect(shouldHoldForRecovery(0.1, 0.6, 0.2)).toBe(false);
  });

  it("returns REBALANCE when probability is in the gray zone", () => {
    expect(shouldHoldForRecovery(0.4, 0.6, 0.2)).toBe(false);
  });

  it("HOLD wins ties at hold threshold", () => {
    expect(shouldHoldForRecovery(0.6, 0.6, 0.2)).toBe(true);
  });
});