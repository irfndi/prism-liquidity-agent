import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import {
  buildLayer,
  buildPositionSnapshots,
  estimatePositionValue,
  executeLive,
  finalizeAppliedProposal,
  hasSyncProposalTransport,
  isProposalStale,
  decisionChangesExecutableBehavior,
  recordAppliedProposalRiskApproval,
  recordAppliedProposalRiskDenial,
  shouldHoldForSupervisedApproval,
  shouldPenalizeAppliedProposalDenial,
} from "../engine/program.js";
import type { ProposalBackoff } from "../engine/proposal-backoff.js";
import type { AgentDecision } from "../engine/types.js";
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
      getMintAuthorities: () => Effect.succeed({ mintAuthority: null, freezeAuthority: null }),
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
          volumeAuthenticityKnown: true,
          binUtilizationKnown: true,
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
      closePosition: () => Effect.void,
      getClosedPositions: () => Effect.succeed([]),
      savePositionEvent: () => Effect.void,
      getPositionEvents: () => Effect.succeed([]),
      getLatestSnapshotPrice: () => Effect.succeed(null),
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
          solPriceUsd: 150,
        },
        {
          action: "ENTER",
          poolAddress,
          confidence: 0.8,
          reasoning: "test",
          positionSizeUsd,
        } as AgentDecision,
        {
          activeBinId: 5000,
          binStep: 10,
          tokenXSymbol: "SOL",
          tokenYSymbol: "USDC",
          currentPrice: 150,
        },
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
          solPriceUsd: 150,
        },
        {
          action: "ENTER",
          poolAddress,
          confidence: 0.8,
          reasoning: "test",
          positionSizeUsd,
        } as AgentDecision,
        {
          activeBinId: 5000,
          binStep: 10,
          tokenXSymbol: "SOL",
          tokenYSymbol: "USDC",
          currentPrice: 150,
        },
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
      entryPriceUsd: null,
      entryAmountXUsd: null,
      entryAmountYUsd: null,
      cumulativeFeesClaimedUsd: 0,
      closedAt: null,
      realizedPnlUsd: null,
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

describe("hasSyncProposalTransport", () => {
  it("is false for AgentNoOp / disconnected runtimes", () => {
    expect(hasSyncProposalTransport({ transport: null })).toBe(false);
  });

  it("is false for alert-only transports", () => {
    expect(hasSyncProposalTransport({ transport: "alert-only" })).toBe(false);
  });

  it("is true when a real advisor transport is present", () => {
    expect(hasSyncProposalTransport({ transport: "acp" })).toBe(true);
    expect(hasSyncProposalTransport({ transport: "gateway" })).toBe(true);
  });
});

describe("decisionChangesExecutableBehavior", () => {
  const base = (overrides: Partial<AgentDecision> = {}): AgentDecision => ({
    action: "HOLD",
    poolAddress: "pool-a",
    confidence: 0.5,
    reasoning: "deterministic",
    ...overrides,
  });

  it("is false for pure preserve-original echoes", () => {
    expect(decisionChangesExecutableBehavior(base(), base({ reasoning: "advisor" }))).toBe(false);
  });

  it("is true when action or confidence changes", () => {
    expect(
      decisionChangesExecutableBehavior(base(), base({ action: "EXIT", confidence: 0.5 })),
    ).toBe(true);
    expect(decisionChangesExecutableBehavior(base(), base({ confidence: 0.9 }))).toBe(true);
  });

  it("is true when positionSizeUsd appears, disappears, or changes", () => {
    expect(decisionChangesExecutableBehavior(base(), base({ positionSizeUsd: 1_000 }))).toBe(true);
    expect(decisionChangesExecutableBehavior(base({ positionSizeUsd: 1_000 }), base())).toBe(true);
    expect(
      decisionChangesExecutableBehavior(
        base({ positionSizeUsd: 1_000 }),
        base({ positionSizeUsd: 2_000 }),
      ),
    ).toBe(true);
    expect(
      decisionChangesExecutableBehavior(
        base({ positionSizeUsd: 1_000 }),
        base({ positionSizeUsd: 1_000 }),
      ),
    ).toBe(false);
  });

  it("is true when rebalanceParams appear, disappear, or change bin ids", () => {
    const params = { newLowerBinId: 100, newUpperBinId: 110, slippageBps: 0 };
    expect(decisionChangesExecutableBehavior(base(), base({ rebalanceParams: params }))).toBe(true);
    expect(decisionChangesExecutableBehavior(base({ rebalanceParams: params }), base())).toBe(true);
    expect(
      decisionChangesExecutableBehavior(
        base({ rebalanceParams: params }),
        base({ rebalanceParams: { ...params, newUpperBinId: 120 } }),
      ),
    ).toBe(true);
  });

  it("ignores slippage-only differences, mirroring rebalanceParamsEqual", () => {
    expect(
      decisionChangesExecutableBehavior(
        base({
          rebalanceParams: { newLowerBinId: 100, newUpperBinId: 110, slippageBps: 50 },
        }),
        base({
          rebalanceParams: { newLowerBinId: 100, newUpperBinId: 110, slippageBps: 0 },
        }),
      ),
    ).toBe(false);
  });

  it("treats a confidence nudge across the gate threshold as a behavior change", () => {
    expect(
      decisionChangesExecutableBehavior(
        base({ confidence: 0.652 }),
        base({ confidence: 0.648 }),
        0.65,
      ),
    ).toBe(true);
    expect(
      decisionChangesExecutableBehavior(
        base({ confidence: 0.648 }),
        base({ confidence: 0.652 }),
        0.65,
      ),
    ).toBe(true);
    expect(
      decisionChangesExecutableBehavior(
        base({ confidence: 0.66 }),
        base({ confidence: 0.656 }),
        0.65,
      ),
    ).toBe(false);
    // Without a threshold, the same epsilon nudge stays a no-op echo.
    expect(
      decisionChangesExecutableBehavior(base({ confidence: 0.652 }), base({ confidence: 0.648 })),
    ).toBe(false);
  });
});

