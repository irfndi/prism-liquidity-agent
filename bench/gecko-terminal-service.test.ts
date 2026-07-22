import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  parseGeckoPoolStats,
  enrichPoolFromGecko,
  getGeckoPoolStats,
  setGeckoRequestIntervalMsForTest,
  type FetchLike,
} from "../engine/gecko-terminal-service.js";
import { makePool } from "./helpers.js";

// Live-probed shape (pool 5rCf1DM8…, GeckoTerminal, 2026-07-22): numeric fields
// arrive as decimal STRINGS and pool_fee_percentage is null for CL pools.
const LIVE_RESPONSE = {
  data: {
    id: "solana_5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6",
    type: "pool",
    attributes: {
      base_token_price_usd: "77.597230959542796772209534429859017020595617284",
      quote_token_price_usd: "1.00166858397201897729759463448169660137218581327066171017749108",
      address: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6",
      name: "SOL / USDC",
      pool_fee_percentage: null,
      volume_usd: {
        h24: "23551730.4205602",
        h6: "5510857.90179431",
      },
      reserve_in_usd: "4947464.8465",
    },
  },
};

const BASE_FEE_RATE = 0.003;

function fetchReturning(body: unknown, status = 200): FetchLike {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status }));
}

function fetchRejecting(error: unknown): FetchLike {
  return () => Promise.reject(error);
}

describe("parseGeckoPoolStats", () => {
  it("parses the live shape: real volume + reserve; fees = volume × baseFeeRate when pool_fee_percentage is null", () => {
    const stats = parseGeckoPoolStats(LIVE_RESPONSE, BASE_FEE_RATE);
    expect(stats).not.toBeNull();
    expect(stats!.volume24hUsd).toBeCloseTo(23_551_730.4205602);
    expect(stats!.tvlUsd).toBeCloseTo(4_947_464.8465);
    // pool_fee_percentage is null (live-confirmed for every CL pool) → the
    // binStep-derived baseFeeRate prices the REAL volume into fees.
    expect(stats!.fees24hUsd).toBeCloseTo(23_551_730.4205602 * BASE_FEE_RATE);
    expect(stats!.basePriceUsd).toBeCloseTo(77.5972309595428);
    expect(stats!.quotePriceUsd).toBeCloseTo(1.001668583972019);
  });

  it("uses GeckoTerminal's own pool_fee_percentage (a percentage) when populated, ahead of baseFeeRate", () => {
    const withFee = {
      data: {
        attributes: {
          volume_usd: { h24: "1000000" },
          reserve_in_usd: "5000000",
          // 0.25 means 0.25% → fraction 0.0025, NOT the 0.003 baseFeeRate.
          pool_fee_percentage: 0.25,
        },
      },
    };
    const stats = parseGeckoPoolStats(withFee, BASE_FEE_RATE);
    expect(stats).not.toBeNull();
    expect(stats!.fees24hUsd).toBeCloseTo(1_000_000 * 0.0025);
  });

  it("returns null when the payload is not a usable pool object", () => {
    expect(parseGeckoPoolStats(null, BASE_FEE_RATE)).toBeNull();
    expect(parseGeckoPoolStats({ unexpected: true }, BASE_FEE_RATE)).toBeNull();
    expect(parseGeckoPoolStats({ data: { attributes: {} } }, BASE_FEE_RATE)).toBeNull();
  });

  it("returns null when 24h volume is missing or non-numeric", () => {
    const noVolume = { data: { attributes: { reserve_in_usd: "5000000" } } };
    const badVolume = {
      data: { attributes: { volume_usd: { h24: "n/a" }, reserve_in_usd: "5000000" } },
    };
    expect(parseGeckoPoolStats(noVolume, BASE_FEE_RATE)).toBeNull();
    expect(parseGeckoPoolStats(badVolume, BASE_FEE_RATE)).toBeNull();
  });

  it("returns null for non-positive 24h volume (malformed data must not be marked measured)", () => {
    const zeroVol = {
      data: { attributes: { volume_usd: { h24: "0" }, reserve_in_usd: "5000000" } },
    };
    const negativeVol = {
      data: { attributes: { volume_usd: { h24: "-123.45" }, reserve_in_usd: "5000000" } },
    };
    expect(parseGeckoPoolStats(zeroVol, BASE_FEE_RATE)).toBeNull();
    expect(parseGeckoPoolStats(negativeVol, BASE_FEE_RATE)).toBeNull();
  });

  it("reports null tvl (not a failure) when the reserve is missing", () => {
    const noReserve = { data: { attributes: { volume_usd: { h24: "1000000" } } } };
    const stats = parseGeckoPoolStats(noReserve, BASE_FEE_RATE);
    expect(stats).not.toBeNull();
    expect(stats!.tvlUsd).toBeNull();
    expect(stats!.volume24hUsd).toBeCloseTo(1_000_000);
  });

  it("nulls tvl for a negative reserve (malformed) so the caller rejects the stats", () => {
    const negativeReserve = {
      data: { attributes: { volume_usd: { h24: "1000000" }, reserve_in_usd: "-42.5" } },
    };
    const stats = parseGeckoPoolStats(negativeReserve, BASE_FEE_RATE);
    // Parsed (volume is usable) but tvlUsd nulled — getGeckoPoolStats then
    // returns null for a null tvl, rejecting the stats entirely.
    expect(stats).not.toBeNull();
    expect(stats!.tvlUsd).toBeNull();
  });
});

