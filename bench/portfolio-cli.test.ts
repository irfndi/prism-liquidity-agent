import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { DbLive } from "../engine/db-service.js";
import { DbService } from "../engine/services.js";

async function runAsync<T, E>(
  effect: Effect.Effect<T, E, DbService>,
  layer: Layer.Layer<DbService, never, never>,
): Promise<T> {
  return Effect.runPromise(Effect.provide(effect, layer));
}
import {
  computeClosedTradeStats,
  computeSummary,
  computePnl,
  enterCohortLabel,
  exitReasonFromMetadata,
  exitReasonTag,
  formatAge,
  formatPosition,
  groupClosedTradeExpectancy,
  toJsonOutput,
  toHistoryJsonOutput,
} from "../cli/portfolio.js";
import type { PositionRecord } from "../engine/db-service.js";
// Per-field defaulting split out of makePosition to stay under the complexity cap;
// each helper returns a partial of the same defaulted values makePosition always produced.
function marketIdentityDefaults(
  tokenXSymbol: string | undefined,
  tokenYSymbol: string | undefined,
  activeBinId: number | undefined,
  lowerBinId: number | undefined,
  upperBinId: number | undefined,
) {
  return {
    tokenXSymbol: tokenXSymbol ?? "SOL",
    tokenYSymbol: tokenYSymbol ?? "USDC",
    activeBinId: activeBinId ?? 5000,
    lowerBinId: lowerBinId ?? 4980,
    upperBinId: upperBinId ?? 5020,
  };
}

function marketLedgerDefaults(
  depositedUsd: number | undefined,
  currentValueUsd: number | undefined,
  timestamp: number | undefined,
  outOfRangeSince: number | null | undefined,
  oorCycleCount: number | undefined,
  lastFeeClaimAt: number | undefined,
) {
  return {
    depositedUsd: depositedUsd ?? 1000,
    currentValueUsd: currentValueUsd ?? 1000,
    timestamp: timestamp ?? Date.now(),
    outOfRangeSince: outOfRangeSince ?? null,
    oorCycleCount: oorCycleCount ?? 0,
    lastFeeClaimAt: lastFeeClaimAt ?? Date.now(),
  };
}

function positionMarketDefaults(overrides: Partial<PositionRecord>) {
  return {
    ...marketLedgerDefaults(
      overrides.depositedUsd,
      overrides.currentValueUsd,
      overrides.timestamp,
      overrides.outOfRangeSince,
      overrides.oorCycleCount,
      overrides.lastFeeClaimAt,
    ),
    ...marketIdentityDefaults(
      overrides.tokenXSymbol,
      overrides.tokenYSymbol,
      overrides.activeBinId,
      overrides.lowerBinId,
      overrides.upperBinId,
    ),
  };
}

function lifecycleExitDefaults(
  trailingStopThreshold: number | null | undefined,
  highestValueUsd: number | null | undefined,
  lastRebalanceAt: number | undefined,
  paperExitedAt: number | null | undefined,
  closedAt: number | null | undefined,
  realizedPnlUsd: number | null | undefined,
) {
  return {
    trailingStopThreshold: trailingStopThreshold ?? null,
    highestValueUsd: highestValueUsd ?? null,
    lastRebalanceAt: lastRebalanceAt ?? 0,
    paperExitedAt: paperExitedAt ?? null,
    closedAt: closedAt ?? null,
    realizedPnlUsd: realizedPnlUsd ?? null,
  };
}

function lifecycleEntryDefaults(
  entrySignalTimestamp: number | null | undefined,
  entrySignalSnapshotId: number | null | undefined,
  entryPriceUsd: number | null | undefined,
  entryAmountXUsd: number | null | undefined,
  entryAmountYUsd: number | null | undefined,
  cumulativeFeesClaimedUsd: number | undefined,
  cumulativeRewardsClaimedUsd: number | undefined,
) {
  return {
    entrySignalTimestamp: entrySignalTimestamp ?? null,
    entrySignalSnapshotId: entrySignalSnapshotId ?? null,
    entryPriceUsd: entryPriceUsd ?? null,
    entryAmountXUsd: entryAmountXUsd ?? null,
    entryAmountYUsd: entryAmountYUsd ?? null,
    cumulativeFeesClaimedUsd: cumulativeFeesClaimedUsd ?? 0,
    cumulativeRewardsClaimedUsd: cumulativeRewardsClaimedUsd ?? 0,
  };
}

