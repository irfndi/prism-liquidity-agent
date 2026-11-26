/** Cycle facts are a pure projection of already-fetched data: unknown stays
 *  unknown (never 0-as-known), drift is last-minus-first over the ring, and the
 *  HODL benchmark respects the v16 entry-leg contract. */
import { describe, expect, it } from "vitest";
import {
  assemblePoolFacts,
  assemblePositionFacts,
  hodlBenchmarkUsd,
  resolvePoolDriftMetrics,
} from "../engine/cycle/facts.js";
import type { PoolMetrics } from "../engine/types.js";
import { makeBinArray, makePool, makePosition } from "./helpers.js";

describe("resolvePoolDriftMetrics", () => {
  it("reports zero drift for a cold-start or single-observation ring", () => {
    const empty = resolvePoolDriftMetrics(new Map(), "pool", 10);
    expect(empty.netDriftBins).toBe(0);
    expect(empty.volatilityStddev).toBe(0);
    expect(empty.recentBins).toHaveLength(0);

    const single = resolvePoolDriftMetrics(new Map([["pool", [5000]]]), "pool", 10);
    expect(single.netDriftBins).toBe(0);
    expect(single.recentBins).toEqual([5000]);
  });

  it("measures net drift as last minus first over the whole ring", () => {
    const drift = resolvePoolDriftMetrics(
      new Map([["pool", [5010, 5005, 4990, 4960]]]),
      "pool",
      10,
    );
    expect(drift.netDriftBins).toBe(-50);
  });

  it("uses only the newest lookback bins for volatility", () => {
    const ring = [4800, 4810, 5000, 5001, 5002, 5003];
    const drift = resolvePoolDriftMetrics(new Map([["pool", ring]]), "pool", 4);
    expect(drift.recentBins).toEqual(ring);
    expect(drift.volatilityBins).toEqual([5000, 5001, 5002, 5003]);
    expect(drift.volatilityStddev).toBeGreaterThan(0);
  });
});

describe("hodlBenchmarkUsd", () => {
  it("returns null for pre-v16 rows and for an unusable entry price", () => {
    expect(hodlBenchmarkUsd(makePosition({ entryAmountXUsd: null }), 150)).toBeNull();
    expect(
      hodlBenchmarkUsd(
        makePosition({ entryAmountXUsd: 10, entryAmountYUsd: 10, entryPriceUsd: 0 }),
        150,
      ),
    ).toBeNull();
  });

  it("revalues both entry legs at the current price", () => {
    // 100 X at 100 → 100 X at 150 (=150) + 50 Y = 200.
    expect(
      hodlBenchmarkUsd(
        makePosition({ entryAmountXUsd: 100, entryAmountYUsd: 50, entryPriceUsd: 100 }),
        150,
      ),
    ).toBe(200);
  });

  it("keeps a zero leg as a real zero (single-sided entry)", () => {
    expect(
      hodlBenchmarkUsd(
        makePosition({ entryAmountXUsd: 0, entryAmountYUsd: 50, entryPriceUsd: 100 }),
        150,
      ),
    ).toBe(50);
  });
});

describe("assemblePoolFacts", () => {
  it("projects every metric and preserves the unknown flags", () => {
    const pool = makePool({ address: "factsPool", tvlUsd: 250_000, fees24hUsd: 900 });
    const metrics: PoolMetrics = {
      pool,
      binArray: makeBinArray(),
      tvlVelocity: -0.12,
      feeIlRatio: 0,
      volumeAuthenticity: 0,
      binUtilization: 0,
      volumeAuthenticityKnown: false,
      feeIlRatioKnown: false,
      binUtilizationKnown: false,
      farmAprPct: null,
    };
    const facts = assemblePoolFacts({ pool, metrics });
    expect(facts.poolAddress).toBe("factsPool");
    expect(facts.tvlUsd).toBe(250_000);
    expect(facts.tvlVelocity).toBe(-0.12);
    expect(facts.fees24hUsd).toBe(900);
    expect(facts.feeIlRatioKnown).toBe(false);
    expect(facts.volumeAuthenticityKnown).toBe(false);
    expect(facts.binUtilizationKnown).toBe(false);
    // Absent drift is unknown, not 0-as-known.
    expect(facts.netDriftBins).toBeNull();
  });

  it("carries a real zero drift through as 0", () => {
    const pool = makePool();
    const metrics: PoolMetrics = {
      pool,
      binArray: makeBinArray(),
      tvlVelocity: 0,
      feeIlRatio: 2,
      volumeAuthenticity: 0.9,
      binUtilization: 0.8,
      volumeAuthenticityKnown: true,
      feeIlRatioKnown: true,
      binUtilizationKnown: true,
      farmAprPct: 12,
      netDriftBins: 0,
    };
    expect(assemblePoolFacts({ pool, metrics }).netDriftBins).toBe(0);
  });
});

describe("assemblePositionFacts", () => {
  it("maps identity, PnL inputs, and the OOR timestamp", () => {
    const pos = makePosition({
      positionId: "pos-1",
      poolAddress: "factsPool",
      depositedUsd: 100,
      currentValueUsd: 90,
      highestValueUsd: 120,
      cumulativeFeesClaimedUsd: 3,
      cumulativeRewardsClaimedUsd: 1,
      timestamp: 1_779_000_000_000,
    });
    pos.outOfRangeSince = 1_780_000_000_000;
    const facts = assemblePositionFacts(pos, 95);
    expect(facts).toMatchObject({
      positionId: "pos-1",
      poolAddress: "factsPool",
      openedAt: 1_779_000_000_000,
      depositedUsd: 100,
      currentValueUsd: 90,
      highestValueUsd: 120,
      cumulativeFeesClaimedUsd: 3,
      cumulativeRewardsClaimedUsd: 1,
      outOfRangeSince: 1_780_000_000_000,
      hodlValueUsd: 95,
    });
  });

  it("falls back to the cost basis for a missing peak value", () => {
    const pos = makePosition({ depositedUsd: 100, highestValueUsd: null });
    expect(assemblePositionFacts(pos, null).highestValueUsd).toBe(100);
    expect(assemblePositionFacts(pos, null).hodlValueUsd).toBeNull();
  });
});
