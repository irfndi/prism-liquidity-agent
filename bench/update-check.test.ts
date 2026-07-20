import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import { rmSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ConfigService } from "../engine/config-service.js";
import { DbLive } from "../engine/db-service.js";
import { DbService } from "../engine/services.js";
import { checkForAutoUpdate } from "../engine/update-check.js";

function runAsync<T>(effect: Effect.Effect<T, unknown, never>): Promise<T> {
  return Effect.runPromise(effect);
}

function buildLayer(
  overrides: Partial<{
    forceUpdateEnabled: boolean;
    forceUpdateAfterDays: number;
    updateCheckIntervalMs: number;
  }> = {},
) {
  const mockConfig = Layer.succeed(ConfigService, {
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
    updateCheckIntervalMs: overrides.updateCheckIntervalMs ?? 0,
    updateChannel: "stable" as const,
    updateGithubRepo: "irfndi/prism-liquidity-agent",
    updateAllowDirty: false,
    updateR2PublicUrl: "",
    forceUpdateEnabled: overrides.forceUpdateEnabled ?? false,
    forceUpdateAfterDays: overrides.forceUpdateAfterDays ?? 14,
    githubToken: "",
    githubRepo: "",
    feedbackOptOut: false,
    paperModeExitLive: false,
    meteoraPoolsUrl:
      "https://dlmm.datapi.meteora.ag/pools?page=1&page_size=1000&filter_by=is_blacklisted=false&sort_by=tvl:desc",
    meteoraDatapiBaseUrl: "https://dlmm.datapi.meteora.ag",
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
  });
  return Layer.merge(mockConfig, DbLive(":memory:"));
}

describe("checkForAutoUpdate", () => {
  const originalFetch = globalThis.fetch;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "prism-update-check-"));
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (tempHome) {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("respects check interval (skips if recent)", async () => {
    const layer = buildLayer({ updateCheckIntervalMs: 86_400_000 });
    const now = Date.now();

    await runAsync(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.setMetadata("lastUpdateCheckAt", String(now));
        yield* db.setMetadata("versionInstalledAt", String(now - 15 * 86_400_000));

        yield* checkForAutoUpdate(yield* ConfigService, db);

        const lastCheck = yield* db.getMetadata("lastUpdateCheckAt");
        expect(Number(lastCheck)).toBe(now);
      }).pipe(Effect.provide(layer)),
    );
  });

  it("does nothing when no newer version available", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        version: "0.0.0",
        channel: "stable",
        tarball_url: "",
        sha256_url: "",
        published_at: new Date().toISOString(),
        min_cli_version: "1.0.0",
      }),
    }) as unknown as typeof fetch;

    const layer = buildLayer({ updateCheckIntervalMs: 0 });

    await runAsync(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.setMetadata("versionInstalledAt", String(Date.now()));

        yield* checkForAutoUpdate(yield* ConfigService, db);

        expect(exitSpy).not.toHaveBeenCalled();
      }).pipe(Effect.provide(layer)),
    );
  });

  it("forces shutdown when threshold exceeded and force enabled", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        version: "999.0.0",
        channel: "stable",
        tarball_url: "https://example.com/tarball.tar.gz",
        sha256_url: "https://example.com/tarball.tar.gz.sha256",
        published_at: new Date().toISOString(),
        min_cli_version: "1.0.0",
      }),
    }) as unknown as typeof fetch;

    const layer = buildLayer({
      forceUpdateEnabled: true,
      forceUpdateAfterDays: 7,
      updateCheckIntervalMs: 0,
    });

    await runAsync(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = Date.now();
        yield* db.setMetadata("versionInstalledAt", String(now - 10 * 86_400_000));

        yield* checkForAutoUpdate(yield* ConfigService, db);

        expect(exitSpy).toHaveBeenCalledWith(1);
      }).pipe(Effect.provide(layer)),
    );
  });

  it("does not force shutdown when disabled", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        version: "999.0.0",
        channel: "stable",
        tarball_url: "https://example.com/tarball.tar.gz",
        sha256_url: "https://example.com/tarball.tar.gz.sha256",
        published_at: new Date().toISOString(),
        min_cli_version: "1.0.0",
      }),
    }) as unknown as typeof fetch;

    const layer = buildLayer({
      forceUpdateEnabled: false,
      forceUpdateAfterDays: 7,
      updateCheckIntervalMs: 0,
    });

    await runAsync(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = Date.now();
        yield* db.setMetadata("versionInstalledAt", String(now - 10 * 86_400_000));

        yield* checkForAutoUpdate(yield* ConfigService, db);

        expect(exitSpy).not.toHaveBeenCalled();
      }).pipe(Effect.provide(layer)),
    );
  });

  it("survives network errors gracefully", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("network timeout")) as unknown as typeof fetch;

    const layer = buildLayer({ updateCheckIntervalMs: 0 });

    await runAsync(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.setMetadata("versionInstalledAt", String(Date.now()));

        yield* checkForAutoUpdate(yield* ConfigService, db);

        expect(exitSpy).not.toHaveBeenCalled();
      }).pipe(Effect.provide(layer)),
    );
  });

  it("warns when 1 day until forced shutdown", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        version: "999.0.0",
        channel: "stable",
        tarball_url: "https://example.com/tarball.tar.gz",
        sha256_url: "https://example.com/tarball.tar.gz.sha256",
        published_at: new Date().toISOString(),
        min_cli_version: "1.0.0",
      }),
    }) as unknown as typeof fetch;

    const layer = buildLayer({
      forceUpdateEnabled: true,
      forceUpdateAfterDays: 8,
      updateCheckIntervalMs: 0,
    });

    await runAsync(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = Date.now();
        // Install 7 days ago → 8 - 7 = 1 day remaining
        yield* db.setMetadata("versionInstalledAt", String(now - 7 * 86_400_000));

        yield* checkForAutoUpdate(yield* ConfigService, db);

        expect(exitSpy).not.toHaveBeenCalled();
      }).pipe(Effect.provide(layer)),
    );
  });

  it("warns when 2 days until forced shutdown", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        version: "999.0.0",
        channel: "stable",
        tarball_url: "https://example.com/tarball.tar.gz",
        sha256_url: "https://example.com/tarball.tar.gz.sha256",
        published_at: new Date().toISOString(),
        min_cli_version: "1.0.0",
      }),
    }) as unknown as typeof fetch;

    const layer = buildLayer({
      forceUpdateEnabled: true,
      forceUpdateAfterDays: 9,
      updateCheckIntervalMs: 0,
    });

    await runAsync(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = Date.now();
        // Install 7 days ago → 9 - 7 = 2 days remaining
        yield* db.setMetadata("versionInstalledAt", String(now - 7 * 86_400_000));

        yield* checkForAutoUpdate(yield* ConfigService, db);

        expect(exitSpy).not.toHaveBeenCalled();
      }).pipe(Effect.provide(layer)),
    );
  });
});
