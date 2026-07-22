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
import { defaultAppConfig, makePool, makeBinArray, makePosition } from "./helpers.js";
import { stringifySafe } from "../engine/bigint-json.js";

// ─── Task 3: IL protection (ENTER fee/IL floor + IL-dominance fast EXIT) ─────

type MintAuthorities = { mintAuthority: string | null; freezeAuthority: string | null };
const NO_AUTHORITIES: MintAuthorities = { mintAuthority: null, freezeAuthority: null };

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
};

// Runs a single cycle after seeding positions via DbService inside the effect.
function runWithSeed(
  layer: ReturnType<typeof makeTestLayer>,
  positions: ReadonlyArray<ReturnType<typeof makePosition>>,
) {
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

const POOL = "PoolIlProt11111111111111111111111111111111111";

describe("IL protection — ENTER fee/IL floor gate (Task 3a)", () => {
  it("rejects ENTER when feeIlRatio < minFeeIlRatio and ilProtectionEnabled", async () => {
    // fees24hUsd = 1 → fee/IL ratio ≈ 0.4-0.8 (< default minFeeIlRatio 1.2).
    // No datapi → volumeAuthenticityKnown=false → pre-filter skips auth/binUtil.
    const layer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: makePool({ address: POOL, fees24hUsd: 1 }) }),
      configOverrides: { watchlistPools: [POOL], ilProtectionEnabled: true },
    });

    const decisions = await runWithSeed(layer, []);
    const gateRejects = decisions.filter(
      (d) =>
        d.poolAddress === POOL && d.action === "ENTER" && d.reasoning.includes("[fee-il-gate]"),
    );
    expect(
      gateRejects,
      `expected a [fee-il-gate] ENTER rejection, got: ${stringifySafe(decisions.map((d) => `${d.action}:${d.reasoning}`))}`,
    ).toHaveLength(1);
    expect(gateRejects[0]!.riskResult.approved).toBe(false);
  }, 15_000);

  it("does NOT block ENTER via fee-il-gate when ilProtectionEnabled is false (default pin)", async () => {
    // Same low-fee pool; defaultAppConfig pins ilProtectionEnabled=false so the
    // gate must stay silent (existing tests byte-identical).
    const layer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: makePool({ address: POOL, fees24hUsd: 1 }) }),
      configOverrides: { watchlistPools: [POOL] },
    });

    const decisions = await runWithSeed(layer, []);
    const gateRejects = decisions.filter(
      (d) =>
        d.poolAddress === POOL && d.action === "ENTER" && d.reasoning.includes("[fee-il-gate]"),
    );
    expect(
      gateRejects,
      `fee-il-gate fired while ilProtectionEnabled absent: ${stringifySafe(gateRejects)}`,
    ).toHaveLength(0);
  }, 15_000);
});

