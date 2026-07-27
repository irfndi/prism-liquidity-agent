import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { DbLive, type PositionRecord } from "../engine/db-service.js";
import { program } from "../engine/program.js";
import {
  computeEntrySizeUsd,
  computeIdleRedeploySizeUsd,
  ENTRY_SIZE_CAP_USD,
  ENTRY_SIZE_FLOOR_USD,
  ENTRY_SIZE_TVL_FRACTION,
  ENTRY_SIZE_WALLET_FRACTION,
} from "../engine/entry-sizing.js";
import { StrategyLive } from "../engine/strategy-service.js";
import { MemoryLive } from "../engine/memory-service.js";
import { RiskLive } from "../engine/risk-service.js";
import { AuditLive } from "../engine/audit-service.js";
import { AlertLive } from "../engine/alert-service.js";
import { AgentNoOp } from "../engine/agent-service.js";
import { AgentStateMutable } from "../engine/state-service.js";
import { ConfigService, type AppConfig } from "../engine/config-service.js";
import {
  AdapterService,
  BlacklistService,
  AuditService,
  ScreenerService,
  DbService,
  type DbApi,
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
  type MeteoraDatapiApi,
  type MeteoraPoolStats,
} from "../engine/services.js";
import type { PoolState } from "../engine/types.js";
import { defaultAppConfig, makePool, makeBinArray } from "./helpers.js";

// ─── Pure entry sizing ───────────────────────────────────────────────────────

describe("computeEntrySizeUsd — legacy-identical conservative sizing", () => {
  it("wallet-fraction binds: half the wallet below TVL and cap", () => {
    expect(computeEntrySizeUsd({ walletBalanceUsd: 600, tvlUsd: 1_000_000_000 })).toBe(300);
  });

  it("TVL-fraction binds: 0.5% of TVL below wallet-half and cap", () => {
    expect(computeEntrySizeUsd({ walletBalanceUsd: 100_000, tvlUsd: 40_000 })).toBe(200);
  });

  it("the $500 cap binds above both fractions", () => {
    expect(ENTRY_SIZE_CAP_USD).toBe(500);
    expect(computeEntrySizeUsd({ walletBalanceUsd: 10_000, tvlUsd: 1_000_000 })).toBe(500);
  });

  it("the $10 floor lifts degenerate inputs", () => {
    expect(ENTRY_SIZE_FLOOR_USD).toBe(10);
    expect(computeEntrySizeUsd({ walletBalanceUsd: 10, tvlUsd: 100 })).toBe(10);
    expect(computeEntrySizeUsd({ walletBalanceUsd: 0, tvlUsd: 0 })).toBe(10);
  });

  it("matches the legacy inline formula max(min(w*0.5, tvl*0.005, 500), 10) over a grid", () => {
    for (const walletBalanceUsd of [0, 10, 100, 999, 1000, 10_000, 123_456]) {
      for (const tvlUsd of [0, 1000, 50_000, 100_000, 1_000_000, 12_345_678]) {
        expect(computeEntrySizeUsd({ walletBalanceUsd, tvlUsd })).toBe(
          Math.max(
            Math.min(
              walletBalanceUsd * ENTRY_SIZE_WALLET_FRACTION,
              tvlUsd * ENTRY_SIZE_TVL_FRACTION,
              ENTRY_SIZE_CAP_USD,
            ),
            ENTRY_SIZE_FLOOR_USD,
          ),
        );
      }
    }
  });
});

describe("computeIdleRedeploySizeUsd — widened redeploy size", () => {
  it("half the idle capital binds when portfolio and ceiling are generous", () => {
    expect(
      computeIdleRedeploySizeUsd({
        idleCapitalUsd: 1000,
        portfolioValueUsd: 1_000_000_000,
        maxPerPoolAllocationPct: 1,
        maxSizeUsd: 1_000_000_000,
      }),
    ).toBe(500);
  });

  it("the per-pool allocation share of the portfolio binds for a large idle pile", () => {
    expect(
      computeIdleRedeploySizeUsd({
        idleCapitalUsd: 1_000_000_000,
        portfolioValueUsd: 1000,
        maxPerPoolAllocationPct: 0.4,
        maxSizeUsd: 1_000_000_000,
      }),
    ).toBeCloseTo(400, 10);
  });

  it("the configured idle ceiling binds", () => {
    expect(
      computeIdleRedeploySizeUsd({
        idleCapitalUsd: 1_000_000,
        portfolioValueUsd: 1_000_000,
        maxPerPoolAllocationPct: 1,
        maxSizeUsd: 2000,
      }),
    ).toBe(2000);
  });

  it("floors at zero, never negative", () => {
    expect(
      computeIdleRedeploySizeUsd({
        idleCapitalUsd: 0,
        portfolioValueUsd: 10_000,
        maxPerPoolAllocationPct: 0.4,
        maxSizeUsd: 2000,
      }),
    ).toBe(0);
  });
});

// ─── Program-level: idle-capital redeploy gate ───────────────────────────────

