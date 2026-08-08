import { Context, Effect } from "effect";
import type {
  AgentDecision,
  AgentPolicySnapshot,
  AgentProposal,
  BinArray,
  EntryDepositMode,
  EntryStrategyShape,
  MemoryCategory,
  MemoryEntry,
  PoolCooldown,
  PoolMetrics,
  PoolSnapshot,
  PoolState,
  Position,
  PriceDriftContext,
  SignalSnapshot,
  SignalWeights,
  ExecutionOperationRecord,
  SafetyPauseRecord,
  SettlementJobRecord,
  TokenCandidateRecord,
} from "./types.js";
import type {
  AgentRuntimeContext,
  AgentRuntimeCheckin,
  AgentRuntimeAlert,
} from "./agent-transport.js";
import type { PrismStateSnapshot } from "./state-service.js";
import type { GeckoPoolStats } from "./gecko-terminal-service.js";
import type { EvolvableThresholds, OutcomeRecord } from "./strategy-service.js";
import type { ClaimedReward } from "./rewards.js";
import type { LimitOrderRequest } from "./limit-orders.js";
import type { DiscoverPoolsError, EntryPrepError } from "./errors.js";
import type { CopySignalApi } from "./copy-trading-signals.js";

// ─── Adapter Service ─────────────────────────────────────────────────────────

export interface DiscoveredPool {
  readonly address: string;
  readonly tvlUsd: number;
  readonly volume24hUsd: number;
  readonly fees24hUsd: number;
  readonly apr: number;
  readonly binStep: number;
  readonly tokenX: string;
  readonly tokenY: string;
  readonly createdAtMs?: number;
  // Token-safety metadata straight from the Data API list payload. Optional
  // so legacy mappers/tests compile unchanged; the market gate uses it to
  // pre-filter risky legs (unverified, freeze-enabled, dust holder counts)
  // BEFORE they burn scan cycles. Absent fields fail open — the per-pool
  // safety screen (blacklist/freeze/token-risk overlay) still runs on ENTER.
  readonly tokenXSymbol?: string;
  readonly tokenYSymbol?: string;
  readonly tokenXVerified?: boolean;
  readonly tokenYVerified?: boolean;
  readonly tokenXFreezeDisabled?: boolean;
  readonly tokenYFreezeDisabled?: boolean;
  readonly tokenXHolders?: number;
  readonly tokenYHolders?: number;
}

export interface SwapRequest {
  readonly inputMint: string;
  readonly outputMint: string;
  readonly amountAtomic: bigint;
  readonly slippageBps: number;
}

export interface SwapQuote {
  readonly request: SwapRequest;
  readonly outAmountAtomic: bigint;
  readonly minimumOutAmountAtomic: bigint;
  readonly priceImpactBps: number;
  readonly quotedAt: number;
  readonly route: ReadonlyArray<{
    readonly inputMint: string;
    readonly outputMint: string;
  }>;
  readonly rawQuote: Record<string, unknown>;
}

export interface PreparedSwap {
  readonly quote: SwapQuote;
  readonly transactionBase64: string;
  readonly transactionFormat: "legacy" | "versioned";
  readonly preparedAt: number;
}

export interface SwapSimulation {
  readonly successful: true;
  readonly logs: ReadonlyArray<string>;
  readonly unitsConsumed: number | null;
}

export interface SwapStatus {
  readonly state: "not_found" | "processed" | "confirmed" | "finalized" | "failed";
  readonly error: string | null;
}

export interface TokenPriceEvidence {
  readonly mint: string;
  readonly priceUsd: number;
  readonly observedAt: number;
  readonly fallbackUsed: false;
}

