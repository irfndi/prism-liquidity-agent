import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { DbLive } from "../engine/db-service.js";
import { DbService } from "../engine/services.js";

async function runAsync<T>(
  effect: Effect.Effect<T, unknown, DbService>,
  layer: Layer.Layer<DbService, never, never>,
): Promise<T> {
  return Effect.runPromise(Effect.provide(effect, layer));
}
import {
  computeSummary,
  computePnl,
  formatAge,
  formatPosition,
  toJsonOutput,
  toHistoryJsonOutput,
} from "../cli/portfolio.js";
import type { PositionRecord } from "../engine/db-service.js";

function makePosition(overrides: Partial<PositionRecord> = {}): PositionRecord {
  return {
    poolAddress: overrides.poolAddress ?? "Pool111111111111111111111111111111111111111",
    positionPubKey: overrides.positionPubKey ?? null,
    depositedUsd: overrides.depositedUsd ?? 1000,
    currentValueUsd: overrides.currentValueUsd ?? 1000,
    tokenXSymbol: overrides.tokenXSymbol ?? "SOL",
    tokenYSymbol: overrides.tokenYSymbol ?? "USDC",
    activeBinId: overrides.activeBinId ?? 5000,
    lowerBinId: overrides.lowerBinId ?? 4980,
    upperBinId: overrides.upperBinId ?? 5020,
    timestamp: overrides.timestamp ?? Date.now(),
    outOfRangeSince: overrides.outOfRangeSince ?? null,
    oorCycleCount: overrides.oorCycleCount ?? 0,
    lastFeeClaimAt: overrides.lastFeeClaimAt ?? Date.now(),
    trailingStopThreshold: overrides.trailingStopThreshold ?? null,
    highestValueUsd: overrides.highestValueUsd ?? null,
    lastRebalanceAt: overrides.lastRebalanceAt ?? 0,
    paperExitedAt: overrides.paperExitedAt ?? null,
    entrySignalTimestamp: overrides.entrySignalTimestamp ?? null,
    entrySignalSnapshotId: overrides.entrySignalSnapshotId ?? null,
    entryPriceUsd: overrides.entryPriceUsd ?? null,
    entryAmountXUsd: overrides.entryAmountXUsd ?? null,
    entryAmountYUsd: overrides.entryAmountYUsd ?? null,
    cumulativeFeesClaimedUsd: overrides.cumulativeFeesClaimedUsd ?? 0,
    closedAt: overrides.closedAt ?? null,
    realizedPnlUsd: overrides.realizedPnlUsd ?? null,
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
