import { describe, expect, it } from "vitest";
import {
  canConvertFeeAmounts,
  routeClaimedFees,
  summarizeAccumulation,
} from "../engine/fee-destination.js";

describe("fee destination routing", () => {
  it("preserves compound as the default", () => {
    expect(routeClaimedFees(undefined)).toEqual({ kind: "compound" });
    expect(routeClaimedFees("compound")).toEqual({ kind: "compound" });
  });

  it.each(["accumulate-quote", "accumulate-sol"] as const)(
    "routes %s without compounding",
    (destination) => {
      expect(routeClaimedFees(destination)).toEqual({ kind: "accumulate", destination });
    },
  );

  it("rejects zero, negative, and non-finite conversion amounts", () => {
    expect(canConvertFeeAmounts(0, 0)).toBe(false);
    expect(canConvertFeeAmounts(-1, 0)).toBe(false);
    expect(canConvertFeeAmounts(Number.NaN, 1)).toBe(false);
    expect(canConvertFeeAmounts(1, 0)).toBe(true);
  });

  it("summarizes successful Jupiter conversions", () => {
    expect(
      summarizeAccumulation(
        "accumulate-sol",
        [
          { inputMint: "token-x", amountAtomic: 10n, outputAtomic: 8n, signature: "sig-x" },
          { inputMint: "token-y", amountAtomic: 20n, outputAtomic: 16n, signature: "sig-y" },
        ],
        "sol",
      ),
    ).toEqual({
      destination: "accumulate-sol",
      outputAtomic: 24n,
      txSignatures: ["sig-x", "sig-y"],
    });
  });

  it("fails closed for unsupported or zero Jupiter output", () => {
    expect(() => summarizeAccumulation("accumulate-quote", [], "usdc")).toThrow();
    expect(() =>
      summarizeAccumulation(
        "accumulate-quote",
        [{ inputMint: "token", amountAtomic: 1n, outputAtomic: 0n }],
        "usdc",
      ),
    ).toThrow();
    expect(() =>
      summarizeAccumulation(
        "accumulate-quote",
        [{ inputMint: "", amountAtomic: 1n, outputAtomic: 1n }],
        "usdc",
      ),
    ).toThrow();
  });
});
