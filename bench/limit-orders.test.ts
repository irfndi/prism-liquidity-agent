import { describe, expect, it } from "vitest";
import { ConcreteFunctionType } from "@meteora-ag/dlmm";
import { validateLimitOrderRequest } from "../engine/limit-orders.js";

describe("limit-order request validation", () => {
  it("accepts a valid take-profit request for a limit-order pool", () => {
    const result = validateLimitOrderRequest(
      { side: "ask", targetBinId: 120, amountAtomic: 10n, maxActiveBinSlippage: 3 },
      ConcreteFunctionType.LimitOrder,
      ConcreteFunctionType.LimitOrder,
    );

    expect(result).toEqual({
      side: "ask",
      targetBinId: 120,
      amountAtomic: 10n,
      maxActiveBinSlippage: 3,
      isAskSide: true,
    });
  });

  it("rejects unsupported concrete function types", () => {
    expect(() =>
      validateLimitOrderRequest(
        { side: "bid", targetBinId: 120, amountAtomic: 10n },
        ConcreteFunctionType.LiquidityMining,
        ConcreteFunctionType.LimitOrder,
      ),
    ).toThrow("unsupported");
  });

  it("rejects malformed amount and target bins", () => {
    expect(() =>
      validateLimitOrderRequest(
        { side: "ask", targetBinId: 120.5, amountAtomic: 10n },
        ConcreteFunctionType.LimitOrder,
        ConcreteFunctionType.LimitOrder,
      ),
    ).toThrow("integer");
    expect(() =>
      validateLimitOrderRequest(
        { side: "ask", targetBinId: 120, amountAtomic: 0n },
        ConcreteFunctionType.LimitOrder,
        ConcreteFunctionType.LimitOrder,
      ),
    ).toThrow("positive");
  });
});
