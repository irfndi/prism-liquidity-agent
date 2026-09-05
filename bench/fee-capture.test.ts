import { describe, expect, it } from "vitest";
import {
  activeShareEstimate,
  bandWidthPctFromBins,
  expectedIlCapturedPerExitUsd,
  expectedNetProfitUsd,
  paperCloseCostsUsd,
  expectedOorExitsPerDay,
  FEE_CAPTURE_REFERENCE_SPAN_PCT,
  netFeeVelocityUsd,
  netFeeVelocityUsdWithCosts,
  profitableRunner,
  runnerNetAprPct,
  runnerNetDailyPctAfterCosts,
  stableDailyFeesUsd,
} from "../engine/fee-capture.js";

describe("activeShareEstimate", () => {
  it("is deterministic across repeated calls with identical inputs", () => {
    const params = {
      positionSizeUsd: 1000,
      poolTvlUsd: 1_000_000,
      rangeHalfWidthBins: 5,
      binStep: 40,
    };
    const first = activeShareEstimate(params);
    expect(activeShareEstimate(params)).toBe(first);
    expect(activeShareEstimate(params)).toBe(first);
  });

  it("fails closed on degenerate inputs (tvl / size / bins / binStep)", () => {
    const base = {
      positionSizeUsd: 1000,
      poolTvlUsd: 1_000_000,
      rangeHalfWidthBins: 5,
      binStep: 40,
    };
    expect(activeShareEstimate({ ...base, poolTvlUsd: 0 })).toBe(0);
    expect(activeShareEstimate({ ...base, poolTvlUsd: -1 })).toBe(0);
    expect(activeShareEstimate({ ...base, positionSizeUsd: 0 })).toBe(0);
    expect(activeShareEstimate({ ...base, positionSizeUsd: -1 })).toBe(0);
    expect(activeShareEstimate({ ...base, rangeHalfWidthBins: 0 })).toBe(0);
    expect(activeShareEstimate({ ...base, rangeHalfWidthBins: -5 })).toBe(0);
    expect(activeShareEstimate({ ...base, binStep: 0 })).toBe(0);
    expect(activeShareEstimate({ ...base, binStep: -40 })).toBe(0);
    expect(activeShareEstimate({ ...base, poolTvlUsd: Number.NaN })).toBe(0);
    expect(activeShareEstimate({ ...base, positionSizeUsd: Number.POSITIVE_INFINITY })).toBe(0);
  });

  it("computes the reference-span concentration model by hand", () => {
    // spanPct = 2 * 5 * 40 * 0.0001 = 0.04 -> concentration = 2 / 0.04 = 50
    // share = (1000 / 1_000_000) * 50 = 0.05
    expect(
      activeShareEstimate({
        positionSizeUsd: 1000,
        poolTvlUsd: 1_000_000,
        rangeHalfWidthBins: 5,
        binStep: 40,
      }),
    ).toBeCloseTo(0.05, 12);
  });

  it("uses the full-range reference span as concentration 1 (share = size / tvl)", () => {
    // A range spanning exactly ±100%: bins * binStep = 1 / (2 * 0.0001) = 5000.
    const share = activeShareEstimate({
      positionSizeUsd: 1000,
      poolTvlUsd: 100_000,
      rangeHalfWidthBins: 5000,
      binStep: 100,
    });
    expect(share).toBeCloseTo(1000 / 100_000, 12);
    expect(share).toBeCloseTo(0.01, 12);
  });

  it("clamps at 1 when the position dominates the pool", () => {
    expect(
      activeShareEstimate({
        positionSizeUsd: 10_000,
        poolTvlUsd: 100,
        rangeHalfWidthBins: 5,
        binStep: 40,
      }),
    ).toBe(1);
  });

  it("never exceeds 1, even for a wide range with a huge position", () => {
    const share = activeShareEstimate({
      positionSizeUsd: 1_000_000,
      poolTvlUsd: 10_000,
      rangeHalfWidthBins: 1,
      binStep: 100,
    });
    expect(share).toBeLessThanOrEqual(1);
  });

  it("narrower ranges concentrate more (share strictly shrinks with rangeHalfWidthBins)", () => {
    // Narrow range -> smaller spanPct -> higher concentration -> larger share
    // of pool fees per dollar while in range (time-in-range downstream is the
    // de-risker for narrow churn — share must not pre-discount it).
    const narrow = activeShareEstimate({
      positionSizeUsd: 1000,
      poolTvlUsd: 1_000_000,
      rangeHalfWidthBins: 1,
      binStep: 40,
    });
    const wide = activeShareEstimate({
      positionSizeUsd: 1000,
      poolTvlUsd: 1_000_000,
      rangeHalfWidthBins: 100,
      binStep: 40,
    });
    expect(narrow).toBeGreaterThan(wide);
    expect(FEE_CAPTURE_REFERENCE_SPAN_PCT).toBe(2);
  });
});

