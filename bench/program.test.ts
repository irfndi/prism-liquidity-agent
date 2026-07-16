import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import {
  buildLayer,
  estimatePositionValue,
  executeLive,
  finalizeAppliedProposal,
  isProposalStale,
  shouldHoldForSupervisedApproval,
} from "../engine/program.js";
import { ConfigService } from "../engine/config-service.js";
import { EntryPrepError } from "../engine/errors.js";
import {
  AdapterService,
  StrategyService,
  MemoryService,
  RiskService,
  BlacklistService,
  AuditService,
  ScreenerService,
  DbService,
  EntryPrepService,
  AgentService,
  AgentStateService,
  type AdapterApi,
  type StrategyApi,
  type DbApi,
  type RevenueConfigApi,
} from "../engine/services.js";

import type { AgentDecision } from "../engine/types.js";

function run<T>(effect: Effect.Effect<T, unknown, unknown>, layer: unknown): T {
  return Effect.runSync((Effect.provide as any)(effect, layer));
}

describe("Program integration", () => {
  it("buildLayer provides all services", () => {
    const layer = buildLayer();
    const result = run(
      Effect.gen(function* () {
        yield* ConfigService;
        yield* AdapterService;
        yield* StrategyService;
        yield* MemoryService;
        yield* RiskService;
        yield* BlacklistService;
        yield* AuditService;
        yield* ScreenerService;
        yield* DbService;
        yield* EntryPrepService;
        yield* AgentService;
        yield* AgentStateService;
        return "ok";
      }),
      layer,
    );
    expect(result).toBe("ok");
  });
});

