import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { DbService } from "../engine/services.js";
import { DbLive } from "../engine/db-service.js";
import { reconcilePositions } from "../engine/program.js";
import type { AdapterApi, MemoryApi } from "../engine/services.js";
import type { PositionRecord } from "../engine/db-service.js";

function run<T, E, R>(effect: Effect.Effect<T, E, R>, layer: Layer.Layer<R, never, never>): T {
  return Effect.runSync(Effect.provide(effect, layer));
}

function makeMockAdapter(overrides: Partial<AdapterApi> = {}): AdapterApi {
  return {
    hasWallet: () => true,
    getWalletAddress: () => "Wallet111111111111111111111111111111111111111",
    getWalletBalanceUsd: () => Effect.succeed(0),
    getWalletHoldings: () =>
      Effect.succeed(new Map<string, { amountAtomic: bigint; decimals: number }>()),
    getNativeSolBalance: () => Effect.succeed(0n),
    getTokenBalance: () => Effect.succeed(0n),
    getTokenPrices: () => Effect.succeed({}),
    getTokenDecimals: () => Effect.succeed(6),
    getMintAuthorities: () => Effect.succeed({ mintAuthority: null, freezeAuthority: null }),
    quoteSwapUSDCForToken: () => Effect.fail(new Error("not implemented")),
    swapUSDCForToken: () => Effect.fail(new Error("not implemented")),
    getPoolState: () => Effect.fail(new Error("not implemented")),
    getBinArray: () => Effect.fail(new Error("not implemented")),
    getPositions: () => Effect.succeed([]),
    getAllWalletPositions: () => Effect.succeed([]),
    simulateRebalance: () => Effect.fail(new Error("not implemented")),
    enterPosition: () => Effect.fail(new Error("not implemented")),
    exitPosition: () => Effect.fail(new Error("not implemented")),
    rebalancePosition: () => Effect.fail(new Error("not implemented")),
    claimFees: () => Effect.fail(new Error("not implemented")),
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
          getAllWalletPositions: () => Effect.fail(new Error("RPC timeout")),
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

  it("does not re-admit a reaped-empty position while its tombstone is active", () => {
    const dbLayer = DbLive(":memory:");

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        // The reaped-empty ghost remains in the wallet's on-chain set (rent
        // reclaim failed), so getAllWalletPositions still returns it.
        const adapter = makeMockAdapter({
          getAllWalletPositions: () =>
            Effect.succeed([
              {
                poolAddress: "external-pool",
                positionPubKey: "ghost-pubkey",
                lowerBinId: 4980,
                upperBinId: 5020,
              },
            ]),
        });
        // An ACTIVE tombstone (set by the empty-reap path in executeLive).
        yield* db.setMetadata(
          "reaped_empty:ghost-pubkey",
          String(Date.now() + 24 * 60 * 60 * 1000),
        );
        const memory = makeMockMemory();
        const trackedPositions = new Map<string, PositionRecord>();

        yield* reconcilePositions(adapter, db, memory, trackedPositions, ["external-pool"]);

        // The ghost must NOT be re-added to tracking or the ledger.
        expect(trackedPositions.has("ghost-pubkey")).toBe(false);
        const all = yield* db.getAllPositions();
        expect(all).toHaveLength(0);
      }),
      dbLayer,
    );
  });

  it("re-admits a reaped-empty position once its tombstone has expired", () => {
    const dbLayer = DbLive(":memory:");

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        const adapter = makeMockAdapter({
          getAllWalletPositions: () =>
            Effect.succeed([
              {
                poolAddress: "external-pool",
                positionPubKey: "refilled-pubkey",
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
        // EXPIRED tombstone: a later legitimate refill must be re-admitted.
        yield* db.setMetadata("reaped_empty:refilled-pubkey", String(Date.now() - 1));
        const memory = makeMockMemory();
        const trackedPositions = new Map<string, PositionRecord>();

        yield* reconcilePositions(adapter, db, memory, trackedPositions, ["external-pool"]);

        expect(trackedPositions.has("refilled-pubkey")).toBe(true);
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
          getPoolState: () => Effect.fail(new Error("pool unavailable")),
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

  // ─── Data API add-only fallback ─────────────────────────────────────────────
  // getWalletPositionsFromDatapi is consulted ONLY when the authoritative
  // on-chain read fails. Its contract: it may discover and add NEW external
  // positions, but it must NEVER delete or range-sync an existing tracked
  // position (the Data API is a delayed third-party view that can lag/omit).

  it("falls back to the Data API and discovers a new external position when the chain read fails", () => {
    const dbLayer = DbLive(":memory:");

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        const adapter = makeMockAdapter({
          getAllWalletPositions: () => Effect.fail(new Error("RPC 429")),
          getWalletPositionsFromDatapi: () =>
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

        const result = yield* reconcilePositions(adapter, db, memory, trackedPositions, [
          "external-pool",
        ]);

        // The Data API fallback succeeded, so the reconcile is not a failure.
        expect(result.succeeded).toBe(true);
        expect(trackedPositions.has("external-pubkey")).toBe(true);
        const discovered = trackedPositions.get("external-pubkey")!;
        expect(discovered.lowerBinId).toBe(4980);
        expect(discovered.upperBinId).toBe(5020);
      }),
      dbLayer,
    );
  });

  it("never removes a tracked position when the Data API omits it (add-only)", () => {
    const dbLayer = DbLive(":memory:");

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        // Chain read fails; the Data API crawl returns a PARTIAL view that
        // omits pubkey1 (stale/transient). The tracked position must survive —
        // a Data API feed must never drive a deletion.
        const adapter = makeMockAdapter({
          getAllWalletPositions: () => Effect.fail(new Error("RPC 429")),
          getWalletPositionsFromDatapi: () =>
            Effect.succeed([
              {
                poolAddress: "pool2",
                positionPubKey: "pubkey2",
                lowerBinId: 4900,
                upperBinId: 5100,
              },
            ]),
        });
        const memory = makeMockMemory();
        const trackedPositions = new Map<string, PositionRecord>();
        trackedPositions.set("pubkey1", makePosition("pool1", "pubkey1"));

        yield* db.savePosition(makePosition("pool1", "pubkey1"));

        const result = yield* reconcilePositions(adapter, db, memory, trackedPositions, [
          "pool1",
          "pool2",
        ]);

        expect(result.succeeded).toBe(true);
        // pubkey1 is NOT deleted even though the Data API omitted it.
        expect(trackedPositions.has("pubkey1")).toBe(true);
        const all = yield* db.getAllPositions();
        expect(all.some((p) => p.positionPubKey === "pubkey1")).toBe(true);
      }),
      dbLayer,
    );
  });

  it("never range-syncs a tracked position from the Data API (chain-only sync)", () => {
    const dbLayer = DbLive(":memory:");

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        const adapter = makeMockAdapter({
          getAllWalletPositions: () => Effect.fail(new Error("RPC 429")),
          // Data API reports a DIFFERENT (stale) range for the tracked
          // position under the same pubkey. The tracked record must keep its
          // authoritative range — the Data API path must not mutate it.
          getWalletPositionsFromDatapi: () =>
            Effect.succeed([
              {
                poolAddress: "pool1",
                positionPubKey: "pubkey1",
                lowerBinId: 9990,
                upperBinId: 9999,
              },
            ]),
        });
        const memory = makeMockMemory();
        const trackedPositions = new Map<string, PositionRecord>();
        trackedPositions.set("pubkey1", makePosition("pool1", "pubkey1"));

        yield* db.savePosition(makePosition("pool1", "pubkey1"));

        const result = yield* reconcilePositions(adapter, db, memory, trackedPositions, ["pool1"]);

        expect(result.succeeded).toBe(true);
        const tracked = trackedPositions.get("pubkey1")!;
        expect(tracked.lowerBinId).toBe(4980); // unchanged (authoritative)
        expect(tracked.upperBinId).toBe(5020);
        const all = yield* db.getAllPositions();
        expect(all[0]!.lowerBinId).toBe(4980);
        expect(all[0]!.upperBinId).toBe(5020);
      }),
      dbLayer,
    );
  });

  it("keeps current behavior when the Data API fallback is unavailable", () => {
    const dbLayer = DbLive(":memory:");

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        // No getWalletPositionsFromDatapi on the adapter (e.g. a mock that does
        // not implement it) — the chain failure degrades exactly as before.
        const adapter = makeMockAdapter({
          getAllWalletPositions: () => Effect.fail(new Error("RPC timeout")),
        });
        const memory = makeMockMemory();
        const trackedPositions = new Map<string, PositionRecord>();
        trackedPositions.set("pubkey1", makePosition("pool1", "pubkey1"));

        yield* db.savePosition(makePosition("pool1", "pubkey1"));

        const result = yield* reconcilePositions(adapter, db, memory, trackedPositions, ["pool1"]);

        expect(result.succeeded).toBe(false);
        expect(trackedPositions.has("pubkey1")).toBe(true);
        const all = yield* db.getAllPositions();
        expect(all).toHaveLength(1);
      }),
      dbLayer,
    );
  });

  it("does not consult the Data API when the chain read succeeds", () => {
    const dbLayer = DbLive(":memory:");

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        let datapiConsulted = false;
        const adapter = makeMockAdapter({
          getAllWalletPositions: () => Effect.succeed([]),
          getWalletPositionsFromDatapi: () => {
            datapiConsulted = true;
            return Effect.succeed([]);
          },
        });
        const memory = makeMockMemory();
        const trackedPositions = new Map<string, PositionRecord>();
        trackedPositions.set("pubkey1", makePosition("pool1", "pubkey1"));

        yield* db.savePosition(makePosition("pool1", "pubkey1"));

        const result = yield* reconcilePositions(adapter, db, memory, trackedPositions, ["pool1"]);

        expect(result.succeeded).toBe(true);
        // Chain-only path: the Data API is never consulted when chain is healthy.
        expect(datapiConsulted).toBe(false);
        // Chain reports empty → pubkey1 is genuinely gone → removed (authoritative).
        expect(trackedPositions.has("pubkey1")).toBe(false);
      }),
      dbLayer,
    );
  });
});
