import { describe, it, expect } from "vitest";
import {
  weightedEntryScore,
  DLMMStrategy,
  FARM_SCORE_WEIGHT,
  FARM_APR_SCORE_REFERENCE_PCT,
} from "../engine/strategy-service.js";
import { parseMeteoraPoolStats, enrichPoolWithDatapi } from "../engine/meteora-datapi-service.js";
import type { MeteoraPoolStats } from "../engine/services.js";
import type { PoolMetrics, SignalWeights } from "../engine/types.js";
import { makePool, makeBinArray } from "./helpers.js";

// ─── Wave 8: farm-aware scoring ──────────────────────────────────────────────
// DLMM farms stream LM rewards to active-bin liquidity; the Data API exposes
// has_farm + farm_apr (annualized percent). A farm pool must outrank an
// otherwise-identical non-farm pool, with the contribution bounded like the
// other score components.

const WEIGHTS: SignalWeights = {
  feeIlRatio: 1,
  volumeAuthenticity: 1,
  binUtilization: 1,
  tvlUsd: 1,
  tvlVelocity: 1,
  updatedAt: Date.now(),
};

function makeMetrics(overrides: Partial<PoolMetrics> = {}): PoolMetrics {
  const pool = makePool();
  const binArray = makeBinArray();
  return {
    pool,
    binArray,
    tvlVelocity: 0,
    feeIlRatio: 5,
    volumeAuthenticity: 0.9,
    binUtilization: 0.8,
    volumeAuthenticityKnown: true,
    binUtilizationKnown: true,
    farmAprPct: null,
    ...overrides,
  };
}

function makeStats(overrides: Partial<MeteoraPoolStats> = {}): MeteoraPoolStats {
  return {
    address: "unset",
    name: "TEST",
    tvlUsd: 200_000,
    volume24hUsd: 40_000,
    fees24hUsd: 400,
    apr: 20,
    apy: 20,
    currentPrice: 150,
    feeTvlRatio24h: null,
    feeTvlRatio12h: null,
    feeTvlRatio1h: null,
    dynamicFeePct: null,
    baseFeePct: null,
    hasFarm: null,
    farmApr: null,
    farmApy: null,
    isBlacklisted: null,
    tokenXFreezeAuthorityDisabled: null,
    tokenYFreezeAuthorityDisabled: null,
    tokenXVerified: null,
    tokenYVerified: null,
    ...overrides,
  };
}

describe("weightedEntryScore farm contribution", () => {
  it("(v) farm pool scores strictly higher than an identical non-farm pool", () => {
    const nonFarm = makeMetrics({ farmAprPct: null });
    const farm = makeMetrics({ farmAprPct: 80 });
    const nonFarmScore = weightedEntryScore(nonFarm, WEIGHTS);
    const farmScore = weightedEntryScore(farm, WEIGHTS);
    expect(farmScore).toBeGreaterThan(nonFarmScore);
  });

  it("(v) farm contribution is bounded (capped at FARM_SCORE_WEIGHT)", () => {
    const atCap = makeMetrics({ farmAprPct: FARM_APR_SCORE_REFERENCE_PCT });
    const beyondCap = makeMetrics({ farmAprPct: FARM_APR_SCORE_REFERENCE_PCT * 50 });
    const base = makeMetrics({ farmAprPct: null });
    const cappedGain = weightedEntryScore(atCap, WEIGHTS) - weightedEntryScore(base, WEIGHTS);
    expect(cappedGain).toBeCloseTo(FARM_SCORE_WEIGHT, 8);
    expect(weightedEntryScore(beyondCap, WEIGHTS)).toBeCloseTo(
      weightedEntryScore(atCap, WEIGHTS),
      8,
    );
  });

  it("(v) null/unknown farm APR contributes exactly nothing", () => {
    const unknown = makeMetrics({ farmAprPct: null });
    const zero = makeMetrics({ farmAprPct: 0 });
    expect(weightedEntryScore(unknown, WEIGHTS)).toBeCloseTo(weightedEntryScore(zero, WEIGHTS), 8);
  });

  it("(v) partial APR scales linearly below the reference", () => {
    const base = makeMetrics({ farmAprPct: null });
    const half = makeMetrics({ farmAprPct: FARM_APR_SCORE_REFERENCE_PCT / 2 });
    const gain = weightedEntryScore(half, WEIGHTS) - weightedEntryScore(base, WEIGHTS);
    expect(gain).toBeCloseTo(FARM_SCORE_WEIGHT / 2, 8);
  });
});

