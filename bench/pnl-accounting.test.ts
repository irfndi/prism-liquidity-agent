import { describe, it, expect, afterAll } from "vitest";
import { Effect, Layer } from "effect";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { createDatabase } from "../engine/db.js";
import { DbLive, type PositionRecord } from "../engine/db-service.js";
import {
  DbService,
  type AdapterApi,
  type StrategyApi,
  type RevenueConfigApi,
  type EntryPrepApi,
} from "../engine/services.js";
import { executePaper, executeLive, computePaperFeeAccrualUsd } from "../engine/program.js";
import {
  applyCompoundToCostBasis,
  computeFeeAprPct,
  computeHodlValueUsd,
  computePositionAnalytics,
  computeRealizedPnlUsd,
  computeTimeInRangePct,
} from "../engine/pnl.js";
import { makePosition } from "./helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Pure analytics ──────────────────────────────────────────────────────────

describe("computeHodlValueUsd", () => {
  it("values the entry legs at the current price (price up)", () => {
    // $500 X-leg + $500 Y-leg entered at price 100; price now 110.
    // X leg: 5 units × 110 = $550; Y leg unchanged $500 → $1050.
    expect(computeHodlValueUsd(500, 500, 100, 110)).toBeCloseTo(1050, 8);
  });

  it("values the entry legs at the current price (price down)", () => {
    expect(computeHodlValueUsd(500, 500, 100, 90)).toBeCloseTo(950, 8);
  });

  it("handles a zero Y leg (single-sided X entry)", () => {
    // $1000 all in the X leg at price 100; price now 110 → $1100.
    expect(computeHodlValueUsd(1000, 0, 100, 110)).toBeCloseTo(1100, 8);
  });

  it("handles a zero X leg (single-sided Y entry) as flat numeraire", () => {
    // $1000 all in the Y leg: no price exposure, benchmark stays $1000.
    expect(computeHodlValueUsd(0, 1000, 100, 110)).toBeCloseTo(1000, 8);
  });

  it("is flat when the price has not moved", () => {
    expect(computeHodlValueUsd(500, 500, 100, 100)).toBeCloseTo(1000, 8);
  });

  it("returns null for a non-positive entry price", () => {
    expect(computeHodlValueUsd(500, 500, 0, 110)).toBeNull();
    expect(computeHodlValueUsd(500, 500, -5, 110)).toBeNull();
  });
});

describe("computeFeeAprPct", () => {
  it("annualizes fees against cost basis by position age", () => {
    // $10 fees on $1000 basis over exactly 1 day → 1% daily → 365% APR.
    expect(computeFeeAprPct(10, 1000, DAY_MS)).toBeCloseTo(365, 6);
  });

  it("halves the APR when the same fees took twice as long", () => {
    expect(computeFeeAprPct(10, 1000, 2 * DAY_MS)).toBeCloseTo(182.5, 6);
  });

  it("returns null when age or basis is zero", () => {
    expect(computeFeeAprPct(10, 1000, 0)).toBeNull();
    expect(computeFeeAprPct(10, 0, DAY_MS)).toBeNull();
  });

  it("returns 0 when no fees were claimed", () => {
    expect(computeFeeAprPct(0, 1000, DAY_MS)).toBe(0);
  });
});

describe("computeTimeInRangePct", () => {
  const now = 1_700_000_000_000;

  it("is 100% when the position never went out of range", () => {
    expect(computeTimeInRangePct(10 * DAY_MS, null, now)).toBe(100);
  });

  it("discounts the current out-of-range stint", () => {
    // Age 10 days, OOR for the last 5 days → 50%.
    const oorSince = now - 5 * DAY_MS;
    expect(computeTimeInRangePct(10 * DAY_MS, oorSince, now)).toBeCloseTo(50, 6);
  });

  it("never goes below 0", () => {
    const oorSince = now - 20 * DAY_MS;
    expect(computeTimeInRangePct(10 * DAY_MS, oorSince, now)).toBe(0);
  });

  it("returns null when the age is zero", () => {
    expect(computeTimeInRangePct(0, null, now)).toBeNull();
  });
});

describe("computePositionAnalytics", () => {
  const now = 1_700_000_000_000;

  it("computes unrealized PnL including claimed fees", () => {
    const a = computePositionAnalytics(
      {
        depositedUsd: 1000,
        currentValueUsd: 1100,
        cumulativeFeesClaimedUsd: 25,
        entryPriceUsd: 100,
        entryAmountXUsd: 500,
        entryAmountYUsd: 500,
        openedAtMs: now - DAY_MS,
        outOfRangeSinceMs: null,
      },
      110,
      now,
    );
    expect(a.costBasisUsd).toBe(1000);
    expect(a.unrealizedPnlUsd).toBeCloseTo(125, 8);
    expect(a.unrealizedPnlPct).toBeCloseTo(12.5, 6);
    expect(a.feesClaimedUsd).toBe(25);
    expect(a.hodlValueUsd).toBeCloseTo(1050, 8);
    expect(a.ilVsHodlUsd).toBeCloseTo(50, 8);
    expect(a.timeInRangePct).toBe(100);
    expect(a.feeAprPct).toBeCloseTo((25 / 1000) * 365 * 100, 4);
    expect(a.ageMs).toBe(DAY_MS);
  });

  it("treats a zero entry leg as a valid single-sided position (not pre-migration)", () => {
    // Single-sided X entry: full $1000 in the X leg, Y leg 0. The HODL
    // benchmark must still be produced (0 is a real leg, NULL is not).
    const a = computePositionAnalytics(
      {
        depositedUsd: 1000,
        currentValueUsd: 1080,
        cumulativeFeesClaimedUsd: 0,
        entryPriceUsd: 100,
        entryAmountXUsd: 1000,
        entryAmountYUsd: 0,
        openedAtMs: now - DAY_MS,
        outOfRangeSinceMs: null,
      },
      110,
      now,
    );
    expect(a.hodlValueUsd).toBeCloseTo(1100, 8);
    expect(a.ilVsHodlUsd).toBeCloseTo(-20, 8);
    expect(a.unrealizedPnlUsd).toBeCloseTo(80, 8);
  });

  it("degrades gracefully for pre-migration rows (NULL entry fields)", () => {
    const a = computePositionAnalytics(
      {
        depositedUsd: 1000,
        currentValueUsd: 1200,
        cumulativeFeesClaimedUsd: 0,
        entryPriceUsd: null,
        entryAmountXUsd: null,
        entryAmountYUsd: null,
        openedAtMs: now - DAY_MS,
        outOfRangeSinceMs: null,
      },
      110,
      now,
    );
    // PnL falls back to the legacy deposited-vs-current model.
    expect(a.unrealizedPnlUsd).toBeCloseTo(200, 8);
    expect(a.hodlValueUsd).toBeNull();
    expect(a.ilVsHodlUsd).toBeNull();
  });

  it("degrades gracefully when no current price is available", () => {
    const a = computePositionAnalytics(
      {
        depositedUsd: 1000,
        currentValueUsd: 1100,
        cumulativeFeesClaimedUsd: 0,
        entryPriceUsd: 100,
        entryAmountXUsd: 500,
        entryAmountYUsd: 500,
        openedAtMs: now - DAY_MS,
        outOfRangeSinceMs: null,
      },
      null,
      now,
    );
    expect(a.hodlValueUsd).toBeNull();
    expect(a.ilVsHodlUsd).toBeNull();
  });
});

