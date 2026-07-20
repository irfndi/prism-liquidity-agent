import type { ConcreteFunctionType } from "@meteora-ag/dlmm";

export type LimitOrderSide = "ask" | "bid";

export interface LimitOrderRequest {
  readonly side: LimitOrderSide;
  readonly targetBinId: number;
  readonly amountAtomic: bigint;
  readonly maxActiveBinSlippage?: number;
}

export interface ValidatedLimitOrderRequest extends LimitOrderRequest {
  readonly isAskSide: boolean;
}

export function validateLimitOrderRequest(
  request: LimitOrderRequest,
  concreteFunctionType: number,
  limitOrderType: typeof ConcreteFunctionType.LimitOrder,
): ValidatedLimitOrderRequest {
  if (concreteFunctionType !== limitOrderType) {
    throw new Error("Limit orders are unsupported for this pool function type");
  }
  if (!Number.isSafeInteger(request.targetBinId)) {
    throw new Error("Limit-order target bin must be an integer");
  }
  if (request.amountAtomic <= 0n) {
    throw new Error("Limit-order amount must be positive");
  }
  if (
    request.maxActiveBinSlippage !== undefined &&
    (!Number.isSafeInteger(request.maxActiveBinSlippage) || request.maxActiveBinSlippage < 0)
  ) {
    throw new Error("Limit-order active-bin slippage must be a non-negative integer");
  }
  return { ...request, isAskSide: request.side === "ask" };
}
