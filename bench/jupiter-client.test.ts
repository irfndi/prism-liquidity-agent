import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  jupiterFetch,
  resetJupiterGateForTest,
  setJupiterGateForTest,
} from "../engine/jupiter-client.js";
import { asFetch } from "./helpers.js";

function mockFetchOnce(
  impl: (url: string | URL | Request, init?: RequestInit) => Response | Promise<Response>,
): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(asFetch(impl));
}

function okResponse(): Response {
  return new Response(JSON.stringify({ data: [] }), { status: 200 });
}

function rateLimitedResponse(resetAtSeconds?: number): Response {
  type HeadersMap = Record<string, string>;
  const headers: HeadersMap = { "Content-Type": "application/json" };
  if (resetAtSeconds !== undefined) headers["x-ratelimit-reset"] = String(resetAtSeconds);
  return new Response(JSON.stringify({ code: 429, message: "[API Gateway] Too many requests" }), {
    status: 429,
    headers,
  });
}

describe("jupiterFetch traffic gate (issue #196 follow-up)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetJupiterGateForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetJupiterGateForTest();
  });

  it("paces requests to the configured interval (shared keyless bucket)", async () => {
    setJupiterGateForTest({ intervalMs: 50 });
    let fetchCount = 0;
    mockFetchOnce(() => {
      fetchCount += 1;
      return okResponse();
    });

    const first = jupiterFetch(
      "https://api.jup.ag/swap/v1/quote?inputMint=a&outputMint=b&amount=1",
    );
    await vi.advanceTimersByTimeAsync(0);
    await first;

    // The second request waits for the slot reserved by the first (50ms).
    const second = jupiterFetch(
      "https://api.jup.ag/swap/v1/quote?inputMint=a&outputMint=b&amount=1",
    );
    await vi.advanceTimersByTimeAsync(25);
    expect(fetchCount).toBe(1); // still waiting for the slot
    await vi.advanceTimersByTimeAsync(25);
    await second;

    expect(fetchCount).toBe(2);
  });

  it("fails fast with a synthetic 429 while the breaker cooldown is open", async () => {
    setJupiterGateForTest({ intervalMs: 0, baseCooldownMs: 60_000 });
    let fetchCount = 0;
    mockFetchOnce(() => {
      fetchCount += 1;
      return rateLimitedResponse();
    });

    const first = await jupiterFetch("https://api.jup.ag/swap/v1/quote");
    expect(first.status).toBe(429);
    expect(fetchCount).toBe(1);

    // During the cooldown no network request is made — a ban can never be
    // refreshed by retry loops.
    await vi.advanceTimersByTimeAsync(5_000);
    const second = await jupiterFetch("https://api.jup.ag/swap/v1/quote");
    expect(second.status).toBe(429);
    expect(fetchCount).toBe(1);
  });

  it("honors x-ratelimit-reset as the backoff target (no Retry-After exists)", async () => {
    setJupiterGateForTest({ intervalMs: 0, baseCooldownMs: 10 });
    const resetAt = Math.floor(Date.now() / 1000) + 120; // 2 min out
    let fetchCount = 0;
    mockFetchOnce(() => {
      fetchCount += 1;
      return rateLimitedResponse(resetAt);
    });

    await jupiterFetch("https://api.jup.ag/swap/v1/quote");
    // The base cooldown (10ms) would have expired — but the reset header
    // extends the fail-fast window to the documented backoff target.
    await vi.advanceTimersByTimeAsync(30);
    const duringResetWindow = await jupiterFetch("https://api.jup.ag/swap/v1/quote");
    expect(duringResetWindow.status).toBe(429);
    expect(fetchCount).toBe(1);
  });

  it("escalates the cooldown on repeated 429s and clears on half-open success", async () => {
    setJupiterGateForTest({ intervalMs: 0, baseCooldownMs: 10 });
    let fetchCount = 0;
    mockFetchOnce(() => {
      fetchCount += 1;
      return fetchCount <= 2 ? rateLimitedResponse() : okResponse();
    });

    // First 429: cooldown 10ms.
    await jupiterFetch("https://api.jup.ag/swap/v1/quote");
    await vi.advanceTimersByTimeAsync(15);
    // Allowed again (cooldown expired); second 429 escalates to 20ms.
    await jupiterFetch("https://api.jup.ag/swap/v1/quote");
    expect(fetchCount).toBe(2);
    // Still within the escalated window → fail fast, no network.
    await vi.advanceTimersByTimeAsync(15);
    const duringEscalated = await jupiterFetch("https://api.jup.ag/swap/v1/quote");
    expect(duringEscalated.status).toBe(429);
    expect(fetchCount).toBe(2);
    // After the escalated window a probe succeeds and clears the breaker.
    await vi.advanceTimersByTimeAsync(10);
    const recovered = await jupiterFetch("https://api.jup.ag/swap/v1/quote");
    expect(recovered.status).toBe(200);
    expect(fetchCount).toBe(3);
    // The breaker is reset: a fresh 429 restarts from the base cooldown.
    mockFetchOnce(() => {
      fetchCount += 1;
      return fetchCount === 4 ? rateLimitedResponse() : okResponse();
    });
    await jupiterFetch("https://api.jup.ag/swap/v1/quote");
    await vi.advanceTimersByTimeAsync(15);
    const afterReset = await jupiterFetch("https://api.jup.ag/swap/v1/quote");
    expect(afterReset.status).toBe(200);
    expect(fetchCount).toBe(5);
  });

  it("re-checks the breaker after the pacing wait — a queued request behind a 429 fails fast", async () => {
    setJupiterGateForTest({ intervalMs: 30, baseCooldownMs: 60_000 });
    let fetchCount = 0;
    // The first request's 429 lands on a timer, so the second request is
    // already IN the pacing wait when the breaker opens mid-wait — only the
    // post-wait re-check can stop it from hitting the network (the entry
    // guard cannot, because the breaker is still closed when it starts).
    mockFetchOnce(() => {
      fetchCount += 1;
      return new Promise((resolve) => setTimeout(() => resolve(rateLimitedResponse()), 10));
    });

    const first = jupiterFetch("https://api.jup.ag/swap/v1/quote");
    const second = jupiterFetch("https://api.jup.ag/swap/v1/quote");
    // t0: first claims the free slot and sends (429 lands at t0+10); second
    // sees the slot t0+30 and waits.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCount).toBe(1);
    // t0+10: the first 429 opens the breaker while the second is still
    // waiting for its slot.
    await vi.advanceTimersByTimeAsync(10);
    // t0+30: the second wakes — the post-wait re-check returns the synthetic
    // 429 instead of fetching (fetchCount stays 1).
    await vi.advanceTimersByTimeAsync(20);
    const result = await second;
    await first;
    expect(result.status).toBe(429);
    expect(fetchCount).toBe(1);
  });

  it("claims pacing slots synchronously — concurrent callers cannot burst (P1)", async () => {
    setJupiterGateForTest({ intervalMs: 30 });
    let fetchCount = 0;
    mockFetchOnce(() => {
      fetchCount += 1;
      return okResponse();
    });

    // Three concurrent callers: each claims a distinct slot synchronously
    // (0ms, 30ms, 60ms), so fetches are spaced by the interval instead of
    // waking together and bursting.
    const calls = [
      jupiterFetch("https://api.jup.ag/swap/v1/quote?i=1"),
      jupiterFetch("https://api.jup.ag/swap/v1/quote?i=2"),
      jupiterFetch("https://api.jup.ag/swap/v1/quote?i=3"),
    ];
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCount).toBe(1);
    await vi.advanceTimersByTimeAsync(30);
    expect(fetchCount).toBe(2);
    await vi.advanceTimersByTimeAsync(30);
    await Promise.all(calls);
    expect(fetchCount).toBe(3);
  });

  it("aborts the pacing wait with the caller's signal — no request past its timeout", async () => {
    setJupiterGateForTest({ intervalMs: 10_000 });
    let fetchCount = 0;
    mockFetchOnce(() => {
      fetchCount += 1;
      return okResponse();
    });
    const controller = new AbortController();

    // First call claims the free slot and completes immediately.
    await jupiterFetch("https://api.jup.ag/swap/v1/quote");
    expect(fetchCount).toBe(1);

    // Second call waits for the next slot (10s out) — its abort signal must
    // cut the pacing wait short and no request may hit the network.
    const call = jupiterFetch("https://api.jup.ag/swap/v1/quote", {
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error("timed out"));
    await expect(call).rejects.toThrow("timed out");
    expect(fetchCount).toBe(1);
  });

  it("clamps a far-future x-ratelimit-reset so the breaker can self-heal", async () => {
    setJupiterGateForTest({ intervalMs: 0, baseCooldownMs: 10 });
    // A malformed/far-future stamp (millisecond timestamp ≈ year 57k) must
    // not wedge the breaker beyond the 60-minute cap.
    const farFutureReset = Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3_600;
    let fetchCount = 0;
    mockFetchOnce(() => {
      fetchCount += 1;
      return fetchCount === 1 ? rateLimitedResponse(farFutureReset) : okResponse();
    });

    await jupiterFetch("https://api.jup.ag/swap/v1/quote");
    // Past the 60-minute clamp (and the 10ms base cooldown): the gate allows
    // a probe again, and the success clears the breaker.
    await vi.advanceTimersByTimeAsync(3_600_000 + 1);
    const recovered = await jupiterFetch("https://api.jup.ag/swap/v1/quote");
    expect(recovered.status).toBe(200);
    expect(fetchCount).toBe(2);
  });

  it("an aborted waiter leaves no reservation — later callers are not queued behind it (P1)", async () => {
    setJupiterGateForTest({ intervalMs: 30 });
    let fetchCount = 0;
    mockFetchOnce(() => {
      fetchCount += 1;
      return new Promise((resolve) => setTimeout(() => resolve(okResponse()), 10));
    });
    const controller = new AbortController();

    // c1 claims the free slot and sends (resolves at t0+10).
    const c1 = jupiterFetch("https://api.jup.ag/swap/v1/quote");
    // c2 waits for the next slot (t0+30) but aborts mid-wait.
    const c2 = jupiterFetch("https://api.jup.ag/swap/v1/quote", {
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(10);
    await c1;
    controller.abort();
    await expect(c2).rejects.toThrow();
    expect(fetchCount).toBe(1);

    // c3 starts after c2 aborted: it must wait only ONE interval (30ms) —
    // the aborted waiter held no reservation, so there is no abandoned slot
    // to queue behind.
    const c3 = jupiterFetch("https://api.jup.ag/swap/v1/quote");
    await vi.advanceTimersByTimeAsync(30);
    await c3;
    expect(fetchCount).toBe(2);
  });

  it("returns the synthetic 429 with the gateway shape for existing error handling", async () => {
    setJupiterGateForTest({ intervalMs: 0, baseCooldownMs: 60_000 });
    mockFetchOnce(() => rateLimitedResponse());
    await jupiterFetch("https://api.jup.ag/swap/v1/quote");
    const synthetic = await jupiterFetch("https://api.jup.ag/swap/v1/quote");
    expect(synthetic.status).toBe(429);
    await expect(synthetic.json()).resolves.toEqual({
      code: 429,
      message: "[API Gateway] Too many requests",
    });
  });
});