describe("computeRealizedPnlUsd", () => {
  it("is final value plus cumulative fees minus cost basis", () => {
    expect(computeRealizedPnlUsd(1100, 25, 1000)).toBeCloseTo(125, 8);
  });

  it("is negative when the position loses more than fees earned", () => {
    expect(computeRealizedPnlUsd(800, 25, 1000)).toBeCloseTo(-175, 8);
  });
});

describe("applyCompoundToCostBasis", () => {
  it("keeps total PnL continuous across a compound", () => {
    const before = { depositedUsd: 1000, currentValueUsd: 1100, highestValueUsd: 1150 };
    const feesAlreadyClaimed = 25;
    const pnlBefore = before.currentValueUsd + feesAlreadyClaimed - before.depositedUsd;

    const after = applyCompoundToCostBasis({ ...before, compoundedFeesUsd: 25 });
    const pnlAfter = after.currentValueUsd + feesAlreadyClaimed - after.depositedUsd;

    expect(pnlAfter).toBeCloseTo(pnlBefore, 8);
    expect(after.depositedUsd).toBeCloseTo(1025, 8);
    expect(after.currentValueUsd).toBeCloseTo(1125, 8);
  });

  it("raises highestValueUsd when the compounded value exceeds it", () => {
    const after = applyCompoundToCostBasis({
      depositedUsd: 1000,
      currentValueUsd: 1140,
      highestValueUsd: 1150,
      compoundedFeesUsd: 25,
    });
    expect(after.highestValueUsd).toBeCloseTo(1165, 8);
  });

  it("keeps highestValueUsd when the compounded value stays below it", () => {
    const after = applyCompoundToCostBasis({
      depositedUsd: 1000,
      currentValueUsd: 1000,
      highestValueUsd: 1200,
      compoundedFeesUsd: 25,
    });
    expect(after.highestValueUsd).toBeCloseTo(1200, 8);
  });

  it("seeds highestValueUsd from the new value when none was tracked", () => {
    const after = applyCompoundToCostBasis({
      depositedUsd: 1000,
      currentValueUsd: 1100,
      highestValueUsd: null,
      compoundedFeesUsd: 25,
    });
    expect(after.highestValueUsd).toBeCloseTo(1125, 8);
  });
});

// ─── Migration ───────────────────────────────────────────────────────────────

describe("migration v16 — pnl_accounting", () => {
  const tmpDirs: string[] = [];

  afterAll(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds PnL columns and position_events to an old-schema DB, preserving rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-pnl-migration-"));
    tmpDirs.push(dir);
    const dbPath = join(dir, "old.db");

    // Build a pre-v16 database by hand: positions as of v15, _migrations 1..15 applied.
    const old = new Database(dbPath);
    old.exec(`
      CREATE TABLE positions (
        pool_address TEXT PRIMARY KEY,
        position_pubkey TEXT,
        deposited_usd REAL,
        current_value_usd REAL,
        token_x_symbol TEXT,
        token_y_symbol TEXT,
        active_bin_id INTEGER,
        lower_bin_id INTEGER,
        upper_bin_id INTEGER,
        timestamp INTEGER,
        out_of_range_since INTEGER,
        oor_cycle_count INTEGER DEFAULT 0,
        last_fee_claim_at INTEGER DEFAULT 0,
        last_rebalance_at INTEGER DEFAULT 0,
        trailing_stop_threshold REAL,
        highest_value_usd REAL,
        paper_exited_at INTEGER,
        entry_signal_timestamp INTEGER,
        entry_signal_snapshot_id INTEGER
      );
    `);
    old.exec(`
      CREATE TABLE _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);
    for (let v = 1; v <= 15; v++) {
      old.run("INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)", [
        v,
        `legacy_v${v}`,
        Date.now(),
      ]);
    }
    old.run(
      `INSERT INTO positions (
        pool_address, position_pubkey, deposited_usd, current_value_usd,
        token_x_symbol, token_y_symbol, active_bin_id, lower_bin_id, upper_bin_id,
        timestamp, out_of_range_since, oor_cycle_count, last_fee_claim_at,
        last_rebalance_at, trailing_stop_threshold, highest_value_usd,
        paper_exited_at, entry_signal_timestamp, entry_signal_snapshot_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "LegacyPool111",
        null,
        1000,
        1200,
        "SOL",
        "USDC",
        5000,
        4980,
        5020,
        1700000000000,
        null,
        0,
        0,
        0,
        null,
        1200,
        null,
        null,
        null,
      ],
    );
    old.close();

    // Opening via createDatabase must run migration v16.
    const db = createDatabase(dbPath);
    const columns = (db.query("PRAGMA table_info(positions)").all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    for (const col of [
      "entry_price_usd",
      "entry_amount_x_usd",
      "entry_amount_y_usd",
      "cumulative_fees_claimed_usd",
      "closed_at",
      "realized_pnl_usd",
    ]) {
      expect(columns).toContain(col);
    }

    const eventsTable = db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'position_events'")
      .get();
    expect(eventsTable).not.toBeNull();

    const row = db
      .query("SELECT * FROM positions WHERE pool_address = ?")
      .get("LegacyPool111") as Record<string, unknown> | null;
    expect(row).not.toBeNull();
    expect(Number(row!.deposited_usd)).toBe(1000);
    expect(Number(row!.current_value_usd)).toBe(1200);
    expect(Number(row!.cumulative_fees_claimed_usd)).toBe(0);
    expect(row!.entry_price_usd).toBeNull();
    expect(row!.entry_amount_x_usd).toBeNull();
    expect(row!.entry_amount_y_usd).toBeNull();
    expect(row!.closed_at).toBeNull();
    expect(row!.realized_pnl_usd).toBeNull();
    db.close();
  });
});

