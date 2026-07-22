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
  type MeteoraPoolStats,
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

function enterableDatapi(overrides: Partial<MeteoraPoolStats> = {}): MeteoraPoolStats {
  // A strong, positionless-pool-friendly stats payload: high enough TVL/volume
  // authenticity and fee/IL that the ENTER slot both opens AND passes the
  // weighted-score + risk gates, so the pool executes a real live ENTER.
  return {
    address: "ignored",
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

function makeTestLayer(
  adapter: AdapterApi,
  configOverrides: Partial<AppConfig>,
  datapiOverride?: MeteoraDatapiApi,
) {
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
    Layer.succeed(MeteoraDatapiService, datapiOverride ?? datapi),
    Layer.succeed(AlertService, {
      sendAlert: () => Effect.void,
      recordFeeClaim: () => Effect.void,
    }),
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
  return Effect.runPromise(
    Effect.provide(test, layer) as Effect.Effect<CycleResult, unknown, never>,
  );
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
      getPoolState: () =>
        Effect.succeed(makePool({ address: POOL, tvlUsd: 60_000, fees24hUsd: 300 })),
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
        {
          decisions: ReadonlyArray<{ action: string; reasoning: string }>;
          snapshot: PrismStateSnapshot;
        },
        unknown,
        never
      >,
    );

    const exited = decisions.some(
      (d) => d.action === "EXIT" && d.reasoning.includes("TVL dropped"),
    );
    expect(exited, "the seeded position must exit on the TVL drop").toBe(true);
    expect(snapshot.portfolio.totalValueUsd, "closed row must be excluded from the sum").toBe(
      PAPER,
    );
    expect(snapshot.portfolio.totalValueUsd).not.toBe(PAPER + POSITION_VALUE);
  }, 15_000);
});

