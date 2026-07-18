import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { StrategyLive } from "../engine/strategy-service.js";
import { program } from "../engine/program.js";
import { DbLive } from "../engine/db-service.js";
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
  type MemoryApi,
  type MeteoraDatapiApi,
  type MeteoraPoolStats,
} from "../engine/services.js";
import type { PoolSnapshot } from "../engine/types.js";
import { defaultAppConfig, makePool, makeBinArray, makePosition } from "./helpers.js";
import { stringifySafe } from "../engine/bigint-json.js";

// ─── Wave 2: phantom EXITs, portfolio math, HOLD spam, snapshot retention ────

type MintAuthorities = { mintAuthority: string | null; freezeAuthority: string | null };
const NO_AUTHORITIES: MintAuthorities = { mintAuthority: null, freezeAuthority: null };

function makeDatapiStats(overrides: Partial<MeteoraPoolStats> = {}): MeteoraPoolStats {
  return {
    address: "unset",
    name: "TEST",
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
    ...overrides,
  };
}

function makeAdapter(
  pools: Record<string, ReturnType<typeof makePool>>,
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
    enterPosition: (
      _poolAddress: string,
      _lowerBinId: number,
      _upperBinId: number,
      positionSizeUsd: number,
    ) =>
      Effect.succeed({
        positionPubKey: "mock-pos",
        txSignature: "mock-tx",
        depositMode: "two-sided" as const,
        amountXUsd: positionSizeUsd / 2,
        amountYUsd: positionSizeUsd / 2,
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
    getMintAuthorities: () => Effect.succeed(NO_AUTHORITIES),
    ...overrides,
  } as AdapterApi;
}

interface RecordedMemory {
  category: string;
  content: string;
  poolAddress?: string | undefined;
}

function makeRecordingMemory(record: RecordedMemory[]): MemoryApi {
  return {
    initialize: () => Effect.void,
    upsert: (entry) =>
      Effect.sync(() => {
        record.push({
          category: entry.category,
          content: entry.content,
          poolAddress: entry.poolAddress,
        });
      }),
    getRelevantContext: () => Effect.succeed([]),
    pruneExpired: () => Effect.succeed(0),
    recordOutcome: () => Effect.void,
  };
}

function makeTestLayer(opts: {
  adapter: AdapterApi;
  memoryRecorded?: RecordedMemory[];
  datapi?: MeteoraDatapiApi;
  configOverrides?: Partial<AppConfig>;
}) {
  const config = defaultAppConfig({
    scanIntervalMs: 3_600_000,
    paperTrading: true,
    agentMcpEnabled: false,
    agentHttpPort: 0,
    ...opts.configOverrides,
  });
  const dbLayer = DbLive(":memory:");
  return Layer.mergeAll(
    Layer.succeed(ConfigService, config),
    Layer.succeed(AdapterService, opts.adapter),
    StrategyLive,
    opts.memoryRecorded
      ? Layer.succeed(MemoryService, makeRecordingMemory(opts.memoryRecorded))
      : Layer.provide(MemoryLive, dbLayer),
    RiskLive({
      confidenceThreshold: 0.65,
      maxRebalanceRangeBins: 50,
      stopLossPct: 0.15,
      maxPerPoolAllocationPct: 0.4,
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

type DecisionRow = {
  poolAddress: string;
  action: string;
  reasoning: string;
  executed: boolean;
  riskResult: { approved: boolean; reason: string };
};

async function runCycles(
  layer: ReturnType<typeof makeTestLayer>,
  sleepMs = 2_000,
): Promise<ReadonlyArray<DecisionRow>> {
  const test = Effect.gen(function* () {
    yield* Effect.raceFirst(program, Effect.sleep(sleepMs));
    const audit = yield* AuditService;
    return yield* audit.getRecentDecisions(200);
  });
  return Effect.runPromise(
    Effect.provide(test, layer) as Effect.Effect<ReadonlyArray<DecisionRow>, unknown, never>,
  );
}

describe("phantom EXIT gating (Wave 2)", () => {
  const POOL = "PoolPhantomTvl111111111111111111111111111111";

  function previousSnapshot(): PoolSnapshot {
    return {
      poolAddress: POOL,
      timestamp: Date.now() - 600_000,
      activeBinId: 5000,
      tvlUsd: 100_000, // → -40% vs current 60k (threshold 30%)
      volume24hUsd: 30_000,
      fees24hUsd: 300,
      apr: 60,
      currentPrice: 150,
      binStep: 10,
      tokenXSymbol: "SOL",
      tokenYSymbol: "USDC",
      binArray: makeBinArray(),
    };
  }

  it("does NOT record an EXIT for a positionless pool whose TVL dropped", async () => {
    const layer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: makePool({ address: POOL, tvlUsd: 60_000 }) }),
      configOverrides: { watchlistPools: [POOL], tvlDropExitPct: 0.3 },
    });

    const test = Effect.gen(function* () {
      const db = yield* DbService;
      yield* db.saveSnapshot(previousSnapshot());
      yield* Effect.raceFirst(program, Effect.sleep(2_000));
      const audit = yield* AuditService;
      const decisions = yield* audit.getRecentDecisions(50);
      const evolutionCount = yield* db
        .getMetadata("threshold_evolution_count")
        .pipe(Effect.catchAll(() => Effect.succeed(null)));
      return { decisions, evolutionCount };
    });
    const { decisions, evolutionCount } = await Effect.runPromise(
      Effect.provide(test, layer) as Effect.Effect<
        { decisions: ReadonlyArray<DecisionRow>; evolutionCount: string | null },
        unknown,
        never
      >,
    );

    const exits = decisions.filter((d) => d.poolAddress === POOL && d.action === "EXIT");
    expect(
      exits,
      `phantom EXIT recorded for positionless pool: ${stringifySafe(exits)}`,
    ).toHaveLength(0);
    expect(evolutionCount === null || evolutionCount === "0").toBe(true);
  }, 15_000);

  it("DOES record an EXIT for a held pool whose TVL dropped (control)", async () => {
    const layer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: makePool({ address: POOL, tvlUsd: 60_000 }) }),
      configOverrides: { watchlistPools: [POOL], tvlDropExitPct: 0.3 },
    });

    const test = Effect.gen(function* () {
      const db = yield* DbService;
      yield* db.savePosition(
        makePosition({ poolAddress: POOL, depositedUsd: 1_000, currentValueUsd: 1_000 }),
      );
      yield* db.saveSnapshot(previousSnapshot());
      yield* Effect.raceFirst(program, Effect.sleep(2_000));
      const audit = yield* AuditService;
      return yield* audit.getRecentDecisions(50);
    });
    const decisions = await Effect.runPromise(
      Effect.provide(test, layer) as Effect.Effect<ReadonlyArray<DecisionRow>, unknown, never>,
    );

    const tvlExit = decisions.find(
      (d) => d.poolAddress === POOL && d.action === "EXIT" && d.reasoning.includes("TVL dropped"),
    );
    expect(tvlExit, "held pool with a TVL drop must still EXIT").toBeDefined();
  }, 15_000);

  it("does NOT set a pool cooldown for a low-yield phantom EXIT (no position)", async () => {
    const layer = makeTestLayer({
      // fees24hUsd 1 → fee/IL far below 0.5
      adapter: makeAdapter({
        [POOL]: makePool({ address: POOL, tvlUsd: 100_000, fees24hUsd: 1 }),
      }),
      configOverrides: { watchlistPools: [POOL] },
    });

    const test = Effect.gen(function* () {
      yield* Effect.raceFirst(program, Effect.sleep(2_000));
      const audit = yield* AuditService;
      const decisions = yield* audit.getRecentDecisions(50);
      const db = yield* DbService;
      const cooldown = yield* db
        .getPoolCooldown(POOL)
        .pipe(Effect.catchAll(() => Effect.succeed(null)));
      return { decisions, cooldown };
    });
    const { decisions, cooldown } = await Effect.runPromise(
      Effect.provide(test, layer) as Effect.Effect<
        { decisions: ReadonlyArray<DecisionRow>; cooldown: unknown },
        unknown,
        never
      >,
    );

    const exits = decisions.filter((d) => d.poolAddress === POOL && d.action === "EXIT");
    expect(
      exits,
      `phantom low-yield EXIT recorded for positionless pool: ${stringifySafe(exits)}`,
    ).toHaveLength(0);
    expect(cooldown, `phantom EXIT set a pool cooldown: ${stringifySafe(cooldown)}`).toBeNull();
  }, 15_000);
});

