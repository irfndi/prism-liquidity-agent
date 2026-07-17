import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  evaluateAgentProposal,
  evaluateAgentRebalanceCapitalGates,
} from "../engine/risk-service.js";
import { buildProposalPrompt } from "../engine/agent-service.js";
import { parseProposalResponse } from "../engine/proposal-schema.js";
import type { RiskContext } from "../engine/services.js";
import type { AppConfig } from "../engine/config-service.js";
import type { AgentDecision, AgentProposal } from "../engine/types.js";
import type { AgentRuntimeContext } from "../engine/agent-transport.js";

function makeProposal(
  overrides: Partial<AgentProposal> & { action: AgentProposal["action"]; poolAddress: string },
): AgentProposal {
  return {
    proposalId: "p-1",
    source: "sync-prompt",
    confidence: 0.8,
    reasoning: "test",
    proposedAt: Date.now(),
    expiresAt: Date.now() + 300_000,
    status: "pending",
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    walletPrivateKey: "",
    heliusApiKey: "",
    solanaRpcUrl: "",
    solanaRpcFallbackUrl: "",
    paperTrading: true,
    scanIntervalMs: 600_000,
    minPoolTvlUsd: 50_000,
    minFeeIlRatio: 1.2,
    tvlDropExitPct: 0.2,
    volumeAuthThreshold: 0.7,
    minRebalanceIntervalMs: 3_600_000,
    minRebalanceNetBenefitUsd: 10,
    confidenceThreshold: 0.65,
    paperPortfolioUsd: 10_000,
    minBinUtilization: 0.1,
    maxRebalanceRangeBins: 50,
    watchlistPools: [],
    stopLossPct: 0.15,
    trailingStopPct: 0.1,
    oorGracePeriodCycles: 3,
    feeClaimIntervalMs: 86_400_000,
    enablePoolDiscovery: false,
    discoveryMinTvlUsd: 1_000_000,
    discoveryMinFeeRatio: 0.5,
    deployerBlacklistPath: "",
    tokenBlacklistPath: "",
    sqliteDbPath: ":memory:",
    enableSnapshotCapture: false,
    autoSwapEntry: false,
    autoUpdate: true,
    updateCheckIntervalMs: 86_400_000,
    updateChannel: "stable",
    updateGithubRepo: "irfndi/prism-liquidity-agent",
    updateAllowDirty: false,
    forceUpdateEnabled: false,
    forceUpdateAfterDays: 30,
    updateR2PublicUrl: "",
    githubToken: "",
    githubRepo: "irfndi/prism-liquidity-agent",
    feedbackOptOut: false,
    paperModeExitLive: false,
    meteoraPoolsUrl: "https://dlmm.datapi.meteora.ag",
    rebalanceGasCostSol: 0.005,
    solPriceUsd: 20,
    gasAwareMinDaysOfFeesPaidAhead: 3,
    volatilityExitStddev: 5,
    volatilityLookbackSnapshots: 20,
    volatilityWideHalfWidthBins: 20,
    autoCompoundFees: false,
    minCompoundFeesUsd: 1,
    compoundGasBufferUsd: 0.5,
    oorRecoveryLookbackCycles: 12,
    oorRecoveryHoldThreshold: 0.6,
    oorRecoveryForceRebalanceThreshold: 0.2,
    maxPerPoolAllocationPct: 0.4,
    maxOpenPositions: 3,
    paperValidationMinDays: 0,
    paperValidationEnforce: false,
    oorCooldownMs: 3_600_000,
    repeatOorCooldownMs: 86_400_000,
    maxOorCooldownExits: 3,
    agentiveMode: false,
    agentRuntime: "none",
    agentAcpCommand: "hermes",
    agentAcpArgs: ["acp"],
    agentGatewayUrl: "",
    agentGatewayToken: "",
    agentPromptTimeoutMs: 15_000,
    agentCheckinIntervalMs: 3_600_000,
    agentCheckinOnEvents: true,
    agentCheckinIncludeHistory: true,
    agentCheckinMaxPositions: 10,
    agentOpenclawWebhookUrl: "",
    agentHermesApiUrl: "",
    agentHttpPort: 0,
    agentMcpEnabled: false,
    agentProposalMode: "veto",
    agentProposalToken: "",
    agentApprovalToken: "",
    agentProposalTimeoutMs: 15_000,
    agentProposalMaxBatchSize: 10,
    agentProposalMaxQueueSize: 50,
    agentProposalStaleMs: 300_000,
    agentProposalBackoffBaseMs: 60_000,
    agentProposalBackoffMaxMs: 3_600_000,
    agentProposalMaxPositionSizePct: 0.4,
    agentProposalMinConfidence: 0.65,
    agentProposalCircuitBreakerThreshold: 5,
    agentProposalCircuitBreakerCooldownMs: 300_000,
    evolutionInterval: 5,
    evolutionMaxChangePct: 0.2,
    signalWeightWindowDays: 30,
    signalWeightMinOutcomes: 10,
    signalWeightBoostFactor: 1.5,
    signalWeightDecayFactor: 0.95,
    signalWeightFloor: 0.5,
    signalWeightCeiling: 2,
    weightedEntryScoreThreshold: 0.6,
    ...overrides,
  };
}

