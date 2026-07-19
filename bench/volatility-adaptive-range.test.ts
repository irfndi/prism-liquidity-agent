import { describe, it, expect, vi, afterEach } from "vitest";
import { Effect } from "effect";
import {
  DLMMStrategy,
  baselineHalfWidthForBinStep,
  resolveRangeHalfWidth,
  recommendBinRangeForVolatility,
  recommendStrategyShape,
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
      ),
    );
  }

  it("defaults: 0 (binStep-tier baseline) and adaptive disabled", async () => {
    const cfg = await loadConfig();
    expect(cfg.entryRangeHalfWidthBins).toBe(0);
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
    expect(recommendBinRangeSpy).toHaveBeenCalledWith(5000, 10, 40);
    const pos = [...trackedPositions.values()][0] as
      | { lowerBinId: number; upperBinId: number }
      | undefined;
    expect(pos?.lowerBinId).toBe(5000 - 40);
    expect(pos?.upperBinId).toBe(5000 + 40);
  });
});
