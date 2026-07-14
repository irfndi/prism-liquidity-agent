import { describe, it, expect, vi, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { AdapterService } from "../engine/services.js";
import { AdapterLive } from "../engine/adapter-service.js";
import { ConfigService } from "../engine/config-service.js";
import { AuditLive } from "../engine/audit-service.js";
import { DbLive } from "../engine/db-service.js";
import { defaultAppConfig, mockFetch } from "./helpers.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const walletKeypair = Keypair.generate();
const walletPrivateKey = bs58.encode(walletKeypair.secretKey);

function buildLayer(): Layer.Layer<AdapterService, never, never> {
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

describe("AdapterService.swapUSDCForToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns tx signature on successful Jupiter swap", async () => {
    const validSwapTx = new Transaction({
      feePayer: walletKeypair.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
    })
      .add(
        new TransactionInstruction({
          keys: [],
          programId: PublicKey.default,
          data: Buffer.alloc(0),
        }),
      )
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");

    const restore = mockFetch((async (url: string | URL | Request) => {
      const u = url.toString();
      if (u.includes("/swap/v1/quote")) {
        return new Response(JSON.stringify({ routePlan: [] }), { status: 200 });
      }
      if (u.includes("/swap/v1/swap")) {
        return new Response(JSON.stringify({ swapTransaction: validSwapTx }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch);

    vi.spyOn(Connection.prototype, "sendRawTransaction").mockResolvedValue("mock-sig");
    vi.spyOn(Connection.prototype, "confirmTransaction").mockImplementation(() =>
      Promise.resolve(undefined as unknown as never),
    );

    try {
      const sig = await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          return yield* adapter.swapUSDCForToken(SOL_MINT, 1_000_000n);
        }).pipe(Effect.provide(buildLayer())),
      );
      expect(sig).toBe("mock-sig");
    } finally {
      restore();
    }
  });
});
