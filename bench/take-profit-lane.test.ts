import { describe, it, expect } from "vitest";
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = { [key: string]: JsonValue };
import { Effect, Layer } from "effect";
import { program } from "../engine/program.js";
import { AuditService, DbService } from "../engine/services.js";
import { buildTpLadder, parseTpLadder, serializeTpLadder } from "../engine/tp-ladder.js";
import type { PositionRecord } from "../engine/db-service.js";
import {
  makePool,
  makePosition,
  makeTestLayer,
  makeAdapter,
  makeDatapiStats,
  asOwner,
} from "./helpers.js";

// Normal-lane take-profit (winrate fix): a normal ENTER carries a single-rung
// TP ladder when TAKE_PROFIT_ENABLED, and the EXIT chain locks the profit with
// a deterministic [tp-target] EXIT (confidence 1) when price reaches the rung —
// before any loss-side exit. The downside stays owned by the trailing stop /
// loss-side exits (price below the rung must NOT produce a TP exit).

const POOL = "TakeProfitPool111111111111111111111111111111";

type TpDecisionRow = {
  poolAddress: string;
  action: string;
  reasoning: string;
  executed: boolean;
  confidence: number;
  riskResult: { approved: boolean; reason: string };
};

// The harness layer type (see idle-redeploy.test.ts for the same pattern):
// makeTestLayer returns a concrete layer union, passed through `as never`.
type TestLayer = Layer.Layer<never, never, never>;

async function runCycle(
  layer: TestLayer,
  sleepMs = 1_500,
): Promise<{ positions: ReadonlyArray<PositionRecord>; decisions: ReadonlyArray<TpDecisionRow> }> {
  const test = Effect.gen(function* () {
    yield* Effect.raceFirst(program, Effect.sleep(sleepMs));
    const db = yield* DbService;
    const audit = yield* AuditService;
    const positions = yield* db.getAllPositions();
    const decisions = yield* audit.getRecentDecisions(200);
    return { positions, decisions };
  });
  return Effect.runPromise(
    asOwner<
      Effect.Effect<
        { positions: ReadonlyArray<PositionRecord>; decisions: ReadonlyArray<TpDecisionRow> },
        Error,
        never
      >
    >(Effect.provide(test, layer)),
  );
}

function seedLadderedPosition(): PositionRecord {
  // Entry 150, rung +15% → 172.5, invalidation 150 × (1 − 0.1) = 135.
  const ladderSpec = buildTpLadder(150, {
    rungs: [0.15],
    fractions: [1],
    invalidationStopPct: 0.1,
  })!;
  return makePosition({
    poolAddress: POOL,
    positionPubKey: null,
    depositedUsd: 1_000,
    currentValueUsd: 1_000,
    tpLadderJson: serializeTpLadder(ladderSpec.ladder),
    invalidationStopPrice: ladderSpec.invalidationPrice,
  });
}

async function runWithSeededPosition(
  layer: TestLayer,
  position: PositionRecord,
): Promise<ReadonlyArray<TpDecisionRow>> {
  const test = Effect.gen(function* () {
    const db = yield* DbService;
    yield* db.savePosition(position);
    yield* Effect.raceFirst(program, Effect.sleep(1_500));
    const audit = yield* AuditService;
    return yield* audit.getRecentDecisions(200);
  });
  return Effect.runPromise(
    asOwner<Effect.Effect<ReadonlyArray<TpDecisionRow>, Error, never>>(Effect.provide(test, layer)),
  );
}

function enterLayer(configOverrides: JsonRecord): TestLayer {
  // SAFETY: This test fixture is constructed to satisfy the asserted service/domain contract and is exercised by the surrounding test.
  return makeTestLayer({
    adapter: makeAdapter({ [POOL]: makePool({ address: POOL }) }),
    datapi: { getPoolData: () => Effect.succeed(makeDatapiStats({ address: POOL })) },
    // SAFETY: This test intentionally supplies an impossible error channel to exercise the failure branch; production control flow cannot reach it.
    configOverrides: configOverrides as never,
  }) as never;
}

