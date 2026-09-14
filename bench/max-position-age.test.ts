/** Hard age backstop: EXIT once open past maxAgeMs, regardless of measured-fee status. */
import { describe, expect, it } from "vitest";
import {
  isMaxPositionAgeBreached,
  maxPositionAgeReasoning,
} from "../engine/max-position-age.js";

const DAY_MS = 86_400_000;

describe("max position age backstop", () => {
  it("does not fire when disabled (maxAgeMs <= 0)", () => {
    expect(
      isMaxPositionAgeBreached({ positionMode: null, ageMs: 30 * DAY_MS, maxAgeMs: 0 }),
    ).toBe(false);
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
