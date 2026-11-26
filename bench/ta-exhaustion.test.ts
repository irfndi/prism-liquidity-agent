/**
 * TA-exhaustion EXIT policy (#237): the confluence is price-only, so the
 * reasoning must not claim a profit the position did not make, and the
 * behavior-changing gates (hold floor, P&L requirement, RSI threshold) are
 * config-driven with behavior-preserving defaults.
 */
import { describe, expect, it } from "vitest";
import {
  maybeTaExhaustionExit,
  resolveTaExhaustionPolicy,
  taExhaustionNetPnlUsd,
  taExhaustionReasoning,
  taExhaustionSignals,
  taExhaustionVote,
  TA_EXHAUSTION_DEFAULT_POLICY,
  type TaExhaustionExitInput,
} from "../engine/ta-exhaustion.js";

// 39 flat closes + one uptick: RSI(2) = 100, %B = 1.59 (the exact paper shape
// from the issue: (sqrt(19) + 2) / 4), above BB-upper and first MACD green.
const TRIGGER_CLOSES: readonly number[] = [...Array<number>(39).fill(90), 90.9];

function exitInput(overrides: Partial<TaExhaustionExitInput> = {}): TaExhaustionExitInput {
  return {
    poolAddress: "TaPool111111111111111111111111111111111111",
    positionId: "paper-ta-pos",
    closes: TRIGGER_CLOSES,
    ageMs: 3_600_000,
    netPnlUsd: 5,
    feeIlRatio: null,
    ...overrides,
  };
}

describe("TA-exhaustion reasoning is P&L-honest (#237)", () => {
  const signals = taExhaustionSignals(TRIGGER_CLOSES);
  if (signals === null) throw new Error("trigger fixture must produce signals");

  it("labels a non-negative projected P&L as profit-exhaustion with the net figure", () => {
    const reasoning = taExhaustionReasoning(signals, 2.95);
    expect(reasoning).toContain("profit-exhaustion");
    expect(reasoning).toContain("+$2.95");
    expect(reasoning).toContain("net of modeled close costs");
  });

  it("never labels a losing exit as profit-exhaustion", () => {
    const reasoning = taExhaustionReasoning(signals, -0.36);
    expect(reasoning).not.toContain("profit-exhaustion");
    expect(reasoning).toContain("losing position");
    expect(reasoning).toContain("-$0.36");
  });

  it("reports unknown P&L as unknown instead of claiming either sign", () => {
    const reasoning = taExhaustionReasoning(signals, Number.NaN);
    expect(reasoning).not.toContain("profit-exhaustion");
    expect(reasoning).toContain("P&L unknown");
  });

  it("carries the configured RSI threshold into the reasoning", () => {
    const custom = taExhaustionSignals(TRIGGER_CLOSES, 95);
    if (custom === null) throw new Error("trigger fixture must produce signals");
    expect(custom.rsiOverbought).toBe(true);
    expect(taExhaustionReasoning(custom, 1)).toContain("> 95");
  });
});

