/** Churn circuit breaker tests: per-pool same-day re-entry cap. */
import { describe, expect, it } from "vitest";
import { countEntriesOnUtcDay, evaluateChurnGuard, utcDayStart } from "../engine/churn-guard.js";

const DAY = 86_400_000;
const day0 = utcDayStart(Date.UTC(2026, 7, 22, 10, 0, 0));

describe("utcDayStart", () => {
  it("floors to UTC midnight", () => {
    expect(day0).toBe(Date.UTC(2026, 7, 22, 0, 0, 0));
    expect(utcDayStart(day0 + 1)).toBe(day0);
    expect(utcDayStart(day0 - 1)).toBe(day0 - DAY);
  });
});

describe("countEntriesOnUtcDay", () => {
  it("counts only entries within the day window", () => {
    const entries = [
      { openedAt: day0 - 1000, closed: true }, // yesterday — out
      { openedAt: day0 + 1000, closed: true },
      { openedAt: day0 + DAY / 2, closed: true },
      { openedAt: day0 + DAY, closed: false }, // next day — out
    ];
    expect(countEntriesOnUtcDay(entries, day0)).toBe(2);
  });

  it("counts open and closed rows alike", () => {
    const entries = [
      { openedAt: day0 + 1000, closed: true },
      { openedAt: day0 + 2000, closed: false },
    ];
    expect(countEntriesOnUtcDay(entries, day0)).toBe(2);
  });
});

describe("evaluateChurnGuard", () => {
  it("never blocks when the cap is 0 (operator opt-out)", () => {
    const history = Array.from({ length: 50 }, (_, i) => ({
      openedAt: day0 + i * 1000,
      closed: true,
    }));
    expect(
      evaluateChurnGuard({ history, maxEntriesPerPoolPerDay: 0, nowMs: day0 + DAY }).blocked,
    ).toBe(false);
  });

  it("blocks when today's entries reach the cap", () => {
    const history = [
      { openedAt: day0 + 1000, closed: true },
      { openedAt: day0 + 2000, closed: true },
      { openedAt: day0 + 3000, closed: false },
      { openedAt: day0 + 4000, closed: true },
      { openedAt: day0 - DAY, closed: true }, // yesterday — free
    ];
    const v = evaluateChurnGuard({ history, maxEntriesPerPoolPerDay: 4, nowMs: day0 + 5000 });
    expect(v.blocked).toBe(true);
    expect(v.todayCount).toBe(4);
  });

  it("passes under the cap and resets next day", () => {
    const history = [
      { openedAt: day0 + 1000, closed: true },
      { openedAt: day0 + 2000, closed: true },
    ];
    expect(
      evaluateChurnGuard({ history, maxEntriesPerPoolPerDay: 4, nowMs: day0 + 3000 }).blocked,
    ).toBe(false);
    expect(
      evaluateChurnGuard({ history, maxEntriesPerPoolPerDay: 4, nowMs: day0 + DAY }).blocked,
    ).toBe(false);
  });

  it("fails open on empty history", () => {
    const v = evaluateChurnGuard({ history: [], maxEntriesPerPoolPerDay: 4, nowMs: Date.now() });
    expect(v.blocked).toBe(false);
    expect(v.todayCount).toBe(0);
  });
});
