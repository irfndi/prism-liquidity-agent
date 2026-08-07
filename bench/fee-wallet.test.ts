import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import fs from "fs";
import { ConfigService } from "../engine/config-service.js";
import { DbLive } from "../engine/db-service.js";
import { DbService, RevenueConfigService, type RevenueConfig } from "../engine/services.js";
import { fetchConfigFromApi, parseRevenueConfig } from "../engine/revenue-config-service.js";
import { defaultAppConfig } from "./helpers.js";

// ─── Fee wallet acquisition — the REAL production pipeline ──────────────────
//
// The client-side GET /v1/fee-wallet fetcher this file once replicated was
// removed in "server-authoritative revenue sharing enforcement": the fee
// wallet address now ships inside the authenticated revenue config
// (GET /v1/config -> feeWalletAddress) fetched by RevenueConfigService with a
// 30-min in-memory TTL, SQLite fallback, and fail-closed/live vs fail-open/
// paper semantics. These tests exercise that real code — parseRevenueConfig
// (field extraction), fetchConfigFromApi (the HTTP seam) and the wired
// service (TTL cache + paper fail-open) — instead of a re-implemented copy.

const FEE_WALLET = "FeeWallet11111111111111111111111111111111111";
// Mirrors CACHE_TTL_MS in engine/revenue-config-service.ts (30 minutes).
const REVENUE_CONFIG_CACHE_TTL_MS = 30 * 60 * 1000;

const VALID_CONFIG_BODY = {
  tier: "pro",
  platformFeeRate: 0.05,
  revenueShareEnabled: true,
  revenueShareOperatorPct: 20,
  feeWalletAddress: FEE_WALLET,
};

let RevenueConfigServiceLive: typeof import("../engine/revenue-config-service.js").RevenueConfigServiceLive;

const originalFetch = globalThis.fetch;

function buildLayer(
  overrides: Parameters<typeof defaultAppConfig>[0] = {},
): Layer.Layer<RevenueConfigService | DbService, never, never> {
  const mockConfig = Layer.succeed(ConfigService, defaultAppConfig(overrides));
  const dbLayer = DbLive(":memory:");
  const revenueConfigDeps = Layer.merge(mockConfig, dbLayer);
  const revenueConfig = Layer.provide(RevenueConfigServiceLive, revenueConfigDeps);
  return Layer.merge(revenueConfig, dbLayer) as Layer.Layer<
    RevenueConfigService | DbService,
    never,
    never
  >;
}

// readApiKey() reads ${PRISM_CONFIG_DIR}/credentials.json via fs.readFileSync;
// stub just that path so no test touches the real user config directory.
function mockCredentialsFile(apiKey = "test-api-key"): void {
  vi.spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor) => {
    if (typeof path === "string" && path.includes("credentials.json")) {
      return JSON.stringify({ apiKey });
    }
    throw new Error(`ENOENT: no such file: ${String(path)}`);
  }) as typeof fs.readFileSync);
}

function okResponse(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as unknown as Response;
}

function runGetConfig(
  layer: Layer.Layer<RevenueConfigService | DbService, never, never>,
): Promise<RevenueConfig> {
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const svc = yield* RevenueConfigService;
        return yield* svc.getConfig();
      }),
      layer,
    ),
  );
}

