import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { estimatePaperRebalanceBenefit, executeLive, program } from "../engine/program.js";
import { AdapterError } from "../engine/errors.js";
import { DbLive } from "../engine/db-service.js";
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
  GeckoTerminalService,
  AlertService,
  type AdapterApi,
  type StrategyApi,
  type RevenueConfigApi,
  type EntryPrepApi,
  type DbApi,
  type MemoryApi,
  type MeteoraDatapiApi,
} from "../engine/services.js";
import type { AgentDecision } from "../engine/types.js";
import type { PositionRecord } from "../engine/db-service.js";
import { defaultAppConfig, makePool, makeBinArray, makePosition } from "./helpers.js";
import { stringifySafe } from "../engine/bigint-json.js";

// ─── Paper heuristic (decision-layer estimate for simulated mode) ────────────

describe("estimatePaperRebalanceBenefit", () => {
  it("scales pool fees by range capture ratio and reports a pool-heuristic source", () => {
    const est = estimatePaperRebalanceBenefit({
      fees24hUsd: 300,
      newLowerBinId: 4980,
      newUpperBinId: 5020,
    });
    expect(est.source).toBe("pool-heuristic");
    expect(est.estimatedFeesUsd).toBeCloseTo(300 * 0.4, 8);
    expect(est.estimatedCostUsd).toBeCloseTo(0.5, 8);
    expect(est.netBenefitUsd).toBeCloseTo(300 * 0.4 - 0.5, 8);
  });

  it("caps the capture ratio at the full pool for wide ranges", () => {
    const est = estimatePaperRebalanceBenefit({
      fees24hUsd: 300,
      newLowerBinId: 4900,
      newUpperBinId: 5100,
    });
    expect(est.estimatedFeesUsd).toBeCloseTo(300, 8);
  });
});

// ─── executeLive REBALANCE: identity preservation + accounting ──────────────

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
    simulateRebalance: () => Effect.fail(new Error("not used")),
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
    rebalancePosition: () =>
      Effect.succeed({ positionPubKey: "pos-1", txSignatures: ["tx-atomic-1"] }),
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

const livePool = {
  activeBinId: 5000,
  binStep: 10,
  tokenXSymbol: "SOL",
  tokenYSymbol: "USDC",
  currentPrice: 100,
};

function runDb<T>(effect: Effect.Effect<T, unknown, DbService>): Promise<T> {
  return Effect.runPromise(Effect.provide(effect, DbLive(":memory:")));
}

