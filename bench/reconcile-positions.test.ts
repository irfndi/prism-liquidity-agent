import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { AdapterService, DbService } from "../engine/services.js";
import { DbLive } from "../engine/db-service.js";
import { reconcilePositions } from "../engine/program.js";
import type { AdapterApi, DbApi, MemoryApi } from "../engine/services.js";
import type { PositionRecord } from "../engine/db-service.js";

function run<T>(effect: Effect.Effect<T, unknown, unknown>, layer: unknown): T {
  return Effect.runSync((Effect.provide as any)(effect, layer));
}

function makeMockAdapter(overrides: Partial<AdapterApi> = {}): AdapterApi {
  return {
    hasWallet: () => true,
    getWalletAddress: () => "Wallet111111111111111111111111111111111111111",
    getWalletBalanceUsd: () => Effect.succeed(0),
    getNativeSolBalance: () => Effect.succeed(0n),
    getTokenBalance: () => Effect.succeed(0n),
    getTokenPrices: () => Effect.succeed({}),
    getTokenDecimals: () => Effect.succeed(6),
    getMintAuthorities: () => Effect.succeed({ mintAuthority: null, freezeAuthority: null }),
    quoteSwapUSDCForToken: () => Effect.fail("not implemented"),
    swapUSDCForToken: () => Effect.fail("not implemented"),
    getPoolState: () => Effect.fail("not implemented"),
    getBinArray: () => Effect.fail("not implemented"),
    getPositions: () => Effect.succeed([]),
    getAllWalletPositions: () => Effect.succeed([]),
    simulateRebalance: () => Effect.fail("not implemented"),
    enterPosition: () => Effect.fail("not implemented"),
    exitPosition: () => Effect.fail("not implemented"),
    rebalancePosition: () => Effect.fail("not implemented"),
    claimFees: () => Effect.fail("not implemented"),
    claimRewards: () =>
      Effect.succeed({
        skipped: true,
        skipReason: "no pending rewards",
        txSignatures: [],
        rewards: [],
      }),
    discoverPools: () => Effect.succeed([]),
    reportFeeCollection: () => Effect.void,
    swapUSDCForSOL: () => Effect.void,
    ...overrides,
  };
}

function makeMockMemory(): MemoryApi {
  return {
    initialize: () => Effect.void,
    upsert: () => Effect.void,
    getRelevantContext: () => Effect.succeed([]),
    pruneExpired: () => Effect.succeed(0),
    recordOutcome: () => Effect.void,
  };
}

function makePosition(poolAddress: string, positionPubKey: string | null): PositionRecord {
  return {
    positionId: positionPubKey ?? `paper-${poolAddress}`,
    poolAddress,
    positionPubKey,
    depositedUsd: 1000,
    currentValueUsd: 1000,
    tokenXSymbol: "SOL",
    tokenYSymbol: "USDC",
    activeBinId: 5000,
    lowerBinId: 4980,
    upperBinId: 5020,
    timestamp: Date.now(),
    outOfRangeSince: null,
    oorCycleCount: 0,
    lastFeeClaimAt: Date.now(),
    trailingStopThreshold: null,
    highestValueUsd: null,
    lastRebalanceAt: 0,
    paperExitedAt: null,
    entrySignalTimestamp: null,
    entrySignalSnapshotId: null,
    entryPriceUsd: null,
    entryAmountXUsd: null,
    entryAmountYUsd: null,
    cumulativeFeesClaimedUsd: 0,
    cumulativeRewardsClaimedUsd: 0,
    closedAt: null,
    realizedPnlUsd: null,
  };
}