const POOL = "PoolIdleRe111111111111111111111111111111111";

type MintAuthorities = { mintAuthority: string | null; freezeAuthority: string | null };
const NO_AUTHORITIES: MintAuthorities = { mintAuthority: null, freezeAuthority: null };

// A strong Data API payload: passes pre-filter, candidate conditions and the
// weighted-score threshold (the same fixture multi-position tests enter on).
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
    getWalletHoldings: () =>
      Effect.succeed(new Map<string, { amountAtomic: bigint; decimals: number }>()),
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
    paperTrading: true,
    agentMcpEnabled: false,
    agentHttpPort: 0,
    autoUpdate: false,
    scanIntervalMs: 600_000,
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
    Layer.succeed(GeckoTerminalService, { getPoolStats: () => Effect.succeed(null) }),
    Layer.succeed(AlertService, {
      sendAlert: () => Effect.void,
      recordFeeClaim: () => Effect.void,
    }),
  );
}

function makeSeededPosition(overrides: Partial<PositionRecord>): PositionRecord {
  return {
    positionId: overrides.positionId ?? "seeded-pos",
    poolAddress: overrides.poolAddress ?? POOL,
    positionPubKey: null,
    depositedUsd: overrides.depositedUsd ?? 1000,
    currentValueUsd: overrides.currentValueUsd ?? 1000,
    tokenXSymbol: "SOL",
    tokenYSymbol: "USDC",
    activeBinId: 5000,
    lowerBinId: 4980,
    upperBinId: 5020,
    timestamp: Date.now(),
    outOfRangeSince: null,
    oorCycleCount: 0,
    lastFeeClaimAt: Date.now(),
    trailingStopThreshold: null,
    highestValueUsd: null,
    lastRebalanceAt: 0,
    paperExitedAt: null,
    entrySignalTimestamp: null,
    entrySignalSnapshotId: null,
    entryPriceUsd: 150,
    entryAmountXUsd: 500,
    entryAmountYUsd: 500,
    cumulativeFeesClaimedUsd: 0,
    cumulativeRewardsClaimedUsd: 0,
    closedAt: null,
    realizedPnlUsd: null,
    ...overrides,
  };
}

interface CycleResult {
  readonly positions: ReadonlyArray<PositionRecord>;
  readonly decisions: ReadonlyArray<{
    action: string;
    executed: boolean;
    reasoning: string;
    poolAddress: string;
  }>;
}

/** Run exactly one scan cycle (long scanInterval → no second cycle in window). */
function runOneCycle(
  layer: Layer.Layer<unknown, never, never>,
  seed: (db: DbApi) => Effect.Effect<void, unknown> = () => Effect.void,
): Promise<CycleResult> {
  const test = Effect.gen(function* () {
    const db = yield* DbService;
    yield* seed(db);
    yield* Effect.raceFirst(program, Effect.sleep(1_500));
    const audit = yield* AuditService;
    const positions = yield* db.getAllPositions();
    const decisions = yield* audit.getRecentDecisions(200);
    return { positions, decisions };
  });
  return Effect.runPromise(
    Effect.provide(test, layer) as Effect.Effect<CycleResult, unknown, never>,
  );
}

