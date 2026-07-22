import { describe, it, expect, vi, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import { program } from "../engine/program.js";
import { StrategyLive } from "../engine/strategy-service.js";
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
  AgentStateService,
  type AdapterApi,
  type MeteoraDatapiApi,
} from "../engine/services.js";
import type { PrismStateSnapshot } from "../engine/state-service.js";
import type { PoolSnapshot } from "../engine/types.js";
import { defaultAppConfig, makePool, makeBinArray, makePosition } from "./helpers.js";

// Wallet value is reconciled ONCE per cycle at the top of runScanCycle, reused
// by every pool, degrades to the stale value on a live read failure (never
// failing a pool), and a mid-cycle close drops a position from the portfolio
// sum for later pools in the same cycle.

const NO_AUTHORITIES = { mintAuthority: null, freezeAuthority: null } as const;

function makeAdapter(walletBalanceUsd: () => Effect.Effect<number, unknown>): AdapterApi {
  return {
    hasWallet: () => true,
    getWalletAddress: () => "WalletAddress1111111111111111111111111111111",
    getWalletBalanceUsd: walletBalanceUsd,
    getNativeSolBalance: () => Effect.succeed(0n),
    getPoolState: (addr: string) => Effect.succeed(makePool({ address: addr, fees24hUsd: 100 })),
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
    getMintAuthorities: () => Effect.succeed(NO_AUTHORITIES),
    quoteSwapUSDCForToken: () => Effect.succeed({}),
    swapUSDCForToken: () => Effect.succeed("mock-swap-tx"),
  } as AdapterApi;
}

const datapi: MeteoraDatapiApi = { getPoolData: () => Effect.succeed(null) };

function makeTestLayer(adapter: AdapterApi, configOverrides: Partial<AppConfig>) {
  const config = defaultAppConfig({
    scanIntervalMs: 3_600_000,
    agentMcpEnabled: false,
    agentHttpPort: 0,
    ...configOverrides,
  });
  const dbLayer = DbLive(":memory:");
  return Layer.mergeAll(
    Layer.succeed(ConfigService, config),
    Layer.succeed(AdapterService, adapter),
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
    Layer.succeed(MeteoraDatapiService, datapi),
    Layer.succeed(AlertService, { sendAlert: () => Effect.void, recordFeeClaim: () => Effect.void }),
  );
}

interface CycleResult {
  readonly decisions: ReadonlyArray<{ poolAddress: string; action: string }>;
  readonly snapshot: PrismStateSnapshot;
}

function runOneCycle(layer: Layer.Layer<unknown, never, never>): Promise<CycleResult> {
  const test = Effect.gen(function* () {
    yield* Effect.raceFirst(program, Effect.sleep(2_000));
    const audit = yield* AuditService;
    const state = yield* AgentStateService;
    const decisions = yield* audit.getRecentDecisions(50);
    const snapshot = yield* state.getSnapshot();
    return { decisions, snapshot };
  });
  return Effect.runPromise(Effect.provide(test, layer) as Effect.Effect<CycleResult, unknown, never>);
}

