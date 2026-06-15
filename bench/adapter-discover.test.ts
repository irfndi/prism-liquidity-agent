import { describe, it, expect, vi, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import { AdapterService } from "../engine/services.js";
import { AdapterLive } from "../engine/adapter-service.js";
import { ConfigService, type AppConfig } from "../engine/config-service.js";
import { mockFetch } from "./helpers.js";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
    walletPrivateKey: "",
    heliusApiKey: "",
    solanaRpcUrl: "https://api.mainnet.helius-rpc.com",
    paperTrading: true,
    scanIntervalMs: 600_000,
    minPoolTvlUsd: 50_000,
    minFeeIlRatio: 1.2,
    tvlDropExitPct: 0.3,
    volumeAuthThreshold: 0.7,
    maxConcurrentPositions: 5,
    minRebalanceIntervalMs: 86_400_000,
    minRebalanceNetBenefitUsd: 10,
    confidenceThreshold: 0.65,
    paperPortfolioUsd: 10_000,
    minBinUtilization: 0.3,
    maxRebalanceRangeBins: 50,
    watchlistPools: [],
    stopLossPct: 0.15,
    trailingStopPct: 0.1,
    oorGracePeriodCycles: 3,
    feeClaimIntervalMs: 86_400_000,
    enablePoolDiscovery: true,
    discoveryMinTvlUsd: 100_000,
    discoveryMinFeeRatio: 1.5,
    deployerBlacklistPath: "",
    tokenBlacklistPath: "",
    sqliteDbPath: ":memory:",
    enableSnapshotCapture: false,
    autoUpdate: false,
    updateCheckIntervalMs: 216_000_000,
    updateChannel: "stable",
    updateGithubRepo: "irfndi/prism-liquidity-agent",
    updateAllowDirty: false,
    forceUpdateEnabled: false,
    forceUpdateAfterDays: 14,
    updateR2PublicUrl: "https://r2.prism-agent.com",
    githubToken: "",
    githubRepo: "irfndi/prism-liquidity-agent",
    feedbackOptOut: false,
    paperModeExitLive: false,
    meteoraPoolsUrl: "https://dlmm.datapi.meteora.ag/pools?page=1&page_size=1000&filter_by=is_blacklisted=false&sort_by=tvl:desc",
  };
  return { ...base, ...overrides };
}

function buildAdapterLayer(overrides: Partial<AppConfig> = {}): Layer.Layer<AdapterService, never, never> {
  const configLayer = Layer.succeed(ConfigService, makeConfig(overrides));
  return Layer.provide(AdapterLive, configLayer) as Layer.Layer<AdapterService, never, never>;
}

async function runDiscover(layer: Layer.Layer<AdapterService, never, never>) {
  const program = Effect.gen(function* () {
    const adapter = yield* AdapterService;
    return yield* adapter.discoverPools();
  });
  return Effect.runPromise(Effect.provide(program, layer));
}

async function runDiscoverFlip(layer: Layer.Layer<AdapterService, never, never>): Promise<unknown> {
  const program = Effect.gen(function* () {
    const adapter = yield* AdapterService;
    return yield* adapter.discoverPools();
  });
  return Effect.runPromise(Effect.flip(Effect.provide(program, layer)));
}

