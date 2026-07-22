import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Effect, Layer } from "effect";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDatabase } from "../engine/db.js";
import { DbLive, type PositionRecord } from "../engine/db-service.js";
import {
  evaluateRisk,
  evaluatePerPoolAllocation,
  evaluateAgentProposal,
  type RiskConfig,
} from "../engine/risk-service.js";
import { executePaper, executeLive, reconcilePositions, program } from "../engine/program.js";
import { computeSummary, toJsonOutput, formatPosition } from "../cli/portfolio.js";
import { AlertLive } from "../engine/alert-service.js";
import { StrategyLive } from "../engine/strategy-service.js";
import { MemoryLive } from "../engine/memory-service.js";
import { RiskLive } from "../engine/risk-service.js";
import { AuditLive } from "../engine/audit-service.js";
import { AgentNoOp } from "../engine/agent-service.js";
import { AgentStateMutable } from "../engine/state-service.js";
import { ConfigService, type AppConfig } from "../engine/config-service.js";
import {
  AdapterService,
  BlacklistService,
  AuditService,
  ScreenerService,
  DbService,
  MemoryService,
  RevenueService,
  RevenueConfigService,
  ReferralService,
  AgentService,
  McpServerService,
  HttpStatusServerService,
  EntryPrepService,
  MeteoraDatapiService,
  AlertService,
  type AdapterApi,
  type MeteoraDatapiApi,
  type MeteoraPoolStats,
} from "../engine/services.js";
import type { AgentDecision, PoolState, Position } from "../engine/types.js";
import { defaultAppConfig, makePool, makeBinArray, mockFetch, run } from "./helpers.js";
import { randomUUID } from "crypto";

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const POOL = "PoolMulti1111111111111111111111111111111111";

function makePos(overrides: Partial<PositionRecord> & { positionId: string }): PositionRecord {
  return {
    positionId: overrides.positionId,
    poolAddress: overrides.poolAddress ?? POOL,
    positionPubKey: overrides.positionPubKey ?? null,
    depositedUsd: overrides.depositedUsd ?? 1000,
    currentValueUsd: overrides.currentValueUsd ?? 1000,
    tokenXSymbol: "SOL",
    tokenYSymbol: "USDC",
    activeBinId: 5000,
    lowerBinId: overrides.lowerBinId ?? 4980,
    upperBinId: overrides.upperBinId ?? 5020,
    timestamp: overrides.timestamp ?? Date.now(),
    outOfRangeSince: null,
    oorCycleCount: overrides.oorCycleCount ?? 0,
    lastFeeClaimAt: Date.now(),
    trailingStopThreshold: null,
    highestValueUsd: overrides.highestValueUsd ?? null,
    lastRebalanceAt: 0,
    paperExitedAt: overrides.paperExitedAt ?? null,
    entrySignalTimestamp: null,
    entrySignalSnapshotId: null,
    entryPriceUsd: overrides.entryPriceUsd ?? 150,
    entryAmountXUsd: overrides.entryAmountXUsd ?? 500,
    entryAmountYUsd: overrides.entryAmountYUsd ?? 500,
    cumulativeFeesClaimedUsd: overrides.cumulativeFeesClaimedUsd ?? 0,
    cumulativeRewardsClaimedUsd: overrides.cumulativeRewardsClaimedUsd ?? 0,
    closedAt: overrides.closedAt ?? null,
    realizedPnlUsd: overrides.realizedPnlUsd ?? null,
  };
}

function makeRiskPosition(poolAddress: string, id: string, currentValueUsd: number): Position {
  return {
    id,
    poolAddress,
    poolName: "SOL/USDC",
    lowerBinId: 4980,
    upperBinId: 5020,
    liquidityShares: 0n,
    depositedUsd: currentValueUsd,
    currentValueUsd,
    unrealizedPnlUsd: 0,
    feesEarnedUsd: 0,
    openedAt: Date.now(),
  };
}

function runEffect<T>(
  effect: Effect.Effect<T, unknown, DbService>,
  layer: Layer.Layer<DbService>,
): T {
  return run(effect, layer);
}

// ─── DB layer: per-position identity ─────────────────────────────────────────

describe("multi-position DB layer", () => {
  it("stores two positions on the same pool keyed by position identity", () => {
    const layer = DbLive(":memory:");
    const result = runEffect(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(
          makePos({ positionId: "live-pubkey-A", positionPubKey: "live-pubkey-A" }),
        );
        yield* db.savePosition(makePos({ positionId: "paper-pool-B", depositedUsd: 800 }));
        const all = yield* db.getAllPositions();
        return all;
      }),
      layer,
    );
    expect(result).toHaveLength(2);
    const ids = result.map((p) => p.positionId).sort();
    expect(ids).toEqual(["live-pubkey-A", "paper-pool-B"]);
    expect(result.every((p) => p.poolAddress === POOL)).toBe(true);
  });

  it("upserts per position id — saving position A again leaves position B untouched", () => {
    const layer = DbLive(":memory:");
    const result = runEffect(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(makePos({ positionId: "pos-A", depositedUsd: 1000 }));
        yield* db.savePosition(
          makePos({ positionId: "pos-B", depositedUsd: 800, currentValueUsd: 800 }),
        );
        // Re-save A with an updated value (same identity, same pool).
        yield* db.savePosition(
          makePos({ positionId: "pos-A", depositedUsd: 1000, currentValueUsd: 1234 }),
        );
        const a = yield* db.getPosition("pos-A");
        const b = yield* db.getPosition("pos-B");
        const all = yield* db.getAllPositions();
        return { a, b, count: all.length };
      }),
      layer,
    );
    expect(result.count).toBe(2);
    expect(result.a?.currentValueUsd).toBe(1234);
    expect(result.b?.currentValueUsd).toBe(800);
  });

  it("getPosition looks up by position id, not pool address", () => {
    const layer = DbLive(":memory:");
    const result = runEffect(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(makePos({ positionId: "pos-A" }));
        const byId = yield* db.getPosition("pos-A");
        const byPool = yield* db.getPosition(POOL);
        return { byId, byPool };
      }),
      layer,
    );
    expect(result.byId?.poolAddress).toBe(POOL);
    expect(result.byPool).toBeNull();
  });

  it("closePosition(A) soft-closes only A — B stays fully intact (W4 accounting)", () => {
    const layer = DbLive(":memory:");
    const result = runEffect(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(
          makePos({ positionId: "pos-A", depositedUsd: 1000, currentValueUsd: 1100 }),
        );
        yield* db.savePosition(
          makePos({
            positionId: "pos-B",
            depositedUsd: 800,
            currentValueUsd: 820,
            entryPriceUsd: 140,
            entryAmountXUsd: 300,
            entryAmountYUsd: 500,
            cumulativeFeesClaimedUsd: 12,
          }),
        );
        yield* db.closePosition("pos-A", 100);
        const active = yield* db.getAllPositions();
        const closed = yield* db.getClosedPositions();
        const b = yield* db.getPosition("pos-B");
        return { active, closed, b };
      }),
      layer,
    );
    expect(result.active.map((p) => p.positionId)).toEqual(["pos-B"]);
    expect(result.closed).toHaveLength(1);
    expect(result.closed[0]!.positionId).toBe("pos-A");
    expect(result.closed[0]!.realizedPnlUsd).toBe(100);
    expect(result.closed[0]!.closedAt).not.toBeNull();
    // B's accounting fields are byte-identical to before the close of A.
    expect(result.b?.depositedUsd).toBe(800);
    expect(result.b?.currentValueUsd).toBe(820);
    expect(result.b?.entryPriceUsd).toBe(140);
    expect(result.b?.entryAmountXUsd).toBe(300);
    expect(result.b?.entryAmountYUsd).toBe(500);
    expect(result.b?.cumulativeFeesClaimedUsd).toBe(12);
    expect(result.b?.closedAt).toBeNull();
  });

  it("markPaperExited targets a single position on a shared pool", () => {
    const layer = DbLive(":memory:");
    const result = runEffect(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(makePos({ positionId: "pos-A" }));
        yield* db.savePosition(makePos({ positionId: "pos-B" }));
        yield* db.markPaperExited("pos-A");
        const active = yield* db.getAllPositions();
        const paperExited = yield* db.getPaperExitedPositions();
        return { active, paperExited };
      }),
      layer,
    );
    expect(result.active.map((p) => p.positionId)).toEqual(["pos-B"]);
    expect(result.paperExited.map((p) => p.positionId)).toEqual(["pos-A"]);
  });

  it("deletePosition removes only the targeted position", () => {
    const layer = DbLive(":memory:");
    const result = runEffect(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(makePos({ positionId: "pos-A" }));
        yield* db.savePosition(makePos({ positionId: "pos-B" }));
        yield* db.deletePosition("pos-A");
        return yield* db.getAllPositions();
      }),
      layer,
    );
    expect(result.map((p) => p.positionId)).toEqual(["pos-B"]);
  });

  it("position events carry the position identity", () => {
    const layer = DbLive(":memory:");
    const result = runEffect(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePositionEvent({
          id: randomUUID(),
          poolAddress: POOL,
          positionPubKey: null,
          positionId: "pos-A",
          event: "ENTER",
          valueUsd: 1000,
          feesUsd: null,
          price: 150,
          metadata: null,
          createdAt: Date.now(),
        });
        yield* db.savePositionEvent({
          id: randomUUID(),
          poolAddress: POOL,
          positionPubKey: null,
          positionId: "pos-B",
          event: "ENTER",
          valueUsd: 800,
          feesUsd: null,
          price: 150,
          metadata: null,
          createdAt: Date.now(),
        });
        return yield* db.getPositionEvents(POOL);
      }),
      layer,
    );
    expect(result).toHaveLength(2);
    expect(result.find((e) => e.positionId === "pos-A")?.valueUsd).toBe(1000);
    expect(result.find((e) => e.positionId === "pos-B")?.valueUsd).toBe(800);
  });
});