describe("TA-exhaustion projected P&L (net of modeled close costs)", () => {
  it("a flat paper round trip prices negative by exactly the close cost", () => {
    // The issue's evidence: 10-42 minute holds closed by ta-exhaustion were
    // within ±$0.13 of the deposit; the loss was the round-trip cost.
    const net = taExhaustionNetPnlUsd({
      depositedUsd: 48.07,
      currentValueUsd: 48.07,
      cumulativeFeesClaimedUsd: 0,
      cumulativeRewardsClaimedUsd: 0,
      ageMs: 0,
      paperTrading: true,
    });
    // 2 × 0.5% swaps + 2 × $0.005 txs, no harvest/conversion at age 0.
    expect(net).toBeCloseTo(-(2 * 0.005 * 48.07 + 2 * 0.005), 6);
    expect(net).toBeLessThan(0);
  });

  it("adds claimed fees and rewards before debiting close costs", () => {
    const net = taExhaustionNetPnlUsd({
      depositedUsd: 1_000,
      currentValueUsd: 1_000,
      cumulativeFeesClaimedUsd: 10,
      cumulativeRewardsClaimedUsd: 2,
      ageMs: 0,
      paperTrading: true,
    });
    // gross 12 − (2 × 0.5% swaps + 2 × $0.005 txs + 5% conversion on $10 fees)
    expect(net).toBeCloseTo(12 - (2 * 0.005 * 1_000 + 2 * 0.005 + 0.05 * 10), 6);
  });

  it("adds pending live fees the close withdrawal sweeps (unreadable → unknown)", () => {
    const base = {
      depositedUsd: 1_000,
      currentValueUsd: 980,
      cumulativeFeesClaimedUsd: 0,
      cumulativeRewardsClaimedUsd: 0,
      ageMs: 0,
      paperTrading: false,
      swapCostPct: 0.005,
      harvestCostUsd: 0.01,
      txCostUsd: 0.005,
    };
    // mark loss 20 + pending 30 − close costs (5 + 2 × 0.005) → +4.99
    expect(taExhaustionNetPnlUsd({ ...base, pendingFeesUsd: 30 })).toBeCloseTo(4.99, 6);
    expect(taExhaustionNetPnlUsd({ ...base, pendingFeesUsd: 0 })).toBeCloseTo(-25.01, 6);
    expect(Number.isNaN(taExhaustionNetPnlUsd({ ...base, pendingFeesUsd: Number.NaN }))).toBe(true);
  });

  it("debits prior paper rebalance costs the settlement charges", () => {
    const net = taExhaustionNetPnlUsd({
      depositedUsd: 1_000,
      currentValueUsd: 1_011,
      cumulativeFeesClaimedUsd: 0,
      cumulativeRewardsClaimedUsd: 0,
      ageMs: 0,
      paperTrading: true,
      rebalanceCostsUsd: 1.5,
    });
    // 11 − 10.01 close costs − 1.50 rebalance = −0.51 (settlement-identical sign)
    expect(net).toBeCloseTo(-0.51, 6);
  });

  it("a fallback mark (live HODL/deposit) is UNKNOWN, never a profit", () => {
    const net = taExhaustionNetPnlUsd({
      depositedUsd: 1_000,
      currentValueUsd: 1_050,
      cumulativeFeesClaimedUsd: 1,
      cumulativeRewardsClaimedUsd: 0,
      ageMs: 0,
      paperTrading: false,
      markKnown: false,
    });
    expect(Number.isNaN(net)).toBe(true);
  });

  it("the live model debits one exit swap leg plus gas (no conversion)", () => {
    const net = taExhaustionNetPnlUsd({
      depositedUsd: 1_000,
      currentValueUsd: 1_000,
      cumulativeFeesClaimedUsd: 5,
      cumulativeRewardsClaimedUsd: 0,
      ageMs: 86_400_000,
      paperTrading: false,
      swapCostPct: 0.005,
      harvestCostUsd: 0.01,
      txCostUsd: 0.005,
    });
    // 5 − (0.005 × 1000 + 2 × 0.005 + 0.01 × 1 day) = −0.02
    expect(net).toBeCloseTo(-0.02, 6);
  });

  it("returns unknown (NaN) when the mark is unpriceable", () => {
    const net = taExhaustionNetPnlUsd({
      depositedUsd: 1_000,
      currentValueUsd: Number.NaN,
      cumulativeFeesClaimedUsd: 0,
      cumulativeRewardsClaimedUsd: 0,
      ageMs: 0,
      paperTrading: true,
    });
    expect(Number.isNaN(net)).toBe(true);
  });
});

