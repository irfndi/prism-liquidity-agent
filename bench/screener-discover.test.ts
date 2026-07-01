import { describe, it, expect, vi, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import {
  ConfigService,
  type AppConfig,
} from "../engine/config-service.js";
import {
  AdapterService,
  AuditService,
  ScreenerService,
  StrategyService,
} from "../engine/services.js";
import { AdapterLive } from "../engine/adapter-service.js";
import { StrategyLive } from "../engine/strategy-service.js";
import { AuditLive } from "../engine/audit-service.js";
import { DbLive } from "../engine/db-service.js";
import { ScreenerLive } from "../engine/screener-service.js";
import { DiscoverPoolsError } from "../engine/errors.js";
import { mockFetch } from "./helpers.js";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    walletPrivateKey: "",
    heliusApiKey: "",
    solanaRpcUrl: "https://api.mainnet.helius-rpc.com",
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
    enablePoolDiscovery: true,
    discoveryMinTvlUsd: 100_000,
    discoveryMinFeeRatio: 1.5,
    deployerBlacklistPath: "",
    tokenBlacklistPath: "",
    sqliteDbPath: ":memory:",
    enableSnapshotCapture: false,
    autoUpdate: false,
    updateCheckIntervalMs: 216_000_000,
    updateChannel: "stable",
    updateGithubRepo: "irfndi/prism-liquidity-agent",
    updateAllowDirty: false,
    forceUpdateEnabled: false,
    forceUpdateAfterDays: 14,
    updateR2PublicUrl: "https://r2.prism-agent.com",
    githubToken: "",
    githubRepo: "irfndi/prism-liquidity-agent",
    feedbackOptOut: false,
    paperModeExitLive: false,
    meteoraPoolsUrl:
      "https://dlmm.datapi.meteora.ag/pools?page=1&page_size=1000&filter_by=is_blacklisted=false&sort_by=tvl:desc",
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

  };
}

function buildScreenerLayer(
  overrides: Partial<AppConfig> = {},
  adapterFailure: "discoverPoolsError" | "otherError" | null = null,
): Layer.Layer<ScreenerService, never, never> {
  const configLayer = Layer.succeed(ConfigService, makeConfig(overrides));
  const dbLayer = DbLive(":memory:");
  const auditLayer = Layer.provide(AuditLive, dbLayer);
  const strategyLayer = Layer.provide(
    StrategyLive,
    Layer.merge(configLayer, auditLayer),
  );
  const adapterLayer: Layer.Layer<AdapterService, never, never> = (() => {
    if (adapterFailure === "discoverPoolsError") {
      return Layer.succeed(AdapterService, {
        hasWallet: () => false,
        getWalletAddress: () => null,
        getWalletBalanceUsd: () => Effect.never,
        getNativeSolBalance: () => Effect.never,
        getPoolState: () => Effect.never,
        getBinArray: () => Effect.never,
        getPositions: () => Effect.never,
        getAllWalletPositions: () => Effect.never,
        simulateRebalance: () => Effect.never,
        enterPosition: () => Effect.never,
        exitPosition: () => Effect.never,
        rebalancePosition: () => Effect.never,
        claimFees: () => Effect.never,
        discoverPools: () =>
          Effect.fail(
            new DiscoverPoolsError({
              message: "Meteora API returned HTTP 404. Pool discovery disabled.",
              url: "https://dlmm.datapi.meteora.ag/pools",
              status: 404,
            }),
          ),
        reportFeeCollection: () => Effect.never,
        swapUSDCForSOL: () => Effect.never,
        reportRevenue: () => Effect.never,
      } as never);
    }
    if (adapterFailure === "otherError") {
      return Layer.succeed(AdapterService, {
        hasWallet: () => false,
        getWalletAddress: () => null,
        getWalletBalanceUsd: () => Effect.never,
        getNativeSolBalance: () => Effect.never,
        getPoolState: () => Effect.never,
        getBinArray: () => Effect.never,
        getPositions: () => Effect.never,
        getAllWalletPositions: () => Effect.never,
        simulateRebalance: () => Effect.never,
        enterPosition: () => Effect.never,
        exitPosition: () => Effect.never,
        rebalancePosition: () => Effect.never,
        claimFees: () => Effect.never,
        discoverPools: () => Effect.fail(new Error("totally unrelated: out of memory")),
        reportFeeCollection: () => Effect.never,
        swapUSDCForSOL: () => Effect.never,
        reportRevenue: () => Effect.never,
      } as never);
    }
    return Layer.provide(AdapterLive, configLayer);
  })();
  const allDeps = Layer.merge(configLayer, Layer.merge(adapterLayer, strategyLayer));
  return Layer.provide(
    ScreenerLive({
      minTvlUsd: 100_000,
      minFeeRatio: 1.5,
      volumeAuthThreshold: 0.7,
      minBinUtilization: 0.3,
    }),
    allDeps,
  ) as Layer.Layer<ScreenerService, never, never>;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("ScreenerService.screenPools", () => {
  it("catches DiscoverPoolsError and falls back to watchlist-only mode (returns [])", async () => {
    const layer = buildScreenerLayer({}, "discoverPoolsError");
    const program = Effect.gen(function* () {
      const screener = yield* ScreenerService;
      return yield* screener.screenPools();
    });
    const screened = await Effect.runPromise(Effect.provide(program, layer));
    expect(Array.isArray(screened)).toBe(true);
    expect(screened).toHaveLength(0);
  });

  it("rethrows errors that are NOT DiscoverPoolsError (does not silently swallow them)", async () => {
    const layer = buildScreenerLayer({}, "otherError");
    const program = Effect.gen(function* () {
      const screener = yield* ScreenerService;
      return yield* screener.screenPools();
    });
    await expect(
      Effect.runPromise(Effect.provide(program, layer)),
    ).rejects.toThrow(/out of memory/);
  });

  it("returns empty array on a JSON parse error (DiscoverPoolsError from JSON failure)", async () => {
    const restore = mockFetch(
      (async () =>
        new Response("not json at all", { status: 200 })) as unknown as typeof fetch,
    );
    try {
      const layer = buildScreenerLayer();
      const program = Effect.gen(function* () {
        const screener = yield* ScreenerService;
        return yield* screener.screenPools();
      });
      const screened = await Effect.runPromise(Effect.provide(program, layer));
      expect(screened).toHaveLength(0);
    } finally {
      restore();
    }
  });
});