describe("recordAppliedProposalRiskApproval", () => {
  it("clears backoff and records circuit success for a validated proposal", () => {
    const proposalBackoff = new Map<string, ProposalBackoff>([
      ["pool-a", { failures: 2, nextProposalAt: 1_000_000 }],
    ]);
    let successes = 0;
    recordAppliedProposalRiskApproval({
      proposalValidated: true,
      proposalBackoff,
      recordCircuitSuccess: () => {
        successes++;
      },
      poolAddress: "pool-a",
    });
    expect(proposalBackoff.has("pool-a")).toBe(false);
    expect(successes).toBe(1);
  });

  it("does nothing when no proposal was validated", () => {
    const proposalBackoff = new Map<string, ProposalBackoff>([
      ["pool-a", { failures: 2, nextProposalAt: 1_000_000 }],
    ]);
    let successes = 0;
    recordAppliedProposalRiskApproval({
      proposalValidated: false,
      proposalBackoff,
      recordCircuitSuccess: () => {
        successes++;
      },
      poolAddress: "pool-a",
    });
    expect(proposalBackoff.has("pool-a")).toBe(true);
    expect(successes).toBe(0);
  });
});

describe("shouldPenalizeAppliedProposalDenial", () => {
  const base = (overrides: Partial<AgentDecision> = {}): AgentDecision => ({
    action: "HOLD",
    poolAddress: "pool-a",
    confidence: 0.5,
    reasoning: "deterministic",
    ...overrides,
  });

  it("is false when no behavior-changing proposal was applied", () => {
    expect(
      shouldPenalizeAppliedProposalDenial({
        appliedAgentProposal: false,
        preApplyDecision: undefined,
        appliedDecision: base(),
        isPreApplyRiskApproved: () => {
          throw new Error("must not be consulted");
        },
      }),
    ).toBe(false);
  });

  it("is true for a real behavior change without consulting pre-apply risk", () => {
    expect(
      shouldPenalizeAppliedProposalDenial({
        appliedAgentProposal: true,
        preApplyDecision: base(),
        appliedDecision: base({ action: "EXIT" }),
        isPreApplyRiskApproved: () => {
          throw new Error("must not be consulted");
        },
      }),
    ).toBe(true);
  });

  it("is true for a confidence-only nudge that caused the denial", () => {
    expect(
      shouldPenalizeAppliedProposalDenial({
        appliedAgentProposal: true,
        preApplyDecision: base({ confidence: 0.652 }),
        appliedDecision: base({ confidence: 0.648 }),
        isPreApplyRiskApproved: () => true,
      }),
    ).toBe(true);
  });

  it("is false for a confidence-only nudge when the deterministic decision was already denied", () => {
    expect(
      shouldPenalizeAppliedProposalDenial({
        appliedAgentProposal: true,
        preApplyDecision: base({ confidence: 0.652 }),
        appliedDecision: base({ confidence: 0.648 }),
        isPreApplyRiskApproved: () => false,
      }),
    ).toBe(false);
  });

  it("is false for a >=0.005 same-action nudge when the deterministic decision was already denied", () => {
    expect(
      shouldPenalizeAppliedProposalDenial({
        appliedAgentProposal: true,
        preApplyDecision: base({ action: "ENTER", confidence: 0.66 }),
        appliedDecision: base({ action: "ENTER", confidence: 0.65 }),
        isPreApplyRiskApproved: () => false,
      }),
    ).toBe(false);
  });

  it("is true when the pre-apply decision is unavailable", () => {
    expect(
      shouldPenalizeAppliedProposalDenial({
        appliedAgentProposal: true,
        preApplyDecision: undefined,
        appliedDecision: base({ confidence: 0.648 }),
        isPreApplyRiskApproved: () => false,
      }),
    ).toBe(true);
  });
});