beforeEach(async () => {
  // Fresh module instance per test so the service's module-level in-memory
  // cache singleton starts empty (same pattern as revenue-config-service.test.ts).
  vi.resetModules();
  const mod = await import("../engine/revenue-config-service.js");
  RevenueConfigServiceLive = mod.RevenueConfigServiceLive;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── parseRevenueConfig — fee wallet field extraction ───────────────────────

describe("parseRevenueConfig", () => {
  it("parses a complete config including the fee wallet address", () => {
    const parsed = parseRevenueConfig(VALID_CONFIG_BODY);
    expect(parsed).toEqual({
      tier: "pro",
      platformFeeRate: 0.05,
      revenueShareEnabled: true,
      revenueShareOperatorPct: 20,
      feeWalletAddress: FEE_WALLET,
    });
  });

  it("defaults the fee wallet address to empty string when the field is missing", () => {
    const { feeWalletAddress: _dropped, ...rest } = VALID_CONFIG_BODY;
    const parsed = parseRevenueConfig(rest);
    expect(parsed).not.toBeNull();
    expect(parsed?.feeWalletAddress).toBe("");
    expect(parsed?.tier).toBe("pro");
  });

  it("defaults the fee wallet address to empty string when the field is not a string", () => {
    const parsed = parseRevenueConfig({ ...VALID_CONFIG_BODY, feeWalletAddress: 12345 });
    expect(parsed).not.toBeNull();
    expect(parsed?.feeWalletAddress).toBe("");
  });

  it("returns null for non-object bodies", () => {
    expect(parseRevenueConfig(null)).toBeNull();
    expect(parseRevenueConfig("fee-wallet")).toBeNull();
    expect(parseRevenueConfig(42)).toBeNull();
  });
});

// ─── fetchConfigFromApi — the HTTP seam ─────────────────────────────────────

describe("fetchConfigFromApi", () => {
  it("fetches /v1/config with the Bearer key and returns the parsed config", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(VALID_CONFIG_BODY));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await Effect.runPromise(Effect.result(fetchConfigFromApi("test-api-key")));

    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(result.success.feeWalletAddress).toBe(FEE_WALLET);
      expect(result.success.tier).toBe("pro");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://prism-api.irfndi.workers.dev/v1/config");
    expect(init.headers.Authorization).toBe("Bearer test-api-key");
  });

  it("fails when the API returns a non-ok status", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;

    const result = await Effect.runPromise(Effect.result(fetchConfigFromApi("test-api-key")));

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(Error);
      expect((result.failure as Error).message).toBe("API returned 503");
    }
  });

  it("fails when the response body is not valid JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new SyntaxError("Unexpected token '<'")),
    }) as unknown as typeof fetch;

    const result = await Effect.runPromise(Effect.result(fetchConfigFromApi("test-api-key")));

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(Error);
    }
  });

  it("fails when the body is valid JSON but not an object", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(okResponse("not-an-object")) as unknown as typeof fetch;

    const result = await Effect.runPromise(Effect.result(fetchConfigFromApi("test-api-key")));

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect((result.failure as Error).message).toBe("Invalid API response");
    }
  });
});

// ─── RevenueConfigService — fee wallet lifecycle ────────────────────────────

describe("RevenueConfigService fee wallet lifecycle", () => {
  it("caches the fee wallet for 30 minutes, then refetches", async () => {
    vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
    const fetchMock = vi.fn().mockResolvedValue(okResponse(VALID_CONFIG_BODY));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    mockCredentialsFile();
    const layer = buildLayer({ paperTrading: true });

    const program = Effect.provide(
      Effect.gen(function* () {
        const svc = yield* RevenueConfigService;
        const first = yield* svc.getConfig();
        const withinTtl = yield* svc.getConfig();
        return { first, withinTtl };
      }),
      layer,
    );

    const { first, withinTtl } = await Effect.runPromise(program);
    expect(first.feeWalletAddress).toBe(FEE_WALLET);
    expect(withinTtl.feeWalletAddress).toBe(FEE_WALLET);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance past the 30-min TTL — the next call must hit the API again.
    vi.advanceTimersByTime(REVENUE_CONFIG_CACHE_TTL_MS + 1);
    const afterTtl = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* RevenueConfigService;
          return yield* svc.getConfig();
        }),
        layer,
      ),
    );
    expect(afterTtl.feeWalletAddress).toBe(FEE_WALLET);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns an empty fee wallet when the API is unreachable in paper mode", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network error"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    mockCredentialsFile();
    const layer = buildLayer({ paperTrading: true });

    const result = await runGetConfig(layer);

    expect(result.feeWalletAddress).toBe("");
    expect(result.tier).toBe("free");
    // Real retry behavior the old copy never exercised: 3 attempts.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 15_000);
});