describe("executeLive REBALANCE (atomic)", () => {
  it("preserves the position pubkey and entry accounting; claims fees exactly once", async () => {
    const trackedPositions = new Map<string, PositionRecord>();
    const deps = {
      adapter: makeLiveAdapter(),
      strategy: liveStrategy,
      db: null as unknown as DbApi,
      revenueConfigSvc: liveRevenueConfig,
      trackedPositions,
      entryPrep: liveEntryPrep,
      solPriceUsd: 150,
      entryStrategyShape: "spot" as const,
    };

    const outcome = await runDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        deps.db = db;

        const enter = yield* executeLive(
          deps,
          {
            action: "ENTER",
            poolAddress: "pool1",
            confidence: 0.8,
            reasoning: "entry",
            positionSizeUsd: 1000,
          },
          livePool,
        );
        expect(enter.executed).toBe(true);

        const rebalance = yield* executeLive(
          deps,
          {
            action: "REBALANCE",
            poolAddress: "pool1",
            confidence: 0.8,
            reasoning: "re-range",
            rebalanceParams: { newLowerBinId: 4990, newUpperBinId: 5030, slippageBps: 50 },
          },
          livePool,
        );
        expect(rebalance.executed).toBe(true);

        const events = yield* db.getPositionEvents("pool1");
        return { tracked: trackedPositions.get("pos-1"), events };
      }),
    );

    const tracked = outcome.tracked!;
    // Atomic rebalance keeps the same position account — W4 entry accounting
    // and cumulative fee state survive untouched.
    expect(tracked.positionPubKey).toBe("pos-1");
    expect(tracked.lowerBinId).toBe(4990);
    expect(tracked.upperBinId).toBe(5030);
    expect(tracked.entryPriceUsd).toBe(100);
    expect(tracked.entryAmountXUsd).toBeCloseTo(500, 8);
    expect(tracked.entryAmountYUsd).toBeCloseTo(500, 8);
    expect(tracked.cumulativeFeesClaimedUsd).toBeCloseTo(25, 8);

    expect(outcome.events.map((e) => e.event)).toEqual(["ENTER", "CLAIM", "REBALANCE"]);
    const claimEvents = outcome.events.filter((e) => e.event === "CLAIM");
    expect(claimEvents).toHaveLength(1);
    expect(claimEvents[0]!.feesUsd).toBeCloseTo(25, 8);
    const rebalanceEvent = outcome.events[2]!;
    expect(rebalanceEvent.positionPubKey).toBe("pos-1");
    expect(rebalanceEvent.metadata).toContain("4990");
    expect(rebalanceEvent.metadata).toContain("tx-atomic-1");
  });

  it("flags the pool for reconcile and leaves state intact when the atomic rebalance fails", async () => {
    const trackedPositions = new Map<string, PositionRecord>();
    const reconcileRequestedPools = new Set<string>();
    const deps = {
      adapter: makeLiveAdapter({
        claimFees: () =>
          Effect.succeed({
            txSignature: "",
            feeX: 0,
            feeY: 0,
            platformFeeX: 0,
            platformFeeY: 0,
            netFeeX: 0,
            netFeeY: 0,
          }),
        rebalancePosition: () =>
          Effect.fail(new AdapterError({ message: "atomic simulation reverted" })),
      }),
      strategy: liveStrategy,
      db: null as unknown as DbApi,
      revenueConfigSvc: liveRevenueConfig,
      trackedPositions,
      entryPrep: liveEntryPrep,
      solPriceUsd: 150,
      entryStrategyShape: "spot" as const,
      reconcileRequestedPools,
    };

    const outcome = await runDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        deps.db = db;

        const enter = yield* executeLive(
          deps,
          {
            action: "ENTER",
            poolAddress: "pool1",
            confidence: 0.8,
            reasoning: "entry",
            positionSizeUsd: 1000,
          },
          livePool,
        );
        expect(enter.executed).toBe(true);

        const rebalance = yield* executeLive(
          deps,
          {
            action: "REBALANCE",
            poolAddress: "pool1",
            confidence: 0.8,
            reasoning: "re-range",
            rebalanceParams: { newLowerBinId: 4990, newUpperBinId: 5030, slippageBps: 50 },
          },
          livePool,
        );
        const events = yield* db.getPositionEvents("pool1");
        return { rebalance, tracked: trackedPositions.get("pos-1"), events };
      }),
    );

    expect(outcome.rebalance.executed).toBe(false);
    expect(outcome.rebalance.error).toContain("atomic simulation reverted");
    // Flagged for the next reconcile sweep.
    expect([...reconcileRequestedPools]).toEqual(["pool1"]);
    // No half-updated state: record, range, identity and accounting intact.
    const tracked = outcome.tracked!;
    expect(tracked.positionPubKey).toBe("pos-1");
    expect(tracked.lowerBinId).toBe(4980);
    expect(tracked.upperBinId).toBe(5020);
    expect(tracked.entryPriceUsd).toBe(100);
    expect(tracked.cumulativeFeesClaimedUsd).toBe(0);
    // No REBALANCE event row was written.
    expect(outcome.events.map((e) => e.event)).toEqual(["ENTER"]);
  });
});

// ─── Full-loop gate: simulation output drives the rebalance decision ────────

type MintAuthorities = { mintAuthority: string | null; freezeAuthority: string | null };
const NO_AUTHORITIES: MintAuthorities = { mintAuthority: null, freezeAuthority: null };