describe("AdapterService.discoverPools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns parsed pools when the API responds 200 with the official envelope shape", async () => {
    const restore = mockFetch(
      (async () =>
        new Response(
          JSON.stringify({
            total: 2,
            pages: 1,
            current_page: 1,
            page_size: 2,
            data: [
              {
                address: "Pool111111111111111111111111111111111111111",
                name: "SOL-USDC",
                token_x: { address: "So11111111111111111111111111111111111111112" },
                token_y: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
                pool_config: { bin_step: 10 },
                tvl: 200_000,
                apr: 60,
                volume: { "24h": 50_000 },
                fees: { "24h": 500 },
              },
              {
                address: "Pool222222222222222222222222222222222222222",
                name: "USDC-USDT",
                token_x: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
                token_y: { address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" },
                pool_config: { bin_step: 20 },
                tvl: 1_000_000,
                apr: 120,
                volume: { "24h": 200_000 },
                fees: { "24h": 2_000 },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as unknown as typeof fetch,
    );
    try {
      const layer = buildAdapterLayer({ discoveryMinTvlUsd: 100_000 });
      const result = await runDiscover(layer);
      if (Array.isArray(result)) {
        expect(result).toHaveLength(2);
        expect(result[0]?.address).toBe("Pool111111111111111111111111111111111111111");
        expect(result[0]?.binStep).toBe(10);
        expect(result[0]?.tokenX).toBe("So11111111111111111111111111111111111111112");
        expect(result[0]?.tokenY).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
        expect(result[0]?.volume24hUsd).toBe(50_000);
        expect(result[0]?.fees24hUsd).toBe(500);
        expect(result[0]?.tvlUsd).toBe(200_000);
        expect(result[0]?.apr).toBe(60);
      } else {
        expect.fail(`Expected array result, got tagged failure: ${JSON.stringify(result)}`);
      }
    } finally {
      restore();
    }
  });

  it("rejects a flat array response (the legacy /pair/all shape) as a non-envelope", async () => {
    const restore = mockFetch(
      (async () =>
        new Response(
          JSON.stringify([
            { address: "Pool1", bin_step: 10, base_mint: "X", quote_mint: "Y", tvl: 1000, volume_24h: 1, fees_24h: 1, apr: 1 },
          ]),
          { status: 200 },
        )) as unknown as typeof fetch,
    );
    try {
      const layer = buildAdapterLayer();
      const err = (await runDiscoverFlip(layer)) as { _tag?: string; message?: string };
      expect(err._tag).toBe("DiscoverPoolsError");
      expect(err.message?.toLowerCase()).toContain("envelope");
    } finally {
      restore();
    }
  });

  it("surfaces an explicit failure when the API responds 404 (not silently empty)", async () => {
    const restore = mockFetch((async () => new Response("not found", { status: 404 })) as unknown as typeof fetch);
    try {
      const layer = buildAdapterLayer();
      await expect(runDiscover(layer)).rejects.toBeDefined();
    } finally {
      restore();
    }
  });

  it("surfaces an explicit failure when the API responds 500 (not silently empty)", async () => {
    const restore = mockFetch((async () => new Response("server error", { status: 500 })) as unknown as typeof fetch);
    try {
      const layer = buildAdapterLayer();
      await expect(runDiscover(layer)).rejects.toBeDefined();
    } finally {
      restore();
    }
  });

  it("surfaces an explicit failure when the response body is not valid JSON", async () => {
    const restore = mockFetch(
      (async () =>
        new Response("not json at all", { status: 200, headers: { "Content-Type": "text/html" } })) as unknown as typeof fetch,
    );
    try {
      const layer = buildAdapterLayer();
      await expect(runDiscover(layer)).rejects.toBeDefined();
    } finally {
      restore();
    }
  });

  it("surfaces an explicit failure when the response body is JSON but not an array", async () => {
    const restore = mockFetch(
      (async () =>
        new Response(JSON.stringify({ error: "rate limited" }), { status: 200 })) as unknown as typeof fetch,
    );
    try {
      const layer = buildAdapterLayer();
      await expect(runDiscover(layer)).rejects.toBeDefined();
    } finally {
      restore();
    }
  });

  it("surfaces an explicit failure when fetch throws a network error", async () => {
    const restore = mockFetch(
      (async () => {
        throw new Error("ENOTFOUND dlmm-api.meteora.ag");
      }) as unknown as typeof fetch,
    );
    try {
      const layer = buildAdapterLayer();
      await expect(runDiscover(layer)).rejects.toBeDefined();
    } finally {
      restore();
    }
  });

  it("the error carries a typed _tag field DiscoverPoolsError so callers can branch on it", async () => {
    const restore = mockFetch((async () => new Response("not found", { status: 404 })) as unknown as typeof fetch);
    try {
      const layer = buildAdapterLayer();
      const err = (await runDiscoverFlip(layer)) as { _tag?: string; message?: string };
      expect(err._tag).toBe("DiscoverPoolsError");
      expect(typeof err.message).toBe("string");
      expect((err.message ?? "").toLowerCase()).toContain("404");
    } finally {
      restore();
    }
  });

  it("uses the URL from config.meteoraPoolsUrl (not a hardcoded process.env read)", async () => {
    let requestedUrl = "";
    const restore = mockFetch(
      (async (input: unknown) => {
        requestedUrl = String(input);
        return new Response(
          JSON.stringify({ total: 0, pages: 0, current_page: 1, page_size: 0, data: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    );
    try {
      const layer = buildAdapterLayer({
        meteoraPoolsUrl: "https://my-mock-api.example.com/pools",
      });
      await runDiscover(layer);
      expect(requestedUrl).toBe("https://my-mock-api.example.com/pools");
    } finally {
      restore();
    }
  });

  it("falls back to the default URL when config.meteoraPoolsUrl is an empty string", async () => {
    let requestedUrl = "";
    const restore = mockFetch(
      (async (input: unknown) => {
        requestedUrl = String(input);
        return new Response(
          JSON.stringify({ total: 0, pages: 0, current_page: 1, page_size: 0, data: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    );
    try {
      const layer = buildAdapterLayer({ meteoraPoolsUrl: "" });
      await runDiscover(layer);
      expect(requestedUrl).toBe(
        "https://dlmm.datapi.meteora.ag/pools?page=1&page_size=1000&filter_by=is_blacklisted=false&sort_by=tvl:desc",
      );
    } finally {
      restore();
    }
  });

  it("drops pool objects with invalid shape and returns the valid ones (with a logged warning)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const restore = mockFetch(
      (async () =>
        new Response(
          JSON.stringify({
            total: 3,
            pages: 1,
            current_page: 1,
            page_size: 3,
            data: [
              {
                address: "PoolValid11111111111111111111111111111111111",
                token_x: { address: "So11111111111111111111111111111111111111112" },
                token_y: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
                pool_config: { bin_step: 10 },
                tvl: 200_000,
                apr: 60,
                volume: { "24h": 50_000 },
                fees: { "24h": 500 },
              },
              {
                address: "PoolMissingFields111111111111111111111111111111",
              },
              {
                address: "PoolWrongTypes11111111111111111111111111111111",
                token_x: { address: "So11111111111111111111111111111111111111112" },
                token_y: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
                pool_config: { bin_step: 10 },
                tvl: "not a number",
                apr: 60,
                volume: { "24h": 50_000 },
                fees: { "24h": 500 },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as unknown as typeof fetch,
    );
    try {
      const layer = buildAdapterLayer();
      const result = await runDiscover(layer);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect(result[0]?.address).toBe("PoolValid11111111111111111111111111111111111");
      const shapeWarn = warnSpy.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("some pool objects had invalid shape"),
      );
      expect(shapeWarn).toBeDefined();
      expect(shapeWarn?.[1]).toMatchObject({ dropped: 2, kept: 1, total: 3, pages: 1 });
    } finally {
      restore();
      warnSpy.mockRestore();
    }
  });

  it("returns empty array when the envelope itself is valid but ALL pool objects have invalid shape", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const restore = mockFetch(
      (async () =>
        new Response(
          JSON.stringify({
            total: 2,
            pages: 1,
            current_page: 1,
            page_size: 2,
            data: [{ address: "Bad1" }, { address: "Bad2" }],
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    );
    try {
      const layer = buildAdapterLayer();
      const result = await runDiscover(layer);
      expect(result).toEqual([]);
      const shapeWarn = warnSpy.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("some pool objects had invalid shape"),
      );
      expect(shapeWarn).toBeDefined();
      expect(shapeWarn?.[1]).toMatchObject({ dropped: 2, kept: 0, total: 2, pages: 1 });
    } finally {
      restore();
      warnSpy.mockRestore();
    }
  });
});
