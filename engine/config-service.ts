import { Config, ConfigProvider, Context, Effect, Layer } from "effect";
import { ConfigError } from "./errors.js";
import { getPrismDbPath } from "./paths.js";
import { loadKeystoreSecretKeyBase58 } from "./wallet-keystore.js";
import type {
  AgentProposalMode,
  AutonomousTokenMode,
  EntryStrategyType,
  SettlementAsset,
} from "./types.js";
import { PublicKey } from "@solana/web3.js";
import { createLogger } from "./logger.js";
import { applyDbConfigOverrides, readDbConfigOverrides } from "./db-config.js";
import { ENTRY_SIZE_CAP_USD, ENTRY_SIZE_FLOOR_USD } from "./entry-sizing.js";

const logger = createLogger("ConfigService");

export type FeeDestination = "compound" | "accumulate-quote" | "accumulate-sol";

export const AUTONOMOUS_TOKEN_CONFIG_DEFAULTS = {
  autonomousTokenMode: "off",
  settlementAsset: "SOL",
  candidateMinHealthyScans: 6,
  candidateMinObservationMs: 3_600_000,
  candidateScanLimit: 20,
  candidateMinPoolAgeMs: 86_400_000,
  maxMarketDataAgeMs: 300_000,
  maxSwapSlippageBps: 50,
  maxSwapPriceImpactBps: 100,
  settlementDustUsd: 0.1,
  settlementMaxPendingMs: 3_600_000,
  maxDailyDrawdownPct: 5,
  maxConsecutiveExecutionFailures: 3,
  agentInstanceId: "primary",
} as const;

export function maskHeliusUrl(u: string): string {
  return u.replace(/(api[-_]key=)[^&\s]*/g, "$1[REDACTED]");
}

/** Keyless public Solana RPC used as the default fallback tier. */
export const PUBLIC_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";

/**
 * Additional keyless public Solana RPC used to spread keyless load. PublicNode
 * is keyless and verified reachable (2026-08); Ankr's endpoint now requires an
 * API key, so it is deliberately NOT included.
 */
export const PUBLICNODE_SOLANA_RPC_URL = "https://solana-rpc.publicnode.com";

/**
 * Resolve the RPC fallback URL. When the operator left `SOLANA_RPC_FALLBACK_URL`
 * empty, default it to keyless public Solana RPC so a (shared) primary key's
 * 429s/5xx actually fail over instead of erroring — and so a keyless primary
 * still has a second keyless endpoint to round-robin against. Pure + testable.
 * - empty configured fallback + primary already the public RPC → PublicNode (no self-fallback)
 * - empty configured fallback + test mode → "" (tests never touch the network)
 * - empty configured fallback + production + non-public primary → public RPC
 * - non-empty configured fallback → used as-is
 */
export function resolveRpcFallbackUrl(
  configuredFallback: string,
  primaryUrl: string,
  isTest: boolean,
): string {
  if (configuredFallback.trim()) return configuredFallback;
  if (isTest) return "";
  return primaryUrl.trim() === PUBLIC_SOLANA_RPC_URL
    ? PUBLICNODE_SOLANA_RPC_URL
    : PUBLIC_SOLANA_RPC_URL;
}

function isHeliusHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const hostname = parsed.hostname;
    return hostname === "helius-rpc.com" || hostname.endsWith(".helius-rpc.com");
  } catch {
    return false;
  }
}

/**
 * Normalize a Helius RPC URL: fix the common `api_key` → `api-key` typo,
 * replace empty `api-key=` values with the configured key, and append the
 * key when the parameter is missing entirely.
 *
 * Helius currently accepts both spellings, but `api-key` is the documented
 * form and the one every code-generated URL uses.  User-edited `.env` files
 * often contain `api_key`, which is a latent breakage waiting for a Helius
 * API tightening.
 *
 * Security: hostname is validated via URL parsing (not substring match) to
 * prevent credential leakage to attacker-controlled domains such as
 * `helius-rpc.com.attacker.example`.  API key values are redacted in logs.
 */
export interface HeliusUrlNormalization {
  readonly url: string;
  readonly normalized: boolean;
}

export function normalizeHeliusUrl(url: string, heliusApiKey: string): HeliusUrlNormalization {
  const trimmed = url.trim();
  if (!trimmed || !isHeliusHost(trimmed)) {
    return { url: trimmed, normalized: false };
  }

  let result = trimmed;
  let normalized = false;

  if (result.includes("api_key=")) {
    result = result.replace(/api_key=/g, "api-key=");
    normalized = true;
    logger.warn("Normalized Helius URL: replaced api_key= with api-key=", {
      original: maskHeliusUrl(trimmed),
      corrected: maskHeliusUrl(result),
    });
  }

  if (heliusApiKey) {
    const emptyKeyMatch = result.match(/api-key=(&|$)/);
    if (emptyKeyMatch) {
      result = result.replace(/api-key=(&|$)/, `api-key=${heliusApiKey}$1`);
      normalized = true;
      logger.warn("Helius URL had empty api-key value; replaced with configured key", {
        corrected: maskHeliusUrl(result),
      });
    } else if (!result.includes("api-key=")) {
      const separator = result.includes("?") ? "&" : "?";
      result = `${result}${separator}api-key=${heliusApiKey}`;
      normalized = true;
      logger.warn("Helius URL was missing api-key parameter; appended configured key", {
        corrected: maskHeliusUrl(result),
      });
    }
  }

  return { url: result, normalized };
}

export interface AppConfig {
  readonly walletPrivateKey: string;
  readonly heliusApiKey: string;
  /** Skip the keyed Helius DAS `getAsset` metadata fallback (burned under an exhausted free-tier key). Defaults to false. */
  readonly heliusDasDisabled?: boolean;
  readonly solanaRpcUrl: string;
  readonly solanaRpcFallbackUrl: string;
  /** Minimum interval between Solana RPC requests (ms). Defaults to 150. */
  readonly rpcMinIntervalMs?: number;
  readonly paperTrading: boolean;
  readonly autonomousTokenMode: AutonomousTokenMode;
  readonly settlementAsset: SettlementAsset;
  readonly candidateMinHealthyScans: number;
  readonly candidateMinObservationMs: number;
  readonly candidateScanLimit: number;
  readonly candidateMinPoolAgeMs: number;
  readonly maxMarketDataAgeMs: number;
  readonly maxSwapSlippageBps: number;
  readonly maxSwapPriceImpactBps: number;
  readonly settlementDustUsd: number;
  readonly settlementMaxPendingMs: number;
  readonly maxDailyDrawdownPct: number;
  readonly maxConsecutiveExecutionFailures: number;
  readonly agentInstanceId: string;
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
  /** Consecutive cycles the trailing-stop drawdown must persist before EXIT (anti-phantom). */
  readonly trailingStopConfirmCycles: number;
  readonly oorGracePeriodCycles: number;
  readonly feeClaimIntervalMs: number;
  readonly enablePoolDiscovery: boolean;
  readonly discoveryMinTvlUsd: number;
  readonly discoveryMinFeeRatio: number;

  // ─── Market-scan mode (universe-driven trading) ─────────────────────────
  // When enabled, the watchlist is OPTIONAL: the engine continuously scans
  // the top pages of the Meteora universe (by TVL), re-runs the market gate
  // (TVL / fee APR / volume / token-safety / bin-step) on a refresh cadence,
  // and trades the top-ranked pools through the normal per-pool gates —
  // safety screening, metrics, pre-filter, ENTER/HOLD/EXIT, risk. Pools that
  // stop qualifying fall out of the active set; open positions are always
  // kept in the scan set so exits never stall. Optional (like the Wave-17
  // fields) so standalone fixtures that omit them keep compiling; loadConfig
  // always sets all of them.
  readonly marketScanEnabled?: boolean;
  /** How often the universe gate re-runs and the ranked set is rebuilt.
   *  Default 30 min; minimum 60 s. */
  readonly marketScanRefreshIntervalMs?: number;
  /** Top-N pages (1000 pools each) of the TVL-ranked universe fetched per
   *  refresh. Default 3 (covers every pool above ~$50-100K TVL). */
  readonly marketScanUniversePages?: number;
  /** Universe sort for the market scan: `tvl` (TVL desc, default, large pools
   *  first) or `fee` (24h fee/TVL ratio desc — surfaces the hot yield pools
   *  in the first pages, aligning the fetch with the market gate's fee-APR
   *  ranking and reducing the pages needed to reach the runnable set). */
  readonly marketScanUniverseSort?: "tvl" | "fee";
  /** Minimum TVL for a pool to pass the market gate. Default $250K. */
  readonly marketScanMinTvlUsd?: number;
  /** Minimum annualized fee/TVL percent for the market gate (fees24h × 365 /
   *  tvl × 100). Default 100 (only real-yield pools enter the active set). */
  readonly marketScanMinFeeApr?: number;
  readonly marketScanRunnerEnabled?: boolean;
  readonly marketScanRunnerMinFeeApr?: number;
  /** Minimum net active-bin drift (bins) for runner admission. A runner whose
   *  drift sits below this floor is a sustained decliner, not a dip — reject
   *  BEFORE the drift-gate exemption can buy it. Default -8 (matches the
   *  normal-lane drift floor). */
  readonly marketScanRunnerMinDriftBins?: number;
  readonly marketScanRotationEnabled?: boolean;
  readonly marketScanRotationAprMult?: number;
  readonly marketScanRunnerConfirmCycles?: number;
  readonly marketScanRotationArmMs?: number;
  /** Regime-gate master switch: herding ENTER damper. Default false. */
  readonly regimeHerdingGateEnabled?: boolean;
  /** Herding block threshold on cross-pool edge density (default 0.8). */
  readonly regimeHerdingEdgeThreshold?: number;
  /** Herding block threshold on mean pairwise correlation (default 0.6). */
  readonly regimeHerdingCorrThreshold?: number;
  /** Euphoria damper for the runner lane (self-relative APR outlier). Default false. */
  readonly runnerAprOutlierEnabled?: boolean;
  /** Self-rank at/above which a runner APR is a spike outlier (default 0.98). */
  readonly runnerAprOutlierPercentile?: number;
  /** Arms the volume-burst trigger inside the hot-window lane. Default false. */
  readonly flashVolumeTriggerEnabled?: boolean;
  /** Volume burst multiple vs trailing median required (default 2.5). */
  readonly flashMinSpikeRatio?: number;
  /** Trailing per-cycle readings forming the spike baseline (default 8). */
  readonly flashBaselineWindow?: number;
  /** Minimum current 24h volume (USD) for a burst entry (default 10000). */
  readonly flashMinVolumeUsd?: number;
  /** Churn circuit breaker: max ENTERs per pool per UTC day. Default 4.
   *  0 disables the cap. Exits are never restricted. */
  readonly churnMaxEntriesPerPoolPerDay?: number;
  /** Hold-bias master switch: suppress the fee-trend economic EXITs
   *  (fee/IL < 0.5, volume-authenticity, yield-regression) while a position
   *  stays in-range, so liquidity keeps collecting fees instead of churning
   *  round-trips at spread cost. Capital-protection exits (W15, IL
   *  dominance, dust, TVL drop, trailing stop, lifecycles) are NEVER
   *  suppressed. Default false. */
  readonly holdBiasEnabled?: boolean;
  /** Market-gate absolute 24h fee floor (USD). Focuses the scan universe on
   *  pools with real fee dollars — percentage APR alone admits micro-pools
   *  with spectacular ratios but trivial income. Default 0 = disabled. */
  readonly marketScanMinFees24hUsd?: number;
  /** Market-gate absolute 24h volume floor (USD). Real sustained volume is
   *  the honeypot counter-signal. Default 0 = disabled. */
  readonly marketScanMinVolume24hUsd?: number;
  readonly yieldRegressionExitPct?: number;
  readonly feeCaptureConversionCostPct?: number;
  readonly feeCaptureHarvestCostUsd?: number;
  /** Per-swap cost (slippage + fees) the runner churn model charges each OOR
   *  exit's round trip, as a fraction (0.005 = 0.5%). Default 0.005. */
  readonly runnerSwapCostPct?: number;
  /** Minimum net daily yield (% of the position) a runner must clear AFTER
   *  churn/IL/swap costs to enter or keep running; below this the runner
   *  bleeds and is skipped / exited. Default 1 (%/day). */
  readonly runnerNetFloorPct?: number;
  readonly harvestMinNetUsd?: number;
  readonly harvestMaxCostPct?: number;
  readonly harvestTxCostUsdEst?: number;
  readonly allowTransferFeeTokens?: boolean;
  readonly tokenFailureBlockMs?: number;
  /** Rug exit = a closed position whose realized PnL ≤ -(depositedUsd × this).
   *  Default 0.5: a 50%+ realized loss marks a rug/drain and arms the rug-token
   *  block for the position's non-stable legs. Clamped [0.05, 1]. */
  readonly rugExitLossPct?: number;
  /** How long (ms) a rug exit blocks re-entry into the rugged token. Default
   *  7 days; clamped [1h, 30 days]. Distinct from tokenFailureBlockMs so a
   *  drained token stays blocked far longer than a transient exit failure. */
  readonly rugTokenBlockMs?: number;
  readonly minYieldExitAgeMs?: number;
  readonly marketScanMaxNegativeDriftBins?: number;
  readonly entryMomentumConfBoost?: number;
  readonly entryMomentumReferenceBins?: number;
  readonly entryMomentumScoreWeight?: number;
  readonly takeProfitEnabled?: boolean;
  readonly takeProfitPct?: number;
  readonly backtestTolerateEmptyBins?: boolean;
  /** How many top-ranked market pools are actively scanned each cycle. */
  readonly marketScanTopK?: number;
  /** Hard cap on market-scan pools in the active scan set. */
  readonly marketScanMaxPools?: number;
  /** Minimum holders for a non-stable, non-SOL leg to pass the market gate
   *  (rug/IL-safety pre-filter; the per-pool token-risk overlay still runs). */
  readonly marketScanMinHolders?: number;
  /** Hot-lane hard gate: reject a market candidate when a non-stable, non-SOL
   *  leg still has a live mint authority (not renounced) — dev can mint+dump.
   *  Advisory in the standalone token-risk overlay; here it is a hard reject
   *  for the market/runner lane. Default true. */
  readonly marketScanRequireRenouncedMint?: boolean;
  /** Hot-lane hard gate: reject a market candidate younger than this many
   *  hours (rug-factory filter — brand-new pools are the ruin tail; the runner
   *  lane should trade proven-age pools only). 0 disables. Default 24. */
  readonly marketScanMinPoolAgeHours?: number;
  /** Skip pools with bin step below this (ultra-fine bins churn). Default 2. */
  readonly marketScanMinBinStep?: number;
  /** Skip pools with bin step above this. Default 200. */
  readonly marketScanMaxBinStep?: number;

