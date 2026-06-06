import { Layer } from "effect";
import { RevenueService } from "./services.js";

// Tier definitions — based on wallet size and referral count
export interface TierConfig {
  readonly name: string;
  readonly minWalletSol: number;
  readonly minReferrals: number;
  readonly platformFeeRate: number; // % of claimed LP fees
  readonly managementFeeRate: number; // annual
  readonly performanceFeeRate: number; // of profits
}

export const TIERS: Record<string, TierConfig> = {
  free: {
    name: "free",
    minWalletSol: 0,
    minReferrals: 0,
    platformFeeRate: 0,
    managementFeeRate: 0,
    performanceFeeRate: 0,
  },
  pro: {
    name: "pro",
    minWalletSol: 10,
    minReferrals: 3,
    platformFeeRate: 0.05, // 5%
    managementFeeRate: 0.01, // 1% annual
    performanceFeeRate: 0.05, // 5% of profits
  },
  fund: {
    name: "fund",
    minWalletSol: 100,
    minReferrals: 10,
    platformFeeRate: 0.1, // 10%
    managementFeeRate: 0.015, // 1.5% annual
    performanceFeeRate: 0.1, // 10% of profits
  },
};

export function calculateTier(
  walletSol: number,
  referralCount: number,
): string {
  const fund = TIERS.fund;
  const pro = TIERS.pro;
  if (!fund || !pro) return "free";
  if (walletSol >= fund.minWalletSol || referralCount >= fund.minReferrals)
    return "fund";
  if (walletSol >= pro.minWalletSol || referralCount >= pro.minReferrals)
    return "pro";
  return "free";
}

// Calculate platform fee deduction from claimed fees
export function calculatePlatformFee(
  tier: string,
  feeXAmount: number,
  feeYAmount: number,
  tokenPrices: { x: number; y: number },
): { platformFeeUsd: number; netFeeX: number; netFeeY: number } {
  const tierConfig = TIERS[tier];
  if (!tierConfig) {
    return { platformFeeUsd: 0, netFeeX: feeXAmount, netFeeY: feeYAmount };
  }
  const totalFeeUsd =
    feeXAmount * tokenPrices.x + feeYAmount * tokenPrices.y;
  const platformFeeUsd = totalFeeUsd * tierConfig.platformFeeRate;

  const xShare =
    totalFeeUsd > 0 ? (feeXAmount * tokenPrices.x) / totalFeeUsd : 0.5;
  const yShare = 1 - xShare;

  const platformFeeX = (platformFeeUsd * xShare) / tokenPrices.x;
  const platformFeeY = (platformFeeUsd * yShare) / tokenPrices.y;

  return {
    platformFeeUsd,
    netFeeX: Math.max(0, feeXAmount - platformFeeX),
    netFeeY: Math.max(0, feeYAmount - platformFeeY),
  };
}

// Calculate credit discount (max 50%)
export function calculateCreditDiscount(
  credits: number,
  feeUsd: number,
): number {
  const maxDiscount = feeUsd * 0.5;
  return Math.min(credits, maxDiscount);
}

// Revenue tracking state
export interface RevenueState {
  readonly userId: string;
  readonly tier: string;
  readonly highWatermark: number; // Highest NAV seen
  readonly totalFeesPaid: number;
  readonly lastFeeCalculation: string; // ISO date
  readonly lockupEndDate?: string;
}

// Fee calculation result
export interface FeeCalculation {
  readonly managementFee: number;
  readonly performanceFee: number;
  readonly totalFee: number;
  readonly newHighWatermark: number;
}

export const RevenueLive = Layer.succeed(RevenueService, {
  calculateTier,
  calculatePlatformFee,
  calculateCreditDiscount,
});