export interface AdapterApi {
  readonly hasWallet: () => boolean;
  readonly getWalletAddress: () => string | null;
  readonly getWalletBalanceUsd: () => Effect.Effect<number, Error>;
  /**
   * Per-mint SPL holdings the wallet-balance read already scans (Token
   * Program + Token-2022, zero-amount ATAs skipped). Served from the SAME
   * 30s cached snapshot as getWalletBalanceUsd — identical TTL, cleared by
   * the same post-transaction invalidation — so the two reads never
   * disagree and a holdings read costs no extra RPC. Empty map in paper
   * mode (no wallet). A live read failure FAILS the Effect (the balance
   * semantics); idle-capital consumers catch it fail-open and treat the
   * cycle as having no idle capital. Native SOL is not included.
   */
  readonly getWalletHoldings: () => Effect.Effect<
    ReadonlyMap<string, { readonly amountAtomic: bigint; readonly decimals: number }>,
    Error
  >;
  readonly getNativeSolBalance: () => Effect.Effect<bigint, Error>;
  readonly getPoolState: (poolAddress: string) => Effect.Effect<PoolState, Error>;
  readonly getBinArray: (poolAddress: string) => Effect.Effect<BinArray, Error>;
  /**
   * Fetch the top-N pages (1000 pools each) of the TVL-ranked Meteora
   * universe in ONE call — the market-scan universe refresh. Unlike the
   * rotating single-page `discoverPools`, this returns every pool from
   * pages 1..N (no 50-row slice) with the Data API's token-safety metadata
   * attached, so the market gate can rank the whole liquid universe. Never
   * fails: any page/network/parse error logs a warning and returns [] —
   * the market scan falls back to its last ranked set. Optional so test
   * mocks compile unchanged.
   */
  readonly discoverPoolsTopPages?: (
    pages: number,
  ) => Effect.Effect<ReadonlyArray<DiscoveredPool>, never>;
  readonly getPositions: (
    poolAddress: string,
    walletAddress: string,
  ) => Effect.Effect<ReadonlyArray<Position>, Error>;
  readonly getAllWalletPositions: (walletAddress: string) => Effect.Effect<
    ReadonlyArray<{
      poolAddress: string;
      positionPubKey: string;
      lowerBinId: number;
      upperBinId: number;
    }>,
    Error
  >;
  /**
   * Real USD value of a live on-chain position (principal only — pending
   * swap fees and LM rewards are accounted by the claim paths, never by the
   * mark). Computed from the position's ACTUAL bin holdings
   * (`totalXAmount`/`totalYAmount`) priced at the pool's token mints, so it
   * captures genuine impermanent loss (an out-of-range position holds mostly
   * one side) instead of the old bin-drift heuristic that fabricated ±20-40%
   * "drawdowns" from sub-1% price moves — the root cause of the trailing-stop
   * exit churn seen on live deployments. Never fails the caller: a
   * position/price read problem logs nothing and returns null (fail-open),
   * and the caller falls back to the HODL-anchored mark. Optional so loop
   * test mocks that do not care about marks compile unchanged.
   */
  readonly getPositionValueUsd?: (
    poolAddress: string,
    positionPubKey: string,
  ) => Effect.Effect<number | null, never>;
  /**
   * Estimate the benefit of rebalancing `positionPubKey` into a new range.
   * Live mode runs the Meteora SDK's atomic-rebalance simulation against the
   * real on-chain position: `estimatedFeesUsd` is the position's real
   * claimable fees and `estimatedCostUsd` is the quoted bin-array/bitmap
   * rent for the target range. Paper mode has no on-chain position to
   * simulate, so it reports a pool-level heuristic (`source:
   * "pool-heuristic"`) that only shapes simulated decisions.
   */
  readonly simulateRebalance: (
    poolAddress: string,
    positionPubKey: string,
    newLowerBinId: number,
    newUpperBinId: number,
  ) => Effect.Effect<
    {
      estimatedFeesUsd: number;
      estimatedCostUsd: number;
      netBenefitUsd: number;
      source: "sdk-simulation" | "pool-heuristic";
    },
    Error
  >;
  /**
   * Open a live position and deposit liquidity by strategy. The deposit
   * distribution comes from `options.strategyShape` (resolved per pool by the
   * decision loop) falling back to the configured `ENTRY_STRATEGY_TYPE`
   * (`auto` falls back to `spot` here — the adapter has no volatility
   * context). When the wallet can fund only one of the pool's tokens, the
   * adapter takes the SDK single-sided deposit path
   * (`StrategyParameters.singleSidedX`, full position size in the held leg)
   * instead of failing; `depositMode`/`amountXUsd`/`amountYUsd` report what
   * was actually deposited so entry accounting stays exact.
   */
  readonly enterPosition: (
    poolAddress: string,
    lowerBinId: number,
    upperBinId: number,
    positionSizeUsd: number,
    options?: { strategyShape?: EntryStrategyShape },
  ) => Effect.Effect<
    {
      positionPubKey: string;
      txSignature: string;
      depositMode: EntryDepositMode;
      amountXUsd: number;
      amountYUsd: number;
    },
    Error
  >;
  /**
   * Close a live position via the SDK's `removeLiquidity` (full-withdraw +
   * `shouldClaimAndClose`, which claims accrued swap fees AND LM rewards
   * on-chain in the same batch). All accounting fields are OPTIONAL so the
   * ~16 loop-level mocks that return bare `{txSignature}` compile unchanged —
   * absent amounts mean "unresolved" to the caller, which records a NULL
   * realized PnL rather than a fabricated value.
   *
   * - `withdrawnXAtomic`/`withdrawnYAtomic`: withdrawn principal + swept fees,
   *   read from the pre-close position snapshot (the `*ExcludeTransferFee`
   *   variants — identical to gross for plain SPL, correct for token-2022).
   * - `withdrawnUsd`: mint-based USD of the withdrawn legs; `null` when ANY
   *   leg is unpriceable (fail-closed — never 0, never the last mark).
   * - `pendingFeeXAtomic`/`pendingFeeYAtomic`/`pendingFeeUsd`: the unclaimed
   *   swap fees the close batch sweeps, priced the same all-or-nothing way.
   * - `sweptRewards`: LM rewards the close batch claims, priced per
   *   `claimRewards` semantics (unpriceable slot → `amountUsd: null`).
   *
   * Pricing runs under `catch → null` and must NEVER abort or delay the
   * removeLiquidity transactions — closing bleeding liquidity outranks the
   * ledger. Atomic amounts are always returned even when USD pricing fails.
   */
  readonly exitPosition: (
    poolAddress: string,
    positionPubKey: string,
  ) => Effect.Effect<
    {
      txSignature: string;
      withdrawnXAtomic?: string | undefined;
      withdrawnYAtomic?: string | undefined;
      withdrawnUsd?: number | null | undefined;
      pendingFeeXAtomic?: string | undefined;
      pendingFeeYAtomic?: string | undefined;
      pendingFeeUsd?: number | null | undefined;
      sweptRewards?: ReadonlyArray<ClaimedReward> | undefined;
    },
    Error
  >;
  readonly placeLimitOrder?: (
    poolAddress: string,
    request: LimitOrderRequest,
  ) => Effect.Effect<{ orderPubKey: string; txSignature: string }, Error>;
  readonly cancelLimitOrder?: (
    poolAddress: string,
    orderPubKey: string,
    binIds: ReadonlyArray<number>,
  ) => Effect.Effect<{ txSignature: string }, Error>;
  /**
   * Atomically rebalance a position into a new range via the Meteora SDK's
   * `rebalancePosition` instruction. The position account — and therefore its
   * identity (`positionPubKey`), entry accounting and accrued-fee history — is
   * preserved; there is no close+reopen exposure window. The reshaped size is
   * the position's current on-chain liquidity plus the optional `topUp`
   * amounts (used by auto-compound to redeposit just-claimed fees); it is
   * never derived from paper-trading config.
   */
  readonly rebalancePosition: (
    poolAddress: string,
    positionPubKey: string,
    newLowerBinId: number,
    newUpperBinId: number,
    topUp?: { amountXAtomic: bigint; amountYAtomic: bigint },
  ) => Effect.Effect<
    {
      positionPubKey: string;
      txSignatures: ReadonlyArray<string>;
    },
    Error
  >;
  readonly claimFees: (
    poolAddress: string,
    positionPubKey: string,
    platformFeeRate?: number,
    revenueShareEnabled?: boolean,
    revenueShareOperatorPct?: number,
    feeWalletAddress?: string,
  ) => Effect.Effect<
    {
      txSignature: string;
      feeX: number;
      feeY: number;
      platformFeeX: number;
      platformFeeY: number;
      netFeeX: number;
      netFeeY: number;
      feeTransferTxSignature?: string;
      operatorFeeX?: number;
      operatorFeeY?: number;
      /**
       * Mint-based USD value of the NET claimed fees (the adapter has dlmm +
       * mints + decimals in scope — mirrors simulateRebalance). `null` when
       * either leg is unpriceable (fail-closed); the zero-fee shortcut returns
       * 0. Callers consume `netFeesUsd ?? 0` so an unpriceable claim fails the
       * compound gate closed instead of booking a symbol-based mis-estimate.
       * Optional so existing claimFees mocks compile unchanged; callers read
       * `netFeesUsd ?? 0`.
       */
      netFeesUsd?: number | null;
    },
    Error
  >;
  readonly convertClaimedFees?: (
    poolAddress: string,
    destination: "accumulate-quote" | "accumulate-sol",
    feeX: number,
    feeY: number,
  ) => Effect.Effect<
    {
      destination: "accumulate-quote" | "accumulate-sol";
      outputAtomic: bigint;
      outputUsd: number | null;
      txSignatures: ReadonlyArray<string>;
    },
    Error
  >;
  /**
   * Claim LM farm rewards for a position via the SDK's claimAllLMRewards
   * (LM-only — never the combined fee+reward claim, which would move swap
   * fees outside the engine's own fee accounting). Rides the same periodic
   * cadence as claimFees. Skip semantics (not errors): the pool's function
   * type is LimitOrder with nothing pending, or the position has no pending
   * rewards — claiming when nothing is claimable is a no-op by construction,
   * which is what keeps repeated cycles idempotent. Amounts are the position's
   * pending rewardOne/rewardTwo read immediately before the claim; a reward
   * whose mint price is unavailable is recorded with amountUsd null and never
   * blocks the claim.
   */
  readonly claimRewards: (
    poolAddress: string,
    positionPubKey: string,
  ) => Effect.Effect<
    {
      skipped: boolean;
      skipReason: string | null;
      txSignatures: ReadonlyArray<string>;
      rewards: ReadonlyArray<ClaimedReward>;
    },
    Error
  >;
  readonly discoverPools: (
    scanOrdinal?: number,
  ) => Effect.Effect<ReadonlyArray<DiscoveredPool>, DiscoverPoolsError>;
  readonly reportFeeCollection: (event: {
    poolAddress: string;
    positionPubkey?: string;
    feeX: number;
    feeY: number;
    platformFeeX: number;
    platformFeeY: number;
    operatorFeeX?: number;
    operatorFeeY?: number;
    tier: string;
    txSignature: string;
    feeTransferTxSignature?: string;
  }) => Effect.Effect<void, never>;
  readonly swapUSDCForSOL: (
    minSolThreshold?: number,
    swapAmountUSDC?: number,
  ) => Effect.Effect<void, never>;
  readonly getTokenBalance: (mintAddress: string) => Effect.Effect<bigint, Error>;
  readonly getTokenPrices: (
    mints: ReadonlyArray<string>,
    opts?: { readonly useFallback?: boolean },
  ) => Effect.Effect<Record<string, number>, Error>;
  readonly getTokenPriceEvidence?: (
    mints: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<TokenPriceEvidence>, Error>;
  readonly getTokenDecimals: (mintAddress: string) => Effect.Effect<number, Error>;
  /**
   * On-chain mint/freeze authority for a token mint, from the parsed mint
   * account. The mint authority doubles as the documented deployer fallback
   * for the deployer blacklist; the freeze authority feeds the safety
   * screening (freeze-authority-enabled tokens are rejected). Callers treat
   * RPC failures as fail-open.
   */
  readonly getMintAuthorities: (
    mintAddress: string,
  ) => Effect.Effect<{ mintAuthority: string | null; freezeAuthority: string | null }, Error>;
  readonly quoteSwapUSDCForToken: (
    outputMint: string,
    amountAtomic: bigint,
  ) => Effect.Effect<Record<string, unknown>, Error>;
  readonly swapUSDCForToken: (
    outputMint: string,
    amountAtomic: bigint,
    quoteData?: Record<string, unknown>,
  ) => Effect.Effect<string, Error>;
  readonly swapToken?: (
    inputMint: string,
    outputMint: string,
    amountAtomic: bigint,
    quoteData?: Record<string, unknown>,
  ) => Effect.Effect<string, Error>;
  readonly quoteSwap?: (request: SwapRequest) => Effect.Effect<SwapQuote, Error>;
  readonly prepareSwap?: (quote: SwapQuote) => Effect.Effect<PreparedSwap, Error>;
  readonly simulateSwap?: (prepared: PreparedSwap) => Effect.Effect<SwapSimulation, Error>;
  readonly submitSwap?: (
    prepared: PreparedSwap,
    onBroadcast?: (signature: string) => Effect.Effect<void, Error>,
  ) => Effect.Effect<string, Error>;
  readonly getSwapStatus?: (signature: string) => Effect.Effect<SwapStatus, Error>;
  readonly getConfirmedSwapOutput?: (
    signature: string,
  ) => Effect.Effect<{ outputAtomic: bigint; feeAtomic: bigint } | null, Error>;
}

export class AdapterService extends Context.Service<AdapterService, AdapterApi>()(
  "AdapterService",
) {}

// ─── Entry Prep Service ───────────────────────────────────────────────────────

export interface EntryPrepApi {
  readonly prepareEntryTokens: (
    poolAddress: string,
    positionSizeUsd: number,
  ) => Effect.Effect<EntryPreparationOutcome | undefined, EntryPrepError>;
}

export interface EntryPreparationReceipt {
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inputAmountAtomic: bigint;
  readonly acquiredAmountAtomic: bigint;
  readonly txSignature: string;
}

export interface EntryPreparationOutcome {
  readonly status: "complete" | "partial";
  readonly receipts: ReadonlyArray<EntryPreparationReceipt>;
}

export class EntryPrepService extends Context.Service<EntryPrepService, EntryPrepApi>()(
  "EntryPrepService",
) {}

// ─── Strategy Service ────────────────────────────────────────────────────────

export interface StrategyApi {
  readonly computeMetrics: (
    pool: PoolState,
    binArray: BinArray,
    previousTvlUsd: number,
    priceDrift?: PriceDriftContext,
  ) => PoolMetrics;
  readonly checkVolumeAuthenticity: (
    pool: PoolState,
    feesMeasured: boolean,
  ) => {
    score: number;
    flags: ReadonlyArray<string>;
  };
  readonly computeBinUtilization: (binArray: BinArray) => number;
  readonly computeFeeIlRatio: (
    pool: PoolState,
    binArray: BinArray,
    priceDrift?: PriceDriftContext,
  ) => number;
  readonly recommendBinRange: (
    activeBinId: number,
    binStep: number,
    halfWidthOverride?: number,
  ) => { lowerBinId: number; upperBinId: number };
  readonly passesPreFilter: (
    pool: PoolState,
    authScore: number,
    binUtilization: number,
    minTvlUsd: number,
    minAuthScore: number,
    minBinUtilization: number,
    authKnown?: boolean,
    binUtilizationKnown?: boolean,
  ) => boolean;
}

export class StrategyService extends Context.Service<StrategyService, StrategyApi>()(
  "StrategyService",
) {}

// ─── Meteora Data API Service ────────────────────────────────────────────────

/** Real pool statistics from the Meteora Data API (dlmm.datapi.meteora.ag). */
export interface MeteoraPoolStats {
  readonly address: string;
  readonly name: string;
  readonly tvlUsd: number;
  readonly volume24hUsd: number;
  readonly fees24hUsd: number;
  readonly apr: number;
  readonly apy: number;
  readonly currentPrice: number;
  readonly feeTvlRatio24h: number | null;
  readonly feeTvlRatio12h: number | null;
  readonly feeTvlRatio1h: number | null;
  readonly dynamicFeePct: number | null;
  readonly baseFeePct: number | null;
  readonly hasFarm: boolean | null;
  /**
   * Farm reward APR from the Data API (`farm_apr`), annualized percent — the
   * same convention as the engine's enriched `PoolState.apr`. Null when the
   * API omits it (schema drift) or the pool has no farm.
   */
  readonly farmApr: number | null;
  /** Farm reward APY from the Data API (`farm_apy`), annualized percent. */
  readonly farmApy: number | null;
  readonly isBlacklisted: boolean | null;
  readonly tokenXFreezeAuthorityDisabled: boolean | null;
  readonly tokenYFreezeAuthorityDisabled: boolean | null;
  /**
   * Jupiter verification status per token leg (`token_x/y.is_verified`). The
   * disambiguator between "risky freeze authority" and a legitimate
   * freeze-authority token (USDC/USDT/cbBTC report `is_verified: true` while
   * keeping freeze authority set). Read directly by the safety screener from
   * `datapiStats` — deliberately NOT lifted onto `PoolState` by
   * `enrichPoolWithDatapi`. Null when the API omits it (schema drift).
   */
  readonly tokenXVerified: boolean | null;
  readonly tokenYVerified: boolean | null;
}

export interface MeteoraDatapiApi {
  /**
   * Fetch real stats for one pool. Never fails: on any network/HTTP/schema
   * error it logs a warning and returns null so callers fall back to
   * heuristic metrics without crashing the scan cycle.
   */
  readonly getPoolData: (poolAddress: string) => Effect.Effect<MeteoraPoolStats | null, never>;
}

export class MeteoraDatapiService extends Context.Service<MeteoraDatapiService, MeteoraDatapiApi>()(
  "MeteoraDatapiService",
) {}

// ─── GeckoTerminal Service ───────────────────────────────────────────────────

export interface GeckoTerminalApi {
  /**
   * Fetch real stats for one pool from GeckoTerminal. Never fails: on any
   * network/HTTP/schema error the underlying client logs a warning and returns
   * null so callers fall through to the heuristic without crashing the scan
   * cycle. `baseFeeRate` is the pool's binStep-derived base-fee fraction
   * (the consumer computes `0.0025 + binStep / 1e4`) used to price REAL volume
   * into fees — gecko's own `pool_fee_percentage` is null for every CL pool.
   * The ≥2.1s request pacing is an HTTP-client concern that correctly stays in
   * the live layer, not here.
   */
  readonly getPoolStats: (
    poolAddress: string,
    baseFeeRate: number,
  ) => Effect.Effect<GeckoPoolStats | null, never>;
}

export class GeckoTerminalService extends Context.Service<GeckoTerminalService, GeckoTerminalApi>()(
  "GeckoTerminalService",
) {}

// ─── Pyth Price Service ──────────────────────────────────────────────────────

export interface PythPriceApi {
  /**
   * Fetch a USD price for one Pyth feed ID from Hermes. Never fails: on any
   * network/HTTP/schema error, or a publish_time older than the configured
   * staleness window, the underlying client logs a warning and returns null so
   * callers fall back to their own price source without crashing the scan
   * cycle. Results are TTL-cached inside the module (~30s) so a tight loop of
   * consumers shares one Hermes request. This is SERVICE-ONLY: nothing in the
   * decision loop consumes it yet (consumer wiring — trailing-stop marks, HODL
   * benchmark, hedge marks — is a deliberate follow-up).
   */
  readonly getPythPriceUsd: (feedId: string) => Effect.Effect<number | null, never>;
  /**
   * Resolve a symbol (SOL, USDC, USDT — the built-in map) to its verified
   * mainnet feed ID and fetch its USD price. Unknown symbol → null, no fetch.
   */
  readonly getPriceBySymbol: (symbol: string) => Effect.Effect<number | null, never>;
  /** Convenience wrapper: SOL/USD via the verified mainnet feed ID. */
  readonly getSolPriceUsd: () => Effect.Effect<number | null, never>;
}

export class PythPriceService extends Context.Service<PythPriceService, PythPriceApi>()(
  "PythPriceService",
) {}

// ─── Memory Service ──────────────────────────────────────────────────────────

export interface MemoryApi {
  readonly initialize: () => Effect.Effect<void, Error>;
  readonly upsert: (
    entry: Omit<MemoryEntry, "id" | "createdAt" | "expiresAt">,
  ) => Effect.Effect<void, Error>;
  readonly getRelevantContext: (
    query: string,
    topK?: number,
    poolAddress?: string,
  ) => Effect.Effect<ReadonlyArray<MemoryEntry>, Error>;
  readonly pruneExpired: () => Effect.Effect<number, Error>;
  readonly recordOutcome: (
    poolAddress: string,
    action: string,
    pnlUsd: number,
    context: string,
  ) => Effect.Effect<void, Error>;
}

export class MemoryService extends Context.Service<MemoryService, MemoryApi>()("MemoryService") {}

// ─── Risk Service ────────────────────────────────────────────────────────────

export interface RiskContext {
  readonly openPositions: ReadonlyArray<Position>;
  readonly portfolioValueUsd: number;
  readonly recentPnlUsd: number;
  readonly poolAddress: string;
  readonly originalDecision?: AgentDecision;
  /** Current pool active bin; used to reject REBALANCE ranges that miss the market. */
  readonly activeBinId?: number;
  /**
   * Identity of the position the decision targets (Position.id). When set,
   * position-bound gates (stop-loss) match it instead of falling back to the
   * first position on the pool — required when a pool holds multiple
   * positions.
   */
  readonly positionId?: string | undefined;
}

export interface RiskResult {
  readonly approved: boolean;
  readonly reason: string;
  readonly adjustedSizeUsd?: number;
}

export interface RiskApi {
  readonly evaluate: (decision: AgentDecision, ctx: RiskContext) => RiskResult;
}

export class RiskService extends Context.Service<RiskService, RiskApi>()("RiskService") {}

// ─── Blacklist Service ───────────────────────────────────────────────────────

export interface BlacklistApi {
  readonly isDeployerBlacklisted: (deployer: string) => boolean;
  readonly isTokenBlacklisted: (mint: string) => boolean;
  readonly checkPool: (
    poolAddress: string,
    tokenXMint: string,
    tokenYMint: string,
    tokenXDeployer?: string,
    tokenYDeployer?: string,
  ) => Effect.Effect<void, Error>;
}

export class BlacklistService extends Context.Service<BlacklistService, BlacklistApi>()(
  "BlacklistService",
) {}

// ─── Audit Service ───────────────────────────────────────────────────────────

export interface DecisionRecord {
  readonly timestamp: number;
  readonly cycleId: string;
  readonly poolAddress: string;
  readonly action: string;
  readonly confidence: number;
  readonly reasoning: string;
  readonly metrics?: PoolMetrics | undefined;
  readonly riskResult: RiskResult;
  readonly executed: boolean;
  readonly paperTrading: boolean;
  readonly txSignature?: string | undefined;
  readonly error?: string | undefined;
}

export interface AuditApi {
  readonly recordDecision: (record: DecisionRecord) => Effect.Effect<void, Error>;
  readonly getRecentDecisions: (
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<DecisionRecord>, Error>;
}

export class AuditService extends Context.Service<AuditService, AuditApi>()("AuditService") {}

// ─── Screener Service ────────────────────────────────────────────────────────

export interface ScreenedPool {
  readonly address: string;
  readonly tvlUsd: number;
  readonly volume24hUsd: number;
  readonly fees24hUsd: number;
  readonly apr: number;
  readonly feeIlRatio: number;
  readonly volumeAuth: number;
  readonly binUtilization: number;
  readonly tokenX: string;
  readonly tokenY: string;
  readonly createdAtMs?: number;
}

export interface ScreenerApi {
  readonly screenPools: (scanOrdinal?: number) => Effect.Effect<ReadonlyArray<ScreenedPool>, Error>;
}

export class ScreenerService extends Context.Service<ScreenerService, ScreenerApi>()(
  "ScreenerService",
) {}

// ─── Database Service ────────────────────────────────────────────────────────

export interface DbApi {
  readonly db: unknown;
  /**
   * Positions are keyed by position identity, not pool address: the on-chain
   * position pubkey for live positions, a stable synthetic `paper-…` id for
   * paper positions. A pool may hold multiple positions; every per-position
   * method below takes the position id.
   */
  readonly savePosition: (pos: {
    positionId: string;
    poolAddress: string;
    positionPubKey: string | null;
    depositedUsd: number;
    currentValueUsd: number;
    tokenXSymbol: string;
    tokenYSymbol: string;
    activeBinId: number;
    lowerBinId: number;
    upperBinId: number;
    timestamp: number;
    outOfRangeSince: number | null;
    oorCycleCount: number;
    lastFeeClaimAt: number;
    trailingStopThreshold: number | null;
    highestValueUsd: number | null;
    lastRebalanceAt: number;
    paperExitedAt: number | null;
    entrySignalTimestamp: number | null;
    entrySignalSnapshotId: number | null;
    entryPriceUsd: number | null;
    entryAmountXUsd: number | null;
    entryAmountYUsd: number | null;
    cumulativeFeesClaimedUsd: number;
    cumulativeRewardsClaimedUsd: number;
    closedAt: number | null;
    realizedPnlUsd: number | null;
    /** Fallen-angel lifecycle state (Wave 19); optional so legacy callers compile. */
    positionMode?: string | null;
    tpLadderJson?: string | null;
    invalidationStopPrice?: number | null;
  }) => Effect.Effect<void, Error>;
  readonly getPosition: (positionId: string) => Effect.Effect<
    {
      positionId: string;
      poolAddress: string;
      positionPubKey: string | null;
      depositedUsd: number;
      currentValueUsd: number;
      tokenXSymbol: string;
      tokenYSymbol: string;
      activeBinId: number;
      lowerBinId: number;
      upperBinId: number;
      timestamp: number;
      outOfRangeSince: number | null;
      oorCycleCount: number;
      lastFeeClaimAt: number;
      trailingStopThreshold: number | null;
      highestValueUsd: number | null;
      lastRebalanceAt: number;
      paperExitedAt: number | null;
      entrySignalTimestamp: number | null;
      entrySignalSnapshotId: number | null;
      entryPriceUsd: number | null;
      entryAmountXUsd: number | null;
      entryAmountYUsd: number | null;
      cumulativeFeesClaimedUsd: number;
      cumulativeRewardsClaimedUsd: number;
      closedAt: number | null;
      realizedPnlUsd: number | null;
      positionMode?: string | null;
      tpLadderJson?: string | null;
      invalidationStopPrice?: number | null;
    } | null,
    Error
  >;
  readonly getAllPositions: () => Effect.Effect<
    ReadonlyArray<{
      positionId: string;
      poolAddress: string;
      positionPubKey: string | null;
      depositedUsd: number;
      currentValueUsd: number;
      tokenXSymbol: string;
      tokenYSymbol: string;
      activeBinId: number;
      lowerBinId: number;
      upperBinId: number;
      timestamp: number;
      outOfRangeSince: number | null;
      oorCycleCount: number;
      lastFeeClaimAt: number;
      trailingStopThreshold: number | null;
      highestValueUsd: number | null;
      lastRebalanceAt: number;
      paperExitedAt: number | null;
      entrySignalTimestamp: number | null;
      entrySignalSnapshotId: number | null;
      entryPriceUsd: number | null;
      entryAmountXUsd: number | null;
      entryAmountYUsd: number | null;
      cumulativeFeesClaimedUsd: number;
      cumulativeRewardsClaimedUsd: number;
      closedAt: number | null;
      realizedPnlUsd: number | null;
      positionMode?: string | null;
      tpLadderJson?: string | null;
      invalidationStopPrice?: number | null;
    }>,
    Error
  >;
  readonly getPaperExitedPositions: () => Effect.Effect<
    ReadonlyArray<{
      positionId: string;
      poolAddress: string;
      positionPubKey: string | null;
      depositedUsd: number;
      currentValueUsd: number;
      tokenXSymbol: string;
      tokenYSymbol: string;
      activeBinId: number;
      lowerBinId: number;
      upperBinId: number;
      timestamp: number;
      outOfRangeSince: number | null;
      oorCycleCount: number;
      lastFeeClaimAt: number;
      trailingStopThreshold: number | null;
      highestValueUsd: number | null;
      lastRebalanceAt: number;
      paperExitedAt: number | null;
      entrySignalTimestamp: number | null;
      entrySignalSnapshotId: number | null;
      entryPriceUsd: number | null;
      entryAmountXUsd: number | null;
      entryAmountYUsd: number | null;
      cumulativeFeesClaimedUsd: number;
      cumulativeRewardsClaimedUsd: number;
      closedAt: number | null;
      realizedPnlUsd: number | null;
      positionMode?: string | null;
      tpLadderJson?: string | null;
      invalidationStopPrice?: number | null;
    }>,
    Error
  >;
  readonly deletePosition: (positionId: string) => Effect.Effect<void, Error>;
  readonly markPaperExited: (positionId: string) => Effect.Effect<void, Error>;
  readonly closePosition: (
    positionId: string,
    realizedPnlUsd: number | null,
  ) => Effect.Effect<void, Error>;
  readonly finalizeSettlementGroup: (input: {
    readonly positionId: string;
    readonly realizedPnlUsd: number | null;
    readonly jobIds: ReadonlyArray<string>;
    readonly finalizedAt: number;
    readonly signalSnapshotId: number | null;
  }) => Effect.Effect<void, Error>;
  readonly getClosedPositions: () => Effect.Effect<
    ReadonlyArray<{
      positionId: string;
      poolAddress: string;
      positionPubKey: string | null;
      depositedUsd: number;
      currentValueUsd: number;
      tokenXSymbol: string;
      tokenYSymbol: string;
      activeBinId: number;
      lowerBinId: number;
      upperBinId: number;
      timestamp: number;
      outOfRangeSince: number | null;
      oorCycleCount: number;
      lastFeeClaimAt: number;
      trailingStopThreshold: number | null;
      highestValueUsd: number | null;
      lastRebalanceAt: number;
      paperExitedAt: number | null;
      entrySignalTimestamp: number | null;
      entrySignalSnapshotId: number | null;
      entryPriceUsd: number | null;
      entryAmountXUsd: number | null;
      entryAmountYUsd: number | null;
      cumulativeFeesClaimedUsd: number;
      cumulativeRewardsClaimedUsd: number;
      closedAt: number | null;
      realizedPnlUsd: number | null;
      positionMode?: string | null;
      tpLadderJson?: string | null;
      invalidationStopPrice?: number | null;
    }>,
    Error
  >;
  readonly savePositionEvent: (event: {
    id: string;
    poolAddress: string;
    positionPubKey: string | null;
    positionId: string | null;
    event: "ENTER" | "EXIT" | "REBALANCE" | "CLAIM" | "COMPOUND";
    valueUsd: number | null;
    feesUsd: number | null;
    price: number | null;
    metadata?: Record<string, unknown> | null;
    createdAt: number;
  }) => Effect.Effect<void, Error>;
  readonly getPositionEvents: (
    poolAddress: string,
    limit?: number,
  ) => Effect.Effect<
    ReadonlyArray<{
      id: string;
      poolAddress: string;
      positionPubKey: string | null;
      positionId: string | null;
      event: "ENTER" | "EXIT" | "REBALANCE" | "CLAIM" | "COMPOUND";
      valueUsd: number | null;
      feesUsd: number | null;
      price: number | null;
      metadata: string | null;
      createdAt: number;
    }>,
    Error
  >;
  readonly getLatestSnapshotPrice: (poolAddress: string) => Effect.Effect<number | null, Error>;
  readonly updatePositionValue: (
    positionId: string,
    currentValueUsd: number,
    highestValueUsd?: number,
  ) => Effect.Effect<void, Error>;
  readonly saveAudit: (record: {
    id: string;
    timestamp: number;
    cycleId: string;
    poolAddress: string;
    action: string;
    confidence: number;
    reasoning: string;
    metricsJson: string | null;
    riskResultJson: string | null;
    executed: boolean;
    paperTrading: boolean;
    txSignature: string | null;
    error: string | null;
  }) => Effect.Effect<void, Error>;
  readonly getRecentAudit: (limit: number) => Effect.Effect<
    ReadonlyArray<{
      id: string;
      timestamp: number;
      cycleId: string;
      poolAddress: string;
      action: string;
      confidence: number;
      reasoning: string;
      metricsJson: string | null;
      riskResultJson: string | null;
      executed: boolean;
      paperTrading: boolean;
      txSignature: string | null;
      error: string | null;
    }>,
    Error
  >;
  readonly cacheBlacklist: (
    type: "deployer" | "token",
    values: ReadonlyArray<string>,
  ) => Effect.Effect<void, Error>;
  readonly isBlacklisted: (
    type: "deployer" | "token",
    value: string,
  ) => Effect.Effect<boolean, Error>;
  readonly insertMemory: (entry: {
    content: string;
    category: MemoryCategory;
    poolAddress?: string | undefined;
    outcome?: MemoryEntry["outcome"];
    pnlUsd?: number | undefined;
    confidence?: number | undefined;
  }) => Effect.Effect<void, Error>;
  readonly queryMemory: (
    queryText: string,
    topK: number,
    poolAddress?: string,
  ) => Effect.Effect<ReadonlyArray<MemoryEntry>, Error>;
  readonly pruneMemory: () => Effect.Effect<number, Error>;
  readonly saveSnapshot: (snapshot: PoolSnapshot) => Effect.Effect<void, Error>;
  readonly getSnapshots: (
    poolAddress: string,
    startMs: number,
    endMs: number,
  ) => Effect.Effect<ReadonlyArray<PoolSnapshot>, Error>;
  readonly getSnapshotPools: () => Effect.Effect<ReadonlyArray<string>, Error>;
  readonly getSnapshotCount: (poolAddress: string) => Effect.Effect<number, Error>;
  readonly pruneSnapshots: (olderThanMs: number) => Effect.Effect<number, Error>;
  readonly saveFeedback: (entry: {
    id: string;
    agentId: string;
    category: string;
    severity: string;
    summary: string;
    details: string | null;
    relatedFiles: ReadonlyArray<string>;
    contextJson: string;
    githubIssueNumber: number | null;
    githubIssueUrl: string | null;
    reportedAt: number;
    hash: string;
  }) => Effect.Effect<void, Error>;
  readonly getFeedbackByHash: (
    hash: string,
    agentId: string,
  ) => Effect.Effect<
    {
      id: string;
      agentId: string;
      category: string;
      severity: string;
      summary: string;
      details: string | null;
      relatedFiles: ReadonlyArray<string>;
      contextJson: string;
      githubIssueNumber: number | null;
      githubIssueUrl: string | null;
      reportedAt: number;
      hash: string;
    } | null,
    Error
  >;
  readonly getRecentFeedbackForAgent: (
    agentId: string,
    sinceMs: number,
  ) => Effect.Effect<
    ReadonlyArray<{
      id: string;
      agentId: string;
      category: string;
      severity: string;
      summary: string;
      details: string | null;
      relatedFiles: ReadonlyArray<string>;
      contextJson: string;
      githubIssueNumber: number | null;
      githubIssueUrl: string | null;
      reportedAt: number;
      hash: string;
    }>,
    Error
  >;
  readonly getLastFeedbackForAgent: (agentId: string) => Effect.Effect<
    {
      id: string;
      agentId: string;
      category: string;
      severity: string;
      summary: string;
      details: string | null;
      relatedFiles: ReadonlyArray<string>;
      contextJson: string;
      githubIssueNumber: number | null;
      githubIssueUrl: string | null;
      reportedAt: number;
      hash: string;
    } | null,
    Error
  >;
  readonly listFeedbackForAgent: (agentId: string) => Effect.Effect<
    ReadonlyArray<{
      id: string;
      agentId: string;
      category: string;
      severity: string;
      summary: string;
      details: string | null;
      relatedFiles: ReadonlyArray<string>;
      contextJson: string;
      githubIssueNumber: number | null;
      githubIssueUrl: string | null;
      reportedAt: number;
      hash: string;
    }>,
    Error
  >;
  readonly getMetadata: (key: string) => Effect.Effect<string | null, Error>;
  readonly setMetadata: (key: string, value: string) => Effect.Effect<void, Error>;
  /** Delete a metadata row if present (used by `prism config unset`). */
  readonly deleteMetadata: (key: string) => Effect.Effect<void, Error>;
  readonly setMetadataBatch: (
    entries: ReadonlyArray<{ key: string; value: string }>,
  ) => Effect.Effect<void, Error>;

