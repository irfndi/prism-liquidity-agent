import type { FeeDestination } from "./config-service.js";

export type FeeRouting =
  | { readonly kind: "compound" }
  | { readonly kind: "accumulate"; readonly destination: "accumulate-quote" | "accumulate-sol" };

export function routeClaimedFees(destination: FeeDestination | undefined): FeeRouting {
  const resolved = destination ?? "compound";
  return resolved === "compound"
    ? { kind: "compound" }
    : { kind: "accumulate", destination: resolved };
}

export function canConvertFeeAmounts(feeX: number, feeY: number): boolean {
  return Number.isFinite(feeX) && Number.isFinite(feeY) && (feeX > 0 || feeY > 0);
}

export interface FeeSwap {
  readonly inputMint: string;
  readonly amountAtomic: bigint;
  readonly outputAtomic: bigint;
  readonly signature?: string;
}

export function summarizeAccumulation(
  destination: "accumulate-quote" | "accumulate-sol",
  swaps: ReadonlyArray<FeeSwap>,
  targetMint: string,
): {
  readonly destination: "accumulate-quote" | "accumulate-sol";
  readonly outputAtomic: bigint;
  readonly txSignatures: ReadonlyArray<string>;
} {
  const outputAtomic = swaps.reduce((total, swap) => {
    if (swap.outputAtomic <= 0n || !swap.inputMint)
      throw new Error("invalid fee conversion output");
    return total + swap.outputAtomic;
  }, 0n);
  if (outputAtomic === 0n || !targetMint) throw new Error("fee conversion produced no output");
  return {
    destination,
    outputAtomic,
    txSignatures: swaps.flatMap((swap) => (swap.signature ? [swap.signature] : [])),
  };
}
