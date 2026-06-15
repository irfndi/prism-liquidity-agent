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

  it("returns parsed pools when the API responds 200 with valid JSON", async () => {
    const restore = mockFetch(
      (async () =>
        new Response(
          JSON.stringify([
            {
              address: "Pool111111111111111111111111111111111111111",
              bin_step: 10,
              base_mint: "So11111111111111111111111111111111111111112",
              quote_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              tvl: 200_000,
              volume_24h: 50_000,
              fees_24h: 500,
              apr: 60,
            },
            {
              address: "Pool222222222222222222222222222222222222222",
              bin_step: 20,
              base_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              quote_mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
              tvl: 1_000_000,
              volume_24h: 200_000,
              fees_24h: 2_000,
              apr: 120,
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as unknown as typeof fetch,
    );
    try {
      const layer = buildAdapterLayer({ discoveryMinTvlUsd: 100_000 });
      const result = await runDiscover(layer);
      if (Array.isArray(result)) {
        expect(result).toHaveLength(2);
        expect(result[0]?.address).toBe("Pool111111111111111111111111111111111111111");
      } else {
        expect.fail(`Expected array result, got tagged failure: ${JSON.stringify(result)}`);
      }
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
});
