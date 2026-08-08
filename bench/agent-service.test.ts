import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import {
  parseResponse,
  validateOverride,
  AgentNoOp,
  buildPrompt,
  buildProposalPrompt,
  selectTransport,
  connectReviewTransport,
  LatencyWindow,
} from "../engine/agent-service.js";
import { AcpTransport } from "../engine/acp-transport.js";
import { GatewayTransport } from "../engine/gateway-transport.js";
import type { AgentDecision } from "../engine/types.js";
import { AUTONOMOUS_TOKEN_CONFIG_DEFAULTS, type AppConfig } from "../engine/config-service.js";
import type {
  AgentPositionState,
  AgentRuntimeContext,
  AgentRuntimeDetection,
  AgentRuntimeTransport,
} from "../engine/agent-transport.js";

function makeDecision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return {
    poolAddress: "Pool111111111111111111111111111111111111111",
    action: "ENTER",
    confidence: 0.85,
    reasoning: "strong fee/IL ratio",
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
    ...AUTONOMOUS_TOKEN_CONFIG_DEFAULTS,
    scanIntervalMs: 600_000,
    minPoolTvlUsd: 50_000,
    minFeeIlRatio: 1.2,
    tvlDropExitPct: 0.3,
    volumeAuthThreshold: 0.7,
    minRebalanceIntervalMs: 86_400_000,
    minRebalanceNetBenefitUsd: 10,
    confidenceThreshold: 0.65,
    paperPortfolioUsd: 10_000,
    minBinUtilization: 0.3,
    maxRebalanceRangeBins: 50,
    watchlistPools: [],
    stopLossPct: 0.15,
    trailingStopPct: 0.1,
    trailingStopConfirmCycles: 2,
    oorGracePeriodCycles: 3,
    feeClaimIntervalMs: 86_400_000,
    enablePoolDiscovery: false,
    discoveryMinTvlUsd: 100_000,
    discoveryMinFeeRatio: 1.5,
    deployerBlacklistPath: "",
    tokenBlacklistPath: "",
    sqliteDbPath: "",
    enableSnapshotCapture: false,
    autoUpdate: true,
    updateCheckIntervalMs: 21_600_000,
    updateChannel: "stable",
    updateGithubRepo: "",
    updateAllowDirty: false,
    updateR2PublicUrl: "",
    forceUpdateEnabled: false,
    forceUpdateAfterDays: 14,
    githubToken: "",
    githubRepo: "",
    feedbackOptOut: false,
    paperModeExitLive: false,
    meteoraPoolsUrl: "",
    meteoraDatapiBaseUrl: "",
    rebalanceGasCostSol: 0.01,
    solPriceUsd: 150,
    gasAwareMinDaysOfFeesPaidAhead: 3,
    volatilityExitStddev: 5,
    volatilityLookbackSnapshots: 12,
    volatilityWideHalfWidthBins: 50,
    entryRangeHalfWidthBins: 0,
    volatilityAdaptiveRanges: false,
    autoCompoundFees: false,
    minCompoundFeesUsd: 0.5,
    compoundGasBufferUsd: 0.05,
    oorRecoveryLookbackCycles: 10,
    oorRecoveryHoldThreshold: 0.6,
    oorRecoveryForceRebalanceThreshold: 0.2,
    maxPerPoolAllocationPct: 0.4,
    maxOpenPositions: 3,
    maxPositionsPerPool: 2,
    maxEntrySizeUsd: 500,
    paperValidationMinDays: 7,
    paperValidationEnforce: false,
    agentiveMode: true,
    agentRuntime: "auto",
    agentAcpCommand: "hermes",
    agentAcpArgs: ["acp"],
    agentGatewayUrl: "ws://127.0.0.1:18789",
    agentGatewayToken: "",
    agentPromptTimeoutMs: 15_000,
    agentVetoTimeoutMs: 15_000,
    agentCheckinIntervalMs: 3_600_000,
    agentCheckinOnEvents: true,
    agentCheckinIncludeHistory: true,
    agentCheckinMaxPositions: 10,
    agentOpenclawWebhookUrl: "",
    agentHermesApiUrl: "",
    agentOpenclawWebhookToken: "",
    agentHermesApiToken: "",
    agentHttpPort: 18_790,
    agentMcpEnabled: true,
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
    oorCooldownMs: 4 * 60 * 60 * 1000,
    repeatOorCooldownMs: 12 * 60 * 60 * 1000,
    maxOorCooldownExits: 3,
    feeDensityCooldowns: true,
    feeDensityCooldownMinMs: 60 * 60 * 1000,
    feeDensityHighPct: 0.005,
    feeDensityLowPct: 0.0005,
    evolutionInterval: 5,
    evolutionMaxChangePct: 0.2,
    signalWeightWindowDays: 60,
    signalWeightMinOutcomes: 10,
    signalWeightBoostFactor: 1.05,
    signalWeightDecayFactor: 0.95,
    signalWeightFloor: 0.3,
    signalWeightCeiling: 2.5,
    weightedEntryScoreThreshold: 1.8,
    autoSwapEntry: false,
    entryStrategyType: "spot",
    idleRedeployEnabled: false,
    idleRedeployThresholdUsd: 500,
    idleRedeployMaxSizeUsd: 2000,
    farmRewardsEnabled: true,
    snapshotRetentionDays: 14,
    alertsEnabled: true,
    alertCooldownMinutes: 120,
    alertFeeMilestoneUsd: 10,
    ...overrides,
  };
}