describe("live wallet-read entry gate", () => {
  // lastWalletBalanceUsd is seeded from config.paperPortfolioUsd (fictional for
  // live). Until the first SUCCESSFUL chain read, walletEverReadSuccessfully is
  // false and live ENTER is blocked fail-closed; EXIT is never gated by it.

  const ENTER_POOL = "PoolEnterGate1111111111111111111111111111111";

  interface FullDecision {
    readonly poolAddress: string;
    readonly action: string;
    readonly reasoning: string;
    readonly executed: boolean;
  }

  function runCycleFull(layer: Layer.Layer<unknown, never, never>): Promise<{
    readonly decisions: ReadonlyArray<FullDecision>;
  }> {
    const test = Effect.gen(function* () {
      yield* Effect.raceFirst(program, Effect.sleep(2_000));
      const audit = yield* AuditService;
      const decisions = yield* audit.getRecentDecisions(50);
      return { decisions: decisions as unknown as FullDecision[] };
    });
    return Effect.runPromise(
      Effect.provide(test, layer) as Effect.Effect<{ decisions: FullDecision[] }, unknown, never>,
    );
  }

  function enterCandidateAdapter(balance: Effect.Effect<number, unknown>): AdapterApi {
    // A high-quality positionless pool that reaches the ENTER slot.
    return {
      ...makeAdapter(() => balance),
      getPoolState: (addr: string) =>
        Effect.succeed(
          makePool({ address: addr, tvlUsd: 500_000, volume24hUsd: 200_000, fees24hUsd: 2_000 }),
        ),
      getBinArray: () => Effect.succeed(makeBinArray()),
    } as AdapterApi;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks live ENTER with a [wallet-read] audit when no wallet read has succeeded", async () => {
    const adapter = enterCandidateAdapter(Effect.fail(new Error("rpc down")));
    const layer = makeTestLayer(adapter, {
      watchlistPools: [ENTER_POOL],
      paperTrading: false,
      paperPortfolioUsd: 10_000,
    });

    const { decisions } = await runCycleFull(layer as never);

    const walletGate = decisions.find(
      (d) =>
        d.poolAddress === ENTER_POOL &&
        d.action === "ENTER" &&
        d.reasoning.includes("[wallet-read]"),
    );
    expect(walletGate, "ENTER must be rejected by the [wallet-read] gate").toBeDefined();
    expect(walletGate!.executed).toBe(false);
  }, 15_000);

  it("does not fire the gate once a wallet read has succeeded", async () => {
    const adapter = enterCandidateAdapter(Effect.succeed(8_000));
    const layer = makeTestLayer(adapter, {
      watchlistPools: [ENTER_POOL],
      paperTrading: false,
      paperPortfolioUsd: 10_000,
    });

    const { decisions } = await runCycleFull(layer as never);

    const walletGate = decisions.find(
      (d) => d.poolAddress === ENTER_POOL && d.reasoning.includes("[wallet-read]"),
    );
    expect(
      walletGate,
      "the [wallet-read] gate must not fire after a successful read",
    ).toBeUndefined();
  }, 15_000);

  it("never blocks EXIT on a failed wallet read", async () => {
    const EXIT_POOL = "PoolExitGate11111111111111111111111111111111";
    const POS_PUBKEY = "PosExitGate111111111111111111111111111111111";
    // Wallet read fails AND getAllWalletPositions keeps the seeded live position
    // (so reconcile does not drop it before the exit decision).
    const adapter = {
      ...makeAdapter(() => Effect.fail(new Error("rpc down"))),
      getPoolState: (addr: string) =>
        Effect.succeed(makePool({ address: addr, tvlUsd: 60_000, fees24hUsd: 300 })),
      getAllWalletPositions: () =>
        Effect.succeed([
          {
            poolAddress: EXIT_POOL,
            positionPubKey: POS_PUBKEY,
            lowerBinId: 4980,
            upperBinId: 5020,
          },
        ]),
      getPositions: () => Effect.succeed([{ id: POS_PUBKEY }] as never),
    } as AdapterApi;
    const layer = makeTestLayer(adapter, {
      watchlistPools: [EXIT_POOL],
      paperTrading: false,
      paperPortfolioUsd: 10_000,
      tvlDropExitPct: 0.3,
    });

    const previousSnapshot: PoolSnapshot = {
      poolAddress: EXIT_POOL,
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
          poolAddress: EXIT_POOL,
          positionPubKey: POS_PUBKEY,
          positionId: POS_PUBKEY,
          lowerBinId: 4980,
          upperBinId: 5020,
          depositedUsd: 1_000,
          currentValueUsd: 1_000,
        }),
      );
      yield* db.saveSnapshot(previousSnapshot);
      yield* Effect.raceFirst(program, Effect.sleep(2_000));
      const audit = yield* AuditService;
      const decisions = yield* audit.getRecentDecisions(50);
      return { decisions: decisions as unknown as FullDecision[] };
    });

    const { decisions } = await Effect.runPromise(
      Effect.provide(test, layer) as Effect.Effect<{ decisions: FullDecision[] }, unknown, never>,
    );

    const exit = decisions.find((d) => d.poolAddress === EXIT_POOL && d.action === "EXIT");
    expect(
      exit,
      "the seeded position must exit on the TVL drop despite the failed wallet read",
    ).toBeDefined();
    expect(exit!.executed, "EXIT execution is never gated by wallet balance").toBe(true);
    expect(
      decisions.some((d) => d.poolAddress === EXIT_POOL && d.reasoning.includes("[wallet-read]")),
      "the wallet-read gate must not target the EXIT path",
    ).toBe(false);
  }, 15_000);
});

