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

function makeAdapterLayer(
  overrides: Parameters<typeof defaultAppConfig>[0] = {},
): Layer.Layer<AdapterService, never, never> {
  const configLayer = Layer.succeed(
    ConfigService,
    defaultAppConfig({
      walletPrivateKey,
      solanaRpcUrl: "https://example.com",
      solanaRpcFallbackUrl: "",
      sqliteDbPath: ":memory:",
      autoUpdate: false,
      updateCheckIntervalMs: 216_000_000,
      ...overrides,
    }),
  );
  const auditLayer = Layer.provide(AuditLive, DbLive(":memory:"));
  return Layer.provide(AdapterLive, Layer.merge(configLayer, auditLayer)) as Layer.Layer<
    AdapterService,
    never,
    never
  >;
}

function buildLayer(): Layer.Layer<AdapterService, never, never> {
  return makeAdapterLayer();
}

function buildLayerNoWallet(): Layer.Layer<AdapterService, never, never> {
  return makeAdapterLayer({ walletPrivateKey: "" });
}

function swapEffect(
  layer: Layer.Layer<AdapterService, never, never>,
  outputMint: string,
  amountAtomic: bigint,
): Effect.Effect<string, unknown, never> {
  return Effect.gen(function* () {
    const adapter = yield* AdapterService;
    return yield* adapter.swapUSDCForToken(outputMint, amountAtomic);
  }).pipe(Effect.provide(layer));
}

async function runSwap(
  layer: Layer.Layer<AdapterService, never, never>,
  outputMint: string,
  amountAtomic: bigint,
): Promise<string> {
  return Effect.runPromise(swapEffect(layer, outputMint, amountAtomic));
}

async function expectSwapFailure(
  layer: Layer.Layer<AdapterService, never, never>,
  outputMint: string,
  amountAtomic: bigint,
  expectedCauseMessage: string,
): Promise<void> {
  const result = await Effect.runPromise(
    swapEffect(layer, outputMint, amountAtomic).pipe(Effect.either),
  );
  if (result._tag !== "Left") {
    expect.fail("expected swap to fail, but it succeeded");
  }
  const err = result.left;
  if (typeof err !== "object" || err === null || !("message" in err)) {
    expect.fail("expected error object with message");
  }
  const cause = (err as { cause?: unknown }).cause;
  if (
    typeof cause !== "object" ||
    cause === null ||
    !("message" in cause) ||
    typeof (cause as { message?: unknown }).message !== "string"
  ) {
    expect.fail("expected error cause with message");
  }
  expect((err as { message: string }).message).toContain("swapUSDCForToken failed:");
  expect((cause as { message: string }).message).toBe(expectedCauseMessage);
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

    const captured: {
      quoteUrl: string;
      swapBody: Record<string, unknown>;
    } = { quoteUrl: "", swapBody: {} };

    const restore = mockFetch((async (url: string | URL | Request, init?: RequestInit) => {
      const u = url.toString();
      if (u.includes("/swap/v1/quote")) {
        captured.quoteUrl = u;
        return new Response(JSON.stringify({ routePlan: [] }), { status: 200 });
      }
      if (u.includes("/swap/v1/swap")) {
        captured.swapBody = JSON.parse((init?.body as string | undefined) ?? "{}");
        return new Response(JSON.stringify({ swapTransaction: validSwapTx }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch);

    vi.spyOn(Connection.prototype, "sendRawTransaction").mockResolvedValue("mock-sig");
    vi.spyOn(Connection.prototype, "confirmTransaction").mockImplementation(() =>
      Promise.resolve(undefined as unknown as never),
    );

    try {
      const sig = await runSwap(buildLayer(), SOL_MINT, 1_000_000n);
      expect(sig).toBe("mock-sig");
      expect(captured.quoteUrl).toContain("slippageBps=50");
      expect(captured.quoteUrl).toContain("asLegacyTransaction=true");
      expect(captured.swapBody.wrapAndUnwrapSol).toBe(true);
      expect(captured.swapBody.asLegacyTransaction).toBe(true);
    } finally {
      restore();
    }
  });

  it("fails when no wallet is configured", async () => {
    const restore = mockFetch(
      (async () => new Response("unexpected", { status: 500 })) as unknown as typeof fetch,
    );

    try {
      await expectSwapFailure(buildLayerNoWallet(), SOL_MINT, 1_000_000n, "No wallet configured");
    } finally {
      restore();
    }
  });

  it("returns an empty string for non-positive amounts without calling Jupiter", async () => {
    const fetchImpl = vi.fn(
      (async () => new Response("unexpected", { status: 500 })) as unknown as typeof fetch,
    );
    const restore = mockFetch(fetchImpl);

    try {
      const sig = await runSwap(buildLayer(), SOL_MINT, 0n);
      expect(sig).toBe("");
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("fails when Jupiter quote request returns non-OK", async () => {
    const restore = mockFetch((async (url: string | URL | Request) => {
      const u = url.toString();
      if (u.includes("/swap/v1/quote")) {
        return new Response("quote error", { status: 502 });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch);

    try {
      await expectSwapFailure(buildLayer(), SOL_MINT, 1_000_000n, "Jupiter quote failed: 502");
    } finally {
      restore();
    }
  });

  it("fails when Jupiter swap build request returns non-OK", async () => {
    const restore = mockFetch((async (url: string | URL | Request) => {
      const u = url.toString();
      if (u.includes("/swap/v1/quote")) {
        return new Response(JSON.stringify({ routePlan: [] }), { status: 200 });
      }
      if (u.includes("/swap/v1/swap")) {
        return new Response("swap error", { status: 503 });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch);

    try {
      await expectSwapFailure(buildLayer(), SOL_MINT, 1_000_000n, "Jupiter swap build failed: 503");
    } finally {
      restore();
    }
  });

  it("fails when swap response is missing swapTransaction", async () => {
    const restore = mockFetch((async (url: string | URL | Request) => {
      const u = url.toString();
      if (u.includes("/swap/v1/quote")) {
        return new Response(JSON.stringify({ routePlan: [] }), { status: 200 });
      }
      if (u.includes("/swap/v1/swap")) {
        return new Response(JSON.stringify({ transaction: "ignored" }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch);

    try {
      await expectSwapFailure(
        buildLayer(),
        SOL_MINT,
        1_000_000n,
        "Jupiter swap: no transaction returned",
      );
    } finally {
      restore();
    }
  });
});
