import { describe, expect, it } from "vitest";
import { measureWithdrawalDelta } from "../engine/adapter-service.js";
import { SOL_MINT } from "../engine/constants.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function held(
  entries: ReadonlyArray<[string, bigint]>,
): ReadonlyMap<string, { readonly amountAtomic: bigint; readonly decimals: number }> {
  return new Map(entries.map(([mint, amountAtomic]) => [mint, { amountAtomic, decimals: 6 }]));
}

describe("measureWithdrawalDelta", () => {
  it("uses the measured SPL delta when the close credited more than the SDK snapshot (issue #205)", () => {
    // The live case: position closed all-USDC, on-chain credited $41.91 USDC
    // (24,377,718 -> 41,910,000 micro read as pre->post), SDK snapshot 24.38.
    const before = held([[USDC, 2_438_792n]]);
    const after = held([[USDC, 44_352_396n]]);
    const result = measureWithdrawalDelta({
      beforeHeld: before,
      afterHeld: after,
      beforeNativeSol: 1n,
      afterNativeSol: 1n,
      mint: USDC,
      snapshotAmount: "24377718",
    });
    expect(result).toBe("41913604");
  });

  it("falls back to the snapshot when the SPL delta is not positive", () => {
    const before = held([[USDC, 44_352_396n]]);
    const after = held([[USDC, 44_352_396n]]);
    const result = measureWithdrawalDelta({
      beforeHeld: before,
      afterHeld: after,
      beforeNativeSol: 1n,
      afterNativeSol: 1n,
      mint: USDC,
      snapshotAmount: "24377718",
    });
    expect(result).toBe("24377718");
  });

  it("falls back to the snapshot when the wallet reads failed", () => {
    const result = measureWithdrawalDelta({
      beforeHeld: null,
      afterHeld: null,
      beforeNativeSol: null,
      afterNativeSol: null,
      mint: USDC,
      snapshotAmount: "24377718",
    });
    expect(result).toBe("24377718");
  });

  it("falls back when the leg was not held before (new ATA, no measurable delta)", () => {
    const before = held([]);
    const after = held([[USDC, 41_910_000n]]);
    const result = measureWithdrawalDelta({
      beforeHeld: before,
      afterHeld: after,
      beforeNativeSol: 1n,
      afterNativeSol: 1n,
      mint: USDC,
      snapshotAmount: "24377718",
    });
    expect(result).toBe("41910000");
  });

  it("measures the native SOL leg from the balance delta", () => {
    const result = measureWithdrawalDelta({
      beforeHeld: held([]),
      afterHeld: held([]),
      beforeNativeSol: 1_000_000_000n,
      afterNativeSol: 1_500_000_000n,
      mint: SOL_MINT,
      snapshotAmount: "100000000",
    });
    expect(result).toBe("500000000");
  });

  it("falls back for a native SOL leg whose credit is eaten by tx fees (delta not positive)", () => {
    const result = measureWithdrawalDelta({
      beforeHeld: held([]),
      afterHeld: held([]),
      beforeNativeSol: 1_500_000_000n,
      afterNativeSol: 1_480_000_000n,
      mint: SOL_MINT,
      snapshotAmount: "100000000",
    });
    expect(result).toBe("100000000");
  });
});