describe("intra-cycle wallet re-capture after a live mutation", () => {
  // After a SUCCESSFUL live ENTER/EXIT, funds move wallet<->position but later
  // pools still hold the cycle-top wallet capture; without a re-read the deployed
  // capital is double-counted (wallet + position). The fix re-reads the wallet
  // after each successful live mutation. A failed re-read keeps the stale value
  // and warns, never crashing the cycle.

  const POOL = "PoolRecapture111111111111111111111111111111";
  const POS_PUBKEY = "PosRecapture1111111111111111111111111111111";
  const CYCLE_TOP = 10_000;
  const POST_MUTATION = 4_321;

  interface FullDecision {
    readonly poolAddress: string;
    readonly action: string;
    readonly executed: boolean;
  }

  function seedExitingPosition(db: {
    savePosition: (p: ReturnType<typeof makePosition>) => Effect.Effect<void, unknown>;
    saveSnapshot: (s: PoolSnapshot) => Effect.Effect<void, unknown>;
  }) {
    return Effect.gen(function* () {
      yield* db.savePosition(
        makePosition({
          poolAddress: POOL,
          positionPubKey: POS_PUBKEY,
          positionId: POS_PUBKEY,
          lowerBinId: 4980,
          upperBinId: 5020,
          depositedUsd: 1_000,
          currentValueUsd: 1_000,
        }),
      );
      yield* db.saveSnapshot({
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
      });
    });
  }

  function exitingAdapter(balance: Effect.Effect<number, unknown>): AdapterApi {
    return {
      ...makeAdapter(() => balance),
      getPoolState: () =>
        Effect.succeed(makePool({ address: POOL, tvlUsd: 60_000, fees24hUsd: 300 })),
      getAllWalletPositions: () =>
        Effect.succeed([
          { poolAddress: POOL, positionPubKey: POS_PUBKEY, lowerBinId: 4980, upperBinId: 5020 },
        ]),
      getPositions: () => Effect.succeed([{ id: POS_PUBKEY }] as never),
    } as AdapterApi;
  }

  function runRecaptureCycle(layer: Layer.Layer<unknown, never, never>) {
    const test = Effect.gen(function* () {
      const db = yield* DbService;
      yield* seedExitingPosition(db as never);
      yield* Effect.raceFirst(program, Effect.sleep(2_000));
      const audit = yield* AuditService;
      const state = yield* AgentStateService;
      const decisions = yield* audit.getRecentDecisions(50);
      const snapshot = yield* state.getSnapshot();
      return { decisions: decisions as unknown as FullDecision[], snapshot };
    });
    return Effect.runPromise(
      Effect.provide(test, layer) as Effect.Effect<
        { decisions: FullDecision[]; snapshot: PrismStateSnapshot },
        unknown,
        never
      >,
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-reads the wallet after the live EXIT mutation (call count > 1, post-mutation value lands)", async () => {
    let balanceCalls = 0;
    const balance = Effect.suspend(() => {
      balanceCalls += 1;
      // Cycle-top read first; every later (post-mutation) read returns the
      // lower post-withdrawal balance.
      return balanceCalls === 1 ? Effect.succeed(CYCLE_TOP) : Effect.succeed(POST_MUTATION);
    });
    const layer = makeTestLayer(exitingAdapter(balance), {
      watchlistPools: [POOL],
      paperTrading: false,
      paperPortfolioUsd: CYCLE_TOP,
      tvlDropExitPct: 0.3,
    });

    const { decisions, snapshot } = await runRecaptureCycle(layer as never);

    expect(
      decisions.some((d) => d.poolAddress === POOL && d.action === "EXIT" && d.executed),
      "the seeded position must exit",
    ).toBe(true);
    expect(
      balanceCalls,
      "wallet read at cycle top AND after the live mutation",
    ).toBeGreaterThanOrEqual(2);
    // The post-mutation re-read updated the cycle value (no double-count left).
    expect(snapshot.portfolio.walletBalanceUsd).toBe(POST_MUTATION);
  }, 15_000);

  it("a failed post-mutation re-read keeps the stale balance and does not crash the cycle", async () => {
    let balanceCalls = 0;
    const balance = Effect.suspend(() => {
      balanceCalls += 1;
      // Cycle-top read succeeds; every later (post-mutation) re-read fails.
      return balanceCalls === 1
        ? Effect.succeed(CYCLE_TOP)
        : Effect.fail(new Error("re-read down"));
    });
    const layer = makeTestLayer(exitingAdapter(balance), {
      watchlistPools: [POOL],
      paperTrading: false,
      paperPortfolioUsd: CYCLE_TOP,
      tvlDropExitPct: 0.3,
    });

    const { decisions, snapshot } = await runRecaptureCycle(layer as never);

    // The exit still executed and the post-mutation re-read was attempted …
    expect(
      decisions.some((d) => d.poolAddress === POOL && d.action === "EXIT" && d.executed),
      "the exit must succeed even though the post-mutation re-read fails",
    ).toBe(true);
    expect(balanceCalls, "the post-mutation re-read was attempted").toBeGreaterThanOrEqual(2);
    // … but the stale cycle-top value is kept (degrade, never crash).
    expect(snapshot.portfolio.walletBalanceUsd).toBe(CYCLE_TOP);
  }, 15_000);
});

