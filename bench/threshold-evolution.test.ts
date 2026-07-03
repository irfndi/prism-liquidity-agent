import { describe, it, expect } from "vitest";
import {
  nudgeThreshold,
  computeSignalLift,
  evolveThresholds,
} from "../engine/strategy-service.js";
import type { EvolvableThresholds, OutcomeRecord } from "../engine/strategy-service.js";

// ─── nudgeThreshold ─────────────────────────────────────────────────────────

describe("nudgeThreshold", () => {
  it("nudges upward when target > current, clamped to ±maxChangePct", () => {
    const result = nudgeThreshold(1.2, 1.5, 0.20);
    expect(result).toBeCloseTo(1.44, 10);
  });

  it("returns target when it is within the maxChangePct band", () => {
    const result = nudgeThreshold(1.2, 1.3, 0.20);
    expect(result).toBeCloseTo(1.3, 10);
  });

  it("clamps downward when target < current", () => {
    const result = nudgeThreshold(1.2, 1.0, 0.20);
    expect(result).toBeCloseTo(1.0, 10);
  });

  it("returns current when target === current", () => {
    const result = nudgeThreshold(1.2, 1.2, 0.20);
    expect(result).toBe(1.2);
  });

  it("handles zero current value by returning target", () => {
    const result = nudgeThreshold(0, 1.5, 0.20);
    expect(result).toBe(1.5);
  });

  it("clamps large upward nudge", () => {
    const result = nudgeThreshold(1.0, 5.0, 0.10);
    expect(result).toBeCloseTo(1.1, 10);
  });

  it("clamps large downward nudge", () => {
    const result = nudgeThreshold(1.0, -2.0, 0.10);
    expect(result).toBeCloseTo(0.9, 10);
  });
});

// ─── computeSignalLift ──────────────────────────────────────────────────────

describe("computeSignalLift", () => {
  it("returns positive lift when winners have higher signal values", () => {
    const outcomes: OutcomeRecord[] = [
      { feeIlRatio: 2.0, volumeAuthenticity: 0.9, binUtilization: 0.7, pnlUsd: 50 },
      { feeIlRatio: 1.8, volumeAuthenticity: 0.85, binUtilization: 0.6, pnlUsd: 30 },
      { feeIlRatio: 0.5, volumeAuthenticity: 0.4, binUtilization: 0.2, pnlUsd: -20 },
      { feeIlRatio: 0.3, volumeAuthenticity: 0.3, binUtilization: 0.1, pnlUsd: -40 },
    ];
    const lift = computeSignalLift(outcomes, "feeIlRatio");
    expect(lift).toBeGreaterThan(0);
  });

  it("returns negative lift when winners have lower signal values", () => {
    const outcomes: OutcomeRecord[] = [
      { feeIlRatio: 0.3, volumeAuthenticity: 0.3, binUtilization: 0.1, pnlUsd: 50 },
      { feeIlRatio: 0.4, volumeAuthenticity: 0.4, binUtilization: 0.2, pnlUsd: 30 },
      { feeIlRatio: 2.0, volumeAuthenticity: 0.9, binUtilization: 0.7, pnlUsd: -20 },
      { feeIlRatio: 1.8, volumeAuthenticity: 0.85, binUtilization: 0.6, pnlUsd: -40 },
    ];
    const lift = computeSignalLift(outcomes, "feeIlRatio");
    expect(lift).toBeLessThan(0);
  });

  it("returns 0 when all outcomes are winners", () => {
    const outcomes: OutcomeRecord[] = [
      { feeIlRatio: 2.0, volumeAuthenticity: 0.9, binUtilization: 0.7, pnlUsd: 50 },
      { feeIlRatio: 1.0, volumeAuthenticity: 0.5, binUtilization: 0.4, pnlUsd: 10 },
    ];
    const lift = computeSignalLift(outcomes, "feeIlRatio");
    expect(lift).toBe(0);
  });

  it("returns 0 when all outcomes are losers", () => {
    const outcomes: OutcomeRecord[] = [
      { feeIlRatio: 2.0, volumeAuthenticity: 0.9, binUtilization: 0.7, pnlUsd: -10 },
      { feeIlRatio: 1.0, volumeAuthenticity: 0.5, binUtilization: 0.4, pnlUsd: -20 },
    ];
    const lift = computeSignalLift(outcomes, "feeIlRatio");
    expect(lift).toBe(0);
  });

  it("returns 0 for empty outcomes", () => {
    const lift = computeSignalLift([], "feeIlRatio");
    expect(lift).toBe(0);
  });

  it("works with volumeAuthenticity signal key", () => {
    const outcomes: OutcomeRecord[] = [
      { feeIlRatio: 1.0, volumeAuthenticity: 0.9, binUtilization: 0.5, pnlUsd: 50 },
      { feeIlRatio: 1.0, volumeAuthenticity: 0.3, binUtilization: 0.5, pnlUsd: -20 },
    ];
    const lift = computeSignalLift(outcomes, "volumeAuthenticity");
    expect(lift).toBeGreaterThan(0);
  });

  it("works with binUtilization signal key", () => {
    const outcomes: OutcomeRecord[] = [
      { feeIlRatio: 1.0, volumeAuthenticity: 0.5, binUtilization: 0.8, pnlUsd: 50 },
      { feeIlRatio: 1.0, volumeAuthenticity: 0.5, binUtilization: 0.2, pnlUsd: -20 },
    ];
    const lift = computeSignalLift(outcomes, "binUtilization");
    expect(lift).toBeGreaterThan(0);
  });
});

