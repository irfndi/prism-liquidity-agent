import { Effect } from "effect";
import {
  isActionAllowedDuringSafetyPause,
  processSettlementJobs,
} from "../../../engine/autonomous-runtime.ts";

const now = 1_000;
const job = {
  id: "settlement-1",
  walletAddress: "wallet-1",
  agentInstanceId: "primary",
  positionId: "position-1",
  poolAddress: "pool-1",
  tokenMint: "mint-1",
  amountAtomic: "1000000",
  destinationAsset: "SOL",
  status: "pending",
  attempts: 0,
  nextRetryAt: now,
  txSignature: null,
  expiresAt: now + 3_600_000,
  error: null,
  createdAt: now,
  updatedAt: now,
};

let sends = 0;
const shadowAdapter = new Proxy(
  {},
  {
    get() {
      return () => {
        sends += 1;
        throw new Error("shadow adapter call");
      };
    },
  },
);
const shadowDb = new Proxy(
  {},
  {
    get() {
      return () => Effect.die("shadow db write");
    },
  },
);
const shadow = await Effect.runPromise(
  processSettlementJobs({
    adapter: shadowAdapter,
    db: shadowDb,
    jobs: [job],
    mode: "shadow",
    now,
    maxSwapSlippageBps: 50,
  }),
);

const persisted = [];
const failureAdapter = {
  getTokenPrices: () => Effect.fail(new Error("price outage")),
};
const failureDb = {
  saveSettlementJob: (record) =>
    Effect.sync(() => {
      persisted.push(record);
    }),
};
const failed = await Effect.runPromise(
  processSettlementJobs({
    adapter: failureAdapter,
    db: failureDb,
    jobs: [job],
    mode: "live",
    now,
    maxSwapSlippageBps: 50,
  }),
);

const observable = {
  shadow: {
    sends,
    unchanged: shadow[0]?.status === "pending",
  },
  failure: {
    status: failed[0]?.status,
    attempts: failed[0]?.attempts,
    persistedStatus: persisted[0]?.status,
  },
  pause: {
    enterAllowed: isActionAllowedDuringSafetyPause("ENTER"),
    exitAllowed: isActionAllowedDuringSafetyPause("EXIT"),
  },
};

if (
  observable.shadow.sends !== 0 ||
  !observable.shadow.unchanged ||
  observable.failure.status !== "retryable" ||
  observable.failure.persistedStatus !== "retryable" ||
  observable.pause.enterAllowed ||
  !observable.pause.exitAllowed
) {
  throw new Error(`manual driver failed: ${JSON.stringify(observable)}`);
}

console.log(JSON.stringify(observable));
