import { describe, it, expect, vi, afterEach } from "vitest";
import { Effect } from "effect";
import {
  DLMMStrategy,
  baselineHalfWidthForBinStep,
  resolveRangeHalfWidth,
  recommendBinRangeForVolatility,
  recommendStrategyShape,
  halfWidthForPriceCoveragePct,
  ADAPTIVE_RANGE_REFERENCE_STDDEV,
  ADAPTIVE_RANGE_MIN_MULTIPLIER,
  ADAPTIVE_RANGE_MAX_MULTIPLIER,
  MIN_ADAPTIVE_HALF_WIDTH_BINS,
} from "../engine/strategy-service.js";
import { ConfigService, ConfigLive } from "../engine/config-service.js";
import { executePaper } from "../engine/program.js";
import type { StrategyApi, DbApi } from "../engine/services.js";
import type { AgentDecision } from "../engine/types.js";

// ─── Wave 9: volatility-adaptive range width ────────────────────────────────
//
// Model: halfWidth = base × clamp(σ / ADAPTIVE_RANGE_REFERENCE_STDDEV,
// ADAPTIVE_RANGE_MIN_MULTIPLIER, ADAPTIVE_RANGE_MAX_MULTIPLIER), then clamped
// to [MIN_ADAPTIVE_HALF_WIDTH_BINS, floor(MAX_REBALANCE_RANGE_BINS / 2)] so
// the full range never exceeds the risk cap. σ = 0 (cold start, < 2 snapshots
// of bin history) falls back to the bounded baseline — never a fabricated jump.

describe("baselineHalfWidthForBinStep (Wave 9)", () => {
  it("preserves the pre-Wave-9 binStep tiers", () => {
    expect(baselineHalfWidthForBinStep(1)).toBe(25);
    expect(baselineHalfWidthForBinStep(10)).toBe(25);
    expect(baselineHalfWidthForBinStep(11)).toBe(20);
    expect(baselineHalfWidthForBinStep(25)).toBe(20);
    expect(baselineHalfWidthForBinStep(26)).toBe(15);
    expect(baselineHalfWidthForBinStep(100)).toBe(15);
  });
});

describe("halfWidthForPriceCoveragePct (price-coverage floor)", () => {
  it("computes the bin width for a target price span (geometric bins)", () => {
    // binStep 4 → each bin is ×1.0004. To span +5% price needs
    // ceil(ln(1.05)/ln(1.0004)) ≈ 122 bins.
    expect(halfWidthForPriceCoveragePct(4, 5)).toBe(122);
    // binStep 100 → each bin ×1.01; +5% ≈ ceil(ln(1.05)/ln(1.01)) = 5 bins.
    expect(halfWidthForPriceCoveragePct(100, 5)).toBe(5);
  });

  it("coarse pools need far fewer bins than fine pools for the same coverage", () => {
    // The whole point: fine-binStep pools (SOL/USDC @4) need ~hi-width bins,
    // coarse pools (memecoin @50) need very few for the same ±5%.
    const fine = halfWidthForPriceCoveragePct(4, 5);
    const coarse = halfWidthForPriceCoveragePct(50, 5);
    expect(fine).toBeGreaterThan(10 * coarse);
    expect(coarse).toBe(10); // ceil(ln(1.05)/ln(1.005)) = 10
  });

  it("returns 0 when disabled (pct<=0) or the bin step is degenerate", () => {
    expect(halfWidthForPriceCoveragePct(4, 0)).toBe(0);
    expect(halfWidthForPriceCoveragePct(4, -3)).toBe(0);
    expect(halfWidthForPriceCoveragePct(0, 5)).toBe(0);
    expect(halfWidthForPriceCoveragePct(4, Number.NaN)).toBe(0);
    expect(halfWidthForPriceCoveragePct(Number.NaN, 5)).toBe(0);
  });

  it("is monotonic in pct: more coverage → wider range", () => {
    expect(halfWidthForPriceCoveragePct(4, 10)).toBeGreaterThan(halfWidthForPriceCoveragePct(4, 5));
    expect(halfWidthForPriceCoveragePct(100, 20)).toBeGreaterThan(
      halfWidthForPriceCoveragePct(100, 10),
    );
  });
});