function positionLifecycleDefaults(overrides: Partial<PositionRecord>) {
  return {
    ...lifecycleExitDefaults(
      overrides.trailingStopThreshold,
      overrides.highestValueUsd,
      overrides.lastRebalanceAt,
      overrides.paperExitedAt,
      overrides.closedAt,
      overrides.realizedPnlUsd,
    ),
    ...lifecycleEntryDefaults(
      overrides.entrySignalTimestamp,
      overrides.entrySignalSnapshotId,
      overrides.entryPriceUsd,
      overrides.entryAmountXUsd,
      overrides.entryAmountYUsd,
      overrides.cumulativeFeesClaimedUsd,
      overrides.cumulativeRewardsClaimedUsd,
    ),
  };
}

function makePosition(overrides: Partial<PositionRecord> = {}): PositionRecord {
  const poolAddress = overrides.poolAddress ?? "Pool111111111111111111111111111111111111111";
  const positionPubKey = overrides.positionPubKey ?? null;
  return {
    positionId: overrides.positionId ?? positionPubKey ?? `paper-${poolAddress}`,
    poolAddress,
    positionPubKey,
    ...positionMarketDefaults(overrides),
    ...positionLifecycleDefaults(overrides),
  };
}

describe("computePnl", () => {
  it("computes profit correctly", () => {
    const { pnlUsd, pnlPct } = computePnl(1000, 1200);
    expect(pnlUsd).toBe(200);
    expect(pnlPct).toBe(20);
  });

  it("computes loss correctly", () => {
    const { pnlUsd, pnlPct } = computePnl(1000, 800);
    expect(pnlUsd).toBe(-200);
    expect(pnlPct).toBe(-20);
  });

  it("handles break-even", () => {
    const { pnlUsd, pnlPct } = computePnl(1000, 1000);
    expect(pnlUsd).toBe(0);
    expect(pnlPct).toBe(0);
  });

  it("handles zero deposited", () => {
    const { pnlUsd, pnlPct } = computePnl(0, 100);
    expect(pnlUsd).toBe(100);
    expect(pnlPct).toBe(0);
  });
});