// ─── Migration v18: legacy rows gain per-position identities ─────────────────

describe("migration v18 (multi-position)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "prism-multi-pos-migration-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("re-keys existing single-position rows: live rows by pubkey, paper rows get synthetic ids", () => {
    const dbPath = join(tmpDir, "legacy.db");

    // Seed a pre-v18 database: positions keyed by pool_address (v17 shape).
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
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
        trailing_stop_threshold REAL,
        highest_value_usd REAL,
        last_rebalance_at INTEGER DEFAULT 0,
        paper_exited_at INTEGER,
        entry_signal_timestamp INTEGER,
        entry_signal_snapshot_id INTEGER,
        entry_price_usd REAL,
        entry_amount_x_usd REAL,
        entry_amount_y_usd REAL,
        cumulative_fees_claimed_usd REAL NOT NULL DEFAULT 0,
        cumulative_rewards_claimed_usd REAL NOT NULL DEFAULT 0,
        closed_at INTEGER,
        realized_pnl_usd REAL
      );
      CREATE TABLE position_events (
        id TEXT PRIMARY KEY,
        pool_address TEXT NOT NULL,
        position_pubkey TEXT,
        event TEXT NOT NULL,
        value_usd REAL,
        fees_usd REAL,
        price REAL,
        metadata TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    for (let v = 1; v <= 17; v++) {
      legacy.exec(`INSERT INTO _migrations (version, name, applied_at) VALUES (${v}, 'legacy', 0)`);
    }
    legacy.exec(`
      INSERT INTO positions (pool_address, position_pubkey, deposited_usd, current_value_usd,
        token_x_symbol, token_y_symbol, active_bin_id, lower_bin_id, upper_bin_id, timestamp,
        entry_price_usd, entry_amount_x_usd, entry_amount_y_usd, cumulative_fees_claimed_usd)
      VALUES ('PoolLiveLegacy', 'legacy-live-pubkey', 1000, 1100, 'SOL', 'USDC', 5000, 4980, 5020, 111,
        150, 500, 500, 42)
    `);
    legacy.exec(`
      INSERT INTO positions (pool_address, position_pubkey, deposited_usd, current_value_usd,
        token_x_symbol, token_y_symbol, active_bin_id, lower_bin_id, upper_bin_id, timestamp)
      VALUES ('PoolPaperLegacy', NULL, 700, 700, 'SOL', 'USDC', 5000, 4980, 5020, 222)
    `);
    legacy.exec(`
      INSERT INTO position_events (id, pool_address, position_pubkey, event, value_usd, created_at)
      VALUES ('evt-1', 'PoolLiveLegacy', 'legacy-live-pubkey', 'ENTER', 1000, 111)
    `);
    legacy.close();

    // Run the real migration pipeline over the legacy file.
    const migrated = createDatabase(dbPath);
    const rows = migrated
      .query(
        "SELECT position_id, pool_address, position_pubkey, deposited_usd, current_value_usd, entry_price_usd, cumulative_fees_claimed_usd FROM positions ORDER BY pool_address",
      )
      .all() as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(2);
    const live = rows.find((r) => r.pool_address === "PoolLiveLegacy")!;
    const paper = rows.find((r) => r.pool_address === "PoolPaperLegacy")!;
    // Live positions key on their on-chain pubkey; paper rows get a stable synthetic id.
    expect(live.position_id).toBe("legacy-live-pubkey");
    expect(paper.position_id).toBe("paper-PoolPaperLegacy");
    // W4 accounting survives the re-key.
    expect(live.deposited_usd).toBe(1000);
    expect(live.current_value_usd).toBe(1100);
    expect(live.entry_price_usd).toBe(150);
    expect(live.cumulative_fees_claimed_usd).toBe(42);

    // position_events gained a position_id column, backfilled from the pubkey.
    const event = migrated
      .query("SELECT position_id FROM position_events WHERE id = 'evt-1'")
      .get() as { position_id: string | null } | null;
    expect(event?.position_id).toBe("legacy-live-pubkey");

    // A second position on the legacy paper pool no longer collides.
    migrated.exec(`
      INSERT INTO positions (position_id, pool_address, deposited_usd, current_value_usd, timestamp)
      VALUES ('paper-PoolPaperLegacy-2', 'PoolPaperLegacy', 300, 300, 333)
    `);
    const count = migrated
      .query("SELECT COUNT(*) AS n FROM positions WHERE pool_address = 'PoolPaperLegacy'")
      .get() as { n: number };
    expect(count.n).toBe(2);
    migrated.close();
  });
});

// ─── Risk gate 2 rework: per-pool count cap + aggregate allocation ───────────

const riskConfig: RiskConfig = {
  confidenceThreshold: 0.65,
  maxRebalanceRangeBins: 50,
  stopLossPct: 0.15,
  maxPerPoolAllocationPct: 0.4,
  maxPositionsPerPool: 2,
};

function riskCtx(
  overrides: Partial<{
    openPositions: ReadonlyArray<Position>;
    portfolioValueUsd: number;
    recentPnlUsd: number;
    poolAddress: string;
    positionId: string;
    activeBinId: number;
    originalDecision: AgentDecision;
  }> = {},
) {
  return {
    openPositions: [] as ReadonlyArray<Position>,
    portfolioValueUsd: 10_000,
    recentPnlUsd: 0,
    poolAddress: POOL,
    ...overrides,
  };
}

