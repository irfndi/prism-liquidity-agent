/** Hard age backstop: EXIT once open past maxAgeMs, regardless of measured-fee status. */
import { describe, expect, it } from "vitest";
import {
  isMaxPositionAgeBreached,
  maxPositionAgeReasoning,
  isFeeStarved,
  feeStarvationReasoning,
} from "../engine/max-position-age.js";

const DAY_MS = 86_400_000;

describe("max position age backstop", () => {
  it("does not fire when disabled (maxAgeMs <= 0)", () => {
    expect(isMaxPositionAgeBreached({ positionMode: null, ageMs: 30 * DAY_MS, maxAgeMs: 0 })).toBe(
      false,
    );
  });

  it("does not fire while the position is younger than the backstop", () => {
    expect(
      isMaxPositionAgeBreached({ positionMode: null, ageMs: 6 * DAY_MS, maxAgeMs: 7 * DAY_MS }),
    ).toBe(false);
  });

  it("fires once the position reaches the backstop age", () => {
    expect(
      isMaxPositionAgeBreached({ positionMode: null, ageMs: 7 * DAY_MS, maxAgeMs: 7 * DAY_MS }),
    ).toBe(true);
    expect(
      isMaxPositionAgeBreached({
        positionMode: "normal",
        ageMs: 13 * DAY_MS,
        maxAgeMs: 7 * DAY_MS,
      }),
    ).toBe(true);
  });

  it("exempts launch-mode positions (their own timebox lifecycle bounds them)", () => {
    expect(
      isMaxPositionAgeBreached({
        positionMode: "launch",
        ageMs: 30 * DAY_MS,
        maxAgeMs: 7 * DAY_MS,
      }),
    ).toBe(false);
  });

  it("does not fire on invalid/non-finite inputs", () => {
    expect(
      isMaxPositionAgeBreached({ positionMode: null, ageMs: Number.NaN, maxAgeMs: 7 * DAY_MS }),
    ).toBe(false);
    expect(
      isMaxPositionAgeBreached({
        positionMode: null,
        ageMs: 8 * DAY_MS,
        maxAgeMs: Number.POSITIVE_INFINITY,
      }),
    ).toBe(false);
  });

  it("tags reasoning with [max-position-age] and reports hours", () => {
    const reason = maxPositionAgeReasoning({
      positionMode: null,
      ageMs: 13 * DAY_MS,
      maxAgeMs: 7 * DAY_MS,
    });
    expect(reason.startsWith("[max-position-age]")).toBe(true);
    expect(reason).toContain("312.0h"); // 13 days
    expect(reason).toContain("168.0h"); // 7 days
  });
});

describe("fee-starvation exit (old AND earning nothing)", () => {
  const HOUR_MS = 3_600_000;
  const base = { starveAgeMs: 72 * HOUR_MS, starveFeesUsd: 1 };
  it("stays off when disabled", () => {
    expect(
      isFeeStarved({
        ageMs: 300 * HOUR_MS,
        cumulativeFeesUsd: 0,
        cumulativeRewardsUsd: 0,
        ...base,
        starveAgeMs: 0,
      }),
    ).toBe(false);
  });
  it("stays off for young positions even with zero fees", () => {
    expect(
      isFeeStarved({ ageMs: 5 * HOUR_MS, cumulativeFeesUsd: 0, cumulativeRewardsUsd: 0, ...base }),
    ).toBe(false);
  });
  it("stays off for old earners (fees above floor)", () => {
    expect(
      isFeeStarved({
        ageMs: 200 * HOUR_MS,
        cumulativeFeesUsd: 4.13,
        cumulativeRewardsUsd: 0,
        ...base,
      }),
    ).toBe(false);
  });
  it("fires on survivors: old with dust fees (counts rewards too)", () => {
    expect(
      isFeeStarved({
        ageMs: 228 * HOUR_MS,
        cumulativeFeesUsd: 0.17,
        cumulativeRewardsUsd: 0,
        ...base,
      }),
    ).toBe(true);
    expect(
      isFeeStarved({
        ageMs: 182 * HOUR_MS,
        cumulativeFeesUsd: 0,
        cumulativeRewardsUsd: 0.5,
        ...base,
      }),
    ).toBe(true);
  });
  it("tags reasoning with [fee-starvation]", () => {
    const reason = feeStarvationReasoning({
      ageMs: 228 * HOUR_MS,
      cumulativeFeesUsd: 0.17,
      cumulativeRewardsUsd: 0,
      ...base,
    });
    expect(reason.startsWith("[fee-starvation]")).toBe(true);
    expect(reason).toContain("228.0h");
  });
});
