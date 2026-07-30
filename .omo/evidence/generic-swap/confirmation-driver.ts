import { Effect, Layer } from "effect";
import { Connection, Keypair, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { AdapterService } from "../../../engine/services.js";
import { AdapterLive } from "../../../engine/adapter-service.js";
import { ConfigService } from "../../../engine/config-service.js";
import { AuditLive } from "../../../engine/audit-service.js";
import { DbLive } from "../../../engine/db-service.js";
import { defaultAppConfig } from "../../../bench/helpers.js";
import { SOL_MINT } from "../../../engine/constants.js";

const wallet = Keypair.generate();
const outputMint = Keypair.generate().publicKey.toBase58();
const amountAtomic = 1_000_000n;
const message = new TransactionMessage({
  payerKey: wallet.publicKey,
  recentBlockhash: "11111111111111111111111111111111",
  instructions: [],
}).compileToV0Message();
const transactionBase64 = Buffer.from(new VersionedTransaction(message).serialize()).toString(
  "base64",
);
const originalFetch = globalThis.fetch;
const originalSimulate = Connection.prototype.simulateTransaction;
const originalSend = Connection.prototype.sendRawTransaction;
const originalConfirm = Connection.prototype.confirmTransaction;
let releaseConfirmation: (() => void) | undefined;
let confirmCalls = 0;

const config = Layer.succeed(
  ConfigService,
  defaultAppConfig({
    walletPrivateKey: bs58.encode(wallet.secretKey),
    solanaRpcUrl: "https://mock-rpc.invalid",
    solanaRpcFallbackUrl: "",
    sqliteDbPath: ":memory:",
  }),
);
const layer = Layer.provide(
  AdapterLive,
  Layer.merge(config, Layer.provide(AuditLive, DbLive(":memory:"))),
);

try {
  globalThis.fetch = async (input) =>
    input.toString().includes("/swap/v1/quote")
      ? new Response(
          JSON.stringify({
            inputMint: SOL_MINT,
            outputMint,
            inAmount: amountAtomic.toString(),
            outAmount: "990000",
            otherAmountThreshold: "980000",
            slippageBps: 50,
            priceImpactPct: "0.001",
            routePlan: [
              {
                swapInfo: {
                  inputMint: SOL_MINT,
                  outputMint,
                  inAmount: amountAtomic.toString(),
                  outAmount: "990000",
                },
                percent: 100,
              },
            ],
          }),
        )
      : new Response(JSON.stringify({ swapTransaction: transactionBase64 }));
  Connection.prototype.simulateTransaction = async () => ({
    context: { slot: 1 },
    value: { err: null, logs: [], unitsConsumed: 1 },
  });
  Connection.prototype.sendRawTransaction = async () => "confirmation-driver-sig";
  Connection.prototype.confirmTransaction = async () => {
    confirmCalls += 1;
    return new Promise((resolve) => {
      releaseConfirmation = () => resolve({ context: { slot: 2 }, value: { err: null } });
    });
  };

  let settled = false;
  const execution = Effect.runPromise(
    Effect.gen(function* () {
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
        inputMint: SOL_MINT,
        outputMint,
        amountAtomic,
        slippageBps: 50,
      });
      const prepared = yield* adapter.prepareSwap(quote);
      yield* adapter.simulateSwap(prepared);
      return yield* adapter.submitSwap(prepared);
    }).pipe(Effect.provide(layer)),
  ).then((signature) => {
    settled = true;
    return signature;
  });

  while (confirmCalls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  const settledBeforeConfirmation = settled;
  releaseConfirmation?.();
  const signature = await execution;
  const result = {
    safe: !settledBeforeConfirmation && settled,
    confirmCalls,
    settledBeforeConfirmation,
    settledAfterConfirmation: settled,
    signature,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.safe) process.exitCode = 1;
} finally {
  releaseConfirmation?.();
  globalThis.fetch = originalFetch;
  Connection.prototype.simulateTransaction = originalSimulate;
  Connection.prototype.sendRawTransaction = originalSend;
  Connection.prototype.confirmTransaction = originalConfirm;
}
