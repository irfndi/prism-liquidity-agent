import { describe, it, expect, vi, afterEach } from "vitest";
import { Effect } from "effect";
import {
  isRetriableError,
  isRpcNetworkError,
  retryWithBackoff,
  CircuitBreaker,
  CircuitBreakerOpenError,
} from "../engine/adapter-retry.js";

const fromPromise = <T>(fn: () => Promise<T>): Effect.Effect<T, unknown> => Effect.tryPromise(fn);

afterEach(() => {
  vi.useRealTimers();
});

// ── isRetriableError ──────────────────────────────────────────────

describe("isRetriableError", () => {
  it("returns true for error with code 429", () => {
    expect(isRetriableError({ code: 429 })).toBe(true);
  });

  it("returns true for Helius JSON-RPC rate-limit code -32005", () => {
    expect(isRetriableError({ code: -32005 })).toBe(true);
  });

  it("returns true for a too-many-requests message", () => {
    expect(isRetriableError({ message: "Too many requests" })).toBe(true);
  });

  it("returns true for error whose message contains 429", () => {
    expect(isRetriableError({ message: "status 429 too many requests" })).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isRetriableError(new Error("connection refused"))).toBe(false);
    expect(isRetriableError({ code: 500 })).toBe(false);
    expect(isRetriableError(null)).toBe(false);
    expect(isRetriableError(undefined)).toBe(false);
    expect(isRetriableError("string error")).toBe(false);
  });
});

// ── retryWithBackoff ──────────────────────────────────────────────

describe("retryWithBackoff", () => {
  it("succeeds on first attempt", async () => {
    const fn = vi.fn(async () => "ok");
    const result = await Effect.runPromise(retryWithBackoff(fn, { baseDelayMs: 10 }));
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retriable error then succeeds", async () => {
    let call = 0;
    const fn = vi.fn(async () => {
      call++;
      if (call <= 2) {
        throw Object.assign(new Error("rate limited"), { code: 429 });
      }
      return "ok";
    });
    const result = await Effect.runPromise(
      retryWithBackoff(fn, {
        baseDelayMs: 100,
        rateLimitBaseDelayMs: 10,
        maxRetries: 5,
      }),
    );
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws after maxRetries exhausted", async () => {
    const fn = vi.fn(async () => {
      throw Object.assign(new Error("rate limited"), { code: 429 });
    });
    await expect(
      Effect.runPromise(
        retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 10, rateLimitBaseDelayMs: 10 }),
      ),
    ).rejects.toThrow();
    // attempts: 0,1,2,3 = 4 total (maxRetries+1)
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("does not retry on non-retriable error", async () => {
    const fn = vi.fn(async () => {
      throw new Error("bad input");
    });
    await expect(Effect.runPromise(retryWithBackoff(fn, { baseDelayMs: 10 }))).rejects.toThrow(
      "bad input",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("honors Retry-After headers when rate limited", async () => {
    let call = 0;
    const startedAt = Date.now();
    const fn = vi.fn(async () => {
      call++;
      if (call === 1) {
        throw {
          code: 429,
          headers: { get: () => "0.02" },
          message: "too many requests",
        };
      }
      return "ok";
    });

    await Effect.runPromise(
      retryWithBackoff(fn, { baseDelayMs: 1, rateLimitBaseDelayMs: 1, maxRetries: 1 }),
    );

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ── CircuitBreaker ────────────────────────────────────────────────

describe("CircuitBreaker", () => {
  it("executes normally when closed", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    const result = await Effect.runPromise(cb.execute(fromPromise(async () => 42)));
    expect(result).toBe(42);
    expect(cb.getState()).toBe("CLOSED");
  });

  it("opens after threshold failures", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 60_000 });
    const fail = async () => {
      throw new Error("fail");
    };

    for (let i = 0; i < 3; i++) {
      await Effect.runPromise(
        cb.execute(fromPromise(fail)).pipe(Effect.catchAll(() => Effect.void)),
      );
    }

    expect(cb.getState()).toBe("OPEN");

    // Next call should throw CircuitBreakerOpenError without invoking fn
    const fn = vi.fn(async () => "never");
    await expect(Effect.runPromise(cb.execute(fromPromise(fn)))).rejects.toThrow(
      "Circuit breaker is OPEN",
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it("transitions to HALF_OPEN after reset timeout", async () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 });
    const fail = async () => {
      throw new Error("fail");
    };

    // Open the breaker
    await Effect.runPromise(cb.execute(fromPromise(fail)).pipe(Effect.catchAll(() => Effect.void)));
    await Effect.runPromise(cb.execute(fromPromise(fail)).pipe(Effect.catchAll(() => Effect.void)));
    expect(cb.getState()).toBe("OPEN");

    // Advance time past resetTimeout
    vi.advanceTimersByTime(1100);
    expect(cb.getState()).toBe("HALF_OPEN");
  });

  it("rejects concurrent callers in HALF_OPEN state", async () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 });
    const fail = async () => {
      throw new Error("fail");
    };

    await Effect.runPromise(cb.execute(fromPromise(fail)).pipe(Effect.catchAll(() => Effect.void)));
    await Effect.runPromise(cb.execute(fromPromise(fail)).pipe(Effect.catchAll(() => Effect.void)));
    vi.advanceTimersByTime(1100);
    expect(cb.getState()).toBe("HALF_OPEN");

    let resolveTrial: ((value: string) => void) | undefined;
    const trial = new Promise<string>((resolve) => {
      resolveTrial = resolve;
    });

    const first = Effect.runPromise(cb.execute(fromPromise(() => trial)));
    await Promise.resolve();
    expect(cb.getState()).toBe("HALF_OPEN");

    const second = cb.execute(fromPromise(async () => "never"));
    await expect(Effect.runPromise(second)).rejects.toThrow("Circuit breaker is HALF_OPEN");

    resolveTrial!("recovered");
    const result = await first;
    expect(result).toBe("recovered");
    expect(cb.getState()).toBe("CLOSED");
  });

  it("reopens on half-open failure", async () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 });
    const fail = async () => {
      throw new Error("fail");
    };

    await Effect.runPromise(cb.execute(fromPromise(fail)).pipe(Effect.catchAll(() => Effect.void)));
    await Effect.runPromise(cb.execute(fromPromise(fail)).pipe(Effect.catchAll(() => Effect.void)));
    vi.advanceTimersByTime(1100);
    expect(cb.getState()).toBe("HALF_OPEN");

    await Effect.runPromise(cb.execute(fromPromise(fail)).pipe(Effect.catchAll(() => Effect.void)));
    expect(cb.getState()).toBe("OPEN");
  });

  it("does NOT trip on non-retriable business-logic errors when classifier provided", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 60_000 });
    const businessError = new Error("insufficient token balance");

    for (let i = 0; i < 5; i++) {
      await Effect.runPromise(
        cb
          .execute(
            fromPromise(async () => {
              throw businessError;
            }),
            () => false,
          )
          .pipe(Effect.catchAll(() => Effect.void)),
      );
    }

    expect(cb.getState()).toBe("CLOSED");
    expect(cb["consecutiveFailures"]).toBe(0);
  });

  it("DOES trip on retriable network errors when classifier provided", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 60_000 });
    const networkError = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });

    for (let i = 0; i < 3; i++) {
      await Effect.runPromise(
        cb
          .execute(
            fromPromise(async () => {
              throw networkError;
            }),
            () => true,
          )
          .pipe(Effect.catchAll(() => Effect.void)),
      );
    }

    expect(cb.getState()).toBe("OPEN");
  });

  it("classifier defaults to counting all errors when omitted", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 60_000 });

    for (let i = 0; i < 2; i++) {
      await Effect.runPromise(
        cb
          .execute(
            fromPromise(async () => {
              throw new Error("any error");
            }),
          )
          .pipe(Effect.catchAll(() => Effect.void)),
      );
    }

    expect(cb.getState()).toBe("OPEN");
  });

  it("resets failure count on success even after retriable failures", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 60_000 });
    const networkError = Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });

    await Effect.runPromise(
      cb
        .execute(
          fromPromise(async () => {
            throw networkError;
          }),
          () => true,
        )
        .pipe(Effect.catchAll(() => Effect.void)),
    );
    await Effect.runPromise(
      cb
        .execute(
          fromPromise(async () => {
            throw networkError;
          }),
          () => true,
        )
        .pipe(Effect.catchAll(() => Effect.void)),
    );

    expect(cb["consecutiveFailures"]).toBe(2);

    await Effect.runPromise(
      cb.execute(
        fromPromise(async () => "recovered"),
        () => true,
      ),
    );
    expect(cb["consecutiveFailures"]).toBe(0);
    expect(cb.getState()).toBe("CLOSED");
  });
});

