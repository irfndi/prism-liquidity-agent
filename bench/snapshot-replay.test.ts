import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { DbLive } from "../engine/db-service.js";
import { DbService } from "../engine/services.js";
import type { BinArray, PoolSnapshot, PoolState } from "../engine/types.js";
import { DLMMStrategy } from "../engine/strategy-service.js";
import type { BacktestResult } from "../engine/types.js";

function run<T>(effect: Effect.Effect<T, unknown, unknown>, layer: unknown): T {
  return Effect.runSync((Effect.provide as any)(effect, layer));
}

function makeSnapshot(overrides: Partial<PoolSnapshot> = {}): PoolSnapshot {
  const bins = Array.from({ length: 8 }, (_, j) => ({
    binId: j,
    price: 100 + j,
    reserveX: BigInt(1_000_000 + j),
    reserveY: BigInt(2_000_000 + j),
    liquiditySupply: BigInt(10_000_000 + j),
  }));
  const binArray: BinArray = {
    lowerBinId: 0,
    upperBinId: 7,
    bins,
    activeBinId: 4,
    binStep: 10,
  };
  return {
    poolAddress: overrides.poolAddress ?? "Pool111111111111111111111111111111111111111",
    timestamp: overrides.timestamp ?? 1_700_000_000_000,
    activeBinId: overrides.activeBinId ?? 4,
    tvlUsd: overrides.tvlUsd ?? 50_000,
    volume24hUsd: overrides.volume24hUsd ?? 100_000,
    fees24hUsd: overrides.fees24hUsd ?? 150,
    apr: overrides.apr ?? 60,
    currentPrice: overrides.currentPrice ?? 100,
    binStep: overrides.binStep ?? 10,
    tokenXSymbol: overrides.tokenXSymbol ?? "SOL",
    tokenYSymbol: overrides.tokenYSymbol ?? "USDC",
    binArray: overrides.binArray ?? binArray,
  };
}

describe("DbService — snapshots", () => {
  it("saves a snapshot and round-trips it", () => {
    const layer = DbLive(":memory:");
    const snap = makeSnapshot();

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.saveSnapshot(snap);
        const all = yield* db.getSnapshots(
          snap.poolAddress,
          snap.timestamp - 1,
          snap.timestamp + 1,
        );
        expect(all).toHaveLength(1);
        const got = all[0]!;
        expect(got.poolAddress).toBe(snap.poolAddress);
        expect(got.activeBinId).toBe(snap.activeBinId);
        expect(got.tvlUsd).toBeCloseTo(snap.tvlUsd);
        expect(got.binArray.bins).toHaveLength(8);
        // bigints must survive the JSON round-trip
        expect(got.binArray.bins[0]!.reserveX).toBe(BigInt(1_000_000));
        expect(got.binArray.bins[7]!.liquiditySupply).toBe(BigInt(10_000_007));
      }),
      layer,
    );
  });

  it("filters snapshots by time range and orders ascending", () => {
    const layer = DbLive(":memory:");
    const t0 = 1_700_000_000_000;
    const s1 = makeSnapshot({ timestamp: t0 + 1000 });
    const s2 = makeSnapshot({ timestamp: t0 + 2000 });
    const s3 = makeSnapshot({ timestamp: t0 + 3000 });

    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.saveSnapshot(s2);
        yield* db.saveSnapshot(s1);
        yield* db.saveSnapshot(s3);
        const window = yield* db.getSnapshots(s1.poolAddress, t0 + 1500, t0 + 2500);
        expect(window.map((s) => s.timestamp)).toEqual([t0 + 2000]);
      }),
      layer,
    );
  });

  it("lists distinct pool addresses with snapshots", () => {
    const layer = DbLive(":memory:");
    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.saveSnapshot(makeSnapshot({ poolAddress: "PoolA" }));
        yield* db.saveSnapshot(makeSnapshot({ poolAddress: "PoolA" }));
        yield* db.saveSnapshot(makeSnapshot({ poolAddress: "PoolB" }));
        const pools = yield* db.getSnapshotPools();
        expect(pools).toEqual(["PoolA", "PoolB"]);
      }),
      layer,
    );
  });

  it("counts snapshots per pool", () => {
    const layer = DbLive(":memory:");
    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        // Distinct timestamps for distinct snapshots: the (pool_address,
        // timestamp) UNIQUE index added in migration v7 enforces idempotent
        // re-imports — re-saving the same (pool, ts) is an upsert, not a
        // duplicate. Two snapshots for the same pool therefore need
        // different timestamps to count as separate rows.
        yield* db.saveSnapshot(
          makeSnapshot({ poolAddress: "PoolA", timestamp: 1_700_000_000_000 }),
        );
        yield* db.saveSnapshot(
          makeSnapshot({ poolAddress: "PoolA", timestamp: 1_700_000_100_000 }),
        );
        yield* db.saveSnapshot(
          makeSnapshot({ poolAddress: "PoolB", timestamp: 1_700_000_000_000 }),
        );
        const aCount = yield* db.getSnapshotCount("PoolA");
        const bCount = yield* db.getSnapshotCount("PoolB");
        const cCount = yield* db.getSnapshotCount("PoolC");
        expect(aCount).toBe(2);
        expect(bCount).toBe(1);
        expect(cCount).toBe(0);
      }),
      layer,
    );
  });
});

