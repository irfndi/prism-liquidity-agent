import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { parseResponse, validateOverride, AgentNoOp } from "../engine/agent-service.js";
import { AcpTransport } from "../engine/acp-transport.js";
import { GatewayTransport } from "../engine/gateway-transport.js";
import type { AgentDecision } from "../engine/types.js";
import type { AppConfig } from "../engine/config-service.js";
import type { AgentRuntimeDetection } from "../engine/agent-transport.js";

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
    paperTrading: true,
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
    rebalanceGasCostSol: 0.01,
    solPriceUsd: 150,
    gasAwareMinDaysOfFeesPaidAhead: 3,
    volatilityExitStddev: 5,
    volatilityLookbackSnapshots: 12,
    volatilityWideHalfWidthBins: 50,
    autoCompoundFees: false,
    minCompoundFeesUsd: 0.5,
    compoundGasBufferUsd: 0.05,
    oorRecoveryLookbackCycles: 10,
    oorRecoveryHoldThreshold: 0.6,
    oorRecoveryForceRebalanceThreshold: 0.2,
    maxPerPoolAllocationPct: 0.4,
    maxOpenPositions: 3,
    paperValidationMinDays: 7,
    paperValidationEnforce: false,
    agentiveMode: true,
    agentRuntime: "auto",
    agentAcpCommand: "hermes",
    agentAcpArgs: ["acp"],
    agentGatewayUrl: "ws://127.0.0.1:18789",
    agentGatewayToken: "",
    agentPromptTimeoutMs: 15_000,
    agentCheckinIntervalMs: 3_600_000,
    agentCheckinOnEvents: true,
    agentCheckinIncludeHistory: true,
    agentCheckinMaxPositions: 10,
    agentOpenclawWebhookUrl: "",
    agentHermesApiUrl: "",
    agentHttpPort: 18_790,
    agentMcpEnabled: true,
    oorCooldownMs: 4 * 60 * 60 * 1000,
    repeatOorCooldownMs: 12 * 60 * 60 * 1000,
    maxOorCooldownExits: 3,
    evolutionInterval: 5,
    evolutionMaxChangePct: 0.2,
    signalWeightWindowDays: 60,
    signalWeightMinOutcomes: 10,
    signalWeightBoostFactor: 1.05,
    signalWeightDecayFactor: 0.95,
    signalWeightFloor: 0.3,
    signalWeightCeiling: 2.5,
    weightedEntryScoreThreshold: 1.8,
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
