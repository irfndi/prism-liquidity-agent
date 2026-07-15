import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { HttpStatusServer } from "../engine/http-status-server.js";
import type { AppConfig } from "../engine/config-service.js";
import type { AgentStateApi } from "../engine/services.js";
import type { AgentProposal } from "../engine/types.js";
import type { PrismStateSnapshot } from "../engine/state-service.js";

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    walletPrivateKey: "",
    heliusApiKey: "",
    solanaRpcUrl: "",
    solanaRpcFallbackUrl: "",
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
    agentiveMode: false,
    agentRuntime: "none",
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
    agentHttpPort: 0,
    agentMcpEnabled: true,
    agentProposalMode: "veto",
    agentProposalToken: "",
    agentApprovalToken: "",
    agentProposalTimeoutMs: 15_000,
    agentProposalMaxBatchSize: 10,
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
    ...overrides,
  };
}

function mockState(snapshot: Record<string, unknown> = {}) {
  return {
    getSnapshot: () => Effect.succeed(snapshot as never),
    updateSnapshot: () => Effect.void,
    setAgentPolicy: () => Effect.void,
    enqueueProposal: () => Effect.void,
    dequeueProposals: () => Effect.void,
    approveProposal: () => Effect.void,
    rejectProposal: () => Effect.void,
  };
}

function baseSnapshot(overrides: Partial<PrismStateSnapshot> = {}): PrismStateSnapshot {
  return {
    programStartTime: Date.now(),
    scanCount: 0,
    lastCycleAt: null,
    portfolio: {
      totalValueUsd: 0,
      unrealizedPnlUsd: 0,
      realizedPnlUsd: 0,
      openPositions: 0,
      maxPositions: 0,
      walletBalanceUsd: 0,
    },
    positions: [],
    recentDecisions: [],
    agentPolicy: {
      mode: "veto",
      proposalsQueued: 0,
      lastProposalAt: null,
      badProposalBackoffUntil: null,
      circuitBreakerOpen: false,
      hardCaps: {
        maxPositionSizePct: 0.4,
        maxRebalanceRangeBins: 50,
        minProposalConfidence: 0.65,
        proposalStaleMs: 300_000,
      },
    },
    pendingProposals: [],
    ...overrides,
  };
}

function mockAgentState(
  snapshot: PrismStateSnapshot,
  enqueued: AgentProposal[] = [],
): AgentStateApi {
  return {
    getSnapshot: () => Effect.succeed(snapshot),
    updateSnapshot: () => Effect.void,
    setAgentPolicy: () => Effect.void,
    enqueueProposal: (proposal: AgentProposal) =>
      Effect.sync(() => {
        enqueued.push(proposal);
      }),
    dequeueProposals: () => Effect.void,
    approveProposal: () => Effect.void,
    rejectProposal: () => Effect.void,
  };
}

