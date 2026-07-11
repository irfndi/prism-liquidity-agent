import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { McpServer } from "../engine/mcp-server.js";
import { AgentStateService } from "../engine/services.js";
import { AgentStateMutable } from "../engine/state-service.js";
import type { AppConfig } from "../engine/config-service.js";

function baseConfig(): AppConfig {
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
  };
}

function mockState() {
  return {
    layer: AgentStateMutable().layer,
  };
}

function sendRequest(
  server: McpServer,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* server.start();
      try {
        return yield* Effect.tryPromise<Record<string, unknown>>(
          () =>
            new Promise((resolve, reject) => {
              const originalWrite = process.stdout.write;
              let buffer = "";
              process.stdout.write = ((chunk: string | Uint8Array, ..._args: unknown[]) => {
                buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";
                for (const line of lines) {
                  if (line.trim()) {
                    try {
                      process.stdout.write = originalWrite;
                      resolve(JSON.parse(line));
                      return;
                    } catch {
                      reject(new Error(`Invalid JSON: ${line}`));
                      return;
                    }
                  }
                }
                return true;
              }) as typeof process.stdout.write;

              process.stdin.emit("data", JSON.stringify(request) + "\n");
            }),
        );
      } finally {
        yield* server.stop();
      }
    }),
  );
}

describe("McpServer", () => {
  it("responds to initialize", async () => {
    const { layer } = mockState();
    const server = new McpServer(baseConfig(), {
      getSnapshot: () => Effect.succeed({} as never),
      updateSnapshot: () => Effect.void,
    });

    const response = await Effect.runPromise(
      Effect.provide(
        Effect.tryPromise(() =>
          sendRequest(server, { jsonrpc: "2.0", id: 1, method: "initialize" }),
        ),
        layer,
      ),
    );

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    expect(response.result).toHaveProperty("protocolVersion");
  });

  it("lists tools", async () => {
    const server = new McpServer(baseConfig(), {
      getSnapshot: () => Effect.succeed({} as never),
      updateSnapshot: () => Effect.void,
    });

    const response = await sendRequest(server, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(response.result).toHaveProperty("tools");
    const tools = (response.result as { tools: ReadonlyArray<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "prism_status",
        "prism_positions",
        "prism_decisions",
        "prism_config",
      ]),
    );
  });

  it("returns status via prism_status tool", async () => {
    const server = new McpServer(baseConfig(), {
      getSnapshot: () =>
        Effect.succeed({
          programStartTime: Date.now() - 1000,
          scanCount: 5,
          lastCycleAt: Date.now(),
          portfolio: {
            totalValueUsd: 11_000,
            unrealizedPnlUsd: 1000,
            realizedPnlUsd: 0,
            openPositions: 2,
            maxPositions: 3,
            walletBalanceUsd: 10_000,
          },
          positions: [],
          recentDecisions: [],
        } as never),
      updateSnapshot: () => Effect.void,
    });

    const response = await sendRequest(server, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "prism_status", arguments: {} },
    });

    expect(response.error).toBeUndefined();
    const content = (response.result as { content: ReadonlyArray<{ text: string }> }).content;
    expect(content).toHaveLength(1);
    const status = JSON.parse(content[0]!.text);
    expect(status.scanCount).toBe(5);
    expect(status.portfolio.totalValueUsd).toBe(11_000);
  });

  it("returns positions via prism_positions tool", async () => {
    const server = new McpServer(baseConfig(), {
      getSnapshot: () =>
        Effect.succeed({
          programStartTime: Date.now(),
          scanCount: 0,
          lastCycleAt: null,
          portfolio: {} as never,
          positions: [
            {
              poolAddress: "Pool111111111111111111111111111111111111111",
              tokenXSymbol: "TKNA",
              tokenYSymbol: "TKNB",
              depositedUsd: 1000,
              currentValueUsd: 1100,
              activeBinId: 100,
              lowerBinId: 90,
              upperBinId: 110,
              lastAction: "ENTER",
              lastActionAt: Date.now(),
              hoursHeld: 1,
            },
          ],
          recentDecisions: [],
        } as never),
      updateSnapshot: () => Effect.void,
    });

    const response = await sendRequest(server, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "prism_positions", arguments: {} },
    });

    const content = (response.result as { content: ReadonlyArray<{ text: string }> }).content;
    expect(content).toHaveLength(1);
    const result = JSON.parse(content[0]!.text);
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].tokenXSymbol).toBe("TKNA");
  });

  it("returns sanitized config via prism_config tool", async () => {
    const server = new McpServer(baseConfig(), {
      getSnapshot: () => Effect.succeed({} as never),
      updateSnapshot: () => Effect.void,
    });

    const response = await sendRequest(server, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "prism_config", arguments: {} },
    });

    const content = (response.result as { content: ReadonlyArray<{ text: string }> }).content;
    expect(content).toHaveLength(1);
    const cfg = JSON.parse(content[0]!.text);
    expect(cfg.paperTrading).toBe(true);
    expect(cfg).not.toHaveProperty("walletPrivateKey");
    expect(cfg).not.toHaveProperty("heliusApiKey");
  });
});
