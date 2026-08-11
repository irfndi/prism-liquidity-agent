import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  parseDexscreenerPoolStats,
  getDexscreenerPoolStats,
  setDexscreenerRequestIntervalMsForTest,
  type FetchLike,
} from "../engine/dexscreener-service.js";
import { enrichPoolFromGecko } from "../engine/gecko-terminal-service.js";
import { makePool } from "./helpers.js";

// Live-probed shape (XST/SOL Meteora DLMM pool, DexScreener keyless, 2026-08-11):
// `pairs` is an array; volume.h24 and liquidity.usd are NUMBERS; priceUsd is a
// STRING; there is NO fees field of any kind.
const LIVE_RESPONSE = {
  schemaVersion: "1.0.0",
  pairs: [
    {
      chainId: "solana",
      dexId: "meteora",
      pairAddress: "FXc1BVyNDmqwSKbYD8JwMGq5uqsUov4BCjqnATAeyARk",
      labels: ["DLMM"],
      baseToken: { address: "XSTuo1fV7HHMhs4BYiwtrWSLsMCJNrooH2AssWTYZqP", symbol: "XST" },
      quoteToken: { address: "So11111111111111111111111111111111111111112", symbol: "SOL" },
      priceUsd: "0.05429",
      volume: { h24: 4204820.6, h6: 1587627.93 },
      liquidity: { usd: 52747.44, base: 42261, quote: 665.6066 },
    },
  ],
};

const BASE_FEE_RATE = 0.003;

/** A 200 with `pairs: null` is how DexScreener reports an unknown pair. */
const NOT_FOUND_RESPONSE = { schemaVersion: "1.0.0", pairs: null, pair: null };

function fetchReturning(body: unknown, status = 200): FetchLike {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status }));
}

function fetchRejecting(error: unknown): FetchLike {
  return () => Promise.reject(error);
}

describe("parseDexscreenerPoolStats", () => {
  it("parses the live shape: real volume + liquidity; fees = volume × baseFeeRate (no fee field)", () => {
    const stats = parseDexscreenerPoolStats(LIVE_RESPONSE, BASE_FEE_RATE);
    expect(stats).not.toBeNull();
    expect(stats!.volume24hUsd).toBeCloseTo(4_204_820.6);
    expect(stats!.tvlUsd).toBeCloseTo(52_747.44);
    // DexScreener has NO fee field → the binStep-derived baseFeeRate always
    // prices the REAL volume into fees.
    expect(stats!.fees24hUsd).toBeCloseTo(4_204_820.6 * BASE_FEE_RATE);
    expect(stats!.basePriceUsd).toBeCloseTo(0.05429);
  });

  it("returns null when pairs is null (the live not-found shape)", () => {
    expect(parseDexscreenerPoolStats(NOT_FOUND_RESPONSE, BASE_FEE_RATE)).toBeNull();
  });

  it("returns null when the payload is not a usable pool object", () => {
    expect(parseDexscreenerPoolStats(null, BASE_FEE_RATE)).toBeNull();
    expect(parseDexscreenerPoolStats({ unexpected: true }, BASE_FEE_RATE)).toBeNull();
    expect(parseDexscreenerPoolStats({ pairs: [] }, BASE_FEE_RATE)).toBeNull();
  });

  it("returns null when 24h volume is missing or non-numeric", () => {
    const noVolume = { pairs: [{ liquidity: { usd: 5000000 } }] };
    const badVolume = { pairs: [{ volume: { h24: "n/a" }, liquidity: { usd: 5000000 } }] };
    expect(parseDexscreenerPoolStats(noVolume, BASE_FEE_RATE)).toBeNull();
    expect(parseDexscreenerPoolStats(badVolume, BASE_FEE_RATE)).toBeNull();
  });

  it("returns null for non-positive 24h volume (malformed data must not be marked measured)", () => {
    const zeroVol = { pairs: [{ volume: { h24: 0 }, liquidity: { usd: 5000000 } }] };
    const negativeVol = { pairs: [{ volume: { h24: -123.45 }, liquidity: { usd: 5000000 } }] };
    expect(parseDexscreenerPoolStats(zeroVol, BASE_FEE_RATE)).toBeNull();
    expect(parseDexscreenerPoolStats(negativeVol, BASE_FEE_RATE)).toBeNull();
  });

  it("reports null tvl (not a failure) when liquidity is missing", () => {
    const noLiquidity = { pairs: [{ volume: { h24: 1000000 } }] };
    const stats = parseDexscreenerPoolStats(noLiquidity, BASE_FEE_RATE);
    expect(stats).not.toBeNull();
    expect(stats!.tvlUsd).toBeNull();
    expect(stats!.volume24hUsd).toBeCloseTo(1_000_000);
  });

  it("nulls tvl for a ZERO liquidity with positive volume (dead/wash data must not be measured)", () => {
    const zeroLiq = { pairs: [{ volume: { h24: 23551730.42 }, liquidity: { usd: 0 } }] };
    const stats = parseDexscreenerPoolStats(zeroLiq, BASE_FEE_RATE);
    expect(stats).not.toBeNull();
    expect(stats!.tvlUsd).toBeNull();
  });

  it("accepts the smallest strictly-positive liquidity (boundary: > 0 is usable)", () => {
    const tinyLiq = { pairs: [{ volume: { h24: 1000000 }, liquidity: { usd: 0.000001 } }] };
    const stats = parseDexscreenerPoolStats(tinyLiq, BASE_FEE_RATE);
    expect(stats).not.toBeNull();
    expect(stats!.tvlUsd).toBeCloseTo(0.000001);
  });
});

