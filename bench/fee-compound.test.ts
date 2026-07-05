import { describe, it, expect } from "vitest";
import { evaluateCompoundGate } from "../engine/risk-service.js";

describe("evaluateCompoundGate (F3 fee compounding)", () => {
  it("approves when net fees exceed minimum + gas buffer + rebalance gas", () => {
    // net=$5, min=$0.5, gas_buffer=$0.05, rebalance_gas=$1.50 → total=$2.05 → approve
    const result = evaluateCompoundGate({
      netFeesUsd: 5,
      minCompoundFeesUsd: 0.5,
      compoundGasBufferUsd: 0.05,
      rebalanceGasCostUsd: 1.5,
    });
    expect(result.approved).toBe(true);
    expect(result.thresholdUsd).toBeCloseTo(2.05);
  });

  it("rejects when net fees just barely cover the cost", () => {
    // net=$2, threshold=$2.05 → reject
    const result = evaluateCompoundGate({
      netFeesUsd: 2,
      minCompoundFeesUsd: 0.5,
      compoundGasBufferUsd: 0.05,
      rebalanceGasCostUsd: 1.5,
    });
    expect(result.approved).toBe(false);
    expect(result.reason.toLowerCase()).toContain("net");
  });

  it("respects a larger minimum threshold", () => {
    // net=$3, threshold=$0.5+$0.05+$10=$10.55 → reject
    const result = evaluateCompoundGate({
      netFeesUsd: 3,
      minCompoundFeesUsd: 0.5,
      compoundGasBufferUsd: 0.05,
      rebalanceGasCostUsd: 10,
    });
    expect(result.approved).toBe(false);
  });

  it("rejects zero-fee positions (no compound work to do)", () => {
    const result = evaluateCompoundGate({
      netFeesUsd: 0,
      minCompoundFeesUsd: 0.5,
      compoundGasBufferUsd: 0.05,
      rebalanceGasCostUsd: 1.5,
    });
    expect(result.approved).toBe(false);
  });

  it("approves large fees generously exceeding all costs", () => {
    const result = evaluateCompoundGate({
      netFeesUsd: 100,
      minCompoundFeesUsd: 0.5,
      compoundGasBufferUsd: 0.05,
      rebalanceGasCostUsd: 1.5,
    });
    expect(result.approved).toBe(true);
    expect(result.savingsUsd).toBeCloseTo(100 - 2.05);
  });
});
