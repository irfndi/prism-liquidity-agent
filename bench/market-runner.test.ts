/** Market-runner lane tests: high-yield classification (measured-only) and
 * the lowest-APR rotation exit. */
import { describe, expect, it } from "vitest";
import {
  consecutiveAboveFloorObservations,
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
      [RUNNER, { feeAprPct: 5_000, tvlUsd: 200_000 }],
      [FLAT, { feeAprPct: 25, tvlUsd: 1_000_000 }],
    ]);
    expect(lowestAprHeldPosition([{ poolAddress: RUNNER }, { poolAddress: FLAT }], aprs)).toEqual({
      poolAddress: FLAT,
      feeAprPct: 25,
      tvlUsd: 1_000_000,
    });
  });

  it("never rotates out of an unmeasured/zero-APR position (fail-closed)", () => {
    const aprs = new Map([[FLAT, { feeAprPct: 25, tvlUsd: 1_000_000 }]]);
    expect(lowestAprHeldPosition([{ poolAddress: RUNNER }], aprs)).toBeNull();
  });

  it("never rotates out of the candidate runner itself (no exit-and-reenter)", () => {
    // A held position on the runner pool must not be exited while the same
    // pool re-enters in the same cycle.
    const aprs = new Map([
      [RUNNER, { feeAprPct: 5_000, tvlUsd: 200_000 }],
      [FLAT, { feeAprPct: 25, tvlUsd: 1_000_000 }],
    ]);
    expect(
      lowestAprHeldPosition([{ poolAddress: RUNNER }, { poolAddress: FLAT }], aprs, RUNNER),
    ).toEqual({ poolAddress: FLAT, feeAprPct: 25, tvlUsd: 1_000_000 });
    // Runner is the ONLY held position -> nothing to rotate into it.
    expect(lowestAprHeldPosition([{ poolAddress: RUNNER }], aprs, RUNNER)).toBeNull();
  });

  it("empty positions -> null", () => {
    expect(lowestAprHeldPosition([], new Map())).toBeNull();
  });
});

describe("consecutiveAboveFloorObservations (persistence gate)", () => {
  const now = 1_800_000_000_000;
  it("counts trailing consecutive above-floor observations (newest-first)", () => {
    const obs = [
      { at: now, apr: 6_000 },
      { at: now - 600_000, apr: 5_500 },
      { at: now - 1_200_000, apr: 300 },
    ];
    expect(consecutiveAboveFloorObservations(obs, 500, now, 3_600_000)).toBe(2);
  });

  it("breaks on the first below-floor observation", () => {
    const obs = [
      { at: now, apr: 6_000 },
      { at: now - 600_000, apr: 100 },
    ];
    expect(consecutiveAboveFloorObservations(obs, 500, now, 3_600_000)).toBe(1);
  });

  it("stale observations break the streak (two cycles days apart are not consecutive)", () => {
    const obs = [
      { at: now, apr: 6_000 },
      { at: now - 5 * 3_600_000, apr: 6_000 },
    ];
    expect(consecutiveAboveFloorObservations(obs, 500, now, 3_600_000)).toBe(1);
  });

  it("empty history -> 0", () => {
    expect(consecutiveAboveFloorObservations([], 500, now, 3_600_000)).toBe(0);
  });
});

describe("shouldRotate (APR multiplier gate)", () => {
  it("5000% runner vs 25% held with 5x mult -> rotate", () => {
    expect(shouldRotate(5_000, { poolAddress: FLAT, feeAprPct: 25, tvlUsd: 1_000_000 }, 5)).toBe(
      true,
    );
  });

  it("marginal 100% candidate vs 25% held -> no rotation", () => {
    expect(shouldRotate(100, { poolAddress: FLAT, feeAprPct: 25, tvlUsd: 1_000_000 }, 5)).toBe(
      false,
    );
  });

  it("no worst position -> no rotation", () => {
    expect(shouldRotate(5_000, null, 5)).toBe(false);
  });

  it("defaults to 5x when the multiplier is unset", () => {
    expect(
      shouldRotate(126, { poolAddress: FLAT, feeAprPct: 25, tvlUsd: 1_000_000 }, undefined),
    ).toBe(true);
    expect(
      shouldRotate(124, { poolAddress: FLAT, feeAprPct: 25, tvlUsd: 1_000_000 }, undefined),
    ).toBe(false);
  });
});