describe("HttpStatusServer", () => {
  it("does not start when port is 0", async () => {
    const server = new HttpStatusServer(baseConfig(), mockState());
    await Effect.runPromise(server.start());
    expect(server).toBeDefined();
    await Effect.runPromise(server.stop());
  });

  it("serves status endpoint", async () => {
    const port = 18_799;
    const server = new HttpStatusServer(
      baseConfig({ agentHttpPort: port }),
      mockState({
        programStartTime: Date.now() - 1000,
        scanCount: 3,
        lastCycleAt: Date.now(),
        portfolio: {
          totalValueUsd: 12_000,
          unrealizedPnlUsd: 2000,
          realizedPnlUsd: 0,
          openPositions: 1,
          maxPositions: 3,
          walletBalanceUsd: 10_000,
        },
        positions: [],
        recentDecisions: [],
      }),
    );
    await Effect.runPromise(server.start());
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        scanCount: number;
        portfolio: { totalValueUsd: number };
      };
      expect(body.scanCount).toBe(3);
      expect(body.portfolio.totalValueUsd).toBe(12_000);
    } finally {
      await Effect.runPromise(server.stop());
    }
  });

  it("serves positions endpoint with filter", async () => {
    const port = 18_798;
    const server = new HttpStatusServer(
      baseConfig({ agentHttpPort: port }),
      mockState({
        programStartTime: Date.now(),
        scanCount: 0,
        lastCycleAt: null,
        portfolio: {} as never,
        positions: [
          {
            poolAddress: "poolA",
            tokenXSymbol: "X",
            tokenYSymbol: "Y",
            depositedUsd: 100,
            currentValueUsd: 110,
            activeBinId: 1,
            lowerBinId: 0,
            upperBinId: 2,
            lastAction: "ENTER",
            lastActionAt: Date.now(),
            hoursHeld: 0,
          },
          {
            poolAddress: "poolB",
            tokenXSymbol: "A",
            tokenYSymbol: "B",
            depositedUsd: 200,
            currentValueUsd: 210,
            activeBinId: 10,
            lowerBinId: 8,
            upperBinId: 12,
            lastAction: "ENTER",
            lastActionAt: Date.now(),
            hoursHeld: 0,
          },
        ],
        recentDecisions: [],
      }),
    );
    await Effect.runPromise(server.start());
    try {
      const response = await fetch(`http://127.0.0.1:${port}/positions?pool=poolA`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { positions: ReadonlyArray<{ poolAddress: string }> };
      expect(body.positions).toHaveLength(1);
      expect(body.positions[0]!.poolAddress).toBe("poolA");
    } finally {
      await Effect.runPromise(server.stop());
    }
  });

  it("serves sanitized config endpoint", async () => {
    const port = 18_797;
    const server = new HttpStatusServer(baseConfig({ agentHttpPort: port }), mockState());
    await Effect.runPromise(server.start());
    try {
      const response = await fetch(`http://127.0.0.1:${port}/config`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { paperTrading: boolean };
      expect(body.paperTrading).toBe(true);
      expect(body).not.toHaveProperty("walletPrivateKey");
      expect(body).not.toHaveProperty("heliusApiKey");
      expect(body).not.toHaveProperty("agentPolicy");
      expect(body).not.toHaveProperty("agentProposalToken");
    } finally {
      await Effect.runPromise(server.stop());
    }
  });

  it("returns 404 for unknown paths", async () => {
    const port = 18_796;
    const server = new HttpStatusServer(baseConfig({ agentHttpPort: port }), mockState());
    await Effect.runPromise(server.start());
    try {
      const response = await fetch(`http://127.0.0.1:${port}/unknown`);
      expect(response.status).toBe(404);
    } finally {
      await Effect.runPromise(server.stop());
    }
  });

  it("serves agent policy endpoint", async () => {
    const port = 18_795;
    const policy = { ...baseSnapshot().agentPolicy, mode: "suggest" as const };
    const server = new HttpStatusServer(
      baseConfig({ agentHttpPort: port }),
      mockAgentState(baseSnapshot({ agentPolicy: policy })),
    );
    await Effect.runPromise(server.start());
    try {
      const response = await fetch(`http://127.0.0.1:${port}/agent-policy`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual(policy);
    } finally {
      await Effect.runPromise(server.stop());
    }
  });

  it("rejects propose with bad token", async () => {
    const port = 18_794;
    const enqueued: AgentProposal[] = [];
    const server = new HttpStatusServer(
      baseConfig({ agentHttpPort: port, agentProposalToken: "secret-token" }),
      mockAgentState(baseSnapshot(), enqueued),
    );
    await Effect.runPromise(server.start());
    try {
      const response = await fetch(`http://127.0.0.1:${port}/propose`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({ action: "HOLD", poolAddress: "PoolA", confidence: 0.8 }),
      });
      expect(response.status).toBe(401);
      expect(enqueued).toHaveLength(0);
    } finally {
      await Effect.runPromise(server.stop());
    }
  });

  it("accepts and enqueues valid proposals", async () => {
    const port = 18_793;
    const enqueued: AgentProposal[] = [];
    const server = new HttpStatusServer(
      baseConfig({ agentHttpPort: port, agentProposalToken: "secret-token" }),
      mockAgentState(baseSnapshot(), enqueued),
    );
    await Effect.runPromise(server.start());
    try {
      const proposals = [
        { action: "ENTER", poolAddress: "PoolA", confidence: 0.8, positionSizeUsd: 1000 },
        {
          action: "REBALANCE",
          poolAddress: "PoolB",
          confidence: 0.75,
          rebalanceParams: { lowerBinId: 10, upperBinId: 20 },
        },
      ];
      const response = await fetch(`http://127.0.0.1:${port}/propose`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-token",
        },
        body: JSON.stringify(proposals),
      });
      expect(response.status).toBe(202);
      const body = (await response.json()) as {
        accepted: number;
        proposalIds: ReadonlyArray<string>;
      };
      expect(body.accepted).toBe(2);
      expect(body.proposalIds).toHaveLength(2);
      expect(enqueued).toHaveLength(2);
      expect(enqueued[0]!.action).toBe("ENTER");
      expect(enqueued[0]!.poolAddress).toBe("PoolA");
      expect(enqueued[0]!.status).toBe("pending");
      expect(enqueued[1]!.action).toBe("REBALANCE");
      expect(enqueued[1]!.rebalanceParams).toEqual({
        newLowerBinId: 10,
        newUpperBinId: 20,
        slippageBps: 0,
      });
    } finally {
      await Effect.runPromise(server.stop());
    }
  });

  it("rejects batches that exceed the configured limit", async () => {
    const port = 18_792;
    const enqueued: AgentProposal[] = [];
    const server = new HttpStatusServer(
      baseConfig({
        agentHttpPort: port,
        agentProposalToken: "secret-token",
        agentProposalMaxBatchSize: 2,
      }),
      mockAgentState(baseSnapshot(), enqueued),
    );
    await Effect.runPromise(server.start());
    try {
      const proposals = [
        { action: "HOLD", poolAddress: "PoolA", confidence: 0.8 },
        { action: "HOLD", poolAddress: "PoolB", confidence: 0.8 },
        { action: "HOLD", poolAddress: "PoolC", confidence: 0.8 },
      ];
      const response = await fetch(`http://127.0.0.1:${port}/propose`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-token",
        },
        body: JSON.stringify(proposals),
      });
      expect(response.status).toBe(413);
      expect(enqueued).toHaveLength(0);
    } finally {
      await Effect.runPromise(server.stop());
    }
  });

  it("approves queued proposals via /approve", async () => {
    const port = 18_791;
    const approvedIds: string[] = [];
    const server = new HttpStatusServer(
      baseConfig({ agentHttpPort: port, agentProposalToken: "secret-token" }),
      {
        ...mockAgentState(
          baseSnapshot({
            pendingProposals: [
              {
                proposalId: "id-1",
                action: "HOLD",
                poolAddress: "PoolA",
                confidence: 0.8,
                reasoning: "test",
                proposedAt: Date.now(),
                expiresAt: Date.now() + 300_000,
                source: "http-queue",
                status: "pending",
              },
              {
                proposalId: "id-2",
                action: "HOLD",
                poolAddress: "PoolB",
                confidence: 0.8,
                reasoning: "test",
                proposedAt: Date.now(),
                expiresAt: Date.now() + 300_000,
                source: "http-queue",
                status: "pending",
              },
            ],
          }),
        ),
        approveProposal: (proposalId: string) =>
          Effect.sync(() => {
            approvedIds.push(proposalId);
          }),
      },
    );
    await Effect.runPromise(server.start());
    try {
      const response = await fetch(`http://127.0.0.1:${port}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-token",
        },
        body: JSON.stringify({ proposalIds: ["id-1", "id-2"] }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ approved: 2 });
      expect(approvedIds).toEqual(["id-1", "id-2"]);
    } finally {
      await Effect.runPromise(server.stop());
    }
  });

  it("rejects /approve with bad token", async () => {
    const port = 18_790;
    const approvedIds: string[] = [];
    const server = new HttpStatusServer(
      baseConfig({ agentHttpPort: port, agentProposalToken: "secret-token" }),
      {
        ...mockAgentState(baseSnapshot()),
        approveProposal: (proposalId: string) =>
          Effect.sync(() => {
            approvedIds.push(proposalId);
          }),
      },
    );
    await Effect.runPromise(server.start());
    try {
      const response = await fetch(`http://127.0.0.1:${port}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({ proposalIds: ["id-1"] }),
      });
      expect(response.status).toBe(401);
      expect(approvedIds).toHaveLength(0);
    } finally {
      await Effect.runPromise(server.stop());
    }
  });

  it("rejects /approve batches that exceed the configured limit", async () => {
    const port = 18_789;
    const server = new HttpStatusServer(
      baseConfig({
        agentHttpPort: port,
        agentProposalToken: "secret-token",
        agentProposalMaxBatchSize: 2,
      }),
      mockAgentState(baseSnapshot()),
    );
    await Effect.runPromise(server.start());
    try {
      const response = await fetch(`http://127.0.0.1:${port}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-token",
        },
        body: JSON.stringify({ proposalIds: ["id-1", "id-2", "id-3"] }),
      });
      expect(response.status).toBe(413);
    } finally {
      await Effect.runPromise(server.stop());
    }
  });

  it("requires a separate approval token for /approve when configured", async () => {
    const port = 18_788;
    const approvedIds: string[] = [];
    const server = new HttpStatusServer(
      baseConfig({
        agentHttpPort: port,
        agentProposalToken: "proposal-token",
        agentApprovalToken: "approval-token",
      }),
      {
        ...mockAgentState(
          baseSnapshot({
            pendingProposals: [
              {
                proposalId: "id-1",
                action: "HOLD",
                poolAddress: "PoolA",
                confidence: 0.8,
                reasoning: "test",
                proposedAt: Date.now(),
                expiresAt: Date.now() + 300_000,
                source: "http-queue",
                status: "pending",
              },
            ],
          }),
        ),
        approveProposal: (proposalId: string) =>
          Effect.sync(() => {
            approvedIds.push(proposalId);
          }),
      },
    );
    await Effect.runPromise(server.start());
    try {
      const proposalTokenResponse = await fetch(`http://127.0.0.1:${port}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer proposal-token",
        },
        body: JSON.stringify({ proposalIds: ["id-1"] }),
      });
      expect(proposalTokenResponse.status).toBe(401);
      expect(approvedIds).toHaveLength(0);

      const approvalTokenResponse = await fetch(`http://127.0.0.1:${port}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer approval-token",
        },
        body: JSON.stringify({ proposalIds: ["id-1"] }),
      });
      expect(approvalTokenResponse.status).toBe(200);
      expect(approvedIds).toEqual(["id-1"]);
    } finally {
      await Effect.runPromise(server.stop());
    }
  });
});
