import { describe, expect, it } from "vitest";
import { computeCooldownForExit, type ExitCooldownConfig } from "../engine/cooldown.js";

const HOUR = 60 * 60 * 1000;

const config: ExitCooldownConfig = {
  oorCooldownMs: 4 * HOUR,
  repeatOorCooldownMs: 12 * HOUR,
  maxOorCooldownExits: 3,
  feeDensityCooldowns: true,
  feeDensityCooldownMinMs: 1 * HOUR,
  feeDensityHighPct: 0.005,
  feeDensityLowPct: 0.0005,
};

function lowYield(feeDensityPerDay: number | null, overrides: Partial<ExitCooldownConfig> = {}) {
  return computeCooldownForExit({
    trigger: "low-yield",
    consecutiveOorExits: 0,
    config: { ...config, ...overrides },
    feeDensityPerDay,
  });
}

describe("cooldown duration math", () => {
  describe("oor trigger (legacy escalation)", () => {
    it("uses the base duration before the escalation threshold", () => {
      // existing 0 → new count 1 < 3
      expect(
        computeCooldownForExit({
          trigger: "oor",
          consecutiveOorExits: 0,
          config,
          feeDensityPerDay: null,
        }),
      ).toBe(4 * HOUR);
      // existing 1 → new count 2 < 3
      expect(
        computeCooldownForExit({
          trigger: "oor",
          consecutiveOorExits: 1,
          config,
          feeDensityPerDay: null,
        }),
      ).toBe(4 * HOUR);
    });

    it("escalates at the maxOorCooldownExits boundary (inclusive)", () => {
      // existing 2 → new count 3 >= 3 → repeat duration
      expect(
        computeCooldownForExit({
          trigger: "oor",
          consecutiveOorExits: 2,
          config,
          feeDensityPerDay: null,
        }),
      ).toBe(12 * HOUR);
    });

    it("keeps the repeat duration for every subsequent OOR exit", () => {
      expect(
        computeCooldownForExit({
          trigger: "oor",
          consecutiveOorExits: 5,
          config,
          feeDensityPerDay: null,
        }),
      ).toBe(12 * HOUR);
      expect(
        computeCooldownForExit({
          trigger: "oor",
          consecutiveOorExits: 99,
          config,
          feeDensityPerDay: null,
        }),
      ).toBe(12 * HOUR);
    });

    it("ignores fee density for OOR exits even when density is high", () => {
      expect(
        computeCooldownForExit({
          trigger: "oor",
          consecutiveOorExits: 0,
          config,
          feeDensityPerDay: 0.5,
        }),
      ).toBe(4 * HOUR);
    });

    it("escalates at custom thresholds", () => {
      const oneStrike = { ...config, maxOorCooldownExits: 1 };
      expect(
        computeCooldownForExit({
          trigger: "oor",
          consecutiveOorExits: 0,
          config: oneStrike,
          feeDensityPerDay: null,
        }),
      ).toBe(12 * HOUR);
    });
  });

  describe("low-yield trigger — static fallbacks", () => {
    it("returns exactly the static duration when the feature is disabled", () => {
      expect(lowYield(0.5, { feeDensityCooldowns: false })).toBe(4 * HOUR);
      expect(lowYield(0, { feeDensityCooldowns: false })).toBe(4 * HOUR);
      expect(lowYield(null, { feeDensityCooldowns: false })).toBe(4 * HOUR);
    });

    it("returns exactly the static duration when density is null", () => {
      expect(lowYield(null)).toBe(4 * HOUR);
    });

    it("returns the static duration for non-finite density instead of crashing", () => {
      expect(lowYield(Number.NaN)).toBe(4 * HOUR);
      expect(lowYield(Number.POSITIVE_INFINITY)).toBe(4 * HOUR);
      expect(lowYield(Number.NEGATIVE_INFINITY)).toBe(4 * HOUR);
    });

    it("returns the static duration for an inverted or collapsed band", () => {
      expect(lowYield(0.002, { feeDensityLowPct: 0.005, feeDensityHighPct: 0.005 })).toBe(4 * HOUR);
      expect(lowYield(0.002, { feeDensityLowPct: 0.01, feeDensityHighPct: 0.005 })).toBe(4 * HOUR);
    });
  });

  describe("low-yield trigger — density scaling", () => {
    it("returns exactly the floor at or above the high threshold", () => {
      expect(lowYield(0.005)).toBe(1 * HOUR);
      expect(lowYield(0.0050001)).toBe(1 * HOUR);
      expect(lowYield(0.27)).toBe(1 * HOUR);
    });

    it("returns exactly the static duration at or below the low threshold", () => {
      expect(lowYield(0.0005)).toBe(4 * HOUR);
      expect(lowYield(0.0004999)).toBe(4 * HOUR);
      expect(lowYield(0)).toBe(4 * HOUR);
    });

    it("interpolates linearly between the thresholds (exact midpoint)", () => {
      // density exactly at the band midpoint → duration exactly at the
      // midpoint between static (4h) and floor (1h) = 2.5h
      const midpointDensity = (config.feeDensityHighPct + config.feeDensityLowPct) / 2;
      expect(lowYield(midpointDensity)).toBe(2.5 * HOUR);
    });

    it("interpolates exactly at the quarter points", () => {
      const band = config.feeDensityHighPct - config.feeDensityLowPct;
      // t = 0.25 → duration = 4h - 0.25 × 3h = 3.25h
      expect(lowYield(config.feeDensityLowPct + band * 0.25)).toBe(3.25 * HOUR);
      // t = 0.75 → duration = 4h - 0.75 × 3h = 1.75h
      expect(lowYield(config.feeDensityLowPct + band * 0.75)).toBe(1.75 * HOUR);
    });

    it("treats negative density as below the low threshold (no crash, static)", () => {
      expect(lowYield(-0.1)).toBe(4 * HOUR);
    });
  });

  describe("low-yield trigger — clamping", () => {
    it("never returns below the floor or above the static duration", () => {
      for (let density = -1; density <= 1; density += 0.02) {
        const duration = lowYield(density);
        expect(Number.isFinite(duration)).toBe(true);
        expect(duration).toBeGreaterThanOrEqual(1 * HOUR);
        expect(duration).toBeLessThanOrEqual(4 * HOUR);
      }
    });

    it("returns the static duration for every density when the floor exceeds it (never inverts)", () => {
      // The old normalization swapped min/max here and handed thin pools the
      // larger "minimum" while high-density exits got the static duration;
      // the guard rejects the inverted relationship instead.
      const inverted = { feeDensityCooldownMinMs: 10 * HOUR };
      const mid = (config.feeDensityHighPct + config.feeDensityLowPct) / 2;
      expect(lowYield(0.01, inverted)).toBe(4 * HOUR); // high density
      expect(lowYield(mid, inverted)).toBe(4 * HOUR); // interpolated density
      expect(lowYield(0, inverted)).toBe(4 * HOUR); // low density
      expect(lowYield(null, inverted)).toBe(4 * HOUR); // missing density
      expect(lowYield(Number.NaN, inverted)).toBe(4 * HOUR);
    });

    it("collapses to a single value when the floor equals the static duration", () => {
      expect(lowYield(0.5, { feeDensityCooldownMinMs: 4 * HOUR })).toBe(4 * HOUR);
      expect(lowYield(0.002, { feeDensityCooldownMinMs: 4 * HOUR })).toBe(4 * HOUR);
      expect(lowYield(0, { feeDensityCooldownMinMs: 4 * HOUR })).toBe(4 * HOUR);
    });
  });

  describe("low-yield trigger — monotonicity", () => {
    it("never increases the duration as density rises", () => {
      let previous = lowYield(-0.01);
      for (let i = 0; i <= 200; i++) {
        const density = -0.01 + (i / 200) * 0.08;
        const duration = lowYield(density);
        expect(duration).toBeLessThanOrEqual(previous);
        previous = duration;
      }
    });
  });
});
