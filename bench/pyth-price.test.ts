import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  parsePythPriceUpdate,
  fetchPythPriceUsd,
  resolveFeedId,
  PYTH_FEED_IDS,
  setPythCacheTtlMsForTest,
  clearPythCacheForTest,
  type FetchLike,
} from "../engine/pyth-price-service.js";

// Hermes response shape verified against docs.pyth.network
// /api-reference/pyth-core/hermes/latest_price_updates and a live response
// (2026-07-28): parsed[].price.{price,conf,expo,publish_time}; the feed id is
// the element-level `id` (no 0x prefix in responses), NOT price.feed_id.
const NOW_MS = Date.parse("2026-07-28T00:00:00Z");
const NOW_SEC = NOW_MS / 1000;
const SOL_ID_NO_PREFIX = PYTH_FEED_IDS.SOL.slice("0x".length);

function liveResponse(priceStr: string, expo: number, publishSec: number) {
  return {
    binary: { encoding: "hex", data: ["504e4155"] },
    parsed: [
      {
        id: SOL_ID_NO_PREFIX,
        price: { price: priceStr, conf: "52057", expo, publish_time: publishSec },
        ema_price: { price: priceStr, conf: "98077", expo, publish_time: publishSec },
        metadata: {
          slot: 305084340,
          proof_available_time: publishSec + 2,
          prev_publish_time: publishSec - 1,
        },
      },
    ],
  };
}

function fetchReturning(body: unknown, status = 200): FetchLike {
  return (_url, init) => {
    lastInit = init;
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
}

function fetchRejecting(error: unknown): FetchLike {
  return () => Promise.reject(error);
}

let lastInit: RequestInit | undefined;
let lastUrl: string | undefined;

function fetchCapturing(body: unknown, status = 200): FetchLike {
  return (url, init) => {
    lastUrl = String(url as unknown);
    lastInit = init;
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
}

describe("parsePythPriceUpdate", () => {
  it("scales the integer price by 10^expo (1234567, expo -6 → 1.234567)", () => {
    const result = parsePythPriceUpdate(liveResponse("1234567", -6, NOW_SEC), 60_000, NOW_MS);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.point.priceUsd).toBeCloseTo(1.234567);
    expect(result.point.publishTimeMs).toBe(NOW_MS);
    expect(result.point.feedId).toBe(SOL_ID_NO_PREFIX);
  });

  it("decodes the live USDC/USD capture (99985012, expo -8 → 0.99985012)", () => {
    const result = parsePythPriceUpdate(liveResponse("99985012", -8, NOW_SEC), 60_000, NOW_MS);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.point.priceUsd).toBeCloseTo(0.99985012);
  });

  it("returns stale when publish_time is older than the staleness window", () => {
    const result = parsePythPriceUpdate(liveResponse("1234567", -6, NOW_SEC - 120), 60_000, NOW_MS);
    expect(result.kind).toBe("stale");
    if (result.kind !== "stale") return;
    expect(result.publishTimeMs).toBe(NOW_MS - 120_000);
  });

  it("accepts a publish_time exactly at the staleness boundary (only > is stale)", () => {
    const result = parsePythPriceUpdate(liveResponse("1234567", -6, NOW_SEC - 60), 60_000, NOW_MS);
    expect(result.kind).toBe("ok");
  });

  it.each([
    ["not an object", null],
    ["no parsed array", { parsed: [] }],
    ["parsed not an array", { parsed: {} }],
    ["entry missing price", { parsed: [{ id: "abc" }] }],
    [
      "price.price not a string",
      { parsed: [{ id: "abc", price: { price: 1234, expo: -6, publish_time: NOW_SEC } }] },
    ],
    [
      "expo not an integer",
      { parsed: [{ id: "abc", price: { price: "100", expo: -6.5, publish_time: NOW_SEC } }] },
    ],
    [
      "expo positive",
      { parsed: [{ id: "abc", price: { price: "100", expo: 2, publish_time: NOW_SEC } }] },
    ],
    [
      "non-numeric price string",
      { parsed: [{ id: "abc", price: { price: "n/a", expo: -6, publish_time: NOW_SEC } }] },
    ],
    [
      "zero price",
      { parsed: [{ id: "abc", price: { price: "0", expo: -6, publish_time: NOW_SEC } }] },
    ],
    [
      "negative price",
      { parsed: [{ id: "abc", price: { price: "-5", expo: -6, publish_time: NOW_SEC } }] },
    ],
    ["missing publish_time", { parsed: [{ id: "abc", price: { price: "100", expo: -6 } }] }],
  ])("returns malformed for %s", (_label, payload) => {
    expect(parsePythPriceUpdate(payload, 60_000, NOW_MS).kind).toBe("malformed");
  });
});

