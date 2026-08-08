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
import type { PoolState } from "../engine/types.js";
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

  it("a caller-supplied maxSizeUsd replaces the $500 cap (high-frequency rotation)", () => {
    expect(
      computeEntrySizeUsd({ walletBalanceUsd: 10_000, tvlUsd: 1_000_000, maxSizeUsd: 2_000 }),
    ).toBe(2_000);
    expect(
      computeEntrySizeUsd({ walletBalanceUsd: 10_000, tvlUsd: 1_000_000, maxSizeUsd: 100 }),
    ).toBe(100);
    // The floor still binds under a tiny override.
    expect(computeEntrySizeUsd({ walletBalanceUsd: 0, tvlUsd: 0, maxSizeUsd: 100 })).toBe(10);
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
    Layer.succeed(EntryPrepService, { prepareEntryTokens: () => Effect.succeed(undefined) }),
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
function runOneCycle<E>(
  layer: Layer.Layer<never, never, never>,
  seed: (db: DbApi) => Effect.Effect<void, E> = () => Effect.void,
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
    Effect.provide(test, layer) as unknown as Effect.Effect<CycleResult, Error, never>,
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

  it("keeps idle redeploy from executing live in autonomous shadow mode (no-send)", async () => {
    // A shadow-mode live setup (PAPER_TRADING=false, real wallet) must never
    // fund or open a real position through the redeploy pass: the in-slot tail
    // skips live execution in shadow mode, and the pass must apply the same
    // contract BEFORE dispatching executeLive — which would otherwise send a
    // real transaction (tagged as an autonomous operation) while the operator
    // believes nothing sends.
    const layer = makeProgramLayer({
      adapter: makeProgramAdapter(
        { [POOL]: makePool({ address: POOL }) },
        {
          hasWallet: () => true,
          getWalletAddress: () => "shadow-wallet",
          getWalletHoldings: () =>
            Effect.succeed(
              new Map<string, { amountAtomic: bigint; decimals: number }>([
                [USDC_MINT, { amountAtomic: 20_000_000_000n, decimals: 6 }], // $20k idle
              ]),
            ),
        },
      ),
      datapi: { getPoolData: () => Effect.succeed(makeDatapiStats()) },
      configOverrides: {
        paperTrading: false,
        autonomousTokenMode: "shadow",
        watchlistPools: [POOL],
        idleRedeployEnabled: true,
        idleRedeployThresholdUsd: 500,
        idleRedeployMaxSizeUsd: 2000,
        maxPositionsPerPool: 2,
        maxOpenPositions: 5,
      },
    });
    const { positions, decisions } = await runOneCycle(layer as never);

    // No real position may open on ANY path in shadow mode; the redeploy pass
    // records the shadow skip instead of sending.
    expect(positions).toHaveLength(0);
    const redeployDecisions = decisions.filter((d) => d.reasoning.includes("[idle-redeploy]"));
    expect(redeployDecisions.length).toBeGreaterThanOrEqual(1);
    expect(redeployDecisions.some((d) => d.reasoning.includes("shadow"))).toBe(true);
    expect(redeployDecisions.every((d) => !d.executed)).toBe(true);
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

describe("computeIdleRedeployConfidence — modeled fee/IL excluded, known signals vote", () => {
  // Known-signal args are irrelevant on the fee-known path (it short-circuits);
  // a neutral fixture keeps the calls readable.
  const NO_KNOWN_SIGNALS = {
    volumeAuthenticity: 0,
    volumeAuthenticityKnown: false,
    binUtilization: 0,
    binUtilizationKnown: false,
  };

  it("measured (datapi) ratio: unchanged fee-aware formula, capped at 0.85", () => {
    expect(
      computeIdleRedeployConfidence({ feeIlRatio: 0, feeIlRatioKnown: true, ...NO_KNOWN_SIGNALS }),
    ).toBe(0.5);
    expect(
      computeIdleRedeployConfidence({ feeIlRatio: 2, feeIlRatioKnown: true, ...NO_KNOWN_SIGNALS }),
    ).toBeCloseTo(0.6, 10);
    expect(
      computeIdleRedeployConfidence({ feeIlRatio: 7, feeIlRatioKnown: true, ...NO_KNOWN_SIGNALS }),
    ).toBe(0.85);
    expect(
      computeIdleRedeployConfidence({ feeIlRatio: 20, feeIlRatioKnown: true, ...NO_KNOWN_SIGNALS }),
    ).toBe(0.85);
  });

  it("fee unknown + NO known signals: exactly the neutral base regardless of the modeled fee", () => {
    // The modeled fee value must move nothing when it is the only signal absent
    // and nothing else is known: a modeled-high ratio must NOT raise confidence…
    expect(
      computeIdleRedeployConfidence({
        feeIlRatio: 20,
        feeIlRatioKnown: false,
        ...NO_KNOWN_SIGNALS,
      }),
    ).toBe(0.5);
    expect(
      computeIdleRedeployConfidence({ feeIlRatio: 8, feeIlRatioKnown: false, ...NO_KNOWN_SIGNALS }),
    ).toBe(0.5);
    // …and a modeled-low ratio must NOT lower it.
    expect(
      computeIdleRedeployConfidence({ feeIlRatio: 0, feeIlRatioKnown: false, ...NO_KNOWN_SIGNALS }),
    ).toBe(0.5);
    expect(
      computeIdleRedeployConfidence({
        feeIlRatio: 0.1,
        feeIlRatioKnown: false,
        ...NO_KNOWN_SIGNALS,
      }),
    ).toBe(0.5);
  });

  it("fee unknown + known signals: confidence derived from volume + bin utilization, clamped to 0.85", () => {
    // volume term = 0.1 + max(0, auth-0.8)*0.25 ; bin term = 0.05 + util*0.1.
    // auth 0.85 known + util 0.5 known → 0.5 + (0.1+0.0125) + (0.05+0.05) = 0.7125.
    expect(
      computeIdleRedeployConfidence({
        feeIlRatio: 20,
        feeIlRatioKnown: false,
        volumeAuthenticity: 0.85,
        volumeAuthenticityKnown: true,
        binUtilization: 0.5,
        binUtilizationKnown: true,
      }),
    ).toBeCloseTo(0.7125, 10);
    // Only volume known (auth 0.9) → 0.5 + (0.1 + 0.025) = 0.625.
    expect(
      computeIdleRedeployConfidence({
        feeIlRatio: 0,
        feeIlRatioKnown: false,
        volumeAuthenticity: 0.9,
        volumeAuthenticityKnown: true,
        binUtilization: 0.9,
        binUtilizationKnown: false,
      }),
    ).toBeCloseTo(0.625, 10);
    // Clamp: extreme known signals never exceed 0.85 (and the modeled fee — 20
    // here — still votes nothing).
    expect(
      computeIdleRedeployConfidence({
        feeIlRatio: 20,
        feeIlRatioKnown: false,
        volumeAuthenticity: 5,
        volumeAuthenticityKnown: true,
        binUtilization: 5,
        binUtilizationKnown: true,
      }),
    ).toBe(0.85);
  });

  it("REQUIRED PROPERTY: any entry-candidate (volumeAuth>0.8 known, binUtil>0.4 known) clears the 0.65 threshold", () => {
    // The entry candidate conditions are volumeAuthenticity > 0.8 (known) and
    // binUtilization > 0.4 (known). At those strict lower bounds the confidence
    // is 0.5 + 0.1 + (0.05 + 0.04) = 0.69 — already ≥ 0.65 — and it only grows
    // with stronger signals, so a qualified gecko candidate is never fail-closed
    // by an absent (modeled) fee signal.
    for (const volumeAuthenticity of [0.81, 0.85, 0.95, 1.0]) {
      for (const binUtilization of [0.41, 0.5, 0.75, 1.0]) {
        expect(
          computeIdleRedeployConfidence({
            feeIlRatio: 0,
            feeIlRatioKnown: false,
            volumeAuthenticity,
            volumeAuthenticityKnown: true,
            binUtilization,
            binUtilizationKnown: true,
          }),
        ).toBeGreaterThanOrEqual(0.65);
      }
    }
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
    expect(redeploy.some((d) => d.reasoning.includes("backoff active"))).toBe(true);
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

  it("gecko candidate (follow-up 3655288403): known signals drive confidence above threshold → executes", async () => {
    // datapi down → gecko overlays real volume/TVL (statsSource=geckoterminal →
    // feeIlRatioKnown=false, volumeAuthenticityKnown=true) and bin utilization is
    // on-chain (binUtilizationKnown=true). Follow-up 3655288403: an absent fee
    // signal must neither HELP nor BLOCK — confidence is derived from the known
    // volume + bin signals instead of a flat fail-closed 0.5, so a qualified
    // gecko candidate clears CONFIDENCE_THRESHOLD=0.65 and executes.
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
        // the (fee-less) score still capture a candidate.
        weightedEntryScoreThreshold: 0.05,
      },
    });
    const { decisions } = await runOneCycle(layer as never);
    const redeploy = decisions.find((d) => d.reasoning.includes("[idle-redeploy]"));

    expect(redeploy).toBeDefined();
    // Known volume + bin signals lift confidence above the neutral base AND the
    // 0.65 threshold, so the gecko redeploy dispatches (pre-fix it was a flat
    // 0.5 and never executed). The modeled Fee/IL here is 20 — had the fee
    // formula voted, confidence would be min(0.5 + 20*0.05, 0.85) = 0.85; it does
    // not, so the modeled fee neither raised nor lowered the known-signal value.
    expect(redeploy!.confidence).toBeGreaterThan(0.65);
    expect(redeploy!.confidence).toBeLessThan(0.85);
    expect(redeploy!.executed).toBe(true);
  }, 15_000);
});

// ─── Program: post-merge follow-up fidelity gaps (P2 review round) ───────────

describe("program — idle-redeploy follow-up fidelity (post-merge review)", () => {
  it("(a) 3655288389: paper seed is the portfolio TOTAL — redeploy respects 40% of the $10k seed", async () => {
    const POOL_OTHER = "PoolIdleOo111111111111111111111111111111111";
    const layer = makeProgramLayer({
      adapter: makeProgramAdapter({ [POOL]: makePool({ address: POOL }) }),
      datapi: { getPoolData: () => Effect.succeed(makeDatapiStats()) },
      configOverrides: {
        watchlistPools: [POOL],
        paperPortfolioUsd: 10_000,
        idleRedeployEnabled: true,
        idleRedeployThresholdUsd: 500,
        // Generous ceiling so the per-pool allocation share binds, not the cap.
        idleRedeployMaxSizeUsd: 5000,
        maxPositionsPerPool: 2,
        maxOpenPositions: 5,
      },
    });
    // A $1,500 position on an UNWATCHED pool counts toward deployed capital but
    // not toward POOL's per-pool headroom. At the pass: normal ENTER on POOL =
    // $500, deployed = $2,000, idle = $8,000. With the seed as the TOTAL
    // ($10,000) the widened size = min(8_000/2, 10_000×0.4, 5_000) = $4,000, then
    // allocation caps it to POOL headroom = 4_000 − 500 = $3,500.
    const { positions } = await runOneCycle(layer as never, (db) =>
      Effect.gen(function* () {
        yield* db.savePosition(
          makeSeededPosition({
            positionId: "seed-other",
            poolAddress: POOL_OTHER,
            depositedUsd: 1500,
            currentValueUsd: 1500,
          }),
        );
      }),
    );

    const poolPositions = positions.filter((p) => p.poolAddress === POOL);
    const redeployPosition = poolPositions.find((p) => p.depositedUsd > 500);
    expect(redeployPosition).toBeDefined();
    expect(redeployPosition!.depositedUsd).toBe(3500);
    // POOL aggregate = 500 + 3_500 = $4,000 = exactly 40% of the $10k seed. The
    // pre-fix formula evaluated the portfolio as seed + deployed ($12,000) and
    // grew POOL to $4,500 (45% of the real paper portfolio).
    const poolAggregate = poolPositions.reduce((sum, p) => sum + p.depositedUsd, 0);
    expect(poolAggregate).toBeLessThanOrEqual(0.4 * 10_000);
  }, 15_000);

  it("(b) 3655288395: walks past a blocked top candidate to the first executable one (one deploy)", async () => {
    const POOL_A = "PoolIdleAa111111111111111111111111111111111";
    const POOL_B = "PoolIdleBb111111111111111111111111111111111";
    const layer = makeProgramLayer({
      adapter: makeProgramAdapter({
        [POOL_A]: makePool({ address: POOL_A }),
        [POOL_B]: makePool({ address: POOL_B }),
      }),
      datapi: {
        getPoolData: (addr: string) => Effect.succeed(makeDatapiStats({ address: addr })),
      },
      configOverrides: {
        watchlistPools: [POOL_A, POOL_B],
        paperPortfolioUsd: 10_000,
        idleRedeployEnabled: true,
        idleRedeployThresholdUsd: 500,
        idleRedeployMaxSizeUsd: 2000,
        maxPositionsPerPool: 2,
        maxOpenPositions: 5,
      },
    });
    // POOL_A is already at MAX_POSITIONS_PER_POOL (2 seeded): its in-slot ENTER
    // is skipped and it is captured via the per-pool-cap path, but the pass's
    // allocation re-check rejects it again (per-pool count full). Equal entry
    // scores keep POOL_A first in score order, so the walk must audit-skip it and
    // continue to the fully-executable POOL_B — deploying exactly once.
    const { positions, decisions } = await runOneCycle(layer as never, (db) =>
      Effect.gen(function* () {
        yield* db.savePosition(makeSeededPosition({ positionId: "a-1", poolAddress: POOL_A }));
        yield* db.savePosition(makeSeededPosition({ positionId: "a-2", poolAddress: POOL_A }));
      }),
    );

    const redeployExecuted = decisions.filter(
      (d) => d.reasoning.includes("[idle-redeploy]") && d.executed && d.action === "ENTER",
    );
    expect(redeployExecuted).toHaveLength(1);
    expect(redeployExecuted[0]!.poolAddress).toBe(POOL_B);

    // POOL_A got its own per-candidate audit skip; POOL_B opened normal + redeploy.
    expect(
      decisions.some(
        (d) => d.reasoning.includes("[idle-redeploy]") && !d.executed && d.poolAddress === POOL_A,
      ),
    ).toBe(true);
    expect(positions.filter((p) => p.poolAddress === POOL_B)).toHaveLength(2);
  }, 15_000);

  // A full-mode SYNC advisor: getStatus reports a real transport so the overlay
  // takes the sync-proposal path; enhanceDecision answers per-decision below.
  const SYNC_TRANSPORT_STATUS = {
    connected: true,
    transport: "acp",
    lastPromptAt: null,
    errorCount: 0,
  };

  it("(g) 3655404934: widened-size guard compares against the agent-ENLARGED normal entry", async () => {
    const layer = makeProgramLayer({
      adapter: makeProgramAdapter({ [POOL]: makePool({ address: POOL }) }),
      datapi: { getPoolData: () => Effect.succeed(makeDatapiStats()) },
      configOverrides: {
        watchlistPools: [POOL],
        paperPortfolioUsd: 10_000,
        // Let a full-mode proposal enlarge the normal entry up to 50% of portfolio.
        agentProposalMaxPositionSizePct: 0.5,
        idleRedeployEnabled: true,
        idleRedeployThresholdUsd: 500,
        idleRedeployMaxSizeUsd: 2000,
        maxPositionsPerPool: 2,
        maxOpenPositions: 5,
        agentiveMode: true,
        agentProposalMode: "full",
      },
      agentApi: {
        ...AgentNoOp,
        getStatus: () => Effect.succeed(SYNC_TRANSPORT_STATUS),
        // Enlarge the deterministic normal ENTER to $3,000; leave the redeploy
        // decision untouched so it runs its deterministic path.
        enhanceDecision: (decision) =>
          Effect.succeed(
            decision.action === "ENTER" && !decision.reasoning.includes("[idle-redeploy]")
              ? {
                  action: "ENTER" as const,
                  poolAddress: POOL,
                  confidence: 0.8,
                  reasoning: "advisor enlarged entry",
                  positionSizeUsd: 3000,
                  proposalId: "sync-g",
                  proposedAt: Date.now(),
                  expiresAt: Date.now() + 300_000,
                  source: "sync-prompt" as const,
                  status: "pending" as const,
                }
              : null,
          ),
      },
    });
    const { positions, decisions } = await runOneCycle(layer as never);

    // Normal ENTER enlarged to $3,000 and executed; the fix synced that FINAL
    // size onto the candidate. The redeploy caps to POOL headroom (4_000 − 3_000
    // = $1,000), which is ≤ the enlarged $3,000 → skipped. Without the sync, the
    // candidate would carry the stale $500 and the $1,000 redeploy would deploy.
    const poolPositions = positions.filter((p) => p.poolAddress === POOL);
    expect(poolPositions).toHaveLength(1);
    expect(poolPositions[0]!.depositedUsd).toBe(3000);
    expect(
      decisions.some((d) => d.reasoning.includes("does not exceed normal entry") && !d.executed),
    ).toBe(true);
    expect(decisions.some((d) => d.reasoning.includes("[idle-redeploy]") && d.executed)).toBe(
      false,
    );
  }, 15_000);

  it("(f) 3655404926: a pool whose EXIT executed this cycle is excluded from redeploy", async () => {
    const layer = makeProgramLayer({
      adapter: makeProgramAdapter({ [POOL]: makePool({ address: POOL }) }),
      datapi: { getPoolData: () => Effect.succeed(makeDatapiStats()) },
      configOverrides: {
        watchlistPools: [POOL],
        paperPortfolioUsd: 10_000,
        idleRedeployEnabled: true,
        idleRedeployThresholdUsd: 500,
        idleRedeployMaxSizeUsd: 2000,
        // Single position per pool: the seeded position fills the cap, so the
        // in-slot ENTER is structurally skipped (captured as a redeploy candidate
        // via the per-pool-cap path) — the redeploy is the ONLY re-entry path.
        maxPositionsPerPool: 1,
        maxOpenPositions: 5,
        agentiveMode: true,
        agentProposalMode: "full",
      },
      agentApi: {
        ...AgentNoOp,
        getStatus: () => Effect.succeed(SYNC_TRANSPORT_STATUS),
        // Flip the seeded position's deterministic HOLD to EXIT (and execute it);
        // leave the redeploy decision untouched.
        enhanceDecision: (decision) =>
          Effect.succeed(
            decision.action === "HOLD" && !decision.reasoning.includes("[idle-redeploy]")
              ? {
                  action: "EXIT" as const,
                  poolAddress: POOL,
                  confidence: 0.8,
                  reasoning: "advisor exit",
                  proposalId: "sync-f",
                  proposedAt: Date.now(),
                  expiresAt: Date.now() + 300_000,
                  source: "sync-prompt" as const,
                  status: "pending" as const,
                }
              : null,
          ),
      },
    });
    const { positions, decisions } = await runOneCycle(layer as never, (db) =>
      Effect.gen(function* () {
        yield* db.savePosition(makeSeededPosition({ positionId: "seeded-pos", poolAddress: POOL }));
      }),
    );

    // The advisor EXIT executed (closing the seeded position) and added POOL to
    // executedExitPools. The redeploy candidate — captured before the exit freed
    // the slot — is then excluded: no same-cycle re-entry despite the free slot.
    expect(positions.filter((p) => p.poolAddress === POOL)).toHaveLength(0);
    expect(
      decisions.some(
        (d) =>
          d.reasoning.includes("[idle-redeploy]") && d.reasoning.includes("no exit-and-reenter"),
      ),
    ).toBe(true);
    expect(decisions.some((d) => d.reasoning.includes("[idle-redeploy]") && d.executed)).toBe(
      false,
    );
  }, 15_000);
});