describe("evaluateRisk — multi-position gate", () => {
  const enter = (size = 500): AgentDecision => ({
    action: "ENTER",
    poolAddress: POOL,
    confidence: 0.8,
    reasoning: "test",
    positionSizeUsd: size,
  });

  it("allows a second ENTER on a held pool when under the per-pool position cap", () => {
    const result = evaluateRisk(
      riskConfig,
      enter(),
      riskCtx({ openPositions: [makeRiskPosition(POOL, "pos-A", 1000)] }),
    );
    expect(result.approved).toBe(true);
  });

  it("rejects a third ENTER when the pool is at the position cap (cap=2)", () => {
    const result = evaluateRisk(
      riskConfig,
      enter(),
      riskCtx({
        openPositions: [
          makeRiskPosition(POOL, "pos-A", 1000),
          makeRiskPosition(POOL, "pos-B", 800),
        ],
      }),
    );
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/position cap/i);
  });

  it("caps the ENTER size by the pool's AGGREGATE exposure, not per-position", () => {
    // portfolio 10k, per-pool cap 40% = $4000. Pool already holds $3500 across
    // two positions → only $500 of headroom remains for the third... but the
    // count cap blocks that case, so use one existing position instead.
    const result = evaluateRisk(
      riskConfig,
      enter(1000),
      riskCtx({ openPositions: [makeRiskPosition(POOL, "pos-A", 3500)] }),
    );
    expect(result.approved).toBe(true);
    expect(result.adjustedSizeUsd).toBe(500);
  });

  it("rejects an ENTER when the pool's aggregate exposure already fills the allocation cap", () => {
    const result = evaluateRisk(
      riskConfig,
      enter(500),
      riskCtx({ openPositions: [makeRiskPosition(POOL, "pos-A", 4000)] }),
    );
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/allocation|exposure|cap/i);
  });

  it("stop-loss targets the decision's own position, not a sibling on the same pool", () => {
    const healthy = makeRiskPosition(POOL, "pos-A", 1000);
    const loser = { ...makeRiskPosition(POOL, "pos-B", 700), depositedUsd: 1000 };
    const hold = (positionId: string): AgentDecision => ({
      action: "REBALANCE",
      poolAddress: POOL,
      positionId,
      confidence: 0.8,
      reasoning: "test",
      rebalanceParams: { newLowerBinId: 4990, newUpperBinId: 5010, slippageBps: 50 },
    });
    const onLoser = evaluateRisk(
      riskConfig,
      hold("pos-B"),
      riskCtx({ openPositions: [healthy, loser], positionId: "pos-B", activeBinId: 5000 }),
    );
    expect(onLoser.approved).toBe(false);
    expect(onLoser.reason).toContain("Stop-loss");
    const onHealthy = evaluateRisk(
      riskConfig,
      hold("pos-A"),
      riskCtx({ openPositions: [healthy, loser], positionId: "pos-A", activeBinId: 5000 }),
    );
    expect(onHealthy.approved).toBe(true);
  });
});

