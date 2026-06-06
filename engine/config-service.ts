import { Config, Context, Effect, Layer, Option, pipe } from "effect";
import { ConfigError } from "./errors.js";

export interface AppConfig {
  readonly walletPrivateKey: string;
  readonly heliusApiKey: string;
  readonly solanaRpcUrl: string;
  readonly paperTrading: boolean;
  readonly scanIntervalMs: number;
  readonly minPoolTvlUsd: number;
  readonly minFeeIlRatio: number;
  readonly tvlDropExitPct: number;
  readonly volumeAuthThreshold: number;
  readonly maxConcurrentPositions: number;
  readonly minRebalanceIntervalMs: number;
  readonly minRebalanceNetBenefitUsd: number;
  readonly confidenceThreshold: number;
  readonly paperPortfolioUsd: number;
  readonly minBinUtilization: number;
  readonly maxRebalanceRangeBins: number;
  readonly watchlistPools: ReadonlyArray<string>;
  // New features
  readonly stopLossPct: number;
  readonly trailingStopPct: number;
  readonly oorGracePeriodCycles: number;
  readonly feeClaimIntervalMs: number;
  readonly enablePoolDiscovery: boolean;
  readonly discoveryMinTvlUsd: number;
  readonly discoveryMinFeeRatio: number;
  readonly deployerBlacklistPath: string;
  readonly tokenBlacklistPath: string;
  readonly sqliteDbPath: string;
  readonly enableSnapshotCapture: boolean;
  // Auto-update settings
  readonly autoUpdate: boolean;
  readonly updateCheckIntervalMs: number;
  readonly updateChannel: "stable" | "beta" | "dev";
  readonly updateGithubRepo: string;
  readonly updateAllowDirty: boolean;
  // R2 release tarball source (GitHub-independent updates)
  readonly updateR2PublicUrl: string;
  readonly githubToken: string;
  readonly githubRepo: string;
  readonly feedbackOptOut: boolean;
  // Allow paper mode to exit live positions (opt-in escape hatch)
  readonly paperModeExitLive: boolean;
}

export class ConfigService extends Context.Tag("ConfigService")<ConfigService, AppConfig>() {}

function validatedNumber(name: string, min: number, fallback: number) {
  return Config.number(name).pipe(
    Effect.map((n) => (Number.isFinite(n) && n >= min ? n : fallback)),
    Effect.orElseSucceed(() => fallback),
  );
}