describe("resolveRangeHalfWidth price-coverage floor", () => {
  it("price floor off (pct=0) → unchanged fixed bin-count baseline", () => {
    const w = resolveRangeHalfWidth({
      binStep: 4,
      configuredBaseHalfWidth: 0,
      adaptiveEnabled: false,
      volatilityStddev: 0,
      maxFullRangeBins: 200,
      minPriceCoveragePct: 0,
    });
    expect(w).toBe(25); // binStep≤10 tier
  });

  it("price floor lifts a fine-binStep pool out of the ±1% trap", () => {
    // SOL/USDC binStep 4: the 25-bin baseline is only ~±1% price, so a 40% swing
    // spends nearly the whole window out of range. A 5% price-coverage floor
    // widens the range to ~122 bins so it can actually hold the price path.
    const w = resolveRangeHalfWidth({
      binStep: 4,
      configuredBaseHalfWidth: 0,
      adaptiveEnabled: false,
      volatilityStddev: 0,
      maxFullRangeBins: 300, // half-cap 150 ≫ floor, so 122 is observable
      minPriceCoveragePct: 5,
    });
    expect(w).toBe(122);
  });

  it("coarse pools keep their bin-count baseline (floor is immaterial)", () => {
    // binStep 100's 5% floor is 5 bins < the 15-bin tier baseline, so no change.
    const w = resolveRangeHalfWidth({
      binStep: 100,
      configuredBaseHalfWidth: 0,
      adaptiveEnabled: false,
      volatilityStddev: 0,
      maxFullRangeBins: 200,
      minPriceCoveragePct: 5,
    });
    expect(w).toBe(15);
  });

  it("floor is bounded by the half-cap so it can never exceed the risk cap", () => {
    const w = resolveRangeHalfWidth({
      binStep: 4,
      configuredBaseHalfWidth: 0,
      adaptiveEnabled: false,
      volatilityStddev: 0,
      maxFullRangeBins: 100, // half-cap 50
      minPriceCoveragePct: 5, // raw floor would be 122
    });
    expect(w).toBe(50);
    expect(w * 2).toBeLessThanOrEqual(100);
  });

  it("at the default risk cap the floor still reaches the profitable width", () => {
    // With the live MAX_REBALANCE_RANGE_BINS=200 (half-cap 100), a 5% floor on
    // SOL/USDC caps at 100 bins = (1.0004)^100 ≈ ±4% price — exactly the width
    // that turned the pool positive in the honest backtest sweep, up from the
    // old ±2% (50-bin) ceiling the max multiplier would have held.
    const w = resolveRangeHalfWidth({
      binStep: 4,
      configuredBaseHalfWidth: 0,
      adaptiveEnabled: false,
      volatilityStddev: 0,
      maxFullRangeBins: 200,
      minPriceCoveragePct: 5,
    });
    expect(w).toBe(100);
  });

  it("floor composes with σ-scaling for high-vol fine-bin pools", () => {
    // Unbounded σ would take a 122-bin floor to ×2 = 244, but the half-cap
    // (maxFullRangeBins/2 = 100) clamps it. The floor prevents the multiplier
    // from silently keeping a fine pool at 50 bins (the old ±2% ceiling).
    const w = resolveRangeHalfWidth({
      binStep: 4,
      configuredBaseHalfWidth: 0,
      adaptiveEnabled: true,
      volatilityStddev: 100 * ADAPTIVE_RANGE_REFERENCE_STDDEV,
      maxFullRangeBins: 200,
      minPriceCoveragePct: 5,
    });
    expect(w).toBe(100);
  });

  it("env override still wins as the base; floor only raises it", () => {
    const w = resolveRangeHalfWidth({
      binStep: 4,
      configuredBaseHalfWidth: 60, // explicit env baseline
      adaptiveEnabled: false,
      volatilityStddev: 0,
      maxFullRangeBins: 300, // half-cap 150 ≫ floor 122
      minPriceCoveragePct: 5, // floor 122 > 60
    });
    expect(w).toBe(122);
  });
});

