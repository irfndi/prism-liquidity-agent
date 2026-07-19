import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { DbLive } from "../engine/db-service.js";
import { DbService } from "../engine/services.js";

function run<T>(effect: Effect.Effect<T, unknown, unknown>, layer: unknown): T {
  return Effect.runSync((Effect.provide as any)(effect, layer));
}

function makePosition(
  overrides: Partial<{
    positionId: string;
    poolAddress: string;
    positionPubKey: string | null;
    depositedUsd: number;
    currentValueUsd: number;
    highestValueUsd: number | null;
    trailingStopThreshold: number | null;
    lastRebalanceAt: number;
    paperExitedAt: number | null;
    entrySignalTimestamp: number | null;
    entrySignalSnapshotId: number | null;
  }> = {},
) {
  const poolAddress = overrides.poolAddress ?? "Pool111111111111111111111111111111111111111";
  const positionPubKey = overrides.positionPubKey ?? null;
  return {
    positionId: overrides.positionId ?? positionPubKey ?? `paper-${poolAddress}`,
    poolAddress,
    positionPubKey,
    depositedUsd: overrides.depositedUsd ?? 1000,
    currentValueUsd: overrides.currentValueUsd ?? 1000,
    tokenXSymbol: "SOL",
    tokenYSymbol: "USDC",
    activeBinId: 5000,
    lowerBinId: 4980,
    upperBinId: 5020,
    timestamp: Date.now(),
    outOfRangeSince: null,
    oorCycleCount: 0,
    lastFeeClaimAt: Date.now(),
    trailingStopThreshold: overrides.trailingStopThreshold ?? null,
    highestValueUsd: overrides.highestValueUsd ?? null,
    lastRebalanceAt: overrides.lastRebalanceAt ?? 0,
    paperExitedAt: overrides.paperExitedAt ?? null,
    entrySignalTimestamp: overrides.entrySignalTimestamp ?? null,
    entrySignalSnapshotId: overrides.entrySignalSnapshotId ?? null,
    entryPriceUsd: null,
    entryAmountXUsd: null,
    entryAmountYUsd: null,
    cumulativeFeesClaimedUsd: 0,
    cumulativeRewardsClaimedUsd: 0,
    closedAt: null,
    realizedPnlUsd: null,
  };
}

describe("DbService — positions", () => {
  function makeLayer() {
    return DbLive(":memory:");
  }

  it("saves and retrieves a position", () => {
    const layer = makeLayer();
    const pos = makePosition();

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(pos);
        const retrieved = yield* db.getPosition(pos.positionId);
        expect(retrieved).not.toBeNull();
        expect(retrieved!.depositedUsd).toBe(1000);
        expect(retrieved!.tokenXSymbol).toBe("SOL");
      }),
      layer,
    );
  });

  it("upserts on duplicate position id", () => {
    const layer = makeLayer();
    const pos1 = makePosition({ depositedUsd: 1000 });
    const pos2 = makePosition({ depositedUsd: 2000 });

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(pos1);
        yield* db.savePosition(pos2);
        const retrieved = yield* db.getPosition(pos1.positionId);
        expect(retrieved!.depositedUsd).toBe(2000);
      }),
      layer,
    );
  });

  it("returns null for missing position", () => {
    const layer = makeLayer();

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        const retrieved = yield* db.getPosition("missing");
        expect(retrieved).toBeNull();
      }),
      layer,
    );
  });

  it("returns all positions", () => {
    const layer = makeLayer();

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(makePosition({ poolAddress: "pool1" }));
        yield* db.savePosition(makePosition({ poolAddress: "pool2" }));
        const all = yield* db.getAllPositions();
        expect(all).toHaveLength(2);
      }),
      layer,
    );
  });

  it("deletes a position", () => {
    const layer = makeLayer();
    const pos = makePosition();

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(pos);
        yield* db.deletePosition(pos.positionId);
        const retrieved = yield* db.getPosition(pos.positionId);
        expect(retrieved).toBeNull();
      }),
      layer,
    );
  });

  it("updates position value", () => {
    const layer = makeLayer();
    const pos = makePosition({ currentValueUsd: 1000 });

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(pos);
        yield* db.updatePositionValue(pos.positionId, 1200, 1300);
        const retrieved = yield* db.getPosition(pos.positionId);
        expect(retrieved!.currentValueUsd).toBe(1200);
        expect(retrieved!.highestValueUsd).toBe(1300);
      }),
      layer,
    );
  });

  it("updates position value without highest", () => {
    const layer = makeLayer();
    const pos = makePosition();

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(pos);
        yield* db.updatePositionValue(pos.positionId, 900);
        const retrieved = yield* db.getPosition(pos.positionId);
        expect(retrieved!.currentValueUsd).toBe(900);
        expect(retrieved!.highestValueUsd).toBeNull();
      }),
      layer,
    );
  });

  it("persists highestValueUsd and trailingStopThreshold", () => {
    const layer = makeLayer();
    const pos = makePosition({ highestValueUsd: 1500, trailingStopThreshold: 0.1 });

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(pos);
        const retrieved = yield* db.getPosition(pos.positionId);
        expect(retrieved!.highestValueUsd).toBe(1500);
        expect(retrieved!.trailingStopThreshold).toBe(0.1);
      }),
      layer,
    );
  });

  it("persists lastRebalanceAt", () => {
    const layer = makeLayer();
    const pos = makePosition({ lastRebalanceAt: 12345678 });

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(pos);
        const retrieved = yield* db.getPosition(pos.positionId);
        expect(retrieved!.lastRebalanceAt).toBe(12345678);
      }),
      layer,
    );
  });
});
