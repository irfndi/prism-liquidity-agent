import { describe, it, expect } from "vitest";
import {
  calculateTier,
  calculatePlatformFee,
  calculateCreditDiscount,
  TIERS,
} from "../engine/revenue-service.js";

describe("calculateTier", () => {
  it("returns 'free' for zero wallet and zero referrals", () => {
    expect(calculateTier(0, 0)).toBe("free");
  });

  it("returns 'free' for wallet below pro minimum", () => {
    expect(calculateTier(5, 0)).toBe("free");
    expect(calculateTier(9.9, 2)).toBe("free");
  });

  it("returns 'pro' for wallet at pro minimum", () => {
    expect(calculateTier(10, 0)).toBe("pro");
  });

  it("returns 'pro' for referrals at pro minimum", () => {
    expect(calculateTier(0, 3)).toBe("pro");
  });

  it("returns 'pro' for wallet above pro but below fund", () => {
    expect(calculateTier(50, 5)).toBe("pro");
  });

  it("returns 'fund' for wallet at fund minimum", () => {
    expect(calculateTier(100, 0)).toBe("fund");
  });

  it("returns 'fund' for referrals at fund minimum", () => {
    expect(calculateTier(0, 10)).toBe("fund");
  });

  it("returns 'fund' for wallet above fund minimum", () => {
    expect(calculateTier(500, 20)).toBe("fund");
  });

  it("uses OR logic (wallet OR referrals)", () => {
    expect(calculateTier(0, 3)).toBe("pro"); // referrals qualify
    expect(calculateTier(10, 0)).toBe("pro"); // wallet qualifies
    expect(calculateTier(0, 10)).toBe("fund"); // referrals qualify
    expect(calculateTier(100, 0)).toBe("fund"); // wallet qualifies
  });

  it("returns 'free' for negative inputs", () => {
    expect(calculateTier(-1, -1)).toBe("free");
  });
});

describe("calculatePlatformFee", () => {
  const prices = { x: 2, y: 1 }; // token X = $2, token Y = $1

  it("returns zero fee for free tier", () => {
    const result = calculatePlatformFee("free", 100, 200, prices);
    expect(result.platformFeeUsd).toBe(0);
    expect(result.netFeeX).toBe(100);
    expect(result.netFeeY).toBe(200);
  });

  it("returns zero fee for unknown tier", () => {
    const result = calculatePlatformFee("unknown", 100, 200, prices);
    expect(result.platformFeeUsd).toBe(0);
    expect(result.netFeeX).toBe(100);
    expect(result.netFeeY).toBe(200);
  });

  it("calculates 5% platform fee for pro tier", () => {
    // 100 X @ $2 = $200, 200 Y @ $1 = $200, total = $400
    // 5% of $400 = $20
    const result = calculatePlatformFee("pro", 100, 200, prices);
    expect(result.platformFeeUsd).toBe(20);
  });

  it("calculates 10% platform fee for fund tier", () => {
    // 100 X @ $2 = $200, 200 Y @ $1 = $200, total = $400
    // 10% of $400 = $40
    const result = calculatePlatformFee("fund", 100, 200, prices);
    expect(result.platformFeeUsd).toBe(40);
  });

  it("splits fee proportionally between tokens", () => {
    // 100 X @ $2 = $200, 200 Y @ $1 = $200
    // 50/50 split, 5% platform fee = $20 total
    // X share = $10 / $2 = 5, Y share = $10 / $1 = 10
    const result = calculatePlatformFee("pro", 100, 200, prices);
    expect(result.netFeeX).toBe(95); // 100 - 5
    expect(result.netFeeY).toBe(190); // 200 - 10
  });

  it("handles single-token fees (X only)", () => {
    const result = calculatePlatformFee("pro", 100, 0, prices);
    expect(result.platformFeeUsd).toBe(10); // 100 * 2 * 0.05
    expect(result.netFeeX).toBe(95);
    expect(result.netFeeY).toBe(0);
  });

  it("handles single-token fees (Y only)", () => {
    const result = calculatePlatformFee("pro", 0, 100, prices);
    expect(result.platformFeeUsd).toBe(5); // 100 * 1 * 0.05
    expect(result.netFeeX).toBe(0);
    expect(result.netFeeY).toBe(95);
  });

  it("handles zero fees", () => {
    const result = calculatePlatformFee("pro", 0, 0, prices);
    expect(result.platformFeeUsd).toBe(0);
    expect(result.netFeeX).toBe(0);
    expect(result.netFeeY).toBe(0);
  });

  it("never returns negative net fees", () => {
    // Edge case: if platform fee exceeds fee amount due to price rounding
    const result = calculatePlatformFee("fund", 1, 1, { x: 100, y: 100 });
    expect(result.netFeeX).toBeGreaterThanOrEqual(0);
    expect(result.netFeeY).toBeGreaterThanOrEqual(0);
  });

  it("handles asymmetric token values", () => {
    // X is much more valuable than Y
    const highPrices = { x: 100, y: 0.01 };
    const result = calculatePlatformFee("pro", 1, 1000, highPrices);
    // Total fee USD = 1*100 + 1000*0.01 = $110
    // Platform fee = 5% of $110 = $5.50
    expect(result.platformFeeUsd).toBeCloseTo(5.5, 2);
    expect(result.netFeeX).toBeLessThan(1);
    expect(result.netFeeY).toBeLessThan(1000);
  });
});

describe("calculateCreditDiscount", () => {
  it("returns zero when no credits", () => {
    expect(calculateCreditDiscount(0, 100)).toBe(0);
  });

  it("returns zero when no fee", () => {
    expect(calculateCreditDiscount(100, 0)).toBe(0);
  });

  it("credits less than max discount → full credits used", () => {
    // max discount = $100 * 0.5 = $50, credits = $30
    expect(calculateCreditDiscount(30, 100)).toBe(30);
  });

  it("credits more than max discount → capped at 50%", () => {
    // max discount = $100 * 0.5 = $50, credits = $100
    expect(calculateCreditDiscount(100, 100)).toBe(50);
  });

  it("credits equal to max discount → exact match", () => {
    expect(calculateCreditDiscount(50, 100)).toBe(50);
  });

  it("handles fractional values", () => {
    expect(calculateCreditDiscount(33.33, 100)).toBeCloseTo(33.33, 2);
  });
});

describe("TIERS constants", () => {
  it("has expected tier structure", () => {
    expect(TIERS.free!.platformFeeRate).toBe(0);
    expect(TIERS.pro!.platformFeeRate).toBe(0.05);
    expect(TIERS.fund!.platformFeeRate).toBe(0.1);
  });

  it("free tier has zero fees", () => {
    expect(TIERS.free!.managementFeeRate).toBe(0);
    expect(TIERS.free!.performanceFeeRate).toBe(0);
    expect(TIERS.free!.maxFreeSol).toBe(0);
  });
});