describe("executeLive", () => {
  function makeAdapter(): AdapterApi {
    return {
      hasWallet: () => true,
      getWalletAddress: () => "mock-wallet",
      getWalletBalanceUsd: () => Effect.succeed(10_000),
      getNativeSolBalance: () => Effect.succeed(1_000_000_000n),
      getPoolState: () =>
        Effect.succeed({
          address: "TestPool111111111111111111111111111111111111",
          tokenX: "So11111111111111111111111111111111111111112",
          tokenY: "FakeToken1111111111111111111111111111111111",
          tokenXSymbol: "SOL",
          tokenYSymbol: "FAKE",
          tvlUsd: 100_000,
          volume24hUsd: 30_000,
          fees24hUsd: 300,
          apr: 60,
          activeBinId: 5000,
          binStep: 10,
          currentPrice: 150,
          timestamp: Date.now(),
        }),
      getBinArray: () =>
        Effect.succeed({
          lowerBinId: 4980,
          upperBinId: 5020,
          activeBinId: 5000,
          bins: [],
        }),
      getPositions: () => Effect.succeed([]),
      getAllWalletPositions: () => Effect.succeed([]),
      simulateRebalance: () =>
        Effect.succeed({ estimatedIlUsd: 0, estimatedFeesUsd: 0, netBenefitUsd: 0 }),
      enterPosition: () => Effect.succeed({ positionPubKey: "mock-pos", txSignature: "mock-tx" }),
      exitPosition: () => Effect.succeed({ txSignature: "mock-tx" }),
      rebalancePosition: () =>
        Effect.succeed({ newPositionPubKey: "mock-pos", txSignatures: ["mock-tx"] }),
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
      discoverPools: () => Effect.succeed([]),
      reportFeeCollection: () => Effect.void,
      swapUSDCForSOL: () => Effect.void,
      getTokenBalance: () => Effect.succeed(0n),
      getTokenPrices: () => Effect.succeed({}),
      getTokenDecimals: () => Effect.succeed(9),
      quoteSwapUSDCForToken: () =>
        Effect.succeed({ routePlan: [{ swapInfo: {} }], outAmount: "10000000000000" }),
      swapUSDCForToken: () => Effect.succeed("mock-swap-tx"),
    };
  }

  function makeStrategy(): StrategyApi {
    return {
      computeMetrics: () =>
        ({
          pool: {
            address: "TestPool111111111111111111111111111111111111",
            tokenX: "So11111111111111111111111111111111111111112",
            tokenY: "FakeToken1111111111111111111111111111111111",
            tokenXSymbol: "SOL",
            tokenYSymbol: "FAKE",
            tvlUsd: 100_000,
            volume24hUsd: 30_000,
            fees24hUsd: 300,
            apr: 60,
            activeBinId: 5000,
            binStep: 10,
            currentPrice: 150,
            timestamp: Date.now(),
          },
          binArray: {
            lowerBinId: 4980,
            upperBinId: 5020,
            activeBinId: 5000,
            bins: [],
          },
          feeIlRatio: 2,
          volumeAuthenticity: 0.9,
          binUtilization: 0.5,
          tvlVelocity: 0,
        }) as import("../engine/types.js").PoolMetrics,
      checkVolumeAuthenticity: () => ({ score: 0.9, flags: [] }),
      computeBinUtilization: () => 0.5,
      computeFeeIlRatio: () => 2,
      recommendBinRange: () => ({ lowerBinId: 4980, upperBinId: 5020 }),
      passesPreFilter: () => true,
    };
  }

  function makeDb(): DbApi {
    return {
      db: {},
      savePosition: () => Effect.void,
      getPosition: () => Effect.succeed(null),
      getAllPositions: () => Effect.succeed([]),
      getPaperExitedPositions: () => Effect.succeed([]),
      deletePosition: () => Effect.void,
      markPaperExited: () => Effect.void,
      updatePositionValue: () => Effect.void,
      saveAudit: () => Effect.void,
      getRecentAudit: () => Effect.succeed([]),
      cacheBlacklist: () => Effect.void,
      isBlacklisted: () => Effect.succeed(false),
      insertMemory: () => Effect.void,
      queryMemory: () => Effect.succeed([]),
      pruneMemory: () => Effect.succeed(0),
      saveSnapshot: () => Effect.void,
      getSnapshots: () => Effect.succeed([]),
      getSnapshotPools: () => Effect.succeed([]),
      getSnapshotCount: () => Effect.succeed(0),
      pruneSnapshots: () => Effect.succeed(0),
      saveFeedback: () => Effect.void,
      getFeedbackByHash: () => Effect.succeed(null),
      getRecentFeedbackForAgent: () => Effect.succeed([]),
      getLastFeedbackForAgent: () => Effect.succeed(null),
      listFeedbackForAgent: () => Effect.succeed([]),
      getMetadata: () => Effect.succeed(null),
      setMetadata: () => Effect.void,
      setMetadataBatch: () => Effect.void,
      saveFeeClaim: () => Effect.void,
      getUnreportedFeeClaims: () => Effect.succeed([]),
      markFeeClaimReported: () => Effect.void,
      saveSignalSnapshot: () => Effect.succeed(0),
      getSignalSnapshots: () => Effect.succeed([]),
      recordSignalOutcome: () => Effect.void,
      getRecentOutcomes: () => Effect.succeed([]),
      getEvolvedThresholds: () => Effect.succeed(null),
      saveEvolvedThresholds: () => Effect.void,
      getClosedPositionOutcomes: () => Effect.succeed([]),
      getSignalWeights: () => Effect.succeed(null),
      saveSignalWeights: () => Effect.void,
      getPoolCooldown: () => Effect.succeed(null),
      setPoolCooldown: () => Effect.void,
      clearPoolCooldown: () => Effect.void,
    };
  }

  function makeRevenueConfigSvc(): RevenueConfigApi {
    const config = {
      tier: "free",
      platformFeeRate: 0,
      revenueShareEnabled: false,
      revenueShareOperatorPct: 0,
      feeWalletAddress: "",
    };
    return {
      getConfig: () => Effect.succeed(config),
      refreshConfig: () => Effect.succeed(config),
    };
  }

  it("calls prepareEntryTokens on a live ENTER decision", () => {
    const poolAddress = "TestPool111111111111111111111111111111111111";
    const positionSizeUsd = 1234;

    const prepareSpy = vi.fn().mockReturnValue(Effect.void);

    const result = Effect.runSync(
      executeLive(
        {
          adapter: makeAdapter(),
          strategy: makeStrategy(),
          db: makeDb(),
          revenueConfigSvc: makeRevenueConfigSvc(),
          trackedPositions: new Map(),
          entryPrep: { prepareEntryTokens: prepareSpy },
        },
        {
          action: "ENTER",
          poolAddress,
          confidence: 0.8,
          reasoning: "test",
          positionSizeUsd,
        } as AgentDecision,
        { activeBinId: 5000, binStep: 10, tokenXSymbol: "SOL", tokenYSymbol: "USDC" },
      ),
    );

    expect(result.executed).toBe(true);
    expect(result.error).toBeUndefined();
    expect(prepareSpy).toHaveBeenCalledTimes(1);
    expect(prepareSpy).toHaveBeenCalledWith(poolAddress, positionSizeUsd);
  });

  it("skips enterPosition when prepareEntryTokens fails", () => {
    const poolAddress = "TestPool111111111111111111111111111111111111";
    const positionSizeUsd = 1234;

    const enterPositionSpy = vi.fn(() =>
      Effect.succeed({ positionPubKey: "mock-pos", txSignature: "mock-tx" }),
    );
    const adapter: AdapterApi = {
      ...makeAdapter(),
      enterPosition: enterPositionSpy,
    };

    const result = Effect.runSync(
      executeLive(
        {
          adapter,
          strategy: makeStrategy(),
          db: makeDb(),
          revenueConfigSvc: makeRevenueConfigSvc(),
          trackedPositions: new Map(),
          entryPrep: {
            prepareEntryTokens: () =>
              Effect.fail(
                new EntryPrepError({
                  code: "INSUFFICIENT_USDC_BALANCE",
                  message: "Not enough USDC",
                  poolAddress,
                }),
              ),
          },
        },
        {
          action: "ENTER",
          poolAddress,
          confidence: 0.8,
          reasoning: "test",
          positionSizeUsd,
        } as AgentDecision,
        { activeBinId: 5000, binStep: 10, tokenXSymbol: "SOL", tokenYSymbol: "USDC" },
      ),
    );

    expect(result.executed).toBe(false);
    expect(result.error).toContain("Entry token preparation failed");
    expect(enterPositionSpy).not.toHaveBeenCalled();
  });
});

