import { describe, expect, it } from "vitest";
import { routeProbeAmountAtomic } from "../engine/route-probe.js";

describe("route probe sizing", () => {
  it("converts the bounded USD notional using token decimals", () => {
    expect(routeProbeAmountAtomic(1, 6)).toBe(1_000_000n);
    expect(routeProbeAmountAtomic(0.1, 9)).toBe(10_000_000_000n);
  });

  it("uses one atomic unit for a positive price when the notional rounds down", () => {
    expect(routeProbeAmountAtomic(10_000, 0)).toBe(1n);
  });

  it("rejects invalid prices and decimal counts", () => {
    expect(routeProbeAmountAtomic(0, 6)).toBe(0n);
    expect(routeProbeAmountAtomic(1, -1)).toBe(0n);
    expect(routeProbeAmountAtomic(1, 19)).toBe(0n);
  });
});