describe("resolveRangeHalfWidth (Wave 9)", () => {
  const base = { binStep: 20, maxFullRangeBins: 200 };

  it("adaptive disabled → binStep-tier baseline (today's behavior)", () => {
    const w = resolveRangeHalfWidth({
      ...base,
      configuredBaseHalfWidth: 0,
      adaptiveEnabled: false,
      volatilityStddev: 4,
    });
    expect(w).toBe(20);
  });

  it("adaptive disabled + env override → bounded env baseline", () => {
    const w = resolveRangeHalfWidth({
      ...base,
      configuredBaseHalfWidth: 33,
      adaptiveEnabled: false,
      volatilityStddev: 4,
    });
    expect(w).toBe(33);
  });

  it("cold start (σ=0, <2 snapshots) → baseline, never a fabricated jump", () => {
    const w = resolveRangeHalfWidth({
      ...base,
      configuredBaseHalfWidth: 0,
      adaptiveEnabled: true,
      volatilityStddev: 0,
    });
    expect(w).toBe(20);
  });

  it("high volatility → wider than baseline", () => {
    const baseline = resolveRangeHalfWidth({
      ...base,
      configuredBaseHalfWidth: 0,
      adaptiveEnabled: false,
      volatilityStddev: 0,
    });
    const highVol = resolveRangeHalfWidth({
      ...base,
      configuredBaseHalfWidth: 0,
      adaptiveEnabled: true,
      volatilityStddev: 2 * ADAPTIVE_RANGE_REFERENCE_STDDEV,
    });
    expect(highVol).toBeGreaterThan(baseline);
    expect(highVol).toBe(40); // 20 × clamp(4/2, 0.5, 2) = 20 × 2
  });

  it("low volatility → narrower than baseline (fee concentration)", () => {
    const w = resolveRangeHalfWidth({
      ...base,
      configuredBaseHalfWidth: 0,
      adaptiveEnabled: true,
      volatilityStddev: ADAPTIVE_RANGE_REFERENCE_STDDEV / 2,
    });
    expect(w).toBeLessThan(20);
    expect(w).toBe(10); // 20 × clamp(1/2, 0.5, 2) = 20 × 0.5
  });

  it("exact multiplier math: σ = 1.5× reference → 1.5× base", () => {
    const w = resolveRangeHalfWidth({
      ...base,
      configuredBaseHalfWidth: 0,
      adaptiveEnabled: true,
      volatilityStddev: 1.5 * ADAPTIVE_RANGE_REFERENCE_STDDEV,
    });
    expect(w).toBe(30); // 20 × 1.5
  });

  it("multiplier clamps at the min for near-flat pools", () => {
    const w = resolveRangeHalfWidth({
      ...base,
      configuredBaseHalfWidth: 0,
      adaptiveEnabled: true,
      volatilityStddev: 0.1 * ADAPTIVE_RANGE_REFERENCE_STDDEV,
    });
    expect(w).toBe(Math.round(20 * ADAPTIVE_RANGE_MIN_MULTIPLIER)); // 10
  });

  it("multiplier clamps at the max for extreme volatility", () => {
    const w = resolveRangeHalfWidth({
      ...base,
      configuredBaseHalfWidth: 0,
      adaptiveEnabled: true,
      volatilityStddev: 100 * ADAPTIVE_RANGE_REFERENCE_STDDEV,
    });
    expect(w).toBe(Math.round(20 * ADAPTIVE_RANGE_MAX_MULTIPLIER)); // 40
  });

  it("widening stays bounded by MAX_REBALANCE_RANGE_BINS (full width ≤ cap)", () => {
    const w = resolveRangeHalfWidth({
      binStep: 20,
      configuredBaseHalfWidth: 0,
      adaptiveEnabled: true,
      volatilityStddev: 100 * ADAPTIVE_RANGE_REFERENCE_STDDEV,
      maxFullRangeBins: 50, // risk cap → half cap 25
    });
    expect(w).toBe(25);
    expect(w * 2).toBeLessThanOrEqual(50);
  });

  it("baseline itself is bounded by the cap even with an oversized env override", () => {
    const w = resolveRangeHalfWidth({
      binStep: 20,
      configuredBaseHalfWidth: 60,
      adaptiveEnabled: false,
      volatilityStddev: 0,
      maxFullRangeBins: 50,
    });
    expect(w).toBe(25);
  });

  it("narrowing never drops below the sane floor", () => {
    const w = resolveRangeHalfWidth({
      binStep: 20,
      configuredBaseHalfWidth: 8,
      adaptiveEnabled: true,
      volatilityStddev: 0.1 * ADAPTIVE_RANGE_REFERENCE_STDDEV, // → 8 × 0.5 = 4
      maxFullRangeBins: 200,
    });
    expect(w).toBe(MIN_ADAPTIVE_HALF_WIDTH_BINS);
  });

  it("env override combines with adaptation: env sets base, σ scales it", () => {
    const w = resolveRangeHalfWidth({
      binStep: 20,
      configuredBaseHalfWidth: 30,
      adaptiveEnabled: true,
      volatilityStddev: 2 * ADAPTIVE_RANGE_REFERENCE_STDDEV,
      maxFullRangeBins: 200,
    });
    expect(w).toBe(60); // 30 × 2
  });
});

