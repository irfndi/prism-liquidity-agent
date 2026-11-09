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
  GeckoTerminalService,
  AlertService,
  type AdapterApi,
  type MeteoraDatapiApi,
} from "../engine/services.js";
import { defaultAppConfig, makePool, makePosition, makeBinArray } from "./helpers.js";

// Issue #232: paper positions freeze at entry values when a pool's gate phase
// throws. The gate phase resolves stats (datapi first) and a pool that fails
// there aborted the whole evaluation, so OOR tracking and the value mark never
// ran: out_of_range_since stayed null, current_value_usd stayed at the deposit,
// and the position silently left every risk gate that reads them.
describe("issue #232 — held positions stay marked when the gate phase fails", () => {
  const POOL = "PoolDelisted1111111111111111111111111111111111";

  function makeAdapter(): AdapterApi {
    return {
      hasWallet: () => false,
      getWalletAddress: () => null,
      getWalletBalanceUsd: () => Effect.succeed(10_000),
      getWalletHoldings: () =>
        Effect.succeed(new Map<string, { amountAtomic: bigint; decimals: number }>()),
      getNativeSolBalance: () => Effect.succeed(0n),
      // The RPC read still works — the data API is what fails. Active bin is
      // OUTSIDE the held range, so a refresh must record the OOR onset.
      // The gate phase reads WITHOUT skipStats (no datapi hit) and its
      // reserve/price stats fetch rejects; the minimal skipStats read succeeds.
      // That is the failure shape issue #232 describes: the enriched read
      // aborts the evaluation while the pool itself is still readable.
      getPoolState: (_poolAddress: string, opts?: { readonly skipStats?: boolean }) =>
        opts?.skipStats === true
          ? Effect.succeed(
              makePool({
                address: POOL,
                activeBinId: 5300,
                currentPrice: 400,
                tvlUsd: 60_000,
                fees24hUsd: 300,
              }),
            )
          : Effect.fail(new Error("pool stats unavailable (reserve/price reads rejected)")),
      getBinArray: () => Effect.succeed(makeBinArray(5300)),
      getPositions: () => Effect.succeed([]),
      getAllWalletPositions: () => Effect.succeed([]),
      simulateRebalance: () =>
        Effect.succeed({
          estimatedFeesUsd: 0,
          estimatedCostUsd: 0,
          netBenefitUsd: 0,
          source: "pool-heuristic" as const,
        }),
      enterPosition: (_p: string, _l: number, _u: number, sizeUsd: number) =>
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

  // The reported trigger: stats resolution failing for a held pool. The data
  // API contract cannot fail (it returns null), so the realistic trigger is
  // the adapter's reserve/price read, modelled on getPoolState above.
  function makeDatapi(): MeteoraDatapiApi {
    return { getPoolData: () => Effect.succeed(null) };
  }

  function makeTestLayer() {
    const config = defaultAppConfig({
      watchlistPools: [POOL],
      scanIntervalMs: 3_600_000,
      paperTrading: true,
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
      Layer.succeed(EntryPrepService, { prepareEntryTokens: () => Effect.succeed(undefined) }),
      Layer.succeed(MeteoraDatapiService, makeDatapi()),
      Layer.succeed(GeckoTerminalService, { getPoolStats: () => Effect.succeed(null) }),
      Layer.succeed(AlertService, {
        sendAlert: () => Effect.void,
        recordFeeClaim: () => Effect.void,
      }),
    );
  }

  it("records the OOR onset and moves the mark even when the stats fetch rejects", async () => {
    const layer = makeTestLayer();

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
          entryPriceUsd: 150,
        }),
      );

      // Given the gate phase fails every cycle (the delisted-pool case).
      yield* Effect.raceFirst(program, Effect.sleep(3_000));

      return yield* db.getAllPositions();
    });

    const positions = await Effect.runPromise(Effect.provide(test, layer));
    const held = positions.find((p) => p.poolAddress === POOL);

    // Then the position is still tracked (no phantom EXIT) and its risk state
    // is current: out-of-range recorded, mark revalued away from the deposit.
    expect(held).toBeDefined();
    expect(held?.outOfRangeSince).not.toBeNull();
    expect(held?.currentValueUsd).not.toBe(1_000);
  }, 20_000);
});
