/** Left-tail hard stop: age-free EXIT when mark PnL ≤ -(deposited × pct). */
import { describe, expect, it } from "vitest";
import {
  isPositionLossCapBreached,
  positionLossCapReasoning,
} from "../engine/position-loss-cap.js";

describe("position loss cap", () => {
  it("does not fire when disabled (pct <= 0) or inputs invalid", () => {
    expect(
      isPositionLossCapBreached({
        depositedUsd: 20,
        currentValueUsd: 5,
        cumulativeFeesClaimedUsd: 0,
        cumulativeRewardsClaimedUsd: 0,
        maxLossPct: 0,
      }),
    ).toBe(false);
    expect(
      isPositionLossCapBreached({
        depositedUsd: 0,
        currentValueUsd: 0,
        cumulativeFeesClaimedUsd: 0,
        cumulativeRewardsClaimedUsd: 0,
        maxLossPct: 0.35,
      }),
    ).toBe(false);
  });

  it("fires when unrealized PnL (incl fees/rewards) breaches the floor", () => {
    // $20 deposit, $10 mark, $0 fees → −50% ≤ −35%
    expect(
      isPositionLossCapBreached({
        depositedUsd: 20,
        currentValueUsd: 10,
        cumulativeFeesClaimedUsd: 0,
        cumulativeRewardsClaimedUsd: 0,
        maxLossPct: 0.35,
      }),
    ).toBe(true);
  });

  it("does not fire when fees offset the mark drawdown above the floor", () => {
    // $20 deposit, $12 mark, $2 fees → −$6 / $20 = −30% > −35%
    expect(
      isPositionLossCapBreached({
        depositedUsd: 20,
        currentValueUsd: 12,
        cumulativeFeesClaimedUsd: 2,
        cumulativeRewardsClaimedUsd: 0,
        maxLossPct: 0.35,
      }),
    ).toBe(false);
  });

  it("tags reasoning with [position-loss-cap]", () => {
    const reason = positionLossCapReasoning({
      depositedUsd: 20,
      currentValueUsd: 5,
      cumulativeFeesClaimedUsd: 0.1,
      cumulativeRewardsClaimedUsd: 0,
      maxLossPct: 0.35,
    });
    expect(reason.startsWith("[position-loss-cap]")).toBe(true);
    expect(reason).toContain("35%");
  });
});
