import { describe, it, expect, vi, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import { AdapterService } from "../engine/services.js";
import { AdapterLive } from "../engine/adapter-service.js";
import { ConfigService } from "../engine/config-service.js";
import { AuditLive } from "../engine/audit-service.js";
import { DbLive } from "../engine/db-service.js";
import { defaultAppConfig, mockFetch } from "./helpers.js";

function buildAdapterLayer(
  overrides: Parameters<typeof defaultAppConfig>[0] = {},
): Layer.Layer<AdapterService, never, never> {
  const configLayer = Layer.succeed(
    ConfigService,
    defaultAppConfig({
      solanaRpcUrl: "https://api.mainnet.helius-rpc.com",
    solanaRpcFallbackUrl: "",
      enablePoolDiscovery: true,
      sqliteDbPath: ":memory:",
      autoUpdate: false,
      updateCheckIntervalMs: 216_000_000,
      updateGithubRepo: "irfndi/prism-liquidity-agent",
      updateR2PublicUrl: "https://pub-2f55c98709e74d1d900b89ec20f8f1fc.r2.dev",
      githubRepo: "irfndi/prism-liquidity-agent",
      ...overrides,
    }),
  );
  // AuditLive requires DbService — use Layer.provide (not merge) so the dep
  // is wired transitively into the merged harness below.
  const auditLayer = Layer.provide(AuditLive, DbLive(":memory:"));
  const withDeps = Layer.provide(AdapterLive, Layer.merge(configLayer, auditLayer));
  return withDeps as Layer.Layer<AdapterService, never, never>;
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
            {
              address: "Pool1",
              bin_step: 10,
              base_mint: "X",
              quote_mint: "Y",
              tvl: 1000,
              volume_24h: 1,
              fees_24h: 1,
              apr: 1,
            },
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
    const restore = mockFetch(
      (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch,
    );
    try {
      const layer = buildAdapterLayer();
      const err = (await runDiscoverFlip(layer)) as { _tag?: string; message?: string };
      expect(err._tag).toBe("DiscoverPoolsError");
      expect(err.message?.toLowerCase()).toContain("404");
    } finally {
      restore();
    }
  });

  it("surfaces an explicit failure when the API responds 500 (not silently empty)", async () => {
    const restore = mockFetch(
      (async () => new Response("server error", { status: 500 })) as unknown as typeof fetch,
    );
    try {
      const layer = buildAdapterLayer();
      const err = (await runDiscoverFlip(layer)) as { _tag?: string; message?: string };
      expect(err._tag).toBe("DiscoverPoolsError");
      expect(err.message?.toLowerCase()).toContain("500");
    } finally {
      restore();
    }
  });

  it("surfaces an explicit failure when the response body is not valid JSON", async () => {
    const restore = mockFetch(
      (async () =>
        new Response("not json at all", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        })) as unknown as typeof fetch,
    );
    try {
      const layer = buildAdapterLayer();
      const err = (await runDiscoverFlip(layer)) as { _tag?: string; message?: string };
      expect(err._tag).toBe("DiscoverPoolsError");
      expect(err.message?.toLowerCase()).toContain("json");
    } finally {
      restore();
    }
  });

  it("surfaces an explicit failure when the response body is JSON but not an array", async () => {
    const restore = mockFetch(
      (async () =>
        new Response(JSON.stringify({ error: "rate limited" }), {
          status: 200,
        })) as unknown as typeof fetch,
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

  it("surfaces an explicit failure when fetch throws a network error", async () => {
    const restore = mockFetch((async () => {
      throw new Error("ENOTFOUND dlmm-api.meteora.ag");
    }) as unknown as typeof fetch);
    try {
      const layer = buildAdapterLayer();
      const err = (await runDiscoverFlip(layer)) as { _tag?: string; message?: string };
      expect(err._tag).toBe("DiscoverPoolsError");
      expect(err.message?.toLowerCase()).toContain("network error");
    } finally {
      restore();
    }
  });

  it("the error carries a typed _tag field DiscoverPoolsError so callers can branch on it", async () => {
    const restore = mockFetch(
      (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch,
    );
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
    const restore = mockFetch((async (input: unknown) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({ total: 0, pages: 0, current_page: 1, page_size: 0, data: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch);
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
    const restore = mockFetch((async (input: unknown) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({ total: 0, pages: 0, current_page: 1, page_size: 0, data: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch);
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
        (call) =>
          typeof call[0] === "string" && call[0].includes("some pool objects had invalid shape"),
      );
      expect(shapeWarn).toBeDefined();
      expect(shapeWarn?.[1]).toMatchObject({ dropped: 2, kept: 1, total: 3, pages: 1 });
    } finally {
      restore();
      warnSpy.mockRestore();
    }
  });

  it("fails with DiscoverPoolsError when the envelope is valid but ALL pool objects have invalid shape (P2 schema-error guard)", async () => {
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
      const err = (await runDiscoverFlip(layer)) as { _tag?: string; message?: string };
      expect(err._tag).toBe("DiscoverPoolsError");
      expect(err.message?.toLowerCase()).toContain("none matched the expected shape");
      const shapeWarn = warnSpy.mock.calls.find(
        (call) =>
          typeof call[0] === "string" && call[0].includes("ALL pool objects had invalid shape"),
      );
      expect(shapeWarn).toBeDefined();
      expect(shapeWarn?.[1]).toMatchObject({ dropped: 2, kept: 0, total: 2, pages: 1 });
    } finally {
      restore();
      warnSpy.mockRestore();
    }
  });

  it("does NOT trigger the all-fail guard when the envelope has an empty data array (zero pools is fine)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const restore = mockFetch(
      (async () =>
        new Response(
          JSON.stringify({ total: 0, pages: 0, current_page: 1, page_size: 0, data: [] }),
          { status: 200 },
        )) as unknown as typeof fetch,
    );
    try {
      const layer = buildAdapterLayer();
      const result = await runDiscover(layer);
      expect(result).toEqual([]);
      const allFailWarn = warnSpy.mock.calls.find(
        (call) =>
          typeof call[0] === "string" && call[0].includes("ALL pool objects had invalid shape"),
      );
      expect(allFailWarn).toBeUndefined();
    } finally {
      restore();
      warnSpy.mockRestore();
    }
  });

  it("drops pools where volume['24h'] is not a number (gap 1 regression)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
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
                address: "PoolBadVolume11111111111111111111111111111111",
                token_x: { address: "So11111111111111111111111111111111111111112" },
                token_y: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
                pool_config: { bin_step: 10 },
                tvl: 200_000,
                apr: 60,
                volume: { "24h": "not a number" },
                fees: { "24h": 500 },
              },
            ],
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    );
    try {
      const layer = buildAdapterLayer();
      const result = await runDiscover(layer);
      expect(result).toHaveLength(1);
      expect(result[0]?.address).toBe("PoolValid11111111111111111111111111111111111");
    } finally {
      restore();
      warnSpy.mockRestore();
    }
  });

  it("drops pools where fees['24h'] is not a number (gap 1 regression)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
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
                address: "PoolBadFees111111111111111111111111111111111",
                token_x: { address: "So11111111111111111111111111111111111111112" },
                token_y: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
                pool_config: { bin_step: 10 },
                tvl: 200_000,
                apr: 60,
                volume: { "24h": 50_000 },
                fees: { "24h": null },
              },
            ],
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    );
    try {
      const layer = buildAdapterLayer();
      const result = await runDiscover(layer);
      expect(result).toHaveLength(1);
      expect(result[0]?.address).toBe("PoolValid11111111111111111111111111111111111");
    } finally {
      restore();
      warnSpy.mockRestore();
    }
  });

  it("maps an AbortError from fetch to a DiscoverPoolsError (gap 2 fetch timeout)", async () => {
    const restore = mockFetch((async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch);
    try {
      const layer = buildAdapterLayer();
      const err = (await runDiscoverFlip(layer)) as { _tag?: string; message?: string };
      expect(err._tag).toBe("DiscoverPoolsError");
      expect(err.message?.toLowerCase()).toContain("network error");
    } finally {
      restore();
    }
  });
});