describe("per-cycle wallet reconciliation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the wallet exactly once per cycle and feeds it to every pool", async () => {
    const POOL_A = "PoolCycleA111111111111111111111111111111111";
    const POOL_B = "PoolCycleB111111111111111111111111111111111";
    let reads = 0;
    const adapter = makeAdapter(() =>
      Effect.sync(() => {
        reads += 1;
        return 7_777;
      }),
    );
    const layer = makeTestLayer(adapter, {
      watchlistPools: [POOL_A, POOL_B],
      paperTrading: false,
      paperPortfolioUsd: 1_000,
    });

    const { decisions, snapshot } = await runOneCycle(layer as never);

    expect(reads, "wallet must be read once per cycle, not per pool").toBe(1);
    const poolsSeen = new Set(decisions.map((d) => d.poolAddress));
    expect(poolsSeen.has(POOL_A), "pool A must still be evaluated").toBe(true);
    expect(poolsSeen.has(POOL_B), "pool B must still be evaluated").toBe(true);
    expect(snapshot.portfolio.walletBalanceUsd).toBe(7_777);
  }, 15_000);

  it("on a live read failure reuses the stale value, warns once, and keeps evaluating pools", async () => {
    const POOL_A = "PoolFailA1111111111111111111111111111111111";
    const POOL_B = "PoolFailB1111111111111111111111111111111111";
    const STALE = 4_321; // seeded from paperPortfolioUsd before the first read
    let warnCount = 0;
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      if (String(args[0]).includes("reusing last known value")) warnCount += 1;
    });

    const adapter = makeAdapter(() => Effect.fail(new Error("rpc down")));
    const layer = makeTestLayer(adapter, {
      watchlistPools: [POOL_A, POOL_B],
      paperTrading: false,
      paperPortfolioUsd: STALE,
    });

    try {
      const { decisions, snapshot } = await runOneCycle(layer as never);

      const poolsSeen = new Set(decisions.map((d) => d.poolAddress));
      expect(poolsSeen.has(POOL_A), "a wallet read failure must not skip pool A").toBe(true);
      expect(poolsSeen.has(POOL_B), "a wallet read failure must not skip pool B").toBe(true);
      expect(snapshot.portfolio.walletBalanceUsd).toBe(STALE);
      expect(warnCount, "warn exactly once per failing cycle").toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  }, 15_000);

  it("keeps paper mode on the configured paper portfolio and never reads the chain wallet", async () => {
    const POOL = "PoolPaper1111111111111111111111111111111111";
    let reads = 0;
    const adapter = makeAdapter(() =>
      Effect.sync(() => {
        reads += 1;
        return 99_999;
      }),
    );
    const layer = makeTestLayer(adapter, {
      watchlistPools: [POOL],
      paperTrading: true,
      paperPortfolioUsd: 2_500,
    });

    const { snapshot } = await runOneCycle(layer as never);

    expect(reads, "paper mode must not perform a chain wallet read").toBe(0);
    expect(snapshot.portfolio.walletBalanceUsd).toBe(2_500);
  }, 15_000);
});

describe("mid-cycle position close excludes the row from the portfolio sum", () => {
  const POOL = "PoolMidClose1111111111111111111111111111111";
  const PAPER = 5_000;
  const POSITION_VALUE = 1_000;

  function makeExitingAdapter(): AdapterApi {
    return {
      ...makeAdapter(() => Effect.succeed(PAPER)),
      getPoolState: () => Effect.succeed(makePool({ address: POOL, tvlUsd: 60_000, fees24hUsd: 300 })),
    } as AdapterApi;
  }

  it("a position that exits this cycle is not counted in the same cycle's portfolio", async () => {
    const layer = makeTestLayer(makeExitingAdapter(), {
      watchlistPools: [POOL],
      paperTrading: true,
      paperPortfolioUsd: PAPER,
      tvlDropExitPct: 0.3,
    });
    const previousSnapshot: PoolSnapshot = {
      poolAddress: POOL,
      timestamp: Date.now() - 600_000,
      activeBinId: 5000,
      tvlUsd: 100_000, // -40% vs current 60k → exceeds the 30% EXIT threshold
      volume24hUsd: 30_000,
      fees24hUsd: 300,
      apr: 60,
      currentPrice: 150,
      binStep: 10,
      tokenXSymbol: "SOL",
      tokenYSymbol: "USDC",
      binArray: makeBinArray(),
    };

    const test = Effect.gen(function* () {
      const db = yield* DbService;
      yield* db.savePosition(
        makePosition({
          poolAddress: POOL,
          positionPubKey: null,
          lowerBinId: 4980,
          upperBinId: 5020,
          depositedUsd: POSITION_VALUE,
          currentValueUsd: POSITION_VALUE,
        }),
      );
      yield* db.saveSnapshot(previousSnapshot);
      yield* Effect.raceFirst(program, Effect.sleep(2_000));
      const audit = yield* AuditService;
      const state = yield* AgentStateService;
      const decisions = yield* audit.getRecentDecisions(50);
      const snapshot = yield* state.getSnapshot();
      return { decisions, snapshot };
    });

    const { decisions, snapshot } = await Effect.runPromise(
      Effect.provide(test, layer) as Effect.Effect<
        { decisions: ReadonlyArray<{ action: string; reasoning: string }>; snapshot: PrismStateSnapshot },
        unknown,
        never
      >,
    );

    const exited = decisions.some(
      (d) => d.action === "EXIT" && d.reasoning.includes("TVL dropped"),
    );
    expect(exited, "the seeded position must exit on the TVL drop").toBe(true);
    expect(snapshot.portfolio.totalValueUsd, "closed row must be excluded from the sum").toBe(PAPER);
    expect(snapshot.portfolio.totalValueUsd).not.toBe(PAPER + POSITION_VALUE);
  }, 15_000);
});