describe("netFeeVelocityUsd", () => {
  it("is deterministic across repeated calls with identical inputs", () => {
    const params = {
      fees24hUsd: 1000,
      shareEstimate: 0.01,
      harvestCostUsd: 1.0,
      conversionCostPct: 0.1,
      positionSizeUsd: 1000,
      timeInRangePct: 0.9,
    };
    const first = netFeeVelocityUsd(params);
    expect(netFeeVelocityUsd(params)).toBe(first);
    expect(netFeeVelocityUsd(params)).toBe(first);
  });

  it("fails closed on degenerate inputs (fees / size / timeInRange)", () => {
    const base = {
      fees24hUsd: 1000,
      shareEstimate: 0.01,
      harvestCostUsd: 1.0,
      conversionCostPct: 0.1,
      positionSizeUsd: 1000,
      timeInRangePct: 0.9,
    };
    expect(netFeeVelocityUsd({ ...base, fees24hUsd: 0 })).toBe(0);
    expect(netFeeVelocityUsd({ ...base, fees24hUsd: -1 })).toBe(0);
    expect(netFeeVelocityUsd({ ...base, positionSizeUsd: 0 })).toBe(0);
    expect(netFeeVelocityUsd({ ...base, positionSizeUsd: -1 })).toBe(0);
    expect(netFeeVelocityUsd({ ...base, timeInRangePct: 0 })).toBe(0);
    expect(netFeeVelocityUsd({ ...base, timeInRangePct: -0.5 })).toBe(0);
    expect(netFeeVelocityUsd({ ...base, fees24hUsd: Number.NaN })).toBe(0);
    expect(netFeeVelocityUsd({ ...base, shareEstimate: Number.NaN })).toBe(0);
    expect(netFeeVelocityUsd({ ...base, conversionCostPct: Number.POSITIVE_INFINITY })).toBe(0);
    expect(netFeeVelocityUsd({ ...base, harvestCostUsd: Number.NaN })).toBe(0);
  });

  it("applies the conversion haircut (1 - conversionCostPct)", () => {
    const base = {
      fees24hUsd: 1000,
      shareEstimate: 0.01,
      harvestCostUsd: 0,
      conversionCostPct: 0.25,
      positionSizeUsd: 1000,
      timeInRangePct: 1,
    };
    const noCost = netFeeVelocityUsd({ ...base, conversionCostPct: 0 });
    const withCost = netFeeVelocityUsd(base);
    expect(noCost).toBeCloseTo((1000 * 0.01) / 1000, 12); // 0.01
    expect(withCost).toBeCloseTo(noCost * 0.75, 12);
  });

  it("a harvest cost exceeding gross capture zeroes the result (never negative)", () => {
    // gross = 1000 * 0.01 * 1 = 10; harvest 15 > 10 -> 0, not -0.005
    expect(
      netFeeVelocityUsd({
        fees24hUsd: 1000,
        shareEstimate: 0.01,
        harvestCostUsd: 15,
        conversionCostPct: 0,
        positionSizeUsd: 1000,
        timeInRangePct: 1,
      }),
    ).toBe(0);
  });

  it("share scales the result linearly", () => {
    const base = {
      fees24hUsd: 1000,
      harvestCostUsd: 0,
      conversionCostPct: 0,
      positionSizeUsd: 1000,
      timeInRangePct: 1,
    };
    const low = netFeeVelocityUsd({ ...base, shareEstimate: 0.1 });
    const high = netFeeVelocityUsd({ ...base, shareEstimate: 0.2 });
    expect(high).toBeCloseTo(low * 2, 12);
  });

  it("clamps out-of-range fractions defensively (share / timeInRange / conversion)", () => {
    const base = {
      fees24hUsd: 1000,
      shareEstimate: 0.01,
      harvestCostUsd: 0,
      conversionCostPct: 0.1,
      positionSizeUsd: 1000,
      timeInRangePct: 0.9,
    };
    expect(netFeeVelocityUsd({ ...base, shareEstimate: 5 })).toBeCloseTo(
      netFeeVelocityUsd({ ...base, shareEstimate: 1 }),
      12,
    );
    expect(netFeeVelocityUsd({ ...base, shareEstimate: -5 })).toBe(0);
    expect(netFeeVelocityUsd({ ...base, timeInRangePct: 2 })).toBeCloseTo(
      netFeeVelocityUsd({ ...base, timeInRangePct: 1 }),
      12,
    );
    expect(netFeeVelocityUsd({ ...base, conversionCostPct: 1.5 })).toBe(0);
    expect(netFeeVelocityUsd({ ...base, conversionCostPct: -0.5 })).toBeCloseTo(
      netFeeVelocityUsd({ ...base, conversionCostPct: 0 }),
      12,
    );
  });

  it("computes a hand-verified worked example", () => {
    // gross = 1000 * 0.01 * 0.9 = 9
    // net   = (9 - 1) * (1 - 0.1) = 7.2
    // per $ = 7.2 / 1000 = 0.0072
    expect(
      netFeeVelocityUsd({
        fees24hUsd: 1000,
        shareEstimate: 0.01,
        harvestCostUsd: 1.0,
        conversionCostPct: 0.1,
        positionSizeUsd: 1000,
        timeInRangePct: 0.9,
      }),
    ).toBeCloseTo(0.0072, 10);
  });
});