  readonly saveFeeClaim: (claim: {
    id: string;
    poolAddress: string;
    positionPubkey: string;
    feeX: number;
    feeY: number;
    platformFeeX: number;
    platformFeeY: number;
    netFeeX: number;
    netFeeY: number;
    operatorFeeX?: number;
    operatorFeeY?: number;
    txSignature: string | null;
    feeTransferTxSignature: string | null;
    reportedToApi: boolean;
    createdAt: number;
  }) => Effect.Effect<void, Error>;

  readonly getUnreportedFeeClaims: () => Effect.Effect<
    ReadonlyArray<{
      id: string;
      poolAddress: string;
      positionPubkey: string;
      feeX: number;
      feeY: number;
      platformFeeX: number;
      platformFeeY: number;
      txSignature: string | null;
      feeTransferTxSignature: string | null;
      createdAt: number;
    }>,
    Error
  >;

  readonly markFeeClaimReported: (id: string) => Effect.Effect<void, Error>;

  readonly saveSignalSnapshot: (snapshot: SignalSnapshot) => Effect.Effect<number, Error>;
  readonly getSignalSnapshots: (
    poolAddress: string,
    startMs: number,
    endMs: number,
  ) => Effect.Effect<
    ReadonlyArray<
      SignalSnapshot & { outcomePnlUsd: number | null; outcomeRecordedAt: number | null }
    >,
    Error
  >;
  readonly recordSignalOutcome: (snapshotId: number, pnlUsd: number) => Effect.Effect<void, Error>;
  readonly getRecentOutcomes: (limit: number) => Effect.Effect<
    ReadonlyArray<{
      poolAddress: string;
      timestamp: number;
      feeIlRatio: number;
      volumeAuthenticity: number;
      binUtilization: number;
      tvlUsd: number;
      tvlVelocity: number;
      volatilityStddev: number;
      binStep: number;
      action: string;
      confidence: number;
      outcomePnlUsd: number | null;
      outcomeRecordedAt: number | null;
    }>,
    Error
  >;

