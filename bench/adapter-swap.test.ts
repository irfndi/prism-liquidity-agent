import { describe, it, expect, vi, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type VersionedTransactionResponse,
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
  prefetchedQuote?: Record<string, unknown>,
): Effect.Effect<string, Error, never> {
  return Effect.gen(function* () {
    const adapter = yield* AdapterService;
    return yield* adapter.swapUSDCForToken(outputMint, amountAtomic, prefetchedQuote);
  }).pipe(Effect.provide(layer));
}

function quoteEffect(
  layer: Layer.Layer<AdapterService, never, never>,
  outputMint: string,
  amountAtomic: bigint,
): Effect.Effect<Record<string, unknown>, Error, never> {
  return Effect.gen(function* () {
    const adapter = yield* AdapterService;
    return yield* adapter.quoteSwapUSDCForToken(outputMint, amountAtomic);
  }).pipe(Effect.provide(layer));
}

function genericSwapEffect(
  layer: Layer.Layer<AdapterService, never, never>,
  inputMint: string,
  outputMint: string,
  amountAtomic: bigint,
) {
  return Effect.gen(function* () {
    const adapter = yield* AdapterService;
    if (
      !adapter.quoteSwap ||
      !adapter.prepareSwap ||
      !adapter.simulateSwap ||
      !adapter.submitSwap
    ) {
      return yield* Effect.fail(new Error("generic swap API unavailable"));
    }
    const quote = yield* adapter.quoteSwap({
      inputMint,
      outputMint,
      amountAtomic,
      slippageBps: 50,
    });
    const prepared = yield* adapter.prepareSwap(quote);
    yield* adapter.simulateSwap(prepared);
    return yield* adapter.submitSwap(prepared);
  }).pipe(Effect.provide(layer));
}

function genericSwapAndReadBalanceEffect(
  layer: Layer.Layer<AdapterService, never, never>,
  inputMint: string,
  outputMint: string,
  amountAtomic: bigint,
) {
  return Effect.gen(function* () {
    const adapter = yield* AdapterService;
    const before = yield* adapter.getNativeSolBalance();
    const cached = yield* adapter.getNativeSolBalance();
    if (
      !adapter.quoteSwap ||
      !adapter.prepareSwap ||
      !adapter.simulateSwap ||
      !adapter.submitSwap
    ) {
      return yield* Effect.fail(new Error("generic swap API unavailable"));
    }
    const quote = yield* adapter.quoteSwap({
      inputMint,
      outputMint,
      amountAtomic,
      slippageBps: 50,
    });
    const prepared = yield* adapter.prepareSwap(quote);
    yield* adapter.simulateSwap(prepared);
    const outcome = yield* adapter.submitSwap(prepared).pipe(Effect.result);
    const after = yield* adapter.getNativeSolBalance();
    return { before, cached, after, outcome };
  }).pipe(Effect.provide(layer));
}

