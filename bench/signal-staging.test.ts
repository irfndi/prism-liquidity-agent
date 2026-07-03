import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { DbLive } from "../engine/db-service.js";
import { DbService } from "../engine/services.js";
import type { SignalSnapshot } from "../engine/types.js";

function makeLayer() {
  return DbLive(":memory:");
}

function run<T>(effect: Effect.Effect<T, unknown, unknown>, layer: unknown): T {
  return Effect.runSync((Effect.provide as (e: Effect.Effect<T, unknown, unknown>, l: unknown) => Effect.Effect<T, unknown, never>)(effect, layer));
}

function makeSnapshot(overrides: Partial<SignalSnapshot> = {}): SignalSnapshot {
  return {
    poolAddress: "Pool111111111111111111111111111111111111111",
    timestamp: Date.now(),
    feeIlRatio: 1.5,
    volumeAuthenticity: 0.85,
    binUtilization: 0.6,
    tvlUsd: 100_000,
    tvlVelocity: -0.05,
    volatilityStddev: 2.5,
    binStep: 10,
    action: "ENTER",
    confidence: 0.75,
    ...overrides,
  };
}

// ─── saveSignalSnapshot + getSignalSnapshots ────────────────────────────────

describe("Signal staging", () => {
  it("saves and retrieves a snapshot by pool and time range", () => {
    const layer = makeLayer();
    const snapshot = makeSnapshot({ timestamp: 1_000_000 });

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.saveSignalSnapshot(snapshot);
        const results = yield* db.getSignalSnapshots(
          snapshot.poolAddress,
          0,
          2_000_000,
        );
        expect(results).toHaveLength(1);
        expect(results[0]!.poolAddress).toBe(snapshot.poolAddress);
        expect(results[0]!.timestamp).toBe(snapshot.timestamp);
        expect(results[0]!.feeIlRatio).toBe(snapshot.feeIlRatio);
        expect(results[0]!.action).toBe(snapshot.action);
        expect(results[0]!.outcomePnlUsd).toBeNull();
        expect(results[0]!.outcomeRecordedAt).toBeNull();
      }),
      layer,
    );
  });

  it("returns empty array when no snapshots match the time range", () => {
    const layer = makeLayer();
    const snapshot = makeSnapshot({ timestamp: 5_000_000 });

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.saveSignalSnapshot(snapshot);
        const results = yield* db.getSignalSnapshots(
          snapshot.poolAddress,
          0,
          1_000_000,
        );
        expect(results).toHaveLength(0);
      }),
      layer,
    );
  });

  it("returns empty array for a different pool address", () => {
    const layer = makeLayer();
    const snapshot = makeSnapshot({ timestamp: 1_000_000 });

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.saveSignalSnapshot(snapshot);
        const results = yield* db.getSignalSnapshots(
          "DifferentPool11111111111111111111111111111111",
          0,
          2_000_000,
        );
        expect(results).toHaveLength(0);
      }),
      layer,
    );
  });

  it("returns multiple snapshots ordered by timestamp ascending", () => {
    const layer = makeLayer();

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.saveSignalSnapshot(makeSnapshot({ timestamp: 3_000_000 }));
        yield* db.saveSignalSnapshot(makeSnapshot({ timestamp: 1_000_000 }));
        yield* db.saveSignalSnapshot(makeSnapshot({ timestamp: 2_000_000 }));
        const results = yield* db.getSignalSnapshots(
          "Pool111111111111111111111111111111111111111",
          0,
          4_000_000,
        );
        expect(results).toHaveLength(3);
        expect(results[0]!.timestamp).toBe(1_000_000);
        expect(results[1]!.timestamp).toBe(2_000_000);
        expect(results[2]!.timestamp).toBe(3_000_000);
      }),
      layer,
    );
  });

  // ─── recordSignalOutcome + getRecentOutcomes ──────────────────────────────

  it("records an outcome and retrieves it via getRecentOutcomes", () => {
    const layer = makeLayer();
    const snapshot = makeSnapshot({ timestamp: 1_000_000 });

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.saveSignalSnapshot(snapshot);
        yield* db.recordSignalOutcome(snapshot.poolAddress, snapshot.timestamp, 42.5);
        const outcomes = yield* db.getRecentOutcomes(10);
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]!.outcomePnlUsd).toBe(42.5);
        expect(outcomes[0]!.outcomeRecordedAt).toBeTypeOf("number");
      }),
      layer,
    );
  });

  it("getRecentOutcomes excludes snapshots without outcomes", () => {
    const layer = makeLayer();

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.saveSignalSnapshot(makeSnapshot({ timestamp: 1_000_000 }));
        yield* db.saveSignalSnapshot(makeSnapshot({ timestamp: 2_000_000 }));
        const outcomes = yield* db.getRecentOutcomes(10);
        expect(outcomes).toHaveLength(0);
      }),
      layer,
    );
  });

  it("getRecentOutcomes respects the limit parameter", () => {
    const layer = makeLayer();

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.saveSignalSnapshot(makeSnapshot({ timestamp: 1_000_000 }));
        yield* db.saveSignalSnapshot(makeSnapshot({ timestamp: 2_000_000 }));
        yield* db.saveSignalSnapshot(makeSnapshot({ timestamp: 3_000_000 }));
        yield* db.recordSignalOutcome(
          "Pool111111111111111111111111111111111111111",
          1_000_000,
          10,
        );
        yield* db.recordSignalOutcome(
          "Pool111111111111111111111111111111111111111",
          2_000_000,
          20,
        );
        yield* db.recordSignalOutcome(
          "Pool111111111111111111111111111111111111111",
          3_000_000,
          30,
        );
        const outcomes = yield* db.getRecentOutcomes(2);
        expect(outcomes).toHaveLength(2);
        // ordered by outcome_recorded_at DESC — most recent first
        expect(outcomes[0]!.outcomePnlUsd).toBe(30);
        expect(outcomes[1]!.outcomePnlUsd).toBe(20);
      }),
      layer,
    );
  });

  // ─── getEvolvedThresholds + saveEvolvedThresholds ────────────────────────

  it("returns null when no evolved thresholds are saved", () => {
    const layer = makeLayer();

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        const result = yield* db.getEvolvedThresholds();
        expect(result).toBeNull();
      }),
      layer,
    );
  });

  it("saves and retrieves evolved thresholds round-trip", () => {
    const layer = makeLayer();
    const thresholds = {
      minFeeIlRatio: 1.5,
      volumeAuthThreshold: 0.8,
      minBinUtilization: 0.4,
    };

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.saveEvolvedThresholds(thresholds);
        const result = yield* db.getEvolvedThresholds();
        expect(result).not.toBeNull();
        expect(result!.minFeeIlRatio).toBe(1.5);
        expect(result!.volumeAuthThreshold).toBe(0.8);
        expect(result!.minBinUtilization).toBe(0.4);
      }),
      layer,
    );
  });

  it("overwrites evolved thresholds on subsequent saves", () => {
    const layer = makeLayer();

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.saveEvolvedThresholds({
          minFeeIlRatio: 1.0,
          volumeAuthThreshold: 0.5,
          minBinUtilization: 0.2,
        });
        yield* db.saveEvolvedThresholds({
          minFeeIlRatio: 2.0,
          volumeAuthThreshold: 0.9,
          minBinUtilization: 0.6,
        });
        const result = yield* db.getEvolvedThresholds();
        expect(result!.minFeeIlRatio).toBe(2.0);
        expect(result!.volumeAuthThreshold).toBe(0.9);
        expect(result!.minBinUtilization).toBe(0.6);
      }),
      layer,
    );
  });

  // ─── getClosedPositionOutcomes ───────────────────────────────────────────

  it("returns only ENTER and HOLD actions with recorded outcomes", () => {
    const layer = makeLayer();

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        const base = {
          poolAddress: "Pool111111111111111111111111111111111111111",
          feeIlRatio: 1.5,
          volumeAuthenticity: 0.8,
          binUtilization: 0.6,
          tvlUsd: 100_000,
          tvlVelocity: 0,
          volatilityStddev: 2,
          binStep: 10,
          confidence: 0.7,
        };

        yield* db.saveSignalSnapshot({ ...base, timestamp: 1, action: "ENTER" });
        yield* db.saveSignalSnapshot({ ...base, timestamp: 2, action: "HOLD" });
        yield* db.saveSignalSnapshot({ ...base, timestamp: 3, action: "REBALANCE" });
        yield* db.saveSignalSnapshot({ ...base, timestamp: 4, action: "EXIT" });

        yield* db.recordSignalOutcome("Pool111111111111111111111111111111111111111", 1, 50);
        yield* db.recordSignalOutcome("Pool111111111111111111111111111111111111111", 2, 30);
        yield* db.recordSignalOutcome("Pool111111111111111111111111111111111111111", 3, -10);
        yield* db.recordSignalOutcome("Pool111111111111111111111111111111111111111", 4, -20);

        const outcomes = yield* db.getClosedPositionOutcomes(10);
        expect(outcomes).toHaveLength(2);
        expect(outcomes[0]!.pnlUsd).toBe(30);
        expect(outcomes[1]!.pnlUsd).toBe(50);
      }),
      layer,
    );
  });

  // ─── signal weights DB round-trip ────────────────────────────────────────

  it("returns null when no signal weights are saved", () => {
    const layer = makeLayer();

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        const result = yield* db.getSignalWeights();
        expect(result).toBeNull();
      }),
      layer,
    );
  });

  it("saves and retrieves signal weights round-trip", () => {
    const layer = makeLayer();
    const weights = {
      feeIlRatio: 1.2,
      volumeAuthenticity: 0.9,
      binUtilization: 1.1,
      tvlUsd: 1.0,
      tvlVelocity: 1.0,
      updatedAt: Date.now(),
    };

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.saveSignalWeights(weights);
        const result = yield* db.getSignalWeights();
        expect(result).not.toBeNull();
        expect(result!.feeIlRatio).toBe(1.2);
        expect(result!.volumeAuthenticity).toBe(0.9);
        expect(result!.binUtilization).toBe(1.1);
        expect(result!.tvlUsd).toBe(1.0);
        expect(result!.tvlVelocity).toBe(1.0);
      }),
      layer,
    );
  });
});