function makeContext(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    openPositions: [],
    portfolioValueUsd: 10_000,
    recentPnlUsd: 0,
    poolAddress: "pool1",
    ...overrides,
  };
}

describe("evaluateAgentProposal", () => {
  it("approves a valid HOLD proposal", () => {
    const result = evaluateAgentProposal(
      makeProposal({ action: "HOLD", poolAddress: "pool1" }),
      makeContext(),
      makeConfig(),
    );
    expect(result.valid).toBe(true);
    expect(result.adjustedDecision?.action).toBe("HOLD");
    expect(result.adjustedDecision?.confidence).toBe(0.8);
  });

  it("rejects an unknown action", () => {
    const proposal = {
      ...makeProposal({ action: "HOLD", poolAddress: "pool1" }),
      action: "BUY" as const,
    } as unknown as AgentProposal;
    const result = evaluateAgentProposal(proposal, makeContext(), makeConfig());
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Invalid action/);
  });

  it("rejects confidence below minimum", () => {
    const result = evaluateAgentProposal(
      makeProposal({ action: "HOLD", poolAddress: "pool1", confidence: 0.5 }),
      makeContext(),
      makeConfig(),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Confidence/);
  });

  it("allows proposals that preserve the original low-confidence decision", () => {
    const result = evaluateAgentProposal(
      makeProposal({
        action: "HOLD",
        poolAddress: "pool1",
        confidence: 0.5,
        originalAction: "HOLD",
        originalConfidence: 0.5,
      }),
      makeContext({
        originalDecision: {
          action: "HOLD",
          poolAddress: "pool1",
          confidence: 0.5,
          reasoning: "deterministic",
        },
      }),
      makeConfig(),
    );
    expect(result.valid).toBe(true);
    expect(result.adjustedDecision?.action).toBe("HOLD");
    expect(result.adjustedDecision?.confidence).toBe(0.5);
  });

  it("keeps the original confidence for a preserve-original waiver echo", () => {
    const result = evaluateAgentProposal(
      makeProposal({
        action: "ENTER",
        poolAddress: "pool1",
        confidence: 0.65,
        originalAction: "ENTER",
        originalConfidence: 0.646,
        positionSizeUsd: 1_000,
      }),
      makeContext({
        originalDecision: {
          action: "ENTER",
          poolAddress: "pool1",
          confidence: 0.646,
          reasoning: "deterministic",
          positionSizeUsd: 1_000,
        },
      }),
      makeConfig(),
    );
    expect(result.valid).toBe(true);
    expect(result.adjustedDecision?.action).toBe("ENTER");
    expect(result.adjustedDecision?.confidence).toBe(0.646);
  });

  it("applies the confidence floor to a HOLD echo without a trusted original decision", () => {
    const result = evaluateAgentProposal(
      makeProposal({
        action: "HOLD",
        poolAddress: "pool1",
        confidence: 0.5,
        originalAction: "HOLD",
        originalConfidence: 0.5,
      }),
      makeContext(),
      makeConfig(),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Confidence/);
  });

  it("applies the confidence floor to an EXIT echo without a trusted original decision", () => {
    const result = evaluateAgentProposal(
      makeProposal({
        action: "EXIT",
        poolAddress: "pool1",
        confidence: 0.5,
        originalAction: "EXIT",
        originalConfidence: 0.5,
      }),
      makeContext(),
      makeConfig(),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Confidence/);
  });

  it("rejects a proposal whose claimed originalAction conflicts with the trusted original", () => {
    const result = evaluateAgentProposal(
      makeProposal({
        action: "HOLD",
        poolAddress: "pool1",
        confidence: 0.5,
        originalAction: "HOLD",
        originalConfidence: 0.5,
      }),
      makeContext({
        originalDecision: {
          action: "ENTER",
          poolAddress: "pool1",
          confidence: 0.9,
          reasoning: "deterministic",
          positionSizeUsd: 1_000,
        },
      }),
      makeConfig(),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Confidence/);
  });

  it("rejects a proposal whose claimed originalConfidence conflicts with the trusted original", () => {
    const result = evaluateAgentProposal(
      makeProposal({
        action: "HOLD",
        poolAddress: "pool1",
        confidence: 0.5,
        originalAction: "HOLD",
        originalConfidence: 0.5,
      }),
      makeContext({
        originalDecision: {
          action: "HOLD",
          poolAddress: "pool1",
          confidence: 0.9,
          reasoning: "deterministic",
        },
      }),
      makeConfig(),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Confidence/);
  });

  it("waives the confidence floor when executable params match the original decision", () => {
    const result = evaluateAgentProposal(
      makeProposal({
        action: "ENTER",
        poolAddress: "pool1",
        confidence: 0.5,
        originalAction: "ENTER",
        originalConfidence: 0.5,
        positionSizeUsd: 1_000,
      }),
      makeContext({
        originalDecision: {
          action: "ENTER",
          poolAddress: "pool1",
          confidence: 0.5,
          reasoning: "deterministic",
          positionSizeUsd: 1_000,
        },
      }),
      makeConfig(),
    );
    expect(result.valid).toBe(true);
    expect(result.adjustedDecision?.positionSizeUsd).toBe(1_000);
  });

  it("waives the confidence floor for a matching REBALANCE echo despite differing slippage", () => {
    const result = evaluateAgentProposal(
      makeProposal({
        action: "REBALANCE",
        poolAddress: "pool1",
        confidence: 0.5,
        originalAction: "REBALANCE",
        originalConfidence: 0.5,
        rebalanceParams: { newLowerBinId: 100, newUpperBinId: 110, slippageBps: 0 },
      }),
      makeContext({
        openPositions: [
          {
            id: "pos-1",
            poolAddress: "pool1",
            poolName: "SOL/USDC",
            lowerBinId: 90,
            upperBinId: 120,
            liquidityShares: 0n,
            depositedUsd: 1_000,
            currentValueUsd: 1_000,
            unrealizedPnlUsd: 0,
            feesEarnedUsd: 0,
            openedAt: Date.now(),
          },
        ],
        originalDecision: {
          action: "REBALANCE",
          poolAddress: "pool1",
          confidence: 0.5,
          reasoning: "deterministic",
          rebalanceParams: { newLowerBinId: 100, newUpperBinId: 110, slippageBps: 50 },
        },
      }),
      makeConfig(),
    );
    expect(result.valid).toBe(true);
    expect(result.adjustedDecision?.rebalanceParams?.newUpperBinId).toBe(110);
  });

  it("applies the confidence floor when the proposal changes the position size", () => {
    const result = evaluateAgentProposal(
      makeProposal({
        action: "ENTER",
        poolAddress: "pool1",
        confidence: 0.5,
        originalAction: "ENTER",
        originalConfidence: 0.5,
        positionSizeUsd: 2_000,
      }),
      makeContext({
        originalDecision: {
          action: "ENTER",
          poolAddress: "pool1",
          confidence: 0.5,
          reasoning: "deterministic",
          positionSizeUsd: 1_000,
        },
      }),
      makeConfig(),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Confidence/);
  });

  it("applies the confidence floor when the proposal changes rebalance params", () => {
    const result = evaluateAgentProposal(
      makeProposal({
        action: "REBALANCE",
        poolAddress: "pool1",
        confidence: 0.5,
        originalAction: "REBALANCE",
        originalConfidence: 0.5,
        rebalanceParams: { newLowerBinId: 100, newUpperBinId: 110, slippageBps: 0 },
      }),
      makeContext({
        originalDecision: {
          action: "REBALANCE",
          poolAddress: "pool1",
          confidence: 0.5,
          reasoning: "deterministic",
          rebalanceParams: { newLowerBinId: 100, newUpperBinId: 120, slippageBps: 0 },
        },
      }),
      makeConfig(),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Confidence/);
  });

  it("applies the confidence floor when no original decision is available for comparison", () => {
    const result = evaluateAgentProposal(
      makeProposal({
        action: "ENTER",
        poolAddress: "pool1",
        confidence: 0.5,
        originalAction: "ENTER",
        originalConfidence: 0.5,
        positionSizeUsd: 1_000,
      }),
      makeContext(),
      makeConfig(),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Confidence/);
  });

  it("caps position size to agent and per-pool limits", () => {
    const result = evaluateAgentProposal(
      makeProposal({ action: "ENTER", poolAddress: "pool1", positionSizeUsd: 10_000 }),
      makeContext({ portfolioValueUsd: 10_000 }),
      makeConfig(),
    );
    expect(result.valid).toBe(true);
    expect(result.adjustedDecision?.positionSizeUsd).toBeLessThan(10_000);
  });

  it("rejects REBALANCE without rebalanceParams", () => {
    const result = evaluateAgentProposal(
      makeProposal({ action: "REBALANCE", poolAddress: "pool1" }),
      makeContext(),
      makeConfig(),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/rebalanceParams/);
  });

  it("rejects REBALANCE with an inverted range", () => {
    const result = evaluateAgentProposal(
      makeProposal({
        action: "REBALANCE",
        poolAddress: "pool1",
        rebalanceParams: { newLowerBinId: 100, newUpperBinId: 50, slippageBps: 0 },
      }),
      makeContext({
        openPositions: [
          {
            id: "pos-1",
            poolAddress: "pool1",
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
        ],
      }),
      makeConfig(),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Invalid rebalance range/);
  });

  it("rejects REBALANCE when no position is open for the pool", () => {
    const result = evaluateAgentProposal(
      makeProposal({
        action: "REBALANCE",
        poolAddress: "pool1",
        rebalanceParams: { newLowerBinId: 100, newUpperBinId: 110, slippageBps: 0 },
      }),
      makeContext({ openPositions: [] }),
      makeConfig(),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/no open position/);
  });

  it("rejects REBALANCE ranges that do not contain the active bin", () => {
    const result = evaluateAgentProposal(
      makeProposal({
        action: "REBALANCE",
        poolAddress: "pool1",
        rebalanceParams: { newLowerBinId: 1, newUpperBinId: 10, slippageBps: 0 },
      }),
      makeContext({
        activeBinId: 10_000,
        openPositions: [
          {
            id: "pos-1",
            poolAddress: "pool1",
            poolName: "SOL/USDC",
            lowerBinId: 9_980,
            upperBinId: 10_020,
            liquidityShares: 0n,
            depositedUsd: 1_000,
            currentValueUsd: 1_000,
            unrealizedPnlUsd: 0,
            feesEarnedUsd: 0,
            openedAt: Date.now(),
          },
        ],
      }),
      makeConfig(),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/does not contain active bin/);
  });

  it("approves REBALANCE when the active bin is inside the proposed range", () => {
    const result = evaluateAgentProposal(
      makeProposal({
        action: "REBALANCE",
        poolAddress: "pool1",
        rebalanceParams: { newLowerBinId: 9_990, newUpperBinId: 10_010, slippageBps: 0 },
      }),
      makeContext({
        activeBinId: 10_000,
        openPositions: [
          {
            id: "pos-1",
            poolAddress: "pool1",
            poolName: "SOL/USDC",
            lowerBinId: 9_980,
            upperBinId: 10_020,
            liquidityShares: 0n,
            depositedUsd: 1_000,
            currentValueUsd: 1_000,
            unrealizedPnlUsd: 0,
            feesEarnedUsd: 0,
            openedAt: Date.now(),
          },
        ],
      }),
      makeConfig(),
    );
    expect(result.valid).toBe(true);
  });

  it("rejects EXIT when no position is open for the pool", () => {
    const result = evaluateAgentProposal(
      makeProposal({ action: "EXIT", poolAddress: "pool1" }),
      makeContext({ openPositions: [] }),
      makeConfig(),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/no open position/);
  });

  it("rejects an advisor-initiated EXIT on an unheld pool", () => {
    const result = evaluateAgentProposal(
      makeProposal({ action: "EXIT", poolAddress: "pool1", originalAction: "HOLD" }),
      makeContext({ openPositions: [] }),
      makeConfig(),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/no open position/);
  });

  it("allows an echoed deterministic EXIT on an unheld pool as a no-op", () => {
    const result = evaluateAgentProposal(
      makeProposal({ action: "EXIT", poolAddress: "pool1", originalAction: "EXIT" }),
      makeContext({ openPositions: [] }),
      makeConfig(),
    );
    expect(result.valid).toBe(true);
    expect(result.adjustedDecision?.action).toBe("EXIT");
  });

  it("rejects a proposal targeting a different pool", () => {
    const result = evaluateAgentProposal(
      makeProposal({ action: "HOLD", poolAddress: "other-pool" }),
      makeContext({ poolAddress: "pool1" }),
      makeConfig(),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/poolAddress/);
  });

  it("cannot downgrade a safety EXIT", () => {
    const result = evaluateAgentProposal(
      makeProposal({ action: "HOLD", poolAddress: "pool1", originalAction: "EXIT" }),
      makeContext(),
      makeConfig(),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Cannot downgrade/);
  });

  it("cannot promote a non-ENTER action to ENTER", () => {
    const result = evaluateAgentProposal(
      makeProposal({
        action: "ENTER",
        poolAddress: "pool1",
        positionSizeUsd: 1_000,
        originalAction: "HOLD",
      }),
      makeContext(),
      makeConfig(),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Cannot promote/);
  });

  it("rejects ENTER without positionSizeUsd", () => {
    const result = evaluateAgentProposal(
      makeProposal({ action: "ENTER", poolAddress: "pool1" }),
      makeContext({ openPositions: [] }),
      makeConfig(),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/positionSizeUsd/);
  });

  it("rejects ENTER with zero positionSizeUsd", () => {
    const result = evaluateAgentProposal(
      makeProposal({ action: "ENTER", poolAddress: "pool1", positionSizeUsd: 0 }),
      makeContext({ openPositions: [] }),
      makeConfig(),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/positive/);
  });

  it("rejects ENTER with NaN positionSizeUsd", () => {
    const result = evaluateAgentProposal(
      makeProposal({ action: "ENTER", poolAddress: "pool1", positionSizeUsd: NaN }),
      makeContext({ openPositions: [] }),
      makeConfig(),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/positionSizeUsd/);
  });

  it("approves ENTER when the pool is not already held", () => {
    const result = evaluateAgentProposal(
      makeProposal({ action: "ENTER", poolAddress: "pool1", positionSizeUsd: 1_000 }),
      makeContext({ openPositions: [] }),
      makeConfig(),
    );
    expect(result.valid).toBe(true);
    expect(result.adjustedDecision?.action).toBe("ENTER");
  });

  it("rejects ENTER when the same pool is already held", () => {
    const result = evaluateAgentProposal(
      makeProposal({ action: "ENTER", poolAddress: "pool1", positionSizeUsd: 1_000 }),
      makeContext({
        openPositions: [
          {
            id: "pos-1",
            poolAddress: "pool1",
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
        ],
      }),
      makeConfig(),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Already holding/);
  });
});

describe("proposal template echo end-to-end", () => {
  const makePromptCtx = (decision: AgentDecision): AgentRuntimeContext =>
    ({
      decision,
      pool: {
        address: decision.poolAddress,
        tokenXSymbol: "SOL",
        tokenYSymbol: "USDC",
        tvlUsd: 100_000,
        volume24hUsd: 50_000,
        fees24hUsd: 500,
        apr: 12,
      },
      metrics: {
        feeIlRatio: 1.5,
        volumeAuthenticity: 0.9,
        binUtilization: 0.5,
        tvlVelocity: 0.01,
      },
      warnings: [],
      recentDecisions: [],
      hasOpenPosition: decision.action === "REBALANCE" || decision.action === "EXIT",
    }) as unknown as AgentRuntimeContext;

  // Simulate a faithful advisor: take the prompt's response template and
  // substitute only the action and confidence it is proposing.
  const echoTemplate = (decision: AgentDecision): AgentProposal => {
    const prompt = buildProposalPrompt(decision, makePromptCtx(decision));
    const template = prompt.slice(prompt.indexOf('{"action"'), prompt.lastIndexOf("}") + 1);
    const json = template
      .replace(/"action": "[^"]+"/, `"action": "${decision.action}"`)
      .replace("0.0-1.0", String(decision.confidence));
    return Effect.runSync(parseProposalResponse(json, decision.action));
  };

  it("a faithful template echo of a low-confidence HOLD passes the waiver", () => {
    const decision: AgentDecision = {
      action: "HOLD",
      poolAddress: "pool1",
      confidence: 0.5,
      reasoning: "deterministic",
    };
    const proposal = echoTemplate(decision);
    expect(proposal.positionSizeUsd).toBeUndefined();
    expect(proposal.rebalanceParams).toBeUndefined();
    const result = evaluateAgentProposal(
      proposal,
      makeContext({ originalDecision: decision }),
      makeConfig(),
    );
    expect(result.valid).toBe(true);
  });

  it("a faithful template echo of a low-confidence ENTER preserves the size and passes the waiver", () => {
    const decision: AgentDecision = {
      action: "ENTER",
      poolAddress: "pool1",
      confidence: 0.5,
      reasoning: "deterministic",
      positionSizeUsd: 2_500,
    };
    const proposal = echoTemplate(decision);
    expect(proposal.positionSizeUsd).toBe(2_500);
    const result = evaluateAgentProposal(
      proposal,
      makeContext({ originalDecision: decision }),
      makeConfig(),
    );
    expect(result.valid).toBe(true);
    expect(result.adjustedDecision?.positionSizeUsd).toBe(2_500);
  });

  it("a faithful template echo of a low-confidence REBALANCE round-trips the bin range and passes the waiver", () => {
    const decision: AgentDecision = {
      action: "REBALANCE",
      poolAddress: "pool1",
      confidence: 0.5,
      reasoning: "deterministic",
      rebalanceParams: { newLowerBinId: 500, newUpperBinId: 520, slippageBps: 50 },
    };
    const proposal = echoTemplate(decision);
    expect(proposal.rebalanceParams?.newLowerBinId).toBe(500);
    expect(proposal.rebalanceParams?.newUpperBinId).toBe(520);
    const result = evaluateAgentProposal(
      proposal,
      makeContext({
        openPositions: [
          {
            id: "pos-1",
            poolAddress: "pool1",
            poolName: "SOL/USDC",
            lowerBinId: 490,
            upperBinId: 530,
            liquidityShares: 0n,
            depositedUsd: 1_000,
            currentValueUsd: 1_000,
            unrealizedPnlUsd: 0,
            feesEarnedUsd: 0,
            openedAt: Date.now(),
          },
        ],
        originalDecision: decision,
      }),
      makeConfig(),
    );
    expect(result.valid).toBe(true);
    expect(result.adjustedDecision?.rebalanceParams?.newUpperBinId).toBe(520);
  });
});

describe("evaluateAgentRebalanceCapitalGates", () => {
  const baseInput = {
    now: 10_000_000,
    lastRebalanceAt: 0,
    minRebalanceIntervalMs: 3_600_000,
    oorGraceExpired: false,
    rebalanceGasCostSol: 0.01,
    solPriceUsd: 100,
    positionDailyFeesUsd: 50,
    minDaysOfFeesPaidAhead: 1,
    recoveryProbability: 0.2,
    oorRecoveryHoldThreshold: 0.7,
  };

  it("blocks rebalance inside the min-interval window", () => {
    const result = evaluateAgentRebalanceCapitalGates({
      ...baseInput,
      lastRebalanceAt: baseInput.now - 60_000,
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/min-interval/);
  });

  it("allows rebalance when OOR grace expires even inside min-interval", () => {
    const result = evaluateAgentRebalanceCapitalGates({
      ...baseInput,
      lastRebalanceAt: baseInput.now - 60_000,
      oorGraceExpired: true,
    });
    expect(result.approved).toBe(true);
  });

  it("blocks rebalance when gas gate fails", () => {
    const result = evaluateAgentRebalanceCapitalGates({
      ...baseInput,
      positionDailyFeesUsd: 0,
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/gas-gate/);
  });

  it("blocks rebalance when recovery probability is high", () => {
    const result = evaluateAgentRebalanceCapitalGates({
      ...baseInput,
      recoveryProbability: 0.9,
      oorRecoveryHoldThreshold: 0.7,
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/recovery-gate/);
  });

  it("approves when all capital gates pass", () => {
    const result = evaluateAgentRebalanceCapitalGates(baseInput);
    expect(result.approved).toBe(true);
  });
});
