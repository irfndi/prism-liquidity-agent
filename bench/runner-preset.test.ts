import { describe, expect, it } from "vitest";
import {
  assessRunnerPool,
  dipOffsetBins,
  evaluateRunnerExit,
  planRunnerEntry,
  shouldReanchorRunner,
  RUNNER_PRESET_DEFAULTS,
  type RunnerPoolFacts,
} from "../engine/runner-preset.js";

function facts(overrides: Partial<RunnerPoolFacts> = {}): RunnerPoolFacts {
  return {
    feeTvlRatio30mPct: 0.9,
    binStep: 100,
    tvlUsd: 200_000,
    fees24hUsd: 600,
    volume24hUsd: 60_000,
    ...overrides,
  };
}

describe("runner preset — scanner", () => {
  it("qualifies a pool printing >= 0.6% fee/TVL over 30m on a coarse bin step", () => {
    expect(assessRunnerPool(facts())).toEqual({ qualifies: true, reasons: [] });
    // Exactly at both floors is a pass: the thresholds are floors, not limits.
    expect(assessRunnerPool(facts({ feeTvlRatio30mPct: 0.6, binStep: 80 })).qualifies).toBe(true);
  });

  it("rejects a pool below the 30m fee floor", () => {
    expect(assessRunnerPool(facts({ feeTvlRatio30mPct: 0.59 }))).toEqual({
      qualifies: false,
      reasons: ["fee-tvl-30m-below-floor"],
    });
  });

  it("rejects an unknown 30m window rather than guessing", () => {
    // The whole strategy keys on this window; an undescribed pool is not a
    // candidate, so this is a reject and not a fail-open.
    expect(assessRunnerPool(facts({ feeTvlRatio30mPct: null }))).toEqual({
      qualifies: false,
      reasons: ["fee-tvl-30m-unknown"],
    });
    expect(assessRunnerPool(facts({ feeTvlRatio30mPct: Number.NaN })).reasons).toEqual([
      "fee-tvl-30m-unknown",
    ]);
  });

  it("rejects a fine bin step", () => {
    expect(assessRunnerPool(facts({ binStep: 20 })).reasons).toEqual(["bin-step-below-floor"]);
  });

  it("rejects a pool whose booked fees are not explainable by its volume", () => {
    // 8,000 fees on 60,000 volume = 13% effective rate: wash, not demand.
    const wash = facts({ fees24hUsd: 8_000, volume24hUsd: 60_000 });
    expect(assessRunnerPool(wash).reasons).toEqual(["fee-turnover-inflated"]);

    // A real pool books a plausible fee rate (~1% here).
    const honest = facts({ fees24hUsd: 600, volume24hUsd: 60_000 });
    expect(assessRunnerPool(honest).qualifies).toBe(true);
  });

  it("rejects a dead pool with no volume turnover", () => {
    // A dead pool's booked fees are also unexplained by its volume, so both
    // guards fire; the order is the evaluation order.
    expect(assessRunnerPool(facts({ volume24hUsd: 100, tvlUsd: 200_000 })).reasons).toEqual([
      "volume-turnover-too-low",
      "fee-turnover-inflated",
    ]);
  });

  it("reports every failing condition, in evaluation order", () => {
    const bad = facts({
      feeTvlRatio30mPct: 0.1,
      binStep: 5,
      volume24hUsd: 0,
    });
    expect(assessRunnerPool(bad).reasons).toEqual([
      "fee-tvl-30m-below-floor",
      "bin-step-below-floor",
      "volume-turnover-too-low",
    ]);
  });

  it("honours a custom config", () => {
    const strict = { ...RUNNER_PRESET_DEFAULTS, minFeeTvl30mPct: 2 };
    expect(assessRunnerPool(facts({ feeTvlRatio30mPct: 1 }), strict).qualifies).toBe(false);
  });
});

