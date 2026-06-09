import { describe, it, expect } from "vitest";
import { calculateRevenueShare } from "../engine/adapter-service.js";

describe("calculateRevenueShare", () => {
  const FEE_WALLET = "FeeWallet1111111111111111111111111111111111";
  const OPERATOR_WALLET = "OperatorWallet111111111111111111111111111111";

  it("returns zero fees when platformFeeRate is undefined", () => {
    const result = calculateRevenueShare(1000, 2000, undefined, true, 50, FEE_WALLET, OPERATOR_WALLET);
    expect(result.platformFeeX).toBe(0);
    expect(result.platformFeeY).toBe(0);
    expect(result.netFeeX).toBe(1000);
    expect(result.netFeeY).toBe(2000);
    expect(result.operatorFeeX).toBe(0);
    expect(result.operatorFeeY).toBe(0);
    expect(result.amountToTransferX).toBe(0);
    expect(result.amountToTransferY).toBe(0);
    expect(result.isCircular).toBe(false);
  });

  it("returns zero fees when platformFeeRate is 0", () => {
    const result = calculateRevenueShare(1000, 2000, 0, true, 50, FEE_WALLET, OPERATOR_WALLET);
    expect(result.platformFeeX).toBe(0);
    expect(result.platformFeeY).toBe(0);
    expect(result.netFeeX).toBe(1000);
    expect(result.netFeeY).toBe(2000);
  });

  it("returns zero fees when platformFeeRate > 1", () => {
    const result = calculateRevenueShare(1000, 2000, 1.5, true, 50, FEE_WALLET, OPERATOR_WALLET);
    expect(result.platformFeeX).toBe(0);
    expect(result.platformFeeY).toBe(0);
    expect(result.netFeeX).toBe(1000);
    expect(result.netFeeY).toBe(2000);
  });

  it("calculates platform fee correctly at 10% rate", () => {
    const result = calculateRevenueShare(1000, 2000, 0.1, false, 50, FEE_WALLET, OPERATOR_WALLET);
    expect(result.platformFeeX).toBe(100);
    expect(result.platformFeeY).toBe(200);
    expect(result.netFeeX).toBe(900);
    expect(result.netFeeY).toBe(1800);
    expect(result.operatorFeeX).toBe(0);
    expect(result.operatorFeeY).toBe(0);
    expect(result.amountToTransferX).toBe(100);
    expect(result.amountToTransferY).toBe(200);
    expect(result.isCircular).toBe(false);
  });

  it("calculates revenue share at 50% operator split", () => {
    const result = calculateRevenueShare(1000, 2000, 0.1, true, 50, FEE_WALLET, OPERATOR_WALLET);
    expect(result.platformFeeX).toBe(100);
    expect(result.platformFeeY).toBe(200);
    expect(result.operatorFeeX).toBe(50);
    expect(result.operatorFeeY).toBe(100);
    expect(result.netFeeX).toBe(900);
    expect(result.netFeeY).toBe(1800);
    expect(result.amountToTransferX).toBe(50);
    expect(result.amountToTransferY).toBe(100);
  });

  it("calculates revenue share at 100% operator split (keeps all)", () => {
    const result = calculateRevenueShare(1000, 2000, 0.1, true, 100, FEE_WALLET, OPERATOR_WALLET);
    expect(result.platformFeeX).toBe(100);
    expect(result.platformFeeY).toBe(200);
    expect(result.operatorFeeX).toBe(100);
    expect(result.operatorFeeY).toBe(200);
    expect(result.netFeeX).toBe(900);
    expect(result.netFeeY).toBe(1800);
    expect(result.amountToTransferX).toBe(0);
    expect(result.amountToTransferY).toBe(0);
  });

  it("calculates revenue share at 0% operator split", () => {
    const result = calculateRevenueShare(1000, 2000, 0.1, true, 0, FEE_WALLET, OPERATOR_WALLET);
    expect(result.platformFeeX).toBe(100);
    expect(result.platformFeeY).toBe(200);
    expect(result.operatorFeeX).toBe(0);
    expect(result.operatorFeeY).toBe(0);
    expect(result.amountToTransferX).toBe(100);
    expect(result.amountToTransferY).toBe(200);
  });

  it("handles circular wallet (operator === fee wallet)", () => {
    const result = calculateRevenueShare(1000, 2000, 0.1, true, 50, OPERATOR_WALLET, OPERATOR_WALLET);
    expect(result.isCircular).toBe(true);
    expect(result.amountToTransferX).toBe(0);
    expect(result.amountToTransferY).toBe(0);
    expect(result.platformFeeX).toBe(100);
    expect(result.platformFeeY).toBe(200);
  });

  it("handles null fee wallet", () => {
    const result = calculateRevenueShare(1000, 2000, 0.1, true, 50, null, OPERATOR_WALLET);
    expect(result.isCircular).toBe(false);
    expect(result.amountToTransferX).toBe(0);
    expect(result.amountToTransferY).toBe(0);
  });

  it("handles only X token fees", () => {
    const result = calculateRevenueShare(500, 0, 0.2, true, 25, FEE_WALLET, OPERATOR_WALLET);
    expect(result.platformFeeX).toBe(100);
    expect(result.platformFeeY).toBe(0);
    expect(result.operatorFeeX).toBe(25);
    expect(result.operatorFeeY).toBe(0);
    expect(result.netFeeX).toBe(400);
    expect(result.netFeeY).toBe(0);
    expect(result.amountToTransferX).toBe(75);
    expect(result.amountToTransferY).toBe(0);
  });

  it("handles only Y token fees", () => {
    const result = calculateRevenueShare(0, 800, 0.15, true, 33, FEE_WALLET, OPERATOR_WALLET);
    expect(result.platformFeeX).toBe(0);
    expect(result.platformFeeY).toBe(120); // floor(800 * 0.15)
    expect(result.operatorFeeX).toBe(0);
    expect(result.operatorFeeY).toBe(39); // floor(120 * 0.33)
    expect(result.netFeeX).toBe(0);
    expect(result.netFeeY).toBe(680); // 800 - 120
    expect(result.amountToTransferX).toBe(0);
    expect(result.amountToTransferY).toBe(81); // 120 - 39
  });

  it("handles fractional fees correctly", () => {
    const result = calculateRevenueShare(123.45, 678.9, 0.075, true, 33, FEE_WALLET, OPERATOR_WALLET);
    expect(result.platformFeeX).toBe(9); // floor(123.45 * 0.075)
    expect(result.platformFeeY).toBe(50); // floor(678.9 * 0.075)
    expect(result.operatorFeeX).toBe(2); // floor(9 * 0.33)
    expect(result.operatorFeeY).toBe(16); // floor(50 * 0.33)
  });

  it("handles disabled revenue share with fee wallet", () => {
    const result = calculateRevenueShare(1000, 2000, 0.1, false, 50, FEE_WALLET, OPERATOR_WALLET);
    expect(result.operatorFeeX).toBe(0);
    expect(result.operatorFeeY).toBe(0);
    expect(result.amountToTransferX).toBe(100);
    expect(result.amountToTransferY).toBe(200);
  });

  it("handles zero fees", () => {
    const result = calculateRevenueShare(0, 0, 0.1, true, 50, FEE_WALLET, OPERATOR_WALLET);
    expect(result.platformFeeX).toBe(0);
    expect(result.platformFeeY).toBe(0);
    expect(result.netFeeX).toBe(0);
    expect(result.netFeeY).toBe(0);
    expect(result.amountToTransferX).toBe(0);
    expect(result.amountToTransferY).toBe(0);
  });
});
