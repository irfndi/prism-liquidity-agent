import { describe, it, expect, vi, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import { AdapterService } from "../engine/services.js";
import { AdapterLive } from "../engine/adapter-service.js";
import { ConfigService } from "../engine/config-service.js";
import { AuditLive } from "../engine/audit-service.js";
import { DbLive } from "../engine/db-service.js";
import { defaultAppConfig } from "./helpers.js";

function buildAdapterLayer(
  overrides: Parameters<typeof defaultAppConfig>[0] = {},
): Layer.Layer<AdapterService, never, never> {
  const configLayer = Layer.succeed(
    ConfigService,
    defaultAppConfig({
      solanaRpcUrl: "https://api.mainnet.helius-rpc.com",
      solanaRpcFallbackUrl: "",
      sqliteDbPath: ":memory:",
      autoUpdate: false,
      ...overrides,
    }),
  );
  const auditLayer = Layer.provide(AuditLive, DbLive(":memory:"));
  const withDeps = Layer.provide(AdapterLive, Layer.merge(configLayer, auditLayer));
  return withDeps as Layer.Layer<AdapterService, never, never>;
}

const FEE_EVENT = {
  poolAddress: "5JvD1TW5nqSz6gJtHfVnZKq3fZmBnL5xY7u9dR2wT4k",
  feeX: 10,
  feeY: 20,
  platformFeeX: 1,
  platformFeeY: 2,
  tier: "pro",
  txSignature: "sig-123",
};

describe("AdapterService.reportFeeCollection opt-out", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("does not POST revenue telemetry when feedbackOptOut is set", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const layer = buildAdapterLayer({ feedbackOptOut: true });

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          yield* adapter.reportFeeCollection(FEE_EVENT);
        }),
        layer,
      ),
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs revenue telemetry when feedbackOptOut is not set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const layer = buildAdapterLayer({ feedbackOptOut: false });

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          yield* adapter.reportFeeCollection(FEE_EVENT);
        }),
        layer,
      ),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v1/revenue/log");
  });
});