describe("recordAppliedProposalRiskDenial", () => {
  it("rejects a queued applied proposal, arms backoff, and records circuit failure", async () => {
    const rejected: string[] = [];
    const circuitFailures: number[] = [];
    const proposalBackoff = new Map<string, ProposalBackoff>();
    const agentState = {
      rejectProposal: (id: string) =>
        Effect.sync(() => {
          rejected.push(id);
        }),
    };

    await Effect.runPromise(
      recordAppliedProposalRiskDenial(agentState, {
        penalizeAdvisor: true,
        appliedQueuedProposalId: "p-risk-1",
        proposalBackoff,
        recordCircuitFailure: (now) => {
          circuitFailures.push(now);
        },
        poolAddress: "pool-a",
        now: 1_000_000,
        backoff: { baseMs: 60_000, maxMs: 3_600_000 },
      }),
    );

    expect(rejected).toEqual(["p-risk-1"]);
    expect(circuitFailures).toEqual([1_000_000]);
    const backoff = proposalBackoff.get("pool-a");
    expect(backoff).toBeDefined();
    expect(backoff!.failures).toBe(1);
    expect(backoff!.nextProposalAt).toBeGreaterThan(1_000_000);
  });

  it("arms backoff and circuit failure for sync proposals without a queue id", async () => {
    const rejected: string[] = [];
    const circuitFailures: number[] = [];
    const proposalBackoff = new Map<string, ProposalBackoff>();
    const agentState = {
      rejectProposal: (id: string) =>
        Effect.sync(() => {
          rejected.push(id);
        }),
    };

    await Effect.runPromise(
      recordAppliedProposalRiskDenial(agentState, {
        penalizeAdvisor: true,
        appliedQueuedProposalId: undefined,
        proposalBackoff,
        recordCircuitFailure: (now) => {
          circuitFailures.push(now);
        },
        poolAddress: "pool-a",
        now: 1_000_000,
        backoff: { baseMs: 60_000, maxMs: 3_600_000 },
      }),
    );

    expect(rejected).toEqual([]);
    expect(circuitFailures).toEqual([1_000_000]);
    const backoff = proposalBackoff.get("pool-a");
    expect(backoff).toBeDefined();
    expect(backoff!.failures).toBe(1);
  });

  it("is a no-op when penalization is not warranted", async () => {
    const rejected: string[] = [];
    const circuitFailures: number[] = [];
    const proposalBackoff = new Map<string, ProposalBackoff>();
    const agentState = {
      rejectProposal: (id: string) =>
        Effect.sync(() => {
          rejected.push(id);
        }),
    };

    await Effect.runPromise(
      recordAppliedProposalRiskDenial(agentState, {
        penalizeAdvisor: false,
        appliedQueuedProposalId: undefined,
        proposalBackoff,
        recordCircuitFailure: (now) => {
          circuitFailures.push(now);
        },
        poolAddress: "pool-a",
        now: 1_000_000,
        backoff: { baseMs: 60_000, maxMs: 3_600_000 },
      }),
    );

    expect(rejected).toEqual([]);
    expect(circuitFailures).toEqual([]);
    expect(proposalBackoff.size).toBe(0);
  });

  it("rejects a queued no-op echo without arming backoff", async () => {
    const rejected: string[] = [];
    const circuitFailures: number[] = [];
    const proposalBackoff = new Map<string, ProposalBackoff>();
    const agentState = {
      rejectProposal: (id: string) =>
        Effect.sync(() => {
          rejected.push(id);
        }),
    };

    await Effect.runPromise(
      recordAppliedProposalRiskDenial(agentState, {
        penalizeAdvisor: false,
        appliedQueuedProposalId: "p-noop",
        proposalBackoff,
        recordCircuitFailure: (now) => {
          circuitFailures.push(now);
        },
        poolAddress: "pool-a",
        now: 1_000_000,
        backoff: { baseMs: 60_000, maxMs: 3_600_000 },
      }),
    );

    expect(rejected).toEqual(["p-noop"]);
    expect(circuitFailures).toEqual([]);
    expect(proposalBackoff.size).toBe(0);
  });

  it("escalates backoff across repeated penalized cycles without intermediate success", async () => {
    const proposalBackoff = new Map<string, ProposalBackoff>();
    const agentState = {
      rejectProposal: () => Effect.void,
    };
    const args = {
      penalizeAdvisor: true as const,
      appliedQueuedProposalId: undefined as string | undefined,
      proposalBackoff,
      recordCircuitFailure: () => {},
      poolAddress: "pool-a",
      backoff: { baseMs: 60_000, maxMs: 3_600_000 },
    };

    await Effect.runPromise(
      recordAppliedProposalRiskDenial(agentState, { ...args, now: 1_000_000 }),
    );
    const first = proposalBackoff.get("pool-a");
    expect(first?.failures).toBe(1);

    await Effect.runPromise(
      recordAppliedProposalRiskDenial(agentState, { ...args, now: 2_000_000 }),
    );
    const second = proposalBackoff.get("pool-a");
    expect(second?.failures).toBe(2);
    expect(second!.nextProposalAt).toBeGreaterThan(first!.nextProposalAt);
  });
});