function makeLoopAdapter(opts: {
  pools: Record<string, ReturnType<typeof makePool>>;
  onChainPositions: Array<{
    poolAddress: string;
    positionPubKey: string;
    lowerBinId: number;
    upperBinId: number;
  }>;
  simulateRebalance: AdapterApi["simulateRebalance"];
  rebalancePosition?: AdapterApi["rebalancePosition"];
}): AdapterApi {
  return {
    hasWallet: () => true,
    getWalletAddress: () => "Wallet111",
    getWalletBalanceUsd: () => Effect.succeed(10_000),
    getNativeSolBalance: () => Effect.succeed(10_000_000_000n),
    getPoolState: (addr: string) => {
      const pool = opts.pools[addr];
      return pool ? Effect.succeed(pool) : Effect.fail(new Error(`unknown pool ${addr}`));
    },
    getBinArray: () => Effect.succeed(makeBinArray()),
    getPositions: (poolAddress: string) =>
      Effect.succeed(
        opts.onChainPositions
          .filter((p) => p.poolAddress === poolAddress)
          .map((p) => ({
            id: p.positionPubKey,
            poolAddress: p.poolAddress,
            poolName: "SOL/USDC",
            lowerBinId: p.lowerBinId,
            upperBinId: p.upperBinId,
            liquidityShares: 0n,
            depositedUsd: 1_000,
            currentValueUsd: 1_000,
            unrealizedPnlUsd: 0,
            feesEarnedUsd: 0,
            openedAt: Date.now(),
          })),
      ),
    getAllWalletPositions: () => Effect.succeed(opts.onChainPositions),
    simulateRebalance: opts.simulateRebalance,
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
    rebalancePosition:
      opts.rebalancePosition ??
      (() => Effect.succeed({ positionPubKey: "pos-1", txSignatures: ["tx-atomic"] })),
    claimFees: () =>
      Effect.succeed({
        txSignature: "",
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

function makeLoopLayer(opts: {
  adapter: AdapterApi;
  configOverrides?: Partial<AppConfig>;
  datapi?: MeteoraDatapiApi;
}) {
  const config = defaultAppConfig({
    scanIntervalMs: 3_600_000,
    paperTrading: false,
    agentMcpEnabled: false,
    agentHttpPort: 0,
    ...opts.configOverrides,
  });
  const dbLayer = DbLive(":memory:");
  return Layer.mergeAll(
    Layer.succeed(ConfigService, config),
    Layer.succeed(AdapterService, opts.adapter),
    StrategyLive,
    Layer.provide(MemoryLive, dbLayer),
    RiskLive({
      confidenceThreshold: 0.65,
      maxRebalanceRangeBins: 50,
      // Relaxed for these fixtures: the engine's value heuristic writes any
      // OOR position down 50%, which would trip the default stop-loss before
      // the rebalance gate being tested here.
      stopLossPct: 0.6,
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
    Layer.succeed(GeckoTerminalService, { getPoolStats: () => Effect.succeed(null) }),
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

const GATE_POOL = "PoolAtomicGate11111111111111111111111111111";
const GATE_POS = "pos-gate-1";

const gateConfigOverrides: Partial<AppConfig> = {
  watchlistPools: [GATE_POOL],
  minRebalanceIntervalMs: 0,
  // Isolate the net-benefit gate: never hold for recovery, never force.
  oorRecoveryHoldThreshold: 1.1,
  oorRecoveryForceRebalanceThreshold: -1,
  rebalanceGasCostSol: 0.000001, // gas gate always approves
  minRebalanceNetBenefitUsd: 10,
  // The value heuristic writes a deeply-OOR position down ~50%; keep the
  // trailing stop from preempting the rebalance decision under test.
  trailingStopPct: 0.6,
};

function seedGatePosition(): PositionRecord {
  // Deeply out-of-range position: active bin 5000, range [4900, 4920].
  // (helpers.makePosition hardcodes the range, so override it afterwards.)
  return {
    ...makePosition({
      poolAddress: GATE_POOL,
      positionPubKey: GATE_POS,
      depositedUsd: 1_000,
      currentValueUsd: 1_000,
      entryPriceUsd: 150,
      entryAmountXUsd: 500,
      entryAmountYUsd: 500,
    }),
    lowerBinId: 4900,
    upperBinId: 4920,
  };
}

describe("rebalance gate consumes the SDK simulation (live loop)", () => {
  it("executes an atomic REBALANCE when simulated net benefit clears the threshold", async () => {
    const simCalls: Array<{
      poolAddress: string;
      positionPubKey: string;
      newLowerBinId: number;
      newUpperBinId: number;
    }> = [];
    const rebalanceCalls: Array<{
      poolAddress: string;
      positionPubKey: string;
      newLowerBinId: number;
      newUpperBinId: number;
    }> = [];
    const adapter = makeLoopAdapter({
      pools: {
        [GATE_POOL]: makePool({ address: GATE_POOL, activeBinId: 5000, fees24hUsd: 2_000 }),
      },
      onChainPositions: [
        { poolAddress: GATE_POOL, positionPubKey: GATE_POS, lowerBinId: 4900, upperBinId: 4920 },
      ],
      simulateRebalance: (poolAddress, positionPubKey, newLowerBinId, newUpperBinId) => {
        simCalls.push({ poolAddress, positionPubKey, newLowerBinId, newUpperBinId });
        return Effect.succeed({
          estimatedFeesUsd: 50,
          estimatedCostUsd: 5,
          netBenefitUsd: 45,
          source: "sdk-simulation" as const,
        });
      },
      rebalancePosition: (poolAddress, positionPubKey, newLowerBinId, newUpperBinId) => {
        rebalanceCalls.push({ poolAddress, positionPubKey, newLowerBinId, newUpperBinId });
        return Effect.succeed({ positionPubKey: GATE_POS, txSignatures: ["tx-atomic"] });
      },
    });
    const layer = makeLoopLayer({ adapter, configOverrides: gateConfigOverrides });

    const outcome = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const db = yield* DbService;
          yield* db.savePosition(seedGatePosition());
          yield* Effect.raceFirst(program, Effect.sleep(2_000));
          const audit = yield* AuditService;
          const decisions = yield* audit.getRecentDecisions(50);
          const positions = yield* db.getAllPositions();
          const events = yield* db.getPositionEvents(GATE_POOL);
          return { decisions, positions, events };
        }),
        layer,
      ) as Effect.Effect<
        {
          decisions: ReadonlyArray<DecisionRow>;
          positions: ReadonlyArray<PositionRecord>;
          events: ReadonlyArray<{ event: string; positionPubKey: string | null }>;
        },
        unknown,
        never
      >,
    );

    // The simulation ran against the tracked position's real pubkey.
    expect(simCalls.length).toBeGreaterThan(0);
    expect(simCalls[0]!.poolAddress).toBe(GATE_POOL);
    expect(simCalls[0]!.positionPubKey).toBe(GATE_POS);

    const rebalances = outcome.decisions.filter(
      (d) => d.poolAddress === GATE_POOL && d.action === "REBALANCE",
    );
    expect(
      rebalances.length,
      `expected an executed REBALANCE decision: ${stringifySafe(outcome.decisions)}`,
    ).toBeGreaterThan(0);
    expect(rebalances[0]!.executed).toBe(true);

    // Atomic execution against the same position identity and the simulated range.
    expect(rebalanceCalls).toHaveLength(1);
    expect(rebalanceCalls[0]!.positionPubKey).toBe(GATE_POS);
    expect(rebalanceCalls[0]!.newLowerBinId).toBe(simCalls[0]!.newLowerBinId);
    expect(rebalanceCalls[0]!.newUpperBinId).toBe(simCalls[0]!.newUpperBinId);

    // Position record: range updated, identity + entry accounting preserved.
    const pos = outcome.positions.find((p) => p.poolAddress === GATE_POOL)!;
    expect(pos.positionPubKey).toBe(GATE_POS);
    expect(pos.lowerBinId).toBe(simCalls[0]!.newLowerBinId);
    expect(pos.upperBinId).toBe(simCalls[0]!.newUpperBinId);
    expect(pos.entryPriceUsd).toBe(150);
    expect(pos.entryAmountXUsd).toBe(500);
    expect(pos.entryAmountYUsd).toBe(500);

    const rebalanceEvents = outcome.events.filter((e) => e.event === "REBALANCE");
    expect(rebalanceEvents).toHaveLength(1);
    expect(rebalanceEvents[0]!.positionPubKey).toBe(GATE_POS);
  }, 15_000);

  it("skips the rebalance when simulated net benefit is below the threshold", async () => {
    let simCalled = 0;
    let rebalanceCalled = 0;
    const adapter = makeLoopAdapter({
      pools: {
        [GATE_POOL]: makePool({ address: GATE_POOL, activeBinId: 5000, fees24hUsd: 2_000 }),
      },
      onChainPositions: [
        { poolAddress: GATE_POOL, positionPubKey: GATE_POS, lowerBinId: 4900, upperBinId: 4920 },
      ],
      simulateRebalance: () => {
        simCalled++;
        return Effect.succeed({
          estimatedFeesUsd: 8,
          estimatedCostUsd: 5,
          netBenefitUsd: 3,
          source: "sdk-simulation" as const,
        });
      },
      rebalancePosition: () => {
        rebalanceCalled++;
        return Effect.succeed({ positionPubKey: GATE_POS, txSignatures: ["tx-atomic"] });
      },
    });
    const layer = makeLoopLayer({ adapter, configOverrides: gateConfigOverrides });

    const decisions = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const db = yield* DbService;
          yield* db.savePosition(seedGatePosition());
          yield* Effect.raceFirst(program, Effect.sleep(2_000));
          const audit = yield* AuditService;
          return yield* audit.getRecentDecisions(50);
        }),
        layer,
      ) as Effect.Effect<ReadonlyArray<DecisionRow>, unknown, never>,
    );

    // The simulation ran and fed the gate...
    expect(simCalled).toBeGreaterThan(0);
    // ...but the below-threshold result held the rebalance.
    expect(rebalanceCalled).toBe(0);
    const rebalances = decisions.filter(
      (d) => d.poolAddress === GATE_POOL && d.action === "REBALANCE",
    );
    expect(
      rebalances,
      `no REBALANCE expected below the net-benefit threshold: ${stringifySafe(decisions)}`,
    ).toHaveLength(0);
  }, 15_000);
});
