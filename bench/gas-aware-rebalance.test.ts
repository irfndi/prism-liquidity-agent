import { describe, it, expect } from "vitest";
import { evaluateGasGate } from "../engine/risk-service.js";

describe("evaluateGasGate (F1 gas-aware rebalancing)", () => {
  it("approves rebalance when gas cost is small vs 3 days of fees", () => {
    // gas=$1.50, daily fees=$2 → gas < 3 * 2 = $6 → approve
    const result = evaluateGasGate({
      rebalanceGasCostSol: 0.01,
      solPriceUsd: 150,
      positionDailyFeesUsd: 2,
      minDaysOfFeesPaidAhead: 3,
    });
    expect(result.approved).toBe(true);
    expect(result.gasCostUsd).toBeCloseTo(1.5);
  });

  it("rejects rebalance when gas cost exceeds 3 days of fees", () => {
    // gas=$1.50, daily fees=$0.40 → 3*0.40 = $1.20 < $1.50 → reject
    const result = evaluateGasGate({
      rebalanceGasCostSol: 0.01,
      solPriceUsd: 150,
      positionDailyFeesUsd: 0.4,
      minDaysOfFeesPaidAhead: 3,
    });
    expect(result.approved).toBe(false);
    expect(result.reason.toLowerCase()).toContain("gas");
    expect(result.gasCostUsd).toBeCloseTo(1.5);
    expect(result.feesThresholdUsd).toBeCloseTo(1.2);
  });

  it("rejects when daily fees are zero (fail-closed for zero-fee pools)", () => {
    // 3 * 0 = 0, gas = $1.50 → reject (don't rebalance for zero-fee pool)
    const result = evaluateGasGate({
      rebalanceGasCostSol: 0.01,
      solPriceUsd: 150,
      positionDailyFeesUsd: 0,
      minDaysOfFeesPaidAhead: 3,
    });
    expect(result.approved).toBe(false);
  });

  it("respects custom minDaysOfFeesPaidAhead", () => {
    // gas=$1.50, daily fees=$1, min=2 → 2*1 = $2 > $1.50 → approve
    const result = evaluateGasGate({
      rebalanceGasCostSol: 0.01,
      solPriceUsd: 150,
      positionDailyFeesUsd: 1,
      minDaysOfFeesPaidAhead: 2,
    });
    expect(result.approved).toBe(true);
  });

  it("computes gas cost from SOL price correctly", () => {
    const result = evaluateGasGate({
      rebalanceGasCostSol: 0.05,
      solPriceUsd: 200,
      positionDailyFeesUsd: 100,
      minDaysOfFeesPaidAhead: 3,
    });
    // gas = 0.05 * 200 = $10, fees threshold = 3 * 100 = $300 → approve
    expect(result.gasCostUsd).toBeCloseTo(10);
    expect(result.feesThresholdUsd).toBeCloseTo(300);
    expect(result.approved).toBe(true);
  });
});
