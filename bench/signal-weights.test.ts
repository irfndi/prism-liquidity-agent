import { describe, it, expect } from "vitest";
import { computeSignalWeights, weightedEntryScore } from "../engine/strategy-service.js";
import type { SignalWeights, PoolMetrics } from "../engine/types.js";
import type { OutcomeRecord } from "../engine/strategy-service.js";

function makeWeights(overrides: Partial<SignalWeights> = {}): SignalWeights {
  return {
    feeIlRatio: 1.0,
    volumeAuthenticity: 1.0,
    binUtilization: 1.0,
    tvlUsd: 1.0,
    tvlVelocity: 1.0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeMetrics(overrides: Partial<PoolMetrics> = {}): PoolMetrics {
  return {
    pool: {
      address: "TestPool",
      tokenX: "SOL",
      tokenY: "USDC",
      tokenXSymbol: "SOL",
      tokenYSymbol: "USDC",
      tvlUsd: 100_000,
      volume24hUsd: 30_000,
      fees24hUsd: 300,
      apr: 0.06,
      activeBinId: 5000,
      binStep: 10,
      currentPrice: 150,
      timestamp: Date.now(),
    },
    binArray: { lowerBinId: 4980, upperBinId: 5020, bins: [], activeBinId: 5000 },
    tvlVelocity: overrides.tvlVelocity ?? 0.1,
    feeIlRatio: overrides.feeIlRatio ?? 1.5,
    volumeAuthenticity: overrides.volumeAuthenticity ?? 0.85,
    binUtilization: overrides.binUtilization ?? 0.6,
    volumeAuthenticityKnown: overrides.volumeAuthenticityKnown ?? true,
    binUtilizationKnown: overrides.binUtilizationKnown ?? true,
  };
}

function makeOutcomes(
  count: number,
  opts?: { winnersHaveHighSignals?: boolean; startDaysAgo?: number },
): OutcomeRecord[] {
  const winnersHigh = opts?.winnersHaveHighSignals ?? true;
  const startDaysAgo = opts?.startDaysAgo ?? 0;
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => {
    const isWinner = i < count / 2;
    const signalBase = winnersHigh ? (isWinner ? 0.9 : 0.2) : isWinner ? 0.2 : 0.9;
    return {
      feeIlRatio: signalBase + i * 0.01,
      volumeAuthenticity: signalBase,
      binUtilization: signalBase,
      pnlUsd: isWinner ? 100 : -50,
      outcomeRecordedAt: now - (startDaysAgo + count - 1 - i) * 24 * 60 * 60 * 1000,
    };
  });
}

// ─── computeSignalWeights ──────────────────────────────────────────────────

describe("computeSignalWeights", () => {
  it("returns current weights unchanged when outcomes < minOutcomes", () => {
    const current = makeWeights();
    const outcomes = makeOutcomes(5);
    const result = computeSignalWeights(outcomes, current, { minOutcomes: 10 });
    expect(result.feeIlRatio).toBe(current.feeIlRatio);
    expect(result.volumeAuthenticity).toBe(current.volumeAuthenticity);
    expect(result.binUtilization).toBe(current.binUtilization);
  });

  it("returns current weights when outcomes array is empty", () => {
    const current = makeWeights();
    const result = computeSignalWeights([], current);
    expect(result).toEqual(current);
  });

  it("adjusts weights when given enough outcomes", () => {
    const current = makeWeights();
    const outcomes = makeOutcomes(20, { winnersHaveHighSignals: true });
    const result = computeSignalWeights(outcomes, current, { minOutcomes: 5 });
    const anyChanged =
      result.feeIlRatio !== 1.0 ||
      result.volumeAuthenticity !== 1.0 ||
      result.binUtilization !== 1.0;
    expect(anyChanged).toBe(true);
  });

  it("clamps weights to the floor", () => {
    const current = makeWeights({ feeIlRatio: 0.31 });
    const outcomes = makeOutcomes(20, { winnersHaveHighSignals: false });
    const result = computeSignalWeights(outcomes, current, {
      minOutcomes: 5,
      weightFloor: 0.3,
      weightCeiling: 2.5,
      decayFactor: 0.5,
      boostFactor: 1.5,
    });
    expect(result.feeIlRatio).toBe(0.3);
  });

  it("clamps weights to the ceiling", () => {
    const current = makeWeights({ feeIlRatio: 2.4 });
    const now = Date.now();
    const outcomes: OutcomeRecord[] = Array.from({ length: 20 }, (_, i) => ({
      feeIlRatio: i === 0 ? 2.0 : 0.3 + i * 0.02,
      volumeAuthenticity: 0.5,
      binUtilization: 0.5,
      pnlUsd: i < 10 ? 100 : -50,
      outcomeRecordedAt: now - i * 24 * 60 * 60 * 1000,
    }));
    const result = computeSignalWeights(outcomes, current, {
      minOutcomes: 5,
      weightFloor: 0.3,
      weightCeiling: 2.5,
      decayFactor: 0.5,
      boostFactor: 1.5,
    });
    expect(result.feeIlRatio).toBe(2.5);
  });

  it("updates the updatedAt timestamp", () => {
    const current = makeWeights({ updatedAt: 0 });
    const outcomes = makeOutcomes(20, { winnersHaveHighSignals: true });
    const result = computeSignalWeights(outcomes, current, { minOutcomes: 5 });
    expect(result.updatedAt).toBeGreaterThan(0);
  });

  it("only uses outcomes within the configured windowDays", () => {
    const current = makeWeights();
    const now = Date.now();
    const outcomes: OutcomeRecord[] = Array.from({ length: 12 }, (_, i) => ({
      feeIlRatio: 0.5 + i * 0.1,
      volumeAuthenticity: 0.5 + i * 0.05,
      binUtilization: 0.5 + i * 0.05,
      pnlUsd: i < 6 ? 100 : -50,
      outcomeRecordedAt: now - i * 10 * 24 * 60 * 60 * 1000,
    }));

    // Winners are the 6 newest (i=0..5, feeIlRatio 0.5..1.0). Older outcomes
    // have higher feeIlRatio but should be excluded by the 60-day window.
    const result = computeSignalWeights(outcomes, current, {
      minOutcomes: 3,
      windowDays: 60,
      boostFactor: 1.05,
      decayFactor: 0.95,
    });

    // The latest signal value is from the newest outcome (feeIlRatio 0.5), which
    // is below the median of the included range, so weights should decay or stay
    // near current. If old high-feeIlRatio outcomes were included, the latest
    // value would appear high and weights would boost.
    expect(result.feeIlRatio).toBeLessThanOrEqual(1.0);
  });

  it("preserves tvlUsd and tvlVelocity weights (not adjusted by signal lift)", () => {
    const current = makeWeights({ tvlUsd: 1.5, tvlVelocity: 0.8 });
    const outcomes = makeOutcomes(20, { winnersHaveHighSignals: true });
    const result = computeSignalWeights(outcomes, current, { minOutcomes: 5 });
    expect(result.tvlUsd).toBe(1.5);
    expect(result.tvlVelocity).toBe(0.8);
  });

  it("filters outcomes by timestamp window regardless of array order", () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    const oldOutcomes: OutcomeRecord[] = Array.from({ length: 10 }, (_, i) => ({
      feeIlRatio: 2.0,
      volumeAuthenticity: 0.9,
      binUtilization: 0.7,
      pnlUsd: i % 2 === 0 ? 100 : -50,
      outcomeRecordedAt: now - (100 - i) * day,
    }));

    const recentOutcomes: OutcomeRecord[] = Array.from({ length: 5 }, (_, i) => ({
      feeIlRatio: 0.1,
      volumeAuthenticity: 0.1,
      binUtilization: 0.1,
      pnlUsd: i % 2 === 0 ? 100 : -50,
      outcomeRecordedAt: now - (5 - i) * day,
    }));

    const current = makeWeights({ feeIlRatio: 1.0 });
    const result = computeSignalWeights([...oldOutcomes, ...recentOutcomes], current, {
      windowDays: 60,
      minOutcomes: 8,
      boostFactor: 1.5,
      decayFactor: 0.5,
      weightFloor: 0.1,
      weightCeiling: 5.0,
    });

    expect(result.feeIlRatio).toBe(1.0);
  });
});