describe("estimatePositionValue", () => {
  function makePos(lowerBinId: number, upperBinId: number, depositedUsd: number) {
    return {
      poolAddress: "pool1",
      positionPubKey: null,
      depositedUsd,
      currentValueUsd: depositedUsd,
      tokenXSymbol: "SOL",
      tokenYSymbol: "USDC",
      activeBinId: 5000,
      lowerBinId,
      upperBinId,
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
    };
  }

  function makePool(activeBinId: number) {
    return {
      address: "pool1",
      tokenX: "SOL",
      tokenY: "USDC",
      tokenXSymbol: "SOL",
      tokenYSymbol: "USDC",
      tvlUsd: 100_000,
      volume24hUsd: 30_000,
      fees24hUsd: 300,
      apr: 60,
      activeBinId,
      binStep: 10,
      currentPrice: 150,
      timestamp: Date.now(),
    };
  }

  it("returns deposited value when active bin is at center", () => {
    const pos = makePos(4980, 5020, 1000);
    const pool = makePool(5000);
    expect(estimatePositionValue(pos, pool)).toBe(1000);
  });

  it("decreases value as active bin drifts toward edge", () => {
    const pos = makePos(4980, 5020, 1000);
    const poolCenter = makePool(5000);
    const poolEdge = makePool(5020);
    const centerValue = estimatePositionValue(pos, poolCenter);
    const edgeValue = estimatePositionValue(pos, poolEdge);
    expect(edgeValue).toBeLessThan(centerValue);
  });

  it("reaches minimum value at far edge", () => {
    const pos = makePos(4980, 5020, 1000);
    const pool = makePool(5040);
    expect(estimatePositionValue(pos, pool)).toBe(500);
  });

  it("handles narrow ranges", () => {
    const pos = makePos(4995, 5005, 1000);
    const pool = makePool(5005);
    expect(estimatePositionValue(pos, pool)).toBe(500);
  });
});