describe("parseResponse", () => {
  it("parses JSON from a plain response", () => {
    expect(parseResponse('{"action":"HOLD","confidence":0.6}')).toEqual({
      action: "HOLD",
      confidence: 0.6,
    });
  });

  it("extracts JSON from surrounding text", () => {
    expect(
      parseResponse('Here is my response: {"action":"HOLD","confidence":0.5} thanks!'),
    ).toEqual({
      action: "HOLD",
      confidence: 0.5,
    });
  });

  it("returns empty object when no JSON found", () => {
    expect(parseResponse("no json here")).toEqual({});
  });

  it("returns empty object for invalid JSON", () => {
    expect(parseResponse('{"action":"HOLD",}')).toEqual({});
  });
});

describe("validateOverride", () => {
  it("returns null when parsed is empty", () => {
    const decision = makeDecision();
    expect(validateOverride(decision, {})).toBeNull();
  });

  it("allows reducing confidence", () => {
    const decision = makeDecision();
    const result = validateOverride(decision, { confidence: 0.5 });
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.5);
    expect(result!.action).toBe("ENTER");
  });

  it("prevents increasing confidence", () => {
    const decision = makeDecision({ confidence: 0.5 });
    const result = validateOverride(decision, { confidence: 0.9 });
    expect(result).toBeNull();
  });

  it("allows changing action to HOLD", () => {
    const decision = makeDecision();
    const result = validateOverride(decision, { action: "HOLD" });
    expect(result).not.toBeNull();
    expect(result!.action).toBe("HOLD");
  });

  it("rejects changing action to ENTER when not originally ENTER", () => {
    const decision = makeDecision({ action: "EXIT" });
    const result = validateOverride(decision, { action: "ENTER" });
    expect(result).toBeNull();
  });

  it("rejects invalid action strings", () => {
    const decision = makeDecision();
    const result = validateOverride(decision, { action: "BUY" });
    expect(result).toBeNull();
  });

  it("clamps confidence to [0,1]", () => {
    const decision = makeDecision({ confidence: 1.0 });
    const result = validateOverride(decision, { confidence: 1.5 });
    expect(result).toBeNull();
  });

  it("returns null when nothing changes", () => {
    const decision = makeDecision();
    expect(validateOverride(decision, { reasoning: "looks fine" })).toBeNull();
  });
});

describe("AgentNoOp", () => {
  it("enhanceDecision returns null", async () => {
    const result = await Effect.runPromise(AgentNoOp.enhanceDecision(makeDecision(), {} as never));
    expect(result).toBeNull();
  });

  it("sendCheckin returns void", async () => {
    await Effect.runPromise(AgentNoOp.sendCheckin({ type: "checkin" } as never));
  });

  it("sendAlert returns void", async () => {
    await Effect.runPromise(AgentNoOp.sendAlert({ type: "alert" } as never));
  });

  it("getStatus reports disconnected", async () => {
    const status = await Effect.runPromise(AgentNoOp.getStatus());
    expect(status.connected).toBe(false);
    expect(status.transport).toBeNull();
  });

  it("shouldSkipSyncProposal returns false (no-op never skips)", async () => {
    expect(await Effect.runPromise(AgentNoOp.shouldSkipSyncProposal())).toBe(false);
  });
});

