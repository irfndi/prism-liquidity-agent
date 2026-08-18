import { describe, expect, it } from "vitest";
import {
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
