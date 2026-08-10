import { describe, expect, it } from "vitest";
import { dipOffsetBinsForPct } from "../engine/strategy-service.js";
import { scaleInTopUpUsd, shouldScaleInRunner } from "../engine/launch-position.js";

describe("dipOffsetBinsForPct (runner-mode dip anchor)", () => {
  it("binStep 100, 12% dip -> -13 bins (the Heart Attack -12% band)", () => {
    // ln(0.88)/ln(1.01) = -12.77 -> round -13. At 1% per bin, -13 bins is
    // -12.2% below the active bin.
    expect(dipOffsetBinsForPct(100, 0.12)).toBe(-13);
  });

  it("binStep 100, 15% dip -> -17 bins", () => {
    // ln(0.85)/ln(1.01) = -16.2 -> -16? ln(0.85) = -0.1625, ln(1.01) = 0.00995
    // -> -16.33 -> round -16.
    expect(dipOffsetBinsForPct(100, 0.15)).toBe(-16);
  });

  it("coarser bins (binStep 200) need fewer bins for the same dip", () => {
    // 2% per bin: ln(0.88)/ln(1.02) = -6.44 -> -6.
    expect(dipOffsetBinsForPct(200, 0.12)).toBe(-6);
  });

  it("returns 0 for a zero dip, negative dip, or degenerate bin step", () => {
    expect(dipOffsetBinsForPct(100, 0)).toBe(0);
    expect(dipOffsetBinsForPct(100, -0.1)).toBe(0);
    expect(dipOffsetBinsForPct(0, 0.12)).toBe(0);
    expect(dipOffsetBinsForPct(NaN, 0.12)).toBe(0);
  });

  it("returns 0 for dip >= 1 (ln(0) = -Infinity) and non-finite dips", () => {
    expect(dipOffsetBinsForPct(100, 1)).toBe(0);
    expect(dipOffsetBinsForPct(100, 1.5)).toBe(0);
    expect(dipOffsetBinsForPct(100, NaN)).toBe(0);
    expect(dipOffsetBinsForPct(100, Infinity)).toBe(0);
  });

  it("shifts the whole range below the active bin via recommendBinRange", () => {
    // Exercises the strategy surface directly: a ±5 bin band anchored -13
    // bins below active bin 5000 lands entirely below market.
    const { DLMMStrategy } = require("../engine/strategy-service.js") as {
      DLMMStrategy: {
        recommendBinRange: (
          a: number,
          b: number,
          h?: number,
          d?: number,
        ) => { lowerBinId: number; upperBinId: number };
      };
    };
    const range = DLMMStrategy.recommendBinRange(5000, 100, 5, -13);
    expect(range.lowerBinId).toBe(5000 - 5 - 13);
    expect(range.upperBinId).toBe(5000 + 5 - 13);
    expect(range.upperBinId).toBeLessThan(5000); // entirely below the active bin
  });

  it("anchors a 50% dip (the config max) with the finest bins (binStep 1)", () => {
    // LAUNCH_RUNNER_DIP_PCT clamps at 0.5 (config-service). At 1bp per bin:
    // ln(0.5)/ln(1.0001) = -6931.5 -> round -6932.
    expect(dipOffsetBinsForPct(1, 0.5)).toBe(-6932);
  });

  it("anchors a 50% dip (the config max) with the coarsest bins (binStep 200)", () => {
    // 2% per bin: ln(0.5)/ln(1.02) = -35.0 -> round -35.
    expect(dipOffsetBinsForPct(200, 0.5)).toBe(-35);
  });
});

describe("shouldScaleInRunner (runner scale-in trigger)", () => {
  it("scales when the price drop is exactly stepPct", () => {
    // anchor 100 -> 95 is a 0.05 drop, exactly the 5% step: drop >= stepPct
    // fires (the guard is `drop < stepPct` -> no scale).
    const d = shouldScaleInRunner({
      anchorPrice: 100,
      currentPrice: 95,
      stepPct: 0.05,
      steps: 0,
      maxSteps: 3,
    });
    expect(d.scale).toBe(true);
    expect(d.reason).toContain("step 1/3");
  });

  it("does not scale one basis point under stepPct", () => {
    // 95.01 -> drop 0.0499 < 0.05: just under the step.
    const d = shouldScaleInRunner({
      anchorPrice: 100,
      currentPrice: 95.01,
      stepPct: 0.05,
      steps: 0,
      maxSteps: 3,
    });
    expect(d.scale).toBe(false);
    expect(d.reason).toContain("< step 5%");
  });

  it("refuses to scale when steps are exactly at maxSteps", () => {
    const d = shouldScaleInRunner({
      anchorPrice: 100,
      currentPrice: 90,
      stepPct: 0.05,
      steps: 3,
      maxSteps: 3,
    });
    expect(d.scale).toBe(false);
    expect(d.reason).toContain("max steps reached");
  });

  it("scales on the last allowed step (maxSteps - 1)", () => {
    const d = shouldScaleInRunner({
      anchorPrice: 100,
      currentPrice: 95,
      stepPct: 0.05,
      steps: 2,
      maxSteps: 3,
    });
    expect(d.scale).toBe(true);
    expect(d.reason).toContain("step 3/3");
  });
});

describe("scaleInTopUpUsd (runner top-up sizing)", () => {
  it("sizes an all-in step (sizePct 1.0) at the full wallet", () => {
    // min(1.0 * 500, 1000 cap, 1000 ceiling) = 500.
    expect(
      scaleInTopUpUsd({ walletUsd: 500, sizePct: 1.0, poolCapUsd: 1000, maxTopUpUsd: 1000 }),
    ).toBe(500);
  });

  it("caps exactly when poolCapUsd equals sizePct * walletUsd", () => {
    // 0.25 * 400 = 100, pool cap 100: the tie resolves to 100 (boundary is
    // inclusive), and one dollar less of headroom binds the cap instead.
    expect(
      scaleInTopUpUsd({ walletUsd: 400, sizePct: 0.25, poolCapUsd: 100, maxTopUpUsd: 500 }),
    ).toBe(100);
    expect(
      scaleInTopUpUsd({ walletUsd: 400, sizePct: 0.25, poolCapUsd: 99, maxTopUpUsd: 500 }),
    ).toBe(99);
  });

  it("floors at 0 when maxTopUpUsd is 0", () => {
    // The hard ceiling is 0, so even a large wallet + headroom yields 0.
    expect(
      scaleInTopUpUsd({ walletUsd: 1000, sizePct: 0.5, poolCapUsd: 500, maxTopUpUsd: 0 }),
    ).toBe(0);
  });
});