describe("runnerNetAprPct", () => {
  it("preserves pool APR for a proportional position instead of applying its TVL share twice", () => {
    for (const poolTvlUsd of [100_000, 1_000_000]) {
      expect(
        runnerNetAprPct({
          grossAprPct: 500,
          poolTvlUsd,
          shareEstimate: 20 / poolTvlUsd,
          positionSizeUsd: 20,
          harvestCostUsd: 0,
          conversionCostPct: 0,
          timeInRangePct: 1,
        }),
      ).toBeCloseTo(500, 10);
    }
  });

  it("is deterministic across repeated calls with identical inputs", () => {
    const params = {
      grossAprPct: 200,
      poolTvlUsd: 500_000,
      shareEstimate: 0.02,
      harvestCostUsd: 0.5,
      conversionCostPct: 0.05,
      positionSizeUsd: 10_000,
      timeInRangePct: 1,
    };
    const first = runnerNetAprPct(params);
    expect(runnerNetAprPct(params)).toBe(first);
    expect(runnerNetAprPct(params)).toBe(first);
  });

  it("fails closed on degenerate inputs (grossAprPct / size / timeInRange)", () => {
    const base = {
      grossAprPct: 200,
      poolTvlUsd: 500_000,
      shareEstimate: 0.02,
      harvestCostUsd: 0.5,
      conversionCostPct: 0.05,
      positionSizeUsd: 10_000,
      timeInRangePct: 1,
    };
    expect(runnerNetAprPct({ ...base, grossAprPct: 0 })).toBe(0);
    expect(runnerNetAprPct({ ...base, grossAprPct: -50 })).toBe(0);
    expect(runnerNetAprPct({ ...base, positionSizeUsd: 0 })).toBe(0);
    expect(runnerNetAprPct({ ...base, timeInRangePct: 0 })).toBe(0);
    expect(runnerNetAprPct({ ...base, grossAprPct: Number.NaN })).toBe(0);
    expect(runnerNetAprPct({ ...base, shareEstimate: Number.NaN })).toBe(0);
    expect(runnerNetAprPct({ ...base, poolTvlUsd: Number.NaN })).toBe(0);
    expect(runnerNetAprPct({ ...base, poolTvlUsd: 0 })).toBe(0);
  });

  it("matches netFeeVelocityUsd annualized (same floored math)", () => {
    const params = {
      grossAprPct: 200,
      poolTvlUsd: 500_000,
      shareEstimate: 0.02,
      harvestCostUsd: 0.5,
      conversionCostPct: 0.05,
      positionSizeUsd: 10_000,
      timeInRangePct: 1,
    };
    const dailyPerDollar = netFeeVelocityUsd({
      fees24hUsd: (params.poolTvlUsd * 200) / 100 / 365,
      shareEstimate: params.shareEstimate,
      harvestCostUsd: params.harvestCostUsd,
      conversionCostPct: params.conversionCostPct,
      positionSizeUsd: params.positionSizeUsd,
      timeInRangePct: params.timeInRangePct,
    });
    expect(runnerNetAprPct(params)).toBeCloseTo(dailyPerDollar * 365 * 100, 10);
  });

  it("computes a hand-verified worked example", () => {
    // Pool daily fees = 500_000 * 2 / 365; 2% belongs to the position.
    // Annual position fees = (20_000 - 0.5 * 365) * 0.95 = 18_826.625.
    // APR = 18_826.625 / 10_000 * 100 = 188.26625%.
    expect(
      runnerNetAprPct({
        grossAprPct: 200,
        poolTvlUsd: 500_000,
        shareEstimate: 0.02,
        harvestCostUsd: 0.5,
        conversionCostPct: 0.05,
        positionSizeUsd: 10_000,
        timeInRangePct: 1,
      }),
    ).toBeCloseTo(188.26625, 10);
  });

  it("keeps net APR below gross APR (the consistency sanity property)", () => {
    const apr = runnerNetAprPct({
      grossAprPct: 500,
      poolTvlUsd: 20_000,
      shareEstimate: 0.5,
      harvestCostUsd: 0.1,
      conversionCostPct: 0.1,
      positionSizeUsd: 10_000,
      timeInRangePct: 0.8,
    });
    expect(apr).toBeGreaterThanOrEqual(0);
    expect(apr).toBeLessThanOrEqual(500);
  });

  it("scales linearly with grossAprPct when costs are zero (anchor-only input)", () => {
    const base = {
      grossAprPct: 100,
      poolTvlUsd: 10_000,
      shareEstimate: 1,
      harvestCostUsd: 0,
      conversionCostPct: 0,
      positionSizeUsd: 10_000,
      timeInRangePct: 1,
    };
    expect(runnerNetAprPct({ ...base, grossAprPct: 200 })).toBeCloseTo(
      runnerNetAprPct(base) * 2,
      10,
    );
  });
});