describe("getDexscreenerPoolStats", () => {
  beforeEach(() => {
    setDexscreenerRequestIntervalMsForTest(0);
  });

  afterEach(() => {
    setDexscreenerRequestIntervalMsForTest(120);
    vi.restoreAllMocks();
  });

  it("returns parsed stats for a 200 response", async () => {
    const stats = await getDexscreenerPoolStats("FXc1BVyN", {
      baseFeeRate: BASE_FEE_RATE,
      fetchImpl: fetchReturning(LIVE_RESPONSE),
    });
    expect(stats).not.toBeNull();
    expect(stats!.volume24hUsd).toBeCloseTo(4_204_820.6);
    expect(stats!.tvlUsd).toBeCloseTo(52_747.44);
  });

  it("returns null when the pool is unknown (200 with pairs:null)", async () => {
    const stats = await getDexscreenerPoolStats("UnknownPool", {
      baseFeeRate: BASE_FEE_RATE,
      fetchImpl: fetchReturning(NOT_FOUND_RESPONSE),
    });
    expect(stats).toBeNull();
  });

  it.each([429, 500, 503])("returns null on HTTP %i (fail-through)", async (status) => {
    const stats = await getDexscreenerPoolStats("SomePool", {
      baseFeeRate: BASE_FEE_RATE,
      fetchImpl: fetchReturning({}, status),
    });
    expect(stats).toBeNull();
  });

  it("returns null on timeout / network rejection (fail-through, no throw)", async () => {
    const stats = await getDexscreenerPoolStats("SomePool", {
      baseFeeRate: BASE_FEE_RATE,
      fetchImpl: fetchRejecting(new Error("The operation was aborted due to timeout")),
    });
    expect(stats).toBeNull();
  });

  it("returns null when the pool has no usable liquidity (treat as unavailable)", async () => {
    const noLiquidity = { pairs: [{ volume: { h24: 1000000 } }] };
    const stats = await getDexscreenerPoolStats("SomePool", {
      baseFeeRate: BASE_FEE_RATE,
      fetchImpl: fetchReturning(noLiquidity),
    });
    expect(stats).toBeNull();
  });

  it("honors a baseUrl override for the constructed pool path", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(LIVE_RESPONSE), { status: 200 })),
    );
    await getDexscreenerPoolStats("PoolXYZ", {
      baseFeeRate: BASE_FEE_RATE,
      baseUrl: "https://dexscreener.example.test/latest/dex/",
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://dexscreener.example.test/latest/dex/pairs/solana/PoolXYZ",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

describe("getDexscreenerPoolStats request pacing", () => {
  it("waits until the minimum inter-request interval elapses between fetches", async () => {
    setDexscreenerRequestIntervalMsForTest(80);
    try {
      const fetchTimes: number[] = [];
      const fetchImpl: FetchLike = () => {
        fetchTimes.push(Date.now());
        return Promise.resolve(new Response(JSON.stringify(LIVE_RESPONSE), { status: 200 }));
      };
      await getDexscreenerPoolStats("PoolA", { baseFeeRate: BASE_FEE_RATE, fetchImpl });
      await getDexscreenerPoolStats("PoolB", { baseFeeRate: BASE_FEE_RATE, fetchImpl });
      const elapsedMs = fetchTimes[1]! - fetchTimes[0]!;
      expect(
        elapsedMs,
        "the second request must wait out the paced interval",
      ).toBeGreaterThanOrEqual(70);
    } finally {
      setDexscreenerRequestIntervalMsForTest(120);
    }
  });
});

describe("DexScreener enrich path (delegates to enrichPoolFromGecko)", () => {
  it("replaces heuristic tvl/volume/fees, tags geckoterminal, nulls farm signals", () => {
    const pool = makePool({ tvlUsd: 50_000, volume24hUsd: 15_000, fees24hUsd: 150, hasFarm: true });
    const enriched = enrichPoolFromGecko(pool, {
      tvlUsd: 52_747.44,
      volume24hUsd: 4_204_820.6,
      fees24hUsd: 4_204_820.6 * BASE_FEE_RATE,
      basePriceUsd: 0.05429,
      quotePriceUsd: null,
    });
    expect(enriched.tvlUsd).toBeCloseTo(52_747.44);
    expect(enriched.volume24hUsd).toBeCloseTo(4_204_820.6);
    expect(enriched.fees24hUsd).toBeCloseTo(4_204_820.6 * BASE_FEE_RATE);
    // DexScreener enriches through the gecko trust path → statsSource is
    // "geckoterminal" (measured volume/TVL, modeled fees, no safety signals).
    expect(enriched.statsSource).toBe("geckoterminal");
    expect(enriched.hasFarm).toBeNull();
    expect(enriched.farmAprPct).toBeNull();
    expect(enriched.activeBinId).toBe(pool.activeBinId);
  });
});