function jupiterQuote(
  inputMint: string,
  outputMint: string,
  amountAtomic: bigint,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    inputMint,
    outputMint,
    inAmount: amountAtomic.toString(),
    outAmount: "990000",
    otherAmountThreshold: "980000",
    slippageBps: 50,
    priceImpactPct: "0.001",
    routePlan: [
      {
        swapInfo: {
          inputMint,
          outputMint,
          inAmount: amountAtomic.toString(),
          outAmount: "990000",
        },
        percent: 100,
      },
    ],
    ...overrides,
  };
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
  prefetchedQuote?: Record<string, unknown>,
): Promise<void> {
  const result = await Effect.runPromise(
    swapEffect(layer, outputMint, amountAtomic, prefetchedQuote).pipe(Effect.result),
  );
  if (result._tag !== "Failure") {
    expect.fail("expected swap to fail, but it succeeded");
  }
  const err = result.failure;
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
      const u = String(url as unknown);
      if (u.includes("/swap/v1/quote")) {
        captured.quoteUrl = u;
        return new Response(
          JSON.stringify(
            jupiterQuote("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", SOL_MINT, 1_000_000n),
          ),
          { status: 200 },
        );
      }
      if (u.includes("/swap/v1/swap")) {
        captured.swapBody = JSON.parse((init?.body as string | undefined) ?? "{}");
        return new Response(JSON.stringify({ swapTransaction: validSwapTx }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch);

    vi.spyOn(Connection.prototype, "sendRawTransaction").mockResolvedValue("mock-sig");
    vi.spyOn(Connection.prototype, "simulateTransaction").mockResolvedValue({
      context: { slot: 1 },
      value: { err: null, logs: [], unitsConsumed: 1 },
    });
    vi.spyOn(Connection.prototype, "confirmTransaction").mockResolvedValue({
      context: { slot: 1 },
      value: { err: null },
    });

    try {
      const sig = await runSwap(buildLayer(), SOL_MINT, 1_000_000n);
      expect(sig).toBe("mock-sig");
      expect(captured.quoteUrl).toContain("slippageBps=50");
      expect(captured.quoteUrl).toContain("asLegacyTransaction=false");
      expect(captured.swapBody.wrapAndUnwrapSol).toBe(true);
      expect(captured.swapBody.asLegacyTransaction).toBe(false);
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

  it("fails for non-positive amounts without calling Jupiter", async () => {
    const fetchImpl = vi.fn(
      (async () => new Response("unexpected", { status: 500 })) as unknown as typeof fetch,
    );
    const restore = mockFetch(fetchImpl);

    try {
      await expectSwapFailure(
        buildLayer(),
        SOL_MINT,
        0n,
        "Cannot swap USDC for non-positive amount: 0",
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("fails when Jupiter quote request returns non-OK", async () => {
    const restore = mockFetch((async (url: string | URL | Request) => {
      const u = String(url as unknown);
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
      const u = String(url as unknown);
      if (u.includes("/swap/v1/quote")) {
        return new Response(
          JSON.stringify(
            jupiterQuote("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", SOL_MINT, 1_000_000n),
          ),
          { status: 200 },
        );
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
      const u = String(url as unknown);
      if (u.includes("/swap/v1/quote")) {
        return new Response(
          JSON.stringify(
            jupiterQuote("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", SOL_MINT, 1_000_000n),
          ),
          { status: 200 },
        );
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

  it("fails when Jupiter quote returns an empty route without building a swap", async () => {
    const fetchImpl = vi.fn((async (url: string | URL | Request) => {
      const u = String(url as unknown);
      if (u.includes("/swap/v1/quote")) {
        return new Response(
          JSON.stringify(
            jupiterQuote("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", SOL_MINT, 1_000_000n, {
              routePlan: [],
            }),
          ),
          { status: 200 },
        );
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch);
    const restore = mockFetch(fetchImpl);

    try {
      await expectSwapFailure(
        buildLayer(),
        SOL_MINT,
        1_000_000n,
        "Jupiter quote returned no usable route",
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(String(fetchImpl.mock.calls[0]?.[0] as unknown)).toContain("/swap/v1/quote");
    } finally {
      restore();
    }
  });

  it("fails quote for non-positive amounts", async () => {
    const result = await Effect.runPromise(
      quoteEffect(buildLayer(), SOL_MINT, 0n).pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    const err = result.failure;
    expect(typeof err === "object" && err !== null && "message" in err).toBe(true);
    expect((err as { message: string }).message).toContain(
      "quoteSwapUSDCForToken failed: SwapQuoteError: Cannot quote swap for non-positive amount: 0",
    );
  });

  it("fails when prefetched quote outputMint does not match", async () => {
    const fetchImpl = vi.fn(
      (async () => new Response("unexpected", { status: 500 })) as unknown as typeof fetch,
    );
    const restore = mockFetch(fetchImpl);

    try {
      await expectSwapFailure(
        buildLayer(),
        SOL_MINT,
        1_000_000n,
        "Jupiter quote does not match request: outputMint=So11111111111111111111111111111111111111112, amount=1000000",
        {
          inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          outputMint: "OtherMint1111111111111111111111111111111111",
          inAmount: "1000000",
          routePlan: [{ swapInfo: {} }],
        },
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("fails when prefetched quote amount does not match", async () => {
    const fetchImpl = vi.fn(
      (async () => new Response("unexpected", { status: 500 })) as unknown as typeof fetch,
    );
    const restore = mockFetch(fetchImpl);

    try {
      await expectSwapFailure(
        buildLayer(),
        SOL_MINT,
        1_000_000n,
        "Jupiter quote does not match request: outputMint=So11111111111111111111111111111111111111112, amount=1000000",
        {
          inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          outputMint: SOL_MINT,
          inAmount: "2000000",
          routePlan: [{ swapInfo: {} }],
        },
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

describe("AdapterService generic Jupiter swaps", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("quotes, prepares, simulates, and submits a generic SOL-funded route", async () => {
    const outputMint = Keypair.generate().publicKey.toBase58();
    const amountAtomic = 1_000_000n;
    const message = new TransactionMessage({
      payerKey: walletKeypair.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [],
    }).compileToV0Message();
    const transactionBase64 = Buffer.from(new VersionedTransaction(message).serialize()).toString(
      "base64",
    );
    const captured: { quoteUrl: string; swapBody: Record<string, unknown> } = {
      quoteUrl: "",
      swapBody: {},
    };
    const restore = mockFetch(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url as unknown);
      if (requestUrl.includes("/swap/v1/quote")) {
        captured.quoteUrl = requestUrl;
        return new Response(JSON.stringify(jupiterQuote(SOL_MINT, outputMint, amountAtomic)));
      }
      captured.swapBody = JSON.parse((init?.body as string | undefined) ?? "{}");
      return new Response(JSON.stringify({ swapTransaction: transactionBase64 }));
    });
    vi.spyOn(Connection.prototype, "simulateTransaction").mockResolvedValue({
      context: { slot: 1 },
      value: { err: null, logs: ["Program success"], unitsConsumed: 42 },
    });
    const sendSpy = vi.spyOn(Connection.prototype, "sendRawTransaction").mockResolvedValue("sig");
    vi.spyOn(Connection.prototype, "confirmTransaction").mockResolvedValue({
      context: { slot: 2 },
      value: { err: null },
    });

    try {
      await expect(
        Effect.runPromise(genericSwapEffect(buildLayer(), SOL_MINT, outputMint, amountAtomic)),
      ).resolves.toBe("sig");
      expect(captured.quoteUrl).toContain(`inputMint=${SOL_MINT}`);
      expect(captured.quoteUrl).toContain(`outputMint=${outputMint}`);
      expect(captured.swapBody.asLegacyTransaction).toBe(false);
      expect(sendSpy).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("resolves a submitted swap with the signature only after confirmation succeeds", async () => {
    const outputMint = Keypair.generate().publicKey.toBase58();
    const amountAtomic = 1_000_000n;
    const message = new TransactionMessage({
      payerKey: walletKeypair.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [],
    }).compileToV0Message();
    const transactionBase64 = Buffer.from(new VersionedTransaction(message).serialize()).toString(
      "base64",
    );
    const restore = mockFetch(async (url: string | URL | Request) =>
      String(url as unknown).includes("/swap/v1/quote")
        ? new Response(JSON.stringify(jupiterQuote(SOL_MINT, outputMint, amountAtomic)))
        : new Response(JSON.stringify({ swapTransaction: transactionBase64 })),
    );
    vi.spyOn(Connection.prototype, "simulateTransaction").mockResolvedValue({
      context: { slot: 1 },
      value: { err: null, logs: [], unitsConsumed: 1 },
    });
    vi.spyOn(Connection.prototype, "sendRawTransaction").mockResolvedValue("delayed-sig");
    let releaseConfirmation: (() => void) | undefined;
    const confirmation = new Promise<{
      context: { slot: number };
      value: { err: null };
    }>((resolve) => {
      releaseConfirmation = () => resolve({ context: { slot: 2 }, value: { err: null } });
    });
    const confirmSpy = vi
      .spyOn(Connection.prototype, "confirmTransaction")
      .mockImplementation(() => confirmation);
    let settled = false;

    try {
      const result = Effect.runPromise(
        genericSwapEffect(buildLayer(), SOL_MINT, outputMint, amountAtomic),
      ).then((signature) => {
        settled = true;
        return signature;
      });
      await vi.waitFor(() => expect(confirmSpy).toHaveBeenCalledWith("delayed-sig", "confirmed"));
      expect(settled).toBe(false);
      releaseConfirmation?.();
      await expect(result).resolves.toBe("delayed-sig");
      expect(settled).toBe(true);
    } finally {
      releaseConfirmation?.();
      restore();
    }
  });

  it.each([
    ["stale", { advanceMs: 30_001, quoteOverrides: {} }],
    ["excessive impact", { advanceMs: 0, quoteOverrides: { priceImpactPct: "0.0101" } }],
    ["mint mismatch", { advanceMs: 0, quoteOverrides: { outputMint: SOL_MINT } }],
  ])("does not prepare or send a %s quote", async (_name, scenario) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T00:00:00Z"));
    const outputMint = Keypair.generate().publicKey.toBase58();
    const amountAtomic = 1_000_000n;
    const fetchSpy = vi.fn(async (url: string | URL | Request) => {
      if (String(url as unknown).includes("/swap/v1/quote")) {
        return new Response(
          JSON.stringify(jupiterQuote(SOL_MINT, outputMint, amountAtomic, scenario.quoteOverrides)),
        );
      }
      return new Response("must not prepare", { status: 500 });
    });
    const restore = mockFetch(fetchSpy);
    const sendSpy = vi.spyOn(Connection.prototype, "sendRawTransaction");

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          if (!adapter.quoteSwap || !adapter.prepareSwap) {
            return yield* Effect.fail(new Error("generic swap API unavailable"));
          }
          const quote = yield* adapter.quoteSwap({
            inputMint: SOL_MINT,
            outputMint,
            amountAtomic,
            slippageBps: 50,
          });
          vi.setSystemTime(Date.now() + scenario.advanceMs);
          return yield* adapter.prepareSwap(quote);
        }).pipe(Effect.provide(buildLayer()), Effect.result),
      );
      expect(result._tag).toBe("Failure");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("rejects a malformed transaction payload before simulation or submission", async () => {
    const outputMint = Keypair.generate().publicKey.toBase58();
    const amountAtomic = 1_000_000n;
    const restore = mockFetch(async (url: string | URL | Request) => {
      if (String(url as unknown).includes("/swap/v1/quote")) {
        return new Response(JSON.stringify(jupiterQuote(SOL_MINT, outputMint, amountAtomic)));
      }
      return new Response(JSON.stringify({ swapTransaction: "not-base64!!" }));
    });
    const simulateSpy = vi.spyOn(Connection.prototype, "simulateTransaction");
    const sendSpy = vi.spyOn(Connection.prototype, "sendRawTransaction");

    try {
      const result = await Effect.runPromise(
        genericSwapEffect(buildLayer(), SOL_MINT, outputMint, amountAtomic).pipe(Effect.result),
      );
      expect(result._tag).toBe("Failure");
      expect(simulateSpy).not.toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("returns no price evidence when only a configured fallback exists", async () => {
    const restore = mockFetch(async () => new Response("price unavailable", { status: 503 }));

    try {
      const evidence = await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          if (!adapter.getTokenPriceEvidence) {
            return yield* Effect.fail(new Error("price evidence API unavailable"));
          }
          return yield* adapter.getTokenPriceEvidence([SOL_MINT]);
        }).pipe(Effect.provide(buildLayer())),
      );
      expect(evidence).toEqual([]);
    } finally {
      restore();
    }
  });

  it("maps confirmed RPC signature status into the typed swap status", async () => {
    vi.spyOn(Connection.prototype, "getSignatureStatuses").mockResolvedValue({
      context: { slot: 42 },
      value: [
        {
          slot: 42,
          confirmations: 1,
          err: null,
          confirmationStatus: "confirmed",
        },
      ],
    });

    const status = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* AdapterService;
        if (!adapter.getSwapStatus) {
          return yield* Effect.fail(new Error("swap status API unavailable"));
        }
        return yield* adapter.getSwapStatus("mock-signature");
      }).pipe(Effect.provide(buildLayer())),
    );

    expect(status).toEqual({ state: "confirmed", error: null });
  });

  it("returns output and fee from a confirmed transaction", async () => {
    const response: VersionedTransactionResponse = {
      slot: 1,
      transaction: {
        message: new TransactionMessage({
          payerKey: walletKeypair.publicKey,
          recentBlockhash: "11111111111111111111111111111111",
          instructions: [],
        }).compileToV0Message(),
        signatures: [],
      },
      blockTime: null,
      meta: {
        fee: 5_000,
        preBalances: [1_000_000_000],
        postBalances: [1_001_000_000],
        err: null,
        innerInstructions: null,
        logMessages: null,
        preTokenBalances: null,
        postTokenBalances: null,
      },
    };
    vi.spyOn(Connection.prototype, "getTransaction").mockResolvedValue(response);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* AdapterService;
        if (!adapter.getConfirmedSwapOutput) {
          return yield* Effect.fail(new Error("swap output API unavailable"));
        }
        return yield* adapter.getConfirmedSwapOutput("mock-sig");
      }).pipe(Effect.provide(buildLayer())),
    );

    expect(result).toEqual({ outputAtomic: 1_000_000n, feeAtomic: 5_000n });
  });

  it("returns null when the confirmed transaction is unavailable", async () => {
    vi.spyOn(Connection.prototype, "getTransaction").mockResolvedValue(null);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* AdapterService;
        if (!adapter.getConfirmedSwapOutput) {
          return yield* Effect.fail(new Error("swap output API unavailable"));
        }
        return yield* adapter.getConfirmedSwapOutput("mock-sig");
      }).pipe(Effect.provide(buildLayer())),
    );

    expect(result).toBeNull();
  });

  it("invalidates balance caches when confirmation reports an on-chain failure", async () => {
    const outputMint = Keypair.generate().publicKey.toBase58();
    const amountAtomic = 1_000_000n;
    const message = new TransactionMessage({
      payerKey: walletKeypair.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [],
    }).compileToV0Message();
    const transactionBase64 = Buffer.from(new VersionedTransaction(message).serialize()).toString(
      "base64",
    );
    const restore = mockFetch(async (url: string | URL | Request) =>
      String(url as unknown).includes("/swap/v1/quote")
        ? new Response(JSON.stringify(jupiterQuote(SOL_MINT, outputMint, amountAtomic)))
        : new Response(JSON.stringify({ swapTransaction: transactionBase64 })),
    );
    vi.spyOn(Connection.prototype, "simulateTransaction").mockResolvedValue({
      context: { slot: 1 },
      value: { err: null, logs: [], unitsConsumed: 1 },
    });
    vi.spyOn(Connection.prototype, "sendRawTransaction").mockResolvedValue("sig");
    const getBalanceSpy = vi
      .spyOn(Connection.prototype, "getBalance")
      .mockResolvedValue(1_000_000_000);
    vi.spyOn(Connection.prototype, "confirmTransaction").mockResolvedValue({
      context: { slot: 2 },
      value: { err: new Error("confirmation failed") },
    });

    try {
      const result = await Effect.runPromise(
        genericSwapAndReadBalanceEffect(buildLayer(), SOL_MINT, outputMint, amountAtomic),
      );
      expect(result.before).toBe(1_000_000_000n);
      expect(result.cached).toBe(result.before);
      expect(result.after).toBe(result.before);
      expect(result.outcome._tag).toBe("Failure");
      expect(getBalanceSpy).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
  });

  it("remains pending until confirmTransaction settles, and rejects on confirmation failure", async () => {
    const outputMint = Keypair.generate().publicKey.toBase58();
    const amountAtomic = 1_000_000n;
    const message = new TransactionMessage({
      payerKey: walletKeypair.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [],
    }).compileToV0Message();
    const transactionBase64 = Buffer.from(new VersionedTransaction(message).serialize()).toString(
      "base64",
    );
    const restore = mockFetch(async (url: string | URL | Request) =>
      String(url as unknown).includes("/swap/v1/quote")
        ? new Response(JSON.stringify(jupiterQuote(SOL_MINT, outputMint, amountAtomic)))
        : new Response(JSON.stringify({ swapTransaction: transactionBase64 })),
    );
    vi.spyOn(Connection.prototype, "simulateTransaction").mockResolvedValue({
      context: { slot: 1 },
      value: { err: null, logs: [], unitsConsumed: 1 },
    });
    vi.spyOn(Connection.prototype, "sendRawTransaction").mockResolvedValue("pending-sig");
    let releaseConfirmation: (() => void) | undefined;
    const confirmation = new Promise<{
      context: { slot: number };
      value: { err: Error };
    }>((resolve) => {
      releaseConfirmation = () =>
        resolve({ context: { slot: 2 }, value: { err: new Error("confirmation failed") } });
    });
    const confirmSpy = vi
      .spyOn(Connection.prototype, "confirmTransaction")
      .mockImplementation(() => confirmation);
    let settled = false;

    try {
      const result = Effect.runPromise(
        genericSwapEffect(buildLayer(), SOL_MINT, outputMint, amountAtomic).pipe(Effect.result),
      ).then((outcome) => {
        settled = true;
        return outcome;
      });
      await vi.waitFor(() => expect(confirmSpy).toHaveBeenCalledWith("pending-sig", "confirmed"));
      expect(settled).toBe(false);
      releaseConfirmation?.();
      const outcome = await result;
      expect(settled).toBe(true);
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag !== "Failure") return;
      expect((outcome.failure as { message?: string }).message).toContain("confirmation failed");
    } finally {
      releaseConfirmation?.();
      restore();
    }
  });

  it("fails swapToken when prefetched quote inputMint does not match", async () => {
    const outputMint = Keypair.generate().publicKey.toBase58();
    const amountAtomic = 1_000_000n;
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url as unknown).includes("/swap/v1/quote")
        ? new Response(JSON.stringify(jupiterQuote(SOL_MINT, outputMint, amountAtomic)))
        : new Response("unexpected", { status: 500 }),
    );
    const restore = mockFetch(fetchImpl);

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          if (!adapter.quoteSwap) {
            return yield* Effect.fail(new Error("generic swap API unavailable"));
          }
          const quote = yield* adapter.quoteSwap({
            inputMint: SOL_MINT,
            outputMint,
            amountAtomic,
            slippageBps: 50,
          });
          const swapToken = (
            adapter as unknown as {
              swapToken: (
                inputMint: string,
                outputMint: string,
                amountAtomic: bigint,
                quoteData?: Record<string, unknown>,
              ) => Effect.Effect<string, Error>;
            }
          ).swapToken;
          if (!swapToken) return yield* Effect.fail(new Error("swapToken unavailable"));
          return yield* swapToken(
            "WrongMint1111111111111111111111111111111111",
            quote.request.outputMint,
            quote.request.amountAtomic,
            quote.rawQuote,
          );
        }).pipe(Effect.provide(buildLayer())),
      );
      expect(result).toBe("unexpected-success");
    } catch (err) {
      expect((err as { message?: string }).message).toContain(
        "Jupiter quote does not match request",
      );
    } finally {
      restore();
    }
  });

  it("fails swapToken when prefetched quote outputMint does not match", async () => {
    const outputMint = Keypair.generate().publicKey.toBase58();
    const amountAtomic = 1_000_000n;
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url as unknown).includes("/swap/v1/quote")
        ? new Response(JSON.stringify(jupiterQuote(SOL_MINT, outputMint, amountAtomic)))
        : new Response("unexpected", { status: 500 }),
    );
    const restore = mockFetch(fetchImpl);

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          if (!adapter.quoteSwap) {
            return yield* Effect.fail(new Error("generic swap API unavailable"));
          }
          const quote = yield* adapter.quoteSwap({
            inputMint: SOL_MINT,
            outputMint,
            amountAtomic,
            slippageBps: 50,
          });
          const swapToken = (
            adapter as unknown as {
              swapToken: (
                inputMint: string,
                outputMint: string,
                amountAtomic: bigint,
                quoteData?: Record<string, unknown>,
              ) => Effect.Effect<string, Error>;
            }
          ).swapToken;
          if (!swapToken) return yield* Effect.fail(new Error("swapToken unavailable"));
          return yield* swapToken(
            quote.request.inputMint,
            "WrongMint1111111111111111111111111111111111",
            quote.request.amountAtomic,
            quote.rawQuote,
          );
        }).pipe(Effect.provide(buildLayer())),
      );
      expect(result).toBe("unexpected-success");
    } catch (err) {
      expect((err as { message?: string }).message).toContain(
        "Jupiter quote does not match request",
      );
    } finally {
      restore();
    }
  });

  it("fails swapToken when prefetched quote amount does not match", async () => {
    const outputMint = Keypair.generate().publicKey.toBase58();
    const amountAtomic = 1_000_000n;
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url as unknown).includes("/swap/v1/quote")
        ? new Response(JSON.stringify(jupiterQuote(SOL_MINT, outputMint, amountAtomic)))
        : new Response("unexpected", { status: 500 }),
    );
    const restore = mockFetch(fetchImpl);

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          if (!adapter.quoteSwap) {
            return yield* Effect.fail(new Error("generic swap API unavailable"));
          }
          const quote = yield* adapter.quoteSwap({
            inputMint: SOL_MINT,
            outputMint,
            amountAtomic,
            slippageBps: 50,
          });
          const swapToken = (
            adapter as unknown as {
              swapToken: (
                inputMint: string,
                outputMint: string,
                amountAtomic: bigint,
                quoteData?: Record<string, unknown>,
              ) => Effect.Effect<string, Error>;
            }
          ).swapToken;
          if (!swapToken) return yield* Effect.fail(new Error("swapToken unavailable"));
          return yield* swapToken(
            quote.request.inputMint,
            quote.request.outputMint,
            2_000_000n,
            quote.rawQuote,
          );
        }).pipe(Effect.provide(buildLayer())),
      );
      expect(result).toBe("unexpected-success");
    } catch (err) {
      expect((err as { message?: string }).message).toContain(
        "Jupiter quote does not match request",
      );
    } finally {
      restore();
    }
  });
});
