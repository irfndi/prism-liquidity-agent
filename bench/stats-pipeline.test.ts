import { describe, it, expect, vi, afterEach } from "vitest";
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
  type EngineAlert,
} from "../engine/services.js";
import type { PoolMetrics } from "../engine/types.js";
import { defaultAppConfig, makePool, makeBinArray, makePosition, mockFetch } from "./helpers.js";

// ─── Stats source pipeline: datapi > geckoterminal > heuristic ──────────────
// Fabricated (heuristic) stats must never pass a volume/fee gate. This file
// drives the FULL scan loop with both fetch layers mocked so each tier's
// propagation (statsSource + known flags + gate behaviour) is exercised end to
// end. The gecko client reads global fetch (program.ts passes no fetchImpl), so
// mockFetch controls it; the datapi client is mocked at the service level.

type MintAuthorities = { mintAuthority: string | null; freezeAuthority: string | null };
const NO_AUTHORITIES: MintAuthorities = { mintAuthority: null, freezeAuthority: null };

function makeAdapter(pools: Record<string, ReturnType<typeof makePool>>): AdapterApi {
  return {
    hasWallet: () => false,
    getWalletAddress: () => null,
    getWalletBalanceUsd: () => Effect.succeed(10_000),
    getNativeSolBalance: () => Effect.succeed(0n),
    getPoolState: (addr: string) => {
      const pool = pools[addr];
      if (!pool) return Effect.fail(new Error(`unknown pool ${addr}`));
      // Mirror the real adapter invariant: raw on-chain pool state is always
      // tagged "heuristic" until program.ts enriches it with a measured source.
      return Effect.succeed({ ...pool, statsSource: pool.statsSource ?? "heuristic" });
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
  } as AdapterApi;
}

function makeTestLayer(opts: {
  adapter: AdapterApi;
  datapi?: MeteoraDatapiApi;
  configOverrides?: Partial<AppConfig>;
  alertCapture?: EngineAlert[];
}) {
  const config = defaultAppConfig({
    scanIntervalMs: 3_600_000,
    paperTrading: true,
    agentMcpEnabled: false,
    agentHttpPort: 0,
    ...opts.configOverrides,
  });
  const dbLayer = DbLive(":memory:");
  const capture = opts.alertCapture;
  return Layer.mergeAll(
    Layer.succeed(ConfigService, config),
    Layer.succeed(AdapterService, opts.adapter),
    StrategyLive,
    Layer.provide(MemoryLive, dbLayer),
    RiskLive({
      confidenceThreshold: 0.65,
      maxRebalanceRangeBins: 50,
      stopLossPct: 0.15,
      maxPerPoolAllocationPct: 0.4,
      maxPositionsPerPool: 2,
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
      sendAlert: capture
        ? (alert) =>
            Effect.sync(() => {
              capture.push(alert);
            })
        : () => Effect.void,
      recordFeeClaim: () => Effect.void,
    }),
  );
}

type DecisionRow = {
  poolAddress: string;
  action: string;
  reasoning: string;
  confidence: number;
  executed: boolean;
  riskResult: { approved: boolean; reason: string };
  metrics?: PoolMetrics;
};

// Runs a single cycle after seeding positions, then returns audit rows (with the
// metrics snapshot, which carries pool.statsSource + the known flags).
function runWithSeed(
  layer: ReturnType<typeof makeTestLayer>,
  positions: ReadonlyArray<ReturnType<typeof makePosition>>,
): Promise<ReadonlyArray<DecisionRow>> {
  const test = Effect.gen(function* () {
    const db = yield* DbService;
    for (const pos of positions) {
      yield* db.savePosition(pos);
    }
    yield* Effect.raceFirst(program, Effect.sleep(2_000));
    const audit = yield* AuditService;
    return yield* audit.getRecentDecisions(200);
  });
  return Effect.runPromise(
    Effect.provide(test, layer) as Effect.Effect<ReadonlyArray<DecisionRow>, unknown, never>,
  );
}

// Live-shaped gecko fixture (strings, pool_fee_percentage null). program.ts
// derives baseFeeRate = 0.0025 + binStep/1e4 = 0.0035 for the default binStep 10,
// so fees24hUsd = volume24hUsd × 0.0035.
function geckoResponse(volume24hUsd: number, reserveUsd: number): unknown {
  return {
    data: {
      attributes: {
        name: "SOL / USDC",
        pool_fee_percentage: null,
        volume_usd: { h24: String(volume24hUsd) },
        reserve_in_usd: String(reserveUsd),
        base_token_price_usd: "150",
        quote_token_price_usd: "1",
      },
    },
  };
}

// gecko is the only global-fetch consumer in these cycles (token-risk is pinned
// off in defaultAppConfig), so the mock answers the gecko pool path directly.
function geckoUp(volume24hUsd: number, reserveUsd: number): () => void {
  return mockFetch(() =>
    Promise.resolve(
      new Response(JSON.stringify(geckoResponse(volume24hUsd, reserveUsd)), { status: 200 }),
    ),
  );
}

function geckoDown(): () => void {
  return mockFetch(() => Promise.resolve(new Response("rate limited", { status: 429 })));
}

const POOL = "PoolStatsPipeline1111111111111111111111111";

function poolRows(rows: ReadonlyArray<DecisionRow>): ReadonlyArray<DecisionRow> {
  return rows.filter((r) => r.poolAddress === POOL);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stats source propagation — datapi vs gecko vs heuristic", () => {
  it("datapi down + gecko up → enriches geckoterminal, volume/fee gates active (metrics known)", async () => {
    // gecko volume 100 × 0.0035 = fees ≈ 0.35 on tvl 100_000 → a real, low
    // fee/IL ratio (< 1.2). With ilProtectionEnabled the [fee-il-gate] must FIRE
    // because gecko fees are real (feeIlRatioKnown=true).
    const restoreGecko = geckoUp(100, 100_000);
    try {
      const layer = makeTestLayer({
        adapter: makeAdapter({ [POOL]: makePool({ address: POOL }) }),
        datapi: { getPoolData: () => Effect.succeed(null) }, // datapi down
        configOverrides: {
          watchlistPools: [POOL],
          ilProtectionEnabled: true,
          geckoTerminalEnabled: true,
        },
      });
      const rows = await runWithSeed(layer, []);
      const rows_ = poolRows(rows);
      const metrics = rows_.find((r) => r.metrics !== undefined)?.metrics;
      expect(metrics, "expected an audited decision carrying metrics").toBeDefined();
      expect(metrics!.pool.statsSource).toBe("geckoterminal");
      expect(metrics!.volumeAuthenticityKnown).toBe(true);
      expect(metrics!.feeIlRatioKnown).toBe(true);
      // Fees are real → the floor gate acts on them.
      const gateRejects = rows_.filter(
        (d) => d.action === "ENTER" && d.reasoning.includes("[fee-il-gate]"),
      );
      expect(gateRejects, "gecko real low fee/IL should trip [fee-il-gate]").toHaveLength(1);
    } finally {
      restoreGecko();
    }
  }, 15_000);

  it("datapi down + gecko down → heuristic, known-flags false, [fee-il-gate] skipped (volume-unknown blocks entry instead)", async () => {
    // Same low-fee pool, but BOTH real sources are down → heuristic. The OLD
    // behaviour rejected ENTER via [fee-il-gate] on the FABRICATED ratio; it must
    // now skip — the volume candidate gate (volumeAuthenticityKnown required)
    // keeps the pool out, just not via a made-up fee/IL number.
    const restoreGecko = geckoDown();
    try {
      const layer = makeTestLayer({
        adapter: makeAdapter({ [POOL]: makePool({ address: POOL, fees24hUsd: 1 }) }),
        datapi: { getPoolData: () => Effect.succeed(null) },
        configOverrides: {
          watchlistPools: [POOL],
          ilProtectionEnabled: true,
          geckoTerminalEnabled: true,
        },
      });
      const rows = await runWithSeed(layer, []);
      const rows_ = poolRows(rows);
      const metrics = rows_.find((r) => r.metrics !== undefined)?.metrics;
      expect(metrics).toBeDefined();
      expect(metrics!.pool.statsSource).toBe("heuristic");
      expect(metrics!.volumeAuthenticityKnown).toBe(false);
      expect(metrics!.feeIlRatioKnown).toBe(false);
      // No [fee-il-gate] rejection (fabricated ratio must not reject), and no
      // ENTER at all (volume-unknown path).
      const gateRejects = rows_.filter((d) => d.reasoning.includes("[fee-il-gate]"));
      expect(gateRejects, "heuristic must not reject via [fee-il-gate]").toHaveLength(0);
      const enters = rows_.filter((d) => d.action === "ENTER");
      expect(enters, "volume-unknown heuristic pool must not ENTER").toHaveLength(0);
    } finally {
      restoreGecko();
    }
  }, 15_000);

  it("heuristic fee/IL EXIT gate is skipped despite a fabricated-low ratio (tracked position stays)", async () => {
    // In-range paper position on a stable heuristic pool whose modeled fee/IL is
    // < 0.5. The fee/IL EXIT MUST skip (feeIlRatioKnown=false) rather than dump
    // the position on a fabricated low-fee number. No other EXIT fires (stable
    // TVL, in-range, no drawdown), so the position is held.
    const restoreGecko = geckoDown();
    try {
      // fees 0.3 on tvl 100_000 → fee/IL ≈ 0.12-0.24, reliably < 0.5, so the old
      // (unguarded) code WOULD have fired the fee/IL EXIT here.
      const layer = makeTestLayer({
        adapter: makeAdapter({ [POOL]: makePool({ address: POOL, fees24hUsd: 0.3 }) }),
        datapi: { getPoolData: () => Effect.succeed(null) },
        configOverrides: { watchlistPools: [POOL], geckoTerminalEnabled: true },
      });
      const position = makePosition({
        poolAddress: POOL,
        depositedUsd: 1000,
        currentValueUsd: 1000,
      });
      const rows = await runWithSeed(layer, [position]);
      const rows_ = poolRows(rows);
      const feeIlExits = rows_.filter(
        (d) => d.action === "EXIT" && d.reasoning.includes("Fee/IL ratio"),
      );
      expect(feeIlExits, "heuristic fabricated-low fee/IL must not force an EXIT").toHaveLength(0);
      const metrics = rows_.find((r) => r.metrics !== undefined)?.metrics;
      expect(metrics).toBeDefined();
      expect(metrics!.feeIlRatioKnown).toBe(false);
      const exits = rows_.filter((d) => d.action === "EXIT");
      expect(exits, "stable in-range heuristic position is held, not exited").toHaveLength(0);
    } finally {
      restoreGecko();
    }
  }, 15_000);
});

