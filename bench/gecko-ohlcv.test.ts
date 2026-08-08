import { describe, it, expect, beforeEach } from "vitest";
import {
  parseGeckoOhlcv,
  summarizeGeckoOhlcv,
  getGeckoPoolOhlcv,
  resetGeckoOhlcvCache,
  type GeckoOhlcvBar,
} from "../engine/gecko-ohlcv-service.js";

beforeEach(() => resetGeckoOhlcvCache());
// Live-verified payload fragment (2026-08-05, pool 54Vp27uLaw4wNLo5n7r4fcC6zLamoQc28xBARjss4EUJ).
// ohlcv_list rows are [unixSeconds, open, high, low, close, volume].
const LIVE_OHLCV = {
  data: {
    id: "7e41c2b9",
    type: "ohlcv_request_response",
    attributes: {
      ohlcv_list: [
        [
          1785888000, 0.043808700040646194, 0.04391338004930444, 0.04306529366056049,
          0.0432089334915276, 1890678.0106959,
        ],
        [
          1785801600, 0.043717860331926095, 0.044177497806156624, 0.042507952190013,
          0.043808700040646194, 4053303.447853192,
        ],
        [
          1785715200, 0.04381447647326329, 0.044499417223687054, 0.0435799522462199,
          0.043717860331926095, 3105739.8974361727,
        ],
        [
          1785628800, 0.04390281345369361, 0.0443945111172234, 0.04358413202194858,
          0.04381447647326329, 2554437.233137032,
        ],
        [
          1785542400, 0.0438431320912166, 0.04432228939524769, 0.042785618516131274,
          0.04390281345369361, 3912004.941657897,
        ],
      ],
    },
  },
  meta: { base: { symbol: "ANTFUN" }, quote: { symbol: "USDT" } },
};

describe("parseGeckoOhlcv", () => {
  it("parses the live-verified payload", () => {
    const bars = parseGeckoOhlcv(LIVE_OHLCV);
    expect(bars.length).toBe(5);
    expect(bars[0]!.timestampSec).toBe(1785888000);
    expect(bars[0]!.open).toBeCloseTo(0.0438087, 6);
    expect(bars[0]!.close).toBeCloseTo(0.0432089, 6);
    expect(bars[0]!.volumeQuote).toBeCloseTo(1890678.01, 1);
  });

  it("preserves the API's newest-first row order in the parsed bars", () => {
    const bars = parseGeckoOhlcv(LIVE_OHLCV);
    // GeckoTerminal returns ohlcv_list newest-first; parsing must preserve
    // that (summarizeGeckoOhlcv normalizes to ascending internally).
    expect(bars[bars.length - 1]!.timestampSec).toBeLessThan(bars[0]!.timestampSec);
    expect(bars[bars.length - 1]!.close).toBeCloseTo(0.0439028, 6);
  });

  it("computes drawdown from the LATEST close even when input is newest-first", () => {
    // Newest bar first (timestamp 3, close 1.25); oldest last (timestamp 1).
    const newestFirst: GeckoOhlcvBar[] = [
      { timestampSec: 3, open: 1.2, high: 1.5, low: 1.1, close: 1.25, volumeQuote: 100 },
      { timestampSec: 2, open: 1.0, high: 1.6, low: 0.9, close: 1.4, volumeQuote: 100 },
      { timestampSec: 1, open: 1.0, high: 2.0, low: 0.8, close: 1.5, volumeQuote: 100 },
    ];
    const s = summarizeGeckoOhlcv(newestFirst);
    // ATH = 2.0 (all highs); latest = the NEWEST close 1.25 → drawdown = 1 - 1.25/2.
    expect(s.latestClose).toBeCloseTo(1.25, 6);
    expect(s.drawdownFromAth).toBeCloseTo(1 - 1.25 / 2, 6);
  });

  it("returns [] for malformed / empty payloads", () => {
    expect(parseGeckoOhlcv(null)).toEqual([]);
    expect(parseGeckoOhlcv({})).toEqual([]);
    expect(parseGeckoOhlcv({ data: {} })).toEqual([]);
    expect(parseGeckoOhlcv({ data: { attributes: {} } })).toEqual([]);
    expect(parseGeckoOhlcv({ data: { attributes: { ohlcv_list: "nope" } } })).toEqual([]);
    expect(parseGeckoOhlcv({ data: { attributes: { ohlcv_list: [] } } })).toEqual([]);
  });

  it("drops bars with non-positive close", () => {
    const raw = {
      data: {
        attributes: {
          ohlcv_list: [
            [1, 1, 2, 0, 0, 100],
            [2, 1, 2, 0.5, 1.5, 100],
          ],
        },
      },
    };
    const bars = parseGeckoOhlcv(raw);
    expect(bars.length).toBe(1);
    expect(bars[0]!.close).toBe(1.5);
  });
});

