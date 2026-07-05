import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { DbLive } from "../engine/db-service.js";
import { DbService } from "../engine/services.js";
import type { PoolCooldown } from "../engine/types.js";

function makeLayer() {
  return DbLive(":memory:");
}

function run<T>(effect: Effect.Effect<T, unknown, unknown>, layer: unknown): T {
  return Effect.runSync(
    (
      Effect.provide as (
        e: Effect.Effect<T, unknown, unknown>,
        l: unknown,
      ) => Effect.Effect<T, unknown, never>
    )(effect, layer),
  );
}

describe("Pool cooldown", () => {
  it("returns null when no cooldown exists for a pool", () => {
    const layer = makeLayer();

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        const result = yield* db.getPoolCooldown("Pool111111111111111111111111111111111111111");
        expect(result).toBeNull();
      }),
      layer,
    );
  });

  it("round-trips setPoolCooldown + getPoolCooldown", () => {
    const layer = makeLayer();
    const cooldown: PoolCooldown = {
      poolAddress: "Pool111111111111111111111111111111111111111",
      cooldownUntil: Date.now() + 3_600_000,
      reason: "OOR exit",
      consecutiveOorExits: 2,
    };

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.setPoolCooldown(cooldown);
        const result = yield* db.getPoolCooldown(cooldown.poolAddress);
        expect(result).not.toBeNull();
        expect(result!.poolAddress).toBe(cooldown.poolAddress);
        expect(result!.cooldownUntil).toBe(cooldown.cooldownUntil);
        expect(result!.reason).toBe(cooldown.reason);
        expect(result!.consecutiveOorExits).toBe(cooldown.consecutiveOorExits);
      }),
      layer,
    );
  });

  it("clearPoolCooldown removes the cooldown", () => {
    const layer = makeLayer();
    const cooldown: PoolCooldown = {
      poolAddress: "Pool111111111111111111111111111111111111111",
      cooldownUntil: Date.now() + 3_600_000,
      reason: "OOR exit",
      consecutiveOorExits: 1,
    };

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.setPoolCooldown(cooldown);
        yield* db.clearPoolCooldown(cooldown.poolAddress);
        const result = yield* db.getPoolCooldown(cooldown.poolAddress);
        expect(result).toBeNull();
      }),
      layer,
    );
  });

  it("upserts cooldown on the same pool address", () => {
    const layer = makeLayer();
    const first: PoolCooldown = {
      poolAddress: "Pool111111111111111111111111111111111111111",
      cooldownUntil: Date.now() + 1_000_000,
      reason: "First cooldown",
      consecutiveOorExits: 1,
    };
    const second: PoolCooldown = {
      poolAddress: first.poolAddress,
      cooldownUntil: Date.now() + 2_000_000,
      reason: "Second cooldown",
      consecutiveOorExits: 3,
    };

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.setPoolCooldown(first);
        yield* db.setPoolCooldown(second);
        const result = yield* db.getPoolCooldown(first.poolAddress);
        expect(result).not.toBeNull();
        expect(result!.cooldownUntil).toBe(second.cooldownUntil);
        expect(result!.reason).toBe(second.reason);
        expect(result!.consecutiveOorExits).toBe(3);
      }),
      layer,
    );
  });

  it("returns null for a different pool after clearing", () => {
    const layer = makeLayer();
    const cooldownA: PoolCooldown = {
      poolAddress: "PoolA111111111111111111111111111111111111111",
      cooldownUntil: Date.now() + 1_000_000,
      reason: "Pool A cooldown",
      consecutiveOorExits: 1,
    };
    const cooldownB: PoolCooldown = {
      poolAddress: "PoolB111111111111111111111111111111111111111",
      cooldownUntil: Date.now() + 1_000_000,
      reason: "Pool B cooldown",
      consecutiveOorExits: 2,
    };

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.setPoolCooldown(cooldownA);
        yield* db.setPoolCooldown(cooldownB);
        yield* db.clearPoolCooldown(cooldownA.poolAddress);
        const resultA = yield* db.getPoolCooldown(cooldownA.poolAddress);
        const resultB = yield* db.getPoolCooldown(cooldownB.poolAddress);
        expect(resultA).toBeNull();
        expect(resultB).not.toBeNull();
        expect(resultB!.reason).toBe("Pool B cooldown");
      }),
      layer,
    );
  });
});
