import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { DbLive } from "../engine/db-service.js";
import { DbService } from "../engine/services.js";
import type { BinArray, PoolSnapshot, PoolState } from "../engine/types.js";
import { DLMMStrategy } from "../engine/strategy-service.js";
import type { BacktestResult } from "../engine/types.js";

function run<T, E, R>(effect: Effect.Effect<T, E, R>, layer: Layer.Layer<R, never, never>): T {
  return Effect.runSync(Effect.provide(effect, layer));
}

function snapshotIdentityDefaults(
  poolAddress: string | undefined,
  timestamp: number | undefined,
  activeBinId: number | undefined,
  binStep: number | undefined,
  tokenXSymbol: string | undefined,
  tokenYSymbol: string | undefined,
) {
  return {
    poolAddress: poolAddress ?? "Pool111111111111111111111111111111111111111",
    timestamp: timestamp ?? 1_700_000_000_000,
    activeBinId: activeBinId ?? 4,
    binStep: binStep ?? 10,
    tokenXSymbol: tokenXSymbol ?? "SOL",
    tokenYSymbol: tokenYSymbol ?? "USDC",
  };
}

function snapshotMarketDefaults(
  tvlUsd: number | undefined,
  volume24hUsd: number | undefined,
  fees24hUsd: number | undefined,
  apr: number | undefined,
  currentPrice: number | undefined,
) {
  return {
    tvlUsd: tvlUsd ?? 50_000,
    volume24hUsd: volume24hUsd ?? 100_000,
    fees24hUsd: fees24hUsd ?? 150,
    apr: apr ?? 60,
    currentPrice: currentPrice ?? 100,
  };
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
    ...snapshotIdentityDefaults(
      overrides.poolAddress,
      overrides.timestamp,
      overrides.activeBinId,
      overrides.binStep,
      overrides.tokenXSymbol,
      overrides.tokenYSymbol,
    ),
    ...snapshotMarketDefaults(
      overrides.tvlUsd,
      overrides.volume24hUsd,
      overrides.fees24hUsd,
      overrides.apr,
      overrides.currentPrice,
    ),
    binArray: overrides.binArray ?? binArray,
    statsSource: overrides.statsSource,
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

  it("persists and restores an explicit statsSource ('datapi' round-trips)", () => {
    const layer = DbLive(":memory:");
    const snap = makeSnapshot({ statsSource: "datapi" });

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
        // A Data-API snapshot must replay as "datapi" so the measured-fee-rate
        // authenticity gate stays active on replay.
        expect(all[0]!.statsSource).toBe("datapi");
      }),
      layer,
    );
  });

  it("normalizes a legacy snapshot without statsSource to conservative 'heuristic' (never 'datapi')", () => {
    const layer = DbLive(":memory:");
    const snap = makeSnapshot(); // no statsSource → unknown provenance

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
        // Unknown provenance fails closed: treated as fabricated, NOT datapi, so
        // the measured-fee-rate gate stays DISABLED exactly as the trust model
        // intends for a source-less pool.
        expect(all[0]!.statsSource).toBe("heuristic");
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

// Initial replay state from the first snapshot (or safe zeros for an empty stream);
// extracted from replaySnapshots to stay under the complexity cap.
function replayStartState(snaps: ReadonlyArray<PoolSnapshot>, cfg: ReplayConfig) {
  return {
    previousTvl: snaps[0]?.tvlUsd ?? 0,
    lower: (snaps[0]?.activeBinId ?? 0) - cfg.halfWidth,
    upper: (snaps[0]?.activeBinId ?? 0) + cfg.halfWidth,
    lastRebalance: -cfg.minHoldTicks,
  };
}

interface RebalanceEconomics {
  cost: number;
  expected: number;
}

function snapshotPoolState(snap: PoolSnapshot): PoolState {
  return {
    address: snap.poolAddress,
    tokenX: "",
    tokenY: "",
    tokenXSymbol: snap.tokenXSymbol,
    tokenYSymbol: snap.tokenYSymbol,
    tvlUsd: snap.tvlUsd,
    volume24hUsd: snap.volume24hUsd,
    fees24hUsd: snap.fees24hUsd,
    apr: snap.apr,
    activeBinId: snap.activeBinId,
    binStep: snap.binStep,
    currentPrice: snap.currentPrice,
    timestamp: snap.timestamp,
  };
}

function feesForTick(fees24hUsd: number, inRange: boolean): number {
  return inRange ? fees24hUsd / (24 * 6) : 0;
}

function driftOf(lower: number, upper: number, activeBinId: number): number {
  const center = (lower + upper) / 2;
  const halfW = (upper - lower) / 2 || 1;
  return Math.abs(activeBinId - center) / halfW;
}

function shouldRebalance(
  rebalances: number,
  maxRebalances: number,
  ticksSince: number,
  minHoldTicks: number,
  drift: number,
  driftThreshold: number,
): boolean {
  return rebalances < maxRebalances && ticksSince >= minHoldTicks && drift > driftThreshold;
}

function rebalanceEconomics(
  portfolioValue: number,
  drift: number,
  feesThisTick: number,
  minHoldTicks: number,
): RebalanceEconomics {
  const ilCost = portfolioValue * 0.001 * drift;
  const swapCost = portfolioValue * 0.0005;
  const cost = ilCost + swapCost;
  return { cost, expected: feesThisTick * minHoldTicks * 0.7 };
}

function buildBacktestResult(
  snaps: ReadonlyArray<PoolSnapshot>,
  initialValue: number,
  portfolioValue: number,
  totalFees: number,
  totalIl: number,
  rebalances: number,
  wins: number,
): BacktestResult {
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

function replaySnapshots(snaps: ReadonlyArray<PoolSnapshot>, cfg: ReplayConfig): BacktestResult {
  const initialValue = 10_000;
  let portfolioValue = initialValue;
  let rebalances = 0;
  let wins = 0;
  let totalFees = 0;
  let totalIl = 0;
  const start = replayStartState(snaps, cfg);
  let previousTvl = start.previousTvl;
  let lower = start.lower;
  let upper = start.upper;
  let lastRebalance = start.lastRebalance;

  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i]!;
    const pool = snapshotPoolState(s);
    const metrics = DLMMStrategy.computeMetrics(pool, s.binArray, previousTvl);
    const inRange = s.activeBinId >= lower && s.activeBinId <= upper;
    const feesThisTick = feesForTick(s.fees24hUsd, inRange);
    totalFees += feesThisTick;
    portfolioValue += feesThisTick;

    const drift = driftOf(lower, upper, s.activeBinId);
    const ticksSince = i - lastRebalance;

    if (
      shouldRebalance(
        rebalances,
        cfg.maxRebalances,
        ticksSince,
        cfg.minHoldTicks,
        drift,
        cfg.driftThreshold,
      )
    ) {
      const { cost, expected } = rebalanceEconomics(
        portfolioValue,
        drift,
        feesThisTick,
        cfg.minHoldTicks,
      );
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

  return buildBacktestResult(
    snaps,
    initialValue,
    portfolioValue,
    totalFees,
    totalIl,
    rebalances,
    wins,
  );
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

// ─── Stats-source trust model across the replay round-trip ───────────────────

// Elevated (not wash) volume/TVL plus an outlier fee rate — the exact shape the
// reviewer flagged: vol/tvl 6.0x → "elevated" (-0.15); fee rate 2.5% → above the
// 2% band (-0.2, ONLY when fees are measured). With the fee-rate component
// disabled the pool scores 0.85 and passes the 0.7 prefilter; with it enabled
// (datapi) it scores 0.65 and is rejected.
function replayPool(
  base: Pick<PoolSnapshot, "tvlUsd" | "volume24hUsd" | "fees24hUsd" | "statsSource">,
): PoolState {
  return {
    address: "Pool111111111111111111111111111111111111111",
    tokenX: "",
    tokenY: "",
    tokenXSymbol: "SOL",
    tokenYSymbol: "USDC",
    tvlUsd: base.tvlUsd,
    volume24hUsd: base.volume24hUsd,
    fees24hUsd: base.fees24hUsd,
    apr: 60,
    activeBinId: 4,
    binStep: 10,
    currentPrice: 100,
    timestamp: 1_700_000_000_000,
    statsSource: base.statsSource,
  };
}

describe("snapshot statsSource trust model on replay", () => {
  const outlierFees = {
    tvlUsd: 100_000,
    volume24hUsd: 600_000,
    fees24hUsd: 600_000 * 0.025,
  };

  it("a datapi snapshot restores gate-on: the outlier measured fee rate now rejects at the 0.7 prefilter", () => {
    const layer = DbLive(":memory:");
    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.saveSnapshot(makeSnapshot({ ...outlierFees, statsSource: "datapi" }));
        const [restored] = yield* db.getSnapshots(
          "Pool111111111111111111111111111111111111111",
          1_700_000_000_000 - 1,
          1_700_000_000_000 + 1,
        );
        // A Data-API snapshot replays as datapi…
        expect(restored!.statsSource).toBe("datapi");
        const pool = replayPool({ ...outlierFees, statsSource: restored!.statsSource });
        // …so the measured-fee-rate component fires (mirrors the backtest gate:
        // checkVolumeAuthenticity(pool, statsSource === "datapi")).
        const auth = DLMMStrategy.checkVolumeAuthenticity(pool, pool.statsSource === "datapi");
        expect(auth.flags.some((f: string) => f.includes("outlier"))).toBe(true);
        expect(auth.score).toBeCloseTo(0.65, 5);
        expect(DLMMStrategy.passesPreFilter(pool, auth.score, 0.5, 50_000, 0.7, 0.3)).toBe(false);
      }),
      layer,
    );
  });

  it("a source-less snapshot restores conservative 'heuristic': the gate stays DISABLED and the same pool passes", () => {
    const layer = DbLive(":memory:");
    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.saveSnapshot(makeSnapshot({ ...outlierFees })); // no statsSource
        const [restored] = yield* db.getSnapshots(
          "Pool111111111111111111111111111111111111111",
          1_700_000_000_000 - 1,
          1_700_000_000_000 + 1,
        );
        expect(restored!.statsSource).toBe("heuristic");
        const pool = replayPool({ ...outlierFees, statsSource: restored!.statsSource });
        const auth = DLMMStrategy.checkVolumeAuthenticity(pool, pool.statsSource === "datapi");
        // Fee-rate penalty NOT applied: outlier fee rate cannot push a healthy
        // pool under the prefilter when the source is unknown (deterministic).
        expect(auth.flags.some((f: string) => f.includes("outlier"))).toBe(false);
        expect(auth.score).toBeCloseTo(0.85, 5);
        expect(DLMMStrategy.passesPreFilter(pool, auth.score, 0.5, 50_000, 0.7, 0.3)).toBe(true);
      }),
      layer,
    );
  });

  it("a synthetic tick is classified 'heuristic' (not 'datapi'), keeping the fee-rate gate off", () => {
    const pool = replayPool({ ...outlierFees, statsSource: "heuristic" });
    expect(pool.statsSource).toBe("heuristic");
    expect(pool.statsSource).not.toBe("datapi");
    const auth = DLMMStrategy.checkVolumeAuthenticity(pool, pool.statsSource === "datapi");
    expect(auth.flags.some((f: string) => f.includes("outlier"))).toBe(false);
    expect(DLMMStrategy.passesPreFilter(pool, auth.score, 0.5, 50_000, 0.7, 0.3)).toBe(true);
  });
});