describe("computeSummary", () => {
  it("returns zeros for empty positions", () => {
    const summary = computeSummary([]);
    expect(summary.totalDepositedUsd).toBe(0);
    expect(summary.totalCurrentValueUsd).toBe(0);
    expect(summary.totalUnrealizedPnlUsd).toBe(0);
    expect(summary.totalUnrealizedPnlPct).toBe(0);
    expect(summary.positionCount).toBe(0);
  });

  it("computes correct P&L for a single profitable position", () => {
    const positions = [makePosition({ depositedUsd: 1000, currentValueUsd: 1200 })];
    const summary = computeSummary(positions);
    expect(summary.totalDepositedUsd).toBe(1000);
    expect(summary.totalCurrentValueUsd).toBe(1200);
    expect(summary.totalUnrealizedPnlUsd).toBe(200);
    expect(summary.totalUnrealizedPnlPct).toBeCloseTo(20, 5);
    expect(summary.positionCount).toBe(1);
  });

  it("computes correct P&L for a single losing position", () => {
    const positions = [makePosition({ depositedUsd: 1000, currentValueUsd: 800 })];
    const summary = computeSummary(positions);
    expect(summary.totalUnrealizedPnlUsd).toBe(-200);
    expect(summary.totalUnrealizedPnlPct).toBeCloseTo(-20, 5);
  });

  it("aggregates multiple positions correctly", () => {
    const positions = [
      makePosition({ poolAddress: "pool1", depositedUsd: 1000, currentValueUsd: 1200 }),
      makePosition({ poolAddress: "pool2", depositedUsd: 2000, currentValueUsd: 1900 }),
      makePosition({ poolAddress: "pool3", depositedUsd: 500, currentValueUsd: 600 }),
    ];
    const summary = computeSummary(positions);
    expect(summary.totalDepositedUsd).toBe(3500);
    expect(summary.totalCurrentValueUsd).toBe(3700);
    expect(summary.totalUnrealizedPnlUsd).toBe(200);
    expect(summary.totalUnrealizedPnlPct).toBeCloseTo(5.714, 2);
    expect(summary.positionCount).toBe(3);
  });

  it("handles position with zero deposited", () => {
    const positions = [makePosition({ depositedUsd: 0, currentValueUsd: 100 })];
    const summary = computeSummary(positions);
    expect(summary.totalUnrealizedPnlPct).toBe(0);
  });

  it("(v) includes claimed rewards in totals (additive to P&L, separate from fees)", () => {
    const positions = [
      makePosition({
        poolAddress: "pool1",
        depositedUsd: 1000,
        currentValueUsd: 1200,
        cumulativeFeesClaimedUsd: 25,
        cumulativeRewardsClaimedUsd: 40,
      }),
      makePosition({ poolAddress: "pool2", depositedUsd: 2000, currentValueUsd: 1900 }),
    ];
    const summary = computeSummary(positions);
    expect(summary.totalFeesClaimedUsd).toBe(25);
    expect(summary.totalRewardsClaimedUsd).toBe(40);
    // 3100 current + 25 fees + 40 rewards − 3000 deposited
    expect(summary.totalUnrealizedPnlUsd).toBe(165);
  });
});

describe("formatAge", () => {
  it("returns minutes for recent timestamps", () => {
    const ts = Date.now() - 5 * 60 * 1000; // 5 minutes ago
    expect(formatAge(ts)).toBe("5m");
  });

  it("returns hours and minutes", () => {
    const ts = Date.now() - 2 * 60 * 60 * 1000 - 30 * 60 * 1000; // 2h 30m ago
    expect(formatAge(ts)).toBe("2h 30m");
  });

  it("returns days and hours", () => {
    const ts = Date.now() - 3 * 24 * 60 * 60 * 1000 - 5 * 60 * 60 * 1000; // 3d 5h ago
    expect(formatAge(ts)).toBe("3d 5h");
  });

  it("returns 'just now' for future timestamps", () => {
    const ts = Date.now() + 60000; // 1 minute in the future
    expect(formatAge(ts)).toBe("just now");
  });

  it("returns '0m' for current timestamp", () => {
    const ts = Date.now();
    expect(formatAge(ts)).toBe("0m");
  });
});

