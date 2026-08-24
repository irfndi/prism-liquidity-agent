import { describe, expect, it } from "vitest";
import {
  detectVolumeSpike,
  evaluateHotWindowEnter,
  evaluateHotWindowExit,
  hotWindowDayKey,
  type HotWindowConfig,
} from "../engine/hot-window.js";

const baseCfg: HotWindowConfig = {
  enabled: true,
  entrySizeUsd: 30,
  maxPoolTvlUsd: 25_000,
  minPoolTvlUsd: 500,
  printingRatio1h: 1,
  minSharePct: 0.005,
  maxSharePct: 0.05,
  holdMaxMs: 1_800_000,
  maxTripsPerDay: 30,
  dailyLossHaltUsd: 3,
  maxOpen: 2,
};

const spikeCfg: HotWindowConfig = {
  ...baseCfg,
  volumeSpike: { baselineWindow: 4, spikeRatio: 2.5, minPoints: 2, minVolumeUsd: 10_000 },
};

describe("evaluateHotWindowEnter", () => {
  it("does not enter when the lane is disabled", () => {
    const r = evaluateHotWindowEnter({
      config: { ...baseCfg, enabled: false },
      feeTvlRatio1h: 5,
      tvlUsd: 3000,
    });
    expect(r.qualify).toBe(false);
    expect(r.rejectReason).toContain("disabled");
  });

  it("fails closed on a missing (unmeasured) printing signal", () => {
    const r = evaluateHotWindowEnter({
      config: baseCfg,
      feeTvlRatio1h: null,
      tvlUsd: 3000,
    });
    expect(r.qualify).toBe(false);
    expect(r.rejectReason).toContain("printing");
  });

  it("rejects a pool that is not printing now (below the 1h floor)", () => {
    const r = evaluateHotWindowEnter({
      config: baseCfg,
      feeTvlRatio1h: 0.4,
      tvlUsd: 3000,
    });
    expect(r.qualify).toBe(false);
    expect(r.rejectReason).toContain("floor");
  });

  it("enters a currently-printing pool inside the economic depth band", () => {
    const r = evaluateHotWindowEnter({
      config: baseCfg,
      feeTvlRatio1h: 2.0,
      tvlUsd: 3000,
    });
    expect(r.qualify).toBe(true);
    expect(r.sizeUsd).toBe(30);
  });

  it("rejects a pool too deep for an economic share", () => {
    const r = evaluateHotWindowEnter({
      config: baseCfg,
      feeTvlRatio1h: 2.0,
      tvlUsd: 8000,
    });
    expect(r.qualify).toBe(false);
    expect((r.rejectReason ?? "").toLowerCase()).toContain("depth");
  });

  it("rejects a dust pool below the min TVL", () => {
    const r = evaluateHotWindowEnter({ config: baseCfg, feeTvlRatio1h: 2.0, tvlUsd: 100 });
    expect(r.qualify).toBe(false);
    expect(r.rejectReason).toContain("min");
  });

  it("rejects a pool small enough that the entry would whale it", () => {
    // tvl 550 clears minPoolTvl (500) but < minShareTvl (600) => would exceed 5%.
    const r = evaluateHotWindowEnter({ config: baseCfg, feeTvlRatio1h: 2.0, tvlUsd: 550 });
    expect(r.qualify).toBe(false);
    expect((r.rejectReason ?? "").toLowerCase()).toContain("exceed");
  });

  it("respects a tighter operator depth cap", () => {
    const r = evaluateHotWindowEnter({
      config: { ...baseCfg, maxPoolTvlUsd: 1000 },
      feeTvlRatio1h: 2.0,
      tvlUsd: 2000,
    });
    expect(r.qualify).toBe(false);
  });
});

describe("evaluateHotWindowExit", () => {
  it("exits on a daily-loss halt", () => {
    const r = evaluateHotWindowExit({
      config: baseCfg,
      ageMs: 60_000,
      outOfRangeSince: null,
      halted: true,
    });
    expect(r.exit).toBe(true);
    expect(r.reason).toBe("halt");
  });

  it("exits immediately when out of range (fees stopped, IL bleeding)", () => {
    const r = evaluateHotWindowExit({
      config: baseCfg,
      ageMs: 5_000,
      outOfRangeSince: Date.now() - 1,
      halted: false,
    });
    expect(r.exit).toBe(true);
    expect(r.reason).toBe("oor");
  });

  it("exits when the short timebox expires", () => {
    const r = evaluateHotWindowExit({
      config: baseCfg,
      ageMs: baseCfg.holdMaxMs + 1,
      outOfRangeSince: null,
      halted: false,
    });
    expect(r.exit).toBe(true);
    expect(r.reason).toBe("timebox");
  });

  it("holds while in-range and inside the timebox", () => {
    const r = evaluateHotWindowExit({
      config: baseCfg,
      ageMs: 30_000,
      outOfRangeSince: null,
      halted: false,
    });
    expect(r.exit).toBe(false);
  });

  it("fails closed (exits) on a non-finite age", () => {
    const r = evaluateHotWindowExit({
      config: baseCfg,
      ageMs: NaN,
      outOfRangeSince: null,
      halted: false,
    });
    expect(r.exit).toBe(true);
  });
});

describe("hotWindowDayKey", () => {
  it("formats a UTC date key", () => {
    expect(hotWindowDayKey(Date.UTC(2026, 7, 18, 15, 0, 0))).toBe("2026-08-18");
  });

  it("zero-pads month and day", () => {
    expect(hotWindowDayKey(Date.UTC(2026, 0, 3, 0, 0, 0))).toBe("2026-01-03");
  });
});

