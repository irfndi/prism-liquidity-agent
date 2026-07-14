import { describe, expect, it, vi } from "vitest";
import {
  nextProposalBackoff,
  isProposalBackoffActive,
  ProposalCircuitBreaker,
} from "../engine/proposal-backoff.js";

const opts = { baseMs: 60_000, maxMs: 3_600_000, jitter: 0 };

describe("nextProposalBackoff", () => {
  it("increases exponentially", () => {
    const first = nextProposalBackoff(undefined, 0, opts);
    expect(first.failures).toBe(1);
    expect(first.nextProposalAt).toBe(60_000);

    const second = nextProposalBackoff(first, 0, opts);
    expect(second.failures).toBe(2);
    expect(second.nextProposalAt).toBe(120_000);

    const third = nextProposalBackoff(second, 0, opts);
    expect(third.failures).toBe(3);
    expect(third.nextProposalAt).toBe(240_000);
  });

  it("caps at maxMs", () => {
    let backoff = nextProposalBackoff(undefined, 0, opts);
    for (let i = 0; i < 20; i++) {
      backoff = nextProposalBackoff(backoff, 0, opts);
    }
    expect(backoff.nextProposalAt).toBeLessThanOrEqual(3_600_000);
    expect(backoff.nextProposalAt).toBeGreaterThanOrEqual(3_600_000);
  });

  it("applies jitter", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const backoff = nextProposalBackoff(undefined, 0, { baseMs: 60_000, maxMs: 3_600_000 });
    expect(backoff.nextProposalAt).toBe(75_000); // 60_000 * 1.25
    vi.restoreAllMocks();
  });
});

describe("isProposalBackoffActive", () => {
  it("returns true before nextProposalAt", () => {
    const backoff = nextProposalBackoff(undefined, 0, opts);
    expect(isProposalBackoffActive(backoff, 30_000)).toBe(true);
  });

  it("returns false after nextProposalAt", () => {
    const backoff = nextProposalBackoff(undefined, 0, opts);
    expect(isProposalBackoffActive(backoff, 60_001)).toBe(false);
  });

  it("returns false when backoff is undefined", () => {
    expect(isProposalBackoffActive(undefined, 0)).toBe(false);
  });
});

describe("ProposalCircuitBreaker", () => {
  it("starts closed", () => {
    const cb = new ProposalCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
    expect(cb.isOpen(0)).toBe(false);
    expect(cb.canTry(0)).toBe(true);
  });

  it("opens after threshold failures", () => {
    const cb = new ProposalCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
    cb.recordFailure(0);
    cb.recordFailure(0);
    cb.recordFailure(0);
    expect(cb.isOpen(0)).toBe(true);
    expect(cb.canTry(0)).toBe(false);
  });

  it("closes after cooldown", () => {
    const cb = new ProposalCircuitBreaker({ failureThreshold: 2, cooldownMs: 60_000 });
    cb.recordFailure(0);
    cb.recordFailure(0);
    expect(cb.isOpen(59_999)).toBe(true);
    expect(cb.isOpen(60_000)).toBe(false);
    expect(cb.canTry(60_000)).toBe(true);
  });

  it("resets on success", () => {
    const cb = new ProposalCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
    cb.recordFailure(0);
    cb.recordFailure(0);
    cb.recordSuccess();
    expect(cb.getState().failures).toBe(0);
    expect(cb.isOpen(0)).toBe(false);
  });
});