describe("toJsonOutput", () => {
  it("produces correct JSON structure for active positions", () => {
    const positions = [
      makePosition({
        poolAddress: "pool1",
        positionPubKey: "PubKey123",
        tokenXSymbol: "SOL",
        tokenYSymbol: "USDC",
        depositedUsd: 1000,
        currentValueUsd: 1200,
        lowerBinId: 4980,
        upperBinId: 5020,
        activeBinId: 5000,
        timestamp: 1700000000000,
      }),
    ];

    const json = toJsonOutput(positions);
    expect(json.positions).toHaveLength(1);
    expect(json.positions[0]).toBeDefined();
    if (json.positions[0]) {
      expect(json.positions[0].poolAddress).toBe("pool1");
      expect(json.positions[0].poolName).toBe("SOL/USDC");
      expect(json.positions[0].positionPubKey).toBe("PubKey123");
      expect(json.positions[0].depositedUsd).toBe(1000);
      expect(json.positions[0].currentValueUsd).toBe(1200);
      expect(json.positions[0].unrealizedPnlUsd).toBe(200);
      expect(json.positions[0].unrealizedPnlPct).toBe(20);
      expect(json.positions[0].activeBinId).toBe(5000);
      expect(json.positions[0].lowerBinId).toBe(4980);
      expect(json.positions[0].upperBinId).toBe(5020);
      expect(json.positions[0].timestamp).toBe(1700000000000);
      expect(json.positions[0].outOfRangeSince).toBeNull();
    }
    expect(json.summary.totalDepositedUsd).toBe(1000);
    expect(json.summary.totalUnrealizedPnlUsd).toBe(200);
  });

  it("includes positionPubKey null when not set", () => {
    const positions = [makePosition({ positionPubKey: null })];
    const json = toJsonOutput(positions);
    expect(json.positions[0]).toBeDefined();
    if (json.positions[0]) {
      expect(json.positions[0].positionPubKey).toBeNull();
    }
  });

  it("handles empty positions", () => {
    const json = toJsonOutput([]);
    expect(json.positions).toHaveLength(0);
    expect(json.summary.positionCount).toBe(0);
    expect(json.summary.totalDepositedUsd).toBe(0);
  });
});

describe("toHistoryJsonOutput", () => {
  it("produces correct JSON structure for exited positions", () => {
    const positions = [
      makePosition({
        poolAddress: "pool1",
        tokenXSymbol: "SOL",
        tokenYSymbol: "USDC",
        depositedUsd: 1000,
        currentValueUsd: 900,
        paperExitedAt: 1700000000000,
      }),
    ];

    const json = toHistoryJsonOutput(positions);
    expect(json.positions).toHaveLength(1);
    expect(json.positions[0]).toBeDefined();
    if (json.positions[0]) {
      expect(json.positions[0].poolAddress).toBe("pool1");
      expect(json.positions[0].poolName).toBe("SOL/USDC");
      expect(json.positions[0].depositedUsd).toBe(1000);
      expect(json.positions[0].exitValueUsd).toBe(900);
      expect(json.positions[0].realizedPnlUsd).toBe(-100);
      expect(json.positions[0].realizedPnlPct).toBe(-10);
      expect(json.positions[0].paperExitedAt).toBe(1700000000000);
    }
    expect(json.summary.totalDepositedUsd).toBe(1000);
    expect(json.summary.totalUnrealizedPnlUsd).toBe(-100);
    expect(json.summary.positionCount).toBe(1);
  });

  it("handles empty positions", () => {
    const json = toHistoryJsonOutput([]);
    expect(json.positions).toHaveLength(0);
    expect(json.summary.positionCount).toBe(0);
    expect(json.summary.totalDepositedUsd).toBe(0);
  });

  it("prefers the stored realizedPnlUsd over the legacy fallback", () => {
    const positions = [
      makePosition({
        poolAddress: "pool1",
        depositedUsd: 1000,
        currentValueUsd: 1100,
        cumulativeFeesClaimedUsd: 25,
        closedAt: 1700000000000,
        realizedPnlUsd: 125,
      }),
    ];
    const json = toHistoryJsonOutput(positions);
    expect(json.positions[0]).toBeDefined();
    if (json.positions[0]) {
      expect(json.positions[0].realizedPnlUsd).toBe(125);
      expect(json.positions[0].realizedPnlPct).toBeCloseTo(12.5, 5);
      expect(json.positions[0].feesClaimedUsd).toBe(25);
      expect(json.positions[0].closedAt).toBe(1700000000000);
    }
  });
});

