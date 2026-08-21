import { vi } from "vitest";

/** Explicit fail-fast implementations for SDK operations outside a scenario. */
export const unsupportedDlmmMethods = {
  cancelLimitOrder: vi.fn(async () => {
    throw new Error("unexpected cancelLimitOrder call");
  }),
  claimAllLMRewards: vi.fn(async () => {
    throw new Error("unexpected claimAllLMRewards call");
  }),
  claimSwapFee: vi.fn(async () => {
    throw new Error("unexpected claimSwapFee call");
  }),
  closePositionIfEmpty: vi.fn(async () => {
    throw new Error("unexpected closePositionIfEmpty call");
  }),
  getActiveBin: vi.fn(async () => {
    throw new Error("unexpected getActiveBin call");
  }),
  getBinsAroundActiveBin: vi.fn(async () => {
    throw new Error("unexpected getBinsAroundActiveBin call");
  }),
  getPosition: vi.fn(async () => {
    throw new Error("unexpected getPosition call");
  }),
  getPositionsByUserAndLbPair: vi.fn(async () => {
    throw new Error("unexpected getPositionsByUserAndLbPair call");
  }),
  initializePositionAndAddLiquidityByStrategy: vi.fn(async () => {
    throw new Error("unexpected initializePositionAndAddLiquidityByStrategy call");
  }),
  placeLimitOrder: vi.fn(async () => {
    throw new Error("unexpected placeLimitOrder call");
  }),
  rebalancePosition: vi.fn(async () => {
    throw new Error("unexpected rebalancePosition call");
  }),
  refetchStates: vi.fn(async () => {
    throw new Error("unexpected refetchStates call");
  }),
  removeLiquidity: vi.fn(async () => {
    throw new Error("unexpected removeLiquidity call");
  }),
  simulateRebalancePosition: vi.fn(async () => {
    throw new Error("unexpected simulateRebalancePosition call");
  }),
};
