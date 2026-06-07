import { describe, it, expect, vi } from "vitest";
import { Effect, Layer } from "effect";
import { AdapterService, DbService } from "../engine/services.js";
import { DbLive } from "../engine/db-service.js";

function run<T>(effect: Effect.Effect<T, unknown, unknown>, layer: unknown): T {
  return Effect.runSync((Effect.provide as any)(effect, layer));
}

describe("Position reconciliation — adapter API", () => {
  it("AdapterApi exposes getAllWalletPositions", () => {
    const mockAdapter = {
      hasWallet: () => true,
      getWalletAddress: () => "Wallet111111111111111111111111111111111111111",
      getWalletBalanceUsd: () => Effect.succeed(0),
      getNativeSolBalance: () => Effect.succeed(0),
      getPoolState: () => Effect.fail("not implemented"),
      getBinArray: () => Effect.fail("not implemented"),
      getPositions: () => Effect.succeed([]),
      getAllWalletPositions: () =>
        Effect.succeed([
          {
            poolAddress: "Pool111111111111111111111111111111111111111",
            positionPubKey: "Pos1111111111111111111111111111111111111111",
            lowerBinId: 4980,
            upperBinId: 5020,
          },
        ]),
      simulateRebalance: () => Effect.fail("not implemented"),
      enterPosition: () => Effect.fail("not implemented"),
      exitPosition: () => Effect.fail("not implemented"),
      rebalancePosition: () => Effect.fail("not implemented"),
      claimFees: () => Effect.fail("not implemented"),
      discoverPools: () => Effect.succeed([]),
      reportFeeCollection: () => {},
      swapUSDCForSOL: () => Effect.void,
    };

    const layer = Layer.succeed(AdapterService, mockAdapter);

    const result = run(
      Effect.gen(function* () {
        const adapter = yield* AdapterService;
        const positions = yield* adapter.getAllWalletPositions("wallet");
        return positions;
      }),
      layer,
    );

    expect(result).toHaveLength(1);
    const first = result[0];
    expect(first).toBeDefined();
    if (first) {
      expect(first.poolAddress).toBe("Pool111111111111111111111111111111111111111");
      expect(first.positionPubKey).toBe("Pos1111111111111111111111111111111111111111");
    }
  });

  it("getAllWalletPositions returns empty array when no positions", () => {
    const mockAdapter = {
      hasWallet: () => true,
      getWalletAddress: () => "wallet",
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
      reportFeeCollection: () => {},
      swapUSDCForSOL: () => Effect.void,
    };

    const layer = Layer.succeed(AdapterService, mockAdapter);

    const result = run(
      Effect.gen(function* () {
        const adapter = yield* AdapterService;
        return yield* adapter.getAllWalletPositions("wallet");
      }),
      layer,
    );

    expect(result).toHaveLength(0);
  });

  it("does not delete positions on RPC failure (returns null, not empty)", () => {
    const mockAdapter = {
      hasWallet: () => true,
      getWalletAddress: () => "wallet",
      getWalletBalanceUsd: () => Effect.succeed(0),
      getNativeSolBalance: () => Effect.succeed(0),
      getPoolState: () => Effect.fail("not implemented"),
      getBinArray: () => Effect.fail("not implemented"),
      getPositions: () => Effect.fail("RPC timeout"),
      getAllWalletPositions: () => Effect.fail("RPC timeout"),
      simulateRebalance: () => Effect.fail("not implemented"),
      enterPosition: () => Effect.fail("not implemented"),
      exitPosition: () => Effect.fail("not implemented"),
      rebalancePosition: () => Effect.fail("not implemented"),
      claimFees: () => Effect.fail("not implemented"),
      discoverPools: () => Effect.succeed([]),
      reportFeeCollection: () => {},
      swapUSDCForSOL: () => Effect.void,
    };

    const layer = Layer.succeed(AdapterService, mockAdapter);
    let loggedError = false;
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      if (args[0] === "Reconcile: failed to fetch on-chain positions — skipping") {
        loggedError = true;
      }
    };

    try {
      run(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          const result = yield* adapter
            .getAllWalletPositions("wallet")
            .pipe(Effect.catchAll(() => Effect.succeed(null)));
          return result;
        }),
        layer,
      );
    } finally {
      console.error = originalError;
    }

    expect(loggedError).toBe(false);
  });
});

describe("Position reconciliation — DB operations", () => {
  it("deletes a tracked position from DB", () => {
    const layer = DbLive(":memory:");

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition({
          poolAddress: "pool1",
          positionPubKey: "pubkey1",
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
        });

        const before = yield* db.getAllPositions();
        expect(before).toHaveLength(1);

        yield* db.deletePosition("pool1");

        const after = yield* db.getAllPositions();
        expect(after).toHaveLength(0);
      }),
      layer,
    );
  });

  it("distinguishes tracked vs paper-exited positions", () => {
    const layer = DbLive(":memory:");

    run(
      Effect.gen(function* () {
        const db = yield* DbService;

        yield* db.savePosition({
          poolAddress: "pool-active",
          positionPubKey: "pubkey1",
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
        });

        yield* db.savePosition({
          poolAddress: "pool-exited",
          positionPubKey: "pubkey2",
          depositedUsd: 500,
          currentValueUsd: 500,
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
          paperExitedAt: Date.now(),
        });

        const all = yield* db.getAllPositions();
        expect(all).toHaveLength(1);
        const active = all[0];
        expect(active).toBeDefined();
        if (active) {
          expect(active.poolAddress).toBe("pool-active");
        }

        const exited = yield* db.getPaperExitedPositions();
        expect(exited).toHaveLength(1);
        const firstExited = exited[0];
        expect(firstExited).toBeDefined();
        if (firstExited) {
          expect(firstExited.poolAddress).toBe("pool-exited");
        }
      }),
      layer,
    );
  });
});
