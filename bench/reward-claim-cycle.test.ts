import { describe, it, expect, vi } from "vitest";
import { Effect, Layer } from "effect";
import { program } from "../engine/program.js";
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
} from "../engine/services.js";
import { defaultAppConfig, makePool, makeBinArray, makePosition } from "./helpers.js";

// ─── Wave 8: periodic LM reward claim cycle (full engine loop) ───────────────
// A farm position with pending rewards must see exactly ONE reward CLAIM event
// and one cumulative increment, even across many claim cycles (the adapter
// reports "skipped" once on-chain pending amounts reset). Swap-fee accounting
// must stay fee-pure throughout.

const FARM_POOL = "PoolFarmRewards11111111111111111111111111";
const FARM_POS = "pos-farm-1";
const REWARD_MINT = "RewardMint111111111111111111111111111111111";

const NO_AUTHORITIES = { mintAuthority: null, freezeAuthority: null };

function makeLoopAdapter(claimRewards: AdapterApi["claimRewards"]): AdapterApi {
  return {
    hasWallet: () => true,
    getWalletAddress: () => "Wallet111",
    getWalletBalanceUsd: () => Effect.succeed(10_000),
    getNativeSolBalance: () => Effect.succeed(10_000_000_000n),
    getPoolState: (addr: string) =>
      addr === FARM_POOL
        ? Effect.succeed(makePool({ address: FARM_POOL, activeBinId: 5000, fees24hUsd: 3_000 }))
        : Effect.fail(new Error(`unknown pool ${addr}`)),
    getBinArray: () => Effect.succeed(makeBinArray()),
    getPositions: (poolAddress: string) =>
      Effect.succeed(
        poolAddress === FARM_POOL
          ? [
              {
                id: FARM_POS,
                poolAddress: FARM_POOL,
                poolName: "SOL/USDC",
                lowerBinId: 4980,
                upperBinId: 5020,
                liquidityShares: 0n,
                depositedUsd: 1_000,
                currentValueUsd: 1_000,
                unrealizedPnlUsd: 0,
                feesEarnedUsd: 0,
                openedAt: Date.now(),
              },
            ]
          : [],
      ),
    getAllWalletPositions: () =>
      Effect.succeed([
        { poolAddress: FARM_POOL, positionPubKey: FARM_POS, lowerBinId: 4980, upperBinId: 5020 },
      ]),
    simulateRebalance: () => Effect.fail(new Error("not used")),
    enterPosition: () => Effect.fail(new Error("not used")),
    exitPosition: () => Effect.fail(new Error("not used")),
    rebalancePosition: () => Effect.fail(new Error("not used")),
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
    claimRewards,
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

function makeLoopLayer(opts: { adapter: AdapterApi; configOverrides?: Partial<AppConfig> }) {
  const config = defaultAppConfig({
    watchlistPools: [FARM_POOL],
    paperTrading: false,
    scanIntervalMs: 100,
    feeClaimIntervalMs: 0,
    autoUpdate: false,
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
      stopLossPct: 0.6,
      maxPerPoolAllocationPct: 0.4,
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
    Layer.succeed(MeteoraDatapiService, { getPoolData: () => Effect.succeed(null) }),
    Layer.succeed(AlertService, {
      sendAlert: () => Effect.void,
      recordFeeClaim: () => Effect.void,
    }),
  );
}

describe("periodic reward claim cycle", () => {
  it("(v) records one reward CLAIM event and cumulative total across many cycles; fees stay fee-pure", async () => {
    // First cycle has pending rewards; after the claim the on-chain pending
    // amounts are zero, so every subsequent cycle reports skipped.
    let call = 0;
    const claimRewards = vi.fn(() => {
      call += 1;
      return call === 1
        ? Effect.succeed({
            skipped: false,
            skipReason: null,
            txSignatures: ["tx-reward-1"],
            rewards: [{ mint: REWARD_MINT, amountAtomic: 250_000_000, amountUsd: 100 }],
          })
        : Effect.succeed({
            skipped: true,
            skipReason: "no pending rewards",
            txSignatures: [] as string[],
            rewards: [],
          });
    });
    const layer = makeLoopLayer({ adapter: makeLoopAdapter(claimRewards) });

    const outcome = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const db = yield* DbService;
          yield* db.savePosition(
            makePosition({
              poolAddress: FARM_POOL,
              positionPubKey: FARM_POS,
              lastFeeClaimAt: 0,
            }),
          );
          yield* Effect.raceFirst(program, Effect.sleep(1_500));
          const positions = yield* db.getAllPositions();
          const events = yield* db.getPositionEvents(FARM_POOL);
          return { positions, events };
        }),
        layer,
      ) as Effect.Effect<never, unknown, never>,
    );

    const { positions, events } = outcome as unknown as {
      positions: ReadonlyArray<{
        cumulativeFeesClaimedUsd: number;
        cumulativeRewardsClaimedUsd: number;
      }>;
      events: ReadonlyArray<{ event: string; feesUsd: number | null; metadata: string | null }>;
    };

    // The claim ran and was then skipped on later cycles (no double-claim).
    expect(claimRewards.mock.calls.length).toBeGreaterThanOrEqual(2);

    const pos = positions.find((p) => "cumulativeRewardsClaimedUsd" in p)!;
    expect(pos.cumulativeRewardsClaimedUsd).toBeCloseTo(100, 8);
    // Swap-fee accounting untouched by rewards.
    expect(pos.cumulativeFeesClaimedUsd).toBe(0);

    const rewardEvents = events.filter((e) => e.metadata?.includes("lm_reward"));
    expect(rewardEvents).toHaveLength(1);
    expect(rewardEvents[0]!.event).toBe("CLAIM");
    // fees_usd stays NULL on reward rows — fee queries stay fee-pure.
    expect(rewardEvents[0]!.feesUsd).toBeNull();
    expect(rewardEvents[0]!.metadata).toContain(REWARD_MINT);
    expect(rewardEvents[0]!.metadata).toContain("tx-reward-1");
  });

  it("(v) FARM_REWARDS_ENABLED=false disables reward claims entirely", async () => {
    const claimRewards = vi.fn(() =>
      Effect.succeed({
        skipped: true,
        skipReason: "no pending rewards",
        txSignatures: [] as string[],
        rewards: [],
      }),
    );
    const layer = makeLoopLayer({
      adapter: makeLoopAdapter(claimRewards),
      configOverrides: { farmRewardsEnabled: false },
    });

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const db = yield* DbService;
          yield* db.savePosition(
            makePosition({
              poolAddress: FARM_POOL,
              positionPubKey: FARM_POS,
              lastFeeClaimAt: 0,
            }),
          );
          yield* Effect.raceFirst(program, Effect.sleep(400));
        }),
        layer,
      ) as Effect.Effect<never, unknown, never>,
    );

    expect(claimRewards).not.toHaveBeenCalled();
  });
});