describe("evaluatePerPoolAllocation — aggregate per-pool exposure", () => {
  const base = {
    portfolioValueUsd: 10_000,
    maxPerPoolAllocationPct: 0.4,
    maxOpenPositions: 5,
    maxPositionsPerPool: 2,
    poolAddress: POOL,
  };

  it("approves a second position on the same pool under count and exposure caps", () => {
    const result = evaluatePerPoolAllocation({
      ...base,
      proposedDepositUsd: 500,
      openPositions: [makeRiskPosition(POOL, "pos-A", 1000)],
    });
    expect(result.approved).toBe(true);
    expect(result.adjustedDepositUsd).toBe(500);
  });

  it("rejects when the pool is at the per-pool position count cap", () => {
    const result = evaluatePerPoolAllocation({
      ...base,
      proposedDepositUsd: 500,
      openPositions: [makeRiskPosition(POOL, "pos-A", 1000), makeRiskPosition(POOL, "pos-B", 800)],
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/position cap/i);
  });

  it("caps the deposit to the remaining per-pool exposure headroom", () => {
    const result = evaluatePerPoolAllocation({
      ...base,
      proposedDepositUsd: 1000,
      openPositions: [makeRiskPosition(POOL, "pos-A", 3500)],
    });
    expect(result.approved).toBe(true);
    expect(result.adjustedDepositUsd).toBe(500);
  });

  it("rejects when existing pool exposure alone fills the cap", () => {
    const result = evaluatePerPoolAllocation({
      ...base,
      proposedDepositUsd: 500,
      openPositions: [makeRiskPosition(POOL, "pos-A", 4000)],
    });
    expect(result.approved).toBe(false);
    expect(result.adjustedDepositUsd).toBe(0);
  });

  it("still enforces the portfolio-wide open-position cap", () => {
    const result = evaluatePerPoolAllocation({
      ...base,
      maxOpenPositions: 2,
      proposedDepositUsd: 100,
      openPositions: [
        makeRiskPosition(POOL, "pos-A", 100),
        makeRiskPosition("OtherPool", "pos-C", 100),
      ],
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/Max open positions/);
  });
});

describe("evaluateAgentProposal — multi-position", () => {
  const config = defaultAppConfig();
  const enterProposal = (size = 1000) => ({
    proposalId: "p-1",
    source: "sync-prompt" as const,
    confidence: 0.8,
    reasoning: "test",
    proposedAt: Date.now(),
    expiresAt: Date.now() + 300_000,
    status: "pending" as const,
    action: "ENTER" as const,
    poolAddress: POOL,
    positionSizeUsd: size,
  });

  it("accepts an ENTER proposal on an already-held pool under the position cap", () => {
    const result = evaluateAgentProposal(
      enterProposal(),
      riskCtx({ openPositions: [makeRiskPosition(POOL, "pos-A", 1000)] }),
      config,
    );
    expect(result.valid).toBe(true);
    expect(result.adjustedDecision?.action).toBe("ENTER");
  });

  it("rejects an ENTER proposal when the pool is at the position cap", () => {
    const result = evaluateAgentProposal(
      enterProposal(),
      riskCtx({
        openPositions: [
          makeRiskPosition(POOL, "pos-A", 1000),
          makeRiskPosition(POOL, "pos-B", 800),
        ],
      }),
      config,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/position cap/i);
  });

  it("targets the pool's single position for an advisor EXIT", () => {
    const { positionSizeUsd: _drop, ...exitProposal } = {
      ...enterProposal(),
      action: "EXIT" as const,
    };
    const result = evaluateAgentProposal(
      exitProposal,
      riskCtx({ openPositions: [makeRiskPosition(POOL, "pos-A", 1000)] }),
      config,
    );
    expect(result.valid).toBe(true);
    expect(result.adjustedDecision?.positionId).toBe("pos-A");
  });

  it("propagates the deterministic decision's position target through validation", () => {
    const original: AgentDecision = {
      action: "HOLD",
      poolAddress: POOL,
      positionId: "pos-B",
      confidence: 0.75,
      reasoning: "deterministic",
    };
    const { positionSizeUsd: _size, ...rebalanceProposal } = {
      ...enterProposal(),
      action: "REBALANCE" as const,
      originalAction: "HOLD" as const,
      rebalanceParams: { newLowerBinId: 4990, newUpperBinId: 5010, slippageBps: 50 },
    };
    const result = evaluateAgentProposal(
      rebalanceProposal,
      riskCtx({
        openPositions: [makeRiskPosition(POOL, "pos-B", 1000)],
        originalDecision: original,
        activeBinId: 5000,
      }),
      config,
    );
    expect(result.valid).toBe(true);
    expect(result.adjustedDecision?.positionId).toBe("pos-B");
  });
});

// ─── Paper execution: independent per-position lifecycle ─────────────────────

function makePaperDb() {
  const calls = {
    saved: [] as PositionRecord[],
    closed: [] as Array<{ id: string; pnl: number | null }>,
    paperExited: [] as string[],
    events: [] as Array<Record<string, unknown>>,
  };
  const db = {
    savePosition: (pos: PositionRecord) =>
      Effect.sync(() => {
        calls.saved.push(pos);
      }),
    savePositionEvent: (evt: Record<string, unknown>) =>
      Effect.sync(() => {
        calls.events.push(evt);
      }),
    closePosition: (id: string, pnl: number | null) =>
      Effect.sync(() => {
        calls.closed.push({ id, pnl });
      }),
    markPaperExited: (id: string) =>
      Effect.sync(() => {
        calls.paperExited.push(id);
      }),
    recordSignalOutcome: () => Effect.void,
  };
  return { db, calls };
}

const paperPool = {
  activeBinId: 5000,
  binStep: 10,
  tokenXSymbol: "SOL",
  tokenYSymbol: "USDC",
  currentPrice: 150,
};

function makePaperStrategy() {
  return {
    computeMetrics: () => {
      throw new Error("not used");
    },
    checkVolumeAuthenticity: () => ({ score: 1, flags: [] }),
    computeBinUtilization: () => 1,
    computeFeeIlRatio: () => 1,
    recommendBinRange: (active: number, _step: number, half = 20) => ({
      lowerBinId: active - half,
      upperBinId: active + half,
    }),
    passesPreFilter: () => true,
  };
}

function enterDecision(size: number): AgentDecision {
  return {
    action: "ENTER",
    poolAddress: POOL,
    confidence: 0.8,
    reasoning: "test",
    positionSizeUsd: size,
  };
}

describe("executePaper — two positions on one pool", () => {
  it("tracks both ENTERs as independent positions with distinct synthetic ids", () => {
    const { db } = makePaperDb();
    const trackedPositions = new Map<string, PositionRecord>();
    const strategy = makePaperStrategy();

    Effect.runSync(
      executePaper(
        { db: db as never, trackedPositions, strategy, entryStrategyShape: "spot" },
        enterDecision(1000),
        paperPool,
      ),
    );
    Effect.runSync(
      executePaper(
        { db: db as never, trackedPositions, strategy, entryStrategyShape: "spot" },
        enterDecision(800),
        paperPool,
      ),
    );

    expect(trackedPositions.size).toBe(2);
    const positions = [...trackedPositions.values()];
    expect(positions.every((p) => p.poolAddress === POOL)).toBe(true);
    const ids = positions.map((p) => p.positionId);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^paper-/);
    const sizes = positions.map((p) => p.depositedUsd).sort((a, b) => a - b);
    expect(sizes).toEqual([800, 1000]);
  });

  it("EXIT on position A leaves position B fully intact", () => {
    const { db, calls } = makePaperDb();
    const trackedPositions = new Map<string, PositionRecord>();
    const strategy = makePaperStrategy();

    Effect.runSync(
      executePaper(
        { db: db as never, trackedPositions, strategy, entryStrategyShape: "spot" },
        enterDecision(1000),
        paperPool,
      ),
    );
    Effect.runSync(
      executePaper(
        { db: db as never, trackedPositions, strategy, entryStrategyShape: "spot" },
        enterDecision(800),
        paperPool,
      ),
    );

    const [posA, posB] = [...trackedPositions.values()].sort(
      (a, b) => b.depositedUsd - a.depositedUsd,
    );
    expect(posA).toBeDefined();
    expect(posB).toBeDefined();

    const exitA: AgentDecision = {
      action: "EXIT",
      poolAddress: POOL,
      positionId: posA!.positionId,
      confidence: 0.8,
      reasoning: "trailing stop test",
    };
    const result = Effect.runSync(
      executePaper(
        { db: db as never, trackedPositions, strategy, entryStrategyShape: "spot" },
        exitA,
        paperPool,
      ),
    );

    expect(result.executed).toBe(true);
    expect(trackedPositions.size).toBe(1);
    const survivor = [...trackedPositions.values()][0]!;
    expect(survivor.positionId).toBe(posB!.positionId);
    expect(survivor.depositedUsd).toBe(800);
    expect(survivor.entryAmountXUsd).toBe(400);
    expect(survivor.entryAmountYUsd).toBe(400);

    // The soft-close and paper-exit markers target A's identity only.
    expect(calls.closed).toHaveLength(1);
    expect(calls.closed[0]!.id).toBe(posA!.positionId);
    expect(calls.paperExited).toEqual([posA!.positionId]);

    // Events are attributed per position: A has ENTER+EXIT, B has ENTER only.
    const eventsA = calls.events.filter((e) => e.positionId === posA!.positionId);
    const eventsB = calls.events.filter((e) => e.positionId === posB!.positionId);
    expect(eventsA.map((e) => e.event)).toEqual(["ENTER", "EXIT"]);
    expect(eventsB.map((e) => e.event)).toEqual(["ENTER"]);
  });

  it("REBALANCE reshapes only the targeted position", () => {
    const { db } = makePaperDb();
    const trackedPositions = new Map<string, PositionRecord>();
    const strategy = makePaperStrategy();

    for (const size of [1000, 800]) {
      Effect.runSync(
        executePaper(
          { db: db as never, trackedPositions, strategy, entryStrategyShape: "spot" },
          enterDecision(size),
          paperPool,
        ),
      );
    }
    const [posA, posB] = [...trackedPositions.values()];

    const rebalance: AgentDecision = {
      action: "REBALANCE",
      poolAddress: POOL,
      positionId: posA!.positionId,
      confidence: 0.8,
      reasoning: "test",
      rebalanceParams: { newLowerBinId: 4950, newUpperBinId: 5050, slippageBps: 50 },
    };
    Effect.runSync(
      executePaper(
        { db: db as never, trackedPositions, strategy, entryStrategyShape: "spot" },
        rebalance,
        paperPool,
      ),
    );

    const afterA = trackedPositions.get(posA!.positionId)!;
    const afterB = trackedPositions.get(posB!.positionId)!;
    expect(afterA.lowerBinId).toBe(4950);
    expect(afterA.upperBinId).toBe(5050);
    expect(afterB.lowerBinId).toBe(4980);
    expect(afterB.upperBinId).toBe(5020);
  });
});

// ─── Live execution: positions keyed by on-chain pubkey ──────────────────────

function makeLiveAdapter() {
  const pubkeys = ["live-pos-A", "live-pos-B"];
  const calls = { exits: [] as Array<{ pool: string; pubkey: string }> };
  const adapter: Partial<AdapterApi> = {
    hasWallet: () => true,
    getWalletAddress: () => "mock-wallet",
    getWalletBalanceUsd: () => Effect.succeed(10_000),
    getNativeSolBalance: () => Effect.succeed(1_000_000_000n),
    swapUSDCForSOL: () => Effect.void,
    enterPosition: (_pool, _lower, _upper, sizeUsd) =>
      Effect.succeed({
        positionPubKey: pubkeys.shift() ?? `live-pos-${randomUUID()}`,
        txSignature: "mock-tx",
        depositMode: "two-sided" as const,
        amountXUsd: sizeUsd / 2,
        amountYUsd: sizeUsd / 2,
      }),
    exitPosition: (pool, pubkey) =>
      Effect.sync(() => {
        calls.exits.push({ pool, pubkey });
        return { txSignature: "mock-tx" };
      }),
  };
  return { adapter: adapter as AdapterApi, calls };
}

describe("executeLive — two positions on one pool", () => {
  it("keys positions by their on-chain position pubkey and exits them independently", () => {
    const { adapter, calls } = makeLiveAdapter();
    const { db, calls: dbCalls } = makePaperDb();
    const trackedPositions = new Map<string, PositionRecord>();
    const revenueConfigSvc = {
      getConfig: () =>
        Effect.succeed({
          tier: "free",
          platformFeeRate: 0,
          revenueShareEnabled: false,
          revenueShareOperatorPct: 0,
          feeWalletAddress: "",
        }),
      refreshConfig: () => Effect.void,
    };

    const deps = {
      adapter,
      strategy: makePaperStrategy(),
      db: db as never,
      revenueConfigSvc: revenueConfigSvc as never,
      trackedPositions,
      entryPrep: { prepareEntryTokens: () => Effect.void } as never,
      solPriceUsd: 150,
      entryStrategyShape: "spot" as const,
    };

    Effect.runSync(executeLive(deps, enterDecision(1000), paperPool));
    Effect.runSync(executeLive(deps, enterDecision(800), paperPool));

    expect(trackedPositions.size).toBe(2);
    expect(trackedPositions.has("live-pos-A")).toBe(true);
    expect(trackedPositions.has("live-pos-B")).toBe(true);

    const exitA: AgentDecision = {
      action: "EXIT",
      poolAddress: POOL,
      positionId: "live-pos-A",
      confidence: 0.85,
      reasoning: "capital protection",
    };
    const result = Effect.runSync(executeLive(deps, exitA, paperPool));

    expect(result.executed).toBe(true);
    // The on-chain exit used A's pubkey — never B's.
    expect(calls.exits).toEqual([{ pool: POOL, pubkey: "live-pos-A" }]);
    expect(trackedPositions.size).toBe(1);
    expect(trackedPositions.has("live-pos-B")).toBe(true);
    expect(trackedPositions.get("live-pos-B")?.depositedUsd).toBe(800);
    expect(dbCalls.closed).toHaveLength(1);
    expect(dbCalls.closed[0]!.id).toBe("live-pos-A");
  });
});

// ─── Reconcile: match on-chain positions to rows by pubkey ───────────────────

function makeReconcileAdapter(overrides: Partial<AdapterApi>): AdapterApi {
  return {
    hasWallet: () => true,
    getWalletAddress: () => "Wallet111",
    getWalletBalanceUsd: () => Effect.succeed(0),
    getNativeSolBalance: () => Effect.succeed(0n),
    getTokenBalance: () => Effect.succeed(0n),
    getTokenPrices: () => Effect.succeed({}),
    getTokenDecimals: () => Effect.succeed(6),
    getMintAuthorities: () => Effect.succeed({ mintAuthority: null, freezeAuthority: null }),
    quoteSwapUSDCForToken: () => Effect.fail("not implemented"),
    swapUSDCForToken: () => Effect.fail("not implemented"),
    getPoolState: () => Effect.fail("not implemented"),
    getBinArray: () => Effect.fail("not implemented"),
    getPositions: () => Effect.succeed([]),
    getAllWalletPositions: () => Effect.succeed([]),
    simulateRebalance: () => Effect.fail("not implemented"),
    enterPosition: () => Effect.fail("not implemented"),
    exitPosition: () => Effect.fail("not implemented"),
    rebalancePosition: () => Effect.fail("not implemented"),
    claimFees: () => Effect.fail("not implemented"),
    claimRewards: () =>
      Effect.succeed({ skipped: true, skipReason: "none", txSignatures: [], rewards: [] }),
    discoverPools: () => Effect.succeed([]),
    reportFeeCollection: () => Effect.void,
    swapUSDCForSOL: () => Effect.void,
    ...overrides,
  } as AdapterApi;
}

const noopMemory = {
  initialize: () => Effect.void,
  upsert: () => Effect.void,
  getRelevantContext: () => Effect.succeed([]),
  pruneExpired: () => Effect.succeed(0),
  recordOutcome: () => Effect.void,
};

describe("reconcilePositions — multiple positions per pool", () => {
  it("keeps both positions when both are still on-chain", () => {
    const layer = DbLive(":memory:");
    const tracked = new Map<string, PositionRecord>();
    const posA = makePos({ positionId: "pk-A", positionPubKey: "pk-A" });
    const posB = makePos({ positionId: "pk-B", positionPubKey: "pk-B", depositedUsd: 800 });
    tracked.set(posA.positionId, posA);
    tracked.set(posB.positionId, posB);

    const result = runEffect(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(posA);
        yield* db.savePosition(posB);
        const adapter = makeReconcileAdapter({
          getAllWalletPositions: () =>
            Effect.succeed([
              { poolAddress: POOL, positionPubKey: "pk-A", lowerBinId: 4980, upperBinId: 5020 },
              { poolAddress: POOL, positionPubKey: "pk-B", lowerBinId: 4980, upperBinId: 5020 },
            ]),
        });
        yield* reconcilePositions(adapter, db, noopMemory, tracked, [POOL]);
        return yield* db.getAllPositions();
      }),
      layer,
    );
    expect(tracked.size).toBe(2);
    expect(result).toHaveLength(2);
  });

  it("removes only the externally-closed position and keeps its sibling", () => {
    const layer = DbLive(":memory:");
    const tracked = new Map<string, PositionRecord>();
    const posA = makePos({ positionId: "pk-A", positionPubKey: "pk-A" });
    const posB = makePos({ positionId: "pk-B", positionPubKey: "pk-B", depositedUsd: 800 });
    tracked.set(posA.positionId, posA);
    tracked.set(posB.positionId, posB);

    const remaining = runEffect(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(posA);
        yield* db.savePosition(posB);
        const adapter = makeReconcileAdapter({
          getAllWalletPositions: () =>
            Effect.succeed([
              // pk-A vanished (closed via the Meteora UI); pk-B is still there.
              { poolAddress: POOL, positionPubKey: "pk-B", lowerBinId: 4980, upperBinId: 5020 },
            ]),
        });
        yield* reconcilePositions(adapter, db, noopMemory, tracked, [POOL]);
        return yield* db.getAllPositions();
      }),
      layer,
    );
    expect(tracked.has("pk-A")).toBe(false);
    expect(tracked.has("pk-B")).toBe(true);
    expect(remaining.map((p) => p.positionId)).toEqual(["pk-B"]);
  });

  it("syncs a drifted range by matching pubkey, leaving the sibling's range alone", () => {
    const layer = DbLive(":memory:");
    const tracked = new Map<string, PositionRecord>();
    const posA = makePos({ positionId: "pk-A", positionPubKey: "pk-A" });
    const posB = makePos({ positionId: "pk-B", positionPubKey: "pk-B", depositedUsd: 800 });
    tracked.set(posA.positionId, posA);
    tracked.set(posB.positionId, posB);

    runEffect(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(posA);
        yield* db.savePosition(posB);
        const adapter = makeReconcileAdapter({
          getAllWalletPositions: () =>
            Effect.succeed([
              { poolAddress: POOL, positionPubKey: "pk-A", lowerBinId: 4990, upperBinId: 5030 },
              { poolAddress: POOL, positionPubKey: "pk-B", lowerBinId: 4980, upperBinId: 5020 },
            ]),
        });
        yield* reconcilePositions(adapter, db, noopMemory, tracked, [POOL]);
        return yield* db.getAllPositions();
      }),
      layer,
    );
    expect(tracked.get("pk-A")?.lowerBinId).toBe(4990);
    expect(tracked.get("pk-A")?.upperBinId).toBe(5030);
    expect(tracked.get("pk-B")?.lowerBinId).toBe(4980);
    expect(tracked.get("pk-B")?.upperBinId).toBe(5020);
  });

  it("discovers a second on-chain position on an already-tracked pool", () => {
    const layer = DbLive(":memory:");
    const tracked = new Map<string, PositionRecord>();
    const posA = makePos({ positionId: "pk-A", positionPubKey: "pk-A" });
    tracked.set(posA.positionId, posA);

    const poolState: PoolState = {
      address: POOL,
      tokenX: "SOL",
      tokenY: "USDC",
      tokenXSymbol: "SOL",
      tokenYSymbol: "USDC",
      tvlUsd: 100_000,
      volume24hUsd: 30_000,
      fees24hUsd: 300,
      apr: 60,
      activeBinId: 5000,
      binStep: 10,
      currentPrice: 150,
      timestamp: Date.now(),
    };

    const all = runEffect(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(posA);
        const adapter = makeReconcileAdapter({
          getAllWalletPositions: () =>
            Effect.succeed([
              { poolAddress: POOL, positionPubKey: "pk-A", lowerBinId: 4980, upperBinId: 5020 },
              { poolAddress: POOL, positionPubKey: "pk-C", lowerBinId: 4900, upperBinId: 5100 },
            ]),
          getPoolState: () => Effect.succeed(poolState),
        });
        yield* reconcilePositions(adapter, db, noopMemory, tracked, [POOL]);
        return yield* db.getAllPositions();
      }),
      layer,
    );
    expect(tracked.size).toBe(2);
    expect(tracked.has("pk-C")).toBe(true);
    expect(tracked.get("pk-C")?.lowerBinId).toBe(4900);
    expect(all).toHaveLength(2);
  });
});