describe("portfolio value math (Wave 2)", () => {
  const POOL_HELD = "PoolHeld111111111111111111111111111111111";
  const POOL_NEW = "PoolNew1111111111111111111111111111111111";

  it("computes the ENTER drawdown gate against wallet + open positions", async () => {
    // Wallet: $100. Open position: deposited $950, now worth ~$902 (drifted 2
    // bins off center) → unrealized PnL ≈ -$47.50. Against a wallet-only
    // "portfolio" of $100 that is a 47% drawdown (ENTER blocked); against the
    // real portfolio of ~$1002 it is ~4.7% (ENTER allowed).
    const adapter = makeAdapter({
      [POOL_HELD]: makePool({ address: POOL_HELD, activeBinId: 5002, fees24hUsd: 100 }),
      [POOL_NEW]: makePool({ address: POOL_NEW }),
    });
    const datapi: MeteoraDatapiApi = {
      getPoolData: (addr: string) =>
        Effect.succeed(addr === POOL_NEW ? makeDatapiStats({ address: POOL_NEW }) : null),
    };
    const layer = makeTestLayer({
      adapter,
      datapi,
      configOverrides: {
        watchlistPools: [POOL_HELD, POOL_NEW],
        paperPortfolioUsd: 100,
      },
    });

    const test = Effect.gen(function* () {
      const db = yield* DbService;
      yield* db.savePosition(
        makePosition({
          poolAddress: POOL_HELD,
          depositedUsd: 950,
          currentValueUsd: 950,
          lowerBinId: 4980,
          upperBinId: 5020,
        }),
      );
      yield* Effect.raceFirst(program, Effect.sleep(2_000));
      const audit = yield* AuditService;
      return yield* audit.getRecentDecisions(50);
    });
    const decisions = await Effect.runPromise(
      Effect.provide(test, layer) as Effect.Effect<ReadonlyArray<DecisionRow>, unknown, never>,
    );

    const enter = decisions.find((d) => d.poolAddress === POOL_NEW && d.action === "ENTER");
    expect(
      enter,
      `expected an ENTER decision for the strong pool, got: ${stringifySafe(decisions.map((d) => `${d.poolAddress}:${d.action}:${d.riskResult.reason}`))}`,
    ).toBeDefined();
    expect(
      enter!.riskResult.approved,
      `ENTER wrongly rejected — drawdown gate must use wallet+positions, got: ${enter!.riskResult.reason}`,
    ).toBe(true);
  }, 15_000);
});