describe("LatencyWindow", () => {
  // Budget 1000ms → skip threshold 950ms; skip needs ≥3 fresh samples of
  // which ≥2 are individually slow.
  const makeWindow = (): LatencyWindow =>
    new LatencyWindow({
      budgetMs: 1000,
      windowSize: 20,
      minSamples: 3,
      minSlowSamples: 2,
      sampleMaxAgeMs: 60_000,
    });

  it("does not skip before enough fresh samples exist", () => {
    const w = makeWindow();
    w.record(990, 1_000);
    expect(w.shouldSkip(1_000).skip).toBe(false);
    w.record(990, 2_000);
    expect(w.shouldSkip(2_000).skip).toBe(false);
  });

  it("engages the skip when the fresh-window p95 exceeds 95% of the budget", () => {
    const w = makeWindow();
    for (let i = 1; i <= 3; i++) w.record(990, i * 1_000);
    const result = w.shouldSkip(3_000);
    expect(result.skip).toBe(true);
    expect(result.p95Ms).toBe(990);
    expect(result.slowCount).toBe(3);
  });

  it("never engages when samples are fast", () => {
    const w = makeWindow();
    for (let i = 1; i <= 5; i++) w.record(100, i * 1_000);
    expect(w.shouldSkip(5_000).skip).toBe(false);
  });

  it("requires multiple slow samples — a single outlier cannot latch the skip", () => {
    const w = makeWindow();
    for (let i = 1; i <= 3; i++) w.record(100, i * 1_000);
    w.record(990, 4_000);
    expect(w.shouldSkip(4_000).skip).toBe(false);
  });

  it("drains and disengages once slow samples age out", () => {
    const w = makeWindow();
    for (let i = 1; i <= 3; i++) w.record(990, i * 1_000);
    expect(w.shouldSkip(3_000).skip).toBe(true);
    // All samples are older than sampleMaxAgeMs now; the window is empty.
    expect(w.shouldSkip(3_000 + 60_001).skip).toBe(false);
    expect(w.shouldSkip(3_000 + 60_001).windowSize).toBe(0);
  });
});

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

const makePositionState = (overrides: Partial<AgentPositionState> = {}): AgentPositionState => ({
  positionId: "pos-1",
  valueUsd: 1200,
  depositedUsd: 1000,
  unrealizedPnlUsd: 250,
  feesClaimedUsd: 50,
  rewardsClaimedUsd: 0,
  outOfRangeSinceMs: null,
  oorCycleCount: 0,
  hoursOutOfRange: null,
  hoursHeld: 3.5,
  activeBinId: 100,
  lowerBinId: 95,
  upperBinId: 110,
  entryPriceUsd: 1.2,
  highestValueUsd: 1300,
  lastRebalanceAtMs: 0,
  ...overrides,
});

