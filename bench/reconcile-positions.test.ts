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
    getNativeSolBalance: () => Effect.succeed(0),
    getPoolState: () => Effect.fail("not implemented"),
    getBinArray: () => Effect.fail("not implemented"),
    getPositions: () => Effect.succeed([]),
    getAllWalletPositions: () => Effect.succeed([]),
    simulateRebalance: () => Effect.fail("not implemented"),
    enterPosition: () => Effect.fail("not implemented"),
    exitPosition: () => Effect.fail("not implemented"),
    rebalancePosition: () => Effect.fail("not implemented"),
    claimFees: () => Effect.fail("not implemented"),
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
        trackedPositions.set("pool1", makePosition("pool1", "pubkey1"));
        trackedPositions.set("pool2", makePosition("pool2", "pubkey2"));

        yield* db.savePosition(makePosition("pool1", "pubkey1"));
        yield* db.savePosition(makePosition("pool2", "pubkey2"));

        yield* reconcilePositions(adapter, db, memory, trackedPositions, ["pool1", "pool2"]);

        expect(trackedPositions.has("pool1")).toBe(false);
        expect(trackedPositions.has("pool2")).toBe(false);

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
        trackedPositions.set("pool1", makePosition("pool1", "pubkey1"));

        yield* db.savePosition(makePosition("pool1", "pubkey1"));

        yield* reconcilePositions(adapter, db, memory, trackedPositions, ["pool1"]);

        expect(trackedPositions.has("pool1")).toBe(true);

        const all = yield* db.getAllPositions();
        expect(all).toHaveLength(1);
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

        expect(trackedPositions.has("external-pool")).toBe(true);

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

        expect(trackedPositions.has("unwatched-pool")).toBe(false);

        const all = yield* db.getAllPositions();
        expect(all).toHaveLength(0);
      }),
      dbLayer,
    );
  });
});