describe("summarizeGeckoOhlcv", () => {
  const bars: GeckoOhlcvBar[] = [
    { timestampSec: 1, open: 1, high: 2, low: 0.8, close: 1.5, volumeQuote: 100 },
    { timestampSec: 2, open: 1.5, high: 1.6, low: 1.0, close: 1.2, volumeQuote: 200 },
    { timestampSec: 3, open: 1.2, high: 1.3, low: 1.1, close: 1.25, volumeQuote: 300 },
  ];

  it("computes ATH, latest close, and drawdown", () => {
    const s = summarizeGeckoOhlcv(bars);
    expect(s.atlHigh).toBe(2);
    expect(s.latestClose).toBe(1.25);
    expect(s.drawdownFromAth).toBeCloseTo(1 - 1.25 / 2, 6);
  });

  it("computes daily-return stddev and total volume", () => {
    const s = summarizeGeckoOhlcv(bars);
    expect(s.totalVolumeQuote).toBe(600);
    expect(s.barCount).toBe(3);
    expect(s.dailyReturnStddev).toBeGreaterThan(0);
  });

  it("returns zeros for empty series", () => {
    const s = summarizeGeckoOhlcv([]);
    expect(s.atlHigh).toBe(0);
    expect(s.latestClose).toBe(0);
    expect(s.drawdownFromAth).toBe(0);
    expect(s.dailyReturnStddev).toBe(0);
    expect(s.totalVolumeQuote).toBe(0);
    expect(s.barCount).toBe(0);
  });

  it("clamps drawdown to >= 0 (never negative from a weird ATH/close)", () => {
    const s = summarizeGeckoOhlcv([
      { timestampSec: 1, open: 1, high: 1, low: 1, close: 2, volumeQuote: 1 },
    ]);
    expect(s.drawdownFromAth).toBe(0);
  });
});

describe("getGeckoPoolOhlcv", () => {
  it("returns null on HTTP error (fail-open)", async () => {
    const fetchImpl = async () => new Response("{}", { status: 404 });
    const result = await getGeckoPoolOhlcv("pool", { fetchImpl });
    expect(result).toBeNull();
  });

  it("returns null on unparseable body", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ data: {} }), { status: 200 });
    const result = await getGeckoPoolOhlcv("pool", { fetchImpl });
    expect(result).toBeNull();
  });

  it("returns derived signals on a valid payload", async () => {
    const fetchImpl = async () => new Response(JSON.stringify(LIVE_OHLCV), { status: 200 });
    const result = await getGeckoPoolOhlcv("pool", { fetchImpl });
    expect(result).not.toBeNull();
    expect(result!.barCount).toBe(5);
    expect(result!.atlHigh).toBeCloseTo(0.044499417223687054, 6);
  });

  it("hits the day?limit endpoint", async () => {
    let calledUrl = "";
    const fetchImpl = async (input: string | URL | Request) => {
      calledUrl = String(input as unknown);
      return new Response(
        JSON.stringify({ data: { attributes: { ohlcv_list: [[1, 1, 2, 0.5, 1.5, 10]] } } }),
        { status: 200 },
      );
    };
    await getGeckoPoolOhlcv("abc", { fetchImpl, baseUrl: "https://x.example/api/v2", limit: 60 });
    expect(calledUrl).toContain("/networks/solana/pools/abc/ohlcv/day?limit=60");
  });

  it("serves a fresh last-good series from cache without re-fetching", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(JSON.stringify(LIVE_OHLCV), { status: 200 });
    };
    await getGeckoPoolOhlcv("cached-pool", { fetchImpl });
    const second = await getGeckoPoolOhlcv("cached-pool", { fetchImpl });
    expect(second).not.toBeNull();
    expect(calls).toBe(1);
  });

  it("reuses the stale last-good series when a later fetch fails (#154)", async () => {
    const ok = async () => new Response(JSON.stringify(LIVE_OHLCV), { status: 200 });
    await getGeckoPoolOhlcv("stale-pool", { fetchImpl: ok });
    const failing = async () => new Response("{}", { status: 429 });
    const result = await getGeckoPoolOhlcv("stale-pool", {
      fetchImpl: failing,
      cacheTtlMs: 0, // force the cached series stale so the fetch runs
    });
    expect(result).not.toBeNull();
    expect(result!.barCount).toBe(5);
  });

  it("does not re-fetch a pool inside its backoff window", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response("{}", { status: 500 });
    };
    await getGeckoPoolOhlcv("backoff-pool", { fetchImpl });
    const second = await getGeckoPoolOhlcv("backoff-pool", { fetchImpl });
    expect(second).toBeNull();
    expect(calls).toBe(1);
  });
});