describe("buildProposalPrompt", () => {
  it("embeds the current ENTER size in the decision block and response template", () => {
    const prompt = buildProposalPrompt(
      makeDecision({ action: "ENTER", positionSizeUsd: 2_500 }),
      makePromptCtx(makeDecision({ action: "ENTER", positionSizeUsd: 2_500 })),
    );
    expect(prompt).toContain("Position Size: $2500");
    expect(prompt).toContain('"positionSizeUsd": 2500');
    expect(prompt).not.toContain('"positionSizeUsd": 100');
  });

  it("embeds the current REBALANCE bin range in the decision block and response template", () => {
    const decision = makeDecision({
      action: "REBALANCE",
      rebalanceParams: { newLowerBinId: 500, newUpperBinId: 520, slippageBps: 50 },
    });
    const prompt = buildProposalPrompt(decision, makePromptCtx(decision));
    expect(prompt).toContain("Bin Range: 500 to 520");
    expect(prompt).toContain('"lowerBinId": 500, "upperBinId": 520');
    expect(prompt).not.toContain('"lowerBinId": 100, "upperBinId": 110');
  });

  it("falls back to placeholder values when the decision has no executable params", () => {
    const decision = makeDecision({ action: "HOLD" });
    const prompt = buildProposalPrompt(decision, makePromptCtx(decision));
    expect(prompt).not.toContain("Position Size:");
    expect(prompt).not.toContain("Bin Range:");
    expect(prompt).toContain('"positionSizeUsd": 100');
    expect(prompt).toContain('"lowerBinId": 100, "upperBinId": 110');
  });

  it("limits allowed actions for a deterministic HOLD decision with an open position", () => {
    const decision = makeDecision({ action: "HOLD" });
    const ctx = { ...makePromptCtx(decision), hasOpenPosition: true };
    const prompt = buildProposalPrompt(decision, ctx);
    expect(prompt).toContain("You may propose only: HOLD, REBALANCE, EXIT.");
    expect(prompt).toContain("allowed actions: HOLD, REBALANCE, EXIT");
    expect(prompt).toContain('"action": "HOLD"');
  });

  it("limits allowed actions for a deterministic HOLD decision without an open position", () => {
    const decision = makeDecision({ action: "HOLD" });
    const ctx = { ...makePromptCtx(decision), hasOpenPosition: false };
    const prompt = buildProposalPrompt(decision, ctx);
    expect(prompt).toContain("You may propose only: HOLD.");
    expect(prompt).toContain("allowed actions: HOLD");
    expect(prompt).toContain('"action": "HOLD"');
    expect(prompt).not.toContain("allowed actions: HOLD, REBALANCE, EXIT");
  });

  it("limits allowed actions for a deterministic EXIT decision", () => {
    const decision = makeDecision({ action: "EXIT" });
    const prompt = buildProposalPrompt(decision, makePromptCtx(decision));
    expect(prompt).toContain("You may propose only: EXIT.");
    expect(prompt).toContain("allowed actions: EXIT");
    expect(prompt).toContain('"action": "EXIT"');
    expect(prompt).not.toContain("allowed actions: HOLD, REBALANCE, EXIT");
  });

  it("allows only executable actions for a deterministic ENTER decision", () => {
    const decision = makeDecision({ action: "ENTER", positionSizeUsd: 1_000 });
    const prompt = buildProposalPrompt(decision, makePromptCtx(decision));
    expect(prompt).toContain("You may propose only: HOLD, ENTER.");
    expect(prompt).toContain("allowed actions: HOLD, ENTER");
    expect(prompt).toContain('"action": "ENTER"');
    expect(prompt).not.toContain("allowed actions: HOLD, REBALANCE, EXIT, ENTER");
  });

  it("embeds the POSITION block when the decision targets an open position", () => {
    const decision = makeDecision({ action: "REBALANCE" });
    const ctx = {
      ...makePromptCtx(decision),
      hasOpenPosition: true,
      position: makePositionState(),
    };
    const prompt = buildProposalPrompt(decision, ctx);
    expect(prompt).toContain("POSITION:");
    expect(prompt).toContain("Value: $1200.00 (deposited $1000.00)");
    expect(prompt).toContain("Unrealized PnL: +$250.00");
    expect(prompt).toContain("fees claimed $50.00, rewards $0.00");
    expect(prompt).toContain("In range: yes");
    expect(prompt).toContain("Age: 3.5h | range: bins 95..110 (active 100)");
    expect(prompt).toContain("Base EXIT/REBALANCE proposals on the POSITION state below.");
  });

  it("shows out-of-range and negative-PnL state in the POSITION block", () => {
    const decision = makeDecision({ action: "EXIT" });
    const ctx = {
      ...makePromptCtx(decision),
      hasOpenPosition: true,
      position: makePositionState({
        valueUsd: 800,
        unrealizedPnlUsd: -150,
        outOfRangeSinceMs: Date.now() - 7_200_000,
        hoursOutOfRange: 2,
        oorCycleCount: 2,
      }),
    };
    const prompt = buildProposalPrompt(decision, ctx);
    expect(prompt).toContain("Unrealized PnL: −$150.00");
    expect(prompt).toContain("In range: NO — out of range 2.0h (2 OOR cycle(s))");
  });

  it("omits the POSITION block for positionless decisions", () => {
    const decision = makeDecision({ action: "ENTER", positionSizeUsd: 1_000 });
    const prompt = buildProposalPrompt(decision, makePromptCtx(decision));
    expect(prompt).not.toContain("POSITION:");
  });
});