describe("recommendBinRange half-width override (Wave 9)", () => {
  it("keeps the tiered default when no override is passed", () => {
    expect(DLMMStrategy.recommendBinRange(5000, 10)).toEqual({
      lowerBinId: 4975,
      upperBinId: 5025,
    });
    expect(DLMMStrategy.recommendBinRange(5000, 50)).toEqual({
      lowerBinId: 4985,
      upperBinId: 5015,
    });
  });

  it("centers the range at ±override when one is passed", () => {
    expect(DLMMStrategy.recommendBinRange(5000, 10, 33)).toEqual({
      lowerBinId: 4967,
      upperBinId: 5033,
    });
  });
});

describe("recommendBinRangeForVolatility base override (Wave 9)", () => {
  it("uses the env baseline for the low-vol path", () => {
    const r = recommendBinRangeForVolatility(5000, 10, false, 50, 30);
    expect(r.halfWidth).toBe(30);
  });

  it("doubles the env baseline for the high-vol path", () => {
    const r = recommendBinRangeForVolatility(5000, 10, true, 50, 30);
    expect(r.halfWidth).toBe(60); // max(30 × 2, 50)
  });
});

describe("width is orthogonal to the W7 strategy shape (Wave 9)", () => {
  it("same σ feeds shape and width independently — no cross-talk", () => {
    const highVolStddev = 5;
    // W7 shape rule: high-vol chop (no trend) → spot. Unchanged by Wave 9.
    const shape = recommendStrategyShape({
      volatilityStddev: highVolStddev,
      highVolThreshold: 5,
      netDriftBins: 0,
    });
    expect(shape).toBe("spot");
    // Wave 9 width rule on the same σ: widened, bounded.
    const width = resolveRangeHalfWidth({
      binStep: 20,
      configuredBaseHalfWidth: 0,
      adaptiveEnabled: true,
      volatilityStddev: highVolStddev,
      maxFullRangeBins: 200,
    });
    expect(width).toBe(40);
    // Calm regime: W7 → curve, Wave 9 → narrower. Orthogonal knobs.
    const calmShape = recommendStrategyShape({
      volatilityStddev: 1,
      highVolThreshold: 5,
      netDriftBins: 0,
    });
    expect(calmShape).toBe("curve");
    const calmWidth = resolveRangeHalfWidth({
      binStep: 20,
      configuredBaseHalfWidth: 0,
      adaptiveEnabled: true,
      volatilityStddev: 1,
      maxFullRangeBins: 200,
    });
    expect(calmWidth).toBe(10);
  });
});

