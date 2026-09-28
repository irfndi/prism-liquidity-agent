import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JEV_DISABLED } from "../engine/jev-service.js";
import { asFetch } from "./helpers.js";
import {
  jevCacheKey,
  jevCachedVerdict,
  jevFetch,
  resetJevGateForTest,
  resetJevVerdictCacheForTest,
  jevStoreVerdict,
  setJevGateForTest,
} from "../engine/jev-gate.js";

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

describe("jev verdict cache", () => {
  beforeEach(() => {
    resetJevVerdictCacheForTest();
  });

  afterEach(() => {
    resetJevVerdictCacheForTest();
  });

  it("misses empty, hits stored, expires past TTL", () => {
    const key = jevCacheKey("poolA", "datapi", 7, 5000);
    expect(jevCachedVerdict(key, 1_000)).toBeNull();
    jevStoreVerdict(key, JEV_DISABLED, 1_000);
    expect(jevCachedVerdict(key, 1_000 + 44 * 60_000)).toBe(JEV_DISABLED);
    expect(jevCachedVerdict(key, 1_000 + 46 * 60_000)).toBeNull();
  });

  it("buckets regimes: drift/active-bin/source moves re-consult", () => {
    const base = jevCacheKey("poolA", "datapi", 7, 5000);
    expect(jevCacheKey("poolA", "datapi", 9, 5000)).toBe(base);
    expect(jevCacheKey("poolA", "datapi", 13, 5000)).not.toBe(base);
    expect(jevCacheKey("poolA", "datapi", 7, 5001)).not.toBe(base);
    expect(jevCacheKey("poolA", "geckoterminal", 7, 5000)).not.toBe(base);
    expect(jevCacheKey("poolA", "datapi", null, 5000)).not.toBe(base);
    expect(jevCacheKey("poolB", "datapi", 7, 5000)).not.toBe(base);
  });
});