describe("Wave 4 — PnL accounting fields", () => {
  it("toJsonOutput surfaces entry price, fees, HODL benchmark, IL and time-in-range", () => {
    const positions = [
      makePosition({
        poolAddress: "pool1",
        depositedUsd: 1000,
        currentValueUsd: 1100,
        cumulativeFeesClaimedUsd: 25,
        entryPriceUsd: 100,
        entryAmountXUsd: 500,
        entryAmountYUsd: 500,
        timestamp: Date.now() - 24 * 60 * 60 * 1000,
      }),
    ];
    const prices = new Map([["pool1", 110]]);
    const json = toJsonOutput(positions, prices);

    expect(json.positions[0]).toBeDefined();
    const p = json.positions[0]!;
    expect(p.entryPriceUsd).toBe(100);
    expect(p.feesClaimedUsd).toBe(25);
    // unrealized = 1100 + 25 − 1000 = 125
    expect(p.unrealizedPnlUsd).toBeCloseTo(125, 6);
    expect(p.unrealizedPnlPct).toBeCloseTo(12.5, 4);
    // HODL = 500 × (110/100) + 500 = 1050 → IL vs HODL = 1100 − 1050 = 50
    expect(p.hodlValueUsd).toBeCloseTo(1050, 6);
    expect(p.ilVsHodlUsd).toBeCloseTo(50, 6);
    expect(p.timeInRangePct).toBe(100);
    expect(p.feeAprPct).toBeCloseTo(912.5, 1);
    expect(json.summary.totalFeesClaimedUsd).toBe(25);
    expect(json.summary.totalUnrealizedPnlUsd).toBeCloseTo(125, 6);
  });

  it("toJsonOutput degrades to null benchmarks for pre-migration rows", () => {
    const positions = [
      makePosition({ poolAddress: "pool1", depositedUsd: 1000, currentValueUsd: 1200 }),
    ];
    const json = toJsonOutput(positions, new Map([["pool1", 110]]));
    const p = json.positions[0]!;
    expect(p.entryPriceUsd).toBeNull();
    expect(p.hodlValueUsd).toBeNull();
    expect(p.ilVsHodlUsd).toBeNull();
    // Legacy PnL model still works.
    expect(p.unrealizedPnlUsd).toBeCloseTo(200, 6);
  });

  it("formatPosition renders fees, IL-vs-HODL and time-in-range lines", () => {
    const pos = makePosition({
      poolAddress: "pool1",
      depositedUsd: 1000,
      currentValueUsd: 1100,
      cumulativeFeesClaimedUsd: 25,
      entryPriceUsd: 100,
      entryAmountXUsd: 500,
      entryAmountYUsd: 500,
      timestamp: Date.now() - 3_600_000,
    });
    const text = formatPosition(pos, 110);
    expect(text).toContain("Fees:");
    expect(text).toContain("$25.00");
    expect(text).toContain("IL vs HODL:");
    expect(text).toContain("In range:");
    expect(text).toContain("100.0%");
  });

  it("formatPosition shows n/a for IL-vs-HODL when entry data is missing", () => {
    const pos = makePosition({ poolAddress: "pool1" });
    const text = formatPosition(pos, 110);
    expect(text).toContain("IL vs HODL: n/a");
  });
});

