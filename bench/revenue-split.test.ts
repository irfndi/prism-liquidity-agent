import { describe, it, expect } from "vitest";
import { calculateRevenueShare } from "../engine/adapter-service.js";

describe("revenue share fee calculation", () => {
  const FEE_WALLET = "FeeWallet1111111111111111111111111111111111";
  const OPERATOR_WALLET = "OperatorWallet111111111111111111111111111111";

  it("when disabled, operator gets 0%", () => {
    const result = calculateRevenueShare(100, 200, 0.1, false, 50, FEE_WALLET, OPERATOR_WALLET);
    expect(result.operatorFeeX).toBe(0);
    expect(result.operatorFeeY).toBe(0);
    expect(result.amountToTransferX).toBe(10); // full platform fee transferred
  });

  it("when enabled 50%, operator gets half", () => {
    const result = calculateRevenueShare(100, 200, 0.1, true, 50, FEE_WALLET, OPERATOR_WALLET);
    expect(result.operatorFeeX).toBe(5); // floor(10 * 0.5)
    expect(result.operatorFeeY).toBe(10); // floor(20 * 0.5)
    expect(result.amountToTransferX).toBe(5); // 10 - 5
    expect(result.amountToTransferY).toBe(10); // 20 - 10
  });

  it("when enabled 100%, operator gets all", () => {
    const result = calculateRevenueShare(100, 200, 0.1, true, 100, FEE_WALLET, OPERATOR_WALLET);
    expect(result.operatorFeeX).toBe(10); // floor(10 * 1.0)
    expect(result.operatorFeeY).toBe(20); // floor(20 * 1.0)
    expect(result.amountToTransferX).toBe(0); // 10 - 10
    expect(result.amountToTransferY).toBe(0); // 20 - 20
  });

  it("when enabled 0%, operator gets nothing", () => {
    const result = calculateRevenueShare(100, 200, 0.1, true, 0, FEE_WALLET, OPERATOR_WALLET);
    expect(result.operatorFeeX).toBe(0);
    expect(result.operatorFeeY).toBe(0);
    expect(result.amountToTransferX).toBe(10); // full platform fee transferred
  });

  it("circular wallet detection: operator wallet == fee wallet", () => {
    const result = calculateRevenueShare(100, 200, 0.1, true, 50, OPERATOR_WALLET, OPERATOR_WALLET);
    expect(result.isCircular).toBe(true);
    expect(result.amountToTransferX).toBe(0);
    expect(result.amountToTransferY).toBe(0);
  });
});
