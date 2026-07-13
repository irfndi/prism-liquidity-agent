import { describe, expect, it } from "vitest";
import {
  isInsufficientTokenBalanceError,
  nextEntryFailureBackoff,
} from "../engine/entry-backoff.js";

describe("entry failure backoff", () => {
  it("classifies only deterministic token-balance failures", () => {
    expect(isInsufficientTokenBalanceError("Insufficient token balance: SOL required 1")).toBe(
      true,
    );
    expect(isInsufficientTokenBalanceError("RPC 429 Too Many Requests")).toBe(false);
    expect(isInsufficientTokenBalanceError(undefined)).toBe(false);
  });

  it("increases the retry delay and caps it", () => {
    const first = nextEntryFailureBackoff(undefined, 1_000);
    const second = nextEntryFailureBackoff(first, 1_000);
    let capped = second;
    for (let i = 0; i < 10; i++) {
      capped = nextEntryFailureBackoff(capped, 1_000);
    }

    expect(first.nextAttemptAt).toBe(1_801_000);
    expect(second.nextAttemptAt).toBe(3_601_000);
    expect(capped.nextAttemptAt).toBe(21_601_000);
  });
});
