/** Momentum/timing filter (throughput + winrate): the entry score gains a
 * bounded momentum term, falling pools are rejected by [drift-gate], and
 * positive drift boosts the normal-ENTER confidence so a feeIl ~2 pool with
 * real upward momentum crosses the 0.65 floor without lowering the threshold
 * for static pools. */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  weightedEntryScore,
  entryMomentumBoost,
  driftGateRejected,
  normalEntryConfidence,
} from "../engine/strategy-service.js";
import { program } from "../engine/program.js";
import {
  makeTestLayer,
  makeAdapter,
  makeDatapiStats,
  makePool,
  makePosition,
  asOwner,
} from "./helpers.js";
import { AuditService, DbService } from "../engine/services.js";
import type { PoolMetrics } from "../engine/types.js";
import type { SignalWeights } from "../engine/types.js";

function makeWeights(overrides: Partial<SignalWeights> = {}): SignalWeights {
  return {
    feeIlRatio: 1.0,
    volumeAuthenticity: 1.0,
    binUtilization: 1.0,
    tvlUsd: 1.0,
    tvlVelocity: 1.0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeMetrics(overrides: Partial<PoolMetrics> = {}): PoolMetrics {
  let metrics: PoolMetrics = {
    pool: {
      address: "TestPool",
      tokenX: "SOL",
      tokenY: "USDC",
      tokenXSymbol: "SOL",
      tokenYSymbol: "USDC",
      tvlUsd: 100_000,
      volume24hUsd: 30_000,
      fees24hUsd: 300,
      apr: 0.06,
      activeBinId: 5000,
      binStep: 10,
      currentPrice: 150,
      timestamp: Date.now(),
    },
    binArray: { lowerBinId: 4980, upperBinId: 5020, bins: [], activeBinId: 5000 },
    tvlVelocity: overrides.tvlVelocity ?? 0.1,
    feeIlRatio: overrides.feeIlRatio ?? 1.5,
    volumeAuthenticity: overrides.volumeAuthenticity ?? 0.85,
    binUtilization: overrides.binUtilization ?? 0.6,
    volumeAuthenticityKnown: overrides.volumeAuthenticityKnown ?? true,
    feeIlRatioKnown: overrides.feeIlRatioKnown ?? true,
    binUtilizationKnown: overrides.binUtilizationKnown ?? true,
    farmAprPct: overrides.farmAprPct ?? null,
  };
  if (overrides.netDriftBins !== undefined) {
    metrics = { ...metrics, netDriftBins: overrides.netDriftBins };
  }
  return metrics;
}

const MOMENTUM = { referenceBins: 20, scoreWeight: 0.15 };

describe("weightedEntryScore momentum term", () => {
  it("positive drift adds the bounded momentum weight", () => {
    const base = weightedEntryScore(makeMetrics(), makeWeights());
    const withDrift = weightedEntryScore(
      makeMetrics({ netDriftBins: 10 }),
      makeWeights(),
      MOMENTUM,
    );
    expect(withDrift - base).toBeCloseTo(0.075, 6); // 10/20 × 0.15
  });

  it("negative drift contributes 0", () => {
    const withDrift = weightedEntryScore(
      makeMetrics({ netDriftBins: -10 }),
      makeWeights(),
      MOMENTUM,
    );
    expect(withDrift).toBe(weightedEntryScore(makeMetrics(), makeWeights()));
  });

  it("drift at or above the reference saturates at the full weight", () => {
    const sat = weightedEntryScore(makeMetrics({ netDriftBins: 40 }), makeWeights(), MOMENTUM);
    expect(sat).toBeCloseTo(weightedEntryScore(makeMetrics(), makeWeights()) + 0.15, 6);
  });

  it("absent netDriftBins behaves as zero drift (2-arg call sites unchanged)", () => {
    expect(weightedEntryScore(makeMetrics(), makeWeights())).toBe(
      weightedEntryScore(makeMetrics(), makeWeights()),
    );
  });

  it("NaN drift contributes 0 (fail-closed)", () => {
    const nan = weightedEntryScore(makeMetrics({ netDriftBins: NaN }), makeWeights(), MOMENTUM);
    expect(nan).toBe(weightedEntryScore(makeMetrics(), makeWeights()));
  });
});

describe("entryMomentumBoost (pure)", () => {
  it("bounded clamp01(max(drift,0)/reference) * weight", () => {
    expect(entryMomentumBoost(10, 20, 0.15)).toBeCloseTo(0.075, 6);
    expect(entryMomentumBoost(-10, 20, 0.15)).toBe(0);
    expect(entryMomentumBoost(40, 20, 0.15)).toBeCloseTo(0.15, 6);
  });

  it("degenerate inputs fail closed", () => {
    expect(entryMomentumBoost(NaN, 20, 0.15)).toBe(0);
    expect(entryMomentumBoost(10, 0, 0.15)).toBe(0);
    expect(entryMomentumBoost(10, -5, 0.15)).toBe(0);
  });
});

describe("driftGateRejected (pure)", () => {
  it("strict <: below the floor rejects, at-floor enters", () => {
    expect(driftGateRejected(-10, -8)).toBe(true);
    expect(driftGateRejected(-8, -8)).toBe(false);
    expect(driftGateRejected(0, -8)).toBe(false);
  });

  it("custom floor", () => {
    expect(driftGateRejected(-5, -4)).toBe(true);
    expect(driftGateRejected(-3, -4)).toBe(false);
  });
});

describe("normalEntryConfidence (pure)", () => {
  it("positive drift crosses the 0.65 threshold where static would not", () => {
    // feeIl 2.0 → static 0.60; +10 bins of momentum → 0.60 + 0.025 = 0.625
    // (still under 0.65); +40 bins → +0.05 → 0.65 exactly.
    expect(normalEntryConfidence(2.0, 0)).toBeCloseTo(0.6, 6);
    expect(normalEntryConfidence(2.0, 40)).toBeCloseTo(0.65, 6);
    // feeIl 2.4 → static 0.62; a strong run pushes over the floor.
    expect(normalEntryConfidence(2.4, 20)).toBeGreaterThanOrEqual(0.65);
  });

  it("negative drift matches the static formula", () => {
    expect(normalEntryConfidence(2.0, -50)).toBeCloseTo(0.6, 6);
  });

  it("caps at 0.85", () => {
    expect(normalEntryConfidence(10, 100)).toBe(0.85);
  });

  it("defaults mirror the config values when opts omitted", () => {
    expect(normalEntryConfidence(2.0, 20)).toBeCloseTo(0.65, 6); // 20/20 × 0.05 = full boost
  });
});

describe("drift gate in the decision loop", () => {
  const POOL = "MomentumFallingPool111111111111111111111111111111";
  const NEUTRAL = "MomentumNeutralPool11111111111111111111111111111";

  it("a falling pool is rejected with [drift-gate]; a neutral pool proceeds", async () => {
    let call = 0;
    const layer = makeTestLayer({
      adapter: makeAdapter(
        {
          [POOL]: makePool({ address: POOL, tvlUsd: 100_000, fees24hUsd: 300 }),
          [NEUTRAL]: makePool({
            address: NEUTRAL,
            tvlUsd: 100_000,
            fees24hUsd: 300,
            tokenX: "NeutralTokenA1111111111111111111111111111111",
            tokenY: "NeutralTokenB1111111111111111111111111111111",
          }),
        },
        {
          // The falling pool steps DOWN 30 bins per CYCLE (~3 state reads
          // each) so the recent-bin window accumulates a large negative
          // drift; the neutral pool oscillates ±1 bin (no dominant drift).
          getPoolState: (addr: string) => {
            call += 1;
            const cycle = Math.floor(call / 3);
            const base = addr === POOL ? 5000 - 30 * cycle : 5000 + (cycle % 2 === 0 ? 1 : -1);
            const pool = makePool({
              address: addr,
              tvlUsd: 100_000,
              fees24hUsd: 300,
              activeBinId: base,
            });
            return Effect.succeed(pool);
          },
        },
      ),
      configOverrides: {
        paperTrading: true,
        scanIntervalMs: 100,
        watchlistPools: [POOL, NEUTRAL],
        marketScanMaxNegativeDriftBins: -8,
        tokenFailureBlockMs: 60_000, // the seeded block expires after ~2s
        volatilityLookbackSnapshots: 12,
      },
      datapi: {
        getPoolData: (addr: string) =>
          Effect.succeed(
            addr === POOL || addr === NEUTRAL
              ? makeDatapiStats({ address: addr, fees24hUsd: 300 })
              : null,
          ),
      },
    });
    const test = Effect.gen(function* () {
      const db = yield* DbService;
      // Seed a token execution-failure block on the falling pool's legs that
      // expires after ~2s: while it blocks, the bin history accumulates; when
      // it clears, the ENTER slot reaches the drift gate with a deeply
      // negative drift and the pool is rejected [drift-gate] instead of
      // entering on the first cycles (before any history exists).
      const TOKEN_A = "So11111111111111111111111111111111111111112";
      const TOKEN_B = "FakeToken1111111111111111111111111111111111";
      const blockAt = Date.now() - 58_000; // 2s of a 60s window remaining
      yield* db.setMetadata(`token_block:${TOKEN_A}`, String(blockAt));
      yield* db.setMetadata(`token_block:${TOKEN_B}`, String(blockAt));
      yield* Effect.raceFirst(program, Effect.sleep(8_000)); // wide window: parallel-load flake guard (real-clock expiry)
      const audit = yield* AuditService;
      const decisions = yield* audit.getRecentDecisions(300);
      return asOwner<
        ReadonlyArray<{
          action: string;
          reasoning: string;
          executed: boolean;
          poolAddress: string;
        }>
      >(decisions);
    });
    const decisions = (await Effect.runPromise(
      asOwner<
        Effect.Effect<
          ReadonlyArray<{
            action: string;
            reasoning: string;
            executed: boolean;
            poolAddress: string;
          }>,
          Error,
          never
        >
      >(Effect.provide(test, layer)),
    )) as ReadonlyArray<{
      action: string;
      reasoning: string;
      executed: boolean;
      poolAddress: string;
    }>;
    const driftRejections = decisions.filter(
      (d) => d.action === "ENTER" && d.reasoning.includes("[drift-gate]"),
    );
    expect(driftRejections.length).toBeGreaterThan(0);
    expect(driftRejections[0]!.reasoning).toContain("falling price, no momentum entry");
    const neutralDrift = decisions.filter(
      (d) =>
        d.action === "ENTER" && d.poolAddress === NEUTRAL && d.reasoning.includes("[drift-gate]"),
    );
    expect(neutralDrift.length).toBe(0);
  }, 30_000);
});
