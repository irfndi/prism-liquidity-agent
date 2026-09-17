import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jevFetch, resetJevGateForTest, setJevGateForTest } from "../engine/jev-gate.js";
import { asFetch } from "./helpers.js";

function mockFetchOnce(
  impl: (url: string | URL | Request, init?: RequestInit) => Response | Promise<Response>,
): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(asFetch(impl));
}

function okResponse(): Response {
  return new Response(JSON.stringify({ model: "jev-1.13.0", answers: {} }), { status: 200 });
}

function rateLimitedResponse(): Response {
  return new Response(JSON.stringify({ code: 429, message: "Too many requests" }), {
    status: 429,
    headers: { "Content-Type": "application/json" },
  });
}

describe("jevFetch traffic gate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetJevGateForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetJevGateForTest();
  });

  it("passes traffic through when idle", async () => {
    setJevGateForTest({ intervalMs: 0 });
    let fetchCount = 0;
    mockFetchOnce(() => {
      fetchCount += 1;
      return okResponse();
    });
    const res = await jevFetch("https://api.typesafe.ai/v1/systemone", { method: "POST" });
    expect(res.status).toBe(200);
    expect(fetchCount).toBe(1);
  });

  it("paces requests to the configured interval", async () => {
    setJevGateForTest({ intervalMs: 50 });
    let fetchCount = 0;
    mockFetchOnce(() => {
      fetchCount += 1;
      return okResponse();
    });

    const first = jevFetch("https://api.typesafe.ai/v1/systemone", { method: "POST" });
    await vi.advanceTimersByTimeAsync(0);
    await first;

    const second = jevFetch("https://api.typesafe.ai/v1/systemone", { method: "POST" });
    await vi.advanceTimersByTimeAsync(25);
    expect(fetchCount).toBe(1);
    await vi.advanceTimersByTimeAsync(25);
    await second;
    expect(fetchCount).toBe(2);
  });

  it("fails fast with a synthetic 429 while the breaker cooldown is open", async () => {
    setJevGateForTest({ intervalMs: 0, baseCooldownMs: 60_000 });
    let fetchCount = 0;
    mockFetchOnce(() => {
      fetchCount += 1;
      return rateLimitedResponse();
    });

    const first = await jevFetch("https://api.typesafe.ai/v1/systemone", { method: "POST" });
    expect(first.status).toBe(429);
    expect(fetchCount).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    const second = await jevFetch("https://api.typesafe.ai/v1/systemone", { method: "POST" });
    expect(second.status).toBe(429);
    expect(fetchCount).toBe(1);
  });
});
