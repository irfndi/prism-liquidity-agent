import { describe, it, expect } from "vitest";
import { computePortfolioEquity } from "../engine/pnl.js";

describe("computePortfolioEquity (issue #149)", () => {
  const pos = (overrides: Partial<{ v: number; d: number; f: number; r: number }> = {}) => ({
    currentValueUsd: overrides.v ?? 100,
    depositedUsd: overrides.d ?? 80,
    cumulativeFeesClaimedUsd: overrides.f ?? 5,
    cumulativeRewardsClaimedUsd: overrides.r ?? 0,
  });

  it("adds the liquid wallet to position value for true equity", () => {
    const result = computePortfolioEquity({
      walletBalanceUsd: 54.18,
      positions: [pos()],
    });
    expect(result.positionsValueUsd).toBe(100);
    expect(result.walletBalanceUsd).toBe(54.18);
    expect(result.totalEquityUsd).toBeCloseTo(154.18, 2);
  });

  it("computes positions-only unrealized P&L; the wallet stays in equity", () => {
    // wallet 54.18 + positions 36.82 = 91.00 equity; deposits 41.89.
    const result = computePortfolioEquity({
      walletBalanceUsd: 54.18,
      positions: [
        {
          currentValueUsd: 36.82,
          depositedUsd: 41.89,
          cumulativeFeesClaimedUsd: 0,
          cumulativeRewardsClaimedUsd: 0,
        },
      ],
    });
    expect(result.totalEquityUsd).toBeCloseTo(91.0, 2);
    // The idle wallet balance is NOT unrealized gain (the "+127% on a $54
    // wallet" artifact): unrealized = 36.82 − 41.89 = −5.07.
    expect(result.unrealizedPnlUsd).toBeCloseTo(-5.07, 2);
    expect(result.unrealizedPnlPct).toBeCloseTo(-12.1, 1);
    expect(result.walletKnown).toBe(true);
  });

  it("includes claimed fees and rewards in unrealized P&L (wallet excluded)", () => {
    const result = computePortfolioEquity({
      walletBalanceUsd: 10,
      positions: [
        {
          currentValueUsd: 100,
          depositedUsd: 100,
          cumulativeFeesClaimedUsd: 4,
          cumulativeRewardsClaimedUsd: 2,
        },
      ],
    });
    // positions 100 + fees 4 + rewards 2 − deposits 100 = 6 (wallet 10 is
    // equity, not P&L).
    expect(result.unrealizedPnlUsd).toBeCloseTo(6, 6);
    expect(result.unrealizedPnlPct).toBeCloseTo(6, 6);
    expect(result.totalEquityUsd).toBeCloseTo(110, 6);
  });

  it("falls back to positions-only equity when the wallet is unknown (no fabrication)", () => {
    const result = computePortfolioEquity({
      walletBalanceUsd: null,
      positions: [pos()],
    });
    expect(result.walletKnown).toBe(false);
    expect(result.walletBalanceUsd).toBe(0);
    expect(result.totalEquityUsd).toBeCloseTo(100, 6);
    // 100 + 5 − 80 = 25, same as the positions-only figure.
    expect(result.unrealizedPnlUsd).toBeCloseTo(25, 6);
  });

  it("skips non-finite position values and deposits", () => {
    const result = computePortfolioEquity({
      walletBalanceUsd: 10,
      positions: [
        {
          currentValueUsd: Number.NaN,
          depositedUsd: 50,
          cumulativeFeesClaimedUsd: 0,
          cumulativeRewardsClaimedUsd: 0,
        },
        {
          currentValueUsd: 20,
          depositedUsd: Number.POSITIVE_INFINITY,
          cumulativeFeesClaimedUsd: 0,
          cumulativeRewardsClaimedUsd: 0,
        },
        {
          currentValueUsd: 30,
          depositedUsd: 10,
          cumulativeFeesClaimedUsd: 0,
          cumulativeRewardsClaimedUsd: 0,
        },
      ],
    });
    expect(result.positionsValueUsd).toBeCloseTo(50, 6); // 20 + 30 (Infinity is in deposited, not value)
    expect(result.totalDepositedUsd).toBeCloseTo(60, 6); // 50 (NaN-value pos) + 10; Infinity deposit skipped
    expect(result.totalEquityUsd).toBeCloseTo(60, 6); // 50 + 10 wallet
  });

  it("handles an empty portfolio with a known wallet", () => {
    const result = computePortfolioEquity({ walletBalanceUsd: 100, positions: [] });
    expect(result.totalEquityUsd).toBe(100);
    expect(result.positionsValueUsd).toBe(0);
    // No positions → no unrealized P&L; the wallet is equity, not gain.
    expect(result.unrealizedPnlUsd).toBe(0);
    expect(result.unrealizedPnlPct).toBe(0);
    expect(result.walletKnown).toBe(true);
  });
});
