/** Launch-position policy unit tests (Slice A): every exit trigger at its
 * boundary, non-fires below thresholds, unknown-value null handling, and
 * entry-sizing caps. */
import { describe, it, expect } from "vitest";
import {
  launchPositionExit,
  launchEntrySizeUsd,
  type LaunchPositionExitInput,
} from "../engine/launch-position.js";

const NOW = 1_800_000_000_000;
const HOUR_MS = 3.6e6;

/** Healthy base state: 1h old, fees well above the 10% floor, no drawdown,
 * healthy fee/IL ratio — nothing should fire. */
function baseInput(overrides: Partial<LaunchPositionExitInput> = {}): LaunchPositionExitInput {
  return {
    createdAtMs: NOW - HOUR_MS,
    now: NOW,
    timeboxHours: 6,
    volumeDecayExitPct: 0.1,
    drawdownPct: 0.25,
    currentFees1hUsd: 20,
    peakFees1hUsd: 100,
    currentValueUsd: 100,
    peakValueUsd: 100,
    feeIlRatio: 2,
    ...overrides,
  };
}

describe("launchPositionExit — timebox", () => {
  it("fires at exactly timeboxHours", () => {
    const r = launchPositionExit(
      baseInput({ createdAtMs: NOW - 6 * HOUR_MS, currentFees1hUsd: 50 }),
    );
    expect(r).toEqual({ exit: true, reason: "timebox" });
  });

  it("fires past the timebox", () => {
    const r = launchPositionExit(
      baseInput({ createdAtMs: NOW - 7 * HOUR_MS, currentFees1hUsd: 50 }),
    );
    expect(r).toEqual({ exit: true, reason: "timebox" });
  });

  it("does not fire just below the timebox", () => {
    const r = launchPositionExit(baseInput({ createdAtMs: NOW - 6 * HOUR_MS + 1 }));
    expect(r.exit).toBe(false);
  });

  it("does not fire timebox for a young position (decay may still fire)", () => {
    // Age-based exit requires the timebox to elapse; a young position whose
    // fees collapsed still exits via volume-decay, not timebox.
    const r = launchPositionExit(baseInput({ currentFees1hUsd: 0 }));
    expect(r).toEqual({ exit: true, reason: "volume-decay" });
  });
});

describe("launchPositionExit — volume decay", () => {
  it("fires when current 1h fees fall below 10% of peak", () => {
    const r = launchPositionExit(baseInput({ currentFees1hUsd: 9.99 }));
    expect(r).toEqual({ exit: true, reason: "volume-decay" });
  });

  it("does not fire at exactly 10% of peak (strict <)", () => {
    const r = launchPositionExit(baseInput({ currentFees1hUsd: 10 }));
    expect(r.exit).toBe(false);
  });

  it("does not fire above the 10% floor", () => {
    const r = launchPositionExit(baseInput({ currentFees1hUsd: 50 }));
    expect(r.exit).toBe(false);
  });

  it("does not fire when peak fees are unknown", () => {
    const r = launchPositionExit(baseInput({ currentFees1hUsd: 1, peakFees1hUsd: null }));
    expect(r.exit).toBe(false);
  });

  it("does not fire when current fees are unknown", () => {
    const r = launchPositionExit(baseInput({ currentFees1hUsd: null }));
    expect(r.exit).toBe(false);
  });

  it("does not fire when peak fees are zero", () => {
    const r = launchPositionExit(baseInput({ currentFees1hUsd: 0, peakFees1hUsd: 0 }));
    expect(r.exit).toBe(false);
  });
});

describe("launchPositionExit — drawdown", () => {
  it("fires at exactly 25% drawdown", () => {
    const r = launchPositionExit(baseInput({ currentValueUsd: 75 }));
    expect(r).toEqual({ exit: true, reason: "drawdown" });
  });

  it("fires deeper than 25% drawdown", () => {
    const r = launchPositionExit(baseInput({ currentValueUsd: 50 }));
    expect(r).toEqual({ exit: true, reason: "drawdown" });
  });

  it("does not fire just above the 25% line", () => {
    const r = launchPositionExit(baseInput({ currentValueUsd: 75.01 }));
    expect(r.exit).toBe(false);
  });

  it("does not fire when peak value is unknown", () => {
    const r = launchPositionExit(baseInput({ currentValueUsd: 10, peakValueUsd: null }));
    expect(r.exit).toBe(false);
  });

  it("is disabled when drawdownPct is 0 (0 = off convention)", () => {
    const r = launchPositionExit(baseInput({ currentValueUsd: 10, drawdownPct: 0 }));
    expect(r.exit).toBe(false);
  });
});

