/** Regime-gate tests: ORCA-inspired herding assessment and the runner-lane
 *  APR self-outlier (euphoria) damper. Pure functions — deterministic. */
import { describe, expect, it } from "vitest";
import {
  assessHerding,
  herdingBlocksEntry,
  isAprSelfOutlier,
  percentileRank,
  pearson,
} from "../engine/regime-gate.js";

/** Deterministic pseudo-random walk in [-1, 1] (no Math.random — reproducible). */
function noise(seed: number, n: number): number[] {
  const out: Array<number> = [];
  let x = seed;
  for (let i = 0; i < n; i += 1) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out.push((x / 2147483648) * 2 - 1);
  }
  return out;
}

describe("pearson", () => {
  it("returns ~1 for perfectly co-moving series", () => {
    const a = [1, 2, 3, 4, 5];
    expect(pearson(a, [10, 20, 30, 40, 50])).toBeCloseTo(1, 10);
  });

  it("returns ~-1 for inverted series", () => {
    const a = [1, 2, 3, 4, 5];
    expect(pearson(a, [5, 4, 3, 2, 1])).toBeCloseTo(-1, 10);
  });

  it("aligns to the trailing common window", () => {
    const short = [1, 2, 3, 4, 5];
    // Long series whose LAST five points are a scaled copy of `short` — the
    // correlation must be computed against those, not the head.
    const long = [100, -50, 7, 23, 10, 20, 30, 40, 50];
    expect(pearson(long, short)).toBeCloseTo(1, 10);
  });

  it("returns null for zero-variance series", () => {
    expect(pearson([1, 1, 1, 1], [1, 2, 3, 4])).toBeNull();
    expect(pearson([1, 2, 3, 4], [0, 0, 0, 0])).toBeNull();
  });

  it("returns null for too-few points", () => {
    expect(pearson([1], [2])).toBeNull();
  });
});

describe("assessHerding", () => {
  it("is unknown below minPairs (fail-open)", () => {
    const m = new Map([
      ["a", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]],
      ["b", noise(1, 12)],
    ]);
    expect(assessHerding(m).known).toBe(false);
  });

  it("skips short series entirely", () => {
    const long = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const m = new Map([
      ["a", long],
      ["b", [1, 2]], // too short — contributes nothing
    ]);
    // Only one usable series → zero pairs → unknown.
    expect(assessHerding(m)).toMatchObject({ known: false, pairCount: 0 });
  });

  it("detects lockstep movement as high correlation and edge density", () => {
    const base = noise(42, 14);
    const m = new Map([
      ["a", base],
      ["b", base.map((v) => v * 2)], // perfectly correlated
      ["c", base.map((v) => v * 3 + 0.01)],
      ["d", base.map((v) => v + 0.001)],
    ]);
    const r = assessHerding(m);
    expect(r.known).toBe(true);
    expect(r.meanCorrelation).toBeGreaterThan(0.9);
    expect(r.edgeDensity).toBe(1);
  });

  it("reports decorrelated pools as low-herding but known", () => {
    const m = new Map<string, number[]>();
    for (let i = 0; i < 8; i += 1) {
      m.set(`p${i}`, noise(1000 + i * 7919, 14));
    }
    const r = assessHerding(m);
    expect(r.known).toBe(true);
    expect(r.edgeDensity).toBeLessThan(0.2);
    expect(Math.abs(r.meanCorrelation)).toBeLessThan(0.4);
  });

  it("caps compared pools at maxPools", () => {
    const m = new Map<string, number[]>();
    for (let i = 0; i < 30; i += 1) {
      m.set(`p${i}`, noise(500 + i, 12));
    }
    const r = assessHerding(m, { maxPools: 5 });
    // C(5,2) = 10 pairs max.
    expect(r.pairCount).toBeLessThanOrEqual(10);
  });
});

