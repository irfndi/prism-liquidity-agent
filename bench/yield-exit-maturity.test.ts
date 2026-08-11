/** Economic-exit maturity gate (forensics-driven): the fee/IL and
 * yield-regression EXITs must not fire before fees can accrue — the paper
 * forensics showed 33-minute median holds exiting at a loss on temporary IL
 * that reversed, arming cooldowns that starved the ENTER lane. Capital-
 * protection exits stay age-free. */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { program } from "../engine/program.js";
import { makeTestLayer, makeAdapter, makeDatapiStats } from "./helpers.js";
import { makePool, makePosition } from "./helpers.js";
import { AuditService, DbService } from "../engine/services.js";

const POOL = "MaturityPool1111111111111111111111111111111111111";
const POS_ID = "maturity-pos";

interface DecisionRow {
  action: string;
  reasoning: string;
  confidence: number;
  executed: boolean;
}

function makeLayer(opts: { positionAgeMs: number; minYieldExitAgeMs?: number }) {
  return makeTestLayer({
    adapter: makeAdapter(
      { [POOL]: makePool({ address: POOL, tvlUsd: 100_000, fees24hUsd: 300 }) },
      {
        getAllWalletPositions: () =>
          Effect.succeed([
            { positionPubKey: POS_ID, poolAddress: POOL, lowerBinId: 4990, upperBinId: 5010 },
          ]),
      },
    ),
    configOverrides: {
      paperTrading: false,
      scanIntervalMs: 300,
      watchlistPools: [POOL],
      ...(opts.minYieldExitAgeMs !== undefined
        ? { minYieldExitAgeMs: opts.minYieldExitAgeMs }
        : {}),
    },
    datapi: {
      getPoolData: () => Effect.succeed(makeDatapiStats({ address: POOL, fees24hUsd: 300 })),
    },
  });
}

async function runCycle(opts: { positionAgeMs: number; minYieldExitAgeMs?: number }) {
  const layer = makeLayer(opts);
  const test = Effect.gen(function* () {
    const db = yield* DbService;
    // Seed a previous snapshot at a far price: the fee/IL estimate uses the
    // price-drift path (previous 100 -> current 150 = 50% move), producing a
    // large estimated IL and a fee/IL ratio well below 0.5 with fees at $1.
    yield* db.saveSnapshot({
      poolAddress: POOL,
      timestamp: Date.now() - 300_000,
      activeBinId: 4900,
      tvlUsd: 100_000,
      volume24hUsd: 30_000,
      fees24hUsd: 300,
      apr: 30,
      currentPrice: 100,
      binStep: 10,
      tokenXSymbol: "SOL",
      tokenYSymbol: "USDC",
      binArray: {
        lowerBinId: 4980,
        upperBinId: 5020,
        bins: [],
        activeBinId: 5000,
      },
    });
    yield* db.savePosition(
      makePosition({
        poolAddress: POOL,
        positionPubKey: POS_ID,
        timestamp: Date.now() - opts.positionAgeMs,
        depositedUsd: 1_000,
        currentValueUsd: 1_000,
      }),
    );
    yield* Effect.raceFirst(program, Effect.sleep(2_500));
    const audit = yield* AuditService;
    const decisions = yield* audit.getRecentDecisions(200);
    return decisions as unknown as ReadonlyArray<DecisionRow>;
  });
  return (await Effect.runPromise(
    Effect.provide(test, layer) as unknown as Effect.Effect<
      ReadonlyArray<DecisionRow>,
      Error,
      never
    >,
  )) as ReadonlyArray<DecisionRow>;
}

describe("economic-exit maturity gate", () => {
  it("an immature position (33-min hold, fee/IL < 0.5) does NOT exit", async () => {
    const decisions = await runCycle({ positionAgeMs: 33 * 60_000 });
    const feeIlExit = decisions.find((d) => d.reasoning.includes("Fee/IL ratio"));
    expect(feeIlExit, "fee/IL exit must not fire before fees can accrue").toBeUndefined();
  }, 15_000);

  it("a mature position (5h hold) with fee/IL < 0.5 DOES exit", async () => {
    const decisions = await runCycle({ positionAgeMs: 5 * 3_600_000 });
    const feeIlExit = decisions.find((d) => d.reasoning.includes("Fee/IL ratio"));
    expect(feeIlExit, "a mature low-yield position should exit").toBeDefined();
    expect(feeIlExit?.confidence).toBe(0.75);
  }, 15_000);

  it("a config override can keep the gate open (minYieldExitAgeMs=0)", async () => {
    const decisions = await runCycle({ positionAgeMs: 60_000, minYieldExitAgeMs: 0 });
    const feeIlExit = decisions.find((d) => d.reasoning.includes("Fee/IL ratio"));
    expect(feeIlExit, "explicitly zero age floor restores legacy behavior").toBeDefined();
  }, 15_000);

  it("capital-protection exits stay age-free (trailing stop fires on an immature position)", async () => {
    // Immature position WITH a real 33% drawdown (peak 1500 vs 1000): the
    // trailing stop must fire despite the age gate — capital protection is
    // never delayed by MIN_YIELD_EXIT_AGE_MS.
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
      configOverrides: {
        paperTrading: false,
        scanIntervalMs: 300,
        watchlistPools: [POOL],
        trailingStopConfirmCycles: 2,
      },
      datapi: {
        getPoolData: () => Effect.succeed(makeDatapiStats({ address: POOL, fees24hUsd: 300 })),
      },
    });
    const test = Effect.gen(function* () {
      const db = yield* DbService;
      yield* db.saveSnapshot({
        poolAddress: POOL,
        timestamp: Date.now() - 300_000,
        activeBinId: 4900,
        tvlUsd: 100_000,
        volume24hUsd: 30_000,
        fees24hUsd: 300,
        apr: 30,
        currentPrice: 100,
        binStep: 10,
        tokenXSymbol: "SOL",
        tokenYSymbol: "USDC",
        binArray: { lowerBinId: 4980, upperBinId: 5020, bins: [], activeBinId: 5000 },
      });
      yield* db.savePosition(
        makePosition({
          poolAddress: POOL,
          positionPubKey: POS_ID,
          timestamp: Date.now() - 60_000, // immature
          depositedUsd: 1_000,
          currentValueUsd: 1_000,
          highestValueUsd: 1_500, // 33% drawdown
        }),
      );
      yield* Effect.raceFirst(program, Effect.sleep(6_000)); // wide window: parallel-load flake guard (2 confirm cycles)
      const audit = yield* AuditService;
      const decisions = yield* audit.getRecentDecisions(200);
      return decisions as unknown as ReadonlyArray<DecisionRow>;
    });
    const decisions = (await Effect.runPromise(
      Effect.provide(test, layer) as unknown as Effect.Effect<
        ReadonlyArray<DecisionRow>,
        Error,
        never
      >,
    )) as ReadonlyArray<DecisionRow>;
    const trailing = decisions.find((d) => d.reasoning.includes("Trailing stop"));
    expect(
      trailing,
      "trailing stop must fire on an immature position — capital protection is age-free",
    ).toBeDefined();
    // And the fee/IL exit still does NOT fire immature.
    const feeIlExit = decisions.find((d) => d.reasoning.includes("Fee/IL ratio"));
    expect(feeIlExit).toBeUndefined();
  }, 30_000);
});
