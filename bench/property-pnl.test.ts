import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  applyCompoundToCostBasis,
  computeFeeAprPct,
  computeHodlValueUsd,
  computePositionAnalytics,
  computeRealizedPnlUsd,
  type PositionAnalyticsInput,
} from "../engine/pnl.js";

const NUM_RUNS = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Bounded finite USD amount. */
const usd = (max = 1e9) => fc.double({ min: 0, max, noNaN: true });

// ─── Realized PnL ────────────────────────────────────────────────────────────

describe("property: computeRealizedPnlUsd", () => {
  it("is the additive identity and never null for finite non-negative inputs", () => {
    fc.assert(
      fc.property(usd(), usd(), usd(), usd(), (withdrawn, fees, rewards, deposited) => {
        const realized = computeRealizedPnlUsd(withdrawn, fees, deposited, rewards);
        // Actual contract: this pure kernel ALWAYS returns a finite number.
        // There is no null path here — the unresolved-pricing NULL (n/a) is
        // decided in the program layer (exitPosition → withdrawnUsd null), not
        // in this arithmetic. So we pin the real invariant: total correctness.
        expect(Number.isFinite(realized)).toBe(true);
        expect(realized).toBe(withdrawn + fees + rewards - deposited);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("is conserved whether fees are claimed pre-exit or swept at exit (no double counting)", () => {
    fc.assert(
      fc.property(usd(), usd(), usd(), usd(), (principal, fees, rewards, deposited) => {
        // Path A — fees claimed during the lifecycle: withdrawal is principal
        // only and prior-claimed fees carry the claimed amount.
        const claimedFirst = computeRealizedPnlUsd(principal, fees, deposited, rewards);
        // Path B — the same fees are never claimed and instead swept into the
        // withdrawal at close: prior-claimed fees are 0, the withdrawal holds
        // principal + fees. Both totals must agree — exactly once.
        const sweptAtExit = computeRealizedPnlUsd(principal + fees, 0, deposited, rewards);
        expect(claimedFirst).toBeCloseTo(sweptAtExit, 8);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── Compound cost-basis bookkeeping ─────────────────────────────────────────

describe("property: applyCompoundToCostBasis", () => {
  const compoundArb = fc.record({
    depositedUsd: usd(1e6),
    currentValueUsd: usd(1e6),
    compoundedFeesUsd: usd(1e6),
  });

  it("raises cost basis and current value by the exact same delta (gap preserved)", () => {
    fc.assert(
      fc.property(compoundArb, ({ depositedUsd, currentValueUsd, compoundedFeesUsd }) => {
        const after = applyCompoundToCostBasis({
          depositedUsd,
          currentValueUsd,
          highestValueUsd: Math.max(depositedUsd, currentValueUsd),
          compoundedFeesUsd,
        });
        // Lockstep: both columns move by the compounded fee, so total-PnL math
        // (current + fees − basis) is continuous across the compound.
        expect(after.depositedUsd - depositedUsd).toBeCloseTo(compoundedFeesUsd, 6);
        expect(after.currentValueUsd - currentValueUsd).toBeCloseTo(compoundedFeesUsd, 6);
        expect(after.depositedUsd - after.currentValueUsd).toBeCloseTo(
          depositedUsd - currentValueUsd,
          6,
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("never decreases a tracked peak and never widens the trailing-stop distance", () => {
    // Domain: highestValueUsd is a running peak, so it is at least the current
    // mark and the cost basis. Under that invariant a compound can only narrow
    // (or preserve) the highest−current distance, never widen it.
    const arb = fc.record({
      depositedUsd: usd(1e6),
      currentValueUsd: usd(1e6),
      compoundedFeesUsd: usd(1e6),
      peakHeadroom: usd(1e6),
      trackPeak: fc.boolean(),
    });
    fc.assert(
      fc.property(arb, (v) => {
        const floor = Math.max(v.depositedUsd, v.currentValueUsd);
        const highestValueUsd = v.trackPeak ? floor + v.peakHeadroom : null;
        const distanceBefore =
          highestValueUsd === null ? null : highestValueUsd - v.currentValueUsd;

        const after = applyCompoundToCostBasis({
          depositedUsd: v.depositedUsd,
          currentValueUsd: v.currentValueUsd,
          highestValueUsd,
          compoundedFeesUsd: v.compoundedFeesUsd,
        });

        if (highestValueUsd !== null) {
          // A running maximum can only rise.
          expect(after.highestValueUsd).toBeGreaterThanOrEqual(highestValueUsd - 1e-6);
          // Trailing-stop distance preserved or narrowed — never widened, never < 0.
          const distanceAfter = after.highestValueUsd - after.currentValueUsd;
          expect(distanceAfter).toBeGreaterThanOrEqual(-1e-6);
          expect(distanceAfter).toBeLessThanOrEqual((distanceBefore ?? 0) + 1e-6);
        } else {
          // An untracked peak seeds to a value ≥ the freshly compounded mark.
          expect(after.highestValueUsd).toBeGreaterThanOrEqual(after.currentValueUsd - 1e-6);
        }
        expect(Number.isFinite(after.highestValueUsd)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── Fee APR purity ───────────────────────────────────────────────────────────

describe("property: fee APR purity (rewards never leak into fee APR)", () => {
  it("feeAprPct is identical across reward levels while rewards still flow into total PnL", () => {
    const arb = fc.record({
      depositedUsd: fc.double({ min: 1, max: 1e6, noNaN: true }),
      currentValueUsd: usd(1e6),
      fees: usd(1e6),
      rewards: usd(1e6),
      ageMs: fc.double({ min: 1, max: 365 * DAY_MS, noNaN: true }),
    });
    fc.assert(
      fc.property(arb, ({ depositedUsd, currentValueUsd, fees, rewards, ageMs }) => {
        // Pin the age exactly (openedAt 0, now = ageMs) so the analytics' internal
        // age (now − openedAt) equals the `ageMs` the standalone APR is fed — no
        // large-number cancellation noise between the two computations.
        const now = ageMs;
        const base: PositionAnalyticsInput = {
          depositedUsd,
          currentValueUsd,
          cumulativeFeesClaimedUsd: fees,
          entryPriceUsd: null,
          entryAmountXUsd: null,
          entryAmountYUsd: null,
          openedAtMs: 0,
          outOfRangeSinceMs: null,
        };
        const withNoRewards = computePositionAnalytics(base, null, now);
        const withRewards = computePositionAnalytics(
          { ...base, cumulativeRewardsClaimedUsd: rewards },
          null,
          now,
        );

        const aprNone = withNoRewards.feeAprPct;
        const aprSome = withRewards.feeAprPct;
        const pure = computeFeeAprPct(fees, depositedUsd, ageMs);
        if (aprNone === null || aprSome === null || pure === null) {
          throw new Error("fee APR must be defined for a positive cost basis and age");
        }

        // Rewards must NEVER perturb fee APR …
        expect(aprSome).toBeCloseTo(aprNone, 6);
        // … which is exactly the reward-free standalone computation.
        expect(aprNone).toBeCloseTo(pure, 6);
        // Sanity that the isolation is meaningful: rewards DO flow into total
        // (unrealized) PnL, linearly and in full.
        expect(withRewards.unrealizedPnlUsd - withNoRewards.unrealizedPnlUsd).toBeCloseTo(
          rewards,
          6,
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── HODL benchmark ────────────────────────────────────────────────────────────

describe("property: computeHodlValueUsd", () => {
  // Tight bounds keep the absolute FP error of the products well below the
  // toBeCloseTo precision used below.
  const leg = fc.double({ min: 0, max: 1000, noNaN: true });
  const entryPrice = fc.double({ min: 1, max: 1000, noNaN: true });
  const currentPrice = fc.double({ min: 0, max: 1000, noNaN: true });
  const scale = fc.double({ min: 0, max: 5, noNaN: true });

  it("X leg scales linearly with the price ratio, Y leg is price-invariant, zero legs never throw", () => {
    fc.assert(
      fc.property(leg, leg, entryPrice, currentPrice, scale, (x, y, entry, current, k) => {
        const base = computeHodlValueUsd(x, y, entry, current);
        expect(base).not.toBeNull();
        expect(Number.isFinite(base ?? Number.NaN)).toBe(true);

        // The Y leg is the numeraire: a pure-Y position is worth Y at ANY price.
        expect(computeHodlValueUsd(0, y, entry, current)).toBeCloseTo(y, 8);
        expect(computeHodlValueUsd(0, y, entry, current * 0.5)).toBeCloseTo(y, 8);

        // The price-sensitive part (value minus the flat Y leg) is linear in the
        // current price: scaling the current price by k scales that part by k.
        const baseXPart = (base ?? 0) - y; // == x * (current / entry)
        const scaled = computeHodlValueUsd(x, y, entry, current * k);
        expect((scaled ?? 0) - y).toBeCloseTo(k * baseXPart, 6);

        // Single-sided / empty entries never throw and stay finite.
        const empty = computeHodlValueUsd(0, 0, entry, current);
        expect(empty).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("returns null for a non-positive entry price regardless of legs or current price", () => {
    const nonPositiveEntry = fc.double({ min: -1e6, max: 0, noNaN: true });
    fc.assert(
      fc.property(leg, leg, nonPositiveEntry, currentPrice, (x, y, entry, current) => {
        expect(computeHodlValueUsd(x, y, entry, current)).toBeNull();
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
