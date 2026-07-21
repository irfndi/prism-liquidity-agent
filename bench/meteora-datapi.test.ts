import { describe, it, expect, vi, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import { MeteoraDatapiLive, enrichPoolWithDatapi } from "../engine/meteora-datapi-service.js";
import { MeteoraDatapiService } from "../engine/services.js";
import { ConfigService } from "../engine/config-service.js";
import { defaultAppConfig, makePool, mockFetch } from "./helpers.js";

const SAMPLE_POOL_RESPONSE = {
  address: "PoolABC111",
  name: "SOL-USDC",
  token_x: {
    address: "So11111111111111111111111111111111111111112",
    symbol: "SOL",
    freeze_authority_disabled: true,
    is_verified: false,
  },
  token_y: {
    address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    symbol: "USDC",
    freeze_authority_disabled: false,
    is_verified: true,
  },
  pool_config: { bin_step: 10, base_fee_pct: 0.2, max_fee_pct: 0, protocol_fee_pct: 5 },
  dynamic_fee_pct: 0.05,
  tvl: 1_234_567.89,
  current_price: 151.25,
  apr: 0.0042,
  apy: 4.63,
  has_farm: true,
  farm_apr: 0,
  farm_apy: 0,
  volume: { "30m": 10, "1h": 20, "2h": 40, "4h": 80, "12h": 200, "24h": 456_789.12 },
  fees: { "30m": 1, "1h": 2, "2h": 4, "4h": 8, "12h": 20, "24h": 1_234.56 },
  fee_tvl_ratio: {
    "30m": 0.0001,
    "1h": 0.0002,
    "2h": 0.0004,
    "4h": 0.0008,
    "12h": 0.002,
    "24h": 0.001,
  },
  is_blacklisted: false,
  launchpad: "",
  tags: [],
};

function makeLayer() {
  return Layer.provide(MeteoraDatapiLive, Layer.succeed(ConfigService, defaultAppConfig()));
}

describe("MeteoraDatapiService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses a pool response into typed stats", async () => {
    const restore = mockFetch(() =>
      Promise.resolve(new Response(JSON.stringify(SAMPLE_POOL_RESPONSE), { status: 200 })),
    );
    try {
      const stats = await Effect.runPromise(
        Effect.gen(function* () {
          const datapi = yield* MeteoraDatapiService;
          return yield* datapi.getPoolData("PoolABC111");
        }).pipe(Effect.provide(makeLayer())),
      );
      expect(stats).not.toBeNull();
      expect(stats!.address).toBe("PoolABC111");
      expect(stats!.tvlUsd).toBeCloseTo(1_234_567.89);
      expect(stats!.volume24hUsd).toBeCloseTo(456_789.12);
      expect(stats!.fees24hUsd).toBeCloseTo(1_234.56);
      expect(stats!.feeTvlRatio24h).toBeCloseTo(0.001);
      expect(stats!.feeTvlRatio12h).toBeCloseTo(0.002);
      expect(stats!.feeTvlRatio1h).toBeCloseTo(0.0002);
      expect(stats!.dynamicFeePct).toBeCloseTo(0.05);
      expect(stats!.baseFeePct).toBeCloseTo(0.2);
      expect(stats!.hasFarm).toBe(true);
      expect(stats!.isBlacklisted).toBe(false);
      expect(stats!.tokenXFreezeAuthorityDisabled).toBe(true);
      expect(stats!.tokenYFreezeAuthorityDisabled).toBe(false);
      expect(stats!.tokenXVerified).toBe(false);
      expect(stats!.tokenYVerified).toBe(true);
    } finally {
      restore();
    }
  });

  it("(v) fetch failure → null (fallback), warning logged, no throw", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const restore = mockFetch(() => Promise.reject(new TypeError("fetch failed")));
    try {
      const stats = await Effect.runPromise(
        Effect.gen(function* () {
          const datapi = yield* MeteoraDatapiService;
          return yield* datapi.getPoolData("PoolABC111");
        }).pipe(Effect.provide(makeLayer())),
      );
      expect(stats).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("(v-b) non-OK HTTP status → null (fallback), warning logged", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const restore = mockFetch(() => Promise.resolve(new Response("rate limited", { status: 429 })));
    try {
      const stats = await Effect.runPromise(
        Effect.gen(function* () {
          const datapi = yield* MeteoraDatapiService;
          return yield* datapi.getPoolData("PoolABC111");
        }).pipe(Effect.provide(makeLayer())),
      );
      expect(stats).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("malformed payload → null (fallback), never crashes", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const restore = mockFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ unexpected: true }), { status: 200 })),
    );
    try {
      const stats = await Effect.runPromise(
        Effect.gen(function* () {
          const datapi = yield* MeteoraDatapiService;
          return yield* datapi.getPoolData("PoolABC111");
        }).pipe(Effect.provide(makeLayer())),
      );
      expect(stats).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

describe("enrichPoolWithDatapi", () => {
  it("replaces heuristic volume/fees/tvl with real Data API values", () => {
    const pool = makePool({ tvlUsd: 50_000, volume24hUsd: 15_000, fees24hUsd: 150 });
    const enriched = enrichPoolWithDatapi(pool, {
      address: pool.address,
      name: "SOL-USDC",
      tvlUsd: 1_000_000,
      volume24hUsd: 456_789.12,
      fees24hUsd: 1_234.56,
      apr: 0.0042,
      apy: 4.63,
      currentPrice: 151.25,
      feeTvlRatio24h: 0.001,
      feeTvlRatio12h: 0.002,
      feeTvlRatio1h: 0.0002,
      dynamicFeePct: 0.05,
      baseFeePct: 0.2,
      hasFarm: true,
      farmApr: 0,
      farmApy: 0,
      isBlacklisted: false,
      tokenXFreezeAuthorityDisabled: true,
      tokenYFreezeAuthorityDisabled: false,
      tokenXVerified: false,
      tokenYVerified: true,
    });
    expect(enriched.tvlUsd).toBe(1_000_000);
    expect(enriched.volume24hUsd).toBeCloseTo(456_789.12);
    expect(enriched.fees24hUsd).toBeCloseTo(1_234.56);
    expect(enriched.statsSource).toBe("datapi");
    // On-chain identity fields are preserved.
    expect(enriched.activeBinId).toBe(pool.activeBinId);
    expect(enriched.currentPrice).toBe(pool.currentPrice);
  });
});
