/** Market-runner lane tests: high-yield classification (measured-only) and
 * the lowest-APR rotation exit. */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNNER_MIN_DRIFT_BINS,
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
  it("rejects a non-finite or non-positive measured APR", () => {
    expect(classify({ feeAprPct: Number.NaN })).toBe(false);
    expect(classify({ feeAprPct: Number.POSITIVE_INFINITY })).toBe(false);
    expect(classify({ feeAprPct: 0 })).toBe(false);
  });
});

describe("isMarketRunnerPool (drift-aware admission)", () => {
  it("admits a runner with healthy (non-declining) drift", () => {
    expect(classify({ netDriftBins: 0 })).toBe(true);
    expect(classify({ netDriftBins: 5 })).toBe(true);
    expect(classify({ netDriftBins: -5 })).toBe(true);
  });

  it("rejects a runner below the drift floor (sustained decliner, not a dip)", () => {
    expect(classify({ netDriftBins: -9 })).toBe(false);
    expect(classify({ netDriftBins: -20 })).toBe(false);
  });

  it("applies the configured drift floor", () => {
    expect(classify({ netDriftBins: -3, runnerMinDriftBins: -4 })).toBe(true);
    expect(classify({ netDriftBins: -5, runnerMinDriftBins: -4 })).toBe(false);
  });

  it("fails OPEN on unknown drift (cold start — cannot prove a decline)", () => {
    expect(classify({ netDriftBins: null })).toBe(true);
    // Omitted netDriftBins (undefined) also fails open — no bin history yet.
    expect(classify({ feeAprPct: 5_000 })).toBe(true);
  });

  it("fails open on non-finite drift", () => {
    expect(classify({ netDriftBins: NaN })).toBe(true);
  });

  it("default floor matches the normal-lane drift gate", () => {
    expect(DEFAULT_RUNNER_MIN_DRIFT_BINS).toBe(-8);
  });
});