// ─── evolveThresholds ───────────────────────────────────────────────────────

function makeCurrent(): EvolvableThresholds {
  return {
    minFeeIlRatio: 1.2,
    volumeAuthThreshold: 0.7,
    minBinUtilization: 0.3,
  };
}

describe("evolveThresholds", () => {
  it("returns current unchanged when outcomes < minOutcomes", () => {
    const current = makeCurrent();
    const outcomes: OutcomeRecord[] = [
      { feeIlRatio: 2.0, volumeAuthenticity: 0.9, binUtilization: 0.7, pnlUsd: 50 },
      { feeIlRatio: 0.5, volumeAuthenticity: 0.3, binUtilization: 0.2, pnlUsd: -20 },
    ];
    const result = evolveThresholds(outcomes, current);
    expect(result.changed).toBe(false);
    expect(result.thresholds).toEqual(current);
  });

  it("returns current unchanged when minOutcomes defaults to 5", () => {
    const current = makeCurrent();
    const outcomes: OutcomeRecord[] = Array.from({ length: 4 }, (_, i) => ({
      feeIlRatio: 1.0 + i * 0.1,
      volumeAuthenticity: 0.5 + i * 0.05,
      binUtilization: 0.3 + i * 0.05,
      pnlUsd: i % 2 === 0 ? 10 : -10,
    }));
    const result = evolveThresholds(outcomes, current);
    expect(result.changed).toBe(false);
  });

  it("raises thresholds when higher signals correlate with wins", () => {
    const current = makeCurrent();
    const outcomes: OutcomeRecord[] = [
      { feeIlRatio: 3.0, volumeAuthenticity: 0.95, binUtilization: 0.9, pnlUsd: 100 },
      { feeIlRatio: 2.8, volumeAuthenticity: 0.9, binUtilization: 0.85, pnlUsd: 80 },
      { feeIlRatio: 2.5, volumeAuthenticity: 0.85, binUtilization: 0.8, pnlUsd: 60 },
      { feeIlRatio: 0.3, volumeAuthenticity: 0.2, binUtilization: 0.1, pnlUsd: -50 },
      { feeIlRatio: 0.2, volumeAuthenticity: 0.15, binUtilization: 0.05, pnlUsd: -70 },
      { feeIlRatio: 0.1, volumeAuthenticity: 0.1, binUtilization: 0.02, pnlUsd: -90 },
    ];
    const result = evolveThresholds(outcomes, current, { minOutcomes: 3 });
    expect(result.changed).toBe(true);
    expect(result.thresholds.minFeeIlRatio).toBeGreaterThan(current.minFeeIlRatio);
    expect(result.thresholds.volumeAuthThreshold).toBeGreaterThan(current.volumeAuthThreshold);
    expect(result.thresholds.minBinUtilization).toBeGreaterThan(current.minBinUtilization);
  });

  it("lowers thresholds when lower signals correlate with wins", () => {
    const current = { minFeeIlRatio: 2.0, volumeAuthThreshold: 0.8, minBinUtilization: 0.6 };
    const outcomes: OutcomeRecord[] = [
      { feeIlRatio: 0.3, volumeAuthenticity: 0.2, binUtilization: 0.1, pnlUsd: 100 },
      { feeIlRatio: 0.4, volumeAuthenticity: 0.25, binUtilization: 0.15, pnlUsd: 80 },
      { feeIlRatio: 0.5, volumeAuthenticity: 0.3, binUtilization: 0.2, pnlUsd: 60 },
      { feeIlRatio: 3.0, volumeAuthenticity: 0.9, binUtilization: 0.9, pnlUsd: -50 },
      { feeIlRatio: 2.8, volumeAuthenticity: 0.85, binUtilization: 0.85, pnlUsd: -70 },
      { feeIlRatio: 2.5, volumeAuthenticity: 0.8, binUtilization: 0.8, pnlUsd: -90 },
    ];
    const result = evolveThresholds(outcomes, current, { minOutcomes: 3 });
    expect(result.changed).toBe(true);
    expect(result.thresholds.minFeeIlRatio).toBeLessThan(current.minFeeIlRatio);
    expect(result.thresholds.volumeAuthThreshold).toBeLessThan(current.volumeAuthThreshold);
    expect(result.thresholds.minBinUtilization).toBeLessThan(current.minBinUtilization);
  });

  it("respects maxChangePct clamp on evolution", () => {
    const current = makeCurrent();
    const outcomes: OutcomeRecord[] = [
      { feeIlRatio: 5.0, volumeAuthenticity: 1.0, binUtilization: 1.0, pnlUsd: 100 },
      { feeIlRatio: 5.0, volumeAuthenticity: 1.0, binUtilization: 1.0, pnlUsd: 100 },
      { feeIlRatio: 5.0, volumeAuthenticity: 1.0, binUtilization: 1.0, pnlUsd: 100 },
      { feeIlRatio: 0.1, volumeAuthenticity: 0.05, binUtilization: 0.01, pnlUsd: -100 },
      { feeIlRatio: 0.1, volumeAuthenticity: 0.05, binUtilization: 0.01, pnlUsd: -100 },
      { feeIlRatio: 0.1, volumeAuthenticity: 0.05, binUtilization: 0.01, pnlUsd: -100 },
    ];
    const result = evolveThresholds(outcomes, current, {
      minOutcomes: 3,
      maxChangePct: 0.10,
    });
    expect(result.changed).toBe(true);
    expect(result.thresholds.minFeeIlRatio).toBeLessThanOrEqual(current.minFeeIlRatio * 1.10);
    expect(result.thresholds.volumeAuthThreshold).toBeLessThanOrEqual(
      current.volumeAuthThreshold * 1.10,
    );
    expect(result.thresholds.minBinUtilization).toBeLessThanOrEqual(
      current.minBinUtilization * 1.10,
    );
  });

  it("returns unchanged when all pnlUsd values are 0 (all losers)", () => {
    const current = makeCurrent();
    const outcomes: OutcomeRecord[] = [
      { feeIlRatio: 2.0, volumeAuthenticity: 0.9, binUtilization: 0.7, pnlUsd: 0 },
      { feeIlRatio: 1.0, volumeAuthenticity: 0.5, binUtilization: 0.4, pnlUsd: 0 },
      { feeIlRatio: 0.5, volumeAuthenticity: 0.3, binUtilization: 0.2, pnlUsd: 0 },
    ];
    const result = evolveThresholds(outcomes, current, { minOutcomes: 2 });
    expect(result.changed).toBe(false);
  });

  it("uses custom evolutionInterval option", () => {
    const current = makeCurrent();
    const outcomes: OutcomeRecord[] = [
      { feeIlRatio: 2.0, volumeAuthenticity: 0.9, binUtilization: 0.7, pnlUsd: 50 },
      { feeIlRatio: 0.5, volumeAuthenticity: 0.3, binUtilization: 0.2, pnlUsd: -20 },
    ];
    const result = evolveThresholds(outcomes, current, { minOutcomes: 2 });
    expect(result.changed).toBe(true);
  });
});
