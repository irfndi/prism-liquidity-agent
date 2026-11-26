/**
 * TA-exhaustion EXIT policy (#237): the confluence is price-only, so the
 * reasoning must not claim a profit the position did not make, and the
 * behavior-changing gates (hold floor, P&L requirement, RSI threshold) are
 * config-driven with behavior-preserving defaults.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  computeBollingerPercentB,
  computeBollingerUpper,
  computeMacdHistogram,
  computeRsi2,
  isTaExhausted,
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
    expect(reasoning).toContain("projected +$2.95");
    expect(reasoning).toContain("net of modeled close costs");
  });

  it("never labels a losing exit as profit-exhaustion", () => {
    const reasoning = taExhaustionReasoning(signals, -0.36);
    expect(reasoning).not.toContain("profit-exhaustion");
    expect(reasoning).toContain("losing position");
    expect(reasoning).toContain("projected -$0.36");
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

  it("adds pending live fees and rewards the close sweeps (unreadable → unknown)", () => {
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
    // Pending LM rewards are income exactly like pending swap fees.
    expect(taExhaustionNetPnlUsd({ ...base, pendingRewardsUsd: 30 })).toBeCloseTo(4.99, 6);
    expect(Number.isNaN(taExhaustionNetPnlUsd({ ...base, pendingRewardsUsd: Number.NaN }))).toBe(
      true,
    );
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

  it("a live row without measured entry overhead is UNKNOWN (the ledger books NULL)", () => {
    const net = taExhaustionNetPnlUsd({
      depositedUsd: 1_000,
      currentValueUsd: 1_050,
      cumulativeFeesClaimedUsd: 1,
      cumulativeRewardsClaimedUsd: 0,
      ageMs: 0,
      paperTrading: false,
      entryOverheadKnown: false,
    });
    expect(Number.isNaN(net)).toBe(true);
  });

  it("treats a non-finite age as zero days instead of poisoning the projection", () => {
    const net = taExhaustionNetPnlUsd({
      depositedUsd: 1_000,
      currentValueUsd: 1_000,
      cumulativeFeesClaimedUsd: 0,
      cumulativeRewardsClaimedUsd: 0,
      ageMs: Number.NaN,
      paperTrading: true,
    });
    expect(Number.isFinite(net)).toBe(true);
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

describe("TA indicator primitives", () => {
  it("RSI(2): flat 50, all-up 100, all-down 0, mixed uses the formula, cold/junk null", () => {
    expect(computeRsi2([100, 100, 100])).toBe(50);
    expect(computeRsi2([100, 101, 102])).toBe(100);
    expect(computeRsi2([100, 99, 98])).toBe(0);
    // +4 then −1 → avgGain 2, avgLoss 0.5 → 100 − 100/(1+4) = 80.
    expect(computeRsi2([100, 104, 103])).toBeCloseTo(80, 10);
    // Longer mixed series exercises Wilder smoothing (gain and loss legs).
    expect(computeRsi2([100, 101, 100, 102, 99])).toBeCloseTo(27.7778, 4);
    expect(computeRsi2([100, 101])).toBeNull();
    expect(computeRsi2([100, 101, Number.NaN])).toBeNull();
  });

  it("Bollinger: cold history null, flat band %B 0.5", () => {
    expect(computeBollingerUpper([...Array<number>(19).fill(100)])).toBeNull();
    expect(computeBollingerPercentB([...Array<number>(19).fill(100)])).toBeNull();
    expect(computeBollingerPercentB([...Array<number>(19).fill(100), Number.NaN])).toBeNull();
    const flat = [...Array<number>(20).fill(100)];
    expect(computeBollingerUpper(flat)).toBe(100);
    expect(computeBollingerPercentB(flat)).toBe(0.5);
  });

  it("MACD: cold history null; the trigger has a first-green histogram", () => {
    expect(computeMacdHistogram([...Array<number>(34).fill(90)])).toBeNull();
    const macd = computeMacdHistogram(TRIGGER_CLOSES);
    expect(macd).not.toBeNull();
    expect(macd!.current).toBeGreaterThan(0);
    expect(macd!.previous).toBeLessThanOrEqual(0);
  });

  it("signals fail open on short history or junk", () => {
    expect(taExhaustionSignals([...Array<number>(34).fill(90)])).toBeNull();
    expect(
      taExhaustionSignals([...Array<number>(39).fill(90), Number.POSITIVE_INFINITY]),
    ).toBeNull();
    // A non-finite threshold falls back to the textbook 90.
    expect(taExhaustionSignals(TRIGGER_CLOSES, Number.NaN)?.rsiThreshold).toBe(90);
  });

  it("reasoning names the MACD leg when BB-upper is not the trigger", () => {
    const signals = taExhaustionSignals(TRIGGER_CLOSES);
    if (signals === null) throw new Error("trigger fixture must produce signals");
    const reasoning = taExhaustionReasoning({ ...signals, aboveBbUpper: false }, 1);
    expect(reasoning).toContain("first-green MACD histogram");
    expect(reasoning).not.toContain("close above BB-upper");
  });

  it("the confluence truth table is RSI AND (BB OR MACD)", () => {
    expect(isTaExhausted(true, true, false)).toBe(true);
    expect(isTaExhausted(true, false, true)).toBe(true);
    expect(isTaExhausted(false, true, true)).toBe(false);
    expect(isTaExhausted(true, false, false)).toBe(false);
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

describe("property: TA-exhaustion projected P&L and gates (#237)", () => {
  const usd = (max = 1e6) => fc.double({ min: 0, max, noNaN: true });

  it("projection is income minus outgo under the zero-cost model", () => {
    fc.assert(
      fc.property(
        usd(),
        usd(),
        usd(),
        usd(),
        usd(),
        usd(),
        usd(),
        (mark, fees, rewards, pendingFees, pendingRewards, deposit, rebalance) => {
          const net = taExhaustionNetPnlUsd({
            depositedUsd: deposit,
            currentValueUsd: mark,
            cumulativeFeesClaimedUsd: fees,
            cumulativeRewardsClaimedUsd: rewards,
            pendingFeesUsd: pendingFees,
            pendingRewardsUsd: pendingRewards,
            rebalanceCostsUsd: rebalance,
            ageMs: 0,
            paperTrading: true,
            swapCostPct: 0,
            harvestCostUsd: 0,
            conversionCostPct: 0,
            txCostUsd: 0,
          });
          expect(net).toBeCloseTo(
            mark + fees + rewards + pendingFees + pendingRewards - deposit - rebalance,
            6,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it("a loss is never labeled profit; a gain always is (gate off)", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.01, max: 1e6, noNaN: true }), (magnitude) => {
        const loss = maybeTaExhaustionExit(exitInput({ netPnlUsd: -magnitude }));
        expect(loss?.reasoning).not.toContain("profit-exhaustion");
        expect(loss?.reasoning).toContain("losing position");
        const gain = maybeTaExhaustionExit(exitInput({ netPnlUsd: magnitude }));
        expect(gain?.reasoning).toContain("profit-exhaustion");
      }),
      { numRuns: 100 },
    );
  });

  it("the P&L gate with no measured ratio passes exactly when net >= 0", () => {
    const policy = { ...TA_EXHAUSTION_DEFAULT_POLICY, requireNonnegativePnl: true };
    fc.assert(
      fc.property(fc.double({ min: -1e6, max: 1e6, noNaN: true }), (net) => {
        const decision = maybeTaExhaustionExit(
          exitInput({ netPnlUsd: net, feeIlRatio: null, policy }),
        );
        expect(decision !== null).toBe(net >= 0);
      }),
      { numRuns: 100 },
    );
  });

  it("the hold floor passes exactly when age >= minHoldMs", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        (age, floor) => {
          const policy = { ...TA_EXHAUSTION_DEFAULT_POLICY, minHoldMs: floor };
          const decision = maybeTaExhaustionExit(exitInput({ ageMs: age, policy }));
          expect(decision !== null).toBe(age >= floor);
        },
      ),
      { numRuns: 100 },
    );
  });
});