describe("lowestAprHeldPosition (rotation target)", () => {
  it("picks the lowest-APR held position", () => {
    const aprs = new Map([
      [RUNNER, { feeAprPct: 5_000, tvlUsd: 200_000 }],
      [FLAT, { feeAprPct: 25, tvlUsd: 1_000_000 }],
    ]);
    expect(
      lowestAprHeldPosition(
        [
          { positionId: "runner-position", poolAddress: RUNNER },
          { positionId: "flat-position", poolAddress: FLAT },
        ],
        aprs,
      ),
    ).toEqual({
      positionId: "flat-position",
      poolAddress: FLAT,
      feeAprPct: 25,
      tvlUsd: 1_000_000,
    });
  });

  it("never rotates out of an unmeasured/zero-APR position (fail-closed)", () => {
    const aprs = new Map([[FLAT, { feeAprPct: 25, tvlUsd: 1_000_000 }]]);
    expect(
      lowestAprHeldPosition([{ positionId: "runner-position", poolAddress: RUNNER }], aprs),
    ).toBeNull();
  });
  it("selects the lowest supplied net score, not the lowest gross pool APR", () => {
    const aprs = new Map([
      ["pool-a", { feeAprPct: 100, tvlUsd: 100_000, measured: true }],
      ["pool-b", { feeAprPct: 50, tvlUsd: 100_000, measured: true }],
    ]);
    const selected = lowestAprHeldPosition(
      [
        { positionId: "position-a", poolAddress: "pool-a" },
        { positionId: "position-b", poolAddress: "pool-b" },
      ],
      aprs,
      undefined,
      {
        selectionScoreByPositionId: new Map([
          ["position-a", 1],
          ["position-b", 10],
        ]),
      },
    );
    expect(selected).toEqual({
      positionId: "position-a",
      poolAddress: "pool-a",
      feeAprPct: 1,
      tvlUsd: 100_000,
    });
  });

  it("never rotates out of the candidate runner itself (no exit-and-reenter)", () => {
    // A held position on the runner pool must not be exited while the same
    // pool re-enters in the same cycle.
    const aprs = new Map([
      [RUNNER, { feeAprPct: 5_000, tvlUsd: 200_000 }],
      [FLAT, { feeAprPct: 25, tvlUsd: 1_000_000 }],
    ]);
    expect(
      lowestAprHeldPosition(
        [
          { positionId: "runner-position", poolAddress: RUNNER },
          { positionId: "flat-position", poolAddress: FLAT },
        ],
        aprs,
        RUNNER,
      ),
    ).toEqual({
      positionId: "flat-position",
      poolAddress: FLAT,
      feeAprPct: 25,
      tvlUsd: 1_000_000,
    });
    // Runner is the ONLY held position -> nothing to rotate into it.
    expect(
      lowestAprHeldPosition([{ positionId: "runner-position", poolAddress: RUNNER }], aprs, RUNNER),
    ).toBeNull();
  });

  it("empty positions -> null", () => {
    expect(lowestAprHeldPosition([], new Map())).toBeNull();
  });

  it("maturity gate: skips a position younger than minAgeMs", () => {
    // 2026-08-21 field incident: a $20 position entered at 14:32 was
    // rotation-exited at 14:37 for −$0.01. Young entries are never targets.
    const aprs = new Map([[FLAT, { feeAprPct: 25, tvlUsd: 1_000_000 }]]);
    const now = 1_800_000_000_000;
    const young = { positionId: "young", poolAddress: FLAT, openedAt: now - 6 * 60_000 };
    expect(
      lowestAprHeldPosition([young], aprs, undefined, { minAgeMs: 14_400_000, nowMs: now }),
    ).toBeNull();
  });

  it("maturity gate: an old-enough position stays a target", () => {
    const aprs = new Map([[FLAT, { feeAprPct: 25, tvlUsd: 1_000_000 }]]);
    const now = 1_800_000_000_000;
    const old = { positionId: "old", poolAddress: FLAT, openedAt: now - 14_400_000 };
    expect(
      lowestAprHeldPosition([old], aprs, undefined, { minAgeMs: 14_400_000, nowMs: now }),
    ).toEqual({
      positionId: "old",
      poolAddress: FLAT,
      feeAprPct: 25,
      tvlUsd: 1_000_000,
    });
  });

  it("maturity gate: all-young portfolio -> no rotation (fail-closed)", () => {
    const aprs = new Map([
      [RUNNER, { feeAprPct: 5_000, tvlUsd: 200_000 }],
      [FLAT, { feeAprPct: 25, tvlUsd: 1_000_000 }],
    ]);
    const now = 1_800_000_000_000;
    const positions = [
      { positionId: "runner-position", poolAddress: RUNNER, openedAt: now - 60_000 },
      { positionId: "flat-position", poolAddress: FLAT, openedAt: now - 120_000 },
    ];
    expect(
      lowestAprHeldPosition(positions, aprs, RUNNER, { minAgeMs: 14_400_000, nowMs: now }),
    ).toBeNull();
  });

  it("legacy rows without openedAt bypass the maturity gate (treated as old)", () => {
    const aprs = new Map([[FLAT, { feeAprPct: 25, tvlUsd: 1_000_000 }]]);
    const now = 1_800_000_000_000;
    expect(
      lowestAprHeldPosition([{ positionId: "legacy", poolAddress: FLAT }], aprs, undefined, {
        minAgeMs: 14_400_000,
        nowMs: now,
      }),
    ).toEqual({
      positionId: "legacy",
      poolAddress: FLAT,
      feeAprPct: 25,
      tvlUsd: 1_000_000,
    });
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
  it("does not churn when both net APRs are zero", () => {
    expect(
      shouldRotate(
        0,
        { positionId: "flat-position", poolAddress: FLAT, feeAprPct: 0, tvlUsd: 100_000 },
        5,
      ),
    ).toBe(false);
  });

  it("requires a finite positive challenger and valid comparison inputs", () => {
    const held = { positionId: "flat-position", poolAddress: FLAT, feeAprPct: 25, tvlUsd: 100_000 };
    expect(shouldRotate(Infinity, held, 5)).toBe(false);
    expect(shouldRotate(500, { ...held, feeAprPct: -1 }, 5)).toBe(false);
    expect(shouldRotate(500, held, 0)).toBe(false);
    expect(shouldRotate(500, held, 0.5)).toBe(false);
    expect(shouldRotate(500, { ...held, feeAprPct: 0 }, 5)).toBe(true);
  });

  it("5000% runner vs 25% held with 5x mult -> rotate", () => {
    expect(
      shouldRotate(
        5_000,
        { positionId: "flat-position", poolAddress: FLAT, feeAprPct: 25, tvlUsd: 1_000_000 },
        5,
      ),
    ).toBe(true);
  });

  it("marginal 100% candidate vs 25% held -> no rotation", () => {
    expect(
      shouldRotate(
        100,
        { positionId: "flat-position", poolAddress: FLAT, feeAprPct: 25, tvlUsd: 1_000_000 },
        5,
      ),
    ).toBe(false);
  });

  it("no worst position -> no rotation", () => {
    expect(shouldRotate(5_000, null, 5)).toBe(false);
  });

  it("defaults to 5x when the multiplier is unset", () => {
    expect(
      shouldRotate(
        126,
        { positionId: "flat-position", poolAddress: FLAT, feeAprPct: 25, tvlUsd: 1_000_000 },
        undefined,
      ),
    ).toBe(true);
    expect(
      shouldRotate(
        124,
        { positionId: "flat-position", poolAddress: FLAT, feeAprPct: 25, tvlUsd: 1_000_000 },
        undefined,
      ),
    ).toBe(false);
  });
});
