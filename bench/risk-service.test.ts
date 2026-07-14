import { describe, expect, it } from "vitest";
import { evaluateAgentProposal } from "../engine/risk-service.js";
import type { RiskContext } from "../engine/services.js";
import type { AppConfig } from "../engine/config-service.js";
import type { AgentProposal } from "../engine/types.js";

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
    agentProposalTimeoutMs: 15_000,
    agentProposalMaxBatchSize: 10,
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
      makeContext(),
      makeConfig(),
    );
    expect(result.valid).toBe(true);
    expect(result.adjustedDecision?.action).toBe("HOLD");
    expect(result.adjustedDecision?.confidence).toBe(0.5);
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
      makeContext(),
      makeConfig(),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Invalid rebalance range/);
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
