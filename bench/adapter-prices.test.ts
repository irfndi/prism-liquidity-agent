import { describe, it, expect, vi, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { AdapterService } from "../engine/services.js";
import { AdapterLive } from "../engine/adapter-service.js";
import { ConfigService } from "../engine/config-service.js";
import { AuditLive } from "../engine/audit-service.js";
import { DbLive } from "../engine/db-service.js";
import { defaultAppConfig, mockFetch } from "./helpers.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

function buildAdapterLayerWithWallet(): Layer.Layer<AdapterService, never, never> {
  const walletPrivateKey = bs58.encode(Keypair.generate().secretKey);
  const configLayer = Layer.succeed(
    ConfigService,
    defaultAppConfig({
      walletPrivateKey,
      solanaRpcUrl: "https://example.com",
    solanaRpcFallbackUrl: "",
      sqliteDbPath: ":memory:",
      autoUpdate: false,
      updateCheckIntervalMs: 216_000_000,
    }),
  );
  const auditLayer = Layer.provide(AuditLive, DbLive(":memory:"));
  return Layer.provide(AdapterLive, Layer.merge(configLayer, auditLayer)) as Layer.Layer<
    AdapterService,
    never,
    never
  >;
}

describe("AdapterService price resolution", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the live Jupiter price for SOL instead of the hardcoded fallback", async () => {
    const restore = mockFetch((async (url: string | URL | Request) => {
      const u = url.toString();
      if (u.includes("price.jup.ag/v6/price") && u.includes(SOL_MINT)) {
        return new Response(JSON.stringify({ data: { [SOL_MINT]: { price: 200 } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch);

    vi.spyOn(Connection.prototype, "getBalance").mockResolvedValue(1_000_000_000);
    vi.spyOn(Connection.prototype, "getTokenAccountsByOwner").mockResolvedValue({
      value: [],
    } as unknown as Awaited<ReturnType<Connection["getTokenAccountsByOwner"]>>);

    try {
      const layer = buildAdapterLayerWithWallet();
      const program = Effect.gen(function* () {
        const adapter = yield* AdapterService;
        return yield* adapter.getWalletBalanceUsd();
      }).pipe(Effect.provide(layer));

      const balanceUsd = await Effect.runPromise(program);
      // 1 SOL at the mocked Jupiter price of $200 (no USDC balance).
      expect(balanceUsd).toBeCloseTo(200, 1);
    } finally {
      restore();
    }
  });
});
