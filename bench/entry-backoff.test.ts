import { describe, expect, it } from "vitest";
import {
  isInsufficientTokenBalanceError,
  nextEntryFailureBackoff,
} from "../engine/entry-backoff.js";

describe("entry failure backoff", () => {
  it("classifies deterministic token-balance failures", () => {
    expect(isInsufficientTokenBalanceError("Insufficient token balance: SOL required 1")).toBe(
      true,
    );
    expect(
      isInsufficientTokenBalanceError(
        "Entry token preparation failed: [INSUFFICIENT_USDC_BALANCE] Wallet USDC balance 0.000100 is less than required 1010.000000 for auto-swap entry",
      ),
    ).toBe(true);
    expect(
      isInsufficientTokenBalanceError(
        "Entry token preparation failed: [INSUFFICIENT_BALANCE_AFTER_SWAP] Balances still insufficient after swap",
      ),
    ).toBe(true);
    expect(isInsufficientTokenBalanceError("Insufficient SOL for gas — skipping ENTER")).toBe(true);
    expect(isInsufficientTokenBalanceError("RPC 429 Too Many Requests")).toBe(false);
    expect(isInsufficientTokenBalanceError(undefined)).toBe(false);
  });

  it("increases the retry delay and caps it", () => {
    const first = nextEntryFailureBackoff(undefined, 1_000);
    const second = nextEntryFailureBackoff({ ...first, nextAttemptAt: 0 }, 1_000);
    let capped = second;
    for (let i = 0; i < 10; i++) {
      capped = nextEntryFailureBackoff(capped, 1_000);
    }

    expect(first.nextAttemptAt).toBe(1_801_000);
    expect(second.nextAttemptAt).toBe(3_601_000);
    expect(capped.nextAttemptAt).toBe(21_601_000);
  });
});