describe("pipeline", () => {
  it("composes activeShareEstimate into netFeeVelocityUsd (a share from rank-time inputs)", () => {
    // share = (5000 / 500_000) * 50 = 0.5 (halfWidth 5 @ binStep 40 concentrates 50x)
    const share = activeShareEstimate({
      positionSizeUsd: 5000,
      poolTvlUsd: 500_000,
      rangeHalfWidthBins: 5,
      binStep: 40,
    });
    expect(share).toBeCloseTo(0.5, 12);
    const velocity = netFeeVelocityUsd({
      fees24hUsd: 1200,
      shareEstimate: share,
      harvestCostUsd: 0.05,
      conversionCostPct: 0.05,
      positionSizeUsd: 5000,
      timeInRangePct: 0.95,
    });
    // gross = 1200 * 0.5 * 0.95 = 570; net = (570 - 0.05) * 0.95 = 541.4525; /5000
    expect(velocity).toBeCloseTo(541.4525 / 5000, 12);
    expect(velocity).toBeGreaterThan(0);
  });

  it("ranks by NET velocity per dollar, not raw gross (harvest cost is the tie-breaker)", () => {
    const base = {
      fees24hUsd: 1000,
      shareEstimate: 0.01,
      conversionCostPct: 0,
      positionSizeUsd: 5000,
      timeInRangePct: 1,
    };
    // Same gross (10 USD/day attributed), but harvest costs differ.
    const cheapHarvest = netFeeVelocityUsd({ ...base, harvestCostUsd: 1 });
    const breakEven = netFeeVelocityUsd({ ...base, harvestCostUsd: 10 }); // harvest == gross -> 0
    const costlyHarvest = netFeeVelocityUsd({ ...base, harvestCostUsd: 15 }); // harvest > gross -> 0

    expect(cheapHarvest).toBeCloseTo((10 - 1) / 5000, 12);
    expect(breakEven).toBe(0);
    expect(costlyHarvest).toBe(0);
    expect(cheapHarvest).toBeGreaterThan(costlyHarvest);
  });
});

