import { Data } from "effect";
import type { EntryPreparationOutcome } from "./services.js";

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly message: string;
  readonly issues?: ReadonlyArray<{ readonly path: string; readonly message: string }>;
}> {}

export class AdapterError extends Data.TaggedError("AdapterError")<{
  readonly message: string;
  readonly poolAddress?: string;
  readonly cause?: unknown;
}> {}

export class SwapQuoteError extends Data.TaggedError("SwapQuoteError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class SwapValidationError extends Data.TaggedError("SwapValidationError")<{
  readonly stage: "quote" | "prepare" | "simulate" | "submit" | "status";
  readonly reason:
    | "malformed_payload"
    | "mint_mismatch"
    | "amount_mismatch"
    | "route_mismatch"
    | "stale_quote"
    | "slippage_exceeded"
    | "price_impact_exceeded"
    | "simulation_failed"
    | "simulation_required";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class MemoryError extends Data.TaggedError("MemoryError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class RiskError extends Data.TaggedError("RiskError")<{
  readonly message: string;
  readonly reason: string;
}> {}

export class BlacklistError extends Data.TaggedError("BlacklistError")<{
  readonly message: string;
  readonly poolAddress?: string;
}> {}

export class ScreenerError extends Data.TaggedError("ScreenerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class AuditError extends Data.TaggedError("AuditError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class DiscoverPoolsError extends Data.TaggedError("DiscoverPoolsError")<{
  readonly message: string;
  readonly url: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

export class EntryPrepError extends Data.TaggedError("EntryPrepError")<{
  readonly code:
    | "PRICE_UNAVAILABLE"
    | "SWAP_QUOTE_FAILED"
    | "SWAP_TRANSACTION_FAILED"
    | "INSUFFICIENT_BALANCE_AFTER_SWAP"
    | "INSUFFICIENT_USDC_BALANCE"
    | "BALANCE_READ_FAILED"
    | "NO_WALLET";
  readonly message: string;
  readonly poolAddress?: string;
  readonly cause?: unknown;
  readonly partialPreparation?: EntryPreparationOutcome;
}> {}

export class PersistenceContractError extends Data.TaggedError("PersistenceContractError")<{
  readonly entity: "token_candidate" | "execution_operation" | "settlement_job";
  readonly field: "state" | "operation_type" | "status" | "destination_asset";
  readonly value: string;
}> {}

// Effect.tryPromise wraps rejections in UnknownException, whose `message` is a
// generic "An error has occurred" wrapper — `String(err)` renders only that
// wrapper and hides the real failure (e.g. "Gateway 1008: ..."). Walk the `.cause`
// chain to the deepest non-empty Error message; fall back to `String(err)` when the
// chain holds no Error with a message. A `seen` set guards self-referential causes.
export function underlyingErrorMessage(err: unknown): string {
  let deepest: string | null = null;
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error && current.message.length > 0) {
      deepest = current.message;
    }
    current = "cause" in current ? (current as { readonly cause: unknown }).cause : undefined;
  }
  if (deepest !== null) return deepest;
  return err instanceof Error ? err.message : String(err);
}