// ─── DB record keeping ───────────────────────────────────────────────────────

async function runDb<T>(
  effect: Effect.Effect<T, unknown, DbService>,
  layer: Layer.Layer<DbService, never, never>,
): Promise<T> {
  return Effect.runPromise(Effect.provide(effect, layer));
}

describe("DbService — position events + soft close", () => {
  it("records and reads position_events in creation order", async () => {
    const layer = DbLive(":memory:");
    const events = await runDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(makePosition({ poolAddress: "pool1" }));
        yield* db.savePositionEvent({
          id: "evt-1",
          poolAddress: "pool1",
          positionPubKey: null,
          positionId: "paper-pool1",
          event: "ENTER",
          valueUsd: 1000,
          feesUsd: null,
          price: 100,
          metadata: { lowerBinId: 4980, upperBinId: 5020 },
          createdAt: 1000,
        });
        yield* db.savePositionEvent({
          id: "evt-2",
          poolAddress: "pool1",
          positionPubKey: null,
          positionId: "paper-pool1",
          event: "CLAIM",
          valueUsd: null,
          feesUsd: 25,
          price: 100,
          createdAt: 2000,
        });
        return yield* db.getPositionEvents("pool1");
      }),
      layer,
    );
    expect(events).toHaveLength(2);
    expect(events[0]!.event).toBe("ENTER");
    expect(events[0]!.valueUsd).toBe(1000);
    expect(events[0]!.price).toBe(100);
    expect(events[0]!.metadata).toContain("lowerBinId");
    expect(events[1]!.event).toBe("CLAIM");
    expect(events[1]!.feesUsd).toBe(25);
  });

  it("closePosition soft-closes: excluded from active, present in closed, realized PnL stored", async () => {
    const layer = DbLive(":memory:");
    const result = await runDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(makePosition({ poolAddress: "pool1", currentValueUsd: 1100 }));
        yield* db.closePosition("paper-pool1", 125);
        const active = yield* db.getAllPositions();
        const closed = yield* db.getClosedPositions();
        const raw = yield* db.getPosition("paper-pool1");
        return { active, closed, raw };
      }),
      layer,
    );
    expect(result.active).toHaveLength(0);
    expect(result.closed).toHaveLength(1);
    expect(result.closed[0]!.poolAddress).toBe("pool1");
    expect(result.closed[0]!.realizedPnlUsd).toBeCloseTo(125, 8);
    expect(result.closed[0]!.closedAt).not.toBeNull();
    expect(result.raw).not.toBeNull();
  });

  it("getLatestSnapshotPrice returns the newest snapshot price or null", async () => {
    const layer = DbLive(":memory:");
    const prices = await runDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const missing = yield* db.getLatestSnapshotPrice("pool1");
        yield* db.saveSnapshot({
          poolAddress: "pool1",
          timestamp: 1000,
          activeBinId: 5000,
          tvlUsd: 100_000,
          volume24hUsd: 1000,
          fees24hUsd: 10,
          apr: 5,
          currentPrice: 100,
          binStep: 10,
          tokenXSymbol: "SOL",
          tokenYSymbol: "USDC",
          binArray: { lowerBinId: 4980, upperBinId: 5020, bins: [], activeBinId: 5000 },
        });
        yield* db.saveSnapshot({
          poolAddress: "pool1",
          timestamp: 2000,
          activeBinId: 5001,
          tvlUsd: 100_000,
          volume24hUsd: 1000,
          fees24hUsd: 10,
          apr: 5,
          currentPrice: 110,
          binStep: 10,
          tokenXSymbol: "SOL",
          tokenYSymbol: "USDC",
          binArray: { lowerBinId: 4980, upperBinId: 5020, bins: [], activeBinId: 5001 },
        });
        const latest = yield* db.getLatestSnapshotPrice("pool1");
        return { missing, latest };
      }),
      layer,
    );
    expect(prices.missing).toBeNull();
    expect(prices.latest).toBe(110);
  });
});

// ─── Lifecycle: ENTER → CLAIM → price move → EXIT (paper path) ───────────────

// Minimal strategy surface for paper entries: only recommendBinRange is used.
const paperStrategy: StrategyApi = {
  computeMetrics: () => {
    throw new Error("not used");
  },
  checkVolumeAuthenticity: () => ({ score: 1, flags: [] }),
  computeBinUtilization: () => 1,
  computeFeeIlRatio: () => 1,
  recommendBinRange: (activeBinId: number) => ({
    lowerBinId: activeBinId - 20,
    upperBinId: activeBinId + 20,
  }),
  passesPreFilter: () => true,
};