describe("post-ENTER wallet-refresh failure blocks further entries (fail-closed)", () => {
  // After a successful LIVE ENTER, a FAILED post-tx wallet re-read leaves the
  // stale cycle-top balance (still counting the deployed capital) alongside the
  // already-tracked new position. Serving that to the next pool double-counts
  // capital and can breach the allocation cap, so all further entries are
  // blocked for the rest of the cycle ([wallet-refresh]). EXIT-origin refresh
  // failures deliberately do NOT block: a stale balance under-counts, so the
  // gates tighten — the safe direction.

  const POOL_A = "PoolRefreshEnterA111111111111111111111111";
  const POOL_B = "PoolRefreshEnterB111111111111111111111111";
  const CYCLE_TOP = 10_000;

  interface FullDecision {
    readonly poolAddress: string;
    readonly action: string;
    readonly reasoning: string;
    readonly executed: boolean;
  }

  // Live ENTER requires a native SOL balance above MIN_SOL_FOR_GAS_LAMPORTS
  // (30_000_000n); give the mock wallet ample SOL so the enter can execute.
  function enterAdapter(walletBalance: Effect.Effect<number, unknown>): AdapterApi {
    return {
      ...makeAdapter(() => walletBalance),
      getNativeSolBalance: () => Effect.succeed(1_000_000_000n),
      getPoolState: (addr: string) =>
        Effect.succeed(
          makePool({ address: addr, tvlUsd: 200_000, volume24hUsd: 40_000, fees24hUsd: 400 }),
        ),
    } as AdapterApi;
  }

  const enterableDatapiSvc: MeteoraDatapiApi = {
    getPoolData: () => Effect.succeed(enterableDatapi()),
  };

  function runCycle(layer: Layer.Layer<unknown, never, never>) {
    const test = Effect.gen(function* () {
      yield* Effect.raceFirst(program, Effect.sleep(2_000));
      const audit = yield* AuditService;
      const decisions = yield* audit.getRecentDecisions(100);
      return { decisions: decisions as unknown as FullDecision[] };
    });
    return Effect.runPromise(
      Effect.provide(test, layer) as Effect.Effect<{ decisions: FullDecision[] }, unknown, never>,
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a failed wallet re-read after a LIVE ENTER blocks the next pool's ENTER ([wallet-refresh])", async () => {
    let balanceCalls = 0;
    const balance = Effect.suspend(() => {
      balanceCalls += 1;
      // Cycle-top read succeeds (walletEverReadSuccessfully=true so the first
      // ENTER clears the [wallet-read] gate); the post-ENTER re-capture fails.
      return balanceCalls === 1
        ? Effect.succeed(CYCLE_TOP)
        : Effect.fail(new Error("re-read down"));
    });
    const layer = makeTestLayer(
      enterAdapter(balance),
      {
        watchlistPools: [POOL_A, POOL_B],
        paperTrading: false,
        paperPortfolioUsd: CYCLE_TOP,
        maxOpenPositions: 5,
      },
      enterableDatapiSvc,
    );

    const { decisions } = await runCycle(layer as never);

    const executedEnters = decisions.filter((d) => d.action === "ENTER" && d.executed);
    expect(
      executedEnters,
      "only the first pool enters before the failed refresh blocks the rest",
    ).toHaveLength(1);
    const refreshBlock = decisions.find((d) => d.reasoning.includes("[wallet-refresh]"));
    expect(refreshBlock, "the second pool's ENTER must be fail-closed").toBeDefined();
    expect(refreshBlock!.executed).toBe(false);
  }, 15_000);

  it("a successful wallet re-read leaves entries unblocked (both pools enter)", async () => {
    const layer = makeTestLayer(
      enterAdapter(Effect.succeed(CYCLE_TOP)),
      {
        watchlistPools: [POOL_A, POOL_B],
        paperTrading: false,
        paperPortfolioUsd: CYCLE_TOP,
        maxOpenPositions: 5,
      },
      enterableDatapiSvc,
    );

    const { decisions } = await runCycle(layer as never);

    const executedEnters = decisions.filter((d) => d.action === "ENTER" && d.executed);
    expect(executedEnters, "both pools enter when the refresh succeeds").toHaveLength(2);
    expect(
      decisions.some((d) => d.reasoning.includes("[wallet-refresh]")),
      "no [wallet-refresh] block when the re-read succeeds",
    ).toBe(false);
  }, 15_000);

  it("an EXIT-origin refresh failure does NOT set the entry-block flag", async () => {
    const POOL_EXIT = "PoolRefreshExitX1111111111111111111111111";
    const POS_PUBKEY = "PosRefreshExitX11111111111111111111111111";
    // Order [EXIT pool, ENTER pool]: the EXIT pool runs first and its post-EXIT
    // re-read fails; the ENTER pool must still enter (EXIT failure ≠ flag).
    let balanceCalls = 0;
    const balance = Effect.suspend(() => {
      balanceCalls += 1;
      return balanceCalls === 1
        ? Effect.succeed(CYCLE_TOP)
        : Effect.fail(new Error("re-read down"));
    });
    const adapter = {
      ...makeAdapter(() => balance),
      getNativeSolBalance: () => Effect.succeed(1_000_000_000n),
      getPoolState: (addr: string) =>
        addr === POOL_EXIT
          ? Effect.succeed(makePool({ address: addr, tvlUsd: 60_000, fees24hUsd: 300 }))
          : Effect.succeed(
              makePool({ address: addr, tvlUsd: 200_000, volume24hUsd: 40_000, fees24hUsd: 400 }),
            ),
      getAllWalletPositions: () =>
        Effect.succeed([
          {
            poolAddress: POOL_EXIT,
            positionPubKey: POS_PUBKEY,
            lowerBinId: 4980,
            upperBinId: 5020,
          },
        ]),
      getPositions: () => Effect.succeed([{ id: POS_PUBKEY }] as never),
    } as AdapterApi;
    // Datapi null for the EXIT pool so its 60k TVL survives enrichment and the
    // TVL-drop exit fires; the ENTER pool gets strong stats so it can enter.
    const splitDatapi: MeteoraDatapiApi = {
      getPoolData: (addr: string) =>
        addr === POOL_EXIT ? Effect.succeed(null) : Effect.succeed(enterableDatapi()),
    };
    const layer = makeTestLayer(
      adapter,
      {
        watchlistPools: [POOL_EXIT, POOL_B],
        paperTrading: false,
        paperPortfolioUsd: CYCLE_TOP,
        tvlDropExitPct: 0.3,
        maxOpenPositions: 5,
      },
      splitDatapi,
    );

    const test = Effect.gen(function* () {
      const db = yield* DbService;
      yield* db.savePosition(
        makePosition({
          poolAddress: POOL_EXIT,
          positionPubKey: POS_PUBKEY,
          positionId: POS_PUBKEY,
          lowerBinId: 4980,
          upperBinId: 5020,
          depositedUsd: 1_000,
          currentValueUsd: 1_000,
        }),
      );
      yield* db.saveSnapshot({
        poolAddress: POOL_EXIT,
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
      });
      yield* Effect.raceFirst(program, Effect.sleep(2_000));
      const audit = yield* AuditService;
      const decisions = yield* audit.getRecentDecisions(100);
      return { decisions: decisions as unknown as FullDecision[] };
    });
    const { decisions } = await Effect.runPromise(
      Effect.provide(test, layer) as Effect.Effect<{ decisions: FullDecision[] }, unknown, never>,
    );

    expect(
      decisions.some((d) => d.poolAddress === POOL_EXIT && d.action === "EXIT" && d.executed),
      "the EXIT pool exits on the TVL drop despite the failed refresh",
    ).toBe(true);
    expect(
      decisions.some((d) => d.poolAddress === POOL_B && d.action === "ENTER" && d.executed),
      "an EXIT-origin refresh failure must NOT block a later entry",
    ).toBe(true);
    expect(
      decisions.some((d) => d.reasoning.includes("[wallet-refresh]")),
      "EXIT-origin failures never set the entry-block flag",
    ).toBe(false);
  }, 15_000);
});

