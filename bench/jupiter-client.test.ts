import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  jupiterFetch,
  resetJupiterGateForTest,
  setJupiterGateForTest,
} from "../engine/jupiter-client.js";

function mockFetchOnce(
  impl: (url: string | URL | Request, init?: RequestInit) => Response | Promise<Response>,
): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(impl as unknown as typeof fetch);
}

function okResponse(): Response {
  return new Response(JSON.stringify({ data: [] }), { status: 200 });
}

function rateLimitedResponse(resetAtSeconds?: number): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
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
