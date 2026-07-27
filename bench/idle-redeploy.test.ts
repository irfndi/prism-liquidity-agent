import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { DbLive, type PositionRecord } from "../engine/db-service.js";
import { program, computeIdleRedeployConfidence } from "../engine/program.js";
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
  AgentStateService,
  McpServerService,
  HttpStatusServerService,
  EntryPrepService,
  MeteoraDatapiService,
  GeckoTerminalService,
  AlertService,
  type AdapterApi,
  type AgentApi,
  type GeckoTerminalApi,
  type MeteoraDatapiApi,
  type MeteoraPoolStats,
} from "../engine/services.js";
import type { AgentDecision, PoolState } from "../engine/types.js";
import { USDC_MINT } from "../engine/constants.js";
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
  agentApi?: AgentApi;
  agentStateLayer?: Layer.Layer<AgentStateService, never, never>;
  gecko?: GeckoTerminalApi;
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
    Layer.succeed(AgentService, opts.agentApi ?? AgentNoOp),
    opts.agentStateLayer ?? AgentStateMutable({ maxPendingProposals: 50 }).layer,
    Layer.succeed(McpServerService, { start: () => Effect.void, stop: () => Effect.void }),
    Layer.succeed(HttpStatusServerService, { start: () => Effect.void, stop: () => Effect.void }),
    Layer.succeed(EntryPrepService, { prepareEntryTokens: () => Effect.void }),
    Layer.succeed(MeteoraDatapiService, opts.datapi ?? { getPoolData: () => Effect.succeed(null) }),
    Layer.succeed(GeckoTerminalService, opts.gecko ?? { getPoolStats: () => Effect.succeed(null) }),
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
    confidence: number;
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

  it("skips when the post-cap widened size does not exceed the normal entry (P2 3654054429)", async () => {
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
        // but headroom = 800 − 500 = 300 → allocation caps the redeploy to 300,
        // which is ≤ the normal entry size ($500). The widened-size guard now
        // skips it — a smaller second position would fragment capital despite
        // the feature being a WIDER entry.
        paperPortfolioUsd: 1500,
        maxPositionsPerPool: 2,
        maxOpenPositions: 5,
      },
    });
    const { positions, decisions } = await runOneCycle(layer as never);

    // Only the normal ENTER opens; the sub-normal redeploy is skipped.
    expect(positions).toHaveLength(1);
    expect(positions[0]!.depositedUsd).toBe(500);
    const redeploySkips = decisions.filter(
      (d) => d.reasoning.includes("[idle-redeploy]") && !d.executed,
    );
    expect(redeploySkips.length).toBeGreaterThanOrEqual(1);
    expect(redeploySkips.some((d) => d.reasoning.includes("does not exceed normal entry"))).toBe(
      true,
    );
  }, 15_000);

  it("dispatches when the post-cap widened size just exceeds the normal entry (P2 3654054429)", async () => {
    const layer = makeProgramLayer({
      adapter: makeProgramAdapter({ [POOL]: makePool({ address: POOL }) }),
      datapi: { getPoolData: () => Effect.succeed(makeDatapiStats()) },
      configOverrides: {
        watchlistPools: [POOL],
        idleRedeployEnabled: true,
        idleRedeployThresholdUsd: 100,
        // Normal ENTER $500 (min(5000, 1000, 500)); idle 10_000 − 500 = 9_500.
        // Ceiling pins the widened size at $600 — just ABOVE the normal $500 — so
        // the size guard passes and the redeploy dispatches.
        idleRedeployMaxSizeUsd: 600,
        maxPositionsPerPool: 2,
        maxOpenPositions: 5,
      },
    });
    const { positions } = await runOneCycle(layer as never);

    expect(positions).toHaveLength(2);
    const sizes = positions.map((p) => p.depositedUsd).sort((a, b) => a - b);
    expect(sizes).toEqual([500, 600]);
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

// ─── Redeploy confidence (P2 3654054423) — modeled fee/IL gets no vote ───────

describe("computeIdleRedeployConfidence — modeled fee/IL excluded", () => {
  it("measured (datapi) ratio: fee-aware formula, capped at 0.85", () => {
    expect(computeIdleRedeployConfidence({ feeIlRatio: 0, feeIlRatioKnown: true })).toBe(0.5);
    expect(computeIdleRedeployConfidence({ feeIlRatio: 2, feeIlRatioKnown: true })).toBeCloseTo(
      0.6,
      10,
    );
    expect(computeIdleRedeployConfidence({ feeIlRatio: 7, feeIlRatioKnown: true })).toBe(0.85);
    expect(computeIdleRedeployConfidence({ feeIlRatio: 20, feeIlRatioKnown: true })).toBe(0.85);
  });

  it("modeled (gecko) ratio: exactly the neutral base regardless of the value", () => {
    // A modeled-high ratio must NOT raise confidence...
    expect(computeIdleRedeployConfidence({ feeIlRatio: 20, feeIlRatioKnown: false })).toBe(0.5);
    expect(computeIdleRedeployConfidence({ feeIlRatio: 8, feeIlRatioKnown: false })).toBe(0.5);
    // ...and a modeled-low ratio must NOT lower it.
    expect(computeIdleRedeployConfidence({ feeIlRatio: 0, feeIlRatioKnown: false })).toBe(0.5);
    expect(computeIdleRedeployConfidence({ feeIlRatio: 0.1, feeIlRatioKnown: false })).toBe(0.5);
  });
});

// ─── Program: redeploy agent-overlay routing (P1 3654054419) ─────────────────

describe("program — idle-redeploy agent-overlay routing (P1)", () => {
  const redeployOn = {
    idleRedeployEnabled: true,
    idleRedeployThresholdUsd: 500,
    idleRedeployMaxSizeUsd: 2000,
    maxPositionsPerPool: 2,
    maxOpenPositions: 5,
  };

  it("AGENTIC_MODE=false (default): overlay never consulted — redeploy dispatches unchanged", async () => {
    const layer = makeProgramLayer({
      adapter: makeProgramAdapter({ [POOL]: makePool({ address: POOL }) }),
      datapi: { getPoolData: () => Effect.succeed(makeDatapiStats()) },
      configOverrides: { watchlistPools: [POOL], ...redeployOn },
    });
    const { positions, decisions } = await runOneCycle(layer as never);

    expect(positions).toHaveLength(2);
    expect(decisions.some((d) => d.reasoning.includes("[idle-redeploy]") && d.executed)).toBe(true);
    expect(decisions.some((d) => d.reasoning.includes("[supervised]"))).toBe(false);
  }, 15_000);

  it("supervised mode without an approved proposal: redeploy held → skipped with audit", async () => {
    const layer = makeProgramLayer({
      adapter: makeProgramAdapter({ [POOL]: makePool({ address: POOL }) }),
      datapi: { getPoolData: () => Effect.succeed(makeDatapiStats()) },
      configOverrides: {
        watchlistPools: [POOL],
        ...redeployOn,
        agentiveMode: true,
        agentProposalMode: "supervised",
      },
      // Default agent-state layer carries no pending/approved proposals.
    });
    const { positions, decisions } = await runOneCycle(layer as never);

    // Supervised mode without approval holds EVERY ENTER — the normal one too —
    // so nothing opens; the redeploy specifically records the [supervised] skip.
    expect(positions).toHaveLength(0);
    const redeploy = decisions.filter((d) => d.reasoning.includes("[idle-redeploy]"));
    expect(redeploy.length).toBeGreaterThanOrEqual(1);
    expect(redeploy.every((d) => !d.executed)).toBe(true);
    expect(redeploy.some((d) => d.reasoning.includes("[supervised]"))).toBe(true);
  }, 15_000);

  it("veto forcing HOLD: redeploy skipped (a vetoed entry means don't enter)", async () => {
    const layer = makeProgramLayer({
      adapter: makeProgramAdapter({ [POOL]: makePool({ address: POOL }) }),
      datapi: { getPoolData: () => Effect.succeed(makeDatapiStats()) },
      configOverrides: {
        watchlistPools: [POOL],
        ...redeployOn,
        agentiveMode: true,
        agentProposalMode: "veto",
      },
      // Veto targets the redeploy entry only; the normal ENTER is left to the
      // deterministic path (enhance returns null → no change).
      agentApi: {
        ...AgentNoOp,
        enhanceDecision: (decision) =>
          Effect.succeed(
            decision.reasoning.includes("[idle-redeploy]")
              ? { action: "HOLD", poolAddress: POOL, confidence: 0.3, reasoning: "vetoed" }
              : null,
          ),
      },
    });
    const { positions, decisions } = await runOneCycle(layer as never);

    expect(positions).toHaveLength(1); // normal ENTER opens; vetoed redeploy skips
    const redeploy = decisions.filter((d) => d.reasoning.includes("[idle-redeploy]"));
    expect(redeploy.some((d) => d.reasoning.includes("vetoed to HOLD"))).toBe(true);
    expect(redeploy.every((d) => !d.executed)).toBe(true);
  }, 15_000);

  it("veto lowering confidence: still routed through the risk confidence gate (no dispatch)", async () => {
    const layer = makeProgramLayer({
      adapter: makeProgramAdapter({ [POOL]: makePool({ address: POOL }) }),
      datapi: { getPoolData: () => Effect.succeed(makeDatapiStats()) },
      configOverrides: {
        watchlistPools: [POOL],
        ...redeployOn,
        agentiveMode: true,
        agentProposalMode: "veto",
      },
      agentApi: {
        ...AgentNoOp,
        enhanceDecision: (decision) =>
          Effect.succeed(
            decision.reasoning.includes("[idle-redeploy]")
              ? {
                  action: "ENTER",
                  poolAddress: POOL,
                  confidence: 0.1, // below the 0.65 confidence threshold
                  reasoning: "veto nudged confidence down",
                  positionSizeUsd: 2000,
                }
              : null,
          ),
      },
    });
    const { positions, decisions } = await runOneCycle(layer as never);

    // No redeploy opened; the vetoed confidence is replaced onto the decision and
    // flows to risk.evaluate (NOT the supervised/veto-HOLD skip path), where the
    // confidence gate rejects it.
    expect(positions).toHaveLength(1);
    const rejectedLowConfidenceEnter = decisions.some(
      (d) => d.poolAddress === POOL && d.action === "ENTER" && !d.executed && d.confidence < 0.65,
    );
    expect(rejectedLowConfidenceEnter).toBe(true);
    expect(
      decisions.some(
        (d) => d.reasoning.includes("[supervised]") || d.reasoning.includes("vetoed to HOLD"),
      ),
    ).toBe(false);
  }, 15_000);
});

// ─── Program: redeploy entry-backoff guard (P2 3654054425) ───────────────────

describe("program — idle-redeploy entry-backoff guard (P2)", () => {
  it("skips the redeploy when the pool has an active entry-failure backoff", async () => {
    // Live mode so the normal ENTER's insufficient-funds failure arms the SAME
    // entryFailureBackoff the redeploy guard consults. A $0 native SOL balance
    // makes executeLive bail with "Insufficient SOL for gas" (an
    // isInsufficientTokenBalanceError match) — arming the backoff THIS cycle,
    // after the candidate was captured at decision-build time.
    const usdcHoldings = new Map<string, { amountAtomic: bigint; decimals: number }>();
    usdcHoldings.set(USDC_MINT, { amountAtomic: 9_500_000_000n, decimals: 6 }); // $9,500 idle
    const layer = makeProgramLayer({
      adapter: makeProgramAdapter(
        { [POOL]: makePool({ address: POOL }) },
        {
          hasWallet: () => true,
          getWalletHoldings: () => Effect.succeed(usdcHoldings),
          getNativeSolBalance: () => Effect.succeed(0n),
        },
      ),
      datapi: { getPoolData: () => Effect.succeed(makeDatapiStats()) },
      configOverrides: {
        watchlistPools: [POOL],
        paperTrading: false,
        idleRedeployEnabled: true,
        idleRedeployThresholdUsd: 500,
        idleRedeployMaxSizeUsd: 2000,
        maxPositionsPerPool: 2,
        maxOpenPositions: 5,
      },
    });
    const { positions, decisions } = await runOneCycle(layer as never);

    // Normal ENTER failed (armed backoff); redeploy honored it → nothing opens.
    expect(positions).toHaveLength(0);
    const redeploy = decisions.filter((d) => d.reasoning.includes("[idle-redeploy]"));
    expect(redeploy.some((d) => d.reasoning.includes("entry backoff active"))).toBe(true);
    expect(redeploy.every((d) => !d.executed)).toBe(true);
  }, 20_000);
});

// ─── Program: redeploy confidence uses known signals only (P2 3654054423) ────

describe("program — idle-redeploy confidence uses known signals only (P2)", () => {
  it("datapi candidate: confidence is the fee-aware formula (above the neutral base)", async () => {
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
    const { decisions } = await runOneCycle(layer as never);
    const redeploy = decisions.find((d) => d.reasoning.includes("[idle-redeploy]") && d.executed);

    expect(redeploy).toBeDefined();
    // feeIlRatioKnown=true (datapi) → min(0.5 + feeIlRatio*0.05, 0.85); the
    // fixture's positive fee/IL pushes it strictly above the neutral base.
    expect(redeploy!.confidence).toBeGreaterThan(0.5);
    expect(redeploy!.confidence).toBeLessThanOrEqual(0.85);
  }, 15_000);

  it("gecko candidate: modeled fee/IL → confidence stays exactly the neutral 0.5", async () => {
    // datapi down → gecko overlays real volume/TVL (statsSource=geckoterminal →
    // feeIlRatioKnown=false). A high modeled fee/IL must NOT raise redeploy
    // confidence off the neutral base.
    const layer = makeProgramLayer({
      adapter: makeProgramAdapter({ [POOL]: makePool({ address: POOL }) }),
      datapi: { getPoolData: () => Effect.succeed(null) },
      gecko: {
        getPoolStats: () =>
          Effect.succeed({
            tvlUsd: 200_000,
            volume24hUsd: 300_000,
            fees24hUsd: 1_050,
            basePriceUsd: 150,
            quotePriceUsd: 1,
          }),
      },
      configOverrides: {
        watchlistPools: [POOL],
        // The test fixture pins gecko off; opt back in so the secondary source
        // (statsSource=geckoterminal → feeIlRatioKnown=false) is exercised.
        geckoTerminalEnabled: true,
        idleRedeployEnabled: true,
        idleRedeployThresholdUsd: 500,
        idleRedeployMaxSizeUsd: 2000,
        maxPositionsPerPool: 2,
        maxOpenPositions: 5,
        // The fee/IL term is dropped from the gecko score; a low threshold lets
        // the (fee-less) score still capture a candidate. The assertion is on the
        // CONFIDENCE, which the modeled ratio must not move off the neutral base.
        weightedEntryScoreThreshold: 0.05,
      },
    });
    const { decisions } = await runOneCycle(layer as never);
    const redeploy = decisions.find((d) => d.reasoning.includes("[idle-redeploy]"));

    expect(redeploy).toBeDefined();
    // Modeled fee/IL (gecko, Fee/IL 20 here) → the NEUTRAL base 0.5 exactly. The
    // pre-fix formula min(0.5 + 20*0.05, 0.85) = 0.85 would have let the modeled
    // ratio authorize the redeploy; it must not vote in either direction.
    expect(redeploy!.confidence).toBe(0.5);
    // 0.5 sits below the 0.65 confidence threshold, so the modeled-fee redeploy
    // does not dispatch — the doctrine working end to end.
    expect(redeploy!.executed).toBe(false);
  }, 15_000);
});
