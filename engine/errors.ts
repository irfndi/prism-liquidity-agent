import { Data } from "effect";

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
}> {}
