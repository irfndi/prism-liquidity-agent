/** Market-runner lane tests: high-yield classification (measured-only) and
 * the lowest-APR rotation exit. */
import { describe, expect, it } from "vitest";
import {
  isMarketRunnerPool,
  lowestAprHeldPosition,
  shouldRotate,
} from "../engine/market-runner.js";

const RUNNER = "runnerPool11111111111111111111111111111111111111";
const FLAT = "flatPool22222222222222222222222222222222222222222";
const pools = new Set([RUNNER, FLAT]);

function classify(overrides: Partial<Parameters<typeof isMarketRunnerPool>[0]> = {}) {
  return isMarketRunnerPool({
    enabled: true,
    marketScanPools: pools,
    poolAddress: RUNNER,
    statsSource: "datapi",
    feeAprPct: 5_000,
    runnerMinFeeApr: 500,
    ...overrides,
  });
}

describe("isMarketRunnerPool (high-yield classification)", () => {
  it("admits a hot market pool with measured datapi fees above the floor", () => {
    expect(classify()).toBe(true);
  });

  it("lane disabled -> never a runner", () => {
    expect(classify({ enabled: false })).toBe(false);
  });

  it("not in the market scan set -> never a runner", () => {
    expect(classify({ poolAddress: "outside3333333333333333333333333333333333333" })).toBe(false);
  });

  it("modeled gecko or heuristic fees NEVER classify (measured-only)", () => {
    // Same measured-only exclusion as paper fee accrual: a modeled fee APR
    // must not route a pool into the time-boxed runner posture.
    expect(classify({ statsSource: "geckoterminal" })).toBe(false);
    expect(classify({ statsSource: "heuristic" })).toBe(false);
  });

  it("below the runner floor -> normal posture (flat majors stay flat)", () => {
    expect(classify({ feeAprPct: 300 })).toBe(false);
    expect(classify({ feeAprPct: 499 })).toBe(false);
  });

  it("exactly at the floor -> runner", () => {
    expect(classify({ feeAprPct: 500 })).toBe(true);
  });
});

describe("lowestAprHeldPosition (rotation target)", () => {
  it("picks the lowest-APR held position", () => {
    const aprs = new Map([
      [RUNNER, 5_000],
      [FLAT, 25],
    ]);
    expect(lowestAprHeldPosition([{ poolAddress: RUNNER }, { poolAddress: FLAT }], aprs)).toEqual({
      poolAddress: FLAT,
      feeAprPct: 25,
    });
  });

  it("never rotates out of an unmeasured/zero-APR position (fail-closed)", () => {
    const aprs = new Map([[FLAT, 25]]);
    expect(lowestAprHeldPosition([{ poolAddress: RUNNER }], aprs)).toBeNull();
  });

  it("empty positions -> null", () => {
    expect(lowestAprHeldPosition([], new Map())).toBeNull();
  });
});

describe("shouldRotate (APR multiplier gate)", () => {
  it("5000% runner vs 25% held with 5x mult -> rotate", () => {
    expect(shouldRotate(5_000, { poolAddress: FLAT, feeAprPct: 25 }, 5)).toBe(true);
  });

  it("marginal 100% candidate vs 25% held -> no rotation", () => {
    expect(shouldRotate(100, { poolAddress: FLAT, feeAprPct: 25 }, 5)).toBe(false);
  });

  it("no worst position -> no rotation", () => {
    expect(shouldRotate(5_000, null, 5)).toBe(false);
  });

  it("defaults to 5x when the multiplier is unset", () => {
    expect(shouldRotate(126, { poolAddress: FLAT, feeAprPct: 25 }, undefined)).toBe(true);
    expect(shouldRotate(124, { poolAddress: FLAT, feeAprPct: 25 }, undefined)).toBe(false);
  });
});