describe("portfolio — DB integration", () => {
  function buildLayer() {
    return DbLive(":memory:");
  }

  it("retrieves active positions from DB", async () => {
    const layer = buildLayer();
    const effect = Effect.gen(function* () {
      const db = yield* DbService;
      yield* db.savePosition(
        makePosition({ poolAddress: "pool1", depositedUsd: 1000, currentValueUsd: 1100 }),
      );
      yield* db.savePosition(
        makePosition({ poolAddress: "pool2", depositedUsd: 2000, currentValueUsd: 1900 }),
      );
      const positions = yield* db.getAllPositions();
      return positions;
    });
    const positions = await runAsync(effect, layer);
    expect(positions).toHaveLength(2);
    const addresses = positions.map((p) => p.poolAddress);
    expect(addresses).toContain("pool1");
    expect(addresses).toContain("pool2");
  });

  it("excludes paper-exited positions from active list", async () => {
    const layer = buildLayer();
    const effect = Effect.gen(function* () {
      const db = yield* DbService;
      yield* db.savePosition(makePosition({ poolAddress: "active1" }));
      yield* db.savePosition(makePosition({ poolAddress: "active2" }));
      yield* db.savePosition(makePosition({ poolAddress: "exited1", paperExitedAt: Date.now() }));
      const active = yield* db.getAllPositions();
      const exited = yield* db.getPaperExitedPositions();
      return { active, exited };
    });
    const result = await runAsync(effect, layer);
    expect(result.active).toHaveLength(2);
    expect(result.exited).toHaveLength(1);
    expect(result.exited[0]).toBeDefined();
    if (result.exited[0]) {
      expect(result.exited[0].poolAddress).toBe("exited1");
    }
  });

  it("computes P&L from stored positions", async () => {
    const layer = buildLayer();
    const effect = Effect.gen(function* () {
      const db = yield* DbService;
      yield* db.savePosition(
        makePosition({ poolAddress: "pool1", depositedUsd: 1000, currentValueUsd: 1200 }),
      );
      yield* db.savePosition(
        makePosition({ poolAddress: "pool2", depositedUsd: 2000, currentValueUsd: 1800 }),
      );
      const positions = yield* db.getAllPositions();
      const summary = computeSummary(positions);
      return summary;
    });
    const summary = await runAsync(effect, layer);
    expect(summary.totalDepositedUsd).toBe(3000);
    expect(summary.totalCurrentValueUsd).toBe(3000);
    expect(summary.totalUnrealizedPnlUsd).toBe(0);
    expect(summary.positionCount).toBe(2);
  });
});

describe("reward reporting (Wave 8)", () => {
  it("(v) formatPosition shows a Rewards line only when rewards were claimed", () => {
    const withRewards = formatPosition(makePosition({ cumulativeRewardsClaimedUsd: 42.5 }), null);
    expect(withRewards).toContain("Rewards:");
    expect(withRewards).toContain("$42.50");

    const without = formatPosition(makePosition(), null);
    expect(without).not.toContain("Rewards:");
  });

  it("(v) toJsonOutput exposes rewardsClaimedUsd per position and in the summary", () => {
    const json = toJsonOutput([
      makePosition({ poolAddress: "pool1", cumulativeRewardsClaimedUsd: 40 }),
      makePosition({ poolAddress: "pool2" }),
    ]);
    expect(json.positions[0]?.rewardsClaimedUsd).toBe(40);
    expect(json.positions[1]?.rewardsClaimedUsd).toBe(0);
    expect(json.summary.totalRewardsClaimedUsd).toBe(40);
  });

  it("(v) toHistoryJsonOutput surfaces rewards for exited positions", () => {
    const json = toHistoryJsonOutput([
      makePosition({
        poolAddress: "pool1",
        cumulativeFeesClaimedUsd: 25,
        cumulativeRewardsClaimedUsd: 40,
        closedAt: 1700000000000,
        realizedPnlUsd: 165,
      }),
    ]);
    expect(json.positions[0]?.rewardsClaimedUsd).toBe(40);
    expect(json.positions[0]?.feesClaimedUsd).toBe(25);
  });

  it("(v) legacy fallback realized PnL includes rewards", () => {
    const json = toHistoryJsonOutput([
      makePosition({
        poolAddress: "pool1",
        depositedUsd: 1000,
        currentValueUsd: 1100,
        cumulativeFeesClaimedUsd: 25,
        cumulativeRewardsClaimedUsd: 40,
        paperExitedAt: 1700000000000,
      }),
    ]);
    // 1100 + 25 + 40 − 1000 (no stored realizedPnlUsd → fallback)
    expect(json.positions[0]?.realizedPnlUsd).toBe(165);
  });
});