describe("hybrid live EXIT keeps paper sizing paper-pure", () => {
  // PAPER_TRADING=true + PAPER_MODE_EXIT_LIVE: a hybrid live EXIT sets
  // movedLiveFunds, but paper cycles must NOT refresh the chain wallet — doing
  // so would replace paperPortfolioUsd with unrelated chain funds mid-cycle and
  // corrupt later paper pools' sizing. Refresh is gated on !paperTrading.

  const POOL_EXIT = "PoolHybridExit1111111111111111111111111111";
  const POOL_PAPER = "PoolHybridPaper111111111111111111111111";
  const POS_PUBKEY = "PosHybridExit1111111111111111111111111111";
  const PAPER = 2_500;

  interface FullDecision {
    readonly poolAddress: string;
    readonly action: string;
    readonly executed: boolean;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not refresh the chain wallet after a hybrid live EXIT (sizing stays paper-pure)", async () => {
    let balanceCalls = 0;
    const adapter = {
      ...makeAdapter(() =>
        Effect.sync(() => {
          balanceCalls += 1;
          return 99_999;
        }),
      ),
      getPoolState: (addr: string) =>
        addr === POOL_EXIT
          ? Effect.succeed(makePool({ address: addr, tvlUsd: 60_000, fees24hUsd: 300 }))
          : Effect.succeed(makePool({ address: addr })),
      getAllWalletPositions: () =>
        Effect.succeed([
          {
            poolAddress: POOL_EXIT,
            positionPubKey: POS_PUBKEY,
            lowerBinId: 4980,
            upperBinId: 5020,
          },
        ]),
      getPositions: () => Effect.succeed([{ id: POS_PUBKEY }] as never),
    } as AdapterApi;
    const layer = makeTestLayer(adapter, {
      watchlistPools: [POOL_EXIT, POOL_PAPER],
      paperTrading: true,
      paperModeExitLive: true,
      paperPortfolioUsd: PAPER,
      tvlDropExitPct: 0.3,
    });

    const test = Effect.gen(function* () {
      const db = yield* DbService;
      yield* db.savePosition(
        makePosition({
          poolAddress: POOL_EXIT,
          positionPubKey: POS_PUBKEY,
          positionId: POS_PUBKEY,
          lowerBinId: 4980,
          upperBinId: 5020,
          depositedUsd: 1_000,
          currentValueUsd: 1_000,
        }),
      );
      yield* db.saveSnapshot({
        poolAddress: POOL_EXIT,
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
      });
      yield* Effect.raceFirst(program, Effect.sleep(2_000));
      const audit = yield* AuditService;
      const state = yield* AgentStateService;
      const decisions = yield* audit.getRecentDecisions(100);
      const snapshot = yield* state.getSnapshot();
      return { decisions: decisions as unknown as FullDecision[], snapshot };
    });
    const { decisions, snapshot } = await Effect.runPromise(
      Effect.provide(test, layer) as Effect.Effect<
        { decisions: FullDecision[]; snapshot: PrismStateSnapshot },
        unknown,
        never
      >,
    );

    expect(
      decisions.some((d) => d.poolAddress === POOL_EXIT && d.action === "EXIT" && d.executed),
      "the hybrid live exit must still execute",
    ).toBe(true);
    expect(
      balanceCalls,
      "a paper cycle must never perform a chain wallet re-capture after a hybrid exit",
    ).toBe(0);
    expect(snapshot.portfolio.walletBalanceUsd, "paper sizing stays on paperPortfolioUsd").toBe(
      PAPER,
    );
    expect(
      decisions.some((d) => d.poolAddress === POOL_PAPER),
      "later paper pools still evaluate normally",
    ).toBe(true);
  }, 15_000);
});