describe("buildPrompt (veto overlay)", () => {
  it("embeds the POSITION block for position-targeted decisions", () => {
    const decision = makeDecision({ action: "EXIT" });
    const ctx = {
      ...makePromptCtx(decision),
      hasOpenPosition: true,
      position: makePositionState(),
    };
    const prompt = buildPrompt(decision, ctx);
    expect(prompt).toContain("POSITION:");
    expect(prompt).toContain("Unrealized PnL: +$250.00");
    expect(prompt).toContain(
      "Base EXIT reviews on the position's PnL and out-of-range state below.",
    );
  });

  it("omits the POSITION block for positionless decisions", () => {
    const decision = makeDecision({ action: "HOLD" });
    const prompt = buildPrompt(decision, makePromptCtx(decision));
    expect(prompt).not.toContain("POSITION:");
  });

  it("shows out-of-range and negative-PnL state on the safety-critical EXIT review", () => {
    const decision = makeDecision({ action: "EXIT" });
    const ctx = {
      ...makePromptCtx(decision),
      hasOpenPosition: true,
      position: makePositionState({
        valueUsd: 800,
        unrealizedPnlUsd: -150,
        outOfRangeSinceMs: Date.now() - 7_200_000,
        hoursOutOfRange: 2,
        oorCycleCount: 2,
      }),
    };
    const prompt = buildPrompt(decision, ctx);
    expect(prompt).toContain("Unrealized PnL: −$150.00");
    expect(prompt).toContain("In range: NO — out of range 2.0h (2 OOR cycle(s))");
    expect(prompt).toContain(
      "Base EXIT reviews on the position's PnL and out-of-range state below.",
    );
  });
});

describe("transport factories", () => {
  it("AcpTransport has correct name", () => {
    const transport = new AcpTransport({ command: "hermes", args: ["acp"], timeoutMs: 15_000 });
    expect(transport.name).toBe("acp");
  });

  it("GatewayTransport has correct name", () => {
    const transport = new GatewayTransport({
      url: "ws://127.0.0.1:18789",
      token: "",
      timeoutMs: 15_000,
    });
    expect(transport.name).toBe("gateway");
  });
});

describe("selectTransport", () => {
  const openclawDetection = (gatewayRunning: boolean): AgentRuntimeDetection => ({
    hermes: { available: false, path: null },
    openclaw: { available: gatewayRunning, path: null, gatewayRunning },
    recommended: gatewayRunning ? "openclaw" : "none",
  });

  it("selects the gateway transport when the gateway is running and a token is set", () => {
    const config = makeConfig({ agentRuntime: "openclaw", agentGatewayToken: "secret" });
    const transport = selectTransport(config, openclawDetection(true));
    expect(transport?.name).toBe("gateway");
  });

  it("skips the gateway transport when AGENT_GATEWAY_TOKEN is empty (explicit openclaw)", () => {
    const config = makeConfig({ agentRuntime: "openclaw", agentGatewayToken: "" });
    const transport = selectTransport(config, openclawDetection(true));
    expect(transport).toBeNull();
  });

  it("treats a whitespace-only AGENT_GATEWAY_TOKEN as empty", () => {
    const config = makeConfig({ agentRuntime: "openclaw", agentGatewayToken: "   " });
    const transport = selectTransport(config, openclawDetection(true));
    expect(transport).toBeNull();
  });

  it("returns null in auto when the token is empty and no Hermes/ACP transport is available", () => {
    const config = makeConfig({ agentRuntime: "auto", agentGatewayToken: "" });
    const transport = selectTransport(config, openclawDetection(true));
    expect(transport).toBeNull();
  });

  it("falls back to the ACP transport in auto when the token is empty but Hermes is available", () => {
    const config = makeConfig({ agentRuntime: "auto", agentGatewayToken: "" });
    const detection: AgentRuntimeDetection = {
      hermes: { available: true, path: "/usr/local/bin/hermes" },
      openclaw: { available: true, path: null, gatewayRunning: true },
      recommended: "openclaw",
    };
    const transport = selectTransport(config, detection);
    expect(transport?.name).toBe("acp");
  });

  it("does not select the gateway transport when the gateway is not running", () => {
    const config = makeConfig({ agentRuntime: "openclaw", agentGatewayToken: "secret" });
    const transport = selectTransport(config, openclawDetection(false));
    expect(transport).toBeNull();
  });
});

describe("connectReviewTransport", () => {
  const makeTransport = (connect: () => Effect.Effect<void, Error>): AgentRuntimeTransport => ({
    name: "gateway",
    isAvailable: () => Effect.succeed(true),
    connect,
    disconnect: () => Effect.void,
    sendPrompt: () => Effect.succeed({ override: null, raw: "", latencyMs: 0 }),
    onEvent: () => {},
  });

  it("reports connected=true when the transport connects", async () => {
    const transport = makeTransport(() => Effect.void);
    const connected = await Effect.runPromise(connectReviewTransport(transport));
    expect(connected).toBe(true);
  });

  it("reports connected=false when the transport fails to connect", async () => {
    const transport = makeTransport(() =>
      Effect.fail(new Error("Gateway closed (1008): policy violation")),
    );
    const connected = await Effect.runPromise(connectReviewTransport(transport));
    expect(connected).toBe(false);
  });
});