describe("HOLD decisions skip risk evaluation (Wave 2)", () => {
  const POOL = "PoolQuiet1111111111111111111111111111111111";

  it("produces no risk-rejection audit rows and no warning memories over multiple cycles", async () => {
    const recordedMemory: RecordedMemory[] = [];
    const layer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: makePool({ address: POOL }) }),
      memoryRecorded: recordedMemory,
      configOverrides: {
        watchlistPools: [POOL],
        scanIntervalMs: 300, // several cycles inside the 1.2s race window
      },
    });

    const decisions = await runCycles(layer, 1_200);
    const forPool = decisions.filter((d) => d.poolAddress === POOL);
    expect(forPool.length, "expected at least one decision for the quiet pool").toBeGreaterThan(0);

    const rejectedHolds = forPool.filter(
      (d) => d.action === "HOLD" && d.riskResult.approved === false,
    );
    expect(
      rejectedHolds,
      `HOLD decisions were risk-rejected: ${stringifySafe(rejectedHolds.map((d) => d.riskResult.reason))}`,
    ).toHaveLength(0);

    const warnings = recordedMemory.filter((m) => m.category === "warning");
    expect(
      warnings,
      `warning memories written for HOLD rejections: ${stringifySafe(warnings)}`,
    ).toHaveLength(0);
  }, 15_000);
});

describe("pool snapshot retention (Wave 2)", () => {
  const POOL = "PoolRetention11111111111111111111111111111";

  it("prunes snapshots older than the retention window and keeps recent ones", async () => {
    const now = Date.now();
    const layer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: makePool({ address: POOL }) }),
      configOverrides: { watchlistPools: [POOL] },
    });

    const test = Effect.gen(function* () {
      const db = yield* DbService;
      yield* db.saveSnapshot({
        poolAddress: POOL,
        timestamp: now - 30 * 86_400_000, // 30 days old — beyond the 14d default
        activeBinId: 5000,
        tvlUsd: 90_000,
        volume24hUsd: 30_000,
        fees24hUsd: 300,
        apr: 60,
        currentPrice: 150,
        binStep: 10,
        tokenXSymbol: "SOL",
        tokenYSymbol: "USDC",
        binArray: makeBinArray(),
      });
      yield* Effect.raceFirst(program, Effect.sleep(2_000));
      const oldRows = yield* db.getSnapshots(POOL, 0, now - 14 * 86_400_000);
      const recentRows = yield* db.getSnapshots(POOL, now - 14 * 86_400_000, now + 60_000);
      return { oldRows, recentRows };
    });
    const { oldRows, recentRows } = await Effect.runPromise(
      Effect.provide(test, layer) as Effect.Effect<
        { oldRows: ReadonlyArray<PoolSnapshot>; recentRows: ReadonlyArray<PoolSnapshot> },
        unknown,
        never
      >,
    );

    expect(oldRows, "30-day-old snapshot was not pruned").toHaveLength(0);
    expect(recentRows.length, "fresh per-cycle snapshot must be retained").toBeGreaterThan(0);
  }, 15_000);
});
