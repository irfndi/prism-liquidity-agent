import { Effect } from "effect";
import { advanceScreenedCandidates } from "../../../engine/candidate-discovery.js";
import { DbLive } from "../../../engine/db-service.js";
import { DbService } from "../../../engine/services.js";
import type { ScreenedPool, TokenPriceEvidence } from "../../../engine/services.js";

const dbPath = process.env.SQLITE_DB_PATH;
if (!dbPath) throw new Error("SQLITE_DB_PATH is required");
const pool: ScreenedPool = {
  address: "restart-pool",
  tvlUsd: 1_000_000,
  volume24hUsd: 300_000,
  fees24hUsd: 3_000,
  apr: 30,
  feeIlRatio: 2,
  volumeAuth: 0.9,
  binUtilization: 0.5,
  tokenX: "So11111111111111111111111111111111111111112",
  tokenY: "restart-mint",
};
const evidence = (observedAt: number): readonly TokenPriceEvidence[] => [
  { mint: pool.tokenX, priceUsd: 150, observedAt, fallbackUsed: false },
  { mint: pool.tokenY, priceUsd: 1, observedAt, fallbackUsed: false },
];
const phase = process.env.PHASE ?? "resume";

if (phase === "seed") {
  const result = advanceScreenedCandidates({
    walletAddress: "paper",
    agentInstanceId: "primary",
    screenedPools: [pool],
    existingCandidates: [],
    priceEvidence: evidence(1_000),
    routeAvailableMints: new Set([pool.tokenY]),
    now: 1_000,
    policy: { minHealthyScans: 2, minObservationMs: 1_000 },
    maxMarketDataAgeMs: 5_000,
  });
  await Effect.runPromise(Effect.gen(function* () {
    const db = yield* DbService;
    for (const candidate of result.updatedCandidates) yield* db.saveTokenCandidate(candidate);
  }).pipe(Effect.provide(DbLive(dbPath))));
  console.log(JSON.stringify({ phase, candidate: result.updatedCandidates[0] }, null, 2));
} else {
  const persisted = await Effect.runPromise(Effect.gen(function* () {
    const db = yield* DbService;
    return yield* db.listTokenCandidates("paper", "primary");
  }).pipe(Effect.provide(DbLive(dbPath))));
  const result = advanceScreenedCandidates({
    walletAddress: "paper",
    agentInstanceId: "primary",
    screenedPools: [pool],
    existingCandidates: persisted,
    priceEvidence: evidence(2_000),
    routeAvailableMints: new Set([pool.tokenY]),
    now: 2_000,
    policy: { minHealthyScans: 2, minObservationMs: 1_000 },
    maxMarketDataAgeMs: 5_000,
  });
  console.log(JSON.stringify({ phase, persisted, resumed: result.updatedCandidates[0], eligiblePoolAddresses: result.eligiblePoolAddresses }, null, 2));
}
