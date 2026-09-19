// Bend-vs-TS parity: each vector asserts the Bend kernel in
// native/bend/kernels.bend agrees with the TS source of truth.
// TS floats map x100 via Math.round (see bend-parity-harness.ts header);
// every vector here uses exact hundredths, so the mapping is exact.
// Skips (does not fail) when the `bend` binary is absent.
//
// Traceability: clamp/nudge/evolve vectors mirror
// bench/threshold-evolution.test.ts; constants come from
// engine/strategy-service.ts (MIN_*_EVOLVED_*, MAX_FEE_IL_RATIO=20,
// driftGateRejected strict <); gate predicates mirror the private TS
// functions in engine/program.ts cited per vector.

import { describe, it, expect } from "vitest";
import {
  clampThreshold,
  nudgeThreshold,
  driftGateRejected,
  MIN_FEE_IL_EVOLVED_MIN,
  MIN_FEE_IL_EVOLVED_MAX,
  MAX_FEE_IL_RATIO,
} from "../engine/strategy-service.js";
import { isTaExhausted } from "../engine/ta-exhaustion.js";
import { isBendAvailable, runBendNat, runBendBool, toNat } from "./bend-parity-harness.js";

const BEND = isBendAvailable();
const describeIf = BEND ? describe : describe.skip;

// TS mirror of private feeIlHardFloorReason (program.ts:4695): blocks iff
// protection on AND ratio known AND ratio < floor.
function tsEnterBlocked(ilOn: boolean, known: boolean, ratio: number, floor: number): boolean {
  return ilOn && known && ratio < floor;
}

// TS mirror of the fee/IL < 0.5 EXIT (program.ts:10792, 10416): fires iff
// ratio known AND position mature AND ratio < 0.5.
function tsFeeExitFires(known: boolean, mature: boolean, ratio: number): boolean {
  return known && mature && ratio < 0.5;
}

// TS mirror of the paper accrual guard (program.ts:10146-10187): paper mode
// AND no on-chain pubkey AND datapi source.
function tsAccrualAllowed(paper: boolean, onchain: boolean, datapi: boolean): boolean {
  return paper && !onchain && datapi;
}

// TS mirror of the confidence-free capital path (position-loss-cap.ts):
// fires on the danger signal alone at any confidence.
function tsCapitalExit(danger: boolean): boolean {
  return danger;
}

// TS mirror of the decidePositionExit chain shape (program.ts:10959-10970):
// TP-ladder hit wins over TA-exhaustion, which wins over any loss-side
// signal; none -> hold/scale-in (0n). Branch verdicts precomputed.
function tsExitOrder(tpHit: boolean, taHit: boolean, lossHit: boolean): number {
  if (tpHit) return 1;
  if (taHit) return 2;
  if (lossHit) return 3;
  return 0;
}

