import { Config, Context, Effect, Layer, Option, pipe } from "effect";
import { ConfigError } from "./errors.js";
import { getPrismDbPath } from "./paths.js";
import type { AgentProposalMode, EntryStrategyType } from "./types.js";
import { PublicKey } from "@solana/web3.js";
import { createLogger } from "./logger.js";

const logger = createLogger("ConfigService");

export type FeeDestination = "compound" | "accumulate-quote" | "accumulate-sol";

function maskHeliusUrl(u: string): string {
  return u.replace(/(api[-_]key=)[^&\s]*/g, "$1[REDACTED]");
}

function isHeliusHost(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
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
export function normalizeHeliusUrl(
  url: string,
  heliusApiKey: string,
): { readonly url: string; readonly normalized: boolean } {
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
  readonly solanaRpcUrl: string;
  readonly solanaRpcFallbackUrl: string;
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
  /** Days of pool_snapshots history to keep; older rows are pruned daily. Default 14. */
  readonly snapshotRetentionDays: number;
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
  readonly meteoraDatapiBaseUrl: string;
  readonly stablecoinMints?: ReadonlySet<string>;
  readonly depegAbsoluteUsd?: number;
  readonly depegRelativePct?: number;
  readonly liquidityDrainPct?: number;
  readonly liquidityDrainLookbackSnapshots?: number;

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
  /** Scale entry/rebalance range width by measured realized volatility. Default false (opt-in). */
  readonly volatilityAdaptiveRanges: boolean;

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

  // ─── F6: Paper-trading validation period ────────────────────────────────────
  /** Require N days of paper trading before allowing live ENTER. */
  readonly paperValidationMinDays: number;
  /** Hard-block live ENTER if validation not met (vs warn only). */
  readonly paperValidationEnforce: boolean;

  // ─── F7: Pool cooldown after failed exits ───────────────────────────────────
  readonly oorCooldownMs: number;
  readonly repeatOorCooldownMs: number;
  readonly maxOorCooldownExits: number;

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
  /** Timeout for agent prompt responses. Default 15000 ms. */
  readonly agentPromptTimeoutMs: number;
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
  /** Hermes HTTP API URL for one-way agent alerts. Empty = disabled. Default "". */
  readonly agentHermesApiUrl: string;
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
}

export class ConfigService extends Context.Tag("ConfigService")<ConfigService, AppConfig>() {}

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

  const walletPrivateKey = yield* Config.string("WALLET_PRIVATE_KEY").pipe(
    Effect.orElseSucceed(() => ""),
  );
  const heliusApiKey = yield* Config.string("HELIUS_API_KEY").pipe(
    Effect.orElseSucceed(() => (isTest ? "test-helius-key" : "")),
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
  const solanaRpcFallbackUrl = normalizeHeliusUrl(solanaRpcFallbackUrlRaw, heliusApiKey).url;
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
  const stablecoinMintsRaw = yield* Config.string("STABLECOIN_MINTS").pipe(
    Effect.orElseSucceed(() => ""),
  );
  const stablecoinMints = new Set(
    stablecoinMintsRaw
      .split(",")
      .map((mint) => mint.trim())
      .filter(Boolean),
  );
  const depegAbsoluteUsd = yield* validatedNumber("DEPEG_ABSOLUTE_USD", 0.001, 0.02);
  const depegRelativePct = yield* validatedNumber("DEPEG_RELATIVE_PCT", 0.001, 0.02);
  const liquidityDrainPct = yield* validatedNumber("LIQUIDITY_DRAIN_PCT", 0.01, 0.9);
  const liquidityDrainLookbackSnapshots = yield* validatedNumber(
    "LIQUIDITY_DRAIN_LOOKBACK_SNAPSHOTS",
    1,
    12,
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
    Effect.orElseSucceed(() => false),
  );

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

  // ─── Agentic mode / agent runtime overlay ────────────────────────────
  const agentiveMode = yield* Config.boolean("AGENTIC_MODE").pipe(
    Effect.orElseSucceed(() => false),
  );
  const agentRuntimeRaw = yield* Config.string("AGENT_RUNTIME").pipe(
    Effect.orElseSucceed(() => "auto"),
  );
  const validAgentRuntimes = ["auto", "hermes", "openclaw", "none"] as const;
  const agentRuntime = validAgentRuntimes.includes(
    agentRuntimeRaw as (typeof validAgentRuntimes)[number],
  )
    ? (agentRuntimeRaw as (typeof validAgentRuntimes)[number])
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
  const agentPromptTimeoutMs = yield* validatedNumber("AGENT_PROMPT_TIMEOUT_MS", 1_000, 15_000);
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
  const agentHermesApiUrl = yield* Config.string("AGENT_HERMES_API_URL").pipe(
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
  const agentProposalMode = validAgentProposalModes.includes(
    agentProposalModeRaw as (typeof validAgentProposalModes)[number],
  )
    ? (agentProposalModeRaw as (typeof validAgentProposalModes)[number])
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
  const entryStrategyType: EntryStrategyType = validEntryStrategyTypes.includes(
    entryStrategyTypeRaw as (typeof validEntryStrategyTypes)[number],
  )
    ? (entryStrategyTypeRaw as (typeof validEntryStrategyTypes)[number])
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
  const discoveryMinTvlUsd = yield* validatedNumber("DISCOVERY_MIN_TVL_USD", 0, 1_000_000);
  const discoveryMinFeeRatio = yield* validatedNumber("DISCOVERY_MIN_FEE_RATIO", 0, 1.5);
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

  const cfg: AppConfig = {
    walletPrivateKey,
    heliusApiKey,
    solanaRpcUrl,
    solanaRpcFallbackUrl,
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

    rebalanceGasCostSol,
    solPriceUsd,
    gasAwareMinDaysOfFeesPaidAhead,
    volatilityExitStddev,
    volatilityLookbackSnapshots,
    volatilityWideHalfWidthBins,
    entryRangeHalfWidthBins,
    volatilityAdaptiveRanges,
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
    paperValidationMinDays,
    paperValidationEnforce,
    oorCooldownMs,
    repeatOorCooldownMs,
    maxOorCooldownExits,
    agentiveMode,
    agentRuntime,
    agentAcpCommand,
    agentAcpArgs,
    agentGatewayUrl,
    agentGatewayToken,
    agentPromptTimeoutMs,
    agentCheckinIntervalMs,
    agentCheckinOnEvents,
    agentCheckinIncludeHistory,
    agentCheckinMaxPositions,
    agentOpenclawWebhookUrl,
    agentHermesApiUrl,
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
  };

  return cfg;
});

export const ConfigLive = Layer.effect(ConfigService, loadConfig);