  readonly getEvolvedThresholds: () => Effect.Effect<EvolvableThresholds | null, Error>;
  readonly saveEvolvedThresholds: (thresholds: EvolvableThresholds) => Effect.Effect<void, Error>;
  readonly getClosedPositionOutcomes: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<OutcomeRecord>, Error>;

  readonly getSignalWeights: () => Effect.Effect<SignalWeights | null, Error>;
  readonly saveSignalWeights: (weights: SignalWeights) => Effect.Effect<void, Error>;

  readonly getPoolCooldown: (poolAddress: string) => Effect.Effect<PoolCooldown | null, Error>;
  readonly setPoolCooldown: (cooldown: PoolCooldown) => Effect.Effect<void, Error>;
  readonly clearPoolCooldown: (poolAddress: string) => Effect.Effect<void, Error>;

  readonly saveTokenCandidate: (candidate: TokenCandidateRecord) => Effect.Effect<void, Error>;
  readonly getTokenCandidate: (id: string) => Effect.Effect<TokenCandidateRecord | null, Error>;
  readonly listTokenCandidates: (
    walletAddress: string,
    agentInstanceId: string,
  ) => Effect.Effect<ReadonlyArray<TokenCandidateRecord>, Error>;

  readonly saveExecutionOperation: (
    operation: ExecutionOperationRecord,
  ) => Effect.Effect<void, Error>;
  readonly getExecutionOperation: (
    id: string,
  ) => Effect.Effect<ExecutionOperationRecord | null, Error>;
  readonly listExecutionOperations: (
    walletAddress: string,
    agentInstanceId: string,
  ) => Effect.Effect<ReadonlyArray<ExecutionOperationRecord>, Error>;