  // ─── Launch-scan mode (hot-DLMM-pool launch radar) ─────────────────────
  // When enabled, the engine refreshes a discovery snapshot of the hottest
  // YOUNG DLMM pools (fee-yield-ranked) and runs them through the pure
  // launch gate. Radar/screening only in v1 — no execution wiring.
  readonly launchScanEnabled?: boolean;
  /** How often the launch radar re-discovers and re-gates. Default 2 min;
   *  minimum 10 s. */
  readonly launchScanRefreshIntervalMs?: number;
  /** Top-N launch pools logged per refresh. Default 30 (1..200). */
  readonly launchScanTopK?: number;
  /** Candidate universe fetched per refresh BEFORE gating (the gate rejects
   *  most candidates, so fetch wide then slice top-K). Default 500 (1..1000). */
  readonly launchScanUniverseSize?: number;
  /** Minimum TVL for a launch pool. Default $5K. */
  readonly launchScanMinTvlUsd?: number;
  /** Maximum TVL — above this the pool is established, not a launch. Default $1M. */
  readonly launchScanMaxTvlUsd?: number;
  /** Maximum pool age in hours (from pool creation). Default 6 (1..72). */
  readonly launchScanMaxAgeHours?: number;
  /** Minimum 1h volume (USD) for a launch pool. Default $50K. */
  readonly launchScanMinVolume1hUsd?: number;
  /** Minimum base fee percent (pool_config.base_fee_pct). Default 1%. */
  readonly launchScanMinBaseFeePct?: number;
  /** Skip pools with bin step below this. Default 50. */
  readonly launchScanMinBinStep?: number;
  /** Skip pools with bin step above this. Default 200. */
  readonly launchScanMaxBinStep?: number;

  // ─── Launch Mode v2: execution lane ──────────────────────────────────────
  // Launch-gated pools flow through a separate time-boxed lane with
  // launch-specific exits. OFF by default — only effective when
  // launchScanEnabled is also on.
  /** Master switch for launch EXECUTION (radar-only v1 stays OFF here).
   *  Default false; only effective when launchScanEnabled is true. */
  readonly launchExecutionEnabled?: boolean;
  /** Max simultaneous launch positions portfolio-wide (separate counter
   *  from MAX_OPEN_POSITIONS). Default 3 (1..30). */
  readonly launchMaxOpenPositions?: number;
  /** Hard USD cap per launch entry (the sizing formula's cap term).
   *  Default $100 (min 10). */
  readonly launchPositionMaxSizeUsd?: number;
  /** Launch position time-box: exit when held this many hours regardless of
   *  P&L. Default 6 (1..72). */
  readonly launchTimeboxHours?: number;
  // ── Hot-window capture lane ────────────────────────────────────────────────
  /** Master switch for the high-frequency hot-window capture lane. OFF by
   *  default; opt-in and fully reversible. Enters only pools currently
   *  printing fees (measured 1h Data-API fee ratio) within a depth band so a
   *  tiny entry captures a meaningful share, holds at most a short timebox,
   *  and exits — bounded by a daily trip budget and a daily loss halt. */
  readonly hotWindowEnabled?: boolean;
  /** USD entry per hot hold. Default $30 (5..500). */
  readonly hotWindowEntrySizeUsd?: number;
  /** Max pool TVL for a hot entry — beyond this depth an entry's share is too
   *  thin for a short hold to pay for its round-trip churn. Default $25k. */
  readonly hotWindowMaxPoolTvlUsd?: number;
  /** Min pool TVL for a hot entry — below this is dust/rug zone. Default $500. */
  readonly hotWindowMinPoolTvlUsd?: number;
  /** Data-API `fee_tvl_ratio` 1h floor (%/h) that counts as "printing now".
   *  Default 1.0. Measured fees only. */
  readonly hotWindowPrintingRatio1h?: number;
  /** Min share (entry / pool tvl) for an economic hold. Default 0.005 (0.5%). */
  readonly hotWindowMinSharePct?: number;
  /** Max share — never whale a small pool. Default 0.05 (5%). */
  readonly hotWindowMaxSharePct?: number;
  /** Max in-range hold before a timed EXIT. Default 30 min. */
  readonly hotWindowHoldMaxMs?: number;
  /** Max hot ENTERs per day (trip budget). Default 30. */
  readonly hotWindowMaxTripsPerDay?: number;
  /** Halt the lane when today's realized hot PnL falls below this. Default $3. */
  readonly hotWindowDailyLossHaltUsd?: number;
  /** Concurrent hot positions cap. Default 2. */
  readonly hotWindowMaxOpen?: number;
  /** Volume-decay exit: exit when current 1h fees fall below this fraction
   *  of the position's observed peak. Default 0.1 (10%). */
  readonly launchVolumeDecayExitPct?: number;
  /** Hard drawdown stop from the position's peak value. Default 0.25. */
  readonly launchExitDrawdownPct?: number;
  /** Runner mode (Heart Attack) knobs — launch entries anchored below market
   *  with shakeout-tolerant stops. OFF by default. */
  readonly launchRunnerModeEnabled?: boolean;
  readonly launchRunnerDipPct?: number;
  readonly launchRunnerDrawdownPct?: number;
  readonly launchRunnerHalfWidthBins?: number;
  /** Runner scale-in knobs (Heart Attack step 2). */
  readonly launchRunnerScaleInEnabled?: boolean;
  readonly launchRunnerScaleInStepPct?: number;
  readonly launchRunnerScaleInSizePct?: number;
  readonly launchRunnerScaleInMaxSteps?: number;
  /** Wash forensics master switch. */
  readonly launchWashForensicsEnabled?: boolean;
  readonly deployerBlacklistPath: string;
  readonly tokenBlacklistPath: string;
  readonly sqliteDbPath: string;
  readonly enableSnapshotCapture: boolean;
  /** Days of pool_snapshots history to keep; older rows are pruned daily. Default 14. */
  readonly snapshotRetentionDays: number;
  // Auto-update settings
  readonly autoUpdate: boolean;
  readonly updateCheckIntervalMs: number;
  readonly updateChannel: "stable" | "beta" | "dev" | "canary";
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
  readonly meteoraDatapiBaseUrl: string;
  readonly stablecoinMints?: ReadonlySet<string>;
  readonly depegAbsoluteUsd?: number;
  readonly depegRelativePct?: number;
  readonly liquidityDrainPct?: number;
  readonly liquidityDrainLookbackSnapshots?: number;

  // ─── Freeze screening / IL protection (Wave 17) ───────────────────────────
  // Optional (not required) so the many standalone test fixtures that omit new
  // fields keep compiling; loadConfig always sets all four. Absent = safe off.
  /** Smart freeze screening: pass UNTRUSTED freeze-enabled pools to the
   *  pipeline (audit reason + warning memory) instead of hard-rejecting.
   *  Default false (strict reject = today's fail-closed behavior). */
  readonly freezeSmartScreening?: boolean;
  /** Master switch for IL-protection gates (ENTER fee/IL floor +
   *  IL-dominance fast EXIT). Default true. */
  readonly ilProtectionEnabled?: boolean;
  /** IL-dominance fast EXIT fires when IL (USD) > cumulative fees claimed ×
   *  this factor and the position is out of range. Default 2. */
  readonly ilDominanceExitFactor?: number;
  /** Minimum IL (USD) before the IL-dominance fast EXIT may fire. Default 5. */
  readonly ilDominanceMinUsd?: number;
  /** A position whose real mark falls below this USD value is closed as dust
   *  (`[dust-cleanup]` EXIT, confidence 1) — it occupies a per-pool slot and
   *  risk budget but can never pay its way. Default 5; 0 disables the rule. */
  readonly dustExitUsd?: number;

  // ─── Token-risk overlay (Wave 18) ───────────────────────────────────────────
  // Optional so standalone test fixtures that omit new fields keep compiling;
  // loadConfig always sets both. Guard contract: `jupiterTokenRiskEnabled !==
  // false` (production default true; the test fixture pins false to isolate the
  // existing ~80 test files). Absent = overlay active.
  /** Master switch for the Jupiter/Data-API token-risk overlay used by the
   *  freeze-screening seam and ENTER gating. Default true. */
  readonly jupiterTokenRiskEnabled?: boolean;
  /** Minutes a Jupiter token-risk signal is cached before refresh. Default 30. */
  readonly jupiterTokenRiskCacheTtlMin?: number;

  // ─── GoPlus token security (Wave 20) ─────────────────────────────────────────
  // Optional so standalone test fixtures keep compiling; loadConfig always sets
  // all three. GoPlus corroborates the Jupiter overlay with contract-level
  // Solana token-security detection (honeypot/close/mutable-balance). Fail-open
  // like Jupiter: unknown/disabled/failed signals never block entry.
  /** GoPlus app_key. Empty = GoPlus disabled (the overlay skips its consult). */
  readonly goPlusApiKey?: string;
  /** GoPlus app_secret, used to SHA1-sign the access-token request. */
  readonly goPlusApiSecret?: string;
  /** Master switch for the GoPlus token-security consult. Default true. */
  readonly goPlusTokenRiskEnabled?: boolean;
  /** Minutes a GoPlus token-security signal is cached before refresh. Default 30. */
  readonly goPlusTokenRiskCacheTtlMin?: number;

  /** Master switch for the GeckoTerminal secondary pool-stats source (tried when
   *  the Meteora Data API is down). Default true; absent = gecko active. The
   *  test fixture pins false (like jupiterTokenRiskEnabled) so the existing
   *  program tests never touch the network and stay byte-identical. */
  readonly geckoTerminalEnabled?: boolean;

  /** Master switch for the DexScreener parallel pool-stats source (tried when
   *  both the Data API and GeckoTerminal are unavailable). Default true; absent
   *  = active. Same trust posture as gecko (measured volume/TVL, modeled fees,
   *  no safety signals). */
  readonly dexscreenerEnabled?: boolean;

  // ─── Pyth Hermes price feeds ─────────────────────────────────────────────────
  // Optional so standalone test fixtures that omit new fields keep compiling;
  // loadConfig always sets all four. SERVICE-ONLY: the poller layer is
  // available but NO decision code consumes it yet (consumer wiring is a
  // deliberate follow-up). Guard contract: `pythEnabled !== false` (production
  // default true; absent = active).
  /** Master switch for the Pyth Hermes price poller. Default true. */
  readonly pythEnabled?: boolean;
  /** Optional Hermes API key (Authorization: Bearer). Empty = public access,
   *  which Pyth ends shortly after 2026-07-31; a key is required after that. */
  readonly pythApiKey?: string;
  /** Max age of a Hermes publish_time before the price is treated as stale
   *  (→ null). Default 60000, min 5000. */
  readonly pythMaxStalenessMs?: number;
  /** Hermes base URL. Default https://hermes.pyth.network. */
  readonly pythBaseUrl?: string;

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

  // ─── Wave 9: Volatility-adaptive range width ──────────────────────────────
  /** Static baseline range half-width (bins each side). 0 = binStep-tiered default (25/20/15). */
  readonly entryRangeHalfWidthBins: number;
  /** Scale entry/rebalance range width by measured realized volatility. Default true (opt-out). */
  readonly volatilityAdaptiveRanges: boolean;
  /** Price-coverage floor for the range half-width (percent each side). 0 = off. */
  readonly minRangeHalfWidthPct: number;

  // ─── F3: Fee compounding / auto-reinvest ─────────────────────────────────────
  /** Master switch for auto-reinvest of accrued fees. */
  readonly autoCompoundFees: boolean;
  /** Minimum net fee (USD) required to trigger a compound cycle. */
  readonly minCompoundFeesUsd: number;
  /** Buffer (USD) added to the gas cost when evaluating compound worth-it. */
  readonly compoundGasBufferUsd: number;
  readonly feeDestination?: FeeDestination;

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
  /**
   * Max simultaneous positions on a single pool (Wave 10). DLMM natively
   * supports many positions per pool (e.g. a tight+wide range pair); the
   * pool's aggregate exposure across all its positions stays bounded by
   * maxPerPoolAllocationPct. Default 2; set 1 for legacy single-position
   * behavior.
   */
  readonly maxPositionsPerPool: number;
  /** Hard USD ceiling per conservative entry (default 500; see MAX_ENTRY_SIZE_USD). */
  readonly maxEntrySizeUsd: number;

  // ─── F6: Paper-trading validation period ────────────────────────────────────
  /** Require N days of paper trading before allowing live ENTER. */
  readonly paperValidationMinDays: number;
  /** Hard-block live ENTER if validation not met (vs warn only). */
  readonly paperValidationEnforce: boolean;

  // ─── F7: Pool cooldown after failed exits ───────────────────────────────────
  readonly oorCooldownMs: number;
  readonly repeatOorCooldownMs: number;
  readonly maxOorCooldownExits: number;
  /**
   * Same-pool re-entry churn throttle (MIN_REENTRY_COOLDOWN_MS). Arms a pool
   * cooldown on EVERY exit (not just OOR/low-yield), so an exited pool is not
   * re-admitted for at least this long regardless of exit type. Fixes the
   * pathological churn class found in live forensics (2026-08): the pre-existing
   * cooldown armed only for OOR/low-yield exits, so trailing-stop/rotation/TP/
   * yield-regression exits armed NOTHING and a hot pool could exit and re-admit
   * the same pool every ~10 min (5rCf1: 221 round-trips / 2 days, −$163 of pure
   * swap/spread cost drag at ~50% win rate). A 2h throttle blocks ~90% of the
   * observed re-entries. OOR/low-yield exits keep their own (possibly longer)
   * cooldown above it. 0 disables. Default 7 200 000 (2 h).
   */
  readonly minReentryCooldownMs?: number;