const loadConfig = Effect.gen(function* () {
  const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";

  const walletPrivateKey = yield* Config.string("WALLET_PRIVATE_KEY").pipe(
    Effect.orElseSucceed(() => ""),
  );
  const heliusApiKey = yield* Config.string("HELIUS_API_KEY").pipe(
    Effect.orElseSucceed(() => (isTest ? "test-helius-key" : "")),
  );
  const solanaRpcUrl = yield* Config.string("SOLANA_RPC_URL").pipe(
    Effect.orElseSucceed(() =>
      isTest ? "https://example.com" : "https://api.mainnet-beta.solana.com",
    ),
  );
  const paperTrading = yield* Config.boolean("PAPER_TRADING").pipe(
    Effect.orElseSucceed(() => true),
  );
  const scanIntervalMs = yield* validatedNumber("SCAN_INTERVAL_MS", 10_000, 600_000);
  const minPoolTvlUsd = yield* validatedNumber("MIN_POOL_TVL_USD", 0, 50_000);
  const minFeeIlRatio = yield* validatedNumber("MIN_FEE_IL_RATIO", 0, 1.2);
  const tvlDropExitPct = yield* validatedNumber("TVL_DROP_EXIT_PCT", 0, 0.3);
  const volumeAuthThreshold = yield* validatedNumber("VOLUME_AUTH_THRESHOLD", 0, 0.7);
  const maxConcurrentPositions = yield* validatedNumber("MAX_CONCURRENT_POSITIONS", 1, 5);
  const minRebalanceIntervalMs = yield* validatedNumber(
    "MIN_REBALANCE_INTERVAL_MS",
    0,
    24 * 60 * 60 * 1000,
  );
  const minRebalanceNetBenefitUsd = yield* validatedNumber("MIN_REBALANCE_NET_BENEFIT_USD", 0, 10);
  const confidenceThreshold = yield* validatedNumber("CONFIDENCE_THRESHOLD", 0, 0.65);
  const paperPortfolioUsd = yield* validatedNumber("PAPER_PORTFOLIO_USD", 1, 10_000);
  const minBinUtilization = yield* validatedNumber("MIN_BIN_UTILIZATION", 0, 0.3);
  const maxRebalanceRangeBins = yield* validatedNumber("MAX_REBALANCE_RANGE_BINS", 1, 50);
  const watchlistPoolsRaw = yield* Config.string("WATCHLIST_POOLS").pipe(
    Effect.orElseSucceed(() => ""),
  );

  // New feature configs
  const stopLossPct = yield* validatedNumber("STOP_LOSS_PCT", 0, 0.15);
  const trailingStopPct = yield* validatedNumber("TRAILING_STOP_PCT", 0, 0.1);
  const oorGracePeriodCycles = yield* validatedNumber("OOR_GRACE_PERIOD_CYCLES", 0, 3);
  const feeClaimIntervalMs = yield* validatedNumber(
    "FEE_CLAIM_INTERVAL_MS",
    0,
    24 * 60 * 60 * 1000,
  );
  const enablePoolDiscovery = yield* Config.boolean("ENABLE_POOL_DISCOVERY").pipe(
    Effect.orElseSucceed(() => false),
  );
  const discoveryMinTvlUsd = yield* validatedNumber("DISCOVERY_MIN_TVL_USD", 0, 100_000);
  const discoveryMinFeeRatio = yield* validatedNumber("DISCOVERY_MIN_FEE_RATIO", 0, 1.5);
  const deployerBlacklistPath = yield* Config.string("DEPLOYER_BLACKLIST_PATH").pipe(
    Effect.orElseSucceed(() => "./engine/data/deployer-blacklist.json"),
  );
  const tokenBlacklistPath = yield* Config.string("TOKEN_BLACKLIST_PATH").pipe(
    Effect.orElseSucceed(() => "./engine/data/token-blacklist.json"),
  );
  const sqliteDbPath = yield* Config.string("SQLITE_DB_PATH").pipe(
    Effect.orElseSucceed(() => "./prism.db"),
  );
  const enableSnapshotCapture = yield* Config.boolean("ENABLE_SNAPSHOT_CAPTURE").pipe(
    Effect.orElseSucceed(() => false),
  );

  // Auto-update config
  const autoUpdate = yield* Config.boolean("AUTO_UPDATE").pipe(Effect.orElseSucceed(() => true));
  const updateCheckIntervalMs = yield* validatedNumber(
    "UPDATE_CHECK_INTERVAL_MS",
    60_000,
    21_600_000,
  );
  const updateChannelRaw = yield* Config.string("UPDATE_CHANNEL").pipe(
    Effect.orElseSucceed(() => "stable"),
  );
  const validChannels = ["stable", "beta", "dev"] as const;
  const updateChannel = validChannels.includes(updateChannelRaw as (typeof validChannels)[number])
    ? (updateChannelRaw as (typeof validChannels)[number])
    : "stable";
  const updateGithubRepo = yield* Config.string("UPDATE_GITHUB_REPO").pipe(
    Effect.orElseSucceed(() => "irfndi/prism-liquidity-agent"),
  );
  const updateAllowDirty = yield* Config.boolean("UPDATE_ALLOW_DIRTY").pipe(
    Effect.orElseSucceed(() => false),
  );
  const updateR2PublicUrl = yield* Config.string("UPDATE_R2_PUBLIC_URL").pipe(
    Effect.orElseSucceed(() => "https://r2.prism-agent.com"),
  );

  const githubToken = yield* Config.string("GITHUB_TOKEN").pipe(Effect.orElseSucceed(() => ""));
  const githubRepo = yield* Config.string("GITHUB_REPO").pipe(
    Effect.orElseSucceed(() => "irfndi/prism-liquidity-agent"),
  );
  const feedbackOptOut = yield* Config.boolean("PRISM_FEEDBACK_OPT_OUT").pipe(
    Effect.orElseSucceed(() => false),
  );
  const paperModeExitLive = yield* Config.boolean("PAPER_MODE_EXIT_LIVE").pipe(
    Effect.orElseSucceed(() => false),
  );

  const watchlistPools = watchlistPoolsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const cfg: AppConfig = {
    walletPrivateKey,
    heliusApiKey,
    solanaRpcUrl,
    paperTrading,
    scanIntervalMs,
    minPoolTvlUsd,
    minFeeIlRatio,
    tvlDropExitPct,
    volumeAuthThreshold,
    maxConcurrentPositions,
    minRebalanceIntervalMs,
    minRebalanceNetBenefitUsd,
    confidenceThreshold,
    paperPortfolioUsd,
    minBinUtilization,
    maxRebalanceRangeBins,
    watchlistPools,
    stopLossPct,
    trailingStopPct,
    oorGracePeriodCycles,
    feeClaimIntervalMs,
    enablePoolDiscovery,
    discoveryMinTvlUsd,
    discoveryMinFeeRatio,
    deployerBlacklistPath,
    tokenBlacklistPath,
    sqliteDbPath,
    enableSnapshotCapture,
    autoUpdate,
    updateCheckIntervalMs,
    updateChannel,
    updateGithubRepo,
    updateAllowDirty,
    updateR2PublicUrl,
    githubToken,
    githubRepo,
    feedbackOptOut,
    paperModeExitLive,
  };

  return cfg;
});

export const ConfigLive = Layer.effect(ConfigService, loadConfig);