describe("program — idle-capital auto-redeploy gate", () => {
  it("is inert when disabled (default): idle capital present, no redeploy, one normal ENTER only", async () => {
    const layer = makeProgramLayer({
      adapter: makeProgramAdapter({ [POOL]: makePool({ address: POOL }) }),
      datapi: { getPoolData: () => Effect.succeed(makeDatapiStats()) },
      configOverrides: {
        watchlistPools: [POOL],
        maxPositionsPerPool: 2,
        maxOpenPositions: 5,
        // idleRedeployEnabled defaults to false; idle = 10_000 − 500 ≫ 500.
      },
    });
    const { positions, decisions } = await runOneCycle(layer as never);

    expect(positions).toHaveLength(1);
    expect(positions[0]!.depositedUsd).toBe(500);
    expect(decisions.some((d) => d.reasoning.includes("[idle-redeploy]"))).toBe(false);
  }, 15_000);

  it("deploys idle capital into the qualified candidate at the widened size when enabled", async () => {
    const layer = makeProgramLayer({
      adapter: makeProgramAdapter({ [POOL]: makePool({ address: POOL }) }),
      datapi: { getPoolData: () => Effect.succeed(makeDatapiStats()) },
      configOverrides: {
        watchlistPools: [POOL],
        idleRedeployEnabled: true,
        idleRedeployThresholdUsd: 500,
        idleRedeployMaxSizeUsd: 2000,
        maxPositionsPerPool: 2,
        maxOpenPositions: 5,
      },
    });
    const { positions, decisions } = await runOneCycle(layer as never);

    // Normal conservative ENTER ($500) + exactly one widened redeploy:
    // idle = 10_000 − 500 = 9_500 > 500 → widened min(4_750, 10_500×0.4, 2_000)
    // = 2_000, within allocation headroom (4_200 − 500) and risk gate 6.
    expect(positions).toHaveLength(2);
    const sizes = positions.map((p) => p.depositedUsd).sort((a, b) => a - b);
    expect(sizes).toEqual([500, 2000]);

    const redeployExecuted = decisions.filter(
      (d) => d.reasoning.includes("[idle-redeploy]") && d.executed && d.action === "ENTER",
    );
    expect(redeployExecuted).toHaveLength(1);
    expect(redeployExecuted[0]!.poolAddress).toBe(POOL);
  }, 15_000);

  it("lets the allocation gate shrink the widened size to the pool's remaining headroom", async () => {
    const layer = makeProgramLayer({
      adapter: makeProgramAdapter({ [POOL]: makePool({ address: POOL }) }),
      datapi: { getPoolData: () => Effect.succeed(makeDatapiStats()) },
      configOverrides: {
        watchlistPools: [POOL],
        idleRedeployEnabled: true,
        idleRedeployThresholdUsd: 100,
        idleRedeployMaxSizeUsd: 2000,
        // Tight portfolio: normal ENTER $500 (min(750, 1000, 500)); idle
        // 1_500 − 500 = 1_000 → widened min(500, 2_000×0.4=800, 2_000) = 500,
        // but headroom = 800 − 500 = 300 → allocation caps the redeploy to 300.
        paperPortfolioUsd: 1500,
        maxPositionsPerPool: 2,
        maxOpenPositions: 5,
      },
    });
    const { positions } = await runOneCycle(layer as never);

    expect(positions).toHaveLength(2);
    const sizes = positions.map((p) => p.depositedUsd).sort((a, b) => a - b);
    expect(sizes).toEqual([300, 500]);
  }, 15_000);

  it("skips the pass when idle capital is below the threshold", async () => {
    const layer = makeProgramLayer({
      adapter: makeProgramAdapter({ [POOL]: makePool({ address: POOL }) }),
      datapi: { getPoolData: () => Effect.succeed(makeDatapiStats()) },
      configOverrides: {
        watchlistPools: [POOL],
        idleRedeployEnabled: true,
        // Normal ENTER min(400, 1000, 500) = 400; idle 800 − 400 = 400 ≤ 2_000.
        paperPortfolioUsd: 800,
        idleRedeployThresholdUsd: 2000,
        maxPositionsPerPool: 2,
        maxOpenPositions: 5,
      },
    });
    const { positions, decisions } = await runOneCycle(layer as never);

    expect(positions).toHaveLength(1);
    expect(decisions.some((d) => d.reasoning.includes("[idle-redeploy]"))).toBe(false);
  }, 15_000);

  it("is rejected by the caps it routes through: MAX_OPEN_POSITIONS full writes an audit record and opens nothing", async () => {
    const layer = makeProgramLayer({
      adapter: makeProgramAdapter({ [POOL]: makePool({ address: POOL }) }),
      datapi: { getPoolData: () => Effect.succeed(makeDatapiStats()) },
      configOverrides: {
        watchlistPools: [POOL],
        idleRedeployEnabled: true,
        maxPositionsPerPool: 2,
        maxOpenPositions: 1,
      },
    });
    // An in-range, healthy seeded position fills the single open slot. The
    // pool still passes candidate conditions, its normal ENTER is rejected by
    // allocation (capturing it), and the redeploy pass hits the max-open cap.
    const { positions, decisions } = await runOneCycle(layer as never, (db) =>
      Effect.gen(function* () {
        yield* db.savePosition(makeSeededPosition({}));
      }),
    );

    expect(positions).toHaveLength(1);
    expect(positions[0]!.positionId).toBe("seeded-pos");

    const redeployDecisions = decisions.filter((d) => d.reasoning.includes("[idle-redeploy]"));
    expect(redeployDecisions).toHaveLength(1);
    expect(redeployDecisions[0]!.executed).toBe(false);
    expect(redeployDecisions[0]!.reasoning).toContain("max open positions");
  }, 15_000);

  it("does not capture a cooldown-gated candidate: no redeploy despite idle capital", async () => {
    const layer = makeProgramLayer({
      adapter: makeProgramAdapter({ [POOL]: makePool({ address: POOL }) }),
      datapi: { getPoolData: () => Effect.succeed(makeDatapiStats()) },
      configOverrides: {
        watchlistPools: [POOL],
        idleRedeployEnabled: true,
        idleRedeployThresholdUsd: 500,
        maxPositionsPerPool: 2,
        maxOpenPositions: 5,
      },
    });
    const { positions, decisions } = await runOneCycle(layer as never, (db) =>
      Effect.gen(function* () {
        yield* db.setPoolCooldown({
          poolAddress: POOL,
          cooldownUntil: Date.now() + 3_600_000,
          reason: "Low yield exit",
          consecutiveOorExits: 1,
        });
      }),
    );

    expect(positions).toHaveLength(0);
    expect(decisions.some((d) => d.reasoning.includes("[idle-redeploy]"))).toBe(false);
  }, 15_000);
});
