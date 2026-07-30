import { Effect, Layer } from "effect";
import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { AdapterService } from "../../../engine/services.js";
import { AdapterLive } from "../../../engine/adapter-service.js";
import { ConfigService } from "../../../engine/config-service.js";
import { AuditLive } from "../../../engine/audit-service.js";
import { DbLive } from "../../../engine/db-service.js";
import { defaultAppConfig } from "../../../bench/helpers.js";
import { SOL_MINT } from "../../../engine/constants.js";

type Scenario = "mint_mismatch" | "stale" | "impact" | "malformed_transaction";

const wallet = Keypair.generate();
const outputMint = Keypair.generate().publicKey.toBase58();
const amountAtomic = 1_000_000n;
const originalFetch = globalThis.fetch;
const originalSend = Connection.prototype.sendRawTransaction;

function makeLayer() {
  const config = Layer.succeed(
    ConfigService,
    defaultAppConfig({
      walletPrivateKey: bs58.encode(wallet.secretKey),
      solanaRpcUrl: "https://mock-rpc.invalid",
      solanaRpcFallbackUrl: "",
      sqliteDbPath: ":memory:",
      maxSwapSlippageBps: 50,
      maxSwapPriceImpactBps: 100,
    }),
  );
  const audit = Layer.provide(AuditLive, DbLive(":memory:"));
  return Layer.provide(AdapterLive, Layer.merge(config, audit));
}

function quotePayload(scenario: Scenario): Record<string, unknown> {
  const responseOutputMint = scenario === "mint_mismatch" ? SOL_MINT : outputMint;
  return {
    inputMint: SOL_MINT,
    outputMint: responseOutputMint,
    inAmount: amountAtomic.toString(),
    outAmount: "990000",
    otherAmountThreshold: "980000",
    slippageBps: 50,
    priceImpactPct: scenario === "impact" ? "0.0101" : "0.001",
    routePlan: [
      {
        swapInfo: {
          inputMint: SOL_MINT,
          outputMint: responseOutputMint,
          inAmount: amountAtomic.toString(),
          outAmount: "990000",
        },
        percent: 100,
      },
    ],
  };
}

async function runScenario(scenario: Scenario) {
  let quoteCalls = 0;
  let swapBuildCalls = 0;
  let transactionSends = 0;
  Connection.prototype.sendRawTransaction = async () => {
    transactionSends += 1;
    return "unexpected-signature";
  };
  globalThis.fetch = async (input) => {
    const url = input.toString();
    if (url.includes("/swap/v1/quote")) {
      quoteCalls += 1;
      return new Response(JSON.stringify(quotePayload(scenario)));
    }
    swapBuildCalls += 1;
    return new Response(JSON.stringify({ swapTransaction: "not-base64!!" }));
  };

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
      const selectedQuote =
        scenario === "stale" ? { ...quote, quotedAt: quote.quotedAt - 30_001 } : quote;
      return yield* adapter.prepareSwap(selectedQuote);
    }).pipe(Effect.provide(makeLayer()), Effect.either),
  );

  return {
    scenario,
    rejected: result._tag === "Left",
    quoteCalls,
    swapBuildCalls,
    transactionSends,
  };
}

try {
  const results = [];
  for (const scenario of ["mint_mismatch", "stale", "impact", "malformed_transaction"] as const) {
    results.push(await runScenario(scenario));
  }
  const safe = results.every(
    (result) =>
      result.rejected &&
      result.transactionSends === 0 &&
      (result.scenario === "malformed_transaction"
        ? result.swapBuildCalls === 1
        : result.swapBuildCalls === 0),
  );
  console.log(JSON.stringify({ safe, results }, null, 2));
  if (!safe) process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
  Connection.prototype.sendRawTransaction = originalSend;
}
