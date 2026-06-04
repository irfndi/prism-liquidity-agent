import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import { DbLive } from "../engine/db-service.js";
import { DbService } from "../engine/services.js";

function run<T, R>(effect: Effect.Effect<T, unknown, R>, layer: Layer.Layer<R, unknown, unknown>): T {
  return Effect.runSync(Effect.provide(effect, layer) as Effect.Effect<T, unknown, never>);
}

function makePosition(
  poolAddress: string,
  paperExitedAt: number | null = null,
): {
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
} {
  return {
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
        return yield* db.getPosition("PoolA");
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
        yield* db.markPaperExited("PoolB");
        return yield* db.getPosition("PoolB");
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
        yield* db.markPaperExited("PoolExited1");
        yield* db.markPaperExited("PoolExited2");
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
        yield* db.markPaperExited("PoolExited");
        return yield* db.getPosition("PoolExited");
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