// ─── Per-position alert cooldowns ────────────────────────────────────────────

describe("per-position alert cooldowns", () => {
  let tmpDir: string;
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "prism-multi-pos-alert-"));
    savedConfigDir = process.env.PRISM_CONFIG_DIR;
    process.env.PRISM_CONFIG_DIR = tmpDir;
    writeFileSync(join(tmpDir, "credentials.json"), JSON.stringify({ apiKey: "sk-test" }), {
      mode: 0o600,
    });
  });
  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.PRISM_CONFIG_DIR;
    else process.env.PRISM_CONFIG_DIR = savedConfigDir;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("OOR alerts for two positions on one pool do not share a cooldown", async () => {
    const posts: Array<Record<string, unknown>> = [];
    const restore = mockFetch((_url: unknown, init: { body?: string } = {}) => {
      posts.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    try {
      const dbLayer = DbLive(join(tmpDir, "alerts.db"));
      const configLayer = Layer.succeed(
        ConfigService,
        defaultAppConfig({ alertsEnabled: true, alertCooldownMinutes: 120 }),
      );
      const layer = Layer.provide(AlertLive, Layer.merge(dbLayer, configLayer));

      await Effect.runPromise(
        Effect.gen(function* () {
          const alerts = yield* AlertService;
          const base = {
            type: "position_out_of_range" as const,
            severity: "critical" as const,
            poolAddress: POOL,
          };
          // Position A fires → delivered.
          yield* alerts.sendAlert({ ...base, positionId: "pos-A", message: "A out of range" });
          // Position A again → throttled by cooldown.
          yield* alerts.sendAlert({ ...base, positionId: "pos-A", message: "A still out" });
          // Position B on the SAME pool → must NOT be suppressed by A's cooldown.
          yield* alerts.sendAlert({ ...base, positionId: "pos-B", message: "B out of range" });
        }).pipe(Effect.provide(layer)),
      );
      expect(posts).toHaveLength(2);
      expect(posts[0]!.message).toBe("A out of range");
      expect(posts[1]!.message).toBe("B out of range");
    } finally {
      restore();
    }
  });
});

