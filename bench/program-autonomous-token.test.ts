import { describe, expect, it } from "vitest";
import {
  isActionAllowedDuringSafetyPause,
  nextSettlementRetryAt,
  shouldTriggerSafetyPause,
} from "../engine/autonomous-runtime.js";
import { computeNetRealizedPnlUsd } from "../engine/pnl.js";

describe("autonomous token runtime policy", () => {
  it("allows exits but blocks entry and rebalance during a persistent safety pause", () => {
    // Given / When / Then
    expect(isActionAllowedDuringSafetyPause("EXIT")).toBe(true);
    expect(isActionAllowedDuringSafetyPause("HOLD")).toBe(true);
    expect(isActionAllowedDuringSafetyPause("ENTER")).toBe(false);
    expect(isActionAllowedDuringSafetyPause("REBALANCE")).toBe(false);
  });

  it("triggers each wallet safety threshold at its configured boundary", () => {
    // Given / When / Then
    expect(
      shouldTriggerSafetyPause({
        dailyDrawdownPct: 5,
        maxDailyDrawdownPct: 5,
        consecutiveCoreDataFailures: 0,
        consecutiveExecutionFailures: 0,
        maxConsecutiveExecutionFailures: 3,
        oldestSettlementAgeMs: 0,
        settlementMaxPendingMs: 3_600_000,
      }),
    ).toBe("daily_drawdown");
    expect(
      shouldTriggerSafetyPause({
        dailyDrawdownPct: 0,
        maxDailyDrawdownPct: 5,
        consecutiveCoreDataFailures: 2,
        consecutiveExecutionFailures: 0,
        maxConsecutiveExecutionFailures: 3,
        oldestSettlementAgeMs: 0,
        settlementMaxPendingMs: 3_600_000,
      }),
    ).toBe("core_data_unavailable");
    expect(
      shouldTriggerSafetyPause({
        dailyDrawdownPct: 0,
        maxDailyDrawdownPct: 5,
        consecutiveCoreDataFailures: 0,
        consecutiveExecutionFailures: 3,
        maxConsecutiveExecutionFailures: 3,
        oldestSettlementAgeMs: 0,
        settlementMaxPendingMs: 3_600_000,
      }),
    ).toBe("execution_failures");
    expect(
      shouldTriggerSafetyPause({
        dailyDrawdownPct: 0,
        maxDailyDrawdownPct: 5,
        consecutiveCoreDataFailures: 0,
        consecutiveExecutionFailures: 0,
        maxConsecutiveExecutionFailures: 3,
        oldestSettlementAgeMs: 3_600_001,
        settlementMaxPendingMs: 3_600_000,
      }),
    ).toBe("settlement_overdue");
  });

  it("caps deterministic settlement retry backoff", () => {
    // Given / When / Then
    expect(nextSettlementRetryAt(1_000, 1)).toBe(2_000);
    expect(nextSettlementRetryAt(1_000, 20)).toBe(301_000);
  });

  it("subtracts settlement and execution costs from realized PnL", () => {
    // Given / When
    const pnl = computeNetRealizedPnlUsd({
      finalValueUsd: 1_100,
      cumulativeFeesClaimedUsd: 25,
      cumulativeRewardsClaimedUsd: 10,
      costBasisUsd: 1_000,
      settlementCostUsd: 7,
      executionCostUsd: 3,
    });

    // Then
    expect(pnl).toBe(125);
  });
});