describe("runner churn / IL / swap cost model (no-bleed gate)", () => {
  it("bandWidthPctFromBins: 2×halfWidth×binStep, 0 on invalid inputs", () => {
    expect(bandWidthPctFromBins(5, 40)).toBeCloseTo(2 * 5 * 40 * 0.0001, 12);
    expect(bandWidthPctFromBins(0, 40)).toBe(0);
    expect(bandWidthPctFromBins(5, 0)).toBe(0);
    expect(bandWidthPctFromBins(-3, 40)).toBe(0);
  });

  it("expectedOorExitsPerDay: grows with volatility, shrinks with wider band, bounded by cadence, floored", () => {
    const base = { rangeHalfWidthBins: 5, binStep: 40, volatilityStddev: 10, maxExitsPerDay: 200 };
    const low = expectedOorExitsPerDay(base);
    const high = expectedOorExitsPerDay({ ...base, volatilityStddev: 40 });
    expect(high).toBeGreaterThan(low);
    const wide = expectedOorExitsPerDay({ ...base, rangeHalfWidthBins: 50 });
    expect(low).toBeGreaterThan(wide);
    // Cadence cap respected.
    const capped = expectedOorExitsPerDay({ ...base, maxExitsPerDay: low - 1 });
    expect(capped).toBeLessThanOrEqual(low - 1);
    // Flat pool hits the floor, never zero.
    expect(expectedOorExitsPerDay({ ...base, volatilityStddev: 0.0001 })).toBeGreaterThan(0);
    // Fail closed on invalid inputs.
    expect(expectedOorExitsPerDay({ ...base, binStep: 0 })).toBe(0);
    expect(expectedOorExitsPerDay({ ...base, volatilityStddev: Number.NaN })).toBe(0);
  });

  it("expectedIlCapturedPerExitUsd: 0 on invalid, grows with band width and size", () => {
    expect(expectedIlCapturedPerExitUsd(1000, 0, 40)).toBe(0);
    expect(expectedIlCapturedPerExitUsd(0, 5, 40)).toBe(0);
    const narrow = expectedIlCapturedPerExitUsd(1000, 5, 40);
    const wide = expectedIlCapturedPerExitUsd(1000, 20, 40);
    expect(wide).toBeGreaterThan(narrow);
    expect(wide).toBeGreaterThan(0);
    expect(wide).toBeLessThan(1000); // a real LP position can't lose more than its size
  });

  it("netFeeVelocityUsdWithCosts: a bleeding runner returns 0 (churn cost > gross capture)", () => {
    const bleed = netFeeVelocityUsdWithCosts({
      fees24hUsd: 1000,
      poolTvlUsd: 5000,
      positionSizeUsd: 1000,
      rangeHalfWidthBins: 2,
      binStep: 20,
      volatilityStddev: 50, // violent whipsaw -> heavy churn
      swapCostPct: 0.005,
      harvestCostUsd: 0.5,
      timeInRangePct: 1,
      maxExitsPerDay: 200,
    });
    expect(bleed).toBe(0); // floored, never negative
  });

  it("netFeeVelocityUsdWithCosts: a healthy runner clears a positive net velocity", () => {
    const healthy = netFeeVelocityUsdWithCosts({
      fees24hUsd: 50000,
      poolTvlUsd: 100000,
      positionSizeUsd: 1000,
      rangeHalfWidthBins: 50,
      binStep: 20,
      volatilityStddev: 5,
      swapCostPct: 0.001,
      harvestCostUsd: 0.1,
      timeInRangePct: 0.9,
      maxExitsPerDay: 200,
    });
    expect(healthy).toBeGreaterThan(0);
    expect(
      runnerNetDailyPctAfterCosts({
        fees24hUsd: 50000,
        poolTvlUsd: 100000,
        positionSizeUsd: 1000,
        rangeHalfWidthBins: 50,
        binStep: 20,
        volatilityStddev: 5,
        swapCostPct: 0.001,
        harvestCostUsd: 0.1,
        timeInRangePct: 0.9,
        maxExitsPerDay: 200,
      }),
    ).toBeGreaterThan(1); // clears the default floor of 1%/day
  });

  it("netFeeVelocityUsdWithCosts: fails closed (0) on non-positive fees or size", () => {
    const base = {
      fees24hUsd: 1,
      poolTvlUsd: 100000,
      positionSizeUsd: 1000,
      rangeHalfWidthBins: 50,
      binStep: 20,
      volatilityStddev: 5,
      swapCostPct: 0.001,
      harvestCostUsd: 0.1,
      timeInRangePct: 0.9,
      maxExitsPerDay: 200,
    };
    expect(netFeeVelocityUsdWithCosts({ ...base, fees24hUsd: 0 })).toBe(0);
    expect(netFeeVelocityUsdWithCosts({ ...base, positionSizeUsd: 0 })).toBe(0);
    expect(netFeeVelocityUsdWithCosts({ ...base, fees24hUsd: Number.NaN })).toBe(0);
  });

  it("profitableRunner: true only when net daily % clears the floor; degenerate never passes", () => {
    const healthy = {
      fees24hUsd: 50000,
      poolTvlUsd: 100000,
      positionSizeUsd: 1000,
      rangeHalfWidthBins: 50,
      binStep: 20,
      volatilityStddev: 5,
      swapCostPct: 0.001,
      harvestCostUsd: 0.1,
      timeInRangePct: 0.9,
      maxExitsPerDay: 200,
    };
    expect(profitableRunner(healthy, 1)).toBe(true);
    expect(profitableRunner(healthy, 100000)).toBe(false); // absurd floor
    // A zero-net position fails a POSITIVE floor but trivially meets a zero
    // floor (that's why the gate floor must be > 0 to bind on profitability).
    expect(profitableRunner({ ...healthy, fees24hUsd: 0 }, 0)).toBe(true);
    expect(profitableRunner({ ...healthy, fees24hUsd: 0 }, 0.0001)).toBe(false);
  });
});