describe("buildPositionSnapshots", () => {
  it("maps tracked positions to agent state snapshots", () => {
    const now = 1_000_000;
    const positions = [
      {
        poolAddress: "pool-a",
        tokenXSymbol: "SOL",
        tokenYSymbol: "USDC",
        depositedUsd: 1000,
        currentValueUsd: 1100,
        activeBinId: 100,
        lowerBinId: 90,
        upperBinId: 110,
        timestamp: now - 3_600_000,
        outOfRangeSince: null,
        oorCycleCount: 0,
        lastFeeClaimAt: 0,
        trailingStopThreshold: null,
        highestValueUsd: null,
        lastRebalanceAt: now - 3_600_000,
        positionPubKey: null,
        paperExitedAt: null,
        entrySignalTimestamp: null,
        entrySignalSnapshotId: null,
        entryPriceUsd: null,
        entryAmountXUsd: null,
        entryAmountYUsd: null,
        cumulativeFeesClaimedUsd: 0,
        closedAt: null,
        realizedPnlUsd: null,
      },
      {
        poolAddress: "pool-b",
        tokenXSymbol: "BONK",
        tokenYSymbol: "SOL",
        depositedUsd: 500,
        currentValueUsd: 450,
        activeBinId: 200,
        lowerBinId: 180,
        upperBinId: 220,
        timestamp: now - 7_200_000,
        outOfRangeSince: null,
        oorCycleCount: 0,
        lastFeeClaimAt: 0,
        trailingStopThreshold: null,
        highestValueUsd: null,
        lastRebalanceAt: now - 1_800_000,
        positionPubKey: "pubkey",
        paperExitedAt: null,
        entrySignalTimestamp: null,
        entrySignalSnapshotId: null,
        entryPriceUsd: null,
        entryAmountXUsd: null,
        entryAmountYUsd: null,
        cumulativeFeesClaimedUsd: 0,
        closedAt: null,
        realizedPnlUsd: null,
      },
    ];

    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const snapshots = buildPositionSnapshots(positions);
      expect(snapshots).toHaveLength(2);
      expect(snapshots[0]).toMatchObject({
        poolAddress: "pool-a",
        tokenXSymbol: "SOL",
        tokenYSymbol: "USDC",
        depositedUsd: 1000,
        currentValueUsd: 1100,
        activeBinId: 100,
        lowerBinId: 90,
        upperBinId: 110,
        lastAction: "ENTER",
        lastActionAt: now - 3_600_000,
      });
      expect(snapshots[0]!.hoursHeld).toBeCloseTo(1);
      expect(snapshots[1]).toMatchObject({
        poolAddress: "pool-b",
        tokenXSymbol: "BONK",
        tokenYSymbol: "SOL",
        depositedUsd: 500,
        currentValueUsd: 450,
        activeBinId: 200,
        lowerBinId: 180,
        upperBinId: 220,
        lastAction: "REBALANCE",
        lastActionAt: now - 1_800_000,
      });
      expect(snapshots[1]!.hoursHeld).toBeCloseTo(2);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("returns an empty array when no positions are tracked", () => {
    expect(buildPositionSnapshots([])).toEqual([]);
  });
});
