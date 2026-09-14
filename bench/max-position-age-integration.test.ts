/** Hard age backstop wired into the live decision loop: fires through
 * checkDeterministicExits regardless of measured-fee status, exempts
 * launch-mode positions, and stays off a younger position. */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { program } from "../engine/program.js";
import { makeTestLayer, makeAdapter, makeDatapiStats, asOwner } from "./helpers.js";
import { makePool, makePosition } from "./helpers.js";
import { AuditService, DbService } from "../engine/services.js";
import type { AppConfig } from "../engine/config-service.js";

const POOL = "MaxAgePool111111111111111111111111111111111111111";
const POS_ID = "max-age-pos";
const HOUR_MS = 3_600_000;

interface DecisionRow {
  action: string;
  reasoning: string;
  confidence: number;
  executed: boolean;
}

async function runCycle(opts: {
  positionAgeMs: number;
  maxPositionAgeMs: number;
  positionMode?: string | null;
}) {
  const configOverrides: Partial<AppConfig> = {
    paperTrading: false,
    scanIntervalMs: 300,
    watchlistPools: [POOL],
    maxPositionAgeMs: opts.maxPositionAgeMs,
    // Isolate the age backstop: no other exit should fire in this window.
    minYieldExitAgeMs: 999_999_999_999,
    trailingStopConfirmCycles: 99,
  };
  const layer = makeTestLayer({
    adapter: makeAdapter(
      { [POOL]: makePool({ address: POOL, tvlUsd: 100_000, fees24hUsd: 300 }) },
      {
        getAllWalletPositions: () =>
          Effect.succeed([
            { positionPubKey: POS_ID, poolAddress: POOL, lowerBinId: 4990, upperBinId: 5010 },
          ]),
      },
    ),
    configOverrides,
    datapi: {
      getPoolData: () => Effect.succeed(makeDatapiStats({ address: POOL, fees24hUsd: 300 })),
    },
  });
  const test = Effect.gen(function* () {
    const db = yield* DbService;
    yield* db.savePosition(
      makePosition({
        poolAddress: POOL,
        positionPubKey: POS_ID,
        timestamp: Date.now() - opts.positionAgeMs,
        depositedUsd: 1_000,
        currentValueUsd: 1_000,
        highestValueUsd: 1_000,
        positionMode: opts.positionMode ?? null,
      }),
    );
    yield* Effect.raceFirst(program, Effect.sleep(2_500));
    const audit = yield* AuditService;
    return yield* audit.getRecentDecisions(200);
  });
  // SAFETY: This test fixture is constructed to satisfy the asserted service/domain contract and is exercised by the surrounding test.
  return (await Effect.runPromise(
    asOwner<Effect.Effect<ReadonlyArray<DecisionRow>, Error, never>>(Effect.provide(test, layer)),
  )) as ReadonlyArray<DecisionRow>;
}

describe("max-position-age backstop (wired into checkDeterministicExits)", () => {
  it("fires once a position ages past the backstop", async () => {
    const decisions = await runCycle({ positionAgeMs: 2 * HOUR_MS, maxPositionAgeMs: HOUR_MS });
    const ageExit = decisions.find((d) => d.reasoning.includes("[max-position-age]"));
    expect(ageExit, "backstop must fire once the position is older than maxPositionAgeMs").toBeDefined();
    expect(ageExit?.action).toBe("EXIT");
    expect(ageExit?.confidence).toBe(1);
  }, 15_000);

  it("does not fire while younger than the backstop", async () => {
    const decisions = await runCycle({
      positionAgeMs: 30 * 60_000,
      maxPositionAgeMs: HOUR_MS,
    });
    const ageExit = decisions.find((d) => d.reasoning.includes("[max-position-age]"));
    expect(ageExit, "backstop must not fire before the position reaches the max age").toBeUndefined();
  }, 15_000);

  it("exempts launch-mode positions", async () => {
    const decisions = await runCycle({
      positionAgeMs: 10 * HOUR_MS,
      maxPositionAgeMs: HOUR_MS,
      positionMode: "launch",
    });
    const ageExit = decisions.find((d) => d.reasoning.includes("[max-position-age]"));
    expect(ageExit, "launch-mode positions own their age via the timebox lifecycle instead").toBeUndefined();
  }, 15_000);

  it("stays off when maxPositionAgeMs is 0 (disabled)", async () => {
    const decisions = await runCycle({ positionAgeMs: 30 * 24 * HOUR_MS, maxPositionAgeMs: 0 });
    const ageExit = decisions.find((d) => d.reasoning.includes("[max-position-age]"));
    expect(ageExit, "maxPositionAgeMs=0 must disable the backstop").toBeUndefined();
  }, 15_000);
});
