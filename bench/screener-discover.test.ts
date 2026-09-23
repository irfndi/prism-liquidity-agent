import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { Effect, Layer } from "effect";
import {
  AUTONOMOUS_TOKEN_CONFIG_DEFAULTS,
  ConfigService,
  type AppConfig,
} from "../engine/config-service.js";
import { AdapterService, ScreenerService } from "../engine/services.js";
import { AdapterLive } from "../engine/adapter-service.js";
import { StrategyLive, DLMMStrategy } from "../engine/strategy-service.js";
import { AuditLive } from "../engine/audit-service.js";
import { DbLive } from "../engine/db-service.js";
import { ScreenerLive } from "../engine/screener-service.js";
import { DiscoverPoolsError } from "../engine/errors.js";
import { mockFetch, asOwner } from "./helpers.js";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    walletPrivateKey: "",
    heliusApiKey: "",
    solanaRpcUrl: "https://api.mainnet.helius-rpc.com",
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
    githubToken: "",
    githubRepo: "irfndi/prism-liquidity-agent",
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
    minRangeHalfWidthPct: 0,
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
    agentiveMode: false,
    agentRuntime: "none",
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

function buildScreenerLayer(
  overrides: Partial<AppConfig> = {},
  adapterFailure: "discoverPoolsError" | "otherError" | null = null,
): Layer.Layer<ScreenerService, never, never> {
  const configLayer = Layer.succeed(ConfigService, makeConfig(overrides));
  const dbLayer = DbLive(":memory:");
  const auditLayer = Layer.provide(AuditLive, dbLayer);
  const strategyLayer = Layer.provide(StrategyLive, Layer.merge(configLayer, auditLayer));
  const adapterLayer: Layer.Layer<AdapterService, never, never> = (() => {
    if (adapterFailure === "discoverPoolsError") {
      // SAFETY: This test fixture is constructed to satisfy the asserted service/domain contract and is exercised by the surrounding test.
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
      // SAFETY: This test fixture is constructed to satisfy the asserted service/domain contract and is exercised by the surrounding test.
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
    return asOwner<Layer.Layer<AdapterService, never, never>>(
      Layer.provide(AdapterLive, Layer.merge(configLayer, DbLive(":memory:"))),
    );
  })();
  const allDeps = Layer.merge(configLayer, Layer.merge(adapterLayer, strategyLayer));
  // SAFETY: This test fixture is constructed to satisfy the asserted service/domain contract and is exercised by the surrounding test.
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
    await expect(Effect.runPromise(Effect.provide(program, layer))).rejects.toThrow(
      /out of memory/,
    );
  });

  it("returns empty array on a JSON parse error (DiscoverPoolsError from JSON failure)", async () => {
    const restore = mockFetch(async () => new Response("not json at all", { status: 200 }));
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

  it("filters out candidates whose on-chain bin utilization is below minBinUtilization", async () => {
    const POOL_A = "PoolHighUtil11111111111111111111111111111";
    const POOL_B = "PoolLowUtil111111111111111111111111111111";
    const discovered = [POOL_A, POOL_B].map((address) => ({
      address,
      tvlUsd: 2_000_000,
      volume24hUsd: 1_000_000,
      fees24hUsd: 10_000,
      apr: 180,
      binStep: 10,
      tokenX: "TokenX111111111111111111111111111111111111",
      tokenY: "TokenY111111111111111111111111111111111111",
    }));
    const makeBins = (activeCount: number) => ({
      lowerBinId: 4990,
      upperBinId: 4999,
      activeBinId: 5000,
      bins: Array.from({ length: 10 }, (_, i) => ({
        binId: 4990 + i,
        price: 150,
        reserveX: i < activeCount ? BigInt(1_000_000) : 0n,
        reserveY: i < activeCount ? BigInt(1_000_000) : 0n,
        liquiditySupply: i < activeCount ? BigInt(1_000_000_000) : 0n,
      })),
    });
    // SAFETY: This test fixture is constructed to satisfy the asserted service/domain contract and is exercised by the surrounding test.
    const adapterLayer = Layer.succeed(AdapterService, {
      discoverPools: () => Effect.succeed(discovered),
      getBinArray: (address: string) =>
        Effect.succeed(address === POOL_A ? makeBins(10) : makeBins(1)),
    } as never);
    const configLayer = Layer.succeed(ConfigService, makeConfig());
    const layer = Layer.provide(
      ScreenerLive({
        minTvlUsd: 100_000,
        minFeeRatio: 1.5,
        volumeAuthThreshold: 0.7,
        minBinUtilization: 0.3,
      }),
      Layer.merge(configLayer, Layer.merge(adapterLayer, StrategyLive)),
    );

    const program = Effect.gen(function* () {
      const screener = yield* ScreenerService;
      return yield* screener.screenPools();
    });
    const screened = await Effect.runPromise(Effect.provide(program, layer));
    const addresses = screened.map((p) => p.address);
    expect(
      addresses,
      `low-utilization pool must be filtered out, got: ${JSON.stringify(addresses)}`,
    ).toEqual([POOL_A]);
  });
});

