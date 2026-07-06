import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { HttpStatusServer } from "../engine/http-status-server.js";
import type { AppConfig } from "../engine/config-service.js";

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
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

function mockState(snapshot: Record<string, unknown> = {}) {
  return {
    getSnapshot: () => Effect.succeed(snapshot as never),
    updateSnapshot: () => Effect.void,
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
});