describe("fetchPythPriceUsd", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    clearPythCacheForTest();
    lastInit = undefined;
    lastUrl = undefined;
  });

  afterEach(() => {
    clearPythCacheForTest();
    setPythCacheTtlMsForTest(30_000);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns the expo-scaled USD price for a fresh 200 response", async () => {
    const price = await fetchPythPriceUsd(PYTH_FEED_IDS.SOL, {
      fetchImpl: fetchCapturing(liveResponse("1234567", -6, NOW_SEC)),
    });
    expect(price).toBeCloseTo(1.234567);
    // Docs-verified URL shape: /v2/updates/price/latest?ids[]=<feedId>&parsed=true
    expect(lastUrl).toContain("https://hermes.pyth.network/v2/updates/price/latest?");
    expect(lastUrl).toContain(`ids[]=${encodeURIComponent(PYTH_FEED_IDS.SOL)}`);
    expect(lastUrl).toContain("parsed=true");
  });

  it("honors a baseUrl override (trailing slash stripped)", async () => {
    await fetchPythPriceUsd(PYTH_FEED_IDS.SOL, {
      baseUrl: "https://hermes.example.test/",
      fetchImpl: fetchCapturing(liveResponse("1234567", -6, NOW_SEC)),
    });
    expect(lastUrl?.startsWith("https://hermes.example.test/v2/updates/price/latest?ids[]=")).toBe(
      true,
    );
  });

  it("returns null for a stale publish_time (fail-open)", async () => {
    const price = await fetchPythPriceUsd(PYTH_FEED_IDS.SOL, {
      fetchImpl: fetchReturning(liveResponse("1234567", -6, NOW_SEC - 120)),
    });
    expect(price).toBeNull();
  });

  it.each([404, 429, 500, 503])("returns null on HTTP %i (fail-open, no throw)", async (status) => {
    const price = await fetchPythPriceUsd(PYTH_FEED_IDS.SOL, {
      fetchImpl: fetchReturning({ error: "nope" }, status),
    });
    expect(price).toBeNull();
  });

  it("returns null on timeout / network rejection (fail-open, no throw)", async () => {
    const price = await fetchPythPriceUsd(PYTH_FEED_IDS.SOL, {
      fetchImpl: fetchRejecting(new Error("The operation was aborted due to timeout")),
    });
    expect(price).toBeNull();
  });

  it("returns null when the body is valid JSON but not a price payload", async () => {
    const price = await fetchPythPriceUsd(PYTH_FEED_IDS.SOL, {
      fetchImpl: fetchReturning({ unexpected: true }),
    });
    expect(price).toBeNull();
  });

  it("returns null when the body is not JSON at all", async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve(new Response("<html>bad gateway</html>", { status: 200 }));
    const price = await fetchPythPriceUsd(PYTH_FEED_IDS.SOL, { fetchImpl });
    expect(price).toBeNull();
  });

  it("sends the API key as an Authorization: Bearer header when set", async () => {
    await fetchPythPriceUsd(PYTH_FEED_IDS.SOL, {
      apiKey: "test-pyth-key",
      fetchImpl: fetchCapturing(liveResponse("1234567", -6, NOW_SEC)),
    });
    const headers = (lastInit?.headers ?? {}) as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-pyth-key");
  });

  it("sends no Authorization header when the key is unset or blank", async () => {
    await fetchPythPriceUsd(PYTH_FEED_IDS.SOL, {
      fetchImpl: fetchCapturing(liveResponse("1234567", -6, NOW_SEC)),
    });
    let headers = (lastInit?.headers ?? {}) as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();

    await fetchPythPriceUsd(PYTH_FEED_IDS.USDC, {
      apiKey: "   ",
      fetchImpl: fetchCapturing(liveResponse("99985012", -8, NOW_SEC)),
    });
    headers = (lastInit?.headers ?? {}) as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("does not cache failures (a failed fetch retries next call)", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "500" }), { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(liveResponse("1234567", -6, NOW_SEC)), { status: 200 }),
      );
    expect(await fetchPythPriceUsd(PYTH_FEED_IDS.SOL, { fetchImpl })).toBeNull();
    expect(await fetchPythPriceUsd(PYTH_FEED_IDS.SOL, { fetchImpl })).toBeCloseTo(1.234567);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("fetchPythPriceUsd response cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    clearPythCacheForTest();
  });

  afterEach(() => {
    clearPythCacheForTest();
    setPythCacheTtlMsForTest(30_000);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("serves a second call within the TTL from cache (no refetch)", async () => {
    const fetchImpl = vi.fn<FetchLike>(() =>
      Promise.resolve(
        new Response(JSON.stringify(liveResponse("1234567", -6, NOW_SEC)), { status: 200 }),
      ),
    );
    const first = await fetchPythPriceUsd(PYTH_FEED_IDS.SOL, { fetchImpl });
    vi.advanceTimersByTime(10_000);
    const second = await fetchPythPriceUsd(PYTH_FEED_IDS.SOL, { fetchImpl });
    expect(first).toBeCloseTo(1.234567);
    expect(second).toBeCloseTo(1.234567);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refetches once the TTL elapses", async () => {
    const fetchImpl = vi.fn<FetchLike>(() =>
      Promise.resolve(
        new Response(JSON.stringify(liveResponse("1234567", -6, NOW_SEC)), { status: 200 }),
      ),
    );
    await fetchPythPriceUsd(PYTH_FEED_IDS.SOL, { fetchImpl });
    vi.advanceTimersByTime(31_000);
    await fetchPythPriceUsd(PYTH_FEED_IDS.SOL, {
      fetchImpl,
      maxStalenessMs: Number.MAX_SAFE_INTEGER,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("caches per feed (two feeds → two fetches)", async () => {
    const fetchImpl = vi.fn<FetchLike>(() =>
      Promise.resolve(
        new Response(JSON.stringify(liveResponse("1234567", -6, NOW_SEC)), { status: 200 }),
      ),
    );
    await fetchPythPriceUsd(PYTH_FEED_IDS.SOL, { fetchImpl });
    await fetchPythPriceUsd(PYTH_FEED_IDS.USDC, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("symbol → feed ID map", () => {
  it("resolves SOL, USDC, USDT to the docs-verified mainnet feed IDs", () => {
    expect(PYTH_FEED_IDS.SOL).toBe(
      "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    );
    expect(PYTH_FEED_IDS.USDC).toBe(
      "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
    );
    expect(PYTH_FEED_IDS.USDT).toBe(
      "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
    );
  });

  it("resolveFeedId is case-insensitive and trims input", () => {
    expect(resolveFeedId("SOL")).toBe(PYTH_FEED_IDS.SOL);
    expect(resolveFeedId(" sol ")).toBe(PYTH_FEED_IDS.SOL);
    expect(resolveFeedId("usdc")).toBe(PYTH_FEED_IDS.USDC);
  });

  it("resolveFeedId returns null for unknown symbols", () => {
    expect(resolveFeedId("DOGE")).toBeNull();
    expect(resolveFeedId("")).toBeNull();
  });
});