describe("reconcilePositions — integration", () => {
  it("removes tracked positions that no longer exist on-chain", () => {
    const dbLayer = DbLive(":memory:");

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        const adapter = makeMockAdapter({
          getAllWalletPositions: () => Effect.succeed([]),
        });
        const memory = makeMockMemory();
        const trackedPositions = new Map<string, PositionRecord>();
        trackedPositions.set("pubkey1", makePosition("pool1", "pubkey1"));
        trackedPositions.set("pubkey2", makePosition("pool2", "pubkey2"));

        yield* db.savePosition(makePosition("pool1", "pubkey1"));
        yield* db.savePosition(makePosition("pool2", "pubkey2"));

        const reconciled = yield* reconcilePositions(adapter, db, memory, trackedPositions, [
          "pool1",
          "pool2",
        ]);

        expect(reconciled.succeeded).toBe(true);
        expect(trackedPositions.has("pubkey1")).toBe(false);
        expect(trackedPositions.has("pubkey2")).toBe(false);

        const all = yield* db.getAllPositions();
        expect(all).toHaveLength(0);
      }),
      dbLayer,
    );
  });

  it("does not delete positions on RPC failure", () => {
    const dbLayer = DbLive(":memory:");

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        const adapter = makeMockAdapter({
          getAllWalletPositions: () => Effect.fail("RPC timeout"),
        });
        const memory = makeMockMemory();
        const trackedPositions = new Map<string, PositionRecord>();
        trackedPositions.set("pubkey1", makePosition("pool1", "pubkey1"));

        yield* db.savePosition(makePosition("pool1", "pubkey1"));

        const reconciled = yield* reconcilePositions(adapter, db, memory, trackedPositions, [
          "pool1",
        ]);

        expect(reconciled.succeeded).toBe(false);
        expect(trackedPositions.has("pubkey1")).toBe(true);

        const all = yield* db.getAllPositions();
        expect(all).toHaveLength(1);
      }),
      dbLayer,
    );
  });

  it("syncs a tracked position's range when the same on-chain position has drifted", () => {
    const dbLayer = DbLive(":memory:");

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        // The on-chain position kept its pubkey but its range moved (e.g. an
        // atomic rebalance whose confirmation errored after landing).
        const adapter = makeMockAdapter({
          getAllWalletPositions: () =>
            Effect.succeed([
              {
                poolAddress: "pool1",
                positionPubKey: "pubkey1",
                lowerBinId: 4990,
                upperBinId: 5030,
              },
            ]),
        });
        const memory = makeMockMemory();
        const trackedPositions = new Map<string, PositionRecord>();
        trackedPositions.set("pubkey1", makePosition("pool1", "pubkey1"));

        yield* db.savePosition(makePosition("pool1", "pubkey1"));

        const reconciled = yield* reconcilePositions(adapter, db, memory, trackedPositions, [
          "pool1",
        ]);

        expect(reconciled.succeeded).toBe(true);
        const tracked = trackedPositions.get("pubkey1")!;
        expect(tracked.positionPubKey).toBe("pubkey1");
        expect(tracked.lowerBinId).toBe(4990);
        expect(tracked.upperBinId).toBe(5030);
        // Identity + accounting fields are untouched by the range sync.
        expect(tracked.depositedUsd).toBe(1000);

        const all = yield* db.getAllPositions();
        expect(all).toHaveLength(1);
        expect(all[0]!.lowerBinId).toBe(4990);
        expect(all[0]!.upperBinId).toBe(5030);
      }),
      dbLayer,
    );
  });

  it("removes a tracked position whose pubkey vanished and discovers its replacement", () => {
    const dbLayer = DbLive(":memory:");

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        // pubkey1 is gone from the wallet while a different pubkey now exists
        // on the same pool — per-pubkey matching treats the first as an
        // external close and the second as a new discovery. Ranges are never
        // copied across distinct pubkeys.
        const adapter = makeMockAdapter({
          getAllWalletPositions: () =>
            Effect.succeed([
              {
                poolAddress: "pool1",
                positionPubKey: "some-other-pubkey",
                lowerBinId: 4990,
                upperBinId: 5030,
              },
            ]),
          getPoolState: () =>
            Effect.succeed({
              address: "pool1",
              tokenX: "SOL",
              tokenY: "USDC",
              tokenXSymbol: "SOL",
              tokenYSymbol: "USDC",
              tvlUsd: 100_000,
              volume24hUsd: 30_000,
              fees24hUsd: 300,
              apr: 60,
              activeBinId: 5000,
              binStep: 10,
              currentPrice: 150,
              timestamp: Date.now(),
            }),
        });
        const memory = makeMockMemory();
        const trackedPositions = new Map<string, PositionRecord>();
        trackedPositions.set("pubkey1", makePosition("pool1", "pubkey1"));

        yield* db.savePosition(makePosition("pool1", "pubkey1"));

        yield* reconcilePositions(adapter, db, memory, trackedPositions, ["pool1"]);

        expect(trackedPositions.has("pubkey1")).toBe(false);
        const discovered = trackedPositions.get("some-other-pubkey")!;
        expect(discovered.positionPubKey).toBe("some-other-pubkey");
        expect(discovered.lowerBinId).toBe(4990);
        expect(discovered.upperBinId).toBe(5030);
        // The discovered position starts with clean accounting — nothing was
        // carried over from the removed row.
        expect(discovered.depositedUsd).toBe(0);
        expect(discovered.cumulativeFeesClaimedUsd).toBe(0);
      }),
      dbLayer,
    );
  });

  it("discovers external positions in watched pools", () => {
    const dbLayer = DbLive(":memory:");

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        const adapter = makeMockAdapter({
          getAllWalletPositions: () =>
            Effect.succeed([
              {
                poolAddress: "external-pool",
                positionPubKey: "external-pubkey",
                lowerBinId: 4980,
                upperBinId: 5020,
              },
            ]),
          getPoolState: () =>
            Effect.succeed({
              address: "external-pool",
              tokenX: "SOL",
              tokenY: "USDC",
              tokenXSymbol: "SOL",
              tokenYSymbol: "USDC",
              tvlUsd: 100_000,
              volume24hUsd: 30_000,
              fees24hUsd: 300,
              apr: 60,
              activeBinId: 5000,
              binStep: 10,
              currentPrice: 150,
              timestamp: Date.now(),
            }),
        });
        const memory = makeMockMemory();
        const trackedPositions = new Map<string, PositionRecord>();

        yield* reconcilePositions(adapter, db, memory, trackedPositions, ["external-pool"]);

        expect(trackedPositions.has("external-pubkey")).toBe(true);

        const all = yield* db.getAllPositions();
        expect(all).toHaveLength(1);
        const first = all[0];
        expect(first).toBeDefined();
        if (first) {
          expect(first.poolAddress).toBe("external-pool");
          expect(first.positionPubKey).toBe("external-pubkey");
        }
      }),
      dbLayer,
    );
  });

  it("skips discovery for pools not in watchlist", () => {
    const dbLayer = DbLive(":memory:");

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        const adapter = makeMockAdapter({
          getAllWalletPositions: () =>
            Effect.succeed([
              {
                poolAddress: "unwatched-pool",
                positionPubKey: "external-pubkey",
                lowerBinId: 4980,
                upperBinId: 5020,
              },
            ]),
        });
        const memory = makeMockMemory();
        const trackedPositions = new Map<string, PositionRecord>();

        yield* reconcilePositions(adapter, db, memory, trackedPositions, ["watched-pool"]);

        expect(trackedPositions.has("external-pubkey")).toBe(false);

        const all = yield* db.getAllPositions();
        expect(all).toHaveLength(0);
      }),
      dbLayer,
    );
  });

  it("marks approved external positions unresolved when pool state cannot be fetched", () => {
    const dbLayer = DbLive(":memory:");

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        const adapter = makeMockAdapter({
          getAllWalletPositions: () =>
            Effect.succeed([
              {
                poolAddress: "unresolved-pool",
                positionPubKey: "external-pubkey",
                lowerBinId: 4980,
                upperBinId: 5020,
              },
            ]),
          getPoolState: () => Effect.fail("pool unavailable"),
        });
        const memory = makeMockMemory();
        const trackedPositions = new Map<string, PositionRecord>();

        const result = yield* reconcilePositions(adapter, db, memory, trackedPositions, [
          "unresolved-pool",
        ]);

        expect(result.succeeded).toBe(true);
        expect(result.unresolvedPoolAddresses.has("unresolved-pool")).toBe(true);
        expect(trackedPositions.has("external-pubkey")).toBe(false);
      }),
      dbLayer,
    );
  });
});