describe("paper lifecycle PnL accounting", () => {
  it("ENTER snapshots entry price/legs and writes an ENTER event", async () => {
    const layer = DbLive(":memory:");
    const trackedPositions = new Map<string, PositionRecord>();
    const pool = {
      activeBinId: 5000,
      binStep: 10,
      tokenXSymbol: "SOL",
      tokenYSymbol: "USDC",
      currentPrice: 100,
    };

    const outcome = await runDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const result = yield* executePaper(
          { db, trackedPositions, strategy: paperStrategy, entryStrategyShape: "spot" },
          {
            action: "ENTER",
            poolAddress: "pool1",
            confidence: 0.8,
            reasoning: "test entry",
            positionSizeUsd: 1000,
          },
          pool,
        );
        const tracked = [...trackedPositions.values()][0]!;
        const pos = yield* db.getPosition(tracked.positionId);
        const events = yield* db.getPositionEvents("pool1");
        return { result, pos, events };
      }),
      layer,
    );

    expect(outcome.result.executed).toBe(true);
    expect(outcome.pos).not.toBeNull();
    expect(outcome.pos!.entryPriceUsd).toBe(100);
    expect(outcome.pos!.entryAmountXUsd).toBeCloseTo(500, 8);
    expect(outcome.pos!.entryAmountYUsd).toBeCloseTo(500, 8);
    expect(outcome.pos!.cumulativeFeesClaimedUsd).toBe(0);
    expect(outcome.pos!.closedAt).toBeNull();
    expect(outcome.pos!.realizedPnlUsd).toBeNull();
    expect(outcome.events.map((e) => e.event)).toEqual(["ENTER"]);
    expect(outcome.events[0]!.valueUsd).toBe(1000);
    expect(outcome.events[0]!.price).toBe(100);
  });

  it("EXIT computes realized PnL (value + fees − basis), writes EXIT event, soft-closes", async () => {
    const layer = DbLive(":memory:");
    const trackedPositions = new Map<string, PositionRecord>();
    const pool = {
      activeBinId: 5000,
      binStep: 10,
      tokenXSymbol: "SOL",
      tokenYSymbol: "USDC",
      currentPrice: 100,
    };

    const outcome = await runDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* executePaper(
          { db, trackedPositions, strategy: paperStrategy, entryStrategyShape: "spot" },
          {
            action: "ENTER",
            poolAddress: "pool1",
            confidence: 0.8,
            reasoning: "test entry",
            positionSizeUsd: 1000,
          },
          pool,
        );

        // CLAIM $25 of fees (mirrors the engine's claim accounting).
        const pos = [...trackedPositions.values()][0]!;
        pos.cumulativeFeesClaimedUsd += 25;
        yield* db.savePosition(pos);
        yield* db.savePositionEvent({
          id: "evt-claim",
          poolAddress: "pool1",
          positionPubKey: null,
          positionId: pos.positionId,
          event: "CLAIM",
          valueUsd: null,
          feesUsd: 25,
          price: 100,
          createdAt: Date.now(),
        });

        // Price moves 100 → 110; the per-cycle value tracker marks the position to $1100.
        pos.currentValueUsd = 1100;
        yield* db.savePosition(pos);

        const exitResult = yield* executePaper(
          { db, trackedPositions, strategy: paperStrategy, entryStrategyShape: "spot" },
          { action: "EXIT", poolAddress: "pool1", confidence: 0.9, reasoning: "test exit" },
          { ...pool, currentPrice: 110 },
        );

        const closed = yield* db.getClosedPositions();
        const active = yield* db.getAllPositions();
        const events = yield* db.getPositionEvents("pool1");
        return { exitResult, closed, active, events };
      }),
      layer,
    );

    expect(outcome.exitResult.executed).toBe(true);
    expect(outcome.active).toHaveLength(0);
    expect(outcome.closed).toHaveLength(1);

    const closed = outcome.closed[0]!;
    // realized = final value 1100 + fees 25 − basis 1000 = 125
    expect(closed.realizedPnlUsd).toBeCloseTo(125, 8);
    expect(closed.closedAt).not.toBeNull();

    expect(outcome.events.map((e) => e.event)).toEqual(["ENTER", "CLAIM", "EXIT"]);
    const exitEvent = outcome.events[2]!;
    expect(exitEvent.valueUsd).toBeCloseTo(1100, 8);
    expect(exitEvent.feesUsd).toBeCloseTo(25, 8);
    expect(exitEvent.price).toBe(110);

    // HODL benchmark: 500 × (110/100) + 500 = 1050 → IL-vs-HODL = 1100 − 1050 = 50.
    const analytics = computePositionAnalytics(
      {
        depositedUsd: closed.depositedUsd,
        currentValueUsd: closed.currentValueUsd,
        cumulativeFeesClaimedUsd: closed.cumulativeFeesClaimedUsd,
        entryPriceUsd: closed.entryPriceUsd,
        entryAmountXUsd: closed.entryAmountXUsd,
        entryAmountYUsd: closed.entryAmountYUsd,
        openedAtMs: closed.timestamp,
        outOfRangeSinceMs: closed.outOfRangeSince,
      },
      110,
      Date.now(),
    );
    expect(analytics.hodlValueUsd).toBeCloseTo(1050, 6);
    expect(analytics.ilVsHodlUsd).toBeCloseTo(50, 6);
  });
});

// ─── Live REBALANCE inline-claim accounting ──────────────────────────────────