describe("detectVolumeSpike", () => {
  // Thresholds live in the 1.1–1.5 band: the per-cycle reading is a trailing
  // 24h ROLLING figure, so even a violent rate burst lifts it only ~1.2x.
  const cfg = { baselineWindow: 4, spikeRatio: 1.2, minPoints: 2 };

  it("fails open on thin history (no verdict)", () => {
    expect(detectVolumeSpike({ volumes: [100], ...cfg })).toEqual({ isSpike: false, ratio: 0 });
    // Not enough points to reach back baselineWindow cycles → no verdict.
    expect(detectVolumeSpike({ volumes: [100, 100, 100], ...cfg })).toEqual({
      isSpike: false,
      ratio: 0,
    });
  });

  it("detects a burst vs the window-start reading", () => {
    // Window start (index len-1-4) is 90; current 300 → 3.33x >= 1.2.
    const r = detectVolumeSpike({ volumes: [100, 90, 110, 95, 105, 300], ...cfg });
    expect(r.isSpike).toBe(true);
    expect(r.ratio).toBeCloseTo(300 / 90, 10);
  });

  it("does not fire on ordinary drift of the rolling figure", () => {
    // Steady ~$1M/day pool whose rolling figure drifts up 8% over the window.
    const r = detectVolumeSpike({
      volumes: [1_000_000, 1_010_000, 1_020_000, 1_030_000, 1_080_000],
      ...cfg,
    });
    expect(r.isSpike).toBe(false); // 1.08x < 1.2
  });

  it("fires when fresh volume lifts the rolling figure past the bar", () => {
    // Same pool absorbing a real burst: rolling 24h jumps 25% in 4 cycles.
    const r = detectVolumeSpike({
      volumes: [1_000_000, 1_010_000, 1_060_000, 1_150_000, 1_250_000],
      ...cfg,
    });
    expect(r.isSpike).toBe(true); // 1.25x >= 1.2
  });

  it("compares against the single window-start point, not adjacent pairs", () => {
    // Adjacent readings are near-identical (rolling figures move slowly) —
    // the signal is the cumulative lift from the window start.
    const r = detectVolumeSpike({
      volumes: [500_000, 505_000, 512_000, 520_000, 528_000, 537_000, 545_000],
      ...cfg,
      baselineWindow: 6,
    });
    expect(r.ratio).toBeCloseTo(1.09, 2); // 545k / 500k
    expect(r.isSpike).toBe(false); // below the 1.2 bar despite steady climb
  });

  it("treats a dead pool coming alive as a burst", () => {
    const r = detectVolumeSpike({ volumes: [0, 0, 0, 0, 12_000], ...cfg });
    expect(r.isSpike).toBe(true);
    expect(r.ratio).toBe(Number.POSITIVE_INFINITY);
  });

  it("ignores negative and NaN readings", () => {
    const r = detectVolumeSpike({
      volumes: [Number.NaN, -5, 100, 95, 105, 99, 300],
      ...cfg,
    });
    expect(r.isSpike).toBe(true); // filtered to [100,95,105,99,300]; base=100
  });
});

describe("hot-window volume-burst trigger", () => {
  it("enters on a burst even while the fee ratio lags below its floor", () => {
    const r = evaluateHotWindowEnter({
      config: spikeCfg,
      feeTvlRatio1h: 0.3, // below floor 1 — trigger A fails
      tvlUsd: 3000,
      volumeSpike: { isSpike: true, ratio: 4 },
      volume24hUsd: 25_000, // above the absolute floor
    });
    expect(r.qualify).toBe(true);
  });

  it("requires the absolute volume floor for the burst path", () => {
    const r = evaluateHotWindowEnter({
      config: spikeCfg,
      feeTvlRatio1h: 0.3,
      tvlUsd: 3000,
      volumeSpike: { isSpike: true, ratio: 4 },
      volume24hUsd: 5_000, // real spike but dead-pool absolute volume
    });
    expect(r.qualify).toBe(false);
  });

  it("does not enter on a burst when the verdict is absent or negative", () => {
    for (const spike of [null, undefined, { isSpike: false, ratio: 1.2 }] as const) {
      const r = evaluateHotWindowEnter({
        config: spikeCfg,
        feeTvlRatio1h: 0.3,
        tvlUsd: 3000,
        volumeSpike: spike,
        volume24hUsd: 25_000,
      });
      expect(r.qualify).toBe(false);
    }
  });

  it("keeps trigger-A-only behavior when volumeSpike is unconfigured", () => {
    // No volumeSpike config → bursting can never be true regardless of input.
    const r = evaluateHotWindowEnter({
      config: baseCfg,
      feeTvlRatio1h: 0.9,
      tvlUsd: 3000,
      volumeSpike: { isSpike: true, ratio: 99 },
      volume24hUsd: 999_999,
    });
    expect(r.qualify).toBe(false);
  });

  it("burst + printing both present still qualifies once", () => {
    const r = evaluateHotWindowEnter({
      config: spikeCfg,
      feeTvlRatio1h: 2.0,
      tvlUsd: 3000,
      volumeSpike: { isSpike: true, ratio: 4 },
      volume24hUsd: 25_000,
    });
    expect(r.qualify).toBe(true);
  });

  it("burst path respects the depth band identically", () => {
    const r = evaluateHotWindowEnter({
      config: spikeCfg,
      feeTvlRatio1h: 0.3,
      tvlUsd: 8000, // too deep for economic share at $30 entry
      volumeSpike: { isSpike: true, ratio: 4 },
      volume24hUsd: 25_000,
    });
    expect(r.qualify).toBe(false);
    expect((r.rejectReason ?? "").toLowerCase()).toContain("depth");
  });
});
