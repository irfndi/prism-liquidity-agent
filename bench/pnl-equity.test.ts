import { describe, it, expect } from "vitest";
import {
  computePortfolioEquity,
  paperClmmMarkUsd,
  type PaperClmmMarkInput,
} from "../engine/pnl.js";

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

describe("paperClmmMarkUsd", () => {
  const base = {
    depositedUsd: 1000,
    entryPriceUsd: 150,
    anchorBinId: 5000,
    currentPrice: 150,
    lowerBinId: 4980,
    upperBinId: 5020,
    binStep: 10,
  } satisfies PaperClmmMarkInput;

  it("marks cost basis at the anchor price (no phantom IL)", () => {
    expect(paperClmmMarkUsd(base)).toBeCloseTo(1000, 6);
  });

  it("shows IL on a price move (mark below HODL)", () => {
    // HODL at +10% would be 1050; the concentrated LP mark must be lower.
    const mark = paperClmmMarkUsd({ ...base, currentPrice: 165 });
    expect(mark).not.toBeNull();
    expect(mark!).toBeLessThan(1050);
    expect(mark!).toBeGreaterThan(0);
  });

  it("goes flat when price exits above the range (HODL keeps appreciating)", () => {
    const edge = paperClmmMarkUsd({ ...base, currentPrice: 160 });
    const far = paperClmmMarkUsd({ ...base, currentPrice: 300 });
    expect(edge).not.toBeNull();
    expect(far).not.toBeNull();
    // Fully in one token above the range: doubling the price again adds nothing.
    expect(far!).toBeCloseTo(edge!, 6);
  });

  it("fails open (null) when the entry anchor is unknown", () => {
    expect(paperClmmMarkUsd({ ...base, entryPriceUsd: null })).toBeNull();
    expect(paperClmmMarkUsd({ ...base, anchorBinId: null })).toBeNull();
    expect(paperClmmMarkUsd({ ...base, binStep: 0 })).toBeNull();
  });

  it("fails open (null) when the anchor sits outside the range (single-sided shape)", () => {
    expect(paperClmmMarkUsd({ ...base, anchorBinId: 4900 })).toBeNull();
    expect(paperClmmMarkUsd({ ...base, anchorBinId: 5100 })).toBeNull();
  });

  it("prefers the valuation anchor over the entry anchor when stamped", () => {
    // Rebalanced at 165 with value 900: the mark prices the 900 forward
    // from 165, not the original 1000 from 150.
    const mark = paperClmmMarkUsd({
      ...base,
      currentPrice: 165,
      valuationAnchorPriceUsd: 165,
      valuationAnchorBinId: 5000,
      valuationAnchorValueUsd: 900,
    });
    expect(mark).toBeCloseTo(900, 6);
  });

  it("stays continuous across a re-centered range (no fabrication jump)", () => {
    // Entry 1000 @150 (range 4980-5020); price 150 → 142, mark ~947;
    // rebalance re-centers to 4960-5000 and re-stamps the anchor at the
    // live print: the mark equals the anchor value exactly — no $332 jump.
    const before = paperClmmMarkUsd({ ...base, currentPrice: 142 });
    expect(before).not.toBeNull();
    const after = paperClmmMarkUsd({
      ...base,
      currentPrice: 142,
      lowerBinId: 4960,
      upperBinId: 5000,
      valuationAnchorPriceUsd: 142,
      valuationAnchorBinId: 4980,
      valuationAnchorValueUsd: before!,
    });
    expect(after).toBeCloseTo(before!, 6);
  });
});