  readonly saveSettlementJob: (job: SettlementJobRecord) => Effect.Effect<void, Error>;
  readonly getSettlementJob: (id: string) => Effect.Effect<SettlementJobRecord | null, Error>;
  readonly listSettlementJobs: (
    walletAddress: string,
    agentInstanceId: string,
  ) => Effect.Effect<ReadonlyArray<SettlementJobRecord>, Error>;

  readonly saveSafetyPause: (pause: SafetyPauseRecord) => Effect.Effect<void, Error>;
  readonly getSafetyPause: (
    walletAddress: string,
    agentInstanceId: string,
  ) => Effect.Effect<SafetyPauseRecord | null, Error>;
}

export class DbService extends Context.Service<DbService, DbApi>()("DbService") {}

// ─── Feedback Service ───────────────────────────────────────────────────────

export type FeedbackCategory = "friction" | "suggestion" | "observation" | "praise";
export type FeedbackSeverity = "low" | "medium" | "high";

export interface FeedbackContext {
  readonly prismVersion: string;
  readonly installMethod: string;
  readonly platform: string;
  readonly runtime: string;
  readonly nodeVersion?: string;
}

export interface AgentFeedback {
  readonly category: FeedbackCategory;
  readonly severity: FeedbackSeverity;
  readonly summary: string;
  readonly details?: string;
  readonly context?: FeedbackContext;
  readonly relatedFiles?: ReadonlyArray<string>;
}

export type FeedbackResult =
  | { kind: "rate_limited"; reason: string }
  | { kind: "opt_out" }
  | { kind: "local_only"; localId: string }
  | { kind: "cloud"; id: string; duplicate?: boolean }
  | { kind: "error"; error: string };

export interface FeedbackEntry {
  readonly id: string;
  readonly agentId: string;
  readonly category: FeedbackCategory;
  readonly severity: FeedbackSeverity;
  readonly summary: string;
  readonly details: string | null;
  readonly relatedFiles: ReadonlyArray<string>;
  readonly contextJson: string;
  readonly githubIssueNumber: number | null;
  readonly githubIssueUrl: string | null;
  readonly reportedAt: number;
  readonly hash: string;
}

export interface FeedbackApi {
  readonly submit: (feedback: AgentFeedback) => Effect.Effect<FeedbackResult, Error>;
  readonly list: () => Effect.Effect<ReadonlyArray<FeedbackEntry>, Error>;
  readonly listForAgent: (agentId: string) => Effect.Effect<ReadonlyArray<FeedbackEntry>, Error>;
  readonly getByHash: (hash: string) => Effect.Effect<FeedbackEntry | null, Error>;
  readonly setOptOut: (optOut: boolean) => Effect.Effect<void, Error>;
  readonly getOptOut: () => Effect.Effect<boolean, Error>;
}

export class FeedbackService extends Context.Service<FeedbackService, FeedbackApi>()(
  "FeedbackService",
) {}

// ─── Referral Service ───────────────────────────────────────────────────────

export interface ReferralApi {
  readonly generateCode: (userId: string) => Effect.Effect<string, Error>;
  readonly validateCode: (
    code: string,
  ) => Effect.Effect<{ valid: boolean; referrerId?: string }, Error>;
  readonly applyReferral: (code: string, refereeId: string) => Effect.Effect<void, Error>;
  readonly getReferralCount: (userId: string) => Effect.Effect<number, Error>;
}

export class ReferralService extends Context.Service<ReferralService, ReferralApi>()(
  "ReferralService",
) {}

// ─── Revenue Service ────────────────────────────────────────────────────────

export interface RevenueApi {
  readonly calculateTier: (walletSol: number, referralCount: number) => string;
  readonly calculatePlatformFee: (
    tier: string,
    feeXAmount: number,
    feeYAmount: number,
    tokenPrices: { x: number; y: number },
  ) => { platformFeeUsd: number; netFeeX: number; netFeeY: number };
  readonly calculateCreditDiscount: (credits: number, feeUsd: number) => number;
}

export class RevenueService extends Context.Service<RevenueService, RevenueApi>()(
  "RevenueService",
) {}

// ─── Revenue Config Service ─────────────────────────────────────────────────

export interface RevenueConfig {
  readonly tier: string;
  readonly platformFeeRate: number;
  readonly revenueShareEnabled: boolean;
  readonly revenueShareOperatorPct: number;
  readonly feeWalletAddress: string;
}

export interface RevenueConfigApi {
  readonly getConfig: () => Effect.Effect<RevenueConfig, never>;
  readonly refreshConfig: () => Effect.Effect<RevenueConfig, never>;
}

export class RevenueConfigService extends Context.Service<RevenueConfigService, RevenueConfigApi>()(
  "RevenueConfigService",
) {}

// ─── Agent Service (agentic-mode overlay) ──────────────────────────────────

export interface AgentApi {
  readonly enhanceDecision: (
    decision: AgentDecision,
    context: AgentRuntimeContext,
  ) => Effect.Effect<AgentDecision | null, Error>;
  /** True when the rolling proposal-latency window says sync prompts should
   *  be skipped this cycle (fail-open: the caller skips WITHOUT arming
   *  backoff or circuit failure). */
  readonly shouldSkipSyncProposal: () => Effect.Effect<boolean, never>;
  readonly getPolicy: () => Effect.Effect<AgentPolicySnapshot, Error>;
  readonly sendCheckin: (checkin: AgentRuntimeCheckin) => Effect.Effect<void, Error>;
  readonly sendAlert: (alert: AgentRuntimeAlert) => Effect.Effect<void, Error>;
  readonly getStatus: () => Effect.Effect<
    {
      readonly connected: boolean;
      readonly transport: string | null;
      readonly lastPromptAt: number | null;
      readonly errorCount: number;
    },
    Error
  >;
  readonly disconnect: () => Effect.Effect<void, Error>;
}

export class AgentService extends Context.Service<AgentService, AgentApi>()("AgentService") {}

// ─── Agent State Service (shared mutable state for MCP/HTTP servers) ─────────

/** Result of attempting to enqueue an agent proposal into the in-memory queue. */
export type EnqueueProposalResult =
  | { readonly status: "enqueued" }
  | { readonly status: "replaced"; readonly replacedIds: ReadonlyArray<string> }
  | {
      readonly status: "rejected";
      readonly reason: "queue_full" | "approved_exists";
    };

export interface AgentStateApi {
  readonly getSnapshot: () => Effect.Effect<PrismStateSnapshot, never>;
  readonly updateSnapshot: (patch: Partial<PrismStateSnapshot>) => Effect.Effect<void, never>;
  readonly setAgentPolicy: (patch: Partial<AgentPolicySnapshot>) => Effect.Effect<void, never>;
  readonly enqueueProposal: (
    proposal: AgentProposal,
  ) => Effect.Effect<EnqueueProposalResult, never>;
  readonly dequeueProposals: (proposalIds: ReadonlyArray<string>) => Effect.Effect<void, never>;
  readonly approveProposal: (proposalId: string) => Effect.Effect<void, never>;
  readonly rejectProposal: (proposalId: string) => Effect.Effect<void, never>;
}

export class AgentStateService extends Context.Service<AgentStateService, AgentStateApi>()(
  "AgentStateService",
) {}

// ─── Alert Service (proactive Telegram push alerts) ─────────────────────────

export type AlertType =
  | "position_out_of_range"
  | "range_warning"
  | "exit_executed"
  | "risk_rejection"
  | "fee_milestone"
  | "stablecoin_depeg"
  | "liquidity_drain"
  | "il_dominance";

export type AlertSeverity = "info" | "warning" | "critical";

export interface EngineAlert {
  readonly type: AlertType;
  readonly severity: AlertSeverity;
  readonly message: string;
  readonly poolAddress?: string;
  /**
   * Position identity for position-originated alerts (OOR, range warning,
   * per-position exits). Included in the cooldown key so two positions on
   * the same pool throttle independently.
   */
  readonly positionId?: string;
  readonly data?: Record<string, unknown>;
}

export interface AlertApi {
  /**
   * Send an alert to the user's linked Telegram via Prism Cloud. Applies
   * per-rule cooldowns (persisted in SQLite) and never fails: delivery errors
   * are logged and swallowed so a scan cycle is never blocked on alerts.
   */
  readonly sendAlert: (alert: EngineAlert) => Effect.Effect<void, never>;
  /**
   * Accumulate claimed fees (USD) and emit a fee_milestone alert each time the
   * running total crosses the next configured milestone. State is persisted.
   */
  readonly recordFeeClaim: (poolAddress: string, feeUsd: number) => Effect.Effect<void, never>;
}

export class AlertService extends Context.Service<AlertService, AlertApi>()("AlertService") {}

export class CopySignalService extends Context.Service<CopySignalService, CopySignalApi>()(
  "CopySignalService",
) {}

// ─── MCP Server Service ──────────────────────────────────────────────────────

export interface McpServerApi {
  readonly start: () => Effect.Effect<void, Error>;
  readonly stop: () => Effect.Effect<void, Error>;
}

export class McpServerService extends Context.Service<McpServerService, McpServerApi>()(
  "McpServerService",
) {}

// ─── HTTP Status Server Service ──────────────────────────────────────────────

export interface HttpStatusServerApi {
  readonly start: () => Effect.Effect<void, Error>;
  readonly stop: () => Effect.Effect<void, Error>;
}

export class HttpStatusServerService extends Context.Service<
  HttpStatusServerService,
  HttpStatusServerApi
>()("HttpStatusServerService") {}