describe("stableDailyFeesUsd", () => {
  it("takes the minimum across windows (a lone 1h spike cannot pass)", () => {
    // tvl 100k: 1h 2%/h → 48k/day, 12h 0.1%/12h → 200/day, 24h 0.3%/day → 300/day.
    expect(stableDailyFeesUsd({ "1h": 2, "12h": 0.1, "24h": 0.3 }, 100_000)).toBeCloseTo(200, 10);
  });

  it("normalizes sub-day windows to daily dollars", () => {
    // 30m 0.05% → 0.05/100 × 10k × 48 = 240/day.
    expect(stableDailyFeesUsd({ "30m": 0.05 }, 10_000)).toBeCloseTo(240, 10);
  });

  it("fails open (null) when no window is usable", () => {
    expect(stableDailyFeesUsd(null, 100_000)).toBeNull();
    expect(stableDailyFeesUsd(undefined, 100_000)).toBeNull();
    expect(stableDailyFeesUsd({}, 100_000)).toBeNull();
    expect(stableDailyFeesUsd({ "1h": Number.NaN }, 100_000)).toBeNull();
    expect(stableDailyFeesUsd({ "1h": -1 }, 100_000)).toBeNull();
    expect(stableDailyFeesUsd({ "24h": 0.3 }, 0)).toBeNull();
  });
});

