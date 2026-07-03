import { describe, it, expect } from "vitest";
import { evaluatePerPoolAllocation } from "../engine/risk-service.js";
import type { Position } from "../engine/types.js";

function makePos(poolAddress: string, depositedUsd: number): Position {
  return {
    id: poolAddress,
    poolAddress,
    poolName: `Pool/${poolAddress.slice(-4)}`,
    lowerBinId: 4990,
    upperBinId: 5010,
    liquidityShares: 0n,
    depositedUsd,
    currentValueUsd: depositedUsd,
    unrealizedPnlUsd: 0,
    feesEarnedUsd: 0,
    openedAt: Date.now(),
  };
}

describe("evaluatePerPoolAllocation (F5 multi-pool allocation)", () => {
  it("approves an ENTER that stays under the per-pool cap", () => {
    // portfolio=$10k, requested=$1000 (10%), cap=40% → approve
    const result = evaluatePerPoolAllocation({
      proposedDepositUsd: 1000,
      portfolioValueUsd: 10_000,
      openPositions: [],
      maxPerPoolAllocationPct: 0.4,
      maxOpenPositions: 3,
    });
    expect(result.approved).toBe(true);
    expect(result.adjustedDepositUsd).toBe(1000);
  });

  it("caps the deposit to per-pool max when oversized", () => {
    // portfolio=$10k, requested=$6000 (60%), cap=40% → cap to $4000
    const result = evaluatePerPoolAllocation({
      proposedDepositUsd: 6000,
      portfolioValueUsd: 10_000,
      openPositions: [],
      maxPerPoolAllocationPct: 0.4,
      maxOpenPositions: 3,
    });
    expect(result.approved).toBe(true);
    expect(result.adjustedDepositUsd).toBe(4000);
  });

  it("rejects when already at maxOpenPositions", () => {
    const positions = [
      makePos("Pool1", 1000),
      makePos("Pool2", 1000),
      makePos("Pool3", 1000),
    ];
    const result = evaluatePerPoolAllocation({
      proposedDepositUsd: 500,
      portfolioValueUsd: 10_000,
      openPositions: positions,
      maxPerPoolAllocationPct: 0.4,
      maxOpenPositions: 3,
    });
    expect(result.approved).toBe(false);
    expect(result.reason.toLowerCase()).toContain("max");
  });

  it("rejects when per-pool cap rounds deposit to zero (zero-portfolio edge case)", () => {
    // portfolio=$0, cap = 0 × 0.4 = 0 → any non-zero deposit rounds to 0
    const result = evaluatePerPoolAllocation({
      proposedDepositUsd: 50,
      portfolioValueUsd: 0,
      openPositions: [],
      maxPerPoolAllocationPct: 0.4,
      maxOpenPositions: 3,
    });
    expect(result.approved).toBe(false);
    expect(result.adjustedDepositUsd).toBe(0);
    expect(result.reason.toLowerCase()).toContain("cap");
  });

  it("approves when ENTER keeps portfolio under open-position cap", () => {
    const positions = [makePos("Pool1", 1000), makePos("Pool2", 1000)];
    const result = evaluatePerPoolAllocation({
      proposedDepositUsd: 500,
      portfolioValueUsd: 10_000,
      openPositions: positions,
      maxPerPoolAllocationPct: 0.4,
      maxOpenPositions: 3,
    });
    expect(result.approved).toBe(true);
    expect(result.adjustedDepositUsd).toBe(500);
  });
});