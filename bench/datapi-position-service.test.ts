import { describe, it, expect, vi, afterEach } from "vitest";
import { Effect } from "effect";
import {
  fetchOpenPortfolio,
  effectGetOpenPositions,
  PositionCrawlCache,
  parseOpenPortfolio,
  parseOpenPosition,
} from "../engine/datapi-position-service.js";

// A real-ish /portfolio/open payload. The `pools` array holds the position
// objects; a subset of fields mirror the live Data API snake_case keys
// (position_id, pool, token_x, token_y, lower_bin_id, ...) while some use the
// camelCase variants to prove the defensive key probing.
const SAMPLE_POOL_FIXTURE = {
  page: 1,
  pageSize: 100,
  hasNext: false,
  totalCount: 2,
  totalPositions: 2,
  pools: [
    {
      position_id: "Bqhq7H7MdU7MBvFMKQHmCQMUc6pKvN8W6s8k7xFp3jCj",
      pool: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6",
      token_x: { address: "So11111111111111111111111111111111111111112" },
      token_y: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
      lower_bin_id: 1050,
      upper_bin_id: 1100,
      active_bin_id: 1075,
      deposited_usd: 1250.5,
      value_usd: 1320.25,
      pnl_usd: 69.75,
      created_at: 1750000000000,
    },
    {
      positionId: "kAJ1wR3QAvb4RsVjS8oVoFjDGTc679wJYmUmknUF5HwM",
      poolAddress: "9DTp6uAqfkPmgBTSfb4kCVTjjHzzmPoJLY9VND6tVLVW",
      lowerBin: 2048,
      upperBin: 3072,
      currentBin: 2560,
    },
  ],
};

describe("parseOpenPortfolio", () => {
  it("parses a real-ish /portfolio/open payload into OpenPosition[]", () => {
    const positions = parseOpenPortfolio(SAMPLE_POOL_FIXTURE);
    expect(positions).toHaveLength(2);

    const first = positions[0]!;
    expect(first.poolAddress).toBe("5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6");
    expect(first.positionId).toBe("Bqhq7H7MdU7MBvFMKQHmCQMUc6pKvN8W6s8k7xFp3jCj");
    expect(first.tokenX).toBe("So11111111111111111111111111111111111111112");
    expect(first.tokenY).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(first.lowerBin).toBe(1050);
    expect(first.upperBin).toBe(1100);
    expect(first.currentBin).toBe(1075);
    expect(first.depositedUsd).toBeCloseTo(1250.5);
    expect(first.valueUsd).toBeCloseTo(1320.25);
    expect(first.pnlUsd).toBeCloseTo(69.75);
    expect(first.createdAt).toBe(1750000000000);

    // camelCase variant is also mapped
    const second = positions[1]!;
    expect(second.poolAddress).toBe("9DTp6uAqfkPmgBTSfb4kCVTjjHzzmPoJLY9VND6tVLVW");
    expect(second.positionId).toBe("kAJ1wR3QAvb4RsVjS8oVoFjDGTc679wJYmUmknUF5HwM");
    expect(second.currentBin).toBe(2560);
  });

  it("tolerates unknown/missing fields without throwing", () => {
    // No pools key (e.g. the API's validation-error envelope or a schema change)
    expect(parseOpenPortfolio({ message: "user: Validation error: invalid_pubkey" })).toEqual([]);
    expect(parseOpenPortfolio(null)).toEqual([]);
    expect(parseOpenPortfolio({ pools: "not-an-array" })).toEqual([]);
    // A position missing identity fields is dropped, not thrown
    expect(parseOpenPortfolio({ pools: [{ value_usd: 5 }] })).toEqual([]);
  });

  it("drops a position that lacks a usable identity pair", () => {
    expect(parseOpenPosition({ pool: "PoolABC", lower_bin_id: 1, upper_bin_id: 2 })).toBeNull();
  });
});

describe("fetchOpenPortfolio", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses a 200 response into OpenPosition[] via injected fetchImpl", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(SAMPLE_POOL_FIXTURE), { status: 200 })),
    );
    const positions = await fetchOpenPortfolio(
      "https://dlmm.datapi.meteora.ag",
      "walletABC",
      fetchImpl as never,
    );
    expect(positions).toHaveLength(2);
    expect(positions[0]!.poolAddress).toBe("5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6");
    // Correct query param: `user=` (not `wallet=`), the API rejects wallet= with 400
    const calledUrl = String((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(calledUrl).toContain("/portfolio/open");
    expect(calledUrl).toContain("user=walletABC");
    expect(calledUrl).toContain("page=1");
  });

  it("fails open (returns []) on network error", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    const positions = await fetchOpenPortfolio(
      "https://dlmm.datapi.meteora.ag",
      "walletABC",
      fetchImpl as never,
    );
    expect(positions).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("fails open (returns []) on non-OK HTTP status", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("server error", { status: 500 })));
    const positions = await fetchOpenPortfolio(
      "https://dlmm.datapi.meteora.ag",
      "walletABC",
      fetchImpl as never,
    );
    expect(positions).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("fails open (returns []) on malformed JSON", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("{not json", { status: 200 })));
    const positions = await fetchOpenPortfolio(
      "https://dlmm.datapi.meteora.ag",
      "walletABC",
      fetchImpl as never,
    );
    expect(positions).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe("PositionCrawlCache", () => {
  it("returns cached value within TTL without re-fetch", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(SAMPLE_POOL_FIXTURE), { status: 200 })),
    );
    const cache = new PositionCrawlCache(60_000);

    const first = await Effect.runPromise(
      effectGetOpenPositions(
        "https://dlmm.datapi.meteora.ag",
        "walletABC",
        cache,
        fetchImpl as never,
      ),
    );
    const second = await Effect.runPromise(
      effectGetOpenPositions(
        "https://dlmm.datapi.meteora.ag",
        "walletABC",
        cache,
        fetchImpl as never,
      ),
    );

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // only the first read hits the network
  });

  it("expires entries after TTL and re-fetches", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(SAMPLE_POOL_FIXTURE), { status: 200 })),
    );
    const cache = new PositionCrawlCache(60_000);

    await Effect.runPromise(
      effectGetOpenPositions(
        "https://dlmm.datapi.meteora.ag",
        "walletABC",
        cache,
        fetchImpl as never,
      ),
    );
    const expired = cache.get("walletABC", Date.now() + 61_000);
    expect(expired).toBeUndefined();
    await Effect.runPromise(
      effectGetOpenPositions(
        "https://dlmm.datapi.meteora.ag",
        "walletABC",
        cache,
        fetchImpl as never,
      ),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed fetch", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    const cache = new PositionCrawlCache(60_000);

    const first = await Effect.runPromise(
      effectGetOpenPositions(
        "https://dlmm.datapi.meteora.ag",
        "walletABC",
        cache,
        fetchImpl as never,
      ),
    );
    const second = await Effect.runPromise(
      effectGetOpenPositions(
        "https://dlmm.datapi.meteora.ag",
        "walletABC",
        cache,
        fetchImpl as never,
      ),
    );
    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // every read retries
    expect(cache.get("walletABC")).toBeUndefined();
  });
});
