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
    farmRewardsEnabled: true,
    snapshotRetentionDays: 14,
    alertsEnabled: true,
    alertCooldownMinutes: 120,
    alertFeeMilestoneUsd: 10,
    ...overrides,
  };
}

function mockState(snapshot: Record<string, unknown> = {}) {
  return {
    getSnapshot: () => Effect.succeed(snapshot as never),
    updateSnapshot: () => Effect.void,
    setAgentPolicy: () => Effect.void,
    enqueueProposal: () => Effect.succeed({ status: "enqueued" as const }),
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
        return { status: "enqueued" as const };
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
      baseConfig({
        agentHttpPort: port,
        agentProposalToken: "secret-token",
        agentApprovalToken: "approval-token",
        agentiveMode: true,
        agentProposalMode: "supervised",
        watchlistPools: ["PoolA", "PoolB"],
      }),
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

  it("rejects /propose for pools outside the scanned set", async () => {
    const port = 18_795;
    const enqueued: AgentProposal[] = [];
    const server = new HttpStatusServer(
      baseConfig({
        agentHttpPort: port,
        agentProposalToken: "secret-token",
        agentApprovalToken: "approval-token",
        agentiveMode: true,
        agentProposalMode: "supervised",
        watchlistPools: ["PoolA"],
      }),
      mockAgentState(baseSnapshot(), enqueued),
    );
    await Effect.runPromise(server.start());
    try {
      const response = await fetch(`http://127.0.0.1:${port}/propose`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-token",
        },
        body: JSON.stringify({ action: "ENTER", poolAddress: "PoolB", confidence: 0.8 }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        accepted: number;
        error: string;
        unscannable: Array<{ poolAddress: string }>;
      };
      expect(body.error).toBe("unscannable_pool");
      expect(body.accepted).toBe(0);
      expect(body.unscannable).toEqual([expect.objectContaining({ poolAddress: "PoolB" })]);
      expect(enqueued).toHaveLength(0);
    } finally {
      await Effect.runPromise(server.stop());
    }
  });

  it("accepts /propose for held positions outside the watchlist", async () => {
    const port = 18_786;
    const enqueued: AgentProposal[] = [];
    const server = new HttpStatusServer(
      baseConfig({
        agentHttpPort: port,
        agentProposalToken: "secret-token",
        agentApprovalToken: "approval-token",
        agentiveMode: true,
        agentProposalMode: "supervised",
        watchlistPools: ["PoolA"],
      }),
      mockAgentState(
        baseSnapshot({
          positions: [
            {
              positionId: "held-pos-1",
              poolAddress: "HeldPool",
              tokenXSymbol: "X",
              tokenYSymbol: "Y",
              depositedUsd: 1000,
              currentValueUsd: 1000,
              activeBinId: 100,
              lowerBinId: 90,
              upperBinId: 110,
              lastAction: "ENTER",
              lastActionAt: Date.now(),
              hoursHeld: 1,
            },
          ],
        }),
        enqueued,
      ),
    );
    await Effect.runPromise(server.start());
    try {
      const response = await fetch(`http://127.0.0.1:${port}/propose`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-token",
        },
        body: JSON.stringify({ action: "REBALANCE", poolAddress: "HeldPool", confidence: 0.8 }),
      });
      expect(response.status).toBe(202);
      const body = (await response.json()) as { accepted: number; proposalIds: string[] };
      expect(body.accepted).toBe(1);
      expect(body.proposalIds).toHaveLength(1);
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]!.poolAddress).toBe("HeldPool");
    } finally {
      await Effect.runPromise(server.stop());
    }
  });

  it("reads positions from live snapshot updates for the /propose scannable set", async () => {
    const port = 18_776;
    const enqueued: AgentProposal[] = [];
    let snapshot = baseSnapshot({ positions: [] });
    const mutableState: AgentStateApi = {
      getSnapshot: () => Effect.succeed(snapshot),
      updateSnapshot: (patch) =>
        Effect.sync(() => {
          snapshot = { ...snapshot, ...patch };
        }),
      setAgentPolicy: () => Effect.void,
      enqueueProposal: (proposal) =>
        Effect.sync(() => {
          enqueued.push(proposal);
          return { status: "enqueued" as const };
        }),
      dequeueProposals: () => Effect.void,
      approveProposal: () => Effect.void,
      rejectProposal: () => Effect.void,
    };
    const server = new HttpStatusServer(
      baseConfig({
        agentHttpPort: port,
        agentProposalToken: "secret-token",
        agentApprovalToken: "approval-token",
        agentiveMode: true,
        agentProposalMode: "supervised",
        watchlistPools: ["PoolA"],
      }),
      mutableState,
    );
    await Effect.runPromise(server.start());
    try {
      // Before the startup seeding runs, a held-pool proposal is unscannable.
      const before = await fetch(`http://127.0.0.1:${port}/propose`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-token",
        },
        body: JSON.stringify({ action: "REBALANCE", poolAddress: "HeldPool", confidence: 0.8 }),
      });
      expect(before.status).toBe(400);

      // Simulate program.ts seeding the snapshot before exposing the interface.
      snapshot = {
        ...snapshot,
        positions: [
          {
            positionId: "held-pos-1",
            poolAddress: "HeldPool",
            tokenXSymbol: "X",
            tokenYSymbol: "Y",
            depositedUsd: 1000,
            currentValueUsd: 1000,
            activeBinId: 100,
            lowerBinId: 90,
            upperBinId: 110,
            lastAction: "ENTER",
            lastActionAt: Date.now(),
            hoursHeld: 1,
          },
        ],
      };

      const after = await fetch(`http://127.0.0.1:${port}/propose`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-token",
        },
        body: JSON.stringify({ action: "REBALANCE", poolAddress: "HeldPool", confidence: 0.8 }),
      });
      expect(after.status).toBe(202);
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]!.poolAddress).toBe("HeldPool");
    } finally {
      await Effect.runPromise(server.stop());
    }
  });

  it("reports unscannable pools alongside skipped pools when nothing is accepted", async () => {
    const port = 18_784;
    const server = new HttpStatusServer(
      baseConfig({
        agentHttpPort: port,
        agentProposalToken: "secret-token",
        agentApprovalToken: "approval-token",
        agentiveMode: true,
        agentProposalMode: "supervised",
        watchlistPools: ["PoolA"],
      }),
      {
        ...mockAgentState(baseSnapshot()),
        enqueueProposal: (proposal: AgentProposal) =>
          Effect.sync(() => {
            if (proposal.poolAddress === "PoolA") {
              return { status: "rejected" as const, reason: "approved_exists" as const };
            }
            return { status: "enqueued" as const };
          }),
      },
    );
    await Effect.runPromise(server.start());
    try {
      const response = await fetch(`http://127.0.0.1:${port}/propose`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-token",
        },
        body: JSON.stringify([
          { action: "HOLD", poolAddress: "PoolA", confidence: 0.8 },
          { action: "HOLD", poolAddress: "PoolB", confidence: 0.8 },
        ]),
      });
      expect(response.status).toBe(409);
      const body = (await response.json()) as {
        accepted: number;
        error: string;
        skipped: Array<{ poolAddress: string }>;
        unscannable: Array<{ poolAddress: string }>;
      };
      expect(body.accepted).toBe(0);
      expect(body.error).toBe("approved_exists");
      expect(body.skipped).toEqual([expect.objectContaining({ poolAddress: "PoolA" })]);
      expect(body.unscannable).toEqual([expect.objectContaining({ poolAddress: "PoolB" })]);
    } finally {
      await Effect.runPromise(server.stop());
    }
  });

  it("lists unscannable pools in a mixed /propose batch while accepting watchlisted pools", async () => {
    const port = 18_796;
    const enqueued: AgentProposal[] = [];
    const server = new HttpStatusServer(
      baseConfig({
        agentHttpPort: port,
        agentProposalToken: "secret-token",
        agentApprovalToken: "approval-token",
        agentiveMode: true,
        agentProposalMode: "supervised",
        watchlistPools: ["PoolA"],
      }),
      mockAgentState(baseSnapshot(), enqueued),
    );
    await Effect.runPromise(server.start());
    try {
      const response = await fetch(`http://127.0.0.1:${port}/propose`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-token",
        },
        body: JSON.stringify([
          { action: "ENTER", poolAddress: "PoolA", confidence: 0.8 },
          { action: "ENTER", poolAddress: "PoolB", confidence: 0.8 },
        ]),
      });
      expect(response.status).toBe(202);
      const body = (await response.json()) as {
        accepted: number;
        proposalIds: string[];
        unscannable: Array<{ poolAddress: string }>;
      };
      expect(body.accepted).toBe(1);
      expect(body.proposalIds).toHaveLength(1);
      expect(body.unscannable).toEqual([expect.objectContaining({ poolAddress: "PoolB" })]);
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]!.poolAddress).toBe("PoolA");
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
        agentApprovalToken: "approval-token",
        agentiveMode: true,
        agentProposalMode: "supervised",
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

  it("rejects /propose when proposals are not consumed in the current mode", async () => {
    const port = 18_783;
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
          Authorization: "Bearer secret-token",
        },
        body: JSON.stringify({ action: "HOLD", poolAddress: "PoolA", confidence: 0.8 }),
      });
      expect(response.status).toBe(409);
      expect(enqueued).toHaveLength(0);
    } finally {
      await Effect.runPromise(server.stop());
    }
  });

  it("rejects /propose when agentic mode is on but proposal mode is veto", async () => {
    const port = 18_782;
    const enqueued: AgentProposal[] = [];
    const server = new HttpStatusServer(
      baseConfig({
        agentHttpPort: port,
        agentProposalToken: "secret-token",
        agentiveMode: true,
        agentProposalMode: "veto",
      }),
      mockAgentState(baseSnapshot(), enqueued),
    );
    await Effect.runPromise(server.start());
    try {
      const response = await fetch(`http://127.0.0.1:${port}/propose`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-token",
        },
        body: JSON.stringify({ action: "HOLD", poolAddress: "PoolA", confidence: 0.8 }),
      });
      expect(response.status).toBe(409);
      expect(enqueued).toHaveLength(0);
    } finally {
      await Effect.runPromise(server.stop());
    }
  });

  it("rejects /propose in supervised mode when no approval token is configured", async () => {
    const port = 18_781;
    const enqueued: AgentProposal[] = [];
    const server = new HttpStatusServer(
      baseConfig({
        agentHttpPort: port,
        agentProposalToken: "secret-token",
        agentiveMode: true,
        agentProposalMode: "supervised",
        agentApprovalToken: "",
      }),
      mockAgentState(baseSnapshot(), enqueued),
    );
    await Effect.runPromise(server.start());
    try {
      const response = await fetch(`http://127.0.0.1:${port}/propose`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-token",
        },
        body: JSON.stringify({ action: "HOLD", poolAddress: "PoolA", confidence: 0.8 }),
      });
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("approval_token_required");
      expect(enqueued).toHaveLength(0);
    } finally {
      await Effect.runPromise(server.stop());
    }
  });

  it("approves queued proposals via /approve", async () => {
    const port = 18_791;
    const approvedIds: string[] = [];
    const server = new HttpStatusServer(
      baseConfig({
        agentHttpPort: port,
        agentProposalToken: "proposal-token",
        agentApprovalToken: "secret-token",
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
      baseConfig({
        agentHttpPort: port,
        agentProposalToken: "proposal-token",
        agentApprovalToken: "secret-token",
      }),
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

  it("rejects /approve when only the proposal token is configured", async () => {
    const port = 18_780;
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
          Authorization: "Bearer secret-token",
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
        agentApprovalToken: "secret-token",
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

  it("rejects /propose when the in-memory queue is full", async () => {
    const port = 18_779;
    const server = new HttpStatusServer(
      baseConfig({
        agentHttpPort: port,
        agentiveMode: true,
        agentProposalToken: "secret-token",
        agentProposalMode: "full",
        agentProposalMaxQueueSize: 1,
        watchlistPools: ["PoolA"],
      }),
      {
        ...mockAgentState(baseSnapshot()),
        enqueueProposal: () => Effect.succeed({ status: "rejected", reason: "queue_full" }),
      },
    );
    await Effect.runPromise(server.start());
    try {
      const response = await fetch(`http://127.0.0.1:${port}/propose`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-token",
        },
        body: JSON.stringify({
          action: "HOLD",
          poolAddress: "PoolA",
          confidence: 0.8,
        }),
      });
      expect(response.status).toBe(503);
      const body = (await response.json()) as {
        accepted: number;
        proposalIds: string[];
        error: string;
      };
      expect(body.error).toBe("queue_full");
      expect(body.accepted).toBe(0);
      expect(body.proposalIds).toEqual([]);
    } finally {
      await Effect.runPromise(server.stop());
    }
  });

  it("dedupes same-pool items in a batch last-wins and only returns live IDs", async () => {
    const port = 18_785;
    const enqueued: AgentProposal[] = [];
    const server = new HttpStatusServer(
      baseConfig({
        agentHttpPort: port,
        agentiveMode: true,
        agentProposalToken: "secret-token",
        agentProposalMode: "full",
        watchlistPools: ["PoolA"],
      }),
      mockAgentState(baseSnapshot(), enqueued),
    );
    await Effect.runPromise(server.start());
    try {
      const response = await fetch(`http://127.0.0.1:${port}/propose`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-token",
        },
        body: JSON.stringify([
          { action: "HOLD", poolAddress: "PoolA", confidence: 0.7 },
          { action: "EXIT", poolAddress: "PoolA", confidence: 0.9 },
        ]),
      });
      expect(response.status).toBe(202);
      const body = (await response.json()) as {
        accepted: number;
        proposalIds: string[];
      };
      expect(body.accepted).toBe(1);
      expect(body.proposalIds).toHaveLength(1);
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]!.action).toBe("EXIT");
      expect(enqueued[0]!.proposalId).toBe(body.proposalIds[0]);
    } finally {
      await Effect.runPromise(server.stop());
    }
  });

  it("rejects /propose with JSON 409 when an approved proposal exists for the pool", async () => {
    const port = 18_778;
    const server = new HttpStatusServer(
      baseConfig({
        agentHttpPort: port,
        agentiveMode: true,
        agentProposalToken: "secret-token",
        agentProposalMode: "supervised",
        agentApprovalToken: "approval-token",
        watchlistPools: ["PoolA"],
      }),
      {
        ...mockAgentState(baseSnapshot()),
        enqueueProposal: () => Effect.succeed({ status: "rejected", reason: "approved_exists" }),
      },
    );
    await Effect.runPromise(server.start());
    try {
      const response = await fetch(`http://127.0.0.1:${port}/propose`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-token",
        },
        body: JSON.stringify({
          action: "HOLD",
          poolAddress: "PoolA",
          confidence: 0.8,
        }),
      });
      expect(response.status).toBe(409);
      const body = (await response.json()) as {
        error: string;
        accepted: number;
        poolAddresses: string[];
        message: string;
      };
      expect(body.error).toBe("approved_exists");
      expect(body.accepted).toBe(0);
      expect(body.poolAddresses).toEqual(["PoolA"]);
      expect(body.message).toMatch(/execute or expire/);
    } finally {
      await Effect.runPromise(server.stop());
    }
  });

  it("skips approved_exists pools and still accepts healthy pools in the same batch", async () => {
    const port = 18_777;
    const enqueued: AgentProposal[] = [];
    const server = new HttpStatusServer(
      baseConfig({
        agentHttpPort: port,
        agentiveMode: true,
        agentProposalToken: "secret-token",
        agentProposalMode: "supervised",
        agentApprovalToken: "approval-token",
        watchlistPools: ["PoolA", "PoolB"],
      }),
      {
        ...mockAgentState(baseSnapshot(), enqueued),
        enqueueProposal: (proposal: AgentProposal) =>
          Effect.sync(() => {
            if (proposal.poolAddress === "PoolA") {
              return { status: "rejected" as const, reason: "approved_exists" as const };
            }
            enqueued.push(proposal);
            return { status: "enqueued" as const };
          }),
      },
    );
    await Effect.runPromise(server.start());
    try {
      const response = await fetch(`http://127.0.0.1:${port}/propose`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-token",
        },
        body: JSON.stringify([
          { action: "HOLD", poolAddress: "PoolA", confidence: 0.8 },
          { action: "HOLD", poolAddress: "PoolB", confidence: 0.8 },
        ]),
      });
      expect(response.status).toBe(202);
      const body = (await response.json()) as {
        accepted: number;
        proposalIds: string[];
        skipped: Array<{ poolAddress: string; reason: string }>;
      };
      expect(body.accepted).toBe(1);
      expect(body.proposalIds).toHaveLength(1);
      expect(body.skipped).toEqual([
        expect.objectContaining({ poolAddress: "PoolA", reason: "approved_exists" }),
      ]);
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]!.poolAddress).toBe("PoolB");
    } finally {
      await Effect.runPromise(server.stop());
    }
  });
});