describeIf("bend parity", () => {
  it("clamp pins the 13.92 runaway to the 3.0 ceiling (threshold-evolution.test.ts:481)", () => {
    const ts = clampThreshold(13.92, MIN_FEE_IL_EVOLVED_MIN, MIN_FEE_IL_EVOLVED_MAX);
    expect(ts).toBe(MIN_FEE_IL_EVOLVED_MAX);
    expect(runBendNat(`K.clamp_thr(${toNat(13.92)}, 30n, 300n)`)).toBe(
      BigInt(Math.round(ts * 100)),
    );
  });

  it("clamp pins 0.01 to the 0.3 floor (threshold-evolution.test.ts:485)", () => {
    const ts = clampThreshold(0.01, MIN_FEE_IL_EVOLVED_MIN, MIN_FEE_IL_EVOLVED_MAX);
    expect(ts).toBe(MIN_FEE_IL_EVOLVED_MIN);
    expect(runBendNat(`K.clamp_thr(${toNat(0.01)}, 30n, 300n)`)).toBe(BigInt(Math.round(ts * 100)));
  });

  it("single nudge 120->144 at 20% (threshold-evolution.test.ts:14)", () => {
    const ts = nudgeThreshold(1.2, 1.5, 0.2);
    expect(ts).toBeCloseTo(1.44, 10);
    expect(runBendNat("K.nudge_thr(120n, 150n, 20n, 100n)")).toBe(BigInt(Math.round(ts * 100)));
  });

  it("nudge down-clamps at 20% and holds at target (threshold-evolution.test.ts:14)", () => {
    const down = nudgeThreshold(1.5, 1.0, 0.2);
    expect(down).toBeCloseTo(1.2, 10);
    expect(runBendNat("K.nudge_thr(150n, 100n, 20n, 100n)")).toBe(BigInt(Math.round(down * 100)));
    const hold = nudgeThreshold(1.2, 1.2, 0.2);
    expect(hold).toBeCloseTo(1.2, 10);
    expect(runBendNat("K.nudge_thr(120n, 120n, 20n, 100n)")).toBe(BigInt(Math.round(hold * 100)));
  });

  it("evolution pins at the ceiling under runaway lift (strategy-service.ts:637)", () => {
    const ts = clampThreshold(
      nudgeThreshold(3.0, 3.0 * 1.2, 0.2),
      MIN_FEE_IL_EVOLVED_MIN,
      MIN_FEE_IL_EVOLVED_MAX,
    );
    expect(ts).toBe(MIN_FEE_IL_EVOLVED_MAX);
    expect(runBendNat("K.evolve_thr(300n, True{}, 20n, 100n, 20n, 100n, 30n, 300n)")).toBe(
      BigInt(Math.round(ts * 100)),
    );
  });

  it("evolution pins at the floor under negative lift (strategy-service.ts:637)", () => {
    const ts = clampThreshold(
      nudgeThreshold(0.3, 0.3 * 0.8, 0.2),
      MIN_FEE_IL_EVOLVED_MIN,
      MIN_FEE_IL_EVOLVED_MAX,
    );
    expect(ts).toBe(MIN_FEE_IL_EVOLVED_MIN);
    expect(runBendNat("K.evolve_thr(30n, False{}, 20n, 100n, 20n, 100n, 30n, 300n)")).toBe(
      BigInt(Math.round(ts * 100)),
    );
  });

  it("feeRatio caps at MAX_FEE_IL_RATIO=20 (strategy-service.ts:191)", () => {
    const ts = Math.min(30 / 0.01, MAX_FEE_IL_RATIO);
    expect(ts).toBe(20);
    expect(runBendNat("K.fee_ratio(3000n, 1n)")).toBe(BigInt(Math.round(ts * 100)));
  });

  it("feeRatio is 0 when both fees and IL are 0 (strategy-service.ts:191)", () => {
    expect(runBendNat("K.fee_ratio(0n, 0n)")).toBe(0n);
  });

  it("ENTER blocked when known-below-floor, passes when unknown (program.ts:4695)", () => {
    expect(tsEnterBlocked(true, true, 0.2, 0.3)).toBe(true);
    expect(tsEnterBlocked(true, false, 0.2, 0.3)).toBe(false);
    expect(runBendBool("K.enter_blocked(True{}, True{}, 20n, 30n)")).toBe(true);
    expect(runBendBool("K.enter_blocked(True{}, False{}, 20n, 30n)")).toBe(false);
  });

  it("drift rejects strictly below the floor; at-floor enters (strategy-service.ts:885)", () => {
    expect(driftGateRejected(-9, -8)).toBe(true);
    expect(driftGateRejected(-8, -8)).toBe(false);
    expect(runBendBool("K.drift_rejects(True{}, 9n, 8n)")).toBe(true);
    expect(runBendBool("K.drift_rejects(True{}, 8n, 8n)")).toBe(false);
    expect(runBendBool("K.drift_rejects(False{}, 25n, 8n)")).toBe(driftGateRejected(25, -8));
  });

  it("fee/IL EXIT fires only when known, mature, and below 0.5 (program.ts:10792)", () => {
    expect(tsFeeExitFires(true, true, 0.4)).toBe(true);
    expect(tsFeeExitFires(false, true, 0.4)).toBe(false);
    expect(runBendBool("K.fee_exit_fires(True{}, True{}, 40n)")).toBe(true);
    expect(runBendBool("K.fee_exit_fires(False{}, True{}, 40n)")).toBe(false);
    expect(runBendBool("K.fee_exit_fires(True{}, False{}, 40n)")).toBe(
      tsFeeExitFires(true, false, 0.4),
    );
    expect(runBendBool("K.fee_exit_fires(True{}, True{}, 50n)")).toBe(
      tsFeeExitFires(true, true, 0.5),
    );
    expect(runBendBool("K.fee_exit_fires(True{}, True{}, 49n)")).toBe(
      tsFeeExitFires(true, true, 0.49),
    );
  });

  it("paper accrual allowed only for datapi paper without on-chain key (program.ts:10187)", () => {
    expect(tsAccrualAllowed(true, false, true)).toBe(true);
    expect(tsAccrualAllowed(true, false, false)).toBe(false);
    expect(runBendBool("K.accrual_allowed(True{}, False{}, True{})")).toBe(true);
    expect(runBendBool("K.accrual_allowed(True{}, False{}, False{})")).toBe(false);
  });

  // feeKnown is a pure bool passthrough of the host's own datapi comparison
  // (strategy-service.ts:179 `statsSource === "datapi"`); the kernel call
  // proves the wiring, the value is the host's comparison — covered natively
  // by the per-tick `bend_known` shadow + mismatch log, no parity assert adds
  // signal beyond echo.
  it("feeKnown echoes the datapi-only measured flag (strategy-service.ts:179)", () => {
    expect(runBendBool("K.fee_known(True{})")).toBe(true);
    expect(runBendBool("K.fee_known(False{})")).toBe(false);
  });

  it("ENTER floor is il_on AND known AND ratio-below-floor (program.ts:4695)", () => {
    expect(runBendBool("K.enter_blocked(True{}, True{}, 20n, 30n)")).toBe(
      tsEnterBlocked(true, true, 0.2, 0.3),
    );
    expect(runBendBool("K.enter_blocked(False{}, True{}, 20n, 30n)")).toBe(
      tsEnterBlocked(false, true, 0.2, 0.3),
    );
    expect(runBendBool("K.enter_blocked(True{}, True{}, 120n, 30n)")).toBe(
      tsEnterBlocked(true, true, 1.2, 0.3),
    );
    expect(runBendBool("K.enter_blocked(True{}, True{}, 30n, 30n)")).toBe(
      tsEnterBlocked(true, true, 0.3, 0.3),
    );
  });

  it("capital EXIT fires on danger alone, confidence-free (kernels.bend:capital_exit)", () => {
    expect(runBendBool("K.capital_exit(True{}, 95n)")).toBe(tsCapitalExit(true));
    expect(runBendBool("K.capital_exit(True{}, 5n)")).toBe(tsCapitalExit(true));
    expect(runBendBool("K.capital_exit(False{}, 95n)")).toBe(tsCapitalExit(false));
  });

  // Real-fn parity: engine/ta-exhaustion.ts isTaExhausted is the source of
  // truth — RSI(2) overbought AND (close above BB-upper OR first MACD-green
  // histogram). Mirrors native ta_exhausted_truth_table; LAWS pending strategy review.
  it("TA-exhaustion fires on RSI AND (BB OR MACD) (kernels.bend:ta_exhausted)", () => {
    expect(runBendBool("K.ta_exhausted(True{}, True{}, True{})")).toBe(
      isTaExhausted(true, true, true),
    );
    expect(runBendBool("K.ta_exhausted(True{}, True{}, False{})")).toBe(
      isTaExhausted(true, true, false),
    );
    expect(runBendBool("K.ta_exhausted(True{}, False{}, True{})")).toBe(
      isTaExhausted(true, false, true),
    );
    expect(runBendBool("K.ta_exhausted(True{}, False{}, False{})")).toBe(
      isTaExhausted(true, false, false),
    );
    expect(runBendBool("K.ta_exhausted(False{}, True{}, True{})")).toBe(
      isTaExhausted(false, true, true),
    );
    expect(runBendBool("K.ta_exhausted(False{}, False{}, False{})")).toBe(
      isTaExhausted(false, false, false),
    );
  });

  // Spec mirror of the decidePositionExit chain shape (program.ts:10959-10970
  // is 5-way with no 1n/2n/3n projection): TP-ladder hit wins over
  // TA-exhaustion, which wins over any loss-side signal; none ->
  // hold/scale-in (0n). Mirrors native exit_order_precedence.
  it("exit order picks TP(1n) over TA(2n) over loss(3n) over none (kernels.bend:exit_order)", () => {
    expect(runBendNat("K.exit_order(True{}, True{}, True{})")).toBe(
      BigInt(tsExitOrder(true, true, true)),
    );
    expect(runBendNat("K.exit_order(False{}, True{}, True{})")).toBe(
      BigInt(tsExitOrder(false, true, true)),
    );
    expect(runBendNat("K.exit_order(False{}, False{}, True{})")).toBe(
      BigInt(tsExitOrder(false, false, true)),
    );
    expect(runBendNat("K.exit_order(False{}, False{}, False{})")).toBe(
      BigInt(tsExitOrder(false, false, false)),
    );
    expect(runBendNat("K.exit_order(True{}, False{}, False{})")).toBe(
      BigInt(tsExitOrder(true, false, false)),
    );
  });
});
