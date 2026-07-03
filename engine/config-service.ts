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
  // Force auto-update settings
  readonly forceUpdateEnabled: boolean;
  readonly forceUpdateAfterDays: number;
  // R2 release tarball source (GitHub-independent updates)
  readonly updateR2PublicUrl: string;
  readonly githubToken: string;
  readonly githubRepo: string;
  readonly feedbackOptOut: boolean;
  // Allow paper mode to exit live positions (opt-in escape hatch)
  readonly paperModeExitLive: boolean;
  // Meteora DLMM pool-discovery API URL. Override with METEORA_POOLS_URL
  // env var; falls back to the official DLMM Data API (dlmm.datapi.meteora.ag)
  // if the env var is unset or empty.
  readonly meteoraPoolsUrl: string;

  // ─── F1: Gas-aware rebalancing ──────────────────────────────────────────────
  /** Estimated SOL cost of a single rebalance tx (entry + close). */
  readonly rebalanceGasCostSol: number;
  /** USD price of 1 SOL, used to convert gas to USD. */
  readonly solPriceUsd: number;
  /** Skip REBALANCE when gas cost > daysOfFeesPaidAhead × position's 24h fees. */
  readonly gasAwareMinDaysOfFeesPaidAhead: number;

  // ─── F2: Volatility-adjusted range sizing ───────────────────────────────────
  /** Stddev of active bin over recent snapshots above this ⇒ high-vol. */
  readonly volatilityExitStddev: number;
  /** # snapshots to use for the volatility window. */
  readonly volatilityLookbackSnapshots: number;
  /** High-vol bin range width (bins each side). Wider = more breathing room. */
  readonly volatilityWideHalfWidthBins: number;

  // ─── F3: Fee compounding / auto-reinvest ─────────────────────────────────────
  /** Master switch for auto-reinvest of accrued fees. */
  readonly autoCompoundFees: boolean;
  /** Minimum net fee (USD) required to trigger a compound cycle. */
  readonly minCompoundFeesUsd: number;
  /** Buffer (USD) added to the gas cost when evaluating compound worth-it. */
  readonly compoundGasBufferUsd: number;

  // ─── F4: OOR recovery prediction ─────────────────────────────────────────────
  /** # cycles of bin history used to estimate mean-reversion. */
  readonly oorRecoveryLookbackCycles: number;
  /** Above this probability → skip REBALANCE, hold & wait. */
  readonly oorRecoveryHoldThreshold: number;
  /** Below this probability → REBALANCE regardless of cost. */
  readonly oorRecoveryForceRebalanceThreshold: number;

  // ─── F5: Multi-pool allocation ──────────────────────────────────────────────
  /** Max % of portfolio that any single pool can absorb. */
  readonly maxPerPoolAllocationPct: number;
  /** Hard cap on number of simultaneously open positions. */
  readonly maxOpenPositions: number;

  // ─── F6: Paper-trading validation period ────────────────────────────────────
  /** Require N days of paper trading before allowing live ENTER. */
  readonly paperValidationMinDays: number;
  /** Hard-block live ENTER if validation not met (vs warn only). */
  readonly paperValidationEnforce: boolean;

  // ─── F7: Pool cooldown after failed exits ───────────────────────────────────
  readonly oorCooldownMs: number;
  readonly repeatOorCooldownMs: number;
  readonly maxOorCooldownExits: number;

  // ─── Agentic mode / LLM overlay ──────────────────────────────────────
  /** Enable non-deterministic LLM reasoning overlay. Only active when Prism runs as an agent skill. Default false. */
  readonly agentiveMode: boolean;
  /** LLM API key (OpenAI-compatible endpoint). Empty string = disabled. */
  readonly llmApiKey: string;
  /** LLM model name. Default "gpt-4o". */
  readonly llmModel: string;
  /** LLM base URL for OpenAI-compatible APIs. Default "https://api.openai.com/v1". */
  readonly llmBaseUrl: string;
  /** Maximum tokens for LLM reasoning response. Default 1024. */
  readonly llmMaxTokens: number;

  // ─── Threshold evolution ─────────────────────────────────────────────
  /** How many closed positions between evolution rounds. Default 5. */
  readonly evolutionInterval: number;
  /** Max percentage change per evolution round. Default 0.20. */
  readonly evolutionMaxChangePct: number;

  // ─── Darwinian signal weighting ─────────────────────────────────────
  readonly signalWeightWindowDays: number;
  readonly signalWeightMinOutcomes: number;
  readonly signalWeightBoostFactor: number;
  readonly signalWeightDecayFactor: number;
  readonly signalWeightFloor: number;
  readonly signalWeightCeiling: number;
  readonly weightedEntryScoreThreshold: number;
}

