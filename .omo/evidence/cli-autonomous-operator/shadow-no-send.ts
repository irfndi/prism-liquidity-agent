import { Effect } from "effect";
import { processSettlementJobs } from "../../../engine/autonomous-runtime.js";
import type { AdapterApi, DbApi } from "../../../engine/services.js";
import type { SettlementJobRecord } from "../../../engine/types.js";

const job: SettlementJobRecord = {
  id: "shadow-job",
  walletAddress: "shadow-wallet",
  agentInstanceId: "primary",
  positionId: "shadow-position",
  poolAddress: "shadow-pool",
  tokenMint: "shadow-mint",
  amountAtomic: "100",
  destinationAsset: "SOL",
  status: "retryable",
  attempts: 1,
  nextRetryAt: null,
  txSignature: null,
  confirmedOutputAtomic: null,
  outputUsd: null,
  executionCostUsd: null,
  realizedPnlUsd: null,
  finalizedAt: null,
  expiresAt: Date.now() - 1,
  error: "pending",
  createdAt: Date.now() - 10,
  updatedAt: Date.now() - 10,
};

let sends = 0;
const failIfCalled = () => {
  sends += 1;
  throw new Error("shadow mode attempted an on-chain send");
};
const adapter = {
  getTokenPrices: failIfCalled,
  quoteSwap: failIfCalled,
  prepareSwap: failIfCalled,
  simulateSwap: failIfCalled,
  submitSwap: failIfCalled,
  getTokenDecimals: failIfCalled,
} as unknown as AdapterApi;
const db = {
  saveSettlementJob: () => Effect.void,
  getPosition: () => Effect.succeed(null),
  closePosition: () => Effect.void,
} as unknown as DbApi;

const result = await Effect.runPromise(
  processSettlementJobs({
    adapter,
    db,
    jobs: [job],
    mode: "shadow",
    now: Date.now(),
    maxSwapSlippageBps: 50,
  }),
);
console.log(JSON.stringify({
  sends,
  before: job,
  after: result[0],
  unchanged: JSON.stringify(result[0]) === JSON.stringify(job),
}, null, 2));