describe("runner preset — below-market split entry", () => {
  it("converts a 50% dip into bins for the pool's step", () => {
    // ln(0.5)/ln(1.01) ≈ 69.7 → 70 bins at a 100bp step.
    expect(dipOffsetBins(100, 0.5)).toBe(70);
    // A finer step needs more bins for the same price distance.
    expect(dipOffsetBins(20, 0.5)).toBeGreaterThan(dipOffsetBins(100, 0.5));
  });

  it("never anchors at the active bin for a non-zero dip", () => {
    expect(dipOffsetBins(100, 0.0001)).toBeGreaterThanOrEqual(1);
  });

  it("fails closed to a centred range for unusable inputs", () => {
    expect(dipOffsetBins(0, 0.5)).toBe(0);
    expect(dipOffsetBins(100, 0)).toBe(0);
    expect(dipOffsetBins(100, 1)).toBe(0);
    expect(dipOffsetBins(Number.NaN, 0.5)).toBe(0);
  });

  it("splits the size 50:50 with the halves summing exactly", () => {
    const plan = planRunnerEntry({
      binStep: 100,
      sizeUsd: 101,
      maxHalfWidthBins: 50,
      baseHalfWidthBins: 20,
    });
    expect(plan.legs.map((leg) => leg.leg)).toEqual(["spot", "bidask"]);
    expect(plan.legs[0]?.sizeUsd).toBe(50.5);
    expect(plan.legs[1]?.sizeUsd).toBe(50.5);
    expect(plan.legs.reduce((sum, leg) => sum + leg.sizeUsd, 0)).toBe(101);
  });

  it("clamps the half-width to the operator cap and never below one bin", () => {
    expect(
      planRunnerEntry({ binStep: 100, sizeUsd: 10, maxHalfWidthBins: 15, baseHalfWidthBins: 40 })
        .halfWidthBins,
    ).toBe(15);
    expect(
      planRunnerEntry({ binStep: 100, sizeUsd: 10, maxHalfWidthBins: 15, baseHalfWidthBins: 0 })
        .halfWidthBins,
    ).toBe(1);
  });
});

describe("runner preset — reshape cadence", () => {
  it("reshapes once drift reaches the cadence, either direction", () => {
    expect(shouldReanchorRunner({ anchorBinId: 100, activeBinId: 105 })).toEqual({
      reanchor: true,
      driftBins: 5,
    });
    expect(shouldReanchorRunner({ anchorBinId: 100, activeBinId: 95 }).reanchor).toBe(true);
  });

  it("holds inside the cadence", () => {
    expect(shouldReanchorRunner({ anchorBinId: 100, activeBinId: 104 }).reanchor).toBe(false);
    expect(shouldReanchorRunner({ anchorBinId: 100, activeBinId: 96 }).reanchor).toBe(false);
  });

  it("disables with a non-positive cadence", () => {
    expect(shouldReanchorRunner({ anchorBinId: 0, activeBinId: 500, everyBins: 0 }).reanchor).toBe(
      false,
    );
  });
});

describe("runner preset — exit precedence", () => {
  const base = { entryPrice: 100, inRange: true };

  it("banks an emergency take-profit first", () => {
    expect(evaluateRunnerExit({ ...base, currentPrice: 110 })).toEqual({
      reason: "emergency-take-profit",
      pnlPct: 0.1,
    });
  });

  it("recycles an out-of-range position even when it is up", () => {
    expect(evaluateRunnerExit({ ...base, currentPrice: 103, inRange: false }).reason).toBe(
      "out-of-range",
    );
  });

  it("takes the ordinary target when the range still earns", () => {
    expect(evaluateRunnerExit({ ...base, currentPrice: 105, takeProfitPct: 0.05 }).reason).toBe(
      "take-profit",
    );
  });

  it("closes a scratch at the break-even floor instead of letting it revert", () => {
    expect(evaluateRunnerExit({ ...base, currentPrice: 100.1 }).reason).toBe("break-even");
    // Below the floor it keeps running.
    expect(evaluateRunnerExit({ ...base, currentPrice: 100.05 }).reason).toBeNull();
  });

  it("holds when price is below the floor and still in range", () => {
    expect(evaluateRunnerExit({ ...base, currentPrice: 99, inRange: true }).reason).toBeNull();
  });

  it("fails closed on an unusable entry price", () => {
    expect(evaluateRunnerExit({ entryPrice: 0, currentPrice: 10, inRange: true })).toEqual({
      reason: null,
      pnlPct: 0,
    });
  });
});