describe("herdingBlocksEntry", () => {
  it("never blocks an unknown regime (fail-open)", () => {
    expect(
      herdingBlocksEntry({ known: false, pairCount: 3, meanCorrelation: 1, edgeDensity: 1 }),
    ).toBe(false);
  });

  it("blocks at edge-density threshold or mean-correlation threshold", () => {
    const edgeCase = { known: true, pairCount: 20, meanCorrelation: 0.3, edgeDensity: 0.85 };
    expect(herdingBlocksEntry(edgeCase)).toBe(true);
    const corrCase = { known: true, pairCount: 20, meanCorrelation: 0.65, edgeDensity: 0 };
    expect(herdingBlocksEntry(corrCase)).toBe(true);
    const calm = { known: true, pairCount: 20, meanCorrelation: 0.3, edgeDensity: 0.1 };
    expect(herdingBlocksEntry(calm)).toBe(false);
  });

  it("respects custom thresholds", () => {
    const mid = { known: true, pairCount: 20, meanCorrelation: 0.55, edgeDensity: 0.5 };
    expect(herdingBlocksEntry(mid, { edgeDensityThreshold: 0.4 })).toBe(true);
    expect(herdingBlocksEntry(mid, { meanCorrThreshold: 0.5 })).toBe(true);
    expect(herdingBlocksEntry(mid, { edgeDensityThreshold: 0.9, meanCorrThreshold: 0.7 })).toBe(
      false,
    );
  });
});

describe("percentileRank", () => {
  it("ranks by fraction strictly below", () => {
    expect(percentileRank([1, 2, 3, 4], 3)).toBe(0.5); // 1 and 2 are below
    expect(percentileRank([1, 2, 3, 4], 1)).toBe(0);
    expect(percentileRank([1, 2, 3, 4], 99)).toBe(1);
  });

  it("returns 0.5 on empty samples (no opinion)", () => {
    expect(percentileRank([], 10)).toBe(0.5);
  });
});

describe("isAprSelfOutlier", () => {
  const flatHigh = [800, 850, 900, 820, 880]; // durable yield: everything elevated
  const calmHistory = [30, 25, 40, 35, 28]; // normal pool history

  it("fails open on cold start (<3 prior observations)", () => {
    expect(isAprSelfOutlier({ priorAprs: [500, 600], currentApr: 2000 })).toBe(false);
    expect(isAprSelfOutlier({ priorAprs: [], currentApr: 2000 })).toBe(false);
  });

  it("flags a vertical spike over calm history (top-rank AND >= 2x median)", () => {
    expect(isAprSelfOutlier({ priorAprs: calmHistory, currentApr: 1200 })).toBe(true);
    // Top-rank but only ~1.27x the median → a new high, not a blow-off.
    expect(isAprSelfOutlier({ priorAprs: calmHistory, currentApr: 45 })).toBe(false);
  });

  it("does not flag durable flat-high APR (low ratio)", () => {
    // 900 is the all-time high (rank 1.0) but only ~1.06x the median.
    expect(isAprSelfOutlier({ priorAprs: flatHigh, currentApr: 900 })).toBe(false);
    // Mid-range value fails the rank clause anyway.
    expect(isAprSelfOutlier({ priorAprs: flatHigh, currentApr: 870 })).toBe(false);
  });

  it("does not flag values inside the historical range", () => {
    expect(isAprSelfOutlier({ priorAprs: calmHistory, currentApr: 38 })).toBe(false);
  });

  it("honors a custom percentile", () => {
    // 38 is rank 0.8 of calm history but only ~1.09x median → ratio still blocks.
    expect(
      isAprSelfOutlier({ priorAprs: calmHistory, currentApr: 38, outlierPercentile: 0.8 }),
    ).toBe(false);
    expect(
      isAprSelfOutlier({ priorAprs: calmHistory, currentApr: 90, outlierPercentile: 0.8 }),
    ).toBe(true);
  });

  it("outlierPercentile 0 disables the gate entirely", () => {
    expect(
      isAprSelfOutlier({ priorAprs: calmHistory, currentApr: 9999, outlierPercentile: 0 }),
    ).toBe(false);
  });

  it("honors a custom spike ratio", () => {
    // 45 is rank 1.0; 1.5x median passes a 1.5 ratio, fails the 2x default.
    expect(isAprSelfOutlier({ priorAprs: calmHistory, currentApr: 45, minSpikeRatio: 1.5 })).toBe(
      true,
    );
    expect(isAprSelfOutlier({ priorAprs: calmHistory, currentApr: 45 })).toBe(false);
  });

  it("ignores non-finite inputs", () => {
    expect(isAprSelfOutlier({ priorAprs: calmHistory, currentApr: Number.NaN })).toBe(false);
    expect(isAprSelfOutlier({ priorAprs: [Number.NaN, ...calmHistory], currentApr: 1200 })).toBe(
      true,
    ); // NaN filtered → 5 finite obs remain
  });

  it("treats a zero/negative median as spike-when-positive", () => {
    expect(isAprSelfOutlier({ priorAprs: [0, 0, 0], currentApr: 500 })).toBe(true);
    expect(isAprSelfOutlier({ priorAprs: [0, 0, 0], currentApr: 0 })).toBe(false);
  });
});