// ─── CLI: multiple positions per pool in outputs ─────────────────────────────

describe("CLI portfolio — multiple positions per pool", () => {
  it("lists each position individually with its identity and aggregates totals", () => {
    const positions = [
      makePos({ positionId: "pos-A", depositedUsd: 1000, currentValueUsd: 1100 }),
      makePos({ positionId: "pos-B", depositedUsd: 800, currentValueUsd: 750 }),
    ];
    const summary = computeSummary(positions);
    expect(summary.positionCount).toBe(2);
    expect(summary.totalDepositedUsd).toBe(1800);
    expect(summary.totalCurrentValueUsd).toBe(1850);

    const json = toJsonOutput(positions);
    expect(json.positions).toHaveLength(2);
    expect(json.positions.map((p) => p.positionId).sort()).toEqual(["pos-A", "pos-B"]);
    expect(json.positions.every((p) => p.poolAddress === POOL)).toBe(true);
  });

  it("formatPosition labels the position identity", () => {
    const text = formatPosition(makePos({ positionId: "paper-pool-abc123" }), 150);
    expect(text).toContain("paper-pool-abc123");
  });
});

// ─── Full program: two-position lifecycle on one pool ────────────────────────

type MintAuthorities = { mintAuthority: string | null; freezeAuthority: string | null };
const NO_AUTHORITIES: MintAuthorities = { mintAuthority: null, freezeAuthority: null };

function makeDatapiStats(overrides: Partial<MeteoraPoolStats> = {}): MeteoraPoolStats {
  return {
    address: POOL,
    name: "SOL-USDC",
    tvlUsd: 200_000,
    volume24hUsd: 40_000,
    fees24hUsd: 400,
    apr: 20,
    apy: 20,
    currentPrice: 150,
    feeTvlRatio24h: null,
    feeTvlRatio12h: null,
    feeTvlRatio1h: null,
    dynamicFeePct: null,
    baseFeePct: null,
    hasFarm: null,
    farmApr: null,
    farmApy: null,
    isBlacklisted: null,
    tokenXFreezeAuthorityDisabled: null,
    tokenYFreezeAuthorityDisabled: null,
    tokenXVerified: null,
    tokenYVerified: null,
    ...overrides,
  };
}

function makeProgramAdapter(
  pools: Record<string, PoolState>,
  overrides: Partial<AdapterApi> = {},
): AdapterApi {
  return {
    hasWallet: () => false,
    getWalletAddress: () => null,
    getWalletBalanceUsd: () => Effect.succeed(10_000),
    getNativeSolBalance: () => Effect.succeed(0n),
    getPoolState: (addr: string) => {
      const pool = pools[addr];
      return pool ? Effect.succeed(pool) : Effect.fail(new Error(`unknown pool ${addr}`));
    },
    getBinArray: () => Effect.succeed(makeBinArray()),
    getPositions: () => Effect.succeed([]),
    getAllWalletPositions: () => Effect.succeed([]),
    simulateRebalance: () =>
      Effect.succeed({
        estimatedFeesUsd: 0,
        estimatedCostUsd: 0,
        netBenefitUsd: 0,
        source: "pool-heuristic" as const,
      }),
    enterPosition: (_pool: string, _l: number, _u: number, sizeUsd: number) =>
      Effect.succeed({
        positionPubKey: "mock-pos",
        txSignature: "mock-tx",
        depositMode: "two-sided" as const,
        amountXUsd: sizeUsd / 2,
        amountYUsd: sizeUsd / 2,
      }),
    exitPosition: () => Effect.succeed({ txSignature: "mock-tx" }),
    rebalancePosition: () =>
      Effect.succeed({ positionPubKey: "mock-pos", txSignatures: ["mock-tx"] }),
    claimFees: () =>
      Effect.succeed({
        txSignature: "mock-tx",
        feeX: 0,
        feeY: 0,
        platformFeeX: 0,
        platformFeeY: 0,
        netFeeX: 0,
        netFeeY: 0,
      }),
    claimRewards: () =>
      Effect.succeed({ skipped: true, skipReason: "none", txSignatures: [], rewards: [] }),
    discoverPools: () => Effect.succeed([]),
    reportFeeCollection: () => Effect.void,
    swapUSDCForSOL: () => Effect.void,
    getTokenBalance: () => Effect.succeed(0n),
    getTokenPrices: () => Effect.succeed({}),
    getTokenDecimals: () => Effect.succeed(9),
    quoteSwapUSDCForToken: () => Effect.succeed({}),
    swapUSDCForToken: () => Effect.succeed("mock-swap-tx"),
    getMintAuthorities: () => Effect.succeed(NO_AUTHORITIES),
    ...overrides,
  } as AdapterApi;
}

