import { describe, expect, it } from "vitest";
import { classifyStrandedSettlement } from "../cli/status.js";

const base = {
  priceState: "ok" as const,
  priceUsd: 1,
  decimalsState: "ok" as const,
  decimals: 6,
  amountAtomic: "1500000", // 1.5 tokens × $1 = $1.50
  dustUsd: 0.1,
};

describe("classifyStrandedSettlement (issue #183 three-channel split)", () => {
  it("classifies priceable value at/above the dust cutoff as stranded with USD value", () => {
    expect(classifyStrandedSettlement(base)).toEqual({ kind: "stranded", valueUsd: 1.5 });
  });

  it("classifies priceable value below the dust cutoff as dust (excluded)", () => {
    expect(
      classifyStrandedSettlement({ ...base, amountAtomic: "50000" }), // $0.05
    ).toEqual({ kind: "dust", valueUsd: 0.05 });
  });

  it("is stranded at exactly the dust cutoff", () => {
    expect(
      classifyStrandedSettlement({ ...base, amountAtomic: "100000" }), // $0.10
    ).toEqual({ kind: "stranded", valueUsd: 0.1 });
  });

  it("classifies a PRICE typed failure (provider outage) as unavailable", () => {
    expect(
      classifyStrandedSettlement({ ...base, priceState: "unavailable", priceUsd: 0 }),
    ).toEqual({ kind: "unavailable" });
  });

  it("classifies a DECIMALS typed failure (RPC outage) as unavailable, not unpriceable", () => {
    expect(
      classifyStrandedSettlement({ ...base, decimalsState: "unavailable", decimals: 0 }),
    ).toEqual({ kind: "unavailable" });
  });

  it("classifies a genuinely unpriceable token (no price) as unpriceable", () => {
    expect(
      classifyStrandedSettlement({ ...base, priceState: "unpriceable", priceUsd: 0 }),
    ).toEqual({ kind: "unpriceable" });
  });

  it("classifies a decimals defect (malformed mint) as unpriceable", () => {
    expect(
      classifyStrandedSettlement({ ...base, decimalsState: "unpriceable", decimals: 0 }),
    ).toEqual({ kind: "unpriceable" });
  });

  it("classifies a non-finite amount as unpriceable, never silently invisible", () => {
    expect(classifyStrandedSettlement({ ...base, amountAtomic: "not-a-number" })).toEqual({
      kind: "unpriceable",
    });
  });

  it("prefers unavailable over unpriceable when both channels are broken", () => {
    // A provider outage must never be reported as worthless dust even if the
    // mint is also unquotable.
    expect(
      classifyStrandedSettlement({
        ...base,
        priceState: "unavailable",
        priceUsd: 0,
        decimalsState: "unpriceable",
        decimals: 0,
      }),
    ).toEqual({ kind: "unavailable" });
  });
});