describe("TA-exhaustion policy gates", () => {
  it("the pure vote preflight fires only when enabled, mature and confluent", () => {
    expect(taExhaustionVote({ closes: TRIGGER_CLOSES, ageMs: 0 })).not.toBeNull();
    expect(
      taExhaustionVote({
        closes: TRIGGER_CLOSES,
        ageMs: 0,
        policy: { ...TA_EXHAUSTION_DEFAULT_POLICY, enabled: false },
      }),
    ).toBeNull();
    expect(
      taExhaustionVote({
        closes: TRIGGER_CLOSES,
        ageMs: 0,
        policy: { ...TA_EXHAUSTION_DEFAULT_POLICY, minHoldMs: 1 },
      }),
    ).toBeNull();
    expect(taExhaustionVote({ closes: [90, 90.9], ageMs: 0 })).toBeNull();
  });

  it("fires on the confluence with behavior-preserving defaults", () => {
    const decision = maybeTaExhaustionExit(exitInput({ netPnlUsd: -1 }));
    expect(decision).not.toBeNull();
    expect(decision?.action).toBe("EXIT");
    expect(decision?.confidence).toBe(1);
    expect(decision?.reasoning.startsWith("[ta-exhaustion]")).toBe(true);
    expect(decision?.reasoning).toContain("losing position");
  });

  it("TA_EXHAUSTION_ENABLED=false disables the gate", () => {
    const decision = maybeTaExhaustionExit(
      exitInput({ policy: { ...TA_EXHAUSTION_DEFAULT_POLICY, enabled: false } }),
    );
    expect(decision).toBeNull();
  });

  it("TA_EXHAUSTION_MIN_HOLD_MS suppresses an immature position and admits it at the floor", () => {
    const policy = { ...TA_EXHAUSTION_DEFAULT_POLICY, minHoldMs: 3_600_000 };
    expect(maybeTaExhaustionExit(exitInput({ ageMs: 59_999, policy }))).toBeNull();
    expect(maybeTaExhaustionExit(exitInput({ ageMs: 3_600_000, policy }))).not.toBeNull();
  });

  it("TA_EXHAUSTION_RSI_THRESHOLD moves the trip line (100 never trips)", () => {
    const at90 = maybeTaExhaustionExit(
      exitInput({ policy: { ...TA_EXHAUSTION_DEFAULT_POLICY, rsiThreshold: 90 } }),
    );
    const at100 = maybeTaExhaustionExit(
      exitInput({ policy: { ...TA_EXHAUSTION_DEFAULT_POLICY, rsiThreshold: 100 } }),
    );
    expect(at90).not.toBeNull();
    expect(at100).toBeNull();
  });

  it("TA_EXHAUSTION_REQUIRE_NONNEGATIVE_PNL suppresses a losing exit when the ratio is unknown", () => {
    const policy = { ...TA_EXHAUSTION_DEFAULT_POLICY, requireNonnegativePnl: true };
    expect(
      maybeTaExhaustionExit(exitInput({ netPnlUsd: -0.36, feeIlRatio: null, policy })),
    ).toBeNull();
  });

  it("...admits a losing exit when the MEASURED fee/IL clears the floor", () => {
    const policy = { ...TA_EXHAUSTION_DEFAULT_POLICY, requireNonnegativePnl: true };
    expect(
      maybeTaExhaustionExit(exitInput({ netPnlUsd: -0.36, feeIlRatio: 1.2, policy })),
    ).not.toBeNull();
    expect(
      maybeTaExhaustionExit(exitInput({ netPnlUsd: -0.36, feeIlRatio: 1.19, policy })),
    ).toBeNull();
  });

  it("...always admits a non-negative P&L regardless of fee/IL", () => {
    const policy = { ...TA_EXHAUSTION_DEFAULT_POLICY, requireNonnegativePnl: true };
    expect(
      maybeTaExhaustionExit(exitInput({ netPnlUsd: 0, feeIlRatio: null, policy })),
    ).not.toBeNull();
  });

  it("...fails closed on an unknown projected P&L", () => {
    const policy = { ...TA_EXHAUSTION_DEFAULT_POLICY, requireNonnegativePnl: true };
    expect(
      maybeTaExhaustionExit(exitInput({ netPnlUsd: Number.NaN, feeIlRatio: 20, policy })),
    ).not.toBeNull(); // the ratio alternative still applies
    expect(
      maybeTaExhaustionExit(exitInput({ netPnlUsd: Number.NaN, feeIlRatio: null, policy })),
    ).toBeNull();
  });

  it("still fails open (no vote) when the price history is cold", () => {
    expect(maybeTaExhaustionExit(exitInput({ closes: [90, 90.9] }))).toBeNull();
  });
});

describe("resolveTaExhaustionPolicy", () => {
  it("returns the documented defaults for absent/non-finite overrides", () => {
    const policy = resolveTaExhaustionPolicy({
      enabled: undefined,
      rsiThreshold: Number.NaN,
      minHoldMs: Number.NaN,
      requireNonnegativePnl: undefined,
      minFeeIlRatio: Number.NaN,
    });
    expect(policy).toEqual(TA_EXHAUSTION_DEFAULT_POLICY);
  });

  it("keeps an explicit disable and a negative hold floor clamps to 0", () => {
    const policy = resolveTaExhaustionPolicy({
      enabled: false,
      rsiThreshold: 95,
      minHoldMs: -1,
      requireNonnegativePnl: true,
      minFeeIlRatio: 2,
    });
    expect(policy).toEqual({
      enabled: false,
      rsiThreshold: 95,
      minHoldMs: 0,
      requireNonnegativePnl: true,
      minFeeIlRatio: 2,
    });
  });
});