function makeProgramLayer(opts: {
  adapter: AdapterApi;
  datapi?: MeteoraDatapiApi;
  configOverrides?: Partial<AppConfig>;
}) {
  const config = defaultAppConfig({
    scanIntervalMs: 1_000,
    paperTrading: true,
    agentMcpEnabled: false,
    agentHttpPort: 0,
    autoUpdate: false,
    ...opts.configOverrides,
  });
  const dbLayer = DbLive(":memory:");
  return Layer.mergeAll(
    Layer.succeed(ConfigService, config),
    Layer.succeed(AdapterService, opts.adapter),
    StrategyLive,
    Layer.provide(MemoryLive, dbLayer),
    RiskLive({
      confidenceThreshold: config.confidenceThreshold,
      maxRebalanceRangeBins: config.maxRebalanceRangeBins,
      stopLossPct: config.stopLossPct,
      maxPerPoolAllocationPct: config.maxPerPoolAllocationPct,
      maxPositionsPerPool: config.maxPositionsPerPool,
    }),
    Layer.succeed(BlacklistService, {
      isDeployerBlacklisted: () => false,
      isTokenBlacklisted: () => false,
      checkPool: () => Effect.void,
    }),
    Layer.provide(AuditLive, dbLayer),
    Layer.succeed(ScreenerService, { screenPools: () => Effect.succeed([]) }),
    dbLayer,
    Layer.succeed(RevenueService, {
      calculateTier: () => "free",
      calculatePlatformFee: () => ({ platformFeeUsd: 0, netFeeX: 0, netFeeY: 0 }),
      calculateCreditDiscount: () => 0,
    }),
    Layer.succeed(RevenueConfigService, {
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
    }),
    Layer.succeed(ReferralService, {
      generateCode: () => Effect.succeed("code"),
      validateCode: () => Effect.succeed({ valid: false }),
      applyReferral: () => Effect.void,
      getReferralCount: () => Effect.succeed(0),
    }),
    Layer.succeed(AgentService, AgentNoOp),
    AgentStateMutable({ maxPendingProposals: 50 }).layer,
    Layer.succeed(McpServerService, { start: () => Effect.void, stop: () => Effect.void }),
    Layer.succeed(HttpStatusServerService, { start: () => Effect.void, stop: () => Effect.void }),
    Layer.succeed(EntryPrepService, { prepareEntryTokens: () => Effect.void }),
    Layer.succeed(MeteoraDatapiService, opts.datapi ?? { getPoolData: () => Effect.succeed(null) }),
    Layer.succeed(AlertService, {
      sendAlert: () => Effect.void,
      recordFeeClaim: () => Effect.void,
    }),
  );
}

describe("program — multiple positions per pool", () => {
  it("enters a second position on a strong pool, then stops at the per-pool cap", async () => {
    const layer = makeProgramLayer({
      adapter: makeProgramAdapter({ [POOL]: makePool({ address: POOL }) }),
      datapi: { getPoolData: () => Effect.succeed(makeDatapiStats()) },
      configOverrides: {
        watchlistPools: [POOL],
        maxPositionsPerPool: 2,
        maxOpenPositions: 5,
      },
    });

    const test = Effect.gen(function* () {
      // ~3 scan cycles: ENTER A (cycle 1), ENTER B (cycle 2), capped (cycle 3).
      yield* Effect.raceFirst(program, Effect.sleep(2_500));
      const db = yield* DbService;
      const audit = yield* AuditService;
      const positions = yield* db.getAllPositions();
      const decisions = yield* audit.getRecentDecisions(200);
      const events = yield* db.getPositionEvents(POOL);
      return { positions, decisions, events };
    });
    const { positions, decisions, events } = await Effect.runPromise(
      Effect.provide(test, layer) as Effect.Effect<
        {
          positions: ReadonlyArray<PositionRecord>;
          decisions: ReadonlyArray<{ action: string; executed: boolean }>;
          events: ReadonlyArray<{ event: string; positionId: string | null }>;
        },
        unknown,
        never
      >,
    );

    // Two positions on the same pool, keyed by distinct synthetic ids.
    expect(positions).toHaveLength(2);
    expect(positions.every((p) => p.poolAddress === POOL)).toBe(true);
    expect(new Set(positions.map((p) => p.positionId)).size).toBe(2);

    // Exactly two ENTERs executed — the cap blocked any third.
    const enters = decisions.filter((d) => d.action === "ENTER" && d.executed);
    expect(enters).toHaveLength(2);

    // Each position's ENTER event is attributed to its own identity.
    const enterEvents = events.filter((e) => e.event === "ENTER");
    expect(enterEvents).toHaveLength(2);
    const eventIds = new Set(enterEvents.map((e) => e.positionId));
    for (const pos of positions) {
      expect(eventIds).toContain(pos.positionId);
    }
  }, 15_000);

  it("honors maxPositionsPerPool=1 (legacy single-position behavior)", async () => {
    const layer = makeProgramLayer({
      adapter: makeProgramAdapter({ [POOL]: makePool({ address: POOL }) }),
      datapi: { getPoolData: () => Effect.succeed(makeDatapiStats()) },
      configOverrides: {
        watchlistPools: [POOL],
        maxPositionsPerPool: 1,
        maxOpenPositions: 5,
      },
    });

    const test = Effect.gen(function* () {
      yield* Effect.raceFirst(program, Effect.sleep(2_500));
      const db = yield* DbService;
      const audit = yield* AuditService;
      const positions = yield* db.getAllPositions();
      const decisions = yield* audit.getRecentDecisions(200);
      return { positions, decisions };
    });
    const { positions, decisions } = await Effect.runPromise(
      Effect.provide(test, layer) as Effect.Effect<
        {
          positions: ReadonlyArray<PositionRecord>;
          decisions: ReadonlyArray<{ action: string; executed: boolean }>;
        },
        unknown,
        never
      >,
    );

    expect(positions).toHaveLength(1);
    const enters = decisions.filter((d) => d.action === "ENTER" && d.executed);
    expect(enters).toHaveLength(1);
  }, 15_000);

  it("runs an independent lifecycle per position: OOR + trailing-stop EXIT on A leaves B intact", async () => {
    const seededA = makePos({
      positionId: "seeded-A",
      lowerBinId: 4900,
      upperBinId: 4910,
      depositedUsd: 1000,
      currentValueUsd: 1000,
    });
    const seededB = makePos({
      positionId: "seeded-B",
      lowerBinId: 4980,
      upperBinId: 5020,
      depositedUsd: 800,
      currentValueUsd: 800,
      entryPriceUsd: 150,
      entryAmountXUsd: 400,
      entryAmountYUsd: 400,
    });

    const layer = makeProgramLayer({
      adapter: makeProgramAdapter({ [POOL]: makePool({ address: POOL }) }),
      datapi: { getPoolData: () => Effect.succeed(makeDatapiStats()) },
      configOverrides: {
        watchlistPools: [POOL],
        maxPositionsPerPool: 2,
        maxOpenPositions: 5,
        // Exactly one scan cycle: the long interval never fires inside the
        // test window, so no replacement ENTER can happen after A exits.
        scanIntervalMs: 600_000,
      },
    });

    const test = Effect.gen(function* () {
      const db = yield* DbService;
      yield* db.savePosition(seededA);
      yield* db.savePosition(seededB);
      yield* Effect.raceFirst(program, Effect.sleep(1_500));
      const active = yield* db.getAllPositions();
      const closed = yield* db.getClosedPositions();
      const events = yield* db.getPositionEvents(POOL);
      const audit = yield* AuditService;
      const decisions = yield* audit.getRecentDecisions(200);
      return { active, closed, events, decisions };
    });
    const { active, closed, events, decisions } = await Effect.runPromise(
      Effect.provide(test, layer) as Effect.Effect<
        {
          active: ReadonlyArray<PositionRecord>;
          closed: ReadonlyArray<PositionRecord>;
          events: ReadonlyArray<{
            event: string;
            positionId: string | null;
            metadata: string | null;
          }>;
          decisions: ReadonlyArray<{ action: string; executed: boolean }>;
        },
        unknown,
        never
      >,
    );

    // A was far out of range (range [4900,4910] vs active bin 5000): its value
    // estimate collapsed past the trailing stop and it exited. B is in range
    // and untouched.
    expect(active.map((p) => p.positionId)).toEqual(["seeded-B"]);
    expect(closed.map((p) => p.positionId)).toEqual(["seeded-A"]);

    const closedA = closed[0]!;
    expect(closedA.closedAt).not.toBeNull();
    // Realized PnL = final value (500 after the 50% IL-drift estimate) − basis.
    // A4 paper fee accrual is active for this pool (fees24h 300 > 0) but A is
    // OUT of range (inRange = 0) so it accrued nothing — this −500 realized pin
    // is unaffected by the accrual.
    expect(closedA.realizedPnlUsd).toBeCloseTo(-500, 0);
    // A's OOR cycles accumulated independently; B never left range.
    expect(closedA.oorCycleCount).toBeGreaterThanOrEqual(1);
    expect(active[0]!.oorCycleCount).toBe(0);

    // B's entry accounting survived A's exit byte-for-byte.
    expect(active[0]!.depositedUsd).toBe(800);
    expect(active[0]!.entryPriceUsd).toBe(150);
    expect(active[0]!.entryAmountXUsd).toBe(400);
    expect(active[0]!.entryAmountYUsd).toBe(400);

    // The EXIT event targets A's identity. B is in range with fees24h 300 > 0,
    // so the A4 paper notional-fee accrual booked exactly one CLAIM (kind
    // paper_accrual); B has NO lifecycle events (no ENTER/REBALANCE/EXIT).
    const exitEvents = events.filter((e) => e.event === "EXIT");
    expect(exitEvents).toHaveLength(1);
    expect(exitEvents[0]!.positionId).toBe("seeded-A");
    const bEvents = events.filter((e) => e.positionId === "seeded-B");
    expect(bEvents).toHaveLength(1);
    expect(bEvents[0]!.event).toBe("CLAIM");
    expect(JSON.parse(bEvents[0]!.metadata ?? "{}").kind).toBe("paper_accrual");

    const executedExits = decisions.filter((d) => d.action === "EXIT" && d.executed);
    expect(executedExits.length).toBeGreaterThanOrEqual(1);
  }, 15_000);
});