describe("closed-trade evidence", () => {
  const closed = (realizedPnlUsd: number | null, at: number) =>
    makePosition({
      poolAddress: "pool1",
      depositedUsd: 100,
      currentValueUsd: 100,
      realizedPnlUsd,
      closedAt: at,
    });

  it("computes expectancy, profit factor and drawdown (win rate alone misleads)", () => {
    // +10, +10, −15: 66.7% win rate but net +5, expectancy +1.67.
    const stats = computeClosedTradeStats([closed(10, 3), closed(10, 1), closed(-15, 2)]);
    expect(stats.count).toBe(3);
    expect(stats.wins).toBe(2);
    expect(stats.losses).toBe(1);
    expect(stats.winRatePct).toBeCloseTo(66.6667, 3);
    expect(stats.netPnlUsd).toBe(5);
    expect(stats.expectancyUsd).toBeCloseTo(5 / 3, 10);
    expect(stats.avgWinUsd).toBe(10);
    expect(stats.avgLossUsd).toBe(-15);
    expect(stats.profitFactor).toBeCloseTo(20 / 15, 10);
    // Curve 10 → −5 → 5: peak 10, trough −5 → drawdown 15.
    expect(stats.maxDrawdownUsd).toBe(15);
  });

  it("skips NULL realized rows (unpriced exits are unknown, never breakeven)", () => {
    const stats = computeClosedTradeStats([closed(null, 1), closed(10, 2)]);
    expect(stats.count).toBe(1);
    expect(stats.netPnlUsd).toBe(10);
    expect(stats.profitFactor).toBeNull();
  });

  it("returns nulls (not zeros) on an empty ledger", () => {
    const stats = computeClosedTradeStats([]);
    expect(stats.count).toBe(0);
    expect(stats.winRatePct).toBeNull();
    expect(stats.expectancyUsd).toBeNull();
    expect(stats.profitFactor).toBeNull();
    expect(stats.maxDrawdownUsd).toBe(0);
  });

  it("tags exit reasons and entry cohorts from event metadata", () => {
    expect(exitReasonTag("[trailing-stop] peak breached")).toBe("trailing-stop");
    expect(exitReasonTag("no bracket here")).toBe("unknown");
    expect(exitReasonTag(null)).toBe("unknown");
    expect(enterCohortLabel(JSON.stringify({ ladder: "tight" }))).toBe("tight");
    expect(enterCohortLabel(JSON.stringify({ ladder: "wide" }))).toBe("wide");
    expect(enterCohortLabel(JSON.stringify({ strategySpec: "spot" }))).toBe("single");
    expect(enterCohortLabel(null)).toBe("unknown");
    expect(enterCohortLabel("not-json")).toBe("unknown");
    expect(exitReasonFromMetadata(JSON.stringify({ exitReason: "[oor] out" }))).toBe("oor");
    expect(exitReasonFromMetadata(JSON.stringify({}))).toBe("unknown");
    expect(exitReasonFromMetadata(null)).toBe("unknown");
  });

  it("groups expectancy by cohort for the split-vs-single comparison", () => {
    const positions = [
      { ...closed(10, 1), positionId: "tight-1" },
      { ...closed(-4, 2), positionId: "tight-2" },
      { ...closed(2, 3), positionId: "single-1" },
    ];
    const groups = groupClosedTradeExpectancy(
      positions,
      new Map([
        ["tight-1", "tight"],
        ["tight-2", "tight"],
        ["single-1", "single"],
      ]),
    );
    expect(groups.map((g) => g.cohort)).toEqual(["single", "tight"]);
    expect(groups.find((g) => g.cohort === "tight")?.expectancyUsd).toBeCloseTo(3, 10);
    expect(groups.find((g) => g.cohort === "single")?.expectancyUsd).toBe(2);
  });

  it("toHistoryJsonOutput carries stats and cohorts", () => {
    const positions = [{ ...closed(10, 1), positionId: "tight-1" }];
    const json = toHistoryJsonOutput(positions, {
      cohortByPositionId: new Map([["tight-1", "tight"]]),
    });
    expect(json.stats.count).toBe(1);
    expect(json.stats.expectancyUsd).toBe(10);
    expect(json.cohorts).toHaveLength(1);
    expect(json.cohorts?.[0]?.cohort).toBe("tight");
    expect(json.positions[0]?.cohort).toBe("tight");
  });
});