describe("DLMMStrategy.computeMetrics farm surface", () => {
  it("(v) surfaces farmAprPct when the pool has a farm", () => {
    const pool = makePool({ hasFarm: true, farmAprPct: 245.9, statsSource: "datapi" });
    const metrics = DLMMStrategy.computeMetrics(pool, makeBinArray(), 0);
    expect(metrics.farmAprPct).toBeCloseTo(245.9, 8);
  });

  it("(v) reports null farmAprPct for non-farm pools", () => {
    const pool = makePool({ hasFarm: false, farmAprPct: null, statsSource: "datapi" });
    const metrics = DLMMStrategy.computeMetrics(pool, makeBinArray(), 0);
    expect(metrics.farmAprPct).toBeNull();
  });

  it("(v) reports null farmAprPct when farm status is unknown (heuristic stats)", () => {
    const pool = makePool();
    const metrics = DLMMStrategy.computeMetrics(pool, makeBinArray(), 0);
    expect(metrics.farmAprPct).toBeNull();
  });

  it("(v) farm pool with missing APR reports 0 (farm known, APR unknown)", () => {
    const pool = makePool({ hasFarm: true, farmAprPct: null, statsSource: "datapi" });
    const metrics = DLMMStrategy.computeMetrics(pool, makeBinArray(), 0);
    expect(metrics.farmAprPct).toBe(0);
  });
});

describe("MeteoraPoolStats farm parsing", () => {
  const baseResponse = {
    address: "PoolABC111",
    name: "ADX-SOL",
    tvl: 500_000,
    current_price: 0.01,
    apr: 0.014,
    apy: 5,
    has_farm: true,
    farm_apr: 245.91591359986532,
    farm_apy: 1059.891966696301,
    volume: { "30m": 1, "1h": 2, "2h": 3, "4h": 4, "12h": 5, "24h": 10_000 },
    fees: { "30m": 1, "1h": 2, "2h": 3, "4h": 4, "12h": 5, "24h": 100 },
  };

  it("(v) parses farm_apr / farm_apy from the Data API payload", () => {
    const stats = parseMeteoraPoolStats(baseResponse);
    expect(stats).not.toBeNull();
    expect(stats!.hasFarm).toBe(true);
    expect(stats!.farmApr).toBeCloseTo(245.91591359986532, 8);
    expect(stats!.farmApy).toBeCloseTo(1059.891966696301, 8);
  });

  it("(v) missing farm fields degrade to null (schema drift safe)", () => {
    const { farm_apr: _a, farm_apy: _b, ...rest } = baseResponse;
    const stats = parseMeteoraPoolStats(rest);
    expect(stats).not.toBeNull();
    expect(stats!.farmApr).toBeNull();
    expect(stats!.farmApy).toBeNull();
  });
});

describe("enrichPoolWithDatapi farm fields", () => {
  it("(v) copies hasFarm + farmApr onto the pool state", () => {
    const raw = makePool();
    const enriched = enrichPoolWithDatapi(
      raw,
      makeStats({ hasFarm: true, farmApr: 169.2, farmApy: 440.9 }),
    );
    expect(enriched.hasFarm).toBe(true);
    expect(enriched.farmAprPct).toBeCloseTo(169.2, 8);
  });

  it("(v) non-farm pool gets hasFarm=false and null farmAprPct", () => {
    const enriched = enrichPoolWithDatapi(makePool(), makeStats({ hasFarm: false, farmApr: 0 }));
    expect(enriched.hasFarm).toBe(false);
    expect(enriched.farmAprPct).toBeNull();
  });
});