describe("isProposalStale", () => {
  function makeProposal(proposedAt: number, expiresAt: number) {
    return {
      proposalId: "p-1",
      source: "http-queue" as const,
      originalAction: "HOLD" as const,
      action: "HOLD" as const,
      poolAddress: "pool1",
      confidence: 0.8,
      reasoning: "test",
      proposedAt,
      expiresAt,
      status: "pending" as const,
    };
  }

  it("returns false when both staleMs and expiresAt are in the future", () => {
    const now = 1000;
    const proposal = makeProposal(0, 2000);
    expect(isProposalStale(proposal, 5000, now)).toBe(false);
  });

  it("returns true when past the configured staleMs", () => {
    const now = 6000;
    const proposal = makeProposal(0, 2000);
    expect(isProposalStale(proposal, 5000, now)).toBe(true);
  });

  it("returns true when past the explicit expiresAt even if within staleMs", () => {
    const now = 1500;
    const proposal = makeProposal(0, 1000);
    expect(isProposalStale(proposal, 10_000, now)).toBe(true);
  });
});

describe("shouldHoldForSupervisedApproval", () => {
  it("holds ENTER and REBALANCE in supervised mode without an approved proposal", () => {
    expect(shouldHoldForSupervisedApproval(true, "supervised", false, "ENTER")).toBe(true);
    expect(shouldHoldForSupervisedApproval(true, "supervised", false, "REBALANCE")).toBe(true);
  });

  it("does not hold deterministic EXITs — the engine keeps final safety authority", () => {
    expect(shouldHoldForSupervisedApproval(true, "supervised", false, "EXIT")).toBe(false);
  });

  it("does not hold HOLD decisions", () => {
    expect(shouldHoldForSupervisedApproval(true, "supervised", false, "HOLD")).toBe(false);
  });

  it("does not hold when an approved queued proposal was applied", () => {
    expect(shouldHoldForSupervisedApproval(true, "supervised", true, "ENTER")).toBe(false);
  });

  it("does not hold in full or suggest modes", () => {
    expect(shouldHoldForSupervisedApproval(true, "full", false, "ENTER")).toBe(false);
    expect(shouldHoldForSupervisedApproval(true, "suggest", false, "ENTER")).toBe(false);
  });

  it("does not hold when the agent overlay is disabled", () => {
    expect(shouldHoldForSupervisedApproval(false, "supervised", false, "ENTER")).toBe(false);
  });
});

describe("finalizeAppliedProposal", () => {
  const makeAgentState = () => {
    const dequeued: string[][] = [];
    const agentState = {
      dequeueProposals: (ids: ReadonlyArray<string>) => {
        dequeued.push([...ids]);
        return Effect.void;
      },
    };
    return { agentState, dequeued };
  };

  it("dequeues the applied proposal after successful execution", async () => {
    const { agentState, dequeued } = makeAgentState();
    await Effect.runPromise(finalizeAppliedProposal(agentState, "p-1", true, "ENTER"));
    expect(dequeued).toEqual([["p-1"]]);
  });

  it("dequeues an applied HOLD proposal even though nothing executed", async () => {
    const { agentState, dequeued } = makeAgentState();
    await Effect.runPromise(finalizeAppliedProposal(agentState, "p-1", false, "HOLD"));
    expect(dequeued).toEqual([["p-1"]]);
  });

  it("retains the proposal when execution failed", async () => {
    const { agentState, dequeued } = makeAgentState();
    await Effect.runPromise(finalizeAppliedProposal(agentState, "p-1", false, "ENTER"));
    expect(dequeued).toEqual([]);
  });

  it("does nothing when no queued proposal was applied", async () => {
    const { agentState, dequeued } = makeAgentState();
    await Effect.runPromise(finalizeAppliedProposal(agentState, undefined, true, "ENTER"));
    expect(dequeued).toEqual([]);
  });
});