describe("A4 paper fee accrual requires datapi-MEASURED fees", () => {
  // When both real sources are down, getPoolState ships a POSITIVE modeled
  // fees24hUsd under statsSource "heuristic" — every A4 numeric guard (null /
  // <= 0 / non-finite / in-range / TVL) still passes. Accrual must be gated on
  // statsSource === "datapi" (the ONLY source of measured per-pool fees):
  // geckoterminal fees are a binStep base-rate MODEL on real volume
  // (pool_fee_percentage is null for every CL pool) and heuristic fees are
  // fabricated — neither may book paper CLAIM income; only datapi accrues.
  const POS_ID = "paper-accr";

  async function runAccrualCycle(opts: {
    statsSource: "datapi" | "geckoterminal" | "heuristic";
    datapi?: MeteoraDatapiApi;
  }): Promise<{ accruals: ReadonlyArray<{ feesUsd: number | null }>; accruedUsd: number }> {
    const layer = makeProgramLayer({
      // Positive modeled fees + in-range paper position: the numeric A4 guards
      // all pass, so ONLY the statsSource gate decides whether accrual happens.
      adapter: makeProgramAdapter({
        [POOL]: makePool({ address: POOL, fees24hUsd: 400, statsSource: opts.statsSource }),
      }),
      ...(opts.datapi !== undefined ? { datapi: opts.datapi } : {}),
      configOverrides: {
        watchlistPools: [POOL],
        paperTrading: true,
        scanIntervalMs: 600_000,
      },
    });
    const test = Effect.gen(function* () {
      const db = yield* DbService;
      yield* db.savePosition(makePos({ positionId: POS_ID, lowerBinId: 4980, upperBinId: 5020 }));
      yield* Effect.raceFirst(program, Effect.sleep(1_500));
      const events = yield* db.getPositionEvents(POOL);
      const pos = yield* db.getPosition(POS_ID);
      const accruals = events
        .filter(
          (e) =>
            e.positionId === POS_ID &&
            e.event === "CLAIM" &&
            JSON.parse(e.metadata ?? "{}").kind === "paper_accrual",
        )
        .map((e) => ({ feesUsd: e.feesUsd }));
      return { accruals, accruedUsd: pos?.cumulativeFeesClaimedUsd ?? 0 };
    });
    return Effect.runPromise(
      Effect.provide(test, layer) as Effect.Effect<
        { accruals: ReadonlyArray<{ feesUsd: number | null }>; accruedUsd: number },
        unknown,
        never
      >,
    );
  }

  it("a heuristic pool with a positive modeled fees24hUsd accrues NOTHING", async () => {
    const { accruals, accruedUsd } = await runAccrualCycle({ statsSource: "heuristic" });
    expect(
      accruals,
      "heuristic stats must never produce fabricated paper CLAIM income",
    ).toHaveLength(0);
    expect(accruedUsd).toBe(0);
  }, 15_000);

  it("the same pool with Data API stats accrues exactly one notional fee (control)", async () => {
    // Enrichment flips statsSource to "datapi" over the heuristic base pool,
    // proving the gate keys off the REAL fee source, not the modeled one.
    const { accruals, accruedUsd } = await runAccrualCycle({
      statsSource: "heuristic",
      datapi: { getPoolData: () => Effect.succeed(makeDatapiStats()) },
    });
    expect(accruals, "datapi enrichment must enable the notional accrual").toHaveLength(1);
    expect(accruedUsd).toBeGreaterThan(0);
  }, 15_000);

  it("the same pool with geckoterminal stats accrues NOTHING (fees are modeled, not measured)", async () => {
    // GeckoTerminal fees are a binStep base-rate MODEL on real volume
    // (pool_fee_percentage is null for every CL pool — only the Data API
    // measures real fees), so a geckoterminal-sourced pool must NOT accrue.
    // Proves the gate keys off datapi-measured fees specifically, not the
    // broader measured-volume sources.
    const { accruals, accruedUsd } = await runAccrualCycle({ statsSource: "geckoterminal" });
    expect(accruals, "modeled gecko fees must not produce paper CLAIM income").toHaveLength(0);
    expect(accruedUsd).toBe(0);
  }, 15_000);
});