// ─── weightedEntryScore ────────────────────────────────────────────────────

describe("weightedEntryScore", () => {
  it("returns higher scores for better metrics", () => {
    const weights = makeWeights();
    const goodMetrics = makeMetrics({
      feeIlRatio: 2.0,
      volumeAuthenticity: 0.9,
      binUtilization: 0.8,
    });
    const badMetrics = makeMetrics({
      feeIlRatio: 0.5,
      volumeAuthenticity: 0.3,
      binUtilization: 0.2,
    });

    const goodScore = weightedEntryScore(goodMetrics, weights);
    const badScore = weightedEntryScore(badMetrics, weights);
    expect(goodScore).toBeGreaterThan(badScore);
  });

  it("applies feeIlRatio weight correctly", () => {
    const weights = makeWeights({
      feeIlRatio: 2.0,
      volumeAuthenticity: 0,
      binUtilization: 0,
      tvlUsd: 0,
      tvlVelocity: 0,
    });
    const metrics = makeMetrics({ feeIlRatio: 1.5 });
    const score = weightedEntryScore(metrics, weights);
    expect(score).toBeCloseTo(3.0, 10);
  });

  it("applies volumeAuthenticity weight correctly", () => {
    const weights = makeWeights({
      feeIlRatio: 0,
      volumeAuthenticity: 2.0,
      binUtilization: 0,
      tvlUsd: 0,
      tvlVelocity: 0,
    });
    const metrics = makeMetrics({ volumeAuthenticity: 0.85 });
    const score = weightedEntryScore(metrics, weights);
    expect(score).toBeCloseTo(1.7, 10);
  });

  it("applies binUtilization weight correctly", () => {
    const weights = makeWeights({
      feeIlRatio: 0,
      volumeAuthenticity: 0,
      binUtilization: 2.0,
      tvlUsd: 0,
      tvlVelocity: 0,
    });
    const metrics = makeMetrics({ binUtilization: 0.6 });
    const score = weightedEntryScore(metrics, weights);
    expect(score).toBeCloseTo(1.2, 10);
  });

  it("caps TVL contribution at 1.0 for pools with TVL > $1M", () => {
    const weights = makeWeights({
      feeIlRatio: 0,
      volumeAuthenticity: 0,
      binUtilization: 0,
      tvlUsd: 2.0,
      tvlVelocity: 0,
    });
    const metrics = makeMetrics();
    // Override pool.tvlUsd directly via Object.assign since PoolMetrics.pool is readonly-ish
    Object.assign(metrics.pool, { tvlUsd: 5_000_000 });
    const score = weightedEntryScore(metrics, weights);
    expect(score).toBeCloseTo(2.0, 10);
  });

  it("caps the 999 fee/IL sentinel so it cannot dominate the score", () => {
    const weights = makeWeights();
    const normalMetrics = makeMetrics({ feeIlRatio: 1.5 });
    const sentinelMetrics = makeMetrics({ feeIlRatio: 999 });

    const normalScore = weightedEntryScore(normalMetrics, weights);
    const sentinelScore = weightedEntryScore(sentinelMetrics, weights);

    expect(sentinelScore).toBeLessThan(normalScore * 10);
  });
});