describe("paper notional-fee accrual respects the stats source", () => {
  // In-range paper position; the accrual gate is isMeasuredStatsSource(...)
  // (datapi or geckoterminal only — heuristic fabricated fees never accrue).
  function inRangePaperPosition() {
    return makePosition({ poolAddress: POOL, depositedUsd: 1000, currentValueUsd: 1000 });
  }

  function readAccruedFees(layer: ReturnType<typeof makeTestLayer>): Promise<number> {
    const test = Effect.gen(function* () {
      const db = yield* DbService;
      yield* db.savePosition(inRangePaperPosition());
      yield* Effect.raceFirst(program, Effect.sleep(2_000));
      const positions = yield* db.getAllPositions();
      const pos = positions.find((p) => p.poolAddress === POOL);
      return pos?.cumulativeFeesClaimedUsd ?? -1;
    });
    return Effect.runPromise(Effect.provide(test, layer) as Effect.Effect<number, unknown, never>);
  }

  it("accrues under gecko stats (real fees)", async () => {
    const restoreGecko = geckoUp(50_000_000, 5_000_000); // high real volume → real fees
    try {
      const layer = makeTestLayer({
        adapter: makeAdapter({ [POOL]: makePool({ address: POOL, tvlUsd: 5_000_000 }) }),
        datapi: { getPoolData: () => Effect.succeed(null) },
        configOverrides: { watchlistPools: [POOL], geckoTerminalEnabled: true },
      });
      const accrued = await readAccruedFees(layer);
      expect(accrued, "gecko real fees should accrue to a paper position").toBeGreaterThan(0);
    } finally {
      restoreGecko();
    }
  }, 15_000);

  it("does NOT accrue under heuristic stats (fabricated fees, both sources down)", async () => {
    const restoreGecko = geckoDown();
    try {
      // Heuristic getPoolState ships a POSITIVE modeled fees24hUsd, yet accrual
      // must stay 0 because statsSource === "heuristic".
      const layer = makeTestLayer({
        adapter: makeAdapter({ [POOL]: makePool({ address: POOL, tvlUsd: 5_000_000 }) }),
        datapi: { getPoolData: () => Effect.succeed(null) },
        configOverrides: { watchlistPools: [POOL], geckoTerminalEnabled: true },
      });
      const accrued = await readAccruedFees(layer);
      expect(accrued, "heuristic fabricated fees must not accrue").toBe(0);
    } finally {
      restoreGecko();
    }
  }, 15_000);
});