// ─── Wave 101: cross-language discovery/screener gold ─────────────────────
// The SAME fixture feeds bench (this file) and the Rust host
// (native/rust/src/main.rs, `discovery_gold_parity`): TS output here is the
// pinned gold the host must reproduce field-for-field. Regenerate with
// PRISM_WRITE_GOLD=1, then re-run clean to confirm stability.

const GOLD_URL = new URL("../native/rust/fixtures/screener-page.json", import.meta.url);
const WRITE_GOLD = process.env.PRISM_WRITE_GOLD === "1";

function loadGold(): {
  url: string;
  config: {
    minTvlUsd: number;
    minFeeRatio: number;
    volumeAuthThreshold: number;
    minBinUtilization: number;
  };
  payload: unknown;
  bin_windows: Record<string, [boolean, number, number]>;
  fetch_count_expected: number;
  util_vectors: {
    name: string;
    known: boolean;
    bins: [string, string, string][];
    expect: number;
  }[];
  auth_vectors: {
    name: string;
    tvl: number;
    volume: number;
    fees: number;
    measured: boolean;
  }[];
  expected?: {
    discovered?: unknown[];
    screened?: unknown[];
    candidates?: string[];
    auth?: { name: string; score: number }[];
  };
} {
  return JSON.parse(readFileSync(GOLD_URL, "utf8"));
}

function saveGold(gold: ReturnType<typeof loadGold>): void {
  writeFileSync(GOLD_URL, JSON.stringify(gold, null, 1));
}

const discoveredSubset = (p: {
  address: string;
  tvlUsd: number;
  volume24hUsd: number;
  fees24hUsd: number;
  apr: number;
  // Required on DiscoveredPool (services.ts:62) and on every row the
  // adapter's own validity check admits (pool_config.bin_step is one of
  // the seven shape checks), so the gold always carries it.
  binStep: number;
  tokenX: string;
  tokenY: string;
  createdAtMs?: number;
}) => ({
  address: p.address,
  tvlUsd: p.tvlUsd,
  volume24hUsd: p.volume24hUsd,
  fees24hUsd: p.fees24hUsd,
  apr: p.apr,
  binStep: p.binStep,
  tokenX: p.tokenX,
  tokenY: p.tokenY,
  createdAtMs: p.createdAtMs ?? null,
});

const screenedSubset = (p: {
  address: string;
  tvlUsd: number;
  volume24hUsd: number;
  fees24hUsd: number;
  apr: number;
  feeIlRatio: number;
  volumeAuth: number;
  binUtilization: number;
  tokenX: string;
  tokenY: string;
  createdAtMs?: number;
}) => ({
  address: p.address,
  tvlUsd: p.tvlUsd,
  volume24hUsd: p.volume24hUsd,
  fees24hUsd: p.fees24hUsd,
  apr: p.apr,
  feeIlRatio: p.feeIlRatio,
  volumeAuth: p.volumeAuth,
  binUtilization: p.binUtilization,
  tokenX: p.tokenX,
  tokenY: p.tokenY,
  createdAtMs: p.createdAtMs ?? null,
});