describe("ConfigService Wave 9 env vars", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function loadConfig() {
    return Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          return yield* ConfigService;
        }),
        ConfigLive,
        { local: true },
      ),
    );
  }

  it("defaults: 0 (binStep-tier baseline), adaptive enabled, 5% price-coverage floor", async () => {
    // Explicit removal so a dev/CI export of these vars can't silently bypass
    // the default assertions; the shared afterEach(unstubAllEnvs) restores them.
    vi.stubEnv("ENTRY_RANGE_HALF_WIDTH_BINS", undefined);
    vi.stubEnv("VOLATILITY_ADAPTIVE_RANGES", undefined);
    vi.stubEnv("MIN_RANGE_HALF_WIDTH_PCT", undefined);
    const cfg = await loadConfig();
    expect(cfg.entryRangeHalfWidthBins).toBe(0);
    expect(cfg.volatilityAdaptiveRanges).toBe(true);
    expect(cfg.minRangeHalfWidthPct).toBe(5);
  });

  it("parses VOLATILITY_ADAPTIVE_RANGES=false to opt out into static widths", async () => {
    vi.stubEnv("VOLATILITY_ADAPTIVE_RANGES", "false");
    const cfg = await loadConfig();
    expect(cfg.volatilityAdaptiveRanges).toBe(false);
  });

  it("parses ENTRY_RANGE_HALF_WIDTH_BINS", async () => {
    vi.stubEnv("ENTRY_RANGE_HALF_WIDTH_BINS", "30");
    const cfg = await loadConfig();
    expect(cfg.entryRangeHalfWidthBins).toBe(30);
  });

  it("falls back to 0 for negative ENTRY_RANGE_HALF_WIDTH_BINS", async () => {
    vi.stubEnv("ENTRY_RANGE_HALF_WIDTH_BINS", "-5");
    const cfg = await loadConfig();
    expect(cfg.entryRangeHalfWidthBins).toBe(0);
  });

  it("falls back to 0 for non-numeric ENTRY_RANGE_HALF_WIDTH_BINS", async () => {
    vi.stubEnv("ENTRY_RANGE_HALF_WIDTH_BINS", "wide");
    const cfg = await loadConfig();
    expect(cfg.entryRangeHalfWidthBins).toBe(0);
  });

  it("parses VOLATILITY_ADAPTIVE_RANGES=true", async () => {
    vi.stubEnv("VOLATILITY_ADAPTIVE_RANGES", "true");
    const cfg = await loadConfig();
    expect(cfg.volatilityAdaptiveRanges).toBe(true);
  });

  it("parses MIN_RANGE_HALF_WIDTH_PCT", async () => {
    vi.stubEnv("MIN_RANGE_HALF_WIDTH_PCT", "8");
    const cfg = await loadConfig();
    expect(cfg.minRangeHalfWidthPct).toBe(8);
  });

  it("clamps MIN_RANGE_HALF_WIDTH_PCT to the 0-50 bound", async () => {
    vi.stubEnv("MIN_RANGE_HALF_WIDTH_PCT", "200");
    const cfg = await loadConfig();
    expect(cfg.minRangeHalfWidthPct).toBe(50);
  });

  it("falls back to 0 (floor off) for negative MIN_RANGE_HALF_WIDTH_PCT", async () => {
    vi.stubEnv("MIN_RANGE_HALF_WIDTH_PCT", "-3");
    const cfg = await loadConfig();
    expect(cfg.minRangeHalfWidthPct).toBe(0);
  });
});

describe("executePaper entry range threading (Wave 9)", () => {
  it("paper ENTER passes the resolved adaptive half-width to recommendBinRange", () => {
    const poolAddress = "TestPool111111111111111111111111111111111111";
    const recommendBinRangeSpy = vi.fn(
      (activeBinId: number, _binStep: number, halfWidthOverride?: number) => ({
        lowerBinId: activeBinId - (halfWidthOverride ?? 20),
        upperBinId: activeBinId + (halfWidthOverride ?? 20),
      }),
    );
    const strategy: StrategyApi = {
      computeMetrics: () => {
        throw new Error("not used");
      },
      checkVolumeAuthenticity: () => ({ score: 1, flags: [] }),
      computeBinUtilization: () => 1,
      computeFeeIlRatio: () => 1,
      recommendBinRange: recommendBinRangeSpy,
      passesPreFilter: () => true,
    };
    const db = {
      savePosition: () => Effect.void,
      savePositionEvent: () => Effect.void,
    } as unknown as DbApi;
    const trackedPositions = new Map();

    const result = Effect.runSync(
      executePaper(
        { db, trackedPositions, strategy, entryStrategyShape: "spot", entryRangeHalfWidth: 40 },
        {
          action: "ENTER",
          poolAddress,
          confidence: 0.8,
          reasoning: "test",
          positionSizeUsd: 1000,
        } as AgentDecision,
        {
          activeBinId: 5000,
          binStep: 10,
          tokenXSymbol: "SOL",
          tokenYSymbol: "USDC",
          currentPrice: 150,
        },
      ),
    );

    expect(result.executed).toBe(true);
    // The resolved adaptive width (e.g. 2× the ±20 baseline in a high-vol
    // regime) is threaded through, not recomputed inside the executor.
    expect(recommendBinRangeSpy).toHaveBeenCalledWith(5000, 10, 40, undefined);
    const pos = [...trackedPositions.values()][0] as
      | { lowerBinId: number; upperBinId: number }
      | undefined;
    expect(pos?.lowerBinId).toBe(5000 - 40);
    expect(pos?.upperBinId).toBe(5000 + 40);
  });
});