// ── isRpcNetworkError ─────────────────────────────────────────────

describe("isRpcNetworkError", () => {
  it("returns true for ECONNREFUSED", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(isRpcNetworkError(err)).toBe(true);
  });

  it("returns true for ETIMEDOUT", () => {
    const err = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    expect(isRpcNetworkError(err)).toBe(true);
  });

  it("returns true for ENOTFOUND", () => {
    const err = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    expect(isRpcNetworkError(err)).toBe(true);
  });

  it("returns true for ECONNRESET", () => {
    const err = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(isRpcNetworkError(err)).toBe(true);
  });

  it("returns true for HTTP 429", () => {
    expect(isRpcNetworkError({ code: 429 })).toBe(true);
  });

  it("returns true for Helius JSON-RPC rate-limit code -32005", () => {
    expect(isRpcNetworkError({ code: -32005 })).toBe(true);
  });

  it("returns true for HTTP 500", () => {
    expect(isRpcNetworkError({ code: 500 })).toBe(true);
  });

  it("returns true for HTTP 503", () => {
    expect(isRpcNetworkError({ code: 503 })).toBe(true);
  });

  it("returns true for error message containing 429", () => {
    expect(isRpcNetworkError(new Error("rate limited: HTTP 429"))).toBe(true);
  });

  it("returns true for error message containing HTTP 5xx", () => {
    expect(isRpcNetworkError(new Error("HTTP 502 Bad Gateway"))).toBe(true);
  });

  it("returns true for fetch failed TypeError", () => {
    expect(isRpcNetworkError(new TypeError("fetch failed"))).toBe(true);
  });

  it("returns true for network TypeError", () => {
    expect(isRpcNetworkError(new TypeError("Network request failed"))).toBe(true);
  });

  it("returns false for business-logic errors", () => {
    expect(isRpcNetworkError(new Error("insufficient token balance"))).toBe(false);
  });

  it("returns false for AdapterError-like objects", () => {
    expect(isRpcNetworkError({ _tag: "AdapterError", message: "No wallet configured" })).toBe(
      false,
    );
  });

  it("returns false for HTTP 400", () => {
    expect(isRpcNetworkError({ code: 400 })).toBe(false);
  });

  it("returns false for HTTP 404", () => {
    expect(isRpcNetworkError({ code: 404 })).toBe(false);
  });

  it("returns false for null", () => {
    expect(isRpcNetworkError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isRpcNetworkError(undefined)).toBe(false);
  });
});