  // ─── Fee-density-driven low-yield exit cooldowns ────────────────────────────
  /**
   * Scale the low-yield exit cooldown by measured fee density (datapi
   * `fees24hUsd / tvlUsd` only): high-fee-density pools re-enter sooner,
   * thin pools stay cooled down for the full static `oorCooldownMs`.
   * Off (or density unavailable) → static legacy behavior. Default true.
   */
  readonly feeDensityCooldowns: boolean;
  /** Cooldown floor for fee-density-scaled low-yield exits (the duration a
   *  high-fee-density pool cools down for). Must be below `oorCooldownMs`;
   *  an inverted relationship (min >= static) would swap the settings'
   *  meanings, so the loader warns and clamps the floor to just under the
   *  static value (`oorCooldownMs - 1`, floored at 0) — `OOR_COOLDOWN_MS`
   *  itself is never adjusted. Default 3600000 (1 h). */
  readonly feeDensityCooldownMinMs: number;
  /** Fee density (fees/TVL per day) at/above which the low-yield cooldown
   *  hits `feeDensityCooldownMinMs`. Default 0.005 (0.5 %/day). */
  readonly feeDensityHighPct: number;
  /** Fee density (fees/TVL per day) at/below which the low-yield cooldown
   *  stays at the static `oorCooldownMs`. Must be < `feeDensityHighPct`;
   *  an inverted band falls back to defaults for both. Default 0.0005. */
  readonly feeDensityLowPct: number;

  // ─── Agentic mode / agent runtime overlay ────────────────────────────
  /** Enable non-deterministic agent reasoning overlay. Only active when Prism runs under an agent runtime (Hermes/OpenClaw). Default false. */
  readonly agentiveMode: boolean;
  /** Which agent runtime to use. `auto` detects Hermes or OpenClaw; `none` disables agent overlay. Default "auto". */
  readonly agentRuntime: "auto" | "hermes" | "openclaw" | "none";
  /** Command or binary name for the ACP agent runtime (Hermes). Default "hermes". */
  readonly agentAcpCommand: string;
  /** Arguments passed to the ACP command. Default ["acp"]. */
  readonly agentAcpArgs: ReadonlyArray<string>;
  /** OpenClaw Gateway WebSocket URL. Default "ws://127.0.0.1:18789". */
  readonly agentGatewayUrl: string;
  /** Auth token for OpenClaw Gateway. Empty string = no auth. Default "". */
  readonly agentGatewayToken: string;
  /** Timeout for agent prompt responses. Default 60000 ms. */
  readonly agentPromptTimeoutMs: number;
  /** Timeout for inline veto review. Defaults to agentPromptTimeoutMs; clamp [1s, 5min]. */
  readonly agentVetoTimeoutMs: number;
  /** Interval between periodic agent check-ins. Default 3600000 ms (1 hour). */
  readonly agentCheckinIntervalMs: number;
  /** Send check-ins on significant trade/position events. Default true. */
  readonly agentCheckinOnEvents: boolean;
  /** Include recent decision history in check-ins. Default true. */
  readonly agentCheckinIncludeHistory: boolean;
  /** Max positions to include in check-in summary. Default 10. */
  readonly agentCheckinMaxPositions: number;
  /** OpenClaw webhook URL for one-way agent alerts. Empty = disabled. Default "". */
  readonly agentOpenclawWebhookUrl: string;
  /** Bearer token for the OpenClaw webhook. Empty = no auth header. Default "". */
  readonly agentOpenclawWebhookToken: string;
  /** Hermes HTTP API URL for one-way agent alerts. Empty = disabled. Default "". */
  readonly agentHermesApiUrl: string;
  /** Bearer token (Hermes API_SERVER_KEY) for the Hermes HTTP API. Empty = no auth header. Default "". */
  readonly agentHermesApiToken: string;
  /** Port for the local agent HTTP status API. 0 = disabled. Default 0 (disabled unless explicitly enabled). */
  readonly agentHttpPort: number;
  /** Enable the MCP server for agent runtime tool discovery. Default false (enable only when stdout is isolated). */
  readonly agentMcpEnabled: boolean;
  // ─── Agent Proposals ───────────────────────────────────────────────────────
  /**
   * Agent proposal mode. Default "veto".
   *
   * Authority matrix:
   * - `veto` — legacy overlay only: may reduce confidence or force HOLD; never promotes action.
   * - `suggest` — proposals are advisory logs only; never applied to execution.
   * - `supervised` — ENTER/REBALANCE require a human-approved queued proposal
   *   (`AGENT_APPROVAL_TOKEN`); deterministic EXIT remains free. No sync advisor apply.
   * - `full` — validated proposals may change action (except non-ENTER→ENTER and
   *   EXIT downgrades). HOLD→REBALANCE still passes min-interval/gas/recovery gates;
   *   HOLD→EXIT is allowed when a position exists. Defaults keep this off
   *   (`agentiveMode=false`, mode=`veto`).
   */
  readonly agentProposalMode: AgentProposalMode;
  /** Auth token for agent proposal enqueue (`/propose`). Empty = disabled. Default "". */
  readonly agentProposalToken: string;
  /**
   * Auth token for `/approve` and MCP `prism_approve_proposals`. Required for
   * supervised approvals; does not fall back to `agentProposalToken` (fail-closed).
   * Default "".
   */
  readonly agentApprovalToken: string;
  /** Timeout for agent proposal responses. Default 15000 ms. */
  readonly agentProposalTimeoutMs: number;
  /** Max proposals to queue in one batch. Default 10. */
  readonly agentProposalMaxBatchSize: number;
  /** Max pending proposals retained in the in-memory queue. Default 50. */
  readonly agentProposalMaxQueueSize: number;
  /** How long a proposal is valid before considered stale. Default 300000 ms. */
  readonly agentProposalStaleMs: number;
  /** Base backoff duration for bad proposals. Default 60000 ms. */
  readonly agentProposalBackoffBaseMs: number;
  /** Max backoff duration for bad proposals. Default 3600000 ms. */
  readonly agentProposalBackoffMaxMs: number;
  /** Max position size as percentage of portfolio. Default 0.4. */
  readonly agentProposalMaxPositionSizePct: number;
  /** Minimum confidence for an agent proposal. Default 0.65. */
  readonly agentProposalMinConfidence: number;
  /** Bad proposals before circuit breaker opens. Default 5. */
  readonly agentProposalCircuitBreakerThreshold: number;
  /** Cooldown before circuit breaker can close. Default 300000 ms. */
  readonly agentProposalCircuitBreakerCooldownMs: number;

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
  // Auto-swap USDC into missing pool tokens before live ENTER
  readonly autoSwapEntry: boolean;
  /**
   * DLMM deposit distribution for position creation (ENTRY_STRATEGY_TYPE).
   * `spot` (default) | `curve` | `bidask` | `auto` (`auto` resolves per pool
   * from recent volatility/trend metrics in the decision loop).
   */
  readonly entryStrategyType: EntryStrategyType;

  // ─── Idle-capital auto-redeploy (opt-in) ──────────────────────────────────
  /** Master switch for the per-cycle idle-capital redeploy gate. Default
   *  false — the pass is inert unless explicitly opted in. When on, idle
   *  capital above the threshold is deployed into the cycle's top qualified
   *  entry candidate at a wider size; every existing risk gate still runs
   *  verbatim on the redeploy (caps can reject or shrink, never bypassed). */
  readonly idleRedeployEnabled: boolean;
  /** Idle capital (USD) that must sit un-deployed before the redeploy pass
   *  considers acting. Live: USDC wallet balance; paper: the paper portfolio
   *  seed minus open-position value. Default 500. */
  readonly idleRedeployThresholdUsd: number;
  /** Hard ceiling (USD) on a single idle-redeploy entry, on top of the
   *  per-pool allocation cap the risk tail re-applies. Default 2000. */
  readonly idleRedeployMaxSizeUsd: number;

  /** Rolling realized-PnL loss halt master switch. When true, the engine
   *  computes the trailing realized PnL over the last `realizedPnLHaltWindow`
   *  closed positions once per cycle; if it nets below
   *  `realizedPnLHaltThresholdUsd`, every new-capital ENTER across ALL lanes is
   *  rejected at the risk gate until the strategy nets back up (EXIT/REBALANCE
   *  stay free). The anti-bleed breaker for high-frequency churn lanes that
   *  burn swap/spread cost + IL faster than fee capture. Default false (opt-in,
   *  paper-first). */
  readonly realizedPnLHaltEnabled?: boolean;
  /** Number of most-recent closed positions whose realized PnL is summed for
   *  the rolling halt window. Default 100, min 1. */
  readonly realizedPnLHaltWindow?: number;
  /** USD threshold below which the rolling realized-PnL sum trips the halt.
   *  Default -20. */
  readonly realizedPnLHaltThresholdUsd?: number;
  /** Pool-local realized-PnL kill switch. When enabled, a pool whose latest
   * N known closes net below the threshold is kept out of new ENTERs for the
   * configured cooldown. Existing positions remain eligible for EXIT and
   * REBALANCE. Default false (opt-in). */
  readonly poolPnlKillSwitchEnabled?: boolean;
  readonly poolPnlKillSwitchMinClosedPositions?: number;
  readonly poolPnlKillSwitchThresholdUsd?: number;
  readonly poolPnlKillSwitchCooldownMs?: number;

  /** Master switch for periodic LM farm reward claims (Wave 8). Default true;
   *  scoring stays farm-aware regardless — this only gates on-chain claims. */
  readonly farmRewardsEnabled: boolean;
  readonly limitOrdersEnabled?: boolean;
  readonly limitOrderMode?: "take-profit" | "dca";
  readonly limitOrderTargetBinOffset?: number;
  readonly limitOrderMaxActiveBinSlippage?: number;

  // ─── Proactive Telegram alerts (Wave 5) ───────────────────────────────────
  /** Master switch for proactive Telegram alerts. Default true; delivery only
   *  happens when the user registered and linked Telegram (server-side). */
  readonly alertsEnabled: boolean;
  /** Per-rule (type+pool) cooldown between pushed alerts. Default 120. */
  readonly alertCooldownMinutes: number;
  /** USD step between cumulative-fee milestone alerts. Default 10. */
  readonly alertFeeMilestoneUsd: number;
  readonly copySignalsEnabled?: boolean;
  readonly copySignalsEndpoint?: string;
  readonly copySignalWallets?: ReadonlyArray<string>;
  readonly copySignalsStaleMs?: number;
  readonly copySignalsMaxBoost?: number;

  // ─── Fallen-angel mode (Wave 19) ───────────────────────────────────────────
  // Optional so standalone test fixtures that omit new fields keep compiling;
  // loadConfig always sets all of them. Guard contract: `fallenAngelEnabled ===
  // true` activates the mode (absent/undefined = safe off).
  /** Master switch for fallen-angel mode (mean-reversion on distressed but
   *  clean tokens): any-TVL discovery + RugCheck security + GeckoTerminal
   *  drawdown gate + spot TP-ladder / invalidation-stop lifecycle. Default
   *  false — the whole pipeline is inert unless explicitly opted in. */
  readonly fallenAngelEnabled?: boolean;
  /** Floor (USD) for fallen-angel discovery. Default 50k — normally far below
   *  the standard DISCOVERY_MIN_TVL_USD so under-adopted fallen tokens are
   *  reachable; set 0 for truly any TVL. */
  readonly fallenAngelMinTvlUsd?: number;
  /** Token must be down at LEAST this much from its GeckoTerminal window ATH
   *  to qualify (0..1 fraction, default 0.6 = down 60%). */
  readonly fallenAngelMinDrawdownPct?: number;
  /** Token must be down AT MOST this much from its ATH (0..1 default 0.95) —
   *  deeper than this is a dead/abandoned token, not a fallen angel. */
  readonly fallenAngelMaxDrawdownPct?: number;
  /** Minimum daily-return stddev (default 0.02) — below this the OHLCV series
   *  is too dead to mean-revert. */
  readonly fallenAngelVolBaselineMin?: number;
  /** Maximum daily-return stddev (default 0.35) — above this is a lunatic
   *  token, not an oversold gem. */
  readonly fallenAngelVolBaselineMax?: number;
  /** Maximum RugCheck score_normalised (0..100 RISK index — higher = riskier:
   *  SOL≈1, BONK≈7, a dangerous LP-unlocked token ≈56, mint-authority-enabled
   *  ≈71; verified live 2026-08-05) for a fallen-angel token. Default 60.
   *  The hard security gate is the `risks[].level === "danger"` check; this is
   *  the secondary floor. Fail-closed: a missing/unknown score rejects. */
  readonly fallenAngelMaxRugcheckScore?: number;
  /** Minimum RugCheck holder count (default 300) — a token with no real
   *  holder base can't be an angel. */
  readonly fallenAngelMinHolders?: number;
  /** Maximum top-10 holder concentration (0..1 default 0.5) per RugCheck
   *  topHolders; missing concentration data fails open (skip). */
  readonly fallenAngelMaxTop10HolderPct?: number;
  /** TP-ladder take-profit targets as fractions ABOVE entry (e.g. "0.15,0.30,0.50"
   *  = +15%, +30%, +50%). Default "0.15,0.30,0.50". */
  readonly fallenAngelTpRungs?: ReadonlyArray<number>;
  /** Fraction of the position to scale out at each rung (must sum ≤ 1).
   *  Default "0.4,0.3,0.3" = 40%/30%/30%. Excess over 1 is renormalized. */
  readonly fallenAngelTpFractions?: ReadonlyArray<number>;
  /** Invalidation-stop: EXIT at confidence 1 when price falls below
   *  entry × (1 − pct). Default 0.25 (= cut at −25%). */
  readonly fallenAngelInvalidationStopPct?: number;
  /** Max simultaneous fallen-angel positions portfolio-wide. Default 2 — the
   *  mode is concentrated in nature; the standard MAX_OPEN_POSITIONS cap still
   *  applies on top of this. */
  readonly fallenAngelMaxPositions?: number;
}

export class ConfigService extends Context.Service<ConfigService, AppConfig>()("ConfigService") {}

function validatedNumber(name: string, min: number, fallback: number, max?: number) {
  return Config.number(name).pipe(
    Effect.map((n) => {
      if (!Number.isFinite(n)) {
        logger.warn("Invalid numeric configuration; using fallback", { name, value: n, fallback });
        return fallback;
      }
      if (n < min) {
        logger.warn("Numeric configuration below minimum; clamping", { name, value: n, min });
        return min;
      }
      if (max !== undefined && n > max) {
        logger.warn("Numeric configuration above maximum; clamping", { name, value: n, max });
        return max;
      }
      return n;
    }),
    Effect.orElseSucceed(() => fallback),
  );
}

