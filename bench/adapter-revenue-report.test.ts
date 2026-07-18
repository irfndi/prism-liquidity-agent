import { describe, it, expect, vi, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import fs from "fs";
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

// reportFeeCollection reads ~/.config/prism/{install-id,credentials.json} from
// the real home directory — stub those reads so tests never touch the
// environment. Paths that don't match fall through to the real fs.
function stubPrismConfigDir(): void {
  const realReadFileSync = fs.readFileSync;
  const realExistsSync = fs.existsSync;
  vi.spyOn(fs, "readFileSync").mockImplementation(((
    path: fs.PathOrFileDescriptor,
    options?: unknown,
  ) => {
    if (typeof path === "string" && path.includes("install-id")) {
      return "ci-test-install-id-1234";
    }
    if (typeof path === "string" && path.includes("credentials.json")) {
      return JSON.stringify({ apiKey: "ci-test-api-key", userId: "ci-test-user" });
    }
    return realReadFileSync(path, options as never);
  }) as typeof fs.readFileSync);
  vi.spyOn(fs, "existsSync").mockImplementation((path: fs.PathLike) => {
    if (typeof path === "string" && path.includes("install-id")) return true;
    return realExistsSync(path);
  });
}

describe("AdapterService.reportFeeCollection opt-out", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not POST revenue telemetry when feedbackOptOut is set", async () => {
    stubPrismConfigDir();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));
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

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs revenue telemetry when feedbackOptOut is not set", async () => {
    stubPrismConfigDir();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));
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

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("/v1/revenue/log");
  });
});