function makeLiveAdapter(overrides: Partial<AdapterApi> = {}): AdapterApi {
  return {
    hasWallet: () => true,
    getWalletAddress: () => "Wallet111",
    getWalletBalanceUsd: () => Effect.succeed(10_000),
    getNativeSolBalance: () => Effect.succeed(10_000_000_000n),
    getPoolState: () => Effect.fail(new Error("not used")),
    getBinArray: () => Effect.fail(new Error("not used")),
    getPositions: () => Effect.succeed([]),
    getAllWalletPositions: () => Effect.succeed([]),
    simulateRebalance: () =>
      Effect.succeed({
        estimatedFeesUsd: 0,
        estimatedCostUsd: 0,
        netBenefitUsd: 0,
        source: "pool-heuristic" as const,
      }),
    enterPosition: (
      _poolAddress: string,
      _lowerBinId: number,
      _upperBinId: number,
      positionSizeUsd: number,
    ) =>
      Effect.succeed({
        positionPubKey: "pos-1",
        txSignature: "tx-enter",
        depositMode: "two-sided" as const,
        amountXUsd: positionSizeUsd / 2,
        amountYUsd: positionSizeUsd / 2,
      }),
    exitPosition: () => Effect.succeed({ txSignature: "tx-exit" }),
    // Atomic rebalance (Wave 6): the SDK rebalancePosition instruction
    // preserves the position account, so the same pubkey comes back.
    rebalancePosition: () =>
      Effect.succeed({ positionPubKey: "pos-1", txSignatures: ["tx-rebalance"] }),
    claimFees: () =>
      Effect.succeed({
        txSignature: "tx-claim",
        feeX: 0,
        feeY: 25_000_000, // 25 USDC raw (6 decimals)
        platformFeeX: 0,
        platformFeeY: 0,
        netFeeX: 0,
        netFeeY: 25_000_000,
        netFeesUsd: 25, // mint-based USD of the net claim
      }),
    claimRewards: () =>
      Effect.succeed({
        skipped: true,
        skipReason: "no pending rewards",
        txSignatures: [],
        rewards: [],
      }),
    discoverPools: () => Effect.succeed([]),
    reportFeeCollection: () => Effect.void,
    swapUSDCForSOL: () => Effect.void,
    getTokenBalance: () => Effect.succeed(0n),
    getTokenPrices: () => Effect.succeed({}),
    getTokenDecimals: () => Effect.succeed(9),
    quoteSwapUSDCForToken: () => Effect.succeed({}),
    swapUSDCForToken: () => Effect.succeed("mock-swap-tx"),
    getMintAuthorities: () => Effect.succeed({ mintAuthority: null, freezeAuthority: null }),
    ...overrides,
  } as AdapterApi;
}

type ExitResult = Effect.Effect.Success<ReturnType<AdapterApi["exitPosition"]>>;

/**
 * Full-contract `exitPosition` result with neutral defaults. Absent amounts
 * mean "unresolved" to the program (NULL realized path), so tests that assert
 * a concrete realized value MUST override `withdrawnUsd` (and any swept fees /
 * rewards) — this mirrors the real adapter's fail-closed pricing.
 */
function exitResult(overrides: Partial<ExitResult> = {}): ExitResult {
  return {
    txSignature: "tx-exit",
    withdrawnXAtomic: "0",
    withdrawnYAtomic: "0",
    withdrawnUsd: null,
    pendingFeeXAtomic: "0",
    pendingFeeYAtomic: "0",
    pendingFeeUsd: null,
    sweptRewards: [],
    ...overrides,
  };
}

const liveStrategy: StrategyApi = {
  computeMetrics: () => {
    throw new Error("not used");
  },
  checkVolumeAuthenticity: () => ({ score: 1, flags: [] }),
  computeBinUtilization: () => 1,
  computeFeeIlRatio: () => 1,
  recommendBinRange: (activeBinId: number) => ({
    lowerBinId: activeBinId - 20,
    upperBinId: activeBinId + 20,
  }),
  passesPreFilter: () => true,
};

const liveRevenueConfig: RevenueConfigApi = {
  getConfig: () =>
    Effect.succeed({
      tier: "free",
      platformFeeRate: 0,
      revenueShareEnabled: false,
      revenueShareOperatorPct: 0,
      feeWalletAddress: "",
    }),
  refreshConfig: () =>
    Effect.succeed({
      tier: "free",
      platformFeeRate: 0,
      revenueShareEnabled: false,
      revenueShareOperatorPct: 0,
      feeWalletAddress: "",
    }),
};

const liveEntryPrep: EntryPrepApi = { prepareEntryTokens: () => Effect.void };

