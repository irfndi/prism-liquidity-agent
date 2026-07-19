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
import { ConfigService } from "../engine/config-service.js";
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
} from "../engine/services.js";
import type { PoolSnapshot } from "../engine/types.js";
import { defaultAppConfig, makePool, makeBinArray, makePosition } from "./helpers.js";

// ─── (iii) TVL-drop EXIT at the evaluatePool level ───────────────────────────

describe("evaluatePool TVL-drop EXIT (integration)", () => {
  const POOL = "PoolTvlDrop1111111111111111111111111111111111";

  function makeAdapter(): AdapterApi {
    return {
      hasWallet: () => false,
      getWalletAddress: () => null,
      getWalletBalanceUsd: () => Effect.succeed(10_000),
      getNativeSolBalance: () => Effect.succeed(0n),
      getPoolState: () =>
        Effect.succeed(
          makePool({ address: POOL, tvlUsd: 60_000, currentPrice: 150, fees24hUsd: 300 }),
        ),
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
      getMintAuthorities: () => Effect.succeed({ mintAuthority: null, freezeAuthority: null }),
      quoteSwapUSDCForToken: () => Effect.succeed({}),
      swapUSDCForToken: () => Effect.succeed("mock-swap-tx"),
    };
  }

  function makeDatapi(): MeteoraDatapiApi {
    // Data API unavailable → heuristic fallback path; cycle must still complete.
    return { getPoolData: () => Effect.succeed(null) };
  }

  function makeTestLayer() {
    const config = defaultAppConfig({
      watchlistPools: [POOL],
      scanIntervalMs: 3_600_000,
      paperTrading: true,
      tvlDropExitPct: 0.3,
      agentMcpEnabled: false,
      agentHttpPort: 0,
    });
    const dbLayer = DbLive(":memory:");
    return Layer.mergeAll(
      Layer.succeed(ConfigService, config),
      Layer.succeed(AdapterService, makeAdapter()),
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
      Layer.succeed(MeteoraDatapiService, makeDatapi()),
      Layer.succeed(AlertService, {
        sendAlert: () => Effect.void,
        recordFeeClaim: () => Effect.void,
      }),
    );
  }

  it("(iii) held position in a pool whose TVL dropped > TVL_DROP_EXIT_PCT exits", async () => {
    const layer = makeTestLayer();
    const previousSnapshot: PoolSnapshot = {
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

    const test = Effect.gen(function* () {
      const db = yield* DbService;
      yield* db.savePosition(
        makePosition({
          poolAddress: POOL,
          positionPubKey: null,
          lowerBinId: 4980,
          upperBinId: 5020,
          depositedUsd: 1_000,
          currentValueUsd: 1_000,
        }),
      );
      yield* db.saveSnapshot(previousSnapshot);
      // program loops forever on the scheduler; race it against a timer so the
      // first (immediate) scan cycle runs and then we interrupt it.
      yield* Effect.raceFirst(program, Effect.sleep(2_000));
      const audit = yield* AuditService;
      return yield* audit.getRecentDecisions(50);
    });

    const decisions = await Effect.runPromise(
      Effect.provide(test, layer) as Effect.Effect<
        ReadonlyArray<{ action: string; reasoning: string }>,
        unknown,
        never
      >,
    );

    const tvlExit = decisions.find(
      (d) => d.action === "EXIT" && d.reasoning.includes("TVL dropped"),
    );
    expect(
      tvlExit,
      `expected a TVL-drop EXIT decision, got: ${JSON.stringify(decisions.map((d) => `${d.action}: ${d.reasoning}`))}`,
    ).toBeDefined();
  }, 15_000);
});
