import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { advanceScreenedCandidates } from "../engine/candidate-discovery.js";
import { DbLive } from "../engine/db-service.js";
import { DbService, type ScreenedPool, type TokenPriceEvidence } from "../engine/services.js";

const pool: ScreenedPool = {
  address: "pool-1",
  tvlUsd: 1_000_000,
  volume24hUsd: 300_000,
  fees24hUsd: 3_000,
  apr: 30,
  feeIlRatio: 2,
  volumeAuth: 0.9,
  binUtilization: 0.5,
  tokenX: "So11111111111111111111111111111111111111112",
  tokenY: "mint-1",
};

function evidence(observedAt: number): readonly TokenPriceEvidence[] {
  return [
    {
      mint: "So11111111111111111111111111111111111111112",
      priceUsd: 150,
      observedAt,
      fallbackUsed: false,
    },
    { mint: "mint-1", priceUsd: 1, observedAt, fallbackUsed: false },
  ];
}

describe("candidate discovery persistence", () => {
  let testDir: string | null = null;

  afterEach(() => {
    if (testDir !== null) rmSync(testDir, { recursive: true, force: true });
  });

  it("resumes a persisted observation streak after a process restart", async () => {
    // Given
    testDir = mkdtempSync(join(tmpdir(), "prism-candidate-discovery-"));
    const dbPath = join(testDir, "prism.db");
    const first = advanceScreenedCandidates({
      walletAddress: "paper",
      agentInstanceId: "primary",
      screenedPools: [pool],
      existingCandidates: [],
      priceEvidence: evidence(1_000),
      routeAvailableMints: new Set(["mint-1"]),
      now: 1_000,
      policy: { minHealthyScans: 2, minObservationMs: 1_000 },
      maxMarketDataAgeMs: 5_000,
    });
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const db = yield* DbService;
          for (const candidate of first.updatedCandidates) yield* db.saveTokenCandidate(candidate);
        }),
        DbLive(dbPath),
      ),
    );

    // When
    const persisted = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const db = yield* DbService;
          return yield* db.listTokenCandidates("paper", "primary");
        }),
        DbLive(dbPath),
      ),
    );
    const resumed = advanceScreenedCandidates({
      walletAddress: "paper",
      agentInstanceId: "primary",
      screenedPools: [pool],
      existingCandidates: persisted,
      priceEvidence: evidence(2_000),
      routeAvailableMints: new Set(["mint-1"]),
      now: 2_000,
      policy: { minHealthyScans: 2, minObservationMs: 1_000 },
      maxMarketDataAgeMs: 5_000,
    });

    // Then
    expect(resumed.updatedCandidates[0]).toMatchObject({
      state: "eligible",
      healthyScanCount: 2,
      eligibleAt: 2_000,
    });
    expect(resumed.eligiblePoolAddresses).toEqual(["pool-1"]);
  });
});