describe("getGeckoPoolStats", () => {
  // The production pacing (2.1s/request toward the 30 req/min limit) would
  // stall these fast unit tests; disable it per test and restore the
  // production default afterwards.
  beforeEach(() => {
    setGeckoRequestIntervalMsForTest(0);
  });

  afterEach(() => {
    setGeckoRequestIntervalMsForTest(2_100);
    vi.restoreAllMocks();
  });

  it("returns parsed stats for a 200 response", async () => {
    const stats = await getGeckoPoolStats("5rCf1DM8", {
      baseFeeRate: BASE_FEE_RATE,
      fetchImpl: fetchReturning(LIVE_RESPONSE),
    });
    expect(stats).not.toBeNull();
    expect(stats!.volume24hUsd).toBeCloseTo(23_551_730.4205602);
    expect(stats!.tvlUsd).toBeCloseTo(4_947_464.8465);
  });

  it.each([404, 429, 500, 503])("returns null on HTTP %i (fail-through)", async (status) => {
    const stats = await getGeckoPoolStats("SomePool", {
      baseFeeRate: BASE_FEE_RATE,
      fetchImpl: fetchReturning(
        { errors: [{ status: String(status), title: "Not Found" }] },
        status,
      ),
    });
    expect(stats).toBeNull();
  });

  it("returns null on timeout / network rejection (fail-through, no throw)", async () => {
    const stats = await getGeckoPoolStats("SomePool", {
      baseFeeRate: BASE_FEE_RATE,
      fetchImpl: fetchRejecting(new Error("The operation was aborted due to timeout")),
    });
    expect(stats).toBeNull();
  });

  it("returns null when the body cannot be parsed as pool stats", async () => {
    const stats = await getGeckoPoolStats("SomePool", {
      baseFeeRate: BASE_FEE_RATE,
      fetchImpl: fetchReturning({ unexpected: true }),
    });
    expect(stats).toBeNull();
  });

  it("returns null when the pool has no usable reserve (treat as unavailable)", async () => {
    const noReserve = { data: { attributes: { volume_usd: { h24: "1000000" } } } };
    const stats = await getGeckoPoolStats("SomePool", {
      baseFeeRate: BASE_FEE_RATE,
      fetchImpl: fetchReturning(noReserve),
    });
    expect(stats).toBeNull();
  });

  it("honors a baseUrl override for the constructed pool path", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(LIVE_RESPONSE), { status: 200 })),
    );
    await getGeckoPoolStats("PoolXYZ", {
      baseFeeRate: BASE_FEE_RATE,
      baseUrl: "https://gecko.example.test/api/v2/",
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://gecko.example.test/api/v2/networks/solana/pools/PoolXYZ",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns null when the pool reports a negative reserve (malformed → unavailable)", async () => {
    const negativeReserve = {
      data: { attributes: { volume_usd: { h24: "1000000" }, reserve_in_usd: "-42.5" } },
    };
    const stats = await getGeckoPoolStats("SomePool", {
      baseFeeRate: BASE_FEE_RATE,
      fetchImpl: fetchReturning(negativeReserve),
    });
    expect(stats).toBeNull();
  });
});

describe("getGeckoPoolStats request pacing", () => {
  it("waits until the minimum inter-request interval elapses between fetches", async () => {
    setGeckoRequestIntervalMsForTest(80);
    try {
      const fetchTimes: number[] = [];
      const fetchImpl: FetchLike = () => {
        fetchTimes.push(Date.now());
        return Promise.resolve(new Response(JSON.stringify(LIVE_RESPONSE), { status: 200 }));
      };
      await getGeckoPoolStats("PoolA", { baseFeeRate: BASE_FEE_RATE, fetchImpl });
      await getGeckoPoolStats("PoolB", { baseFeeRate: BASE_FEE_RATE, fetchImpl });
      const elapsedMs = fetchTimes[1]! - fetchTimes[0]!;
      expect(
        elapsedMs,
        "the second request must wait out the paced interval",
      ).toBeGreaterThanOrEqual(70);
    } finally {
      setGeckoRequestIntervalMsForTest(2_100);
    }
  });
});

describe("enrichPoolFromGecko", () => {
  it("replaces heuristic tvl/volume/fees with gecko values, tags geckoterminal, nulls farm signals", () => {
    const pool = makePool({ tvlUsd: 50_000, volume24hUsd: 15_000, fees24hUsd: 150, hasFarm: true });
    const enriched = enrichPoolFromGecko(pool, {
      tvlUsd: 4_947_464.8465,
      volume24hUsd: 23_551_730.4205602,
      fees24hUsd: 23_551_730.4205602 * BASE_FEE_RATE,
      basePriceUsd: 77.59,
      quotePriceUsd: 1.0,
    });
    expect(enriched.tvlUsd).toBeCloseTo(4_947_464.8465);
    expect(enriched.volume24hUsd).toBeCloseTo(23_551_730.4205602);
    expect(enriched.fees24hUsd).toBeCloseTo(23_551_730.4205602 * BASE_FEE_RATE);
    expect(enriched.statsSource).toBe("geckoterminal");
    // Data-API-exclusive signals are never sourced from gecko.
    expect(enriched.hasFarm).toBeNull();
    expect(enriched.farmAprPct).toBeNull();
    // On-chain identity fields are preserved.
    expect(enriched.activeBinId).toBe(pool.activeBinId);
    expect(enriched.currentPrice).toBe(pool.currentPrice);
    // APR is recomputed (annualized) from real fees/TVL.
    expect(enriched.apr).toBeCloseTo(
      ((23_551_730.4205602 * BASE_FEE_RATE * 365) / 4_947_464.8465) * 100,
    );
  });
});