describe("IL protection — IL-dominance fast EXIT (Task 3b)", () => {
  // Pool price doubled since entry (100 → 200); the OOR position's heuristic
  // value collapses while the HODL benchmark climbs, so IL dominates fees.
  function ilPool() {
    return makePool({ address: POOL, currentPrice: 200, activeBinId: 5000 });
  }

  // makePosition hardcodes lowerBinId/upperBinId/outOfRangeSince (it does not
  // read them from overrides), so the OOR shape is applied via spread AFTER the
  // helper. Active bin 5000 sits far outside [4900, 4950]: heuristic value →
  // 1000*(1-1*0.5) = 500; HODL → 500*(200/100)+500 = 1500; IL = 1000, which is
  // > 10 fees × 2 and > $5 floor → IL-dominance EXIT.
  function ilDominantPosition() {
    return {
      ...makePosition({
        poolAddress: POOL,
        depositedUsd: 1000,
        currentValueUsd: 1000,
        entryPriceUsd: 100,
        entryAmountXUsd: 500,
        entryAmountYUsd: 500,
        cumulativeFeesClaimedUsd: 10,
      }),
      lowerBinId: 4900,
      upperBinId: 4950,
      outOfRangeSince: Date.now() - 60_000,
    };
  }

  it("exits an IL-dominant out-of-range position with positionId and IL reasoning", async () => {
    const position = ilDominantPosition();
    const layer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: ilPool() }),
      configOverrides: { watchlistPools: [POOL], ilProtectionEnabled: true },
    });

    const decisions = await runWithSeed(layer, [position]);
    const ilExits = decisions.filter(
      (d) => d.poolAddress === POOL && d.action === "EXIT" && d.reasoning.includes("IL dominance"),
    );
    expect(
      ilExits,
      `expected an IL-dominance EXIT, got: ${stringifySafe(decisions.map((d) => `${d.action}:${d.reasoning}`))}`,
    ).toHaveLength(1);
    const exit = ilExits[0]!;
    expect(exit.confidence).toBe(1);
    expect(String(exit.reasoning)).toContain("IL");
  }, 15_000);

  it("skips the IL exit when entry legs are NULL (fail-open, pre-v16 rows)", async () => {
    // OOR like the positive case but with NULL entry legs (pre-v16 row) → the
    // HODL benchmark is uncomputable, so the IL exit must skip (fail-open).
    const position = {
      ...makePosition({
        poolAddress: POOL,
        depositedUsd: 1000,
        currentValueUsd: 1000,
        cumulativeFeesClaimedUsd: 10,
      }),
      lowerBinId: 4900,
      upperBinId: 4950,
      outOfRangeSince: Date.now() - 60_000,
    };
    const layer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: ilPool() }),
      configOverrides: { watchlistPools: [POOL], ilProtectionEnabled: true },
    });

    const decisions = await runWithSeed(layer, [position]);
    const ilExits = decisions.filter(
      (d) => d.poolAddress === POOL && d.action === "EXIT" && d.reasoning.includes("IL dominance"),
    );
    expect(
      ilExits,
      `IL-dominance EXIT fired on NULL entry legs: ${stringifySafe(ilExits)}`,
    ).toHaveLength(0);
  }, 15_000);

  it("skips the IL exit for an in-range position (outOfRangeSince null)", async () => {
    // In range: active bin 5000 inside the default [4980, 5020] → heuristic
    // value stays high (no trailing stop) and outOfRangeSince stays null (OOR
    // tracking does not set it for an in-range position) → the IL-dominance
    // pre-check requires outOfRangeSince !== null, so it skips despite large IL.
    const position = makePosition({
      poolAddress: POOL,
      depositedUsd: 1000,
      currentValueUsd: 1000,
      entryPriceUsd: 100,
      entryAmountXUsd: 500,
      entryAmountYUsd: 500,
      cumulativeFeesClaimedUsd: 10,
    });
    const layer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: ilPool() }),
      configOverrides: { watchlistPools: [POOL], ilProtectionEnabled: true },
    });

    const decisions = await runWithSeed(layer, [position]);
    const ilExits = decisions.filter(
      (d) => d.poolAddress === POOL && d.action === "EXIT" && d.reasoning.includes("IL dominance"),
    );
    expect(
      ilExits,
      `IL-dominance EXIT fired on an in-range position: ${stringifySafe(ilExits)}`,
    ).toHaveLength(0);
  }, 15_000);

  it("fires the il_dominance alert with positionId, severity critical and IL data", async () => {
    const position = ilDominantPosition();
    const capturedAlerts: EngineAlert[] = [];
    const layer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: ilPool() }),
      configOverrides: { watchlistPools: [POOL], ilProtectionEnabled: true },
      alertCapture: capturedAlerts,
    });

    await runWithSeed(layer, [position]);
    const ilAlerts = capturedAlerts.filter((a) => a.type === "il_dominance");
    expect(
      ilAlerts,
      `expected an il_dominance alert, captured: ${stringifySafe(capturedAlerts.map((a) => a.type))}`,
    ).toHaveLength(1);
    const alert = ilAlerts[0]!;
    expect(alert.severity).toBe("critical");
    expect(alert.positionId).toBe(position.positionId);
    expect(alert.poolAddress).toBe(POOL);
    const data = alert.data ?? {};
    expect(typeof data.ilUsd).toBe("number");
    expect(data.ilUsd).toBeGreaterThan(0);
    expect(typeof data.hodlValueUsd).toBe("number");
    expect(typeof data.feesClaimedUsd).toBe("number");
  }, 15_000);
});