describe("expectedNetProfitUsd", () => {
  const base = {
    dailyFeesUsd: 300,
    positionSizeUsd: 100,
    poolTvlUsd: 100_000,
    rangeHalfWidthBins: 20,
    binStep: 20,
    volatilityStddev: 2,
    swapCostPct: 0.005,
    harvestCostUsd: 0.01,
    holdingDays: 1,
    txCostUsd: 0.005,
  };

  it("is positive for a healthy pool and negative below cost coverage", () => {
    expect(expectedNetProfitUsd(base)).toBeGreaterThan(0);
    // A $1 position over a 4h holding horizon cannot amortize the round trip.
    expect(
      expectedNetProfitUsd({ ...base, positionSizeUsd: 1, holdingDays: 1 / 6 }),
    ).toBeLessThanOrEqual(0);
  });

  it("charges the round trip explicitly (bigger tx cost lowers profit)", () => {
    const cheap = expectedNetProfitUsd(base);
    const pricey = expectedNetProfitUsd({ ...base, txCostUsd: 1 });
    expect(cheap).not.toBeNull();
    expect(pricey).toBeCloseTo(cheap! - 2 * (1 - 0.005), 10);
  });

  it("returns null (unknown) on invalid inputs — never a fabricated zero", () => {
    expect(expectedNetProfitUsd({ ...base, dailyFeesUsd: -1 })).toBeNull();
    expect(expectedNetProfitUsd({ ...base, dailyFeesUsd: Number.NaN })).toBeNull();
    expect(expectedNetProfitUsd({ ...base, positionSizeUsd: 0 })).toBeNull();
    expect(expectedNetProfitUsd({ ...base, holdingDays: 0 })).toBeNull();
    expect(expectedNetProfitUsd({ ...base, swapCostPct: Number.NaN })).toBeNull();
  });

  it("prices a measured zero as negative (round trip uncovered) — rejects", () => {
    expect(expectedNetProfitUsd({ ...base, dailyFeesUsd: 0 })).toBeLessThan(0);
  });
});

describe("paperCloseCostsUsd", () => {
  const base = {
    positionSizeUsd: 1000,
    ageDays: 2,
    cumulativeGrossFeesUsd: 25,
    swapCostPct: 0.005,
    harvestCostUsd: 0.01,
    conversionCostPct: 0.05,
    txCostUsd: 0.005,
  };

  it("sums round trip, harvest over age, and conversion on gross fees", () => {
    // 2×0.005×1000 + 2×0.005 = 10.01 round trip; 0.01×2 harvest; 0.05×25 conversion.
    expect(paperCloseCostsUsd(base)).toBeCloseTo(10.01 + 0.02 + 1.25, 10);
  });

  it("charges the full load even when fees are zero (nothing disappears)", () => {
    expect(paperCloseCostsUsd({ ...base, cumulativeGrossFeesUsd: 0, ageDays: 0 })).toBeCloseTo(
      10.01,
      10,
    );
  });

  it("floors at zero and fails closed on unmeasurable size", () => {
    expect(paperCloseCostsUsd({ ...base, positionSizeUsd: 0 })).toBe(0);
    expect(paperCloseCostsUsd({ ...base, positionSizeUsd: -5 })).toBe(0);
  });
});