describe("launchPositionExit — fee/IL floor", () => {
  it("fires below the 0.5 floor", () => {
    const r = launchPositionExit(baseInput({ feeIlRatio: 0.4999 }));
    expect(r).toEqual({ exit: true, reason: "fee-il" });
  });

  it("does not fire at exactly 0.5 (floor is exclusive)", () => {
    const r = launchPositionExit(baseInput({ feeIlRatio: 0.5 }));
    expect(r.exit).toBe(false);
  });

  it("does not fire above the floor", () => {
    const r = launchPositionExit(baseInput({ feeIlRatio: 1.2 }));
    expect(r.exit).toBe(false);
  });

  it("does not fire when the ratio is unknown", () => {
    const r = launchPositionExit(baseInput({ feeIlRatio: null }));
    expect(r.exit).toBe(false);
  });
});

describe("launchPositionExit — rule priority & healthy hold", () => {
  it("timebox wins when several rules fire at once", () => {
    const r = launchPositionExit(
      baseInput({
        createdAtMs: NOW - 10 * HOUR_MS, // timebox
        currentFees1hUsd: 1, // decay
        currentValueUsd: 10, // drawdown
        feeIlRatio: 0.1, // fee-il
      }),
    );
    expect(r).toEqual({ exit: true, reason: "timebox" });
  });

  it("decay wins over drawdown/fee-il when timebox has not elapsed", () => {
    const r = launchPositionExit(
      baseInput({
        currentFees1hUsd: 5, // decay
        currentValueUsd: 10, // drawdown
        feeIlRatio: 0.1, // fee-il
      }),
    );
    expect(r).toEqual({ exit: true, reason: "volume-decay" });
  });

  it("drawdown wins over fee-il when both are below their lines", () => {
    const r = launchPositionExit(baseInput({ currentValueUsd: 60, feeIlRatio: 0.1 }));
    expect(r).toEqual({ exit: true, reason: "drawdown" });
  });

  it("holds when everything is healthy and nulls are absent", () => {
    const r = launchPositionExit(baseInput());
    expect(r).toEqual({ exit: false, reason: null });
  });

  it("holds with all optional signals unknown (timebox backstops later)", () => {
    const r = launchPositionExit(
      baseInput({
        currentFees1hUsd: null,
        peakFees1hUsd: null,
        peakValueUsd: null,
        feeIlRatio: null,
      }),
    );
    expect(r).toEqual({ exit: false, reason: null });
  });
});

describe("launchEntrySizeUsd", () => {
  it("caps at maxSizeUsd when it is the smallest term", () => {
    expect(launchEntrySizeUsd({ walletUsd: 1_000, poolTvlUsd: 100_000, maxSizeUsd: 100 })).toBe(
      100,
    );
  });

  it("caps at 0.005 x pool TVL when that is the smallest term", () => {
    expect(
      launchEntrySizeUsd({ walletUsd: 1_000_000, poolTvlUsd: 10_000, maxSizeUsd: 1_000 }),
    ).toBe(50);
  });

  it("caps at 0.5 x wallet when that is the smallest term", () => {
    expect(launchEntrySizeUsd({ walletUsd: 100, poolTvlUsd: 10_000_000, maxSizeUsd: 1_000 })).toBe(
      50,
    );
  });

  it("floors at 0 for a negative wallet", () => {
    expect(launchEntrySizeUsd({ walletUsd: -100, poolTvlUsd: 10_000_000, maxSizeUsd: 1_000 })).toBe(
      0,
    );
  });

  it("floors at 0 for a negative TVL", () => {
    expect(launchEntrySizeUsd({ walletUsd: 1_000, poolTvlUsd: -1, maxSizeUsd: 100 })).toBe(0);
  });
});