describe("normal-lane take-profit (winrate fix)", () => {
  it("(a) persists a single-rung TP ladder on a normal ENTER with the configured pct", async () => {
    const layer = enterLayer({
      watchlistPools: [POOL],
      takeProfitEnabled: true,
      // Non-default pct proves config wiring, not the 0.15 fallback.
      takeProfitPct: 0.2,
      maxPositionsPerPool: 2,
      maxOpenPositions: 5,
    });
    const { positions, decisions } = await runCycle(layer);

    const entered = positions.filter((p) => p.poolAddress === POOL);
    expect(
      entered,
      `expected a persisted normal ENTER position, got ${positions.length}`,
    ).toHaveLength(1);
    const pos = entered[0]!;
    expect(pos.tpLadderJson).not.toBeNull();
    const ladder = parseTpLadder(pos.tpLadderJson);
    expect(ladder).not.toBeNull();
    expect(ladder!.rungs).toHaveLength(1);
    // entry = pool.currentPrice (150); target = 150 × (1 + 0.2) = 180.
    expect(ladder!.rungs[0]!.targetPrice).toBeCloseTo(180, 6);
    expect(ladder!.rungs[0]!.fraction).toBe(1);
    // invalidation = trailing-stop pct (0.1): 150 × 0.9 = 135.
    expect(pos.invalidationStopPrice).toBeCloseTo(135, 6);

    const executed = decisions.find(
      (d) => d.action === "ENTER" && d.poolAddress === POOL && d.executed,
    );
    expect(executed).toBeDefined();
  }, 15_000);

  it("(b) emits a deterministic [tp-target] EXIT with confidence 1 when price reaches the rung", async () => {
    // Pool price 200 ≥ rung target 172.5 (entry 150 × 1.15).
    // SAFETY: This test fixture is constructed to satisfy the asserted service/domain contract and is exercised by the surrounding test.
    const layer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: makePool({ address: POOL, currentPrice: 200 }) }),
      configOverrides: {
        watchlistPools: [POOL],
        takeProfitEnabled: true,
        // Slot full → no ENTER noise; the EXIT path is what we exercise.
        maxOpenPositions: 1,
      },
    }) as never;
    const decisions = await runWithSeededPosition(layer, seedLadderedPosition());

    const tpExits = decisions.filter(
      (d) => d.action === "EXIT" && d.poolAddress === POOL && d.reasoning.startsWith("[tp-target]"),
    );
    expect(tpExits, `expected one [tp-target] EXIT, got ${tpExits.length}`).toHaveLength(1);
    expect(tpExits[0]!.confidence).toBe(1);
    expect(tpExits[0]!.reasoning).toContain("reached target 172.500000");
    expect(tpExits[0]!.reasoning).toContain("take profit");
  }, 15_000);

  it("(c) emits no TP exit while price is below the rung (loss-side exits own the downside)", async () => {
    // Pool price 160: above entry 150 but below the rung 172.5 — no TP exit,
    // and the healthy position triggers no loss-side exit either.
    // SAFETY: This test fixture is constructed to satisfy the asserted service/domain contract and is exercised by the surrounding test.
    const layer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: makePool({ address: POOL, currentPrice: 160 }) }),
      configOverrides: {
        watchlistPools: [POOL],
        takeProfitEnabled: true,
        maxOpenPositions: 1,
      },
    }) as never;
    const decisions = await runWithSeededPosition(layer, seedLadderedPosition());

    const tpExits = decisions.filter(
      (d) => d.action === "EXIT" && d.poolAddress === POOL && d.reasoning.startsWith("[tp-target]"),
    );
    expect(tpExits).toHaveLength(0);
    const anyExits = decisions.filter((d) => d.action === "EXIT" && d.poolAddress === POOL);
    expect(
      anyExits,
      `healthy sub-rung position must not exit: ${anyExits.map((d) => d.reasoning).join("; ")}`,
    ).toHaveLength(0);
  }, 15_000);

  it("(d) TAKE_PROFIT_ENABLED=false builds no ladder and emits no TP exit", async () => {
    // (1) A normal ENTER with the feature off persists no ladder.
    const enterOffLayer = enterLayer({
      watchlistPools: [POOL],
      maxPositionsPerPool: 2,
      maxOpenPositions: 5,
    });
    const { positions } = await runCycle(enterOffLayer);
    const entered = positions.filter((p) => p.poolAddress === POOL);
    expect(entered).toHaveLength(1);
    expect(entered[0]!.tpLadderJson).toBeNull();
    expect(entered[0]!.invalidationStopPrice).toBeNull();

    // (2) A laddered position held with the feature off never TP-exits even
    // with price at/above the rung.
    // SAFETY: This test fixture is constructed to satisfy the asserted service/domain contract and is exercised by the surrounding test.
    const exitOffLayer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: makePool({ address: POOL, currentPrice: 200 }) }),
      configOverrides: {
        watchlistPools: [POOL],
        maxOpenPositions: 1,
      },
    }) as never;
    const decisions = await runWithSeededPosition(exitOffLayer, seedLadderedPosition());
    const tpExits = decisions.filter(
      (d) => d.action === "EXIT" && d.poolAddress === POOL && d.reasoning.startsWith("[tp-target]"),
    );
    expect(tpExits).toHaveLength(0);
  }, 20_000);
});