const loadConfig = Effect.gen(function* () {
  const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";

  // WALLET_PRIVATE_KEY (env / .env) takes precedence; otherwise fall back to the local
  // keystore written by `prism wallet generate|import`, so a generated wallet actually
  // enables live trading (engine/adapter-service.ts decodes this base58 key).
  const walletPrivateKey = yield* Config.string("WALLET_PRIVATE_KEY").pipe(
    Effect.orElseSucceed(() => loadKeystoreSecretKeyBase58() ?? ""),
  );
  const heliusApiKey = yield* Config.string("HELIUS_API_KEY").pipe(
    Effect.orElseSucceed(() => (isTest ? "test-helius-key" : "")),
  );
  const heliusDasDisabled = yield* Config.boolean("HELIUS_DAS_DISABLED").pipe(
    Effect.orElseSucceed(() => false),
  );
  let solanaRpcUrl = yield* Config.string("SOLANA_RPC_URL").pipe(
    Effect.orElseSucceed(() =>
      isTest ? "https://example.com" : "https://api.mainnet-beta.solana.com",
    ),
  );
  const solanaRpcFallbackUrlRaw = yield* Config.string("SOLANA_RPC_FALLBACK_URL").pipe(
    Effect.orElseSucceed(() => ""),
  );

  // If no SOLANA_RPC_URL is configured but a Helius key is present, prefer
  // Helius over the public Solana RPC for reliability.
  if (!isTest && !process.env.SOLANA_RPC_URL && heliusApiKey.length > 0) {
    solanaRpcUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;
  }

  const solanaRpcUrlNormalized = normalizeHeliusUrl(solanaRpcUrl, heliusApiKey);
  solanaRpcUrl = solanaRpcUrlNormalized.url;

  // Default the RPC fallback to the keyless public Solana RPC when the operator
  // left it empty (see resolveRpcFallbackUrl). The operator's shared Helius key
  // 429s under load, and an empty fallback meant the adapter's circuit-breaker
  // failover had nothing to route to; public mainnet-beta is keyless and only
  // used behind the fallback circuit breaker (after repeated primary failures).
  const solanaRpcFallbackUrl = normalizeHeliusUrl(
    resolveRpcFallbackUrl(solanaRpcFallbackUrlRaw, solanaRpcUrl, isTest),
    heliusApiKey,
  ).url;
  // Rate-limit pacing for Solana RPC. Keyless public endpoints
  // (api.mainnet-beta.solana.com) throttle at ~4 req/s per method, so the
  // default is conservative; paid/high-tier endpoints can lower it.
  const rpcMinIntervalMs = yield* validatedNumber("RPC_MIN_INTERVAL_MS", 0, 150, 10_000);
  const paperTrading = yield* Config.boolean("PAPER_TRADING").pipe(
    Effect.orElseSucceed(() => true),
  );
  const autonomousTokenModeRaw = yield* Config.string("AUTONOMOUS_TOKEN_MODE").pipe(
    Effect.orElseSucceed(() => AUTONOMOUS_TOKEN_CONFIG_DEFAULTS.autonomousTokenMode),
  );
  let autonomousTokenMode: AutonomousTokenMode;
  switch (autonomousTokenModeRaw) {
    case "off":
    case "shadow":
    case "canary":
    case "live":
      autonomousTokenMode = autonomousTokenModeRaw;
      break;
    default:
      return yield* Effect.die(
        new ConfigError({
          message: "AUTONOMOUS_TOKEN_MODE must be one of: off, shadow, canary, live",
          issues: [
            {
              path: "AUTONOMOUS_TOKEN_MODE",
              message: `Unknown mode: ${autonomousTokenModeRaw}`,
            },
          ],
        }),
      );
  }
  const settlementAssetRaw = yield* Config.string("SETTLEMENT_ASSET").pipe(
    Effect.orElseSucceed(() => AUTONOMOUS_TOKEN_CONFIG_DEFAULTS.settlementAsset),
  );
  if (settlementAssetRaw !== "SOL") {
    return yield* Effect.die(
      new ConfigError({
        message: "SETTLEMENT_ASSET must be SOL",
        issues: [{ path: "SETTLEMENT_ASSET", message: `Unsupported asset: ${settlementAssetRaw}` }],
      }),
    );
  }
  const settlementAsset: SettlementAsset = settlementAssetRaw;
  const candidateMinHealthyScans = Math.floor(
    yield* validatedNumber(
      "CANDIDATE_MIN_HEALTHY_SCANS",
      1,
      AUTONOMOUS_TOKEN_CONFIG_DEFAULTS.candidateMinHealthyScans,
    ),
  );
  const candidateMinObservationMs = yield* validatedNumber(
    "CANDIDATE_MIN_OBSERVATION_MS",
    0,
    AUTONOMOUS_TOKEN_CONFIG_DEFAULTS.candidateMinObservationMs,
  );
  const candidateScanLimit = Math.floor(
    yield* validatedNumber(
      "CANDIDATE_SCAN_LIMIT",
      1,
      AUTONOMOUS_TOKEN_CONFIG_DEFAULTS.candidateScanLimit,
    ),
  );
  const candidateMinPoolAgeMs = yield* validatedNumber(
    "CANDIDATE_MIN_POOL_AGE_MS",
    0,
    AUTONOMOUS_TOKEN_CONFIG_DEFAULTS.candidateMinPoolAgeMs,
  );
  const maxMarketDataAgeMs = yield* validatedNumber(
    "MAX_MARKET_DATA_AGE_MS",
    1,
    AUTONOMOUS_TOKEN_CONFIG_DEFAULTS.maxMarketDataAgeMs,
  );
  const maxSwapSlippageBpsRaw = yield* Config.string("MAX_SWAP_SLIPPAGE_BPS").pipe(
    Effect.orElseSucceed(() => ""),
  );
  if (maxSwapSlippageBpsRaw && !Number.isInteger(Number(maxSwapSlippageBpsRaw))) {
    return yield* Effect.die(
      new ConfigError({
        message: "MAX_SWAP_SLIPPAGE_BPS must be an integer",
        issues: [
          {
            path: "MAX_SWAP_SLIPPAGE_BPS",
            message: `Expected integer, got ${maxSwapSlippageBpsRaw}`,
          },
        ],
      }),
    );
  }
  const configuredMaxSwapSlippageBps = yield* validatedNumber(
    "MAX_SWAP_SLIPPAGE_BPS",
    0,
    AUTONOMOUS_TOKEN_CONFIG_DEFAULTS.maxSwapSlippageBps,
    10_000,
  );
  const maxSwapSlippageBps = Math.min(configuredMaxSwapSlippageBps, 50);
  const maxSwapPriceImpactBps = yield* validatedNumber(
    "MAX_SWAP_PRICE_IMPACT_BPS",
    0,
    AUTONOMOUS_TOKEN_CONFIG_DEFAULTS.maxSwapPriceImpactBps,
    10_000,
  );
  const settlementDustUsd = yield* validatedNumber(
    "SETTLEMENT_DUST_USD",
    0,
    AUTONOMOUS_TOKEN_CONFIG_DEFAULTS.settlementDustUsd,
  );
  const settlementMaxPendingMs = yield* validatedNumber(
    "SETTLEMENT_MAX_PENDING_MS",
    1,
    AUTONOMOUS_TOKEN_CONFIG_DEFAULTS.settlementMaxPendingMs,
  );
  const maxDailyDrawdownPct = yield* validatedNumber(
    "MAX_DAILY_DRAWDOWN_PCT",
    0,
    AUTONOMOUS_TOKEN_CONFIG_DEFAULTS.maxDailyDrawdownPct,
    100,
  );
  const maxConsecutiveExecutionFailures = Math.floor(
    yield* validatedNumber(
      "MAX_CONSECUTIVE_EXECUTION_FAILURES",
      1,
      AUTONOMOUS_TOKEN_CONFIG_DEFAULTS.maxConsecutiveExecutionFailures,
    ),
  );
  const agentInstanceIdRaw = yield* Config.string("AGENT_INSTANCE_ID").pipe(
    Effect.orElseSucceed(() => AUTONOMOUS_TOKEN_CONFIG_DEFAULTS.agentInstanceId),
  );
  const agentInstanceId = agentInstanceIdRaw.trim();
  if (agentInstanceId.length === 0) {
    return yield* Effect.die(
      new ConfigError({
        message: "AGENT_INSTANCE_ID must not be blank",
        issues: [{ path: "AGENT_INSTANCE_ID", message: "Agent instance ID is required" }],
      }),
    );
  }
  const scanIntervalMs = yield* validatedNumber("SCAN_INTERVAL_MS", 10_000, 600_000, 3_600_000);
  const minPoolTvlUsd = yield* validatedNumber("MIN_POOL_TVL_USD", 0, 50_000);
  const minFeeIlRatio = yield* validatedNumber("MIN_FEE_IL_RATIO", 0, 1.2, 10);
  const tvlDropExitPct = yield* validatedNumber("TVL_DROP_EXIT_PCT", 0, 0.3, 1);
  const volumeAuthThreshold = yield* validatedNumber("VOLUME_AUTH_THRESHOLD", 0, 0.7, 1);
  const minRebalanceIntervalMs = yield* validatedNumber(
    "MIN_REBALANCE_INTERVAL_MS",
    0,
    24 * 60 * 60 * 1000,
  );
  const minRebalanceNetBenefitUsd = yield* validatedNumber("MIN_REBALANCE_NET_BENEFIT_USD", 0, 10);
  const confidenceThreshold = yield* validatedNumber("CONFIDENCE_THRESHOLD", 0, 0.65, 1);
  const paperPortfolioUsd = yield* validatedNumber("PAPER_PORTFOLIO_USD", 1, 10_000);
  const minBinUtilization = yield* validatedNumber("MIN_BIN_UTILIZATION", 0, 0.3, 1);
  const maxRebalanceRangeBins = yield* validatedNumber("MAX_REBALANCE_RANGE_BINS", 1, 200, 200);
  const watchlistPoolsRaw = yield* Config.string("WATCHLIST_POOLS").pipe(
    Effect.orElseSucceed(() => ""),
  );
  // Default = the verified stablecoin mints (USDC, USDT, PYUSD). An explicit
  // empty value (STABLECOIN_MINTS=) is present, not absent, so it disables the
  // allowlist (empty set). Entries are pubkey-validated below, fail-closed.
  const stablecoinMintsRaw = yield* Config.string("STABLECOIN_MINTS").pipe(
    Effect.orElseSucceed(
      () =>
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v,Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB,2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
    ),
  );
  const depegAbsoluteUsd = yield* validatedNumber("DEPEG_ABSOLUTE_USD", 0.001, 0.02);
  const depegRelativePct = yield* validatedNumber("DEPEG_RELATIVE_PCT", 0.001, 0.02);
  const liquidityDrainPct = yield* validatedNumber("LIQUIDITY_DRAIN_PCT", 0.01, 0.9);
  const liquidityDrainLookbackSnapshots = yield* validatedNumber(
    "LIQUIDITY_DRAIN_LOOKBACK_SNAPSHOTS",
    1,
    12,
  );

  const freezeSmartScreening = yield* Config.boolean("FREEZE_SMART_SCREENING").pipe(
    Effect.orElseSucceed(() => false),
  );
  const ilProtectionEnabled = yield* Config.boolean("IL_PROTECTION_ENABLED").pipe(
    Effect.orElseSucceed(() => true),
  );
  const ilDominanceExitFactor = yield* validatedNumber("IL_DOMINANCE_EXIT_FACTOR", 1, 2);
  const ilDominanceMinUsd = yield* validatedNumber("IL_DOMINANCE_MIN_USD", 0, 5);
  const dustExitUsd = yield* validatedNumber("DUST_EXIT_USD", 0, 5);

  const jupiterTokenRiskEnabled = yield* Config.boolean("JUPITER_TOKEN_RISK_ENABLED").pipe(
    Effect.orElseSucceed(() => true),
  );
  const jupiterTokenRiskCacheTtlMin = yield* validatedNumber(
    "JUPITER_TOKEN_RISK_CACHE_TTL_MIN",
    1,
    30,
  );

  const goPlusApiKey = yield* Config.string("GOPLUS_API_KEY").pipe(Effect.orElseSucceed(() => ""));
  const goPlusApiSecret = yield* Config.string("GOPLUS_API_SECRET").pipe(
    Effect.orElseSucceed(() => ""),
  );
  const goPlusTokenRiskEnabled = yield* Config.boolean("GOPLUS_TOKEN_RISK_ENABLED").pipe(
    Effect.orElseSucceed(() => true),
  );
  const goPlusTokenRiskCacheTtlMin = yield* validatedNumber(
    "GOPLUS_TOKEN_RISK_CACHE_TTL_MIN",
    1,
    30,
  );

  const geckoTerminalEnabled = yield* Config.boolean("GECKO_TERMINAL_ENABLED").pipe(
    Effect.orElseSucceed(() => true),
  );

  const dexscreenerEnabled = yield* Config.boolean("DEXSCREENER_ENABLED").pipe(
    Effect.orElseSucceed(() => true),
  );

  // ─── Pyth Hermes price feeds ──────────────────────────────────────────────
  // Default OFF: Pyth's public keyless Hermes access ends 2026-08-18 (a key is
  // required after that). The service is not consumed by any decision path, so
  // opting in only when a PYTH_API_KEY is present avoids a silently-dead
  // keyless poller after the cutoff. Set PYTH_ENABLED=true (with a key) to use it.
  const pythEnabled = yield* Config.boolean("PYTH_ENABLED").pipe(Effect.orElseSucceed(() => false));
  const pythApiKey = yield* Config.string("PYTH_API_KEY").pipe(Effect.orElseSucceed(() => ""));
  const pythMaxStalenessMs = yield* validatedNumber("PYTH_MAX_STALENESS_MS", 5_000, 60_000);
  const pythBaseUrl = yield* Config.string("PYTH_BASE_URL").pipe(
    Effect.orElseSucceed(() => "https://hermes.pyth.network"),
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

  // ─── Wave 9: Volatility-adaptive range width ──────────────────────────────
  // 0 = unset → binStep-tiered baseline (25/20/15); >0 = static base that
  // adaptation scales. Bounded at use by the MAX_REBALANCE_RANGE_BINS cap.
  const entryRangeHalfWidthBins = Math.floor(
    yield* validatedNumber("ENTRY_RANGE_HALF_WIDTH_BINS", 0, 0, 200),
  );
  const volatilityAdaptiveRanges = yield* Config.boolean("VOLATILITY_ADAPTIVE_RANGES").pipe(
    Effect.orElseSucceed(() => true),
  );
  // Profitability floor for fine-binStep pools: the resolved range half-width is
  // never narrower than the bins needed to span this percent of price each side
  // (see strategy-service.ts halfWidthForPriceCoveragePct). The binStep-tier
  // baseline (25/20/15) caps fine-bin pools (SOL/USDC binStep 4) at ~±1-2%
  // price coverage, which cannot hold a 40%+ swing — the pool bleeds unbounded
  // IL (the honest backtest measured SOL/USDC at −$1158 net on a fixed 25-bin
  // range, IL ~$1157). A 5% price-coverage floor lifts those pools to a range
  // that actually holds the price path: the measured IL collapses to ~$40 and
  // the pool turns positive even under a concentration-aware fee model that
  // dilutes a wide position's active-bin fee share by refWidth÷effectiveWidth
  // (+$122 with dilution vs +$567 with the optimistic width-independent model).
  // It leaves coarse pools untouched (their 25-bin baseline already spans 5-13%),
  // is bounded by the MAX_REBALANCE_RANGE_BINS half-cap, and clamps to [0,50].
  // 0 disables the floor (pre-Wave flat bin-count behavior).
  const minRangeHalfWidthPct = yield* validatedNumber("MIN_RANGE_HALF_WIDTH_PCT", 0, 5, 50);

  // ─── F3: Fee compounding / auto-reinvest ─────────────────────────────────────
  const autoCompoundFees = yield* Config.boolean("AUTO_COMPOUND_FEES").pipe(
    Effect.orElseSucceed(() => false),
  );
  const minCompoundFeesUsd = yield* validatedNumber("MIN_COMPOUND_FEES_USD", 0, 0.5);
  const compoundGasBufferUsd = yield* validatedNumber("COMPOUND_GAS_BUFFER_USD", 0, 0.05);
  const feeDestination: FeeDestination = yield* Config.string("FEE_DESTINATION").pipe(
    Config.withDefault("compound"),
    Effect.flatMap((value) =>
      value === "compound" || value === "accumulate-quote" || value === "accumulate-sol"
        ? Effect.succeed(value)
        : Effect.fail(
            new ConfigError({
              message: `FEE_DESTINATION must be compound, accumulate-quote, or accumulate-sol; got ${value}`,
            }),
          ),
    ),
    // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
    Effect.map((value) => value as FeeDestination),
  );

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
  const maxPositionsPerPool = yield* validatedNumber("MAX_POSITIONS_PER_POOL", 1, 2);
  // Hard USD ceiling per conservative entry (the sizing formula's cap term).
  // Raisable for high-frequency rotation profiles where the default $500
  // constant would cap deployed capital per position.
  const maxEntrySizeUsd = yield* validatedNumber(
    "MAX_ENTRY_SIZE_USD",
    ENTRY_SIZE_FLOOR_USD,
    ENTRY_SIZE_CAP_USD,
  );

  // ─── Idle-capital auto-redeploy (opt-in) ─────────────────────────────────
  const idleRedeployEnabled = yield* Config.boolean("IDLE_REDEPLOY_ENABLED").pipe(
    Effect.orElseSucceed(() => false),
  );
  const idleRedeployThresholdUsd = yield* validatedNumber("IDLE_REDEPLOY_THRESHOLD_USD", 0, 500);
  const idleRedeployMaxSizeUsd = yield* validatedNumber("IDLE_REDEPLOY_MAX_SIZE_USD", 0, 2000);

  // ─── Rolling realized-PnL loss halt ─────────────────────────────────────────
  const realizedPnLHaltEnabled = yield* Config.boolean("REALIZED_PNL_HALT_ENABLED").pipe(
    Effect.orElseSucceed(() => false),
  );
  const realizedPnLHaltWindow = yield* validatedNumber("REALIZED_PNL_HALT_WINDOW", 1, 100);
  const realizedPnLHaltThresholdUsd = yield* validatedNumber(
    "REALIZED_PNL_HALT_THRESHOLD_USD",
    -Number.MAX_SAFE_INTEGER,
    -20,
  );

  // ─── Pool-local realized-PnL kill switch ─────────────────────────────────
  const poolPnlKillSwitchEnabled = yield* Config.boolean("POOL_PNL_KILL_SWITCH_ENABLED").pipe(
    Effect.orElseSucceed(() => false),
  );
  const poolPnlKillSwitchMinClosedPositions = yield* validatedNumber(
    "POOL_PNL_KILL_SWITCH_MIN_CLOSED_POSITIONS",
    1,
    10,
  );
  const poolPnlKillSwitchThresholdUsd = yield* validatedNumber(
    "POOL_PNL_KILL_SWITCH_THRESHOLD_USD",
    -Number.MAX_SAFE_INTEGER,
    -15,
    0,
  );
  const poolPnlKillSwitchCooldownMs = yield* validatedNumber(
    "POOL_PNL_KILL_SWITCH_COOLDOWN_MS",
    1,
    48 * 60 * 60 * 1000,
    30 * 24 * 60 * 60 * 1000,
  );

  // ─── F6: Paper-trading validation period ────────────────────────────────────
  const paperValidationMinDays = yield* validatedNumber("PAPER_VALIDATION_MIN_DAYS", 0, 7);
  const paperValidationEnforce = yield* Config.boolean("PAPER_VALIDATION_ENFORCE").pipe(
    Effect.orElseSucceed(() => false),
  );

  // ─── F7: Pool cooldown after failed exits ───────────────────────────────────
  const oorCooldownMs = yield* validatedNumber("OOR_COOLDOWN_MS", 0, 4 * 60 * 60 * 1000);
  const repeatOorCooldownMs = yield* validatedNumber(
    "REPEAT_OOR_COOLDOWN_MS",
    0,
    12 * 60 * 60 * 1000,
  );
  const maxOorCooldownExits = yield* validatedNumber("MAX_OOR_COOLDOWN_EXITS", 1, 3);

  // Same-pool re-entry churn throttle — arms a cooldown on every exit.
  const minReentryCooldownMs = yield* validatedNumber(
    "MIN_REENTRY_COOLDOWN_MS",
    0,
    2 * 60 * 60 * 1000,
  );

  // ─── Fee-density-driven low-yield exit cooldowns ────────────────────────────
  const feeDensityCooldowns = yield* Config.boolean("FEE_DENSITY_COOLDOWNS").pipe(
    Effect.orElseSucceed(() => true),
  );
  const DEFAULT_FEE_DENSITY_COOLDOWN_MIN_MS = 60 * 60 * 1000;
  const feeDensityCooldownMinMsRaw = yield* validatedNumber(
    "FEE_DENSITY_COOLDOWN_MIN_MS",
    0,
    DEFAULT_FEE_DENSITY_COOLDOWN_MIN_MS,
  );
  // The floor must sit strictly below the static duration. An inverted
  // relationship (min >= static) would swap the settings' meanings —
  // high-density exits getting the static duration and thin pools the larger
  // "minimum" — so clamp the floor just under the static value (same warn
  // channel as validatedNumber / the band guard below). OOR_COOLDOWN_MS
  // itself is left untouched; when the static duration is 0 the floor is
  // pinned at 0 (cooldown.ts's guard then returns the static duration for
  // every density in that degenerate case).
  const feeDensityCooldownMinMsInverted = feeDensityCooldownMinMsRaw >= oorCooldownMs;
  if (feeDensityCooldownMinMsInverted) {
    logger.warn(
      "FEE_DENSITY_COOLDOWN_MIN_MS must be below OOR_COOLDOWN_MS; clamping the floor just under the static value",
      {
        feeDensityCooldownMinMs: feeDensityCooldownMinMsRaw,
        oorCooldownMs,
        fallback: Math.min(feeDensityCooldownMinMsRaw, Math.max(oorCooldownMs - 1, 0)),
      },
    );
  }
  const feeDensityCooldownMinMs = feeDensityCooldownMinMsInverted
    ? Math.min(feeDensityCooldownMinMsRaw, Math.max(oorCooldownMs - 1, 0))
    : feeDensityCooldownMinMsRaw;
  const DEFAULT_FEE_DENSITY_HIGH_PCT = 0.005;
  const DEFAULT_FEE_DENSITY_LOW_PCT = 0.0005;
  const feeDensityHighPctRaw = yield* validatedNumber(
    "FEE_DENSITY_HIGH_PCT",
    0,
    DEFAULT_FEE_DENSITY_HIGH_PCT,
  );
  const feeDensityLowPctRaw = yield* validatedNumber(
    "FEE_DENSITY_LOW_PCT",
    0,
    DEFAULT_FEE_DENSITY_LOW_PCT,
  );
  // An inverted (or collapsed) band breaks the interpolation; fall back to
  // defaults for BOTH so the pair stays sane (same warn channel as
  // validatedNumber). This also catches high == 0, since low >= 0.
  const feeDensityBandInverted = feeDensityLowPctRaw >= feeDensityHighPctRaw;
  if (feeDensityBandInverted) {
    logger.warn("FEE_DENSITY_LOW_PCT must be below FEE_DENSITY_HIGH_PCT; using defaults for both", {
      feeDensityHighPct: feeDensityHighPctRaw,
      feeDensityLowPct: feeDensityLowPctRaw,
      fallback: {
        feeDensityHighPct: DEFAULT_FEE_DENSITY_HIGH_PCT,
        feeDensityLowPct: DEFAULT_FEE_DENSITY_LOW_PCT,
      },
    });
  }
  const feeDensityHighPct = feeDensityBandInverted
    ? DEFAULT_FEE_DENSITY_HIGH_PCT
    : feeDensityHighPctRaw;
  const feeDensityLowPct = feeDensityBandInverted
    ? DEFAULT_FEE_DENSITY_LOW_PCT
    : feeDensityLowPctRaw;

  // ─── Agentic mode / agent runtime overlay ────────────────────────────
  const agentiveMode = yield* Config.boolean("AGENTIC_MODE").pipe(
    Effect.orElseSucceed(() => false),
  );
  const agentRuntimeRaw = yield* Config.string("AGENT_RUNTIME").pipe(
    Effect.orElseSucceed(() => "auto"),
  );
  const validAgentRuntimes = ["auto", "hermes", "openclaw", "none"] as const;
  // SAFETY: The enclosing statement has validated or constructed the asserted contract before this value is consumed.
  const agentRuntime = validAgentRuntimes.includes(
    // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
    agentRuntimeRaw as (typeof validAgentRuntimes)[number],
  )
    ? // SAFETY: The runtime guard or typed fixture immediately above this assertion establishes the required invariant.
      // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
      (agentRuntimeRaw as (typeof validAgentRuntimes)[number])
    : "auto";
  const agentAcpCommand = yield* Config.string("AGENT_ACP_COMMAND").pipe(
    Effect.orElseSucceed(() => "hermes"),
  );
  const agentAcpArgsRaw = yield* Config.string("AGENT_ACP_ARGS").pipe(
    Effect.orElseSucceed(() => "acp"),
  );
  const agentAcpArgs = agentAcpArgsRaw
    .split(" ")
    .map((s) => s.trim())
    .filter(Boolean);
  const agentGatewayUrl = yield* Config.string("AGENT_GATEWAY_URL").pipe(
    Effect.orElseSucceed(() => "ws://127.0.0.1:18789"),
  );
  const agentGatewayToken = yield* Config.string("AGENT_GATEWAY_TOKEN").pipe(
    Effect.orElseSucceed(() => ""),
  );
  const agentPromptTimeoutMs = yield* validatedNumber(
    "AGENT_PROMPT_TIMEOUT_MS",
    1_000,
    60_000,
    300_000,
  );
  // Veto runs inline in the per-pool scan loop, so it gets its own latency budget.
  // Defaults to AGENT_PROMPT_TIMEOUT_MS when unset; clamped to the same [1s, 5min]
  // band so an absurd value cannot stall scan cycles.
  const agentVetoTimeoutMs = yield* validatedNumber(
    "AGENT_VETO_TIMEOUT_MS",
    1_000,
    agentPromptTimeoutMs,
    300_000,
  );
  const agentCheckinIntervalMs = yield* validatedNumber(
    "AGENT_CHECKIN_INTERVAL_MS",
    0,
    60 * 60 * 1000,
  );
  const agentCheckinOnEvents = yield* Config.boolean("AGENT_CHECKIN_ON_EVENTS").pipe(
    Effect.orElseSucceed(() => true),
  );
  const agentCheckinIncludeHistory = yield* Config.boolean("AGENT_CHECKIN_INCLUDE_HISTORY").pipe(
    Effect.orElseSucceed(() => true),
  );
  const agentCheckinMaxPositions = yield* validatedNumber("AGENT_CHECKIN_MAX_POSITIONS", 0, 10);
  const agentOpenclawWebhookUrl = yield* Config.string("AGENT_OPENCLAW_WEBHOOK_URL").pipe(
    Effect.orElseSucceed(() => ""),
  );
  const agentOpenclawWebhookToken = yield* Config.string("AGENT_OPENCLAW_WEBHOOK_TOKEN").pipe(
    Effect.orElseSucceed(() => ""),
  );
  const agentHermesApiUrl = yield* Config.string("AGENT_HERMES_API_URL").pipe(
    Effect.orElseSucceed(() => ""),
  );
  const agentHermesApiToken = yield* Config.string("AGENT_HERMES_API_TOKEN").pipe(
    Effect.orElseSucceed(() => ""),
  );
  const agentHttpPort = yield* validatedNumber("AGENT_HTTP_PORT", 0, 0, 65_535);
  const agentMcpEnabled = yield* Config.boolean("AGENT_MCP_ENABLED").pipe(
    Effect.orElseSucceed(() => false),
  );

  // ─── Agent Proposals ───────────────────────────────────────────────────────
  const agentProposalModeRaw = yield* Config.string("AGENT_PROPOSAL_MODE").pipe(
    Effect.orElseSucceed(() => "veto"),
  );
  const validAgentProposalModes = ["veto", "suggest", "supervised", "full"] as const;
  // SAFETY: The enclosing statement has validated or constructed the asserted contract before this value is consumed.
  const agentProposalMode = validAgentProposalModes.includes(
    // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
    agentProposalModeRaw as (typeof validAgentProposalModes)[number],
  )
    ? // SAFETY: The runtime guard or typed fixture immediately above this assertion establishes the required invariant.
      // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
      (agentProposalModeRaw as (typeof validAgentProposalModes)[number])
    : "veto";
  const agentProposalToken = yield* Config.string("AGENT_PROPOSAL_TOKEN").pipe(
    Effect.orElseSucceed(() => ""),
  );
  const agentApprovalToken = yield* Config.string("AGENT_APPROVAL_TOKEN").pipe(
    Effect.orElseSucceed(() => ""),
  );
  const agentProposalTimeoutMs = yield* validatedNumber(
    "AGENT_PROPOSAL_TIMEOUT_MS",
    1_000,
    15_000,
    60_000,
  );
  const agentProposalMaxBatchSize = yield* validatedNumber(
    "AGENT_PROPOSAL_MAX_BATCH_SIZE",
    1,
    10,
    100,
  );
  const agentProposalMaxQueueSize = yield* validatedNumber(
    "AGENT_PROPOSAL_MAX_QUEUE_SIZE",
    1,
    50,
    1000,
  );
  const agentProposalStaleMs = yield* validatedNumber(
    "AGENT_PROPOSAL_STALE_MS",
    10_000,
    300_000,
    1_800_000,
  );
  const agentProposalBackoffBaseMs = yield* validatedNumber(
    "AGENT_PROPOSAL_BACKOFF_BASE_MS",
    1_000,
    60_000,
    3_600_000,
  );
  const agentProposalBackoffMaxMs = Math.max(
    yield* validatedNumber("AGENT_PROPOSAL_BACKOFF_MAX_MS", 60_000, 3_600_000, 3_600_000),
    agentProposalBackoffBaseMs,
  );
  const agentProposalMaxPositionSizePct = yield* validatedNumber(
    "AGENT_PROPOSAL_MAX_POSITION_SIZE_PCT",
    0,
    0.4,
    1.0,
  );
  const agentProposalMinConfidence = yield* validatedNumber(
    "AGENT_PROPOSAL_MIN_CONFIDENCE",
    0,
    0.65,
    1.0,
  );
  const agentProposalCircuitBreakerThreshold = yield* validatedNumber(
    "AGENT_PROPOSAL_CIRCUIT_BREAKER_THRESHOLD",
    1,
    5,
    20,
  );
  const agentProposalCircuitBreakerCooldownMs = yield* validatedNumber(
    "AGENT_PROPOSAL_CIRCUIT_BREAKER_COOLDOWN_MS",
    60_000,
    300_000,
    1_800_000,
  );

  // ─── Threshold evolution ─────────────────────────────────────────────
  const evolutionInterval = yield* validatedNumber("EVOLUTION_INTERVAL", 1, 5, 100);
  const evolutionMaxChangePct = yield* validatedNumber("EVOLUTION_MAX_CHANGE_PCT", 0.01, 0.2, 1.0);

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
  const autoSwapEntry = yield* Config.boolean("AUTO_SWAP_ENTRY").pipe(
    Effect.orElseSucceed(() => false),
  );
  const entryStrategyTypeRaw = yield* Config.string("ENTRY_STRATEGY_TYPE").pipe(
    Effect.orElseSucceed(() => "spot"),
  );
  const validEntryStrategyTypes = ["spot", "curve", "bidask", "auto"] as const;
  // SAFETY: The enclosing statement has validated or constructed the asserted contract before this value is consumed.
  const entryStrategyType: EntryStrategyType = validEntryStrategyTypes.includes(
    // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
    entryStrategyTypeRaw as (typeof validEntryStrategyTypes)[number],
  )
    ? // SAFETY: The runtime guard or typed fixture immediately above this assertion establishes the required invariant.
      // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
      (entryStrategyTypeRaw as (typeof validEntryStrategyTypes)[number])
    : "spot";

  // ─── Proactive Telegram alerts (Wave 5) ───────────────────────────────────
  const alertsEnabled = yield* Config.boolean("ALERTS_ENABLED").pipe(
    Effect.orElseSucceed(() => true),
  );
  // ─── LM farm reward claims (Wave 8) ───────────────────────────────────────
  const farmRewardsEnabled = yield* Config.boolean("FARM_REWARDS_ENABLED").pipe(
    Effect.orElseSucceed(() => true),
  );
  const limitOrdersEnabled = yield* Config.boolean("LIMIT_ORDERS_ENABLED").pipe(
    Effect.orElseSucceed(() => false),
  );
  const limitOrderModeRaw = yield* Config.string("LIMIT_ORDER_MODE").pipe(
    Effect.orElseSucceed(() => "take-profit"),
  );
  const limitOrderMode = limitOrderModeRaw === "dca" ? "dca" : "take-profit";
  const limitOrderTargetBinOffset = yield* validatedNumber("LIMIT_ORDER_TARGET_BIN_OFFSET", 1, 20);
  const limitOrderMaxActiveBinSlippage = yield* validatedNumber(
    "LIMIT_ORDER_MAX_ACTIVE_BIN_SLIPPAGE",
    0,
    3,
  );
  const copySignalsEnabled = yield* Config.boolean("COPY_SIGNALS_ENABLED").pipe(
    Effect.orElseSucceed(() => false),
  );
  const copySignalsEndpoint = yield* Config.string("COPY_SIGNALS_ENDPOINT").pipe(
    Effect.orElseSucceed(() => ""),
  );
  const copySignalWalletsRaw = yield* Config.string("COPY_SIGNAL_WALLETS").pipe(
    Effect.orElseSucceed(() => ""),
  );
  const copySignalWallets = copySignalWalletsRaw
    .split(",")
    .map((wallet) => wallet.trim())
    .filter(Boolean);
  const copySignalsStaleMs = yield* validatedNumber(
    "COPY_SIGNALS_STALE_MS",
    60_000,
    900_000,
    86_400_000,
  );
  const copySignalsMaxBoost = yield* validatedNumber("COPY_SIGNALS_MAX_BOOST", 0, 0.05, 0.05);
  const alertCooldownMinutes = yield* validatedNumber("ALERT_COOLDOWN_MINUTES", 1, 120);
  const alertFeeMilestoneUsd = yield* validatedNumber("ALERT_FEE_MILESTONE_USD", 0.01, 10);

  // ─── Fallen-angel mode (Wave 19) ───────────────────────────────────────────
  const fallenAngelEnabled = yield* Config.boolean("FALLEN_ANGEL_ENABLED").pipe(
    Effect.orElseSucceed(() => false),
  );
  const fallenAngelMinTvlUsd = yield* validatedNumber("FALLEN_ANGEL_MIN_TVL_USD", 0, 50_000);
  const fallenAngelMinDrawdownPct = yield* validatedNumber(
    "FALLEN_ANGEL_MIN_DRAWDOWN_PCT",
    0,
    0.6,
    1,
  );
  const fallenAngelMaxDrawdownPct = yield* validatedNumber(
    "FALLEN_ANGEL_MAX_DRAWDOWN_PCT",
    0,
    0.95,
    1,
  );
  const fallenAngelVolBaselineMin = yield* validatedNumber(
    "FALLEN_ANGEL_VOL_BASELINE_MIN",
    0,
    0.02,
  );
  const fallenAngelVolBaselineMax = yield* validatedNumber(
    "FALLEN_ANGEL_VOL_BASELINE_MAX",
    0,
    0.35,
  );
  const fallenAngelMaxRugcheckScore = yield* validatedNumber(
    "FALLEN_ANGEL_MAX_RUGCHECK_SCORE",
    0,
    60,
    100,
  );
  const fallenAngelMinHolders = yield* validatedNumber("FALLEN_ANGEL_MIN_HOLDERS", 1, 300);
  const fallenAngelMaxTop10HolderPct = yield* validatedNumber(
    "FALLEN_ANGEL_MAX_TOP10_HOLDER_PCT",
    0,
    0.5,
    1,
  );
  const parsePctList = (raw: string): ReadonlyArray<number> =>
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(Number)
      .filter((n) => Number.isFinite(n));
  const fallenAngelTpRungs = parsePctList(
    yield* Config.string("FALLEN_ANGEL_TP_RUNGS").pipe(
      Effect.orElseSucceed(() => "0.15,0.30,0.50"),
    ),
  );
  const fallenAngelTpFractions = parsePctList(
    yield* Config.string("FALLEN_ANGEL_TP_FRACTIONS").pipe(
      Effect.orElseSucceed(() => "0.4,0.3,0.3"),
    ),
  );
  const fallenAngelInvalidationStopPct = yield* validatedNumber(
    "FALLEN_ANGEL_INVALIDATION_STOP_PCT",
    0,
    0.25,
    1,
  );
  const fallenAngelMaxPositions = yield* validatedNumber("FALLEN_ANGEL_MAX_POSITIONS", 1, 2);

  // New feature configs
  const stopLossPct = yield* validatedNumber("STOP_LOSS_PCT", 0, 0.15);
  const trailingStopPct = yield* validatedNumber("TRAILING_STOP_PCT", 0, 0.1);
  const trailingStopConfirmCycles = yield* validatedNumber(
    "TRAILING_STOP_CONFIRM_CYCLES",
    1,
    2,
    10,
  );
  const oorGracePeriodCycles = yield* validatedNumber("OOR_GRACE_PERIOD_CYCLES", 0, 3);
  const feeClaimIntervalMs = yield* validatedNumber(
    "FEE_CLAIM_INTERVAL_MS",
    0,
    24 * 60 * 60 * 1000,
  );
  const enablePoolDiscovery = yield* Config.boolean("ENABLE_POOL_DISCOVERY").pipe(
    Effect.orElseSucceed(() => false),
  );
  const discoveryMinTvlUsd = yield* validatedNumber("DISCOVERY_MIN_TVL_USD", 0, 1_000_000);
  const discoveryMinFeeRatio = yield* validatedNumber("DISCOVERY_MIN_FEE_RATIO", 0, 1.5);
  const marketScanEnabled = yield* Config.boolean("MARKET_SCAN_ENABLED").pipe(
    Effect.orElseSucceed(() => false),
  );
  const marketScanRefreshIntervalMs = yield* validatedNumber(
    "MARKET_SCAN_REFRESH_INTERVAL_MS",
    60_000,
    30 * 60_000,
  );
  const marketScanUniversePages = yield* validatedNumber("MARKET_SCAN_UNIVERSE_PAGES", 1, 3, 10);
  const marketScanUniverseSortRaw = yield* Config.string("MARKET_SCAN_UNIVERSE_SORT").pipe(
    Effect.orElseSucceed(() => "tvl"),
  );
  const marketScanUniverseSort: "tvl" | "fee" = marketScanUniverseSortRaw === "fee" ? "fee" : "tvl";
  const marketScanMinTvlUsd = yield* validatedNumber("MARKET_SCAN_MIN_TVL_USD", 0, 50_000);
  const marketScanMinFeeApr = yield* validatedNumber("MARKET_SCAN_MIN_FEE_APR", 0, 100);
  // Market-runner lane: when enabled, market-scan pools whose fee APR clears
  // the runner floor enter with the LAUNCH posture (time-boxed, dip-anchored,
  // 0.25 drawdown, scale-in) instead of the flat normal posture — the engine
  // holds HIGH-YIELD pools rather than flat majors. Rotation exits the lowest-
  // APR held position when the portfolio is full and a much hotter runner is
  // available. OFF by default; paper-first.
  const marketScanRunnerEnabled = yield* Config.boolean("MARKET_SCAN_RUNNER_ENABLED").pipe(
    Effect.orElseSucceed(() => false),
  );
  const marketScanRunnerMinFeeApr = yield* validatedNumber(
    "MARKET_SCAN_RUNNER_MIN_FEE_APR",
    0,
    500,
  );
  // Runner drift floor: a runner whose net active-bin drift sits below this
  // floor is a sustained decliner, not a dip — the runner lane's dip-ladder
  // premise is buying the shakeout WITHIN a healthy rising pool, not buying a
  // pool already bleeding for hours. Mirrors the normal-lane drift gate's
  // default. Clamped at 0 so it can never reject on a positive floor.
  const marketScanRunnerMinDriftBins = yield* validatedNumber(
    "MARKET_SCAN_RUNNER_MIN_DRIFT_BINS",
    -100,
    -8,
    0,
  );
  const marketScanRotationEnabled = yield* Config.boolean("MARKET_SCAN_ROTATION_ENABLED").pipe(
    Effect.orElseSucceed(() => false),
  );
  const marketScanRotationAprMult = yield* validatedNumber("MARKET_SCAN_ROTATION_APR_MULT", 1, 5);
  // Runner admission + rotation superiority must persist across this many
  // consecutive above-floor APR observations (rule: no single-cycle spikes).
  const marketScanRunnerConfirmCycles = yield* validatedNumber(
    "MARKET_SCAN_RUNNER_CONFIRM_CYCLES",
    1,
    2,
  );
  // TTL for the rotation arm: the incumbent EXIT executes only while the
  // runner's admission is still fresh (cancel-and-preserve semantics).
  const marketScanRotationArmMs = yield* validatedNumber(
    "MARKET_SCAN_ROTATION_ARM_MS",
    60_000,
    1_800_000,
  );
  // G7: deterministic EXIT when a tracked position's measured fee APR drops
  // below its entry-time APR × this fraction (self-healing flat majors).
  const yieldRegressionExitPct = yield* validatedNumber("YIELD_REGRESSION_EXIT_PCT", 0, 0.5);
  // G3 net-fee capture model: conversion + harvest costs subtracted from
  // expected fees before the runner comparison votes.
  const feeCaptureConversionCostPct = yield* validatedNumber(
    "FEE_CAPTURE_CONVERSION_COST_PCT",
    0,
    0.05,
  );
  const feeCaptureHarvestCostUsd = yield* validatedNumber("FEE_CAPTURE_HARVEST_COST_USD", 0, 0.01);
  // Cost-aware runner gate: per-swap cost + a net-daily-yield floor the runner
  // must clear AFTER churn/IL/swap costs. The floor is the "no bleeds" rule —
  // a runner that cannot clear it is never entered, or is exited early.
  const runnerSwapCostPct = yield* validatedNumber("RUNNER_SWAP_COST_PCT", 0, 0.005, 0.1);
  const runnerNetFloorPct = yield* validatedNumber("RUNNER_NET_FLOOR_PCT", 0, 1, 100);
  // ── Regime gate (ORCA-inspired, paper-first, advisory-only) ────────────
  // Herding damper: block NEW ENTERs while scanned pools move in lockstep
  // (systemic stress — the window where rugs cluster). Fail-open: unknown
  // correlation state never blocks; exits are never affected.
  const regimeHerdingGateEnabled = yield* Config.boolean("REGIME_HERDING_GATE_ENABLED").pipe(
    Effect.orElseSucceed(() => false),
  );
  const regimeHerdingEdgeThreshold = yield* validatedNumber(
    "REGIME_HERDING_EDGE_THRESHOLD",
    0.5,
    0.8,
    1,
  );
  const regimeHerdingCorrThreshold = yield* validatedNumber(
    "REGIME_HERDING_CORR_THRESHOLD",
    0.3,
    0.6,
    1,
  );
  // Euphoria damper (runner lane): reject a runner whose current measured APR
  // is a vertical spike vs its OWN recent history (top-percentile self-rank).
  // Durable high APR is flat-high and passes; blow-off tops fail.
  const runnerAprOutlierEnabled = yield* Config.boolean("RUNNER_APR_OUTLIER_ENABLED").pipe(
    Effect.orElseSucceed(() => false),
  );
  const runnerAprOutlierPercentile = yield* validatedNumber(
    "RUNNER_APR_OUTLIER_PERCENTILE",
    0.5,
    0.98,
    0.999,
  );

  // ── Flash volume trigger (hot-window lane, paper-first) ────────────────
  // Fees lag volume: a measured burst against a pool's OWN trailing snapshot
  // baseline is the EARLY entry signal while the 1h fee ratio still lags its
  // floor. Signal source is the pool_snapshots history we already persist —
  // zero new API load. Measured stats only; default OFF.
  const flashVolumeTriggerEnabled = yield* Config.boolean("FLASH_VOLUME_TRIGGER_ENABLED").pipe(
    Effect.orElseSucceed(() => false),
  );
  const flashMinSpikeRatio = yield* validatedNumber("FLASH_MIN_SPIKE_RATIO", 1, 1.2, 20);
  const flashBaselineWindow = yield* validatedNumber("FLASH_BASELINE_WINDOW", 3, 8, 24);
  const flashMinVolumeUsd = yield* validatedNumber("FLASH_MIN_VOLUME_USD", 0, 10_000, 10_000_000);

  // ── Churn circuit breaker + hold bias (2026-08-22 audit) ───────────────
  // All-time losses concentrated in two churned pools (−$163/221 trades and
  // −$64.76/125 trades) while a passive replay of the same pool nets +$17:
  // trade COUNT is the damage mechanism. Cap same-pool re-entries per UTC
  // day BEFORE the bleed accumulates, and let in-range positions keep
  // collecting fees instead of being recycled by fee-trend exits.
  const churnMaxEntriesPerPoolPerDay = yield* validatedNumber(
    "CHURN_MAX_ENTRIES_PER_POOL_PER_DAY",
    0,
    4,
    100,
  );
  const holdBiasEnabled = yield* Config.boolean("HOLD_BIAS_ENABLED").pipe(
    Effect.orElseSucceed(() => false),
  );
  // Volume+fees focus: absolute activity floors keep the scan universe on
  // pools with real fee dollars and real volume (honeypot counter-signal).
  const marketScanMinFees24hUsd = yield* validatedNumber(
    "MARKET_SCAN_MIN_FEES_24H_USD",
    0,
    0,
    1_000_000,
  );
  const marketScanMinVolume24hUsd = yield* validatedNumber(
    "MARKET_SCAN_MIN_VOLUME_24H_USD",
    0,
    0,
    100_000_000,
  );

  // G4 economic harvest gate: claim only when net proceeds clear the floor
  // and estimated tx cost stays under the fraction of gross fees.
  const harvestMinNetUsd = yield* validatedNumber("HARVEST_MIN_NET_USD", 0, 1);
  const harvestMaxCostPct = yield* validatedNumber("HARVEST_MAX_COST_PCT", 0, 0.15);
  const harvestTxCostUsdEst = yield* validatedNumber("HARVEST_TX_COST_USD_EST", 0, 0.005);
  // G5 transfer-tax screen: reject legs with an enabled Token-2022
  // transfer-fee extension unless explicitly allowed.
  const allowTransferFeeTokens = yield* Config.boolean("ALLOW_TRANSFER_FEE_TOKENS").pipe(
    Effect.orElseSucceed(() => false),
  );
  // G6 token-level failure breaker: a failed EXIT on a token blocks new
  // entries into any pool holding that token for this window.
  const tokenFailureBlockMs = yield* validatedNumber("TOKEN_FAILURE_BLOCK_MS", 60_000, 3_600_000);
  // Rug detection: a position closed at a catastrophic realized loss marks a
  // rug/drained token — block re-entry into its non-stable legs (the base
  // leg is never blocked) for a longer window than the failure breaker.
  const rugExitLossPct = yield* validatedNumber("RUG_EXIT_LOSS_PCT", 0.05, 0.5, 1);
  const rugTokenBlockMs = yield* validatedNumber(
    "RUG_TOKEN_BLOCK_MS",
    3_600_000,
    604_800_000,
    2_592_000_000,
  );
  // ── TA / filter-quality (forensics-driven, paper-first) ────────────────
  // A: economic EXITs (fee/IL < 0.5, yield-regression, volume-auth) must NOT
  // fire before fees can accrue — the 33-min median paper hold was the top
  // winrate drag (locked in temporary IL that reversed, armed cooldowns that
  // starved ENTERS). Capital-protection exits (trailing stop, TVL drop, W15,
  // IL dominance, dust) stay age-free.
  const minYieldExitAgeMs = yield* validatedNumber("MIN_YIELD_EXIT_AGE_MS", 0, 14_400_000);
  // B: momentum/timing ENTER gate + confidence boost — the throughput fix.
  // ENTER rejected when the recent active-bin drift is strongly negative
  // (cascading price); positive drift boosts the confidence so a feeIl ~2
  // pool with real upward momentum crosses the 0.65 floor without lowering
  // the threshold for static pools.
  const marketScanMaxNegativeDriftBins = yield* validatedNumber(
    "MARKET_SCAN_MAX_NEGATIVE_DRIFT_BINS",
    -100,
    -8,
    0, // clamp at 0: a positive floor would reject every normal ENTER (drift < +N)
  );
  const entryMomentumConfBoost = yield* validatedNumber("ENTRY_MOMENTUM_CONF_BOOST", 0, 0.05);
  const entryMomentumReferenceBins = yield* validatedNumber("ENTRY_MOMENTUM_REFERENCE_BINS", 1, 20);
  const entryMomentumScoreWeight = yield* validatedNumber("ENTRY_MOMENTUM_SCORE_WEIGHT", 0, 0.15);
  // C: take-profit for normal positions (winrate — lock profits instead of
  // waiting for a loss-side exit). Single-rung full exit at the target.
  const takeProfitEnabled = yield* Config.boolean("TAKE_PROFIT_ENABLED").pipe(
    Effect.orElseSucceed(() => false),
  );
  const takeProfitPct = yield* validatedNumber("TAKE_PROFIT_PCT", 0.01, 0.15); // 0 would build an at-entry rung -> instant zero-profit EXIT
  // D: backtest replay fidelity — empty-bin snapshots must not reject every
  // tick (paper DB stores bins:[] so the replay admitted nothing).
  const backtestTolerateEmptyBins = yield* Config.boolean("BACKTEST_TOLERATE_EMPTY_BINS").pipe(
    Effect.orElseSucceed(() => true),
  );
  const marketScanTopK = yield* validatedNumber("MARKET_SCAN_TOP_K", 1, 30, 200);
  const marketScanMaxPools = yield* validatedNumber("MARKET_SCAN_MAX_POOLS", 1, 60, 500);
  const marketScanMinHolders = yield* validatedNumber("MARKET_SCAN_MIN_HOLDERS", 0, 1000);
  const marketScanRequireRenouncedMint = yield* Config.boolean(
    "MARKET_SCAN_REQUIRE_RENOUNCED_MINT",
  ).pipe(Effect.orElseSucceed(() => true));
  const marketScanMinPoolAgeHours = yield* validatedNumber(
    "MARKET_SCAN_MIN_POOL_AGE_HOURS",
    0,
    24,
    24 * 30,
  );
  const marketScanMinBinStep = yield* validatedNumber("MARKET_SCAN_MIN_BIN_STEP", 0, 2, 100);
  const marketScanMaxBinStep = yield* validatedNumber("MARKET_SCAN_MAX_BIN_STEP", 1, 200, 2000);
  const launchScanEnabled = yield* Config.boolean("LAUNCH_SCAN_ENABLED").pipe(
    Effect.orElseSucceed(() => false),
  );
  const launchScanRefreshIntervalMs = yield* validatedNumber(
    "LAUNCH_SCAN_REFRESH_INTERVAL_MS",
    10_000,
    120_000,
  );
  const launchScanTopK = yield* validatedNumber("LAUNCH_SCAN_TOP_K", 1, 30, 200);
  const launchScanUniverseSize = yield* validatedNumber("LAUNCH_SCAN_UNIVERSE_SIZE", 1, 500, 1000);
  const launchScanMinTvlUsd = yield* validatedNumber("LAUNCH_SCAN_MIN_TVL_USD", 0, 5_000);
  const launchScanMaxTvlUsd = yield* validatedNumber("LAUNCH_SCAN_MAX_TVL_USD", 0, 1_000_000);
  const launchScanMaxAgeHours = yield* validatedNumber("LAUNCH_SCAN_MAX_AGE_HOURS", 1, 6, 72);
  const launchScanMinVolume1hUsd = yield* validatedNumber(
    "LAUNCH_SCAN_MIN_VOLUME_1H_USD",
    0,
    50_000,
  );
  const launchScanMinBaseFeePct = yield* validatedNumber("LAUNCH_SCAN_MIN_BASE_FEE_PCT", 0, 1);
  const launchScanMinBinStep = yield* validatedNumber("LAUNCH_SCAN_MIN_BIN_STEP", 0, 50);
  const launchScanMaxBinStep = yield* validatedNumber("LAUNCH_SCAN_MAX_BIN_STEP", 1, 200);

  // ─── Launch Mode v2: execution lane ───────────────────────────────────────
  // Launch EXECUTION is opt-in on top of the launch radar; both switches must
  // be on for the lane to exist (Slice B wiring).
  const launchExecutionEnabled = yield* Config.boolean("LAUNCH_EXECUTION_ENABLED").pipe(
    Effect.orElseSucceed(() => false),
  );
  const launchMaxOpenPositions = yield* validatedNumber("LAUNCH_MAX_OPEN_POSITIONS", 1, 3, 30);
  const launchPositionMaxSizeUsd = yield* validatedNumber("LAUNCH_POSITION_MAX_SIZE_USD", 10, 100);
  const launchTimeboxHours = yield* validatedNumber("LAUNCH_TIMEBOX_HOURS", 1, 6, 72);
  const launchVolumeDecayExitPct = yield* validatedNumber(
    "LAUNCH_VOLUME_DECAY_EXIT_PCT",
    0,
    0.1,
    1,
  );
  const launchExitDrawdownPct = yield* validatedNumber("LAUNCH_EXIT_DRAWDOWN_PCT", 0, 0.25, 1);
  // Runner mode (Heart Attack): dip-anchored launch entries + shakeout-
  // tolerant stops. OFF by default — the conservative launch lane is
  // unchanged. When on, launch entries anchor their range DIP_PCT below the
  // active bin (a below-market bid ladder that fills on shakeouts instead of
  // getting stopped by them) with a tight HALF_WIDTH band, and launch exits
  // use the wider runner DRAWDOWN (shakeout tolerance) instead of the crash
  // calibration. The timebox and volume-decay exits are unchanged.
  const launchRunnerModeEnabled = yield* Config.boolean("LAUNCH_RUNNER_MODE_ENABLED").pipe(
    Effect.orElseSucceed(() => false),
  );
  const launchRunnerDipPct = yield* validatedNumber("LAUNCH_RUNNER_DIP_PCT", 0, 0.12, 0.5);
  const launchRunnerDrawdownPct = yield* validatedNumber(
    "LAUNCH_RUNNER_DRAWDOWN_PCT",
    0.05,
    0.25,
    0.5,
  );
  const launchRunnerHalfWidthBins = Math.floor(
    yield* validatedNumber("LAUNCH_RUNNER_HALF_WIDTH_BINS", 1, 5, 100),
  );
  // Runner scale-in (Heart Attack step 2): when the price falls a full step
  // below the band's anchor, re-anchor the band at dip% below the NEW price
  // and top up the position with fresh quote capital (atomic rebalance
  // redeposits the mixed basket + top-up). Persisted per position
  // (launch_runner_steps / launch_runner_anchor_price), restart-safe.
  const launchRunnerScaleInEnabled = yield* Config.boolean("LAUNCH_RUNNER_SCALE_IN_ENABLED").pipe(
    Effect.orElseSucceed(() => true),
  );
  const launchRunnerScaleInStepPct = yield* validatedNumber(
    "LAUNCH_RUNNER_SCALE_IN_STEP_PCT",
    0.01,
    0.05,
    0.5,
  );
  const launchRunnerScaleInSizePct = yield* validatedNumber(
    "LAUNCH_RUNNER_SCALE_IN_SIZE_PCT",
    0.05,
    0.25,
    1,
  );
  const launchRunnerScaleInMaxSteps = Math.floor(
    yield* validatedNumber("LAUNCH_RUNNER_SCALE_IN_MAX_STEPS", 1, 3, 10),
  );
  // Wash forensics: one Helius enhanced-API call per admitted launch pool —
  // wallet-concentration / burst-density evidence that flags wash volume
  // before ENTER. OFF by default (RPC cost + heuristic noise); advisory in
  // the radar log, hard-rejecting only at egregious thresholds.
  const launchWashForensicsEnabled = yield* Config.boolean("LAUNCH_WASH_FORENSICS_ENABLED").pipe(
    Effect.orElseSucceed(() => false),
  );

  const deployerBlacklistPath = yield* Config.string("DEPLOYER_BLACKLIST_PATH").pipe(
    Effect.orElseSucceed(() => "./engine/data/deployer-blacklist.json"),
  );
  const tokenBlacklistPath = yield* Config.string("TOKEN_BLACKLIST_PATH").pipe(
    Effect.orElseSucceed(() => "./engine/data/token-blacklist.json"),
  );
  const sqliteDbPath = yield* Config.string("SQLITE_DB_PATH").pipe(
    Effect.orElseSucceed(() => getPrismDbPath()),
  );
  const enableSnapshotCapture = yield* Config.boolean("ENABLE_SNAPSHOT_CAPTURE").pipe(
    Effect.orElseSucceed(() => false),
  );
  const snapshotRetentionDays = yield* validatedNumber("SNAPSHOT_RETENTION_DAYS", 1, 14);

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
  const validChannels = ["stable", "beta", "dev", "canary"] as const;
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  const updateChannel = validChannels.includes(updateChannelRaw as (typeof validChannels)[number])
    ? // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
      (updateChannelRaw as (typeof validChannels)[number])
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
    Effect.orElseSucceed(() => "https://pub-2f55c98709e74d1d900b89ec20f8f1fc.r2.dev"),
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
  const meteoraDatapiBaseUrl = yield* Config.string("METEORA_DATA_API_URL").pipe(
    Effect.orElseSucceed(() => "https://dlmm.datapi.meteora.ag"),
  );

  const watchlistPools = watchlistPoolsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const invalidPools = watchlistPools.filter((pool) => {
    try {
      new PublicKey(pool);
      return false;
    } catch {
      return true;
    }
  });
  if (invalidPools.length > 0) {
    return yield* Effect.die(
      new ConfigError({
        message: `WATCHLIST_POOLS contains invalid Solana public keys: ${invalidPools.join(", ")}`,
        issues: invalidPools.map((pool) => ({
          path: "WATCHLIST_POOLS",
          message: `Invalid public key: ${pool}`,
        })),
      }),
    );
  }

  const stablecoinMintsList = stablecoinMintsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const invalidStablecoinMints = stablecoinMintsList.filter((mint) => {
    try {
      new PublicKey(mint);
      return false;
    } catch {
      return true;
    }
  });
  if (invalidStablecoinMints.length > 0) {
    return yield* Effect.die(
      new ConfigError({
        message: `STABLECOIN_MINTS contains invalid Solana public keys: ${invalidStablecoinMints.join(", ")}`,
        issues: invalidStablecoinMints.map((mint) => ({
          path: "STABLECOIN_MINTS",
          message: `Invalid public key: ${mint}`,
        })),
      }),
    );
  }
  const stablecoinMints = new Set(stablecoinMintsList);

  // ── Hot-window capture lane knobs ────────────────────────────────────────
  const hotWindowEnabled = yield* Config.boolean("HOT_WINDOW_ENABLED").pipe(
    Effect.orElseSucceed(() => false),
  );
  const hotWindowEntrySizeUsd = yield* validatedNumber("HOT_WINDOW_ENTRY_SIZE_USD", 5, 30, 500);
  const hotWindowMaxPoolTvlUsd = yield* validatedNumber(
    "HOT_WINDOW_MAX_POOL_TVL_USD",
    1_000,
    25_000,
    500_000,
  );
  const hotWindowMinPoolTvlUsd = yield* validatedNumber(
    "HOT_WINDOW_MIN_POOL_TVL_USD",
    100,
    500,
    20_000,
  );
  const hotWindowPrintingRatio1h = yield* validatedNumber(
    "HOT_WINDOW_PRINTING_RATIO_1H",
    0.1,
    1,
    50,
  );
  const hotWindowMinSharePct = yield* validatedNumber(
    "HOT_WINDOW_MIN_SHARE_PCT",
    0.001,
    0.005,
    0.5,
  );
  const hotWindowMaxSharePct = yield* validatedNumber("HOT_WINDOW_MAX_SHARE_PCT", 0.01, 0.05, 0.5);
  const hotWindowHoldMaxMs = yield* validatedNumber(
    "HOT_WINDOW_HOLD_MAX_MS",
    60_000,
    1_800_000,
    6 * 60 * 60 * 1000,
  );
  const hotWindowMaxTripsPerDay = yield* validatedNumber(
    "HOT_WINDOW_MAX_TRIPS_PER_DAY",
    1,
    30,
    500,
  );
  const hotWindowDailyLossHaltUsd = yield* validatedNumber(
    "HOT_WINDOW_DAILY_LOSS_HALT_USD",
    0.1,
    3,
    100,
  );
  const hotWindowMaxOpen = yield* validatedNumber("HOT_WINDOW_MAX_OPEN", 1, 2, 20);

  const cfg: AppConfig = {
    walletPrivateKey,
    heliusApiKey,
    heliusDasDisabled,
    solanaRpcUrl,
    solanaRpcFallbackUrl,
    rpcMinIntervalMs,
    paperTrading,
    autonomousTokenMode,
    settlementAsset,
    candidateMinHealthyScans,
    candidateMinObservationMs,
    candidateScanLimit,
    candidateMinPoolAgeMs,
    maxMarketDataAgeMs,
    maxSwapSlippageBps,
    maxSwapPriceImpactBps,
    settlementDustUsd,
    settlementMaxPendingMs,
    maxDailyDrawdownPct,
    maxConsecutiveExecutionFailures,
    agentInstanceId,
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
    trailingStopConfirmCycles,
    oorGracePeriodCycles,
    feeClaimIntervalMs,
    enablePoolDiscovery,
    discoveryMinTvlUsd,
    discoveryMinFeeRatio,
    marketScanEnabled,
    marketScanRefreshIntervalMs,
    marketScanUniversePages,
    marketScanUniverseSort,
    marketScanMinTvlUsd,
    marketScanMinFeeApr,
    marketScanRunnerEnabled,
    marketScanRunnerMinFeeApr,
    marketScanRunnerMinDriftBins,
    marketScanRotationEnabled,
    marketScanRotationAprMult,
    marketScanRunnerConfirmCycles,
    marketScanRotationArmMs,
    yieldRegressionExitPct,
    feeCaptureConversionCostPct,
    feeCaptureHarvestCostUsd,
    runnerSwapCostPct,
    runnerNetFloorPct,
    harvestMinNetUsd,
    harvestMaxCostPct,
    harvestTxCostUsdEst,
    regimeHerdingGateEnabled,
    regimeHerdingEdgeThreshold,
    regimeHerdingCorrThreshold,
    runnerAprOutlierEnabled,
    runnerAprOutlierPercentile,
    flashVolumeTriggerEnabled,
    flashMinSpikeRatio,
    flashBaselineWindow,
    flashMinVolumeUsd,
    churnMaxEntriesPerPoolPerDay,
    holdBiasEnabled,
    marketScanMinFees24hUsd,
    marketScanMinVolume24hUsd,
    allowTransferFeeTokens,
    tokenFailureBlockMs,
    rugExitLossPct,
    rugTokenBlockMs,
    minYieldExitAgeMs,
    marketScanMaxNegativeDriftBins,
    entryMomentumConfBoost,
    entryMomentumReferenceBins,
    entryMomentumScoreWeight,
    takeProfitEnabled,
    takeProfitPct,
    backtestTolerateEmptyBins,
    marketScanTopK,
    marketScanMaxPools,
    marketScanMinHolders,
    marketScanRequireRenouncedMint,
    marketScanMinPoolAgeHours,
    marketScanMinBinStep,
    marketScanMaxBinStep,
    launchScanEnabled,
    launchScanRefreshIntervalMs,
    launchScanTopK,
    launchScanUniverseSize,
    launchScanMinTvlUsd,
    launchScanMaxTvlUsd,
    launchScanMaxAgeHours,
    launchScanMinVolume1hUsd,
    launchScanMinBaseFeePct,
    launchScanMinBinStep,
    launchScanMaxBinStep,
    launchExecutionEnabled,
    launchMaxOpenPositions,
    launchPositionMaxSizeUsd,
    launchTimeboxHours,
    launchVolumeDecayExitPct,
    launchExitDrawdownPct,
    launchRunnerModeEnabled,
    launchRunnerDipPct,
    launchRunnerDrawdownPct,
    launchRunnerHalfWidthBins,
    launchRunnerScaleInEnabled,
    launchRunnerScaleInStepPct,
    launchRunnerScaleInSizePct,
    launchRunnerScaleInMaxSteps,
    launchWashForensicsEnabled,
    hotWindowEnabled,
    hotWindowEntrySizeUsd,
    hotWindowMaxPoolTvlUsd,
    hotWindowMinPoolTvlUsd,
    hotWindowPrintingRatio1h,
    hotWindowMinSharePct,
    hotWindowMaxSharePct,
    hotWindowHoldMaxMs,
    hotWindowMaxTripsPerDay,
    hotWindowDailyLossHaltUsd,
    hotWindowMaxOpen,
    deployerBlacklistPath,
    tokenBlacklistPath,
    sqliteDbPath,
    enableSnapshotCapture,
    snapshotRetentionDays,
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
    meteoraDatapiBaseUrl,
    stablecoinMints,
    depegAbsoluteUsd,
    depegRelativePct,
    liquidityDrainPct,
    liquidityDrainLookbackSnapshots,
    freezeSmartScreening,
    ilProtectionEnabled,
    ilDominanceExitFactor,
    ilDominanceMinUsd,
    dustExitUsd,
    jupiterTokenRiskEnabled,
    jupiterTokenRiskCacheTtlMin,
    goPlusApiKey,
    goPlusApiSecret,
    goPlusTokenRiskEnabled,
    goPlusTokenRiskCacheTtlMin,
    geckoTerminalEnabled,
    dexscreenerEnabled,

    pythEnabled,
    pythApiKey,
    pythMaxStalenessMs,
    pythBaseUrl,

    rebalanceGasCostSol,
    solPriceUsd,
    gasAwareMinDaysOfFeesPaidAhead,
    volatilityExitStddev,
    volatilityLookbackSnapshots,
    volatilityWideHalfWidthBins,
    entryRangeHalfWidthBins,
    volatilityAdaptiveRanges,
    minRangeHalfWidthPct,
    autoCompoundFees,
    minCompoundFeesUsd,
    compoundGasBufferUsd,
    feeDestination,
    oorRecoveryLookbackCycles,
    oorRecoveryHoldThreshold,
    oorRecoveryForceRebalanceThreshold,
    maxPerPoolAllocationPct,
    maxOpenPositions,
    maxPositionsPerPool,
    maxEntrySizeUsd,
    paperValidationMinDays,
    paperValidationEnforce,
    oorCooldownMs,
    repeatOorCooldownMs,
    maxOorCooldownExits,
    minReentryCooldownMs,
    feeDensityCooldowns,
    feeDensityCooldownMinMs,
    feeDensityHighPct,
    feeDensityLowPct,
    agentiveMode,
    agentRuntime,
    agentAcpCommand,
    agentAcpArgs,
    agentGatewayUrl,
    agentGatewayToken,
    agentPromptTimeoutMs,
    agentVetoTimeoutMs,
    agentCheckinIntervalMs,
    agentCheckinOnEvents,
    agentCheckinIncludeHistory,
    agentCheckinMaxPositions,
    agentOpenclawWebhookUrl,
    agentOpenclawWebhookToken,
    agentHermesApiUrl,
    agentHermesApiToken,
    agentHttpPort,
    agentMcpEnabled,
    agentProposalMode,
    agentProposalToken,
    agentApprovalToken,
    agentProposalTimeoutMs,
    agentProposalMaxBatchSize,
    agentProposalMaxQueueSize,
    agentProposalStaleMs,
    agentProposalBackoffBaseMs,
    agentProposalBackoffMaxMs,
    agentProposalMaxPositionSizePct,
    agentProposalMinConfidence,
    agentProposalCircuitBreakerThreshold,
    agentProposalCircuitBreakerCooldownMs,
    evolutionInterval,
    evolutionMaxChangePct,
    signalWeightWindowDays,
    signalWeightMinOutcomes,
    signalWeightBoostFactor,
    signalWeightDecayFactor,
    signalWeightFloor,
    signalWeightCeiling,
    weightedEntryScoreThreshold,
    autoSwapEntry,
    entryStrategyType,
    idleRedeployEnabled,
    idleRedeployThresholdUsd,
    idleRedeployMaxSizeUsd,
    realizedPnLHaltEnabled,
    realizedPnLHaltWindow,
    realizedPnLHaltThresholdUsd,
    poolPnlKillSwitchEnabled,
    poolPnlKillSwitchMinClosedPositions,
    poolPnlKillSwitchThresholdUsd,
    poolPnlKillSwitchCooldownMs,
    farmRewardsEnabled,
    limitOrdersEnabled,
    limitOrderMode,
    limitOrderTargetBinOffset,
    limitOrderMaxActiveBinSlippage,
    alertsEnabled,
    alertCooldownMinutes,
    alertFeeMilestoneUsd,
    copySignalsEnabled,
    copySignalsEndpoint,
    copySignalWallets,
    copySignalsStaleMs,
    copySignalsMaxBoost,
    fallenAngelEnabled,
    fallenAngelMinTvlUsd,
    fallenAngelMinDrawdownPct,
    fallenAngelMaxDrawdownPct,
    fallenAngelVolBaselineMin,
    fallenAngelVolBaselineMax,
    fallenAngelMaxRugcheckScore,
    fallenAngelMinHolders,
    fallenAngelMaxTop10HolderPct,
    fallenAngelTpRungs,
    fallenAngelTpFractions,
    fallenAngelInvalidationStopPct,
    fallenAngelMaxPositions,
  };

  // ─── DB-backed config sidecar (env > DB > defaults) ───────────────────────
  // After env resolution, apply persisted overrides from the SQLite `metadata`
  // table for keys whose env var is UNSET. Fail-open: a missing/unreadable DB
  // leaves the env/defaults untouched. Skipped entirely in test mode so the
  // suite stays deterministic and DB-free. See engine/db-config.ts.
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  const cfgFromEnv = cfg as Readonly<AppConfig>;
  const dbOverrides = isTest
    ? new Map<string, string>()
    : readDbConfigOverrides(cfgFromEnv.sqliteDbPath);
  if (dbOverrides.size > 0) {
    return applyDbConfigOverrides(cfg, dbOverrides);
  }

  return cfg;
});

// v4's default ConfigProvider snapshots process.env once per process; snapshot
// lazily at each build (preserveEmptyStrings keeps STABLECOIN_MINTS="" semantics)
// so vitest stubs / CLI-set env are honored.
export const ConfigLive = Layer.effect(
  ConfigService,
  Effect.gen(function* () {
    return yield* loadConfig.pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        // v4 treats literal "" as a missing env value by default; the engine
        // contract says empty strings are meaningful (STABLECOIN_MINTS=""
        // disables the allowlist, AGENT_GATEWAY_TOKEN="" disables a runtime).
        ConfigProvider.fromEnv({ preserveEmptyStrings: true }),
      ),
    );
  }),
);