describe("live lifecycle PnL accounting", () => {
  it("ENTER stores entry basis; REBALANCE inline claim accumulates fees + events; EXIT realizes PnL", async () => {
    const layer = DbLive(":memory:");
        const trackedPositions = new Map<string, PositionRecord>();
        const pool = {
          activeBinId: 5000,
          binStep: 10,
          tokenXSymbol: "SOL",
          tokenYSymbol: "USDC",
          currentPrice: 100,
        };

        const outcome = await runDb(
          Effect.gen(function* () {
            const db = yield* DbService;
            const deps = {
              // The REBALANCE claimed the $25 inline (netFeesUsd: 25). At EXIT
              // the position's withdrawn value is $1100 with NO new pending fees
              // (they were already swept by the rebalance claim) → realized =
              // 1100 + 25 (prior) − 1000 (basis) = 125.
              adapter: makeLiveAdapter({
                exitPosition: () =>
                  Effect.succeed(
                    exitResult({
                      withdrawnUsd: 1100,
                      withdrawnXAtomic: "11000000000",
                      pendingFeeUsd: 0,
                    }),
                  ),
              }),
              strategy: liveStrategy,
              db,
              revenueConfigSvc: liveRevenueConfig,
              trackedPositions,
              entryPrep: liveEntryPrep,
              solPriceUsd: 150,
              entryStrategyShape: "spot" as const,
            };

        // 1. ENTER $1000 at price 100.
        const enter = yield* executeLive(
          deps,
          {
            action: "ENTER",
            poolAddress: "pool1",
            confidence: 0.8,
            reasoning: "entry",
            positionSizeUsd: 1000,
          },
          pool,
        );
        expect(enter.executed).toBe(true);

        // 2. REBALANCE claims $25 USDC of fees inline, then re-ranges.
        const rebalance = yield* executeLive(
          deps,
          {
            action: "REBALANCE",
            poolAddress: "pool1",
            confidence: 0.8,
            reasoning: "re-range",
            rebalanceParams: { newLowerBinId: 4990, newUpperBinId: 5030, slippageBps: 50 },
          },
          pool,
        );
        expect(rebalance.executed).toBe(true);

        // Wave 6: the atomic rebalance preserves the position account — the
        // same pubkey, the entry basis and accrued fees all survive.
        const afterRebalance = trackedPositions.get("pos-1")!;
        expect(afterRebalance.positionPubKey).toBe("pos-1");
        expect(afterRebalance.lowerBinId).toBe(4990);
        expect(afterRebalance.upperBinId).toBe(5030);
        expect(afterRebalance.entryPriceUsd).toBe(100);
        expect(afterRebalance.entryAmountXUsd).toBeCloseTo(500, 8);
        expect(afterRebalance.entryAmountYUsd).toBeCloseTo(500, 8);
        expect(afterRebalance.cumulativeFeesClaimedUsd).toBeCloseTo(25, 8);

        // 3. Price moves 100 → 110; position marked to $1100.
        const pos = trackedPositions.get("pos-1")!;
        pos.currentValueUsd = 1100;
        yield* db.savePosition(pos);

        // 4. EXIT realizes the PnL on-chain.
        const exit = yield* executeLive(
          deps,
          { action: "EXIT", poolAddress: "pool1", confidence: 0.9, reasoning: "exit" },
          { ...pool, currentPrice: 110 },
        );
        expect(exit.executed).toBe(true);

        const closed = yield* db.getClosedPositions();
        const active = yield* db.getAllPositions();
        const events = yield* db.getPositionEvents("pool1");
        return { closed, active, events, tracked: trackedPositions.get("pos-1") };
      }),
      layer,
    );

    expect(outcome.active).toHaveLength(0);
    expect(outcome.tracked).toBeUndefined();
    expect(outcome.closed).toHaveLength(1);

    const closed = outcome.closed[0]!;
    expect(closed.entryPriceUsd).toBe(100);
    expect(closed.entryAmountXUsd).toBeCloseTo(500, 8);
    expect(closed.entryAmountYUsd).toBeCloseTo(500, 8);
    expect(closed.cumulativeFeesClaimedUsd).toBeCloseTo(25, 8);
    expect(closed.realizedPnlUsd).toBeCloseTo(125, 8);
    expect(closed.closedAt).not.toBeNull();

    expect(outcome.events.map((e) => e.event)).toEqual(["ENTER", "CLAIM", "REBALANCE", "EXIT"]);
    const claimEvent = outcome.events[1]!;
    expect(claimEvent.feesUsd).toBeCloseTo(25, 8);
    const rebalanceEvent = outcome.events[2]!;
    expect(rebalanceEvent.metadata).toContain("4990");
  });

  // ── Exit-sweep realized-PnL accounting (Oracle-locked ordering) ─────────
  //
  // Each scenario ENTERs a live $1000 position (500/500 @ price 100, basis
  // 1000), optionally seeds prior fee/compound state, then EXITs with a
  // full-contract exitPosition result and asserts the realized economics.

  async function runLiveExitScenario(options: {
    exit: ExitResult;
    seed?: (pos: PositionRecord) => void;
  }) {
    const layer = DbLive(":memory:");
    const trackedPositions = new Map<string, PositionRecord>();
    const pool = {
      activeBinId: 5000,
      binStep: 10,
      tokenXSymbol: "SOL",
      tokenYSymbol: "USDC",
      currentPrice: 100,
    };
    return runDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const deps = {
          adapter: makeLiveAdapter({ exitPosition: () => Effect.succeed(options.exit) }),
          strategy: liveStrategy,
          db,
          revenueConfigSvc: liveRevenueConfig,
          trackedPositions,
          entryPrep: liveEntryPrep,
          solPriceUsd: 150,
          entryStrategyShape: "spot" as const,
        };
        const enter = yield* executeLive(
          deps,
          { action: "ENTER", poolAddress: "pool1", confidence: 0.8, reasoning: "entry", positionSizeUsd: 1000 },
          pool,
        );
        expect(enter.executed).toBe(true);
        const pos = trackedPositions.get("pos-1")!;
        if (options.seed) options.seed(pos);
        yield* db.savePosition(pos);
        const exit = yield* executeLive(
          deps,
          { action: "EXIT", poolAddress: "pool1", confidence: 0.9, reasoning: "exit" },
          pool,
        );
        expect(exit.executed).toBe(true);
        const closed = yield* db.getClosedPositions();
        const events = yield* db.getPositionEvents("pool1");
        const feeClaims = yield* db.getUnreportedFeeClaims();
        return { closed, events, feeClaims };
      }),
      layer,
    );
  }

  it("exit before the claim gate sweeps unclaimed fees into realized PnL (the live-bug pin)", async () => {
    // Position accrued $25 of fees but was exited before the 24h claim gate,
    // so cumulativeFeesClaimedUsd is still 0. withdrawn = principal + the $25
    // swept at close → realized = 1025 + 0 − 1000 = 25 = pendingFeeUsd.
    const outcome = await runLiveExitScenario({
      exit: exitResult({
        withdrawnUsd: 1025,
        withdrawnXAtomic: "5000000000",
        withdrawnYAtomic: "525000000",
        pendingFeeYAtomic: "25000000", // 25 USDC (6 decimals)
        pendingFeeUsd: 25,
      }),
    });

    const closed = outcome.closed[0]!;
    expect(closed.realizedPnlUsd).toBeCloseTo(25, 8);

    const exitEvent = outcome.events.find((e) => e.event === "EXIT")!;
    expect(exitEvent.feesUsd).toBeCloseTo(25, 8); // post-credit lifetime fees ≠ 0
    expect(exitEvent.valueUsd).toBeCloseTo(1025, 8);

    // A fee-claim record tagged as an exit sweep (CLAIM event + fee_claims row).
    const sweepClaim = outcome.events.find(
      (e) => e.event === "CLAIM" && JSON.parse(e.metadata ?? "{}").kind === "exit_sweep",
    )!;
    expect(sweepClaim).toBeDefined();
    expect(sweepClaim.feesUsd).toBeCloseTo(25, 8);
    expect(outcome.feeClaims.some((c) => c.txSignature?.startsWith("exit-sweep:"))).toBe(true);
  });

  it("exit after a prior claim realizes prior + swept fees; the sweep records only the new fees", async () => {
    // Prior claim F1 = $10 already in cumulativeFeesClaimedUsd. At exit, $25
    // more (F2) is unclaimed and swept. realized = withdrawn(1025) + F1(10) −
    // basis(1000) = 35 = F1 + F2.
    const outcome = await runLiveExitScenario({
      seed: (pos) => {
        pos.cumulativeFeesClaimedUsd = 10;
      },
      exit: exitResult({
        withdrawnUsd: 1025,
        withdrawnXAtomic: "5000000000",
        withdrawnYAtomic: "25000000",
        pendingFeeYAtomic: "25000000",
        pendingFeeUsd: 25,
      }),
    });

    const closed = outcome.closed[0]!;
    expect(closed.realizedPnlUsd).toBeCloseTo(35, 8);
    expect(closed.cumulativeFeesClaimedUsd).toBeCloseTo(35, 8); // 10 prior + 25 swept

    const sweepClaim = outcome.events.find(
      (e) => e.event === "CLAIM" && JSON.parse(e.metadata ?? "{}").kind === "exit_sweep",
    )!;
    expect(sweepClaim.feesUsd).toBeCloseTo(25, 8); // sweep records F2 only
  });

  it("exit after compounding realizes F1+F2 exactly once, never F1+2F2", async () => {
    // F1 = $10 was claimed AND recompounded: basis rises 1000 → 1010 and the
    // $10 is in cumulativeFeesClaimedUsd. At exit $25 more (F2) is swept.
    // withdrawn = 1035 (principal incl. recompounded F1 + F2).
    // realized = 1035 + 10 (prior) − 1010 (basis) = 35 = F1 + F2.
    // The pre-crediting regression would give 1035 + (10+25) − 1010 = 60.
    const outcome = await runLiveExitScenario({
      seed: (pos) => {
        const compounded = applyCompoundToCostBasis({
          depositedUsd: pos.depositedUsd,
          currentValueUsd: pos.currentValueUsd,
          highestValueUsd: pos.highestValueUsd,
          compoundedFeesUsd: 10,
        });
        pos.depositedUsd = compounded.depositedUsd; // 1010
        pos.currentValueUsd = compounded.currentValueUsd;
        pos.highestValueUsd = compounded.highestValueUsd;
        pos.cumulativeFeesClaimedUsd = 10;
      },
      exit: exitResult({
        withdrawnUsd: 1035,
        withdrawnXAtomic: "5000000000",
        withdrawnYAtomic: "35000000",
        pendingFeeYAtomic: "25000000",
        pendingFeeUsd: 25,
      }),
    });

    const closed = outcome.closed[0]!;
    expect(closed.realizedPnlUsd).toBeCloseTo(35, 8);
    expect(closed.realizedPnlUsd).not.toBeCloseTo(60, 8);
  });

  it("credits a priced reward at exit (post-compute) and records an exit_sweep_reward CLAIM", async () => {
    const outcome = await runLiveExitScenario({
      exit: exitResult({
        withdrawnUsd: 1000,
        withdrawnXAtomic: "5000000000",
        pendingFeeUsd: 0,
        sweptRewards: [{ mint: "RewardMint111", amountAtomic: 5_000_000, amountUsd: 7 }],
      }),
    });

    const closed = outcome.closed[0]!;
    // Exactly-once: the PRICED swept reward ($7) is part of the withdrawal, so it
    // enters realized via the rewards ARGUMENT (computed before the post-compute
    // credit). realized = withdrawn 1000 + fees 0 + (prior rewards 0 + swept 7) −
    // basis 1000 = 7. The same $7 is then credited to cumulativeRewardsClaimedUsd
    // for APR/display only — the two never sum together into realized again.
    expect(closed.realizedPnlUsd).toBeCloseTo(7, 8);
    expect(closed.cumulativeRewardsClaimedUsd).toBeCloseTo(7, 8);

    const rewardClaim = outcome.events.find(
      (e) => e.event === "CLAIM" && JSON.parse(e.metadata ?? "{}").kind === "exit_sweep_reward",
    )!;
    expect(rewardClaim).toBeDefined();
    expect(rewardClaim.valueUsd).toBeCloseTo(7, 8);
  });

  it("records an unpriceable reward with null USD, leaves realized unaffected, still closes", async () => {
    const outcome = await runLiveExitScenario({
      exit: exitResult({
        withdrawnUsd: 1000,
        withdrawnXAtomic: "5000000000",
        pendingFeeUsd: 0,
        sweptRewards: [{ mint: "ExoticMint", amountAtomic: 1_000, amountUsd: null }],
      }),
    });

    const closed = outcome.closed[0]!;
    expect(closed.closedAt).not.toBeNull();
    expect(closed.realizedPnlUsd).toBeCloseTo(0, 8);
    // Unpriceable reward is NOT credited to cumulativeRewardsClaimedUsd.
    expect(closed.cumulativeRewardsClaimedUsd).toBeCloseTo(0, 8);

    const rewardClaim = outcome.events.find(
      (e) => e.event === "CLAIM" && JSON.parse(e.metadata ?? "{}").kind === "exit_sweep_reward",
    )!;
    expect(rewardClaim).toBeDefined();
    expect(rewardClaim.valueUsd).toBeNull();
  });

  it("records NULL realized when exit pricing is unresolved, but still closes with raw amounts", async () => {
    const outcome = await runLiveExitScenario({
      seed: (pos) => {
        pos.currentValueUsd = 950; // last mark before the unpriced close
      },
      exit: exitResult({
        withdrawnXAtomic: "1111",
        withdrawnYAtomic: "2222",
        pendingFeeXAtomic: "555",
        pendingFeeYAtomic: "0",
        // withdrawnUsd / pendingFeeUsd left null → unresolved pricing.
      }),
    });

    const closed = outcome.closed[0]!;
    expect(closed.closedAt).not.toBeNull(); // close still happened
    expect(closed.realizedPnlUsd).toBeNull(); // n/a, never the mark, never 0

    const exitEvent = outcome.events.find((e) => e.event === "EXIT")!;
    expect(exitEvent.valueUsd).toBeNull();
    const meta = JSON.parse(exitEvent.metadata ?? "{}") as {
      pricing?: string;
      lastMarkUsd?: number;
      raw?: Record<string, unknown>;
    };
    expect(meta.pricing).toBe("unresolved");
    expect(meta.lastMarkUsd).toBeCloseTo(950, 8);
    expect(meta.raw?.withdrawnXAtomic).toBe("1111");
    expect(meta.raw?.pendingFeeXAtomic).toBe("555");
    // No fee credit when pricing is unresolved.
    expect(outcome.feeClaims.some((c) => c.txSignature?.startsWith("exit-sweep:"))).toBe(false);
  });

  it("flags the pool for reconcile when the on-chain close fails (no resurrection, no silent drop)", async () => {
    const layer = DbLive(":memory:");
    const trackedPositions = new Map<string, PositionRecord>();
    const reconcileRequestedPools = new Set<string>();
    const pool = {
      activeBinId: 5000,
      binStep: 10,
      tokenXSymbol: "SOL",
      tokenYSymbol: "USDC",
      currentPrice: 100,
    };
    const result = await runDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const pos = makePosition({
          poolAddress: "pool1",
          positionId: "pos-1",
          positionPubKey: "pos-1",
          depositedUsd: 1000,
          currentValueUsd: 1000,
        });
        trackedPositions.set("pos-1", pos);
        yield* db.savePosition(pos);
        return yield* executeLive(
          {
            adapter: makeLiveAdapter({
              exitPosition: () => Effect.fail(new Error("close tx failed")),
            }),
            strategy: liveStrategy,
            db,
            revenueConfigSvc: liveRevenueConfig,
            trackedPositions,
            entryPrep: liveEntryPrep,
            solPriceUsd: 150,
            entryStrategyShape: "spot" as const,
            reconcileRequestedPools,
          },
          {
            action: "EXIT",
            poolAddress: "pool1",
            confidence: 0.9,
            reasoning: "exit",
            positionId: "pos-1",
          },
          pool,
        );
      }),
      layer,
    );
    // The close failed → not executed, and the pool is flagged so the next
    // cycle's reconcile re-reads the wallet's real positions and drops the row
    // if it was half-closed on-chain (the phantom-row guard).
    expect(result.executed).toBe(false);
    expect(reconcileRequestedPools.has("pool1")).toBe(true);
  });
});

