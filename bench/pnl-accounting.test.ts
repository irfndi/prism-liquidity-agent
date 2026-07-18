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
import { executePaper, executeLive } from "../engine/program.js";
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
        yield* db.closePosition("pool1", 125);
        const active = yield* db.getAllPositions();
        const closed = yield* db.getClosedPositions();
        const raw = yield* db.getPosition("pool1");
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
          { db, trackedPositions },
          {
            action: "ENTER",
            poolAddress: "pool1",
            confidence: 0.8,
            reasoning: "test entry",
            positionSizeUsd: 1000,
          },
          pool,
        );
        const pos = yield* db.getPosition("pool1");
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
          { db, trackedPositions },
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
        const pos = trackedPositions.get("pool1")!;
        pos.cumulativeFeesClaimedUsd += 25;
        yield* db.savePosition(pos);
        yield* db.savePositionEvent({
          id: "evt-claim",
          poolAddress: "pool1",
          positionPubKey: null,
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
          { db, trackedPositions },
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
      Effect.succeed({ estimatedIlUsd: 0, estimatedFeesUsd: 0, netBenefitUsd: 0 }),
    enterPosition: () => Effect.succeed({ positionPubKey: "pos-1", txSignature: "tx-enter" }),
    exitPosition: () => Effect.succeed({ txSignature: "tx-exit" }),
    rebalancePosition: () =>
      Effect.succeed({ newPositionPubKey: "pos-2", txSignatures: ["tx-rebalance"] }),
    claimFees: () =>
      Effect.succeed({
        txSignature: "tx-claim",
        feeX: 0,
        feeY: 25_000_000, // 25 USDC raw (6 decimals)
        platformFeeX: 0,
        platformFeeY: 0,
        netFeeX: 0,
        netFeeY: 25_000_000,
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
          adapter: makeLiveAdapter(),
          strategy: liveStrategy,
          db,
          revenueConfigSvc: liveRevenueConfig,
          trackedPositions,
          entryPrep: liveEntryPrep,
          solPriceUsd: 150,
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

        // 3. Price moves 100 → 110; position marked to $1100.
        const pos = trackedPositions.get("pool1")!;
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
        return { closed, active, events, tracked: trackedPositions.get("pool1") };
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
});
