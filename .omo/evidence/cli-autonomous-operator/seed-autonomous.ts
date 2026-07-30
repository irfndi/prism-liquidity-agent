import { Effect } from "effect";
import { DbLive } from "../../../engine/db-service.js";
import { DbService } from "../../../engine/services.js";

const walletAddress = process.env.WALLET_ADDRESS;
const agentInstanceId = process.env.AGENT_INSTANCE_ID;
const dbPath = process.env.SQLITE_DB_PATH;
if (!walletAddress || !agentInstanceId || !dbPath) throw new Error("missing QA environment");

await Effect.runPromise(
  Effect.gen(function* () {
    const db = yield* DbService;
    yield* db.saveTokenCandidate({
      id: "qa-candidate",
      walletAddress,
      agentInstanceId,
      poolAddress: "qa-pool",
      tokenMint: "qa-mint",
      state: "eligible",
      healthyScanCount: 6,
      firstSeenAt: 1_000,
      lastSeenAt: 2_000,
      eligibleAt: 2_000,
      enteredAt: null,
      cooldownUntil: null,
      rejectionReason: null,
      createdAt: 1_000,
      updatedAt: 2_000,
    });
    yield* db.saveExecutionOperation({
      id: "qa-operation",
      walletAddress,
      agentInstanceId,
      candidateId: "qa-candidate",
      positionId: null,
      poolAddress: "qa-pool",
      tokenMint: "qa-mint",
      operationType: "entry",
      status: "prepared",
      amountAtomic: "100",
      txSignature: null,
      error: null,
      createdAt: 3_000,
      updatedAt: 3_000,
    });
    yield* db.saveSettlementJob({
      id: "qa-settlement",
      walletAddress,
      agentInstanceId,
      positionId: "qa-position",
      poolAddress: "qa-pool",
      tokenMint: "qa-mint",
      amountAtomic: "99",
      destinationAsset: "SOL",
      status: "retryable",
      attempts: 2,
      nextRetryAt: 4_000,
      txSignature: null,
      error: "rpc unavailable",
      expiresAt: 5_000,
      createdAt: 3_000,
      updatedAt: 3_000,
    });
    yield* db.saveSafetyPause({
      walletAddress,
      agentInstanceId,
      reason: "settlement_overdue",
      triggeredAt: 3_000,
      resolvedAt: null,
    });
  }).pipe(Effect.provide(DbLive(dbPath))),
);