// ─── Paper notional-fee accrual (A4) — pure function ─────────────────────────

describe("computePaperFeeAccrualUsd", () => {
  const base = {
    fees24hUsd: 300 as number | null | undefined,
    tvlUsd: 100_000,
    depositedUsd: 800,
    activeBinId: 5000,
    lowerBinId: 4980,
    upperBinId: 5020,
    firstCycle: true,
    elapsedMs: 0,
    scanIntervalMs: 600_000,
  };

  it("accrues the exact proportional share for one in-range scan interval", () => {
    // share = min(800/100000, 1) = 0.008; inRange = 1; dt = 600000ms.
    // 300 × 0.008 × 1 × (600000/86400000) = 0.01666…
    expect(computePaperFeeAccrualUsd(base)).toBeCloseTo(300 * 0.008 * (600_000 / 86_400_000), 12);
  });

  it("accrues nothing when the active bin is out of range (binary gate)", () => {
    expect(computePaperFeeAccrualUsd({ ...base, activeBinId: 4000 })).toBe(0);
    expect(computePaperFeeAccrualUsd({ ...base, activeBinId: 6000 })).toBe(0);
  });

  it("accrues nothing for heuristic / dead pools (fees null, 0, NaN; zero TVL)", () => {
    expect(computePaperFeeAccrualUsd({ ...base, fees24hUsd: null })).toBe(0);
    expect(computePaperFeeAccrualUsd({ ...base, fees24hUsd: 0 })).toBe(0);
    expect(computePaperFeeAccrualUsd({ ...base, fees24hUsd: Number.NaN })).toBe(0);
    expect(computePaperFeeAccrualUsd({ ...base, tvlUsd: 0 })).toBe(0);
  });

  it("caps the elapsed window at 2× scan interval after the first cycle", () => {
    // 10 intervals of downtime → only 2 intervals of fees are booked.
    const capped = computePaperFeeAccrualUsd({
      ...base,
      firstCycle: false,
      elapsedMs: 10 * base.scanIntervalMs,
    });
    const twoIntervals = 300 * 0.008 * (1_200_000 / 86_400_000);
    expect(capped).toBeCloseTo(twoIntervals, 12);
    expect(capped).toBeLessThan(300 * 0.008 * (10 * 600_000) / 86_400_000);
  });

  it("uses one scan interval on the first cycle regardless of elapsed", () => {
    const first = computePaperFeeAccrualUsd({ ...base, firstCycle: true, elapsedMs: 999_999_999 });
    expect(first).toBeCloseTo(computePaperFeeAccrualUsd(base), 12);
  });
});