export class ConfigService extends Context.Tag("ConfigService")<ConfigService, AppConfig>() {}

function validatedNumber(name: string, min: number, fallback: number, max?: number) {
  return Config.number(name).pipe(
    Effect.map((n) => {
      if (!Number.isFinite(n) || n < min) return fallback;
      return max !== undefined && n > max ? max : n;
    }),
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

  // ─── F1: Gas-aware rebalancing ──────────────────────────────────────────────
  const rebalanceGasCostSol = yield* validatedNumber("REBALANCE_GAS_COST_SOL", 0, 0.01);
  const solPriceUsd = yield* validatedNumber("SOL_PRICE_USD", 0, 150, 10_000);
  const gasAwareMinDaysOfFeesPaidAhead = yield* validatedNumber(
    "GAS_AWARE_MIN_DAYS_OF_FEES_PAID_AHEAD",
    0,
    3,
  );

  // ─── F2: Volatility-adjusted range sizing ───────────────────────────────────
  const volatilityExitStddev = yield* validatedNumber("VOLATILITY_EXIT_STDDEV", 0, 5);
  const volatilityLookbackSnapshots = yield* validatedNumber(
    "VOLATILITY_LOOKBACK_SNAPSHOTS",
    3,
    12,
  );
  const volatilityWideHalfWidthBins = yield* validatedNumber(
    "VOLATILITY_WIDE_HALF_WIDTH_BINS",
    5,
    50,
  );

  // ─── F3: Fee compounding / auto-reinvest ─────────────────────────────────────
  const autoCompoundFees = yield* Config.boolean("AUTO_COMPOUND_FEES").pipe(
    Effect.orElseSucceed(() => false),
  );
  const minCompoundFeesUsd = yield* validatedNumber("MIN_COMPOUND_FEES_USD", 0, 0.5);
  const compoundGasBufferUsd = yield* validatedNumber("COMPOUND_GAS_BUFFER_USD", 0, 0.05);

  // ─── F4: OOR recovery prediction ─────────────────────────────────────────────
  const oorRecoveryLookbackCycles = yield* validatedNumber("OOR_RECOVERY_LOOKBACK_CYCLES", 3, 10);
  const oorRecoveryHoldThreshold = yield* validatedNumber("OOR_RECOVERY_HOLD_THRESHOLD", 0, 0.6);
  const oorRecoveryForceRebalanceThreshold = yield* validatedNumber(
    "OOR_RECOVERY_FORCE_REBALANCE_THRESHOLD",
    0,
    0.2,
  );

  // ─── F5: Multi-pool allocation ──────────────────────────────────────────────
  const maxPerPoolAllocationPct = yield* validatedNumber(
    "MAX_PER_POOL_ALLOCATION_PCT",
    0,
    0.4,
    1.0,
  );
  const maxOpenPositions = yield* validatedNumber("MAX_OPEN_POSITIONS", 1, 3);

  // ─── F6: Paper-trading validation period ────────────────────────────────────
  const paperValidationMinDays = yield* validatedNumber("PAPER_VALIDATION_MIN_DAYS", 0, 7);
  const paperValidationEnforce = yield* Config.boolean("PAPER_VALIDATION_ENFORCE").pipe(
    Effect.orElseSucceed(() => false),
  );

  // ─── F7: Pool cooldown after failed exits ───────────────────────────────────
  const oorCooldownMs = yield* validatedNumber("OOR_COOLDOWN_MS", 0, 4 * 60 * 60 * 1000);
  const repeatOorCooldownMs = yield* validatedNumber("REPEAT_OOR_COOLDOWN_MS", 0, 12 * 60 * 60 * 1000);
  const maxOorCooldownExits = yield* validatedNumber("MAX_OOR_COOLDOWN_EXITS", 1, 3);

  // ─── Agentic mode / LLM overlay ──────────────────────────────────────
  const agentiveMode = yield* Config.boolean("AGENTIC_MODE").pipe(
    Effect.orElseSucceed(() => false),
  );
  const llmApiKey = yield* Config.string("LLM_API_KEY").pipe(
    Effect.orElseSucceed(() => ""),
  );
  const llmModel = yield* Config.string("LLM_MODEL").pipe(
    Effect.orElseSucceed(() => "gpt-4o"),
  );
  const llmBaseUrl = yield* Config.string("LLM_BASE_URL").pipe(
    Effect.orElseSucceed(() => "https://api.openai.com/v1"),
  );
  const llmMaxTokens = yield* validatedNumber("LLM_MAX_TOKENS", 256, 1024, 8192);

  // ─── Threshold evolution ─────────────────────────────────────────────
  const evolutionInterval = yield* validatedNumber("EVOLUTION_INTERVAL", 1, 5, 100);
  const evolutionMaxChangePct = yield* validatedNumber(
    "EVOLUTION_MAX_CHANGE_PCT",
    0.01,
    0.20,
    1.0,
  );

  const signalWeightWindowDays = yield* validatedNumber("SIGNAL_WEIGHT_WINDOW_DAYS", 7, 60);
  const signalWeightMinOutcomes = yield* validatedNumber("SIGNAL_WEIGHT_MIN_OUTCOMES", 3, 10);
  const signalWeightBoostFactor = yield* validatedNumber(
    "SIGNAL_WEIGHT_BOOST_FACTOR",
    1.0,
    1.05,
    2.0,
  );
  const signalWeightDecayFactor = yield* validatedNumber(
    "SIGNAL_WEIGHT_DECAY_FACTOR",
    0.5,
    0.95,
    1.0,
  );
  const signalWeightFloor = yield* validatedNumber("SIGNAL_WEIGHT_FLOOR", 0.1, 0.3, 1.0);
  const signalWeightCeiling = yield* validatedNumber("SIGNAL_WEIGHT_CEILING", 1.0, 2.5, 5.0);
  const weightedEntryScoreThreshold = yield* validatedNumber(
    "WEIGHTED_ENTRY_SCORE_THRESHOLD",
    0.1,
    1.8,
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
  const forceUpdateEnabled = yield* Config.boolean("FORCE_UPDATE_ENABLED").pipe(
    Effect.orElseSucceed(() => false),
  );
  const forceUpdateAfterDays = yield* validatedNumber("FORCE_UPDATE_AFTER_DAYS", 1, 14);
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
  const meteoraPoolsUrlRaw = yield* Config.string("METEORA_POOLS_URL").pipe(
    Effect.orElseSucceed(() => ""),
  );
  const meteoraPoolsUrl =
    meteoraPoolsUrlRaw ||
    "https://dlmm.datapi.meteora.ag/pools?page=1&page_size=1000&filter_by=is_blacklisted=false&sort_by=tvl:desc";

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
    forceUpdateEnabled,
    forceUpdateAfterDays,
    updateR2PublicUrl,
    githubToken,
    githubRepo,
    feedbackOptOut,
    paperModeExitLive,
    meteoraPoolsUrl,

    rebalanceGasCostSol,
    solPriceUsd,
    gasAwareMinDaysOfFeesPaidAhead,
    volatilityExitStddev,
    volatilityLookbackSnapshots,
    volatilityWideHalfWidthBins,
    autoCompoundFees,
    minCompoundFeesUsd,
    compoundGasBufferUsd,
    oorRecoveryLookbackCycles,
    oorRecoveryHoldThreshold,
    oorRecoveryForceRebalanceThreshold,
    maxPerPoolAllocationPct,
    maxOpenPositions,
    paperValidationMinDays,
    paperValidationEnforce,
    oorCooldownMs,
    repeatOorCooldownMs,
    maxOorCooldownExits,
    agentiveMode,
    llmApiKey,
    llmModel,
    llmBaseUrl,
    llmMaxTokens,
    evolutionInterval,
    evolutionMaxChangePct,
    signalWeightWindowDays,
    signalWeightMinOutcomes,
    signalWeightBoostFactor,
    signalWeightDecayFactor,
    signalWeightFloor,
    signalWeightCeiling,
    weightedEntryScoreThreshold,
  };

  return cfg;
});

export const ConfigLive = Layer.effect(ConfigService, loadConfig);