// ─── Replay strategy over a snapshot stream ──────────────────────────────────

interface ReplayConfig {
  halfWidth: number;
  driftThreshold: number;
  minHoldTicks: number;
  minNetBenefitUsd: number;
  maxRebalances: number;
}

function replaySnapshots(snaps: ReadonlyArray<PoolSnapshot>, cfg: ReplayConfig): BacktestResult {
  const initialValue = 10_000;
  let portfolioValue = initialValue;
  let rebalances = 0;
  let wins = 0;
  let totalFees = 0;
  let totalIl = 0;
  let previousTvl = snaps[0]?.tvlUsd ?? 0;
  let lower = (snaps[0]?.activeBinId ?? 0) - cfg.halfWidth;
  let upper = (snaps[0]?.activeBinId ?? 0) + cfg.halfWidth;
  let lastRebalance = -cfg.minHoldTicks;

  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i]!;
    const pool: PoolState = {
      address: s.poolAddress,
      tokenX: "",
      tokenY: "",
      tokenXSymbol: s.tokenXSymbol,
      tokenYSymbol: s.tokenYSymbol,
      tvlUsd: s.tvlUsd,
      volume24hUsd: s.volume24hUsd,
      fees24hUsd: s.fees24hUsd,
      apr: s.apr,
      activeBinId: s.activeBinId,
      binStep: s.binStep,
      currentPrice: s.currentPrice,
      timestamp: s.timestamp,
    };
    const metrics = DLMMStrategy.computeMetrics(pool, s.binArray, previousTvl);
    const inRange = s.activeBinId >= lower && s.activeBinId <= upper;
    const feesThisTick = inRange ? s.fees24hUsd / (24 * 6) : 0;
    totalFees += feesThisTick;
    portfolioValue += feesThisTick;

    const center = (lower + upper) / 2;
    const halfW = (upper - lower) / 2 || 1;
    const drift = Math.abs(s.activeBinId - center) / halfW;
    const ticksSince = i - lastRebalance;
    const canRebalance = rebalances < cfg.maxRebalances && ticksSince >= cfg.minHoldTicks;

    if (canRebalance && drift > cfg.driftThreshold) {
      const ilCost = portfolioValue * 0.001 * drift;
      const swapCost = portfolioValue * 0.0005;
      const cost = ilCost + swapCost;
      const expected = feesThisTick * cfg.minHoldTicks * 0.7;
      if (expected - cost > cfg.minNetBenefitUsd) {
        rebalances++;
        totalIl += cost;
        portfolioValue -= cost;
        lower = s.activeBinId - cfg.halfWidth;
        upper = s.activeBinId + cfg.halfWidth;
        lastRebalance = i;
        // simple win metric
        wins += expected > cost ? 1 : 0;
      }
    }
    previousTvl = s.tvlUsd;
    void metrics;
  }

  return {
    poolAddress: snaps[0]?.poolAddress ?? "",
    startDate: snaps[0]?.timestamp ?? 0,
    endDate: snaps[snaps.length - 1]?.timestamp ?? 0,
    initialValueUsd: initialValue,
    finalValueUsd: portfolioValue,
    totalFeesUsd: totalFees,
    totalIlUsd: totalIl,
    netPnlUsd: portfolioValue - initialValue,
    totalRebalances: rebalances,
    winRate: rebalances > 0 ? wins / rebalances : 0,
    sharpeRatio: 0,
  };
}

describe("snapshot replay", () => {
  it("returns a BacktestResult over a synthetic snapshot stream", () => {
    const t0 = 1_700_000_000_000;
    const snaps: PoolSnapshot[] = Array.from({ length: 50 }, (_, i) =>
      makeSnapshot({
        timestamp: t0 + i * 600_000,
        activeBinId: 5000 + Math.floor(Math.sin(i / 3) * 10),
        tvlUsd: 60_000 + i * 100,
        volume24hUsd: 200_000,
        fees24hUsd: 200,
      }),
    );
    const result = replaySnapshots(snaps, {
      halfWidth: 15,
      driftThreshold: 0.6,
      minHoldTicks: 6,
      minNetBenefitUsd: 0.1,
      maxRebalances: 10,
    });
    expect(result.poolAddress).toBe(snaps[0]!.poolAddress);
    expect(result.startDate).toBe(t0);
    expect(result.endDate).toBe(t0 + 49 * 600_000);
    expect(result.totalFeesUsd).toBeGreaterThan(0);
    expect(result.totalRebalances).toBeGreaterThanOrEqual(0);
    expect(result.netPnlUsd).toBeGreaterThan(-result.totalIlUsd);
  });
});
