import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import { DbLive } from "../engine/db-service.js";
import { DbService } from "../engine/services.js";

function run<T, R>(
  effect: Effect.Effect<T, unknown, R>,
  layer: Layer.Layer<R, unknown, unknown>,
): T {
  return Effect.runSync(Effect.provide(effect, layer) as Effect.Effect<T, unknown, never>);
}

function makePosition(
  poolAddress: string,
  paperExitedAt: number | null = null,
): {
  positionId: string;
  poolAddress: string;
  positionPubKey: string | null;
  depositedUsd: number;
  currentValueUsd: number;
  tokenXSymbol: string;
  tokenYSymbol: string;
  activeBinId: number;
  lowerBinId: number;
  upperBinId: number;
  timestamp: number;
  outOfRangeSince: number | null;
  oorCycleCount: number;
  lastFeeClaimAt: number;
  trailingStopThreshold: number | null;
  highestValueUsd: number | null;
  lastRebalanceAt: number;
  paperExitedAt: number | null;
  entrySignalTimestamp: number | null;
  entrySignalSnapshotId: number | null;
  entryPriceUsd: number | null;
  entryAmountXUsd: number | null;
  entryAmountYUsd: number | null;
  cumulativeFeesClaimedUsd: number;
  cumulativeRewardsClaimedUsd: number;
  closedAt: number | null;
  realizedPnlUsd: number | null;
} {
  return {
    positionId: `paper-${poolAddress}`,
    poolAddress,
    positionPubKey: null,
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
    paperExitedAt,
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

describe("DbService — paper-exit tracking", () => {
  beforeEach(() => {
    // Each test gets a fresh in-memory SQLite database via DbLive(":memory:").
  });

  it("saves a position with paperExitedAt=null and round-trips it as null", () => {
    const layer = DbLive(":memory:");
    const pos = makePosition("PoolA", null);

    const result = run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(pos);
        return yield* db.getPosition(pos.positionId);
      }),
      layer,
    );

    expect(result).not.toBeNull();
    expect(result!.paperExitedAt).toBeNull();
  });

  it("markPaperExited sets paperExitedAt to a recent timestamp", () => {
    const layer = DbLive(":memory:");
    const pos = makePosition("PoolB", null);
    const before = Date.now();

    const after = run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(pos);
        yield* db.markPaperExited(pos.positionId);
        return yield* db.getPosition(pos.positionId);
      }),
      layer,
    );

    expect(after).not.toBeNull();
    expect(after!.paperExitedAt).not.toBeNull();
    expect(after!.paperExitedAt!).toBeGreaterThanOrEqual(before);
    expect(after!.paperExitedAt!).toBeLessThanOrEqual(Date.now());
  });

  it("getAllPositions excludes paper-exited positions", () => {
    const layer = DbLive(":memory:");

    const all = run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(makePosition("PoolActive1"));
        yield* db.savePosition(makePosition("PoolActive2"));
        yield* db.savePosition(makePosition("PoolExited1"));
        yield* db.savePosition(makePosition("PoolExited2"));
        yield* db.markPaperExited("paper-PoolExited1");
        yield* db.markPaperExited("paper-PoolExited2");
        return yield* db.getAllPositions();
      }),
      layer,
    );

    const addresses = all.map((p) => p.poolAddress).sort();
    expect(addresses).toEqual(["PoolActive1", "PoolActive2"]);
  });

  it("getPaperExitedPositions returns only paper-exited positions, most recent first", () => {
    const layer = DbLive(":memory:");

    const exited = run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(makePosition("PoolActive"));
        yield* db.savePosition(makePosition("PoolOld", 1000));
        yield* db.savePosition(makePosition("PoolNew", 2000));
        return yield* db.getPaperExitedPositions();
      }),
      layer,
    );

    expect(exited).toHaveLength(2);
    expect(exited[0]!.poolAddress).toBe("PoolNew");
    expect(exited[1]!.poolAddress).toBe("PoolOld");
    for (const pos of exited) {
      expect(pos.paperExitedAt).not.toBeNull();
    }
  });

  it("getPosition still returns paper-exited positions (so the startup warning can see them)", () => {
    const layer = DbLive(":memory:");

    const retrieved = run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(makePosition("PoolExited"));
        yield* db.markPaperExited("paper-PoolExited");
        return yield* db.getPosition("paper-PoolExited");
      }),
      layer,
    );

    expect(retrieved).not.toBeNull();
    expect(retrieved!.paperExitedAt).not.toBeNull();
  });

  it("markPaperExited on a non-existent pool is a silent no-op", () => {
    const layer = DbLive(":memory:");

    const result = run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.markPaperExited("NonExistentPool");
        return yield* db.getPaperExitedPositions();
      }),
      layer,
    );

    expect(result).toEqual([]);
  });

  it("getPaperExitedPositions returns empty array when no positions are paper-exited", () => {
    const layer = DbLive(":memory:");

    const result = run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(makePosition("PoolActive1"));
        yield* db.savePosition(makePosition("PoolActive2"));
        return yield* db.getPaperExitedPositions();
      }),
      layer,
    );

    expect(result).toEqual([]);
  });
});

describe("DbService — setMetadataBatch (Gemini review)", () => {
  it("writes all entries in a single transaction", () => {
    const layer = DbLive(":memory:");
    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.setMetadataBatch([
          { key: "paperTradingDaysAccumulated", value: "5" },
          { key: "paperTradingLastDayIso", value: "2026-07-01" },
        ]);
        const days = yield* db.getMetadata("paperTradingDaysAccumulated");
        const lastDay = yield* db.getMetadata("paperTradingLastDayIso");
        expect(days).toBe("5");
        expect(lastDay).toBe("2026-07-01");
      }),
      layer,
    );
  });

  it("overwrites existing keys (INSERT OR REPLACE)", () => {
    const layer = DbLive(":memory:");
    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.setMetadata("counter", "1");
        yield* db.setMetadataBatch([
          { key: "counter", value: "2" },
          { key: "other", value: "x" },
        ]);
        const counter = yield* db.getMetadata("counter");
        const other = yield* db.getMetadata("other");
        expect(counter).toBe("2");
        expect(other).toBe("x");
      }),
      layer,
    );
  });

  it("handles empty array without error", () => {
    const layer = DbLive(":memory:");
    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.setMetadataBatch([]);
      }),
      layer,
    );
  });

  it("rolls back the entire batch when a mid-batch entry fails (atomicity)", () => {
    const layer = DbLive(":memory:");
    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.setMetadata("preexisting", "untouched");
        const result = yield* db
          .setMetadataBatch([
            { key: "first", value: "would_persist_if_no_rollback" },
            { key: Symbol("bad") as unknown as string, value: "triggers_failure" },
            { key: "third", value: "never_reached" },
          ])
          .pipe(Effect.either);
        expect(result._tag).toBe("Left");
        const first = yield* db.getMetadata("first");
        const third = yield* db.getMetadata("third");
        const preexisting = yield* db.getMetadata("preexisting");
        expect(first).toBeNull();
        expect(third).toBeNull();
        expect(preexisting).toBe("untouched");
      }),
      layer,
    );
  });
});
