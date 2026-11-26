import { describe, expect, it } from "vitest";
import { breakEvenHoldMs, resolveExitMaturityMs } from "../engine/hold-policy.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

describe("breakEvenHoldMs", () => {
  it("is the round-trip cost divided by the position's own realized fee rate", () => {
    // $25 of fees over 10 days on a $1,000 position = $2.50/day.
    // A $5 round trip therefore needs 2 days.
    const hold = breakEvenHoldMs({
      ageMs: 10 * DAY,
      accruedFeesUsd: 25,
      roundTripCostUsd: 5,
    });
    expect(hold).toBeCloseTo(2 * DAY, -3);
  });

  it("matches the identity cost% x 365 / APR% for a position earning its APR", () => {
    // $1,000 at 71% APR for 4 hours earns 1000*0.71*4/(24*365) = $0.3242.
    const accrued = (1000 * 0.71 * 4) / (24 * 365);
    const hold = breakEvenHoldMs({ ageMs: 4 * HOUR, accruedFeesUsd: accrued, roundTripCostUsd: 3 });
    // 0.3% of 1000 = $3 round trip; break-even at 71% APR is 1.54 days.
    expect(hold).toBeGreaterThan(1.5 * DAY);
    expect(hold).toBeLessThan(1.6 * DAY);
  });

  it("is null when nothing has accrued yet (unknown, never zero)", () => {
    expect(breakEvenHoldMs({ ageMs: DAY, accruedFeesUsd: 0, roundTripCostUsd: 5 })).toBeNull();
    expect(breakEvenHoldMs({ ageMs: 0, accruedFeesUsd: 5, roundTripCostUsd: 5 })).toBeNull();
    expect(breakEvenHoldMs({ ageMs: DAY, accruedFeesUsd: 5, roundTripCostUsd: 0 })).toBeNull();
  });

  it("shortens as the fee rate rises", () => {
    const slow =
      breakEvenHoldMs({ ageMs: DAY, accruedFeesUsd: 1, roundTripCostUsd: 3 }) ?? Number.NaN;
    const fast =
      breakEvenHoldMs({ ageMs: DAY, accruedFeesUsd: 10, roundTripCostUsd: 3 }) ?? Number.NaN;
    expect(fast).toBeLessThan(slow);
  });
});

describe("resolveExitMaturityMs", () => {
  const base = { ageMs: DAY, fallbackMs: 12 * HOUR };

  it("uses the measured break-even hold when the rate is known", () => {
    // $10/day on a $5 round trip = 0.5 day.
    const maturity = resolveExitMaturityMs({ ...base, accruedFeesUsd: 10, roundTripCostUsd: 5 });
    expect(maturity).toBeCloseTo(0.5 * DAY, -3);
  });

  it("falls back to the static gate when the rate is unknown", () => {
    const maturity = resolveExitMaturityMs({ ...base, accruedFeesUsd: 0, roundTripCostUsd: 5 });
    expect(maturity).toBe(12 * HOUR);
  });

  it("does NOT cap a slow position by default — the real backstops own dead capital", () => {
    // $0.0001/day against a $5 round trip is ~137 years. Capping that at 24h
    // would re-impose the fixed gate this module removes; MAX_POSITION_AGE_MS
    // (7d) and fee starvation (72h) are the backstops that catch it.
    const maturity = resolveExitMaturityMs({
      ageMs: DAY,
      accruedFeesUsd: 0.0001,
      roundTripCostUsd: 5,
      fallbackMs: 12 * HOUR,
    });
    expect(maturity).toBeGreaterThan(365 * DAY);
  });

  it("still honours an explicit cap for callers that want one", () => {
    const maturity = resolveExitMaturityMs({
      ageMs: DAY,
      accruedFeesUsd: 0.0001,
      roundTripCostUsd: 5,
      fallbackMs: 12 * HOUR,
      capMs: 2 * DAY,
    });
    expect(maturity).toBe(2 * DAY);
  });

  it("lets a high-fee position exit far sooner than the static 12h gate", () => {
    // 31,000% APR on $20 for 5 minutes: ~$0.59, against a $0.06 round trip.
    const accrued = ((20 * 310 * (5 / 60 / 24)) / 365) * 365; // deliberately large
    const maturity = resolveExitMaturityMs({
      ageMs: 5 * 60_000,
      accruedFeesUsd: accrued,
      roundTripCostUsd: 0.06,
      fallbackMs: 12 * HOUR,
    });
    expect(maturity).toBeLessThan(12 * HOUR);
  });

  it("never returns a negative or NaN gate", () => {
    expect(
      resolveExitMaturityMs({ ...base, accruedFeesUsd: 1, roundTripCostUsd: Number.NaN }),
    ).toBe(12 * HOUR);
    expect(
      resolveExitMaturityMs({ ...base, fallbackMs: -5, accruedFeesUsd: 0, roundTripCostUsd: 1 }),
    ).toBe(0);
  });
});