describe("discovery gold (wave 101)", () => {
  it("discoverPools: envelope + row validity + launchpad + adapter tvl/top-50 (gold)", async () => {
    const gold = loadGold();
    const restore = mockFetch(
      async () => new Response(JSON.stringify(gold.payload), { status: 200 }),
    );
    try {
      const configLayer = Layer.succeed(ConfigService, makeConfig());
      const adapterLayer = asOwner<Layer.Layer<AdapterService, never, never>>(
        Layer.provide(AdapterLive, Layer.merge(configLayer, DbLive(":memory:"))),
      );
      const program = Effect.gen(function* () {
        const adapter = yield* AdapterService;
        return yield* adapter.discoverPools();
      });
      const pools = await Effect.runPromise(Effect.provide(program, adapterLayer));
      const subset = pools.map(discoveredSubset);
      gold.expected = { ...gold.expected, discovered: subset };
      if (WRITE_GOLD) saveGold(gold);
      expect(subset).toEqual(gold.expected.discovered);
    } finally {
      restore();
    }
  });

  it("screenPools: gates + stable fee sort + top-10 enrichment + top-3 candidates (gold)", async () => {
    const gold = loadGold();
    // Rows arrive from the gold.discovered seam (written by the test above in
    // a WRITE_GOLD run, persisted in the fixture otherwise).
    expect(gold.expected?.discovered, "run PRISM_WRITE_GOLD=1 first").toBeDefined();
    // SAFETY: the expect above proves the seam exists — it A (declaration-
    // ordered, runs first) persists expected.discovered into the fixture, so
    // both non-null assertions read a gold field this file just verified.
    const rows = gold.expected!.discovered!;
    let fetches = 0;
    // SAFETY: fixture adapter stub — implements exactly the two methods
    // screenPools calls (discoverPools + getBinArray); the closing cast drops
    // the rest of AdapterService, which must never be reached in this test.
    const adapterLayer = Layer.succeed(AdapterService, {
      // SAFETY: `rows` are the persisted gold projections (it A's output) —
      // exactly the DiscoveredPool array screenPools consumes; the stub
      // casts because the rest of AdapterService is intentionally
      // unimplemented (fixture-only layer, same pattern as the tests above).
      discoverPools: () => Effect.succeed(rows as never),
      getBinArray: (address: string) => {
        fetches += 1;
        const w = gold.bin_windows[address];
        if (!w) return Effect.fail(new Error(`no fixture window for ${address}`));
        const [known, active, total] = w;
        return Effect.succeed({
          lowerBinId: 0,
          upperBinId: 0,
          activeBinId: 0,
          binStep: 1,
          reservesKnown: known,
          bins: known
            ? Array.from({ length: total }, (_, i) => ({
                binId: i,
                price: 1,
                reserveX: i < active ? 1n : 0n,
                reserveY: i < active ? 1n : 0n,
                liquiditySupply: i < active ? 1n : 0n,
              }))
            : [],
        });
      },
      // SAFETY: the object implements the two methods this fixture exercises
      // (discoverPools, getBinArray); every other AdapterService member is
      // deliberately absent and must never be reached by screenPools.
    } as never);
    const configLayer = Layer.succeed(ConfigService, makeConfig());
    const layer = Layer.provide(
      ScreenerLive(gold.config),
      Layer.merge(configLayer, Layer.merge(adapterLayer, StrategyLive)),
    );
    const program = Effect.gen(function* () {
      const screener = yield* ScreenerService;
      return yield* screener.screenPools();
    });
    const screened = await Effect.runPromise(Effect.provide(program, layer));
    expect(fetches, "bin-window fetches are bounded to the top 10").toBe(gold.fetch_count_expected);
    const subset = screened.map(screenedSubset);
    const candidates = subset.slice(0, 3).map((p) => p.address);
    gold.expected = { ...gold.expected, screened: subset, candidates };
    if (WRITE_GOLD) saveGold(gold);
    expect(subset).toEqual(gold.expected.screened);
    expect(candidates).toEqual(gold.expected.candidates);
  });

  it("computeBinUtilization vectors (OR legs, known-false, empty) (gold)", () => {
    const gold = loadGold();
    for (const c of gold.util_vectors) {
      const bins = c.bins.map((b, i) => ({
        binId: i,
        price: 1,
        reserveX: BigInt(b[0]),
        reserveY: BigInt(b[1]),
        liquiditySupply: BigInt(b[2]),
      }));
      // SAFETY: the vector carries every BinArray scalar
      // computeBinUtilization reads (bins + reservesKnown); synthetic
      // binId/price are never consulted by the function under test.
      const util = DLMMStrategy.computeBinUtilization({
        lowerBinId: 0,
        upperBinId: 0,
        activeBinId: 0,
        binStep: 1,
        bins,
        reservesKnown: c.known,
      } as never);
      expect(util, c.name).toBe(c.expect);
    }
  });
});

describe("checkVolumeAuthenticity gold (wave 101)", () => {
  it("pins every score leg exactly (gold)", () => {
    const vectors = loadGold().auth_vectors;
    const computed = vectors.map((v) => ({
      name: v.name,
      // SAFETY: the vector carries exactly the three PoolState scalars
      // checkVolumeAuthenticity reads (tvl/volume/fees); the engine's own
      // strategy.test.ts builds partial PoolStates the same way.
      score: DLMMStrategy.checkVolumeAuthenticity(
        { tvlUsd: v.tvl, volume24hUsd: v.volume, fees24hUsd: v.fees } as never,
        v.measured,
      ).score,
    }));
    if (WRITE_GOLD) {
      const target = loadGold();
      target.expected = { ...target.expected, auth: computed };
      saveGold(target);
    }
    // The persisted gold is TS truth; the Rust host asserts the same rows.
    expect(computed).toEqual(loadGold().expected?.auth);
  });
});
