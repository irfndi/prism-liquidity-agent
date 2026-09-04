import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import DLMM, {
  buildLiquidityStrategyParameters,
  getLiquidityStrategyParameterBuilder,
  ConcreteFunctionType,
  StrategyType,
  MAX_ACTIVE_BIN_SLIPPAGE,
  type BinLiquidity,
  type PositionData,
  type RebalanceWithDeposit,
  type RebalanceWithWithdraw,
  type RebalancePositionResponse,
  type StrategyParameters,
} from "@meteora-ag/dlmm";
import { BN } from "@coral-xyz/anchor";
import { Duration, Effect, Layer } from "effect";
import {
  AdapterService,
  type AdapterApi,
  type DiscoveredPool,
  type PreparedSwap,
  type SwapQuote,
  type SwapRequest,
  type SwapSimulation,
  type SwapStatus,
} from "./services.js";
import { ConfigService } from "./config-service.js";
import { DbService } from "./services.js";
import {
  deserializeCache,
  loadPersistedCache,
  savePersistedCache,
  type CacheEntry,
} from "./token-metadata-cache.js";
import {
  effectGetOpenPositions,
  PositionCrawlCache,
  type OpenPosition,
} from "./datapi-position-service.js";
import { AdapterError, underlyingErrorMessage } from "./errors.js";
import { DiscoverPoolsError } from "./errors.js";
import { SwapQuoteError, SwapValidationError } from "./errors.js";
import { createLogger } from "./logger.js";
import { getPrismUserConfigDir } from "./paths.js";
import type { BinData, EntryDepositMode, EntryStrategySpec } from "./types.js";
import { CircuitBreaker, isRpcNetworkError, retryEffectWithBackoff } from "./adapter-retry.js";
import { jupiterFetch } from "./jupiter-client.js";
import bs58 from "bs58";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { getWalletSystemLamportsRequired } from "./live-entry-budget.js";
import { SOL_MINT, USDC_MINT, GAS_RESERVE_LAMPORTS } from "./constants.js";
import { computeRequiredAtomic } from "./entry-prep-service.js";
import type { ClaimedReward } from "./rewards.js";
import { validateLimitOrderRequest, type LimitOrderRequest } from "./limit-orders.js";
import { buildMeteoraDiscoveryPageUrl, selectRecurringDiscoveryPage } from "./discovery-policy.js";
/** Resolve the configured page_size from a discovery URL; null when absent or malformed. */
function safeMeteoraPageSize(baseUrl: string): number | null {
  try {
    const configured = Number(new URL(baseUrl).searchParams.get("page_size") ?? 1000);
    return Number.isSafeInteger(configured) && configured > 0 ? configured : null;
  } catch {
    return null;
  }
}
function buildMarketScanPageUrl(baseUrl: string, page: number, sortByFee: boolean): string | null {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", "1000");
    if (sortByFee) url.searchParams.set("sort_by", "fee_tvl_ratio_24h:desc");
    return url.toString();
  } catch {
    return null;
  }
}

import { scoreWashEvidence, type WashTradeRow } from "./wash-forensics.js";

const DEFAULT_PUBLIC_KEY = "11111111111111111111111111111111";

type AtomicValue = { toString(): string };

export interface MeteoraDlmmPositionData {
  readonly totalXAmount: string;
  readonly totalYAmount: string;
  readonly totalXAmountExcludeTransferFee: BN;
  readonly totalYAmountExcludeTransferFee: BN;
  readonly lowerBinId: number;
  readonly upperBinId: number;
  readonly feeX: BN;
  readonly feeY: BN;
  readonly feeXExcludeTransferFee: BN;
  readonly feeYExcludeTransferFee: BN;
  readonly rewardOne: BN;
  readonly rewardTwo: BN;
  readonly rewardOneExcludeTransferFee: BN;
  readonly rewardTwoExcludeTransferFee: BN;
  readonly lastUpdatedAt: number;
}

export interface MeteoraDlmmPosition {
  readonly publicKey: PublicKey;
  readonly positionData: MeteoraDlmmPositionData;
}

export interface MeteoraDlmmBinsAround {
  readonly activeBin: number;
  readonly bins: Array<{
    readonly binId: number;
    readonly price: string;
    readonly pricePerToken?: string;
    readonly xAmount: AtomicValue;
    readonly yAmount: AtomicValue;
    readonly supply: AtomicValue;
  }>;
}

interface MeteoraDlmmRebalanceSimulation {
  readonly binArrayCost: number;
  readonly bitmapExtensionCost: number;
  readonly binArrayCount: number;
  readonly rebalancePosition: { readonly address: PublicKey };
  readonly simulationResult: { readonly actualAmountXDeposited: BN };
}

/** The subset of the Meteora client used by the adapter runtime. */
export interface MeteoraDlmmClient {
  readonly lbPair: {
    readonly activeId: number;
    readonly binStep: number;
    readonly tokenXMint: PublicKey;
    readonly tokenYMint: PublicKey;
    readonly reserveX: PublicKey;
    readonly reserveY: PublicKey;
    readonly rewardInfos: ReadonlyArray<{ readonly mint: PublicKey; readonly vault?: PublicKey }>;
    readonly concreteFunctionType?: number;
  };
  readonly tokenX: { readonly publicKey: PublicKey; readonly mint: { readonly decimals: number } };
  readonly tokenY: { readonly publicKey: PublicKey; readonly mint: { readonly decimals: number } };
  readonly getActiveBin: (...args: Parameters<DLMM["getActiveBin"]>) => Promise<{
    readonly binId: number;
    readonly price: string;
    readonly pricePerToken?: string;
  }>;
  readonly getBinsAroundActiveBin: (
    ...args: Parameters<DLMM["getBinsAroundActiveBin"]>
  ) => Promise<MeteoraDlmmBinsAround>;
  readonly getPosition: (...args: Parameters<DLMM["getPosition"]>) => Promise<MeteoraDlmmPosition>;
  readonly getPositionsByUserAndLbPair: (
    ...args: Parameters<DLMM["getPositionsByUserAndLbPair"]>
  ) => Promise<{ readonly userPositions: ReadonlyArray<MeteoraDlmmPosition> }>;
  readonly refetchStates: (...args: Parameters<DLMM["refetchStates"]>) => Promise<void>;
  simulateRebalancePosition(
    positionAddress: PublicKey,
    positionData: MeteoraDlmmPositionData,
    shouldClaimFee: boolean,
    shouldClaimReward: boolean,
    deposits: RebalanceWithDeposit[],
    withdraws: RebalanceWithWithdraw[],
  ): Promise<{
    readonly binArrayCost: number;
    readonly bitmapExtensionCost: number;
    readonly binArrayCount: number;
    readonly rebalancePosition: { readonly address: PublicKey };
    readonly simulationResult: { readonly actualAmountXDeposited: BN };
  }>;
  rebalancePosition(
    simulation: {
      readonly binArrayCost: number;
      readonly bitmapExtensionCost: number;
      readonly binArrayCount: number;
      readonly rebalancePosition: { readonly address: PublicKey };
      readonly simulationResult: { readonly actualAmountXDeposited: BN };
    },
    maxActiveBinSlippage: BN,
    rentPayer?: PublicKey,
    slippage?: number,
  ): Promise<{
    readonly initBinArrayInstructions: ReadonlyArray<TransactionInstruction>;
    readonly rebalancePositionInstruction: ReadonlyArray<TransactionInstruction>;
  }>;
  readonly initializePositionAndAddLiquidityByStrategy: (
    ...args: Parameters<DLMM["initializePositionAndAddLiquidityByStrategy"]>
  ) => Promise<Transaction>;
  readonly removeLiquidity: (
    ...args: Parameters<DLMM["removeLiquidity"]>
  ) => Promise<Transaction[]>;
  closePositionIfEmpty(args: {
    owner: PublicKey;
    position: MeteoraDlmmPosition;
  }): Promise<Transaction | null>;
  claimSwapFee(args: { owner: PublicKey; position: MeteoraDlmmPosition }): Promise<Transaction[]>;
  claimAllLMRewards(args: {
    owner: PublicKey;
    positions: MeteoraDlmmPosition[];
  }): Promise<Transaction[]>;
  readonly placeLimitOrder: (...args: Parameters<DLMM["placeLimitOrder"]>) => Promise<Transaction>;
  readonly cancelLimitOrder: (
    ...args: Parameters<DLMM["cancelLimitOrder"]>
  ) => Promise<Transaction>;
}

const RPC_RETRY_OPTIONS = {
  maxRetries: 1,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  rateLimitBaseDelayMs: 5_000,
} as const;
const RPC_MIN_INTERVAL_MS = 50;
const RPC_REQUEST_TIMEOUT_MS = 15_000;
const MAX_SWAP_QUOTE_AGE_MS = 30_000;
const HARD_MAX_SWAP_SLIPPAGE_BPS = 50;
const HARD_MAX_SWAP_PRICE_IMPACT_BPS = 100;

// Atomic rebalance (SDK rebalancePosition): the position's full on-chain
// liquidity is withdrawn and redeposited into the target range inside a single
// instruction, so the position account — and its identity — is preserved.
const REBALANCE_WITHDRAW_BPS = 10_000;
// Bounds sim→exec drift on the SDK-quoted deposit/withdraw amounts (percent).
const REBALANCE_SLIPPAGE_PERCENT = 10;
// initializeBinArray instructions are small; a conservative chunk keeps the
// init transaction well under the size limit.
const MAX_INIT_BIN_ARRAY_IXS_PER_TX = 8;

interface AtomicRebalancePlan {
  readonly deposits: RebalanceWithDeposit[];
  readonly withdraws: RebalanceWithWithdraw[];
}

/** Map the engine's entry strategy shape to the Meteora SDK StrategyType. */
export function toSdkStrategyType(strategySpec: EntryStrategySpec): StrategyType {
  switch (strategySpec) {
    case "spot":
      return StrategyType.Spot;
    case "curve":
      return StrategyType.Curve;
    case "bidask":
      return StrategyType.BidAsk;
  }
}

/**
 * Build the withdraw-everything + redeposit-into-target-range parameters for
 * `simulateRebalancePosition`/`rebalancePosition`. Deposit amounts come from
 * the position's real on-chain token amounts plus any explicit top-up
 * (auto-compound redeposits just-claimed fees) — never from paper config.
 */
export function buildAtomicRebalancePlan(args: {
  activeBinId: number;
  binStep: number;
  positionData: Pick<
    MeteoraDlmmPositionData,
    "totalXAmount" | "totalYAmount" | "lowerBinId" | "upperBinId"
  >;
  newLowerBinId: number;
  newUpperBinId: number;
  topUp?: { amountXAtomic: bigint; amountYAtomic: bigint };
}): AtomicRebalancePlan {
  const activeId = new BN(args.activeBinId);
  const minDeltaId = new BN(args.newLowerBinId - args.activeBinId);
  const maxDeltaId = new BN(args.newUpperBinId - args.activeBinId);
  const depositX = new BN(args.positionData.totalXAmount).add(
    new BN((args.topUp?.amountXAtomic ?? 0n).toString()),
  );
  const depositY = new BN(args.positionData.totalYAmount).add(
    new BN((args.topUp?.amountYAtomic ?? 0n).toString()),
  );
  const strategyParameters = buildLiquidityStrategyParameters(
    depositX,
    depositY,
    minDeltaId,
    maxDeltaId,
    new BN(args.binStep),
    false,
    activeId,
    getLiquidityStrategyParameterBuilder(StrategyType.Spot),
  );
  return {
    deposits: [
      {
        minDeltaId,
        maxDeltaId,
        x0: strategyParameters.x0,
        y0: strategyParameters.y0,
        deltaX: strategyParameters.deltaX,
        deltaY: strategyParameters.deltaY,
        favorXInActiveBin: false,
      },
    ],
    withdraws: [
      {
        minBinId: new BN(args.positionData.lowerBinId),
        maxBinId: new BN(args.positionData.upperBinId),
        bps: new BN(REBALANCE_WITHDRAW_BPS),
      },
    ],
  };
}

function formatTokenAmount(amount: bigint, decimals: number): string {
  return (Number(amount) / 10 ** decimals).toFixed(Math.min(decimals, 6));
}
interface EntryDepositPlan {
  readonly depositXAtomic: bigint;
  readonly depositYAtomic: bigint;
  readonly depositMode: EntryDepositMode;
  readonly singleSidedX?: boolean;
  readonly amountXUsd: number;
  readonly amountYUsd: number;
}

interface EntryDepositInput {
  readonly poolAddress: string;
  readonly tokenX: string;
  readonly tokenY: string;
  readonly positionSizeUsd: number;
  readonly priceX: number;
  readonly priceY: number;
  readonly tokenXDecimals: number;
  readonly tokenYDecimals: number;
  readonly requestedXAmount: bigint;
  readonly requestedYAmount: bigint;
  readonly maxX: bigint;
  readonly maxY: bigint;
  readonly xShort: boolean;
  readonly yShort: boolean;
  readonly shortageX: string;
  readonly shortageY: string;
  readonly forceSingleSidedX: boolean;
}

function resolveEntryDeposit(
  input: EntryDepositInput,
): Effect.Effect<EntryDepositPlan, AdapterError> {
  const halfUsd = input.positionSizeUsd / 2;
  if (input.forceSingleSidedX) {
    const fullSizeXAtomic = computeRequiredAtomic(
      input.positionSizeUsd,
      input.priceX,
      input.tokenXDecimals,
    );
    if (fullSizeXAtomic === 0n || fullSizeXAtomic > input.maxX) {
      return Effect.fail(
        new AdapterError({
          message: `Runner single-sided-X entry impossible: available ${formatTokenAmount(input.maxX, input.tokenXDecimals)} is below the full-size requirement ${formatTokenAmount(fullSizeXAtomic, input.tokenXDecimals)} for a $${input.positionSizeUsd} deposit in ${input.tokenX}. Fund the quote leg up to the full position size.`,
          poolAddress: input.poolAddress,
        }),
      );
    }
    return Effect.succeed({
      depositXAtomic: fullSizeXAtomic,
      depositYAtomic: 0n,
      singleSidedX: true,
      depositMode: "single-sided-x",
      amountXUsd: input.positionSizeUsd,
      amountYUsd: 0,
    });
  }
  if (input.xShort && input.yShort) {
    return Effect.fail(
      new AdapterError({
        message: `Insufficient token balance: ${input.shortageX}; ${input.shortageY}. Neither pool token can fund the entry — fund one pool token up to the full position size for a single-sided deposit, or enable AUTO_SWAP_ENTRY with a USDC balance.`,
        poolAddress: input.poolAddress,
      }),
    );
  }
  if (input.xShort || input.yShort) {
    const heldIsX = input.yShort;
    const heldMint = heldIsX ? input.tokenX : input.tokenY;
    const heldDecimals = heldIsX ? input.tokenXDecimals : input.tokenYDecimals;
    const heldPrice = heldIsX ? input.priceX : input.priceY;
    const heldAvailable = heldIsX ? input.maxX : input.maxY;
    const missingShortage = heldIsX ? input.shortageY : input.shortageX;
    const fullSizeAtomic = computeRequiredAtomic(input.positionSizeUsd, heldPrice, heldDecimals);
    if (fullSizeAtomic === 0n || fullSizeAtomic > heldAvailable) {
      return Effect.fail(
        new AdapterError({
          message: `Single-sided entry impossible for ${heldMint}: available ${formatTokenAmount(heldAvailable, heldDecimals)} is below the full-size requirement ${formatTokenAmount(fullSizeAtomic, heldDecimals)} for a $${input.positionSizeUsd} single-sided deposit (${missingShortage}). Fund the held token up to the full position size or enable AUTO_SWAP_ENTRY.`,
          poolAddress: input.poolAddress,
        }),
      );
    }
    return Effect.succeed({
      depositXAtomic: heldIsX ? fullSizeAtomic : 0n,
      depositYAtomic: heldIsX ? 0n : fullSizeAtomic,
      singleSidedX: heldIsX,
      depositMode: heldIsX ? "single-sided-x" : "single-sided-y",
      amountXUsd: heldIsX ? input.positionSizeUsd : 0,
      amountYUsd: heldIsX ? 0 : input.positionSizeUsd,
    });
  }
  return Effect.succeed({
    depositXAtomic: input.requestedXAmount,
    depositYAtomic: input.requestedYAmount,
    depositMode: "two-sided",
    amountXUsd: halfUsd,
    amountYUsd: halfUsd,
  });
}

/** Convert atomic token amounts to decimal units without Number() precision
 * loss above 2^53: split into whole + fractional bigint parts and compose. */
export function atomicToUnits(amountAtomic: bigint, decimals: number): number {
  const base = 10n ** BigInt(decimals);
  const whole = amountAtomic / base;
  const frac = amountAtomic % base;
  return Number(whole) + Number(frac) / Number(base);
}

/**
 * Issue #205: the SDK's position snapshot can understate the actual
 * withdrawal (observed: a $41.91 all-USDC position closed with the snapshot
 * reporting $24.38 — $17.53 vanished from the ledger and the exit settlement
 * sold only the snapshot amount). The wallet's balance DELTA around the close
 * batch is the on-chain truth. Prefer it per leg; fall back to the SDK
 * snapshot when the delta is genuinely unmeasurable (reads timed out /
 * failed) or negative (a SOL leg whose tx fees ate the credit, or a leg whose
 * balance moved DOWN during the window). An observed ZERO delta is a measured
 * zero — the empty leg of a single-sided position is routine, not a fallback.
 * `measured: true` marks a delta-based result — a measured amount may include
 * swept LM rewards (shouldClaimAndClose) that the exit books separately, so
 * the caller can exclude same-mint rewards; the snapshot amount never
 * includes them.
 */
interface WithdrawalMeasure {
  readonly amountAtomic: string;
  readonly measured: boolean;
}

export function measureWithdrawalDelta(input: {
  readonly beforeHeld: ReadonlyMap<
    string,
    { readonly amountAtomic: bigint; readonly decimals?: number }
  > | null;
  readonly afterHeld: ReadonlyMap<
    string,
    { readonly amountAtomic: bigint; readonly decimals?: number }
  > | null;
  readonly beforeNativeSol: bigint | null;
  readonly afterNativeSol: bigint | null;
  readonly mint: string;
  readonly snapshotAmount: string;
}): WithdrawalMeasure {
  const fallback = (): WithdrawalMeasure => ({
    amountAtomic: input.snapshotAmount,
    measured: false,
  });
  // Native SOL is measured from the balance delta alone — an SPL holdings
  // read failing must not block a measurable SOL leg.
  if (input.mint === SOL_MINT) {
    if (input.beforeNativeSol === null || input.afterNativeSol === null) return fallback();
    const delta = input.afterNativeSol - input.beforeNativeSol;
    if (delta < 0n) return fallback();
    return { amountAtomic: delta.toString(), measured: true };
  }
  if (input.beforeHeld === null || input.afterHeld === null) return fallback();
  const before = input.beforeHeld.get(input.mint)?.amountAtomic ?? 0n;
  const after = input.afterHeld.get(input.mint)?.amountAtomic ?? 0n;
  const delta = after - before;
  if (delta < 0n) return fallback();
  return { amountAtomic: delta.toString(), measured: true };
}

/**
 * Exclude a same-mint swept LM reward from a MEASURED withdrawal delta: the
 * whole-wallet delta includes the reward (shouldClaimAndClose sweeps it into
 * the same ATA), and the exit books it separately via sweptRewards — without
 * this subtraction it would be double-counted. Snapshot-based (unmeasured)
 * amounts never include rewards and are returned unchanged.
 */
export function excludeSameMintRewards(
  measured: { readonly amountAtomic: string; readonly measured: boolean },
  mint: string,
  rewardSlots: ReadonlyArray<{ readonly mint: string | null; readonly amountAtomic: bigint }>,
): string {
  if (!measured.measured) return measured.amountAtomic;
  let result = BigInt(measured.amountAtomic);
  for (const slot of rewardSlots) {
    if (slot.mint === mint) result -= slot.amountAtomic;
  }
  // Preserve an exactly-zero leg (an empty position leg whose measured delta
  // was entirely a same-mint swept reward — the reward books separately, so
  // the leg itself has no value). A NEGATIVE result (reward exceeds the
  // delta: measurement inconsistency) likewise resolves to 0 — returning the
  // reward-inclusive delta would re-introduce the same-mint double count.
  return result >= 0n ? result.toString() : "0";
}
const logger = createLogger("adapter-service");

// Mints we have already warned about for being unpriceable during wallet
// reconciliation. A perpetually-unpriceable token (e.g. a dust ATA with no
// price feed) warns once per process instead of every scan cycle.
const warnedUnpricedWalletMints = new Set<string>();
let warnedSplEnumerationFailure = false;
// Count of distinct unpriced mints currently excluded from wallet balance (for
// the throughput-throttle alert in program.ts).
let unpricedWalletMintCount = 0;
export function getUnpricedWalletMintCount(): number {
  return unpricedWalletMintCount;
}
function warnUnpricedWalletMintOnce(
  mint: string,
  opts?: {
    readonly amountAtomic?: bigint;
    readonly decimals?: number;
    readonly attemptedSources?: string | undefined;
  },
): void {
  if (warnedUnpricedWalletMints.has(mint)) return;
  warnedUnpricedWalletMints.add(mint);
  unpricedWalletMintCount += 1;
  const amountHuman =
    opts?.amountAtomic !== undefined && opts?.decimals !== undefined
      ? formatTokenAmount(opts.amountAtomic, opts.decimals)
      : "unknown";
  logger.warn(
    "Wallet token has no resolvable USD price — excluded from wallet balance (fail-closed)",
    {
      mint,
      amount: amountHuman,
      attemptedSources: opts?.attemptedSources ?? "unknown",
      amountUsd: "$0.00 (excluded)",
    },
  );
}

// ─── Meteora DLMM Data API response shape ────────────────────────────────────
// Mirrors the schema in https://dlmm.datapi.meteora.ag/openapi.json (the file
// at /openapi.json on the host is 404, but the live /pools endpoint and the
// docs at docs.meteora.ag/developer-guides/dlmm/api-reference/ confirm this).
// TimeWindowData is keyed by window string ("30m", "1h", "24h", ...) so we
// use a Record at the type level.

interface MeteoraTimeWindowData {
  readonly "30m": number;
  readonly "1h": number;
  readonly "2h": number;
  readonly "4h": number;
  readonly "12h": number;
  readonly "24h": number;
  readonly [window: string]: number;
}

interface MeteoraTokenMetrics {
  readonly address: string;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly is_verified: boolean;
  readonly holders: number;
  readonly freeze_authority_disabled: boolean;
  readonly total_supply: number;
  readonly price: number;
  readonly market_cap: number;
}

interface MeteoraPoolConfig {
  readonly bin_step: number;
  readonly base_fee_pct: number;
  readonly max_fee_pct: number;
  readonly protocol_fee_pct: number;
  readonly collect_fee_mode: number;
}

interface MeteoraPool {
  readonly address: string;
  readonly name: string;
  readonly token_x: MeteoraTokenMetrics;
  readonly token_y: MeteoraTokenMetrics;
  readonly reserve_x: string;
  readonly reserve_y: string;
  readonly token_x_amount: number;
  readonly token_y_amount: number;
  readonly created_at: number;
  readonly reward_mint_x: string;
  readonly reward_mint_y: string;
  readonly pool_config: MeteoraPoolConfig;
  readonly dynamic_fee_pct: number;
  readonly tvl: number;
  readonly current_price: number;
  readonly apr: number;
  readonly apy: number;
  readonly has_farm: boolean;
  readonly farm_apr: number;
  readonly farm_apy: number;
  readonly volume: MeteoraTimeWindowData;
  readonly fees: MeteoraTimeWindowData;
  readonly protocol_fees: MeteoraTimeWindowData;
  readonly fee_tvl_ratio: MeteoraTimeWindowData;
  readonly cumulative_metrics: { readonly volume: number; readonly fees: number };
  readonly is_blacklisted: boolean;
  readonly tags: ReadonlyArray<string>;
  readonly launchpad: string | null;
}

interface MeteoraPoolsEnvelope {
  readonly total: number;
  readonly pages: number;
  readonly current_page: number;
  readonly page_size: number;
  readonly data: ReadonlyArray<MeteoraPool>;
}

/**
 * Concrete owner type for JSON-decoded external data (RPC parsers, Data API
 * responses). Decoders at each I/O boundary parse raw values into this
 * contract instead of narrowing `unknown` with ad hoc `typeof` checks.
 */
type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** Mint → USD price lookup produced by `fetchTokenPrices`. */
type TokenPriceMap = Readonly<Record<string, number>>;

/** Fail-closed empty price map for the all-or-nothing fetch fallback. */
const EMPTY_TOKEN_PRICES: TokenPriceMap = Object.create(null);

/** Known-mint decimals lookup (SOL, USDC, USDT, …). */
type KnownMintDecimals = Readonly<Record<string, { symbol: string; decimals: number }>>;

/** Hardcoded fallback USD prices for a handful of well-known mints. */
type FallbackPriceMap = Readonly<Record<string, number>>;

/** HTTP request headers keyed by header name. */
type RequestHeaders = Record<string, string>;

const OBJECT_TAG = "[object Object]";
const NUMBER_TAG = "[object Number]";
const STRING_TAG = "[object String]";

function isObject<T>(v: T): v is T & JsonObject {
  return v !== null && Object.prototype.toString.call(v) === OBJECT_TAG;
}

/** True when the value is a runtime number (JSON-decoded primitives only). */
function isNumberValue(v: JsonValue | undefined): v is number {
  return v !== undefined && Object.prototype.toString.call(v) === NUMBER_TAG;
}

/** True when the value is a runtime string (JSON-decoded primitives only). */
function isStringValue(v: JsonValue | undefined): v is string {
  return v !== undefined && Object.prototype.toString.call(v) === STRING_TAG;
}
function readApiKey(): string {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(getPrismUserConfigDir(), "credentials.json"), "utf-8"),
    );
    if (!isObject(parsed)) return "";
    const credentials = parsed;
    return isStringValue(credentials.apiKey) ? credentials.apiKey : "";
  } catch {
    return "";
  }
}

/** Decode a JSON value to a number, or undefined when it is not a number. */
function asNumber(v: JsonValue | undefined): number | undefined {
  // SAFETY: The enclosing statement has validated or constructed the asserted contract before this value is consumed.
  return v !== undefined && Object.prototype.toString.call(v) === NUMBER_TAG
    ? // SAFETY: The runtime guard or typed fixture immediately above this assertion establishes the required invariant.
      // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
      (v as number)
    : undefined;
}

/** Return the value when it is a runtime string, else null. */
function asStringOrNull(v: string | undefined): string | null {
  return v !== undefined && Object.prototype.toString.call(v) === STRING_TAG ? v : null;
}

/** Transfer-fee rate fields on a Token-2022 extension (number or string form). */
interface TransferFeeRate {
  readonly transferFeeBasisPoints?: number | string;
  readonly maximumFee?: number | string;
}

/** A Token-2022 mint extension entry from the parsed account RPC payload. */
interface MintExtension {
  readonly extension: string;
  readonly state?: TransferFeeRate & {
    readonly newerTransferFee?: TransferFeeRate;
    readonly olderTransferFee?: TransferFeeRate;
  };
}

/**
 * Parsed Token-2022 mint account (`parsed.info` from getParsedAccountInfo).
 * The genuine contract for the RPC payload decoded at the caller's boundary.
 */
export interface ParsedMintInfo {
  readonly mintAuthority?: string;
  readonly freezeAuthority?: string;
  readonly extensions?: ReadonlyArray<MintExtension>;
}

/** True when a basis-point rate is a positive runtime number. */
function positiveBasisPoints(v: number | string | undefined): boolean {
  if (v === undefined) return false;
  // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
  return Object.prototype.toString.call(v) === NUMBER_TAG && (v as number) > 0;
}

/** True when a max-fee is a positive number or a numeric string. */
function positiveMaxFee(v: number | string | undefined): boolean {
  if (v === undefined) return false;
  if (isNumberValue(v)) return v > 0;
  if (isStringValue(v)) return Number(v) > 0;
  return false;
}

/**
 * Detect the Token-2022 transfer-fee extension on a parsed mint account (the
 * `parsed.info` JSON from getParsedAccountInfo). The spl-token RPC parser
 * lists extensions as `{ extension, state }` entries and nests the fee rates
 * as `newerTransferFee`/`olderTransferFee`, each
 * `{ transferFeeBasisPoints, maximumFee }`; the top level of `state` is also
 * checked for older parsers that flatten the fields. A non-zero basis-point
 * rate OR non-zero max fee means the mint taxes transfers (the Robinhood
 * rule 4 tax screen). Pure and exported for direct testing.
 */
export function parsedMintHasTransferFee(parsedInfo: ParsedMintInfo | null | undefined): boolean {
  const extensions = parsedInfo?.extensions;
  if (!Array.isArray(extensions)) return false;
  for (const ext of extensions) {
    if (ext.extension !== "transferFeeConfig" || !ext.state) continue;
    const candidates: ReadonlyArray<TransferFeeRate | undefined> = [
      ext.state,
      ext.state.newerTransferFee,
      ext.state.olderTransferFee,
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (positiveBasisPoints(candidate.transferFeeBasisPoints)) return true;
      if (positiveMaxFee(candidate.maximumFee)) return true;
    }
  }
  return false;
}

function isPoolsEnvelope(v: JsonValue): v is MeteoraPoolsEnvelope & JsonObject {
  if (!isObject(v)) return false;
  if (!isNumberValue(v["total"])) return false;
  if (!isNumberValue(v["pages"])) return false;
  if (!isNumberValue(v["current_page"])) return false;
  if (!isNumberValue(v["page_size"])) return false;
  if (!Array.isArray(v["data"])) return false;
  return true;
}
interface ParsedDiscoveryPage {
  readonly pools: ReadonlyArray<DiscoveredPool>;
  readonly pages: number;
}

function parseDiscoveryResponse(
  parsed: JsonValue,
  url: string,
  requestedPage: number | null,
  pageSize: number,
): Effect.Effect<ParsedDiscoveryPage, DiscoverPoolsError> {
  if (!isPoolsEnvelope(parsed)) {
    return Effect.fail(
      new DiscoverPoolsError({
        message: `Meteora API returned non-envelope payload (${describe(parsed)}) from ${url}`,
        url,
      }),
    );
  }
  const { data, total, pages, current_page: currentPage, page_size: responsePageSize } = parsed;
  const paginationValid =
    Number.isSafeInteger(total) &&
    total >= 0 &&
    Number.isSafeInteger(pages) &&
    pages >= 0 &&
    Number.isSafeInteger(currentPage) &&
    currentPage >= 1 &&
    Number.isSafeInteger(responsePageSize) &&
    responsePageSize >= 0 &&
    (total === 0 || (pages >= 1 && responsePageSize >= 1 && currentPage <= pages)) &&
    (requestedPage === null || (currentPage === requestedPage && responsePageSize === pageSize));
  if (!paginationValid) {
    return Effect.fail(
      new DiscoverPoolsError({
        message: `Meteora API returned malformed pagination metadata from ${url}`,
        url,
      }),
    );
  }
  const valid = data.filter(isValidPoolState);
  if (data.length > 0 && valid.length === 0) {
    logger.warn("Pool discovery: ALL pool objects had invalid shape; treating as a schema error", {
      dropped: data.length,
      kept: 0,
      total,
      pages,
    });
    return Effect.fail(
      new DiscoverPoolsError({
        message: `Meteora API returned ${data.length} pool rows but none matched the expected shape. Likely a schema change. Pool discovery disabled for this cycle.`,
        url,
      }),
    );
  }
  if (valid.length < data.length) {
    logger.warn("Pool discovery: some pool objects had invalid shape and were dropped", {
      dropped: data.length - valid.length,
      kept: valid.length,
      total,
      pages,
    });
  }
  return Effect.succeed({ pools: valid.filter((p) => !p.launchpad).map(toDiscoveredPool), pages });
}

function isValidPoolState(v: MeteoraPool): v is MeteoraPool & JsonObject {
  if (!isObject(v)) return false;
  if (!isStringValue(v["address"])) return false;
  if (!isNumberValue(v["tvl"])) return false;
  if (!isNumberValue(v["apr"])) return false;
  const tokenX = v["token_x"];
  if (!isObject(tokenX) || !isStringValue(tokenX["address"])) return false;
  const tokenY = v["token_y"];
  if (!isObject(tokenY) || !isStringValue(tokenY["address"])) return false;
  const poolConfig = v["pool_config"];
  if (!isObject(poolConfig) || !isNumberValue(poolConfig["bin_step"])) return false;
  const volume = v["volume"];
  if (!isObject(volume) || !isNumberValue(volume["24h"])) return false;
  const fees = v["fees"];
  if (!isObject(fees) || !isNumberValue(fees["24h"])) return false;
  return true;
}

/**
 * Extract the finite numeric values of a Data API rolling-window object
 * (e.g. `fee_tvl_ratio` / `volume` with 30m/1h/2h/4h/12h/24h labels). Empty
 * when the object is missing or carries no finite windows.
 */
function readWindowMap(raw: JsonValue): Map<string, number> {
  if (!isObject(raw)) return new Map();
  const out = new Map<string, number>();
  for (const window of ["30m", "1h", "2h", "4h", "12h", "24h"] as const) {
    const resolved = asNumber(raw[window]);
    if (resolved !== undefined && Number.isFinite(resolved)) out.set(window, resolved);
  }
  return out;
}

/**
 * Shared row→DiscoveredPool mapper used by both discovery paths (rotating
 * single-page discovery and the market-scan universe refresh). Attaches the
 * Data API's token-safety metadata (verified / freeze-disabled / holders /
 * symbol) so the market gate can pre-filter risky legs before they burn
 * scan cycles; the fields are optional so legacy consumers compile unchanged.
 */
function toDiscoveredPool(p: MeteoraPool): DiscoveredPool {
  const { token_x: tokenX, token_y: tokenY } = p;
  // Rolling-window curves (30m/1h/2h/4h/12h/24h) for the radar's
  // multi-timeframe probes: the list payload carries fee-yield AND volume
  // windows per pool, so wash patterns (a burst confined to one window) and
  // hotness cross-checks surface with no extra API call.
  const feeYieldWindows = readWindowMap(p.fee_tvl_ratio);
  const volumeWindows = readWindowMap(p.volume);
  // Build through a mutable projected type so the optional radar fields can be
  // assigned conditionally, then return it as the readonly public contract.
  type MutableDiscoveredPool = {
    -readonly [K in keyof DiscoveredPool]: DiscoveredPool[K];
  };
  const result: MutableDiscoveredPool = {
    address: p.address,
    tvlUsd: p.tvl,
    volume24hUsd: p.volume["24h"],
    fees24hUsd: p.fees["24h"],
    apr: p.apr,
    binStep: p.pool_config.bin_step,
    tokenX: tokenX.address,
    tokenY: tokenY.address,
    tokenXSymbol: tokenX.symbol,
    tokenYSymbol: tokenY.symbol,
    tokenXVerified: tokenX.is_verified,
    tokenYVerified: tokenY.is_verified,
    tokenXFreezeDisabled: tokenX.freeze_authority_disabled,
    tokenYFreezeDisabled: tokenY.freeze_authority_disabled,
    tokenXHolders: tokenX.holders,
    tokenYHolders: tokenY.holders,
  };
  if (Number.isFinite(p.created_at) && p.created_at > 0) {
    result.createdAtMs = p.created_at > 1_000_000_000_000 ? p.created_at : p.created_at * 1000;
  }
  // 1h fee-yield radar fields (launch mode): optional so pools where the
  // Data API reports no 1h window (brand-new, zero-activity) stay admitted
  // to the discovery feed and the launch gate rejects them fail-closed.
  const volume1h = p.volume?.["1h"];
  if (Number.isFinite(volume1h)) result.volume1hUsd = volume1h;
  const fees1h = p.fees?.["1h"];
  if (Number.isFinite(fees1h)) result.fees1hUsd = fees1h;
  const feeYield1h = p.fee_tvl_ratio?.["1h"];
  if (Number.isFinite(feeYield1h)) result.feeYield1hPct = feeYield1h;
  // Rolling-window curves for the radar's multi-timeframe probes: the same
  // payload carries 30m/1h/2h/4h/12h/24h fee-yield and volume windows, so
  // the radar can surface wash patterns (a burst confined to one window)
  // and cross-check hotness without any extra API call.
  if (feeYieldWindows.size > 0) {
    result.feeYieldWindows = Object.fromEntries(feeYieldWindows);
  }
  if (volumeWindows.size > 0) {
    result.volumeWindows = Object.fromEntries(volumeWindows);
  }
  if (Number.isFinite(p.pool_config.base_fee_pct)) {
    result.baseFeePct = p.pool_config.base_fee_pct;
  }
  return result;
}

function describe(v: JsonValue): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array(length=${v.length})`;
  if (isObject(v)) return `object(keys=${Object.keys(v).slice(0, 5).join(",")})`;
  if (Object.prototype.toString.call(v) === STRING_TAG) return "string";
  if (Object.prototype.toString.call(v) === NUMBER_TAG) return "number";
  return "boolean";
}

// ─── Install ID helper (engine-safe mirror of cli/install-id.ts) ───────────

const INSTALL_ID_FILE = path.join(getPrismUserConfigDir(), "install-id");
let cachedInstallId: string | null = null;

function getOrCreateInstallId(): Effect.Effect<string, never> {
  return Effect.gen(function* () {
    if (cachedInstallId) return cachedInstallId;
    const existing = yield* Effect.try({
      try: () => {
        if (!fs.existsSync(INSTALL_ID_FILE)) return null;
        const value = fs.readFileSync(INSTALL_ID_FILE, "utf-8").trim();
        return value.length >= 8 && value.length <= 128 ? value : null;
      },
      // SAFETY: This branch normalizes the caught cause to the Error contract before propagation.
      catch: (cause) => cause as Error,
    }).pipe(Effect.catch(() => Effect.succeed(null)));
    if (existing) {
      cachedInstallId = existing;
      return existing;
    }

    const id = randomUUID();
    yield* Effect.try({
      try: () => {
        const dir = path.dirname(INSTALL_ID_FILE);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        fs.writeFileSync(INSTALL_ID_FILE, id, { mode: 0o600 });
        fs.chmodSync(INSTALL_ID_FILE, 0o600);
      },
      // SAFETY: This branch normalizes the caught cause to the Error contract before propagation.
      catch: (cause) => cause as Error,
    }).pipe(Effect.catch(() => Effect.void));
    cachedInstallId = id;
    return id;
  });
}

export interface RevenueShareResult {
  platformFeeX: number;
  platformFeeY: number;
  operatorFeeX: number;
  operatorFeeY: number;
  netFeeX: number;
  netFeeY: number;
  amountToTransferX: number;
  amountToTransferY: number;
  isCircular: boolean;
}

/** Calculates operator and platform fee shares from a collected fee amount. */
export function calculateRevenueShare(
  feeX: number,
  feeY: number,
  platformFeeRate: number | undefined,
  revenueShareEnabled: boolean,
  revenueShareOperatorPct: number,
  feeWallet: string | null,
  operatorWalletAddress: string,
): RevenueShareResult {
  let platformFeeX = 0;
  let platformFeeY = 0;
  let operatorFeeX = 0;
  let operatorFeeY = 0;
  let netFeeX = feeX;
  let netFeeY = feeY;
  let amountToTransferX = 0;
  let amountToTransferY = 0;
  let isCircular = false;

  if (platformFeeRate && platformFeeRate > 0 && platformFeeRate <= 1) {
    platformFeeX = Math.floor(feeX * platformFeeRate);
    platformFeeY = Math.floor(feeY * platformFeeRate);

    if (revenueShareEnabled) {
      const clampedPct = Math.max(0, Math.min(revenueShareOperatorPct, 100));
      const operatorPct = clampedPct / 100;
      operatorFeeX = Math.floor(platformFeeX * operatorPct);
      operatorFeeY = Math.floor(platformFeeY * operatorPct);
    }

    netFeeX = feeX - platformFeeX;
    netFeeY = feeY - platformFeeY;

    isCircular = !!feeWallet && operatorWalletAddress === feeWallet;

    if (!isCircular && feeWallet) {
      amountToTransferX = platformFeeX - operatorFeeX;
      amountToTransferY = platformFeeY - operatorFeeY;
    }
  }

  return {
    platformFeeX,
    platformFeeY,
    operatorFeeX,
    operatorFeeY,
    netFeeX,
    netFeeY,
    amountToTransferX,
    amountToTransferY,
    isCircular,
  };
}

export type DlmmCreate = (...args: Parameters<typeof DLMM.create>) => Promise<MeteoraDlmmClient>;

function isSdkRebalanceResponse(
  value: MeteoraDlmmRebalanceSimulation | RebalancePositionResponse,
): value is RebalancePositionResponse {
  return "rebalancePosition" in value && "simulationResult" in value;
}

export const makeAdapterLive = (
  createDlmm: DlmmCreate = async (connection, publicKey, options) => {
    const client = await DLMM.create(connection, publicKey, options);
    return Object.assign(client, {
      rebalancePosition: async (
        simulation: MeteoraDlmmRebalanceSimulation,
        maxActiveBinSlippage: BN,
        rentPayer?: PublicKey,
        slippage?: number,
      ) => {
        if (!isSdkRebalanceResponse(simulation)) {
          throw new Error("Invalid SDK rebalance simulation response");
        }
        return client.rebalancePosition(simulation, maxActiveBinSlippage, rentPayer, slippage);
      },
    });
  },
) =>
  Layer.effect(
    AdapterService,
    Effect.gen(function* () {
      const config = yield* ConfigService;
      const db = yield* DbService;

      const connection = new Connection(config.solanaRpcUrl, "confirmed");
      // Round-robin RPC pool: the primary URL plus any comma-separated extra
      // endpoints in SOLANA_RPC_FALLBACK_URL. Spreading requests across free /
      // keyless endpoints keeps a single one from tripping its per-method /
      // per-IP rate limit, while each endpoint keeps its own circuit breaker so
      // a 429 / 5xx rotates to the next endpoint instead of failing the call.
      const rpcPoolUrls = [config.solanaRpcUrl];
      for (const raw of config.solanaRpcFallbackUrl.split(",")) {
        const url = raw.trim();
        if (url && !rpcPoolUrls.includes(url)) rpcPoolUrls.push(url);
      }
      interface RpcEndpoint {
        readonly url: string;
        readonly conn: Connection;
        readonly breaker: CircuitBreaker;
      }
      const rpcEndpoints: RpcEndpoint[] = [
        {
          url: config.solanaRpcUrl,
          conn: connection,
          breaker: new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 30_000 }),
        },
        ...rpcPoolUrls.slice(1).map((url) => ({
          url,
          conn: new Connection(url, "confirmed"),
          breaker: new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 30_000 }),
        })),
      ];
      const wallet = config.walletPrivateKey
        ? yield* Effect.try({
            try: () => Keypair.fromSecretKey(bs58.decode(config.walletPrivateKey)),
            // SAFETY: This branch normalizes the caught cause to the Error contract before propagation.
            catch: (cause) => cause as Error,
          }).pipe(
            Effect.catch((err) => {
              logger.error("Failed to load wallet", err);
              return Effect.succeed(null);
            }),
          )
        : null;

      const DLMM_CACHE_TTL_MS = 5 * 60 * 1000;
      const rpcIntervalMs = config.rpcMinIntervalMs ?? RPC_MIN_INTERVAL_MS;
      let nextRpcStartAt = 0;
      let rpcRoundRobinCursor = 0;
      let nextHeliusRequestAt = 0;

      function paceRpc(): Effect.Effect<void> {
        return Effect.sync(() => {
          const now = Date.now();
          const waitMs = Math.max(0, nextRpcStartAt - now);
          nextRpcStartAt = Math.max(now, nextRpcStartAt) + rpcIntervalMs;
          return waitMs;
        }).pipe(Effect.flatMap(Effect.sleep));
      }

      function paceHeliusRequest(): Effect.Effect<void> {
        return Effect.sync(() => {
          const now = Date.now();
          const waitMs = Math.max(0, nextHeliusRequestAt - now);
          nextHeliusRequestAt = Math.max(now, nextHeliusRequestAt) + RPC_MIN_INTERVAL_MS;
          return waitMs;
        }).pipe(Effect.flatMap(Effect.sleep));
      }

      function withRpcTimeout<T>(effect: Effect.Effect<T, Error>): Effect.Effect<T, Error> {
        return effect.pipe(
          Effect.timeoutOrElse({
            duration: RPC_REQUEST_TIMEOUT_MS,
            orElse: () => Effect.fail(new Error("RPC request timeout after 15s")),
          }),
        );
      }

      function rpcCall<T>(fn: (conn: Connection) => Promise<T>): Effect.Effect<T, Error> {
        const startIndex = rpcRoundRobinCursor % rpcEndpoints.length;
        rpcRoundRobinCursor = (rpcRoundRobinCursor + 1) % rpcEndpoints.length;

        const run = (endpoint: RpcEndpoint): Effect.Effect<T, Error> =>
          paceRpc().pipe(
            Effect.andThen(
              endpoint.breaker.execute(
                retryEffectWithBackoff(
                  withRpcTimeout(
                    Effect.tryPromise({
                      try: () => fn(endpoint.conn),
                      // SAFETY: This branch normalizes the caught cause to the Error contract before propagation.
                      catch: (cause) => cause as Error,
                    }),
                  ),
                  RPC_RETRY_OPTIONS,
                ),
                isRpcNetworkError,
              ),
            ),
          );

        const tryEndpoint = (offset: number, attemptsLeft: number): Effect.Effect<T, Error> => {
          // The pool is non-empty by construction (primary URL is always present).
          const endpoint = rpcEndpoints[(startIndex + offset) % rpcEndpoints.length]!;
          return run(endpoint).pipe(
            Effect.catch((err) => {
              if (attemptsLeft > 1 && isRpcNetworkError(err)) {
                return Effect.sync(() =>
                  logger.warn("RPC endpoint failed, rotating to next", {
                    url: endpoint.url.replace(/api-key=[^&]+/g, "api-key=[REDACTED]"),
                    error: err instanceof Error ? err.message : String(err),
                  }),
                ).pipe(Effect.andThen(tryEndpoint(offset + 1, attemptsLeft - 1)));
              }
              return Effect.fail(err);
            }),
          );
        };

        return tryEndpoint(0, rpcEndpoints.length);
      }

      const dlmmCacheEntries = new Map<
        string,
        Effect.Effect<[Effect.Effect<MeteoraDlmmClient, Error>, Effect.Effect<void>], Error>
      >();
      function getDlmmCached(
        poolAddress: string,
      ): Effect.Effect<[Effect.Effect<MeteoraDlmmClient, Error>, Effect.Effect<void>], Error> {
        const existing = dlmmCacheEntries.get(poolAddress);
        if (existing) return existing;
        const entry = Effect.try({
          try: () => new PublicKey(poolAddress),
          // SAFETY: This branch normalizes the caught cause to the Error contract before propagation.
          catch: (cause) => cause as Error,
        }).pipe(
          Effect.flatMap((pubkey) =>
            Effect.cachedInvalidateWithTTL(
              rpcCall((conn) => createDlmm(conn, pubkey)),
              DLMM_CACHE_TTL_MS,
            ),
          ),
        );
        dlmmCacheEntries.set(poolAddress, entry);
        return entry;
      }

      function getDlmm(poolAddress: string): Effect.Effect<MeteoraDlmmClient, Error> {
        return Effect.gen(function* () {
          const [cached, invalidate] = yield* getDlmmCached(poolAddress);
          return yield* cached.pipe(Effect.tapError(() => invalidate));
        });
      }

      // ─── Token metadata cache ──────────────────────────────────────────────

      interface TokenMeta {
        readonly symbol: string;
        readonly decimals: number;
        readonly priceUsd?: number;
        readonly priceFetchedAt?: number;
      }

      interface HeliusAssetResponse {
        readonly result?: {
          readonly content?: { readonly metadata?: { readonly symbol?: string } };
          readonly token_info?: {
            readonly decimals?: number;
            readonly price_info?: {
              readonly price_per_token?: number;
              readonly currency?: string;
            };
          };
        };
        readonly error?: { readonly code?: number; readonly message?: string };
      }

      // Token metadata is resolved keyless-first (standard RPC, then Helius DAS
      // last). The Helius path is the only keyed call and should be hit at most
      // ~once per token per day. The value stores { meta, fetchedAt } so the
      // cache can be persisted to the SQLite `metadata` table (surviving
      // restarts) and written back on startup.
      const tokenMetaCache = new Map<string, CacheEntry>();
      const HELIUS_ASSET_CACHE_TTL_MS = 5 * 60 * 1000;
      const TOKEN_META_NAMESPACE = "adapter";

      // Seed the in-memory token-metadata cache from the persisted SQLite copy
      // so a restart does not re-burn keyed Helius lookups for already-known
      // tokens. Fail-open: a missing/corrupt persisted value yields an empty
      // cache and the first lookup repopulates it.
      yield* loadPersistedCache(db, TOKEN_META_NAMESPACE).pipe(
        Effect.andThen((map) => {
          for (const [mint, entry] of map) tokenMetaCache.set(mint, entry);
          return Effect.void;
        }),
        Effect.catch(() => Effect.void),
      );

      // Mint authorities are quasi-static (revocation is one-way), so a long TTL
      // is safe and keeps the per-cycle safety screening to one RPC call per
      // mint per hour.
      const MINT_AUTHORITIES_CACHE_TTL_MS = 60 * 60 * 1000;
      interface MintAuthoritiesEntry {
        readonly mintAuthority: string | null;
        readonly freezeAuthority: string | null;
        readonly transferFeeEnabled: boolean;
        readonly fetchedAt: number;
      }
      const mintAuthoritiesCache = new Map<string, MintAuthoritiesEntry>();

      // Active-bin memo (issue: the audit's RPC dedup — getActiveBin is fetched
      // TWICE per pool per cycle: once in getPoolState, once in getBinArray, and
      // getBinsAroundActiveBin re-fetches the same bin array getActiveBin just
      // loaded). A SHORT TTL serves the within-cycle pair (ms apart) without
      // going stale across cycles (the active bin moves with every swap). The
      // DLMM instance itself is cached 5 min; this memo is strictly tighter.
      const ACTIVE_BIN_MEMO_TTL_MS = 3_000;
      interface ActiveBinMemo {
        readonly binId: number;
        readonly price: string;
        /** Real human price (tokenY per tokenX) — pricePerLamport × 10^(decX - decY). */
        readonly pricePerToken: string;
        readonly fetchedAt: number;
        readonly halfRange: number;
        readonly binsAround: MeteoraDlmmBinsAround | null;
      }
      const activeBinMemo = new Map<string, ActiveBinMemo>();

      // Opportunistic eviction: pools rotate out of the active set, and in
      // paper mode no mutation ever clears the memo — without pruning, dropped
      // pools' bin arrays would accumulate unboundedly. Each read prunes the
      // entries that have aged past the TTL, bounding the map by the pools
      // touched within one TTL window (the active set).
      function pruneActiveBinMemo(): void {
        const now = Date.now();
        for (const [addr, memo] of activeBinMemo) {
          if (now - memo.fetchedAt >= ACTIVE_BIN_MEMO_TTL_MS) {
            activeBinMemo.delete(addr);
          }
        }
      }

      function memoizedActiveBin(
        poolAddress: string,
        dlmm: MeteoraDlmmClient,
      ): Effect.Effect<{ binId: number; price: string; pricePerToken: string }, Error> {
        return Effect.gen(function* () {
          pruneActiveBinMemo();
          const memo = activeBinMemo.get(poolAddress);
          if (memo && Date.now() - memo.fetchedAt < ACTIVE_BIN_MEMO_TTL_MS) {
            return { binId: memo.binId, price: memo.price, pricePerToken: memo.pricePerToken };
          }
          const activeBin = yield* paceRpc().pipe(
            Effect.andThen(Effect.tryPromise(() => dlmm.getActiveBin())),
          );
          activeBinMemo.set(poolAddress, {
            binId: activeBin.binId,
            price: activeBin.price,
            pricePerToken: activeBin.pricePerToken ?? activeBin.price,
            fetchedAt: Date.now(),
            halfRange: 0,
            binsAround: null,
          });
          return {
            binId: activeBin.binId,
            price: activeBin.price,
            pricePerToken: activeBin.pricePerToken ?? activeBin.price,
          };
        });
      }

      function memoizedBinsAround(
        poolAddress: string,
        dlmm: MeteoraDlmmClient,
        halfRange: number,
      ): Effect.Effect<MeteoraDlmmBinsAround, Error> {
        return Effect.gen(function* () {
          pruneActiveBinMemo();
          const memo = activeBinMemo.get(poolAddress);
          if (
            memo &&
            memo.binsAround !== null &&
            memo.halfRange === halfRange &&
            Date.now() - memo.fetchedAt < ACTIVE_BIN_MEMO_TTL_MS
          ) {
            return memo.binsAround;
          }
          const bins = yield* paceRpc().pipe(
            Effect.andThen(
              Effect.tryPromise(() => dlmm.getBinsAroundActiveBin(halfRange, halfRange)),
            ),
          );
          // The bins fetch carries its OWN active-bin snapshot (the SDK reads
          // the active bin internally): align the memo with it so binId/price
          // and binsAround always describe the SAME point in time — retaining
          // the old binId while refreshing fetchedAt would serve a stale active
          // bin for another TTL window, and mixing bins from a newer snapshot
          // with the old id would be internally inconsistent.
          const activeBinSnapshot = bins.bins.find((b) => b.binId === bins.activeBin);
          activeBinMemo.set(poolAddress, {
            binId: bins.activeBin,
            price: activeBinSnapshot?.price ?? memo?.price ?? "",
            pricePerToken: activeBinSnapshot?.pricePerToken ?? memo?.pricePerToken ?? "",
            fetchedAt: Date.now(),
            halfRange,
            binsAround: bins,
          });
          return bins;
        });
      }

      function getMintAuthorities(mintAddress: string): Effect.Effect<
        {
          mintAuthority: string | null;
          freezeAuthority: string | null;
          transferFeeEnabled: boolean;
        },
        Error
      > {
        return Effect.gen(function* () {
          const cached = mintAuthoritiesCache.get(mintAddress);
          if (cached && Date.now() - cached.fetchedAt < MINT_AUTHORITIES_CACHE_TTL_MS) {
            return {
              mintAuthority: cached.mintAuthority,
              freezeAuthority: cached.freezeAuthority,
              transferFeeEnabled: cached.transferFeeEnabled,
            };
          }
          const mintPubkey = new PublicKey(mintAddress);
          const info = yield* rpcCall((conn) => conn.getParsedAccountInfo(mintPubkey));
          // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
          const parsed = (info.value?.data as { parsed?: { info?: ParsedMintInfo } })?.parsed?.info;
          const mintAuthority = asStringOrNull(parsed?.mintAuthority);
          const freezeAuthority = asStringOrNull(parsed?.freezeAuthority);
          // Token-2022 transfer-fee extension (Robinhood rule 4): a non-zero
          // transfer tax is surfaced so the market gate / launch branch can
          // reject the leg unless allowTransferFeeTokens opts in.
          const transferFeeEnabled = parsedMintHasTransferFee(parsed);
          mintAuthoritiesCache.set(mintAddress, {
            mintAuthority,
            freezeAuthority,
            transferFeeEnabled,
            fetchedAt: Date.now(),
          });
          return { mintAuthority, freezeAuthority, transferFeeEnabled };
        });
      }

      function readHeliusPrice(asset: HeliusAssetResponse): number | undefined {
        const priceInfo = asset.result?.token_info?.price_info;
        const price = priceInfo?.price_per_token;
        const currency = priceInfo?.currency?.toUpperCase();
        if (
          !isNumberValue(price) ||
          !Number.isFinite(price) ||
          price <= 0 ||
          (currency !== "USDC" && currency !== "USD")
        ) {
          return undefined;
        }
        return price;
      }

      const heliusAssetCacheEntries = new Map<
        string,
        Effect.Effect<[Effect.Effect<HeliusAssetResponse, Error>, Effect.Effect<void>]>
      >();
      function fetchHeliusAssetCached(
        mint: string,
      ): Effect.Effect<[Effect.Effect<HeliusAssetResponse, Error>, Effect.Effect<void>]> {
        const existing = heliusAssetCacheEntries.get(mint);
        if (existing) return existing;
        const url = `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;
        const assetRequest = Effect.gen(function* () {
          const res = yield* Effect.tryPromise({
            try: () =>
              fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: "get-asset",
                  method: "getAsset",
                  params: { id: mint },
                }),
                signal: AbortSignal.timeout(10_000),
              }),
            // SAFETY: This branch normalizes the caught cause to the Error contract before propagation.
            catch: (cause) => cause as Error,
          });
          if (!res.ok) {
            return yield* Effect.fail(
              Object.assign(new Error(`Helius getAsset returned HTTP ${res.status}`), {
                code: res.status,
                headers: res.headers,
              }),
            );
          }
          // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
          const json = (yield* Effect.tryPromise(() => res.json())) as HeliusAssetResponse;
          if (json.error) {
            return yield* Effect.fail(
              Object.assign(new Error(json.error.message ?? "Helius getAsset failed"), {
                code: json.error.code ?? -32005,
              }),
            );
          }
          return json;
        });
        const entry = Effect.cachedInvalidateWithTTL(
          paceHeliusRequest().pipe(
            Effect.andThen(retryEffectWithBackoff(withRpcTimeout(assetRequest), RPC_RETRY_OPTIONS)),
          ),
          HELIUS_ASSET_CACHE_TTL_MS,
        );
        heliusAssetCacheEntries.set(mint, entry);
        return entry;
      }

      function fetchHeliusAsset(mint: string): Effect.Effect<HeliusAssetResponse | null, Error> {
        // HeliusDAS switch: skip the keyed getAsset entirely when the operator
        // disabled it (an exhausted free-tier key returns 429 and the exponential
        // backoff stalls cycles). The keyless standard RPC path still resolves
        // decimals for the vast majority of SPL mints, so this only loses the
        // last-resort DAS edge.
        if (!config.heliusApiKey || (config.heliusDasDisabled ?? false))
          return Effect.succeed(null);
        return Effect.gen(function* () {
          const [cached, invalidate] = yield* fetchHeliusAssetCached(mint);
          return yield* cached.pipe(Effect.tapError(() => invalidate));
        });
      }

      // Known mint decimals (avoids network roundtrips for common SPL tokens).
      // If a mint is missing here and the RPC doesn't expose decimals via the
      // standard SPL Token program (or via Helius DAS getAsset), getTokenMeta
      // fails with Effect.fail, so callers must handle the error. For
      // non-Helius RPCs we use the SPL Token program (parsed account info),
      // which returns decimals for any valid SPL mint.
      const KNOWN_MINT_DECIMALS: KnownMintDecimals = {
        [SOL_MINT]: { symbol: "SOL", decimals: 9 },
        [USDC_MINT]: { symbol: "USDC", decimals: 6 },
        Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: "USDT", decimals: 6 },
        "7i5KKsX2weiTkry7jA4ZwSu2SmtUa4rCCi4t8U9b3bR2": { symbol: "USDS", decimals: 6 },
        J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYk6U5Yf9sW: { symbol: "JitoSOL", decimals: 9 },
        JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { symbol: "JUP", decimals: 6 },
      };

      function parseHeliusTokenMeta(
        mint: string,
        json: HeliusAssetResponse | null,
      ): TokenMeta | null {
        const d = json?.result?.token_info?.decimals;
        if (!isNumberValue(d)) return null;
        const priceUsd = json ? readHeliusPrice(json) : undefined;
        type MutableTokenMeta = { -readonly [K in keyof TokenMeta]: TokenMeta[K] };
        const meta: MutableTokenMeta = {
          symbol: json?.result?.content?.metadata?.symbol ?? mint.slice(0, 4),
          decimals: d,
        };
        if (priceUsd !== undefined) {
          meta.priceUsd = priceUsd;
          meta.priceFetchedAt = Date.now();
        }
        return meta;
      }

      function getTokenMeta(mint: string): Effect.Effect<TokenMeta, Error> {
        return Effect.gen(function* () {
          const cachedEntry = tokenMetaCache.get(mint);
          if (cachedEntry) return cachedEntry.meta;

          // Persist a resolved token metadata to the in-memory cache (and, best
          // effort, to SQLite so the keyed Helius lookup is not repeated after a
          // restart). Fail-open: a persistence error never fails the lookup.
          const setMeta = (meta: TokenMeta): Effect.Effect<void, never> =>
            Effect.gen(function* () {
              tokenMetaCache.set(mint, { meta, fetchedAt: Date.now() });
              yield* savePersistedCache(db, TOKEN_META_NAMESPACE, tokenMetaCache).pipe(
                Effect.catch(() => Effect.void),
              );
            });

          // Fast path: known mints (SOL, USDC, USDT, etc.) — no network.
          const known = KNOWN_MINT_DECIMALS[mint];
          if (known) {
            yield* setMeta(known);
            return known;
          }

          // Standard Solana RPC path first (keyless): parsed account info exposes
          // decimals for any SPL mint via the Token Program (works on mainnet-beta
          // and every other standard RPC). Preferred over Helius DAS getAsset so
          // the shared Helius key is NOT burned on the hot decimals path — the
          // public RPC serves this for free. Does NOT call Helius DAS getAsset.
          const mintPubkey = new PublicKey(mint);
          const info = yield* rpcCall((conn) => conn.getParsedAccountInfo(mintPubkey)).pipe(
            Effect.catch(() => Effect.succeed(null)),
          );
          const parsed =
            // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
            (info?.value?.data as { parsed?: { info?: { decimals?: number } } } | undefined)?.parsed
              ?.info;
          const decimals = parsed?.decimals;
          if (isNumberValue(decimals)) {
            const meta = { symbol: mint.slice(0, 4), decimals };
            yield* setMeta(meta);
            return meta;
          }

          // Helius path (last resort): DAS getAsset returns token_info.decimals
          // for any mint Helius has indexed. Only available when heliusApiKey is
          // set, and only reached when the keyless standard RPC could not resolve
          // decimals. Also carries a price the standard RPC path cannot.
          if (config.heliusApiKey) {
            const json = yield* fetchHeliusAsset(mint).pipe(
              Effect.catch(() => Effect.succeed(null)),
            );
            const meta = parseHeliusTokenMeta(mint, json);
            if (meta) {
              yield* setMeta(meta);
              return meta;
            }
          }

          return yield* Effect.fail(
            new Error(`Cannot resolve decimals for mint ${mint} via standard RPC or Helius`),
          );
        });
      }

      // ─── Price fetching ────────────────────────────────────────────────────

      const fallbackPrices: FallbackPriceMap = {
        [SOL_MINT]: 165,
        [USDC_MINT]: 1.0,
        Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 1.0,
        "7i5KKsX2weiTkry7jA4ZwSu2SmtUa4rCCi4t8U9b3bR2": 1.0,
        J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYk6U5Yf9sW: 1.0,
        JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 1.0,
      };

      const PRICE_CACHE_TTL_MS = 60_000;
      const PRICE_MISS_CACHE_TTL_MS = 10 * 60_000;
      const COINGECKO_BATCH_SIZE = 25;
      const COINGECKO_DELAY_MS = 1_200;

      interface PriceCacheEntry {
        readonly price: number;
        readonly fetchedAt: number;
      }

      const priceCache = new Map<string, PriceCacheEntry>();
      const negativePriceCache = new Map<string, number>();

      function getCachedPrice(mint: string): number | undefined {
        const entry = priceCache.get(mint);
        if (!entry) return undefined;
        if (Date.now() - entry.fetchedAt > PRICE_CACHE_TTL_MS) {
          priceCache.delete(mint);
          return undefined;
        }
        return entry.price;
      }

      function setCachedPrice(mint: string, price: number): void {
        priceCache.set(mint, { price, fetchedAt: Date.now() });
        negativePriceCache.delete(mint);
      }

      function fetchHeliusPrices(
        missing: ReadonlyArray<string>,
      ): Effect.Effect<Record<string, number>, never> {
        if (missing.length === 0 || !config.heliusApiKey) return Effect.succeed({});
        return Effect.gen(function* () {
          const result: Record<string, number> = {};
          yield* Effect.forEach(
            missing,
            (mint) =>
              fetchHeliusAsset(mint).pipe(
                Effect.catch((err) => {
                  logger.debug("Helius asset price unavailable", {
                    mint,
                    error: String(err),
                  });
                  return Effect.succeed(null);
                }),
                Effect.tap((asset) =>
                  Effect.sync(() => {
                    const price = asset ? readHeliusPrice(asset) : undefined;
                    if (price !== undefined) {
                      result[mint] = price;
                      setCachedPrice(mint, price);
                    }
                  }),
                ),
              ),
            { concurrency: 5 },
          );
          return result;
        });
      }

      function fetchJupiterPrices(
        missing: ReadonlyArray<string>,
      ): Effect.Effect<Record<string, number>, never> {
        if (missing.length === 0) return Effect.succeed({});
        return Effect.gen(function* () {
          const ids = encodeURIComponent(missing.join(","));
          const jupiterApiKey = process.env.JUPITER_API_KEY?.trim() ?? "";
          const requestInit: RequestInit = { signal: AbortSignal.timeout(10_000) };
          if (jupiterApiKey) requestInit.headers = { "x-api-key": jupiterApiKey };
          const res = yield* Effect.tryPromise(() =>
            jupiterFetch(`https://api.jup.ag/price/v3?ids=${ids}`, requestInit),
          );
          if (!res.ok) return {};
          // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
          const json = (yield* Effect.tryPromise(() => res.json())) as Record<
            string,
            { readonly usdPrice?: number; readonly price?: number } | undefined
          > & {
            readonly data?: Record<string, { readonly price?: number } | undefined>;
          };
          const result: Record<string, number> = {};
          for (const mint of missing) {
            const price = json[mint]?.usdPrice ?? json.data?.[mint]?.price;
            if (isNumberValue(price) && Number.isFinite(price) && price > 0) {
              result[mint] = price;
              setCachedPrice(mint, price);
            }
          }
          return result;
        }).pipe(Effect.catch(() => Effect.succeed({})));
      }

      function fetchCoinGeckoPrices(
        missing: ReadonlyArray<string>,
      ): Effect.Effect<Record<string, number>, never> {
        if (missing.length === 0) return Effect.succeed({});
        return Effect.gen(function* () {
          const result: Record<string, number> = {};
          const coinGeckoApiKey = process.env.COINGECKO_API_KEY?.trim() ?? "";
          for (let i = 0; i < missing.length; i += COINGECKO_BATCH_SIZE) {
            const batch = missing.slice(i, i + COINGECKO_BATCH_SIZE);
            const ids = encodeURIComponent(batch.join(","));
            const requestInit: RequestInit = { signal: AbortSignal.timeout(10_000) };
            if (coinGeckoApiKey) {
              requestInit.headers = { "x-cg-pro-api-key": coinGeckoApiKey };
            }
            const baseUrl = coinGeckoApiKey
              ? "https://pro-api.coingecko.com"
              : "https://api.coingecko.com";
            const res = yield* Effect.tryPromise(() =>
              fetch(
                `${baseUrl}/api/v3/simple/token_price/solana?contract_addresses=${ids}&vs_currencies=usd`,
                requestInit,
              ),
            );
            if (res.ok) {
              // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
              const json = (yield* Effect.tryPromise(() => res.json())) as Record<
                string,
                { readonly usd?: number } | undefined
              >;
              for (const mint of batch) {
                const price = json[mint]?.usd;
                if (isNumberValue(price) && Number.isFinite(price) && price > 0) {
                  result[mint] = price;
                  setCachedPrice(mint, price);
                }
              }
            }
            if (i + COINGECKO_BATCH_SIZE < missing.length) {
              yield* Effect.sleep(COINGECKO_DELAY_MS);
            }
          }
          return result;
        }).pipe(Effect.catch(() => Effect.succeed({})));
      }

      /** Resolves the cached price layers (price cache, token metadata price,
       * negative cache) for the requested mints; returns the populated map and
       * the mints that still need a provider fetch. */
      function resolveCachedPrices(
        mints: ReadonlyArray<string>,
        useFallback: boolean,
        provenanceOut: Map<string, string> | undefined,
      ) {
        const prices: Record<string, number> = {};
        const missing: string[] = [];
        for (const mint of new Set(mints)) {
          const cached = getCachedPrice(mint);
          if (cached !== undefined) {
            prices[mint] = cached;
            continue;
          }
          const metaEntry = tokenMetaCache.get(mint);
          const metadataPrice = metaEntry?.meta.priceUsd;
          if (metadataPrice !== undefined && Number.isFinite(metadataPrice) && metadataPrice > 0) {
            const metadataFetchedAt = metaEntry?.meta.priceFetchedAt;
            if (
              metadataFetchedAt === undefined ||
              Date.now() - metadataFetchedAt <= PRICE_CACHE_TTL_MS
            ) {
              setCachedPrice(mint, metadataPrice);
              prices[mint] = metadataPrice;
              continue;
            }
            tokenMetaCache.delete(mint);
          }
          const missFetchedAt = negativePriceCache.get(mint);
          if (missFetchedAt !== undefined) {
            if (Date.now() - missFetchedAt < PRICE_MISS_CACHE_TTL_MS) {
              prices[mint] = useFallback ? (fallbackPrices[mint] ?? 0) : 0;
              if (provenanceOut && !useFallback && prices[mint] === 0) {
                provenanceOut.set(mint, "negative-cache");
              }
              continue;
            }
            negativePriceCache.delete(mint);
          }
          missing.push(mint);
        }
        return { prices, missing };
      }

      /** Merges one provider's resolved prices into `prices` (with provenance)
       * and returns the mints the provider did not resolve. */
      function mergeProviderPrices(
        mints: ReadonlyArray<string>,
        fetched: Readonly<Record<string, number>>,
        prices: Record<string, number>,
        provenanceOut: Map<string, string> | undefined,
        useFallback: boolean,
        sourcesAttempted: string[],
      ): string[] {
        const missing: string[] = [];
        for (const mint of mints) {
          const price = fetched[mint];
          if (price !== undefined) {
            prices[mint] = price;
            if (provenanceOut && !useFallback) {
              provenanceOut.set(mint, sourcesAttempted.join(","));
            }
          } else {
            missing.push(mint);
          }
        }
        return missing;
      }

      /** Books still-unresolved mints: negative-cache them and apply the
       * fallback (or 0) price with provenance. */
      function applyFallbackForUnresolved(
        mints: ReadonlyArray<string>,
        prices: Record<string, number>,
        useFallback: boolean,
        provenanceOut: Map<string, string> | undefined,
        sourcesAttempted: string[],
      ): void {
        for (const mint of mints) {
          negativePriceCache.set(mint, Date.now());
          prices[mint] = useFallback ? (fallbackPrices[mint] ?? 0) : 0;
          if (provenanceOut && !useFallback) {
            provenanceOut.set(mint, sourcesAttempted.join(","));
          }
        }
      }

      function fetchTokenPrices(
        mints: ReadonlyArray<string>,
        opts?: {
          readonly useFallback?: boolean;
          /** Mutable out-param: populated with per-mint provenance for unresolved
           * mints (those resolving to 0 when useFallback is false). Callers in the
           * wallet reconciliation path pass this so warnUnpricedWalletMintOnce can
           * report which pricing sources were actually attempted vs. short-
           * circuited by the negative cache. */
          readonly provenanceOut?: Map<string, string>;
        },
      ): Effect.Effect<Record<string, number>, Error> {
        const useFallback = opts?.useFallback ?? true;
        const provenanceOut = opts?.provenanceOut;
        return Effect.gen(function* () {
          const { prices, missing } = resolveCachedPrices(mints, useFallback, provenanceOut);
          if (missing.length === 0) return prices;

          const sourcesAttempted: string[] = [];

          // Keyless-first pricing: the shared Helius key 429s under
          // load, so the HOT path must prefer the keyless providers (Jupiter,
          // CoinGecko) and only fall to Helius DAS getAsset for mints the keyless
          // sources miss. Previously Helius was tried FIRST, so every missing
          // mint burned the key's rate limit and added retry backoff latency
          // before the keyless crawl even ran. Reordering is safe: Jupiter/
          // CoinGecko prices are what the keyless fallback already served.
          sourcesAttempted.push("jupiter");
          const jupiterPrices = yield* fetchJupiterPrices(missing);
          const coinGeckoMissing = mergeProviderPrices(
            missing,
            jupiterPrices,
            prices,
            provenanceOut,
            useFallback,
            sourcesAttempted,
          );
          if (coinGeckoMissing.length === 0) return prices;

          sourcesAttempted.push("coingecko");
          const cgPrices = yield* fetchCoinGeckoPrices(coinGeckoMissing);
          const heliusMissing = mergeProviderPrices(
            coinGeckoMissing,
            cgPrices,
            prices,
            provenanceOut,
            useFallback,
            sourcesAttempted,
          );
          if (heliusMissing.length === 0) return prices;

          // Helius is the last-resort price source: only for mints neither
          // keyless provider resolved. Never attempted when no key is configured.
          if (config.heliusApiKey) sourcesAttempted.push("helius");
          const heliusPrices = yield* fetchHeliusPrices(heliusMissing);
          const unresolved = mergeProviderPrices(
            heliusMissing,
            heliusPrices,
            prices,
            provenanceOut,
            useFallback,
            sourcesAttempted,
          );
          applyFallbackForUnresolved(
            unresolved,
            prices,
            useFallback,
            provenanceOut,
            sourcesAttempted,
          );

          return prices;
        });
      }

      const WALLET_BALANCE_CACHE_TTL_MS = 30_000;
      const tokenBalanceCache = new Map<string, { value: bigint; expiresAt: number }>();
      let nativeSolBalanceCache: { value: bigint; expiresAt: number } | undefined;

      // Real position mark cache (getPositionValueUsd): short TTL so the
      // per-cycle value loop and the claim path share one position read.
      const POSITION_VALUE_CACHE_TTL_MS = 60_000;
      const positionValueCache = new Map<string, { value: number; fetchedAt: number }>();
      const datapiPositionCache = new PositionCrawlCache(90_000);

      function readTokenBalance(mintAddress: string): Effect.Effect<bigint, Error> {
        return Effect.gen(function* () {
          const activeWallet = wallet;
          if (!activeWallet) return 0n;
          const cached = tokenBalanceCache.get(mintAddress);
          if (cached && cached.expiresAt > Date.now()) return cached.value;
          const mint = new PublicKey(mintAddress);
          const accounts = yield* rpcCall((conn) =>
            conn.getParsedTokenAccountsByOwner(activeWallet.publicKey, { mint }),
          );
          let total = 0n;
          for (const account of accounts.value) {
            const data = account.account.data;
            if (!isObject(data)) continue;
            const parsed = data["parsed"];
            if (!isObject(parsed)) continue;
            const info = parsed["info"];
            if (!isObject(info)) continue;
            const tokenAmount = info["tokenAmount"];
            if (!isObject(tokenAmount)) continue;
            const amount = tokenAmount["amount"];
            if (isStringValue(amount)) total += BigInt(amount);
          }
          tokenBalanceCache.set(mintAddress, {
            value: total,
            expiresAt: Date.now() + WALLET_BALANCE_CACHE_TTL_MS,
          });
          return total;
        });
      }

      function readNativeSolBalance(opts?: {
        readonly force?: boolean;
      }): Effect.Effect<bigint, Error> {
        return Effect.gen(function* () {
          if (!wallet) return 0n;
          if (
            !opts?.force &&
            nativeSolBalanceCache &&
            nativeSolBalanceCache.expiresAt > Date.now()
          ) {
            return nativeSolBalanceCache.value;
          }
          const value = BigInt(yield* rpcCall((conn) => conn.getBalance(wallet.publicKey)));
          nativeSolBalanceCache = {
            value,
            expiresAt: Date.now() + WALLET_BALANCE_CACHE_TTL_MS,
          };
          return value;
        });
      }

      /**
       * Raw per-mint SPL holdings across Token Program + Token-2022, WITHOUT
       * USD pricing. Two unfiltered reads capture all ATAs (pool residues,
       * reward mints, wSOL); amounts accumulate per mint. Used by
       * readWalletSnapshot (which adds pricing) and by the exit path's
       * before/after withdrawal-delta measurement (issue #205 — the delta only
       * needs amounts, and pricing must not delay broadcasting an exit).
       */
      function readWalletHoldingsRaw(): Effect.Effect<
        ReadonlyMap<string, { readonly amountAtomic: bigint; readonly decimals: number }>,
        Error
      > {
        return Effect.gen(function* () {
          const held = new Map<string, { amountAtomic: bigint; decimals: number }>();
          if (!wallet) return held;
          for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
            const accounts = yield* rpcCall((conn) =>
              conn.getParsedTokenAccountsByOwner(wallet.publicKey, { programId }),
            );
            for (const account of accounts.value) {
              const data = account.account.data;
              if (!isObject(data)) continue;
              const parsed = data["parsed"];
              if (!isObject(parsed)) continue;
              const info = parsed["info"];
              if (!isObject(info)) continue;
              const mint = info["mint"];
              if (!isStringValue(mint)) continue;
              const tokenAmount = info["tokenAmount"];
              if (!isObject(tokenAmount)) continue;
              const amountRaw = tokenAmount["amount"];
              const decimals = tokenAmount["decimals"];
              if (!isStringValue(amountRaw) || !isNumberValue(decimals)) continue;
              if (!/^\d+$/.test(amountRaw)) continue;
              const amountAtomic = BigInt(amountRaw);
              if (amountAtomic <= 0n) continue; // skip empty / rent-only ATAs
              const existing = held.get(mint);
              if (existing) existing.amountAtomic += amountAtomic;
              else held.set(mint, { amountAtomic, decimals });
            }
          }
          return held;
        });
      }

      /**
       * One chain reconciliation of the wallet: the aggregate USD balance AND
       * the per-mint SPL holdings it is computed from. Both are served from the
       * SAME cached snapshot (same TTL, same invalidation after every mutating
       * tx), so a balance read and a holdings read can never disagree, and a
       * holdings read never triggers an extra RPC round. Paper mode / walletless
       * live returns 0 + an empty map. A failed read FAILS the Effect (mirroring
       * the balance semantics); consumers of getWalletHoldings degrade
       * fail-open (treat it as "no idle capital" for the cycle).
       */
      function readWalletSnapshot(): Effect.Effect<
        {
          totalUsd: number;
          held: ReadonlyMap<string, { readonly amountAtomic: bigint; readonly decimals: number }>;
        },
        Error
      > {
        return Effect.gen(function* () {
          if (!wallet) {
            return {
              totalUsd: 0,
              held: new Map<string, { readonly amountAtomic: bigint; readonly decimals: number }>(),
            };
          }

          // Native SOL lamports — the system account, read separately from any
          // wrapped-SOL (wSOL) token accounts below. The two live in distinct
          // storage, so they never double-count.
          const lamports = Number(yield* readNativeSolBalance());

          // Reconcile EVERY SPL token account the wallet holds, across both the
          // legacy Token Program and Token-2022 (see readWalletHoldingsRaw).
          //
          // Keyless/public RPC endpoints do not all serve
          // getParsedTokenAccountsByOwner (some return "Method not found", others
          // 403). When SPL enumeration fails, degrade the snapshot to NATIVE SOL
          // ONLY — getBalance works on every endpoint — instead of failing the
          // whole read. Native SOL is real capital and must not be dropped just
          // because SPL enumeration is unavailable; a degraded (SOL-only)
          // balance still under-reports SPL holdings, but never fails the cycle
          // and never over-reports. Warn once per process.
          const held = yield* readWalletHoldingsRaw().pipe(
            Effect.catch((err) => {
              if (!warnedSplEnumerationFailure) {
                warnedSplEnumerationFailure = true;
                logger.warn(
                  "SPL token-account enumeration failed — wallet balance degrades to native SOL only (fail-closed)",
                  { error: underlyingErrorMessage(err) },
                );
              }
              return Effect.succeed(
                new Map<string, { readonly amountAtomic: bigint; readonly decimals: number }>(),
              );
            }),
          );

          // Price every discovered mint plus native SOL in ONE batched call.
          // useFallback: false — an unresolvable price becomes 0 below (never a
          // hardcoded fallback), so the valuation can skip it fail-closed.
          const allMints = [...new Set([...held.keys(), SOL_MINT])];
          const priceProvenance = new Map<string, string>();
          const prices = yield* fetchTokenPrices(allMints, {
            useFallback: false,
            provenanceOut: priceProvenance,
          });

          // FAIL-CLOSED valuation: there is deliberately NO fallback price here.
          // The old path valued unresolved SOL at a hardcoded $165, which is how
          // a SOL-heavy wallet over-reported by ~$27. A token with no resolvable
          // USD price is SKIPPED with a one-time warn: shrinking the measured
          // portfolio only pauses new entries — EXITs stay free, so capital is
          // protected, and sizing keeps its own min floor.
          let totalUsd = 0;

          const solPrice = prices[SOL_MINT];
          if (lamports > 0) {
            if (isNumberValue(solPrice) && solPrice > 0) {
              totalUsd += (lamports / 1e9) * solPrice;
            } else {
              warnUnpricedWalletMintOnce(SOL_MINT, {
                amountAtomic: BigInt(lamports),
                decimals: 9,
                attemptedSources: priceProvenance.get(SOL_MINT),
              });
            }
          }

          for (const [mint, balance] of held) {
            const price = prices[mint];
            if (!isNumberValue(price) || price <= 0) {
              warnUnpricedWalletMintOnce(mint, {
                amountAtomic: balance.amountAtomic,
                decimals: balance.decimals,
                attemptedSources: priceProvenance.get(mint),
              });
              continue;
            }
            totalUsd += atomicToUnits(balance.amountAtomic, balance.decimals) * price;
          }

          return { totalUsd, held };
        });
      }

      const [cachedWalletSnapshot, invalidateWalletSnapshot] =
        yield* Effect.cachedInvalidateWithTTL(readWalletSnapshot(), WALLET_BALANCE_CACHE_TTL_MS);
      const cachedWalletBalance = Effect.map(cachedWalletSnapshot, (snapshot) => snapshot.totalUsd);
      const cachedWalletHoldings = Effect.map(cachedWalletSnapshot, (snapshot) => snapshot.held);

      const invalidateBalanceCaches = Effect.sync(() => {
        activeBinMemo.clear();
        tokenBalanceCache.clear();
        nativeSolBalanceCache = undefined;
        // Position marks read the same on-chain accounts a mutation rewrites:
        // a rebalance preserves positionPubKey, so without clearing this cache
        // the next valuation would serve a pre-mutation mark (up to 60s) into
        // trailing-stop / IL / dust decisions.
        positionValueCache.clear();
      }).pipe(Effect.andThen(invalidateWalletSnapshot));

      const quotedByRawPayload = new WeakMap<object, SwapQuote>();
      const preparedTransactions = new Map<string, number>();
      const simulatedTransactions = new Map<string, number>();

      function prunePreparedState(now: number): void {
        for (const [transaction, createdAt] of preparedTransactions) {
          if (now - createdAt > MAX_SWAP_QUOTE_AGE_MS) preparedTransactions.delete(transaction);
        }
        for (const [transaction, createdAt] of simulatedTransactions) {
          if (now - createdAt > MAX_SWAP_QUOTE_AGE_MS) simulatedTransactions.delete(transaction);
        }
      }

      function parseAtomicString(value: JsonValue | undefined): bigint | null {
        if (value === undefined || Object.prototype.toString.call(value) !== STRING_TAG)
          return null;
        try {
          // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
          return BigInt(value as string);
        } catch {
          return null;
        }
      }

      function swapValidationError(
        stage: SwapValidationError["stage"],
        reason: SwapValidationError["reason"],
        message: string,
        cause?: unknown,
      ): SwapValidationError {
        return new SwapValidationError({ stage, reason, message, cause });
      }

      type QuoteRouteStep = { readonly inputMint: string; readonly outputMint: string };

      function validateQuoteMatchesRequest(
        request: SwapRequest,
        payload: JsonObject,
      ): Effect.Effect<void, SwapValidationError> {
        if (payload.inputMint !== request.inputMint || payload.outputMint !== request.outputMint) {
          return Effect.fail(
            swapValidationError(
              "quote",
              "mint_mismatch",
              "Jupiter quote mints do not match request",
            ),
          );
        }
        if (parseAtomicString(payload.inAmount) !== request.amountAtomic) {
          return Effect.fail(
            swapValidationError(
              "quote",
              "amount_mismatch",
              "Jupiter quote input amount does not match request",
            ),
          );
        }
        return Effect.void;
      }

      function validateQuoteSlippage(
        request: SwapRequest,
        payload: JsonObject,
      ): Effect.Effect<void, SwapValidationError> {
        if (payload.slippageBps !== request.slippageBps) {
          return Effect.fail(
            swapValidationError(
              "quote",
              "slippage_exceeded",
              "Jupiter quote slippage does not match request",
            ),
          );
        }
        const configuredSlippageCap = Math.min(
          config.maxSwapSlippageBps ?? HARD_MAX_SWAP_SLIPPAGE_BPS,
          HARD_MAX_SWAP_SLIPPAGE_BPS,
        );
        if (
          !Number.isInteger(request.slippageBps) ||
          request.slippageBps < 0 ||
          request.slippageBps > configuredSlippageCap
        ) {
          return Effect.fail(
            swapValidationError(
              "quote",
              "slippage_exceeded",
              `Swap slippage ${request.slippageBps}bps exceeds ${configuredSlippageCap}bps`,
            ),
          );
        }
        return Effect.void;
      }

      function parseQuotePriceImpactBps(payload: JsonObject): number {
        const priceImpactPct = isStringValue(payload.priceImpactPct)
          ? Number(payload.priceImpactPct)
          : Number.NaN;
        return priceImpactPct * 10_000;
      }

      function validateQuotePriceImpact(
        priceImpactBps: number,
      ): Effect.Effect<void, SwapValidationError> {
        const configuredImpactCap = Math.min(
          config.maxSwapPriceImpactBps ?? HARD_MAX_SWAP_PRICE_IMPACT_BPS,
          HARD_MAX_SWAP_PRICE_IMPACT_BPS,
        );
        if (
          !Number.isFinite(priceImpactBps) ||
          priceImpactBps < 0 ||
          priceImpactBps > configuredImpactCap
        ) {
          return Effect.fail(
            swapValidationError(
              "quote",
              "price_impact_exceeded",
              `Swap price impact exceeds ${configuredImpactCap}bps`,
            ),
          );
        }
        return Effect.void;
      }

      function parseQuoteRoute(payload: JsonObject) {
        if (!Array.isArray(payload.routePlan) || payload.routePlan.length === 0) {
          return Effect.fail(
            swapValidationError(
              "quote",
              "route_mismatch",
              "Jupiter quote returned no usable route",
            ),
          );
        }
        const route: QuoteRouteStep[] = [];
        for (const step of payload.routePlan) {
          if (!isObject(step) || !isObject(step.swapInfo)) {
            return Effect.fail(
              swapValidationError("quote", "malformed_payload", "Jupiter route step is malformed"),
            );
          }
          const routeInputMint = step.swapInfo.inputMint;
          const routeOutputMint = step.swapInfo.outputMint;
          if (!isStringValue(routeInputMint) || !isStringValue(routeOutputMint)) {
            return Effect.fail(
              swapValidationError(
                "quote",
                "malformed_payload",
                "Jupiter route mints are malformed",
              ),
            );
          }
          route.push({ inputMint: routeInputMint, outputMint: routeOutputMint });
        }
        return Effect.succeed(route);
      }

      function validateQuoteRouteContinuity(
        request: SwapRequest,
        route: ReadonlyArray<QuoteRouteStep>,
      ): Effect.Effect<void, SwapValidationError> {
        const firstStep = route[0];
        const lastStep = route.at(-1);
        if (
          !firstStep ||
          !lastStep ||
          firstStep.inputMint !== request.inputMint ||
          lastStep.outputMint !== request.outputMint ||
          route.some((step, index) => index > 0 && route[index - 1]?.outputMint !== step.inputMint)
        ) {
          return Effect.fail(
            swapValidationError("quote", "route_mismatch", "Jupiter route does not match request"),
          );
        }
        return Effect.void;
      }

      function validateQuotePayload(
        request: SwapRequest,
        payload: JsonValue,
        quotedAt: number,
      ): Effect.Effect<SwapQuote, SwapValidationError> {
        return Effect.gen(function* () {
          if (!isObject(payload)) {
            return yield* Effect.fail(
              swapValidationError("quote", "malformed_payload", "Jupiter quote is not an object"),
            );
          }
          yield* validateQuoteMatchesRequest(request, payload);
          yield* validateQuoteSlippage(request, payload);
          const priceImpactBps = parseQuotePriceImpactBps(payload);
          yield* validateQuotePriceImpact(priceImpactBps);
          const outAmountAtomic = parseAtomicString(payload.outAmount);
          const minimumOutAmountAtomic = parseAtomicString(payload.otherAmountThreshold);
          if (
            outAmountAtomic === null ||
            outAmountAtomic <= 0n ||
            minimumOutAmountAtomic === null ||
            minimumOutAmountAtomic <= 0n ||
            minimumOutAmountAtomic > outAmountAtomic
          ) {
            return yield* Effect.fail(
              swapValidationError(
                "quote",
                "malformed_payload",
                "Jupiter quote amounts are invalid",
              ),
            );
          }
          const route = yield* parseQuoteRoute(payload);
          yield* validateQuoteRouteContinuity(request, route);
          return {
            request,
            outAmountAtomic,
            minimumOutAmountAtomic,
            priceImpactBps,
            quotedAt,
            route,
            rawQuote: payload,
          };
        });
      }

      function ensureFreshQuote(
        quote: SwapQuote,
        stage: "prepare" | "simulate" | "submit",
      ): Effect.Effect<void, SwapValidationError> {
        const ageMs = Date.now() - quote.quotedAt;
        if (ageMs < 0 || ageMs > MAX_SWAP_QUOTE_AGE_MS) {
          return Effect.fail(
            swapValidationError(stage, "stale_quote", `Jupiter quote age ${ageMs}ms is invalid`),
          );
        }
        return Effect.void;
      }

      function jupiterHeaders(): RequestHeaders {
        const headers: RequestHeaders = { "Content-Type": "application/json" };
        const apiKey = process.env.JUPITER_API_KEY?.trim() ?? "";
        if (apiKey) headers["x-api-key"] = apiKey;
        return headers;
      }

      function quoteSwap(request: SwapRequest): Effect.Effect<SwapQuote, Error> {
        return Effect.gen(function* () {
          if (request.amountAtomic <= 0n) {
            return yield* Effect.fail(
              new SwapQuoteError({
                message: `Cannot quote swap for non-positive amount: ${request.amountAtomic.toString()}`,
              }),
            );
          }
          if (request.inputMint === request.outputMint) {
            return yield* Effect.fail(
              swapValidationError(
                "quote",
                "route_mismatch",
                "Swap input and output mints must differ",
              ),
            );
          }
          const configuredSlippageCap = Math.min(
            config.maxSwapSlippageBps ?? HARD_MAX_SWAP_SLIPPAGE_BPS,
            HARD_MAX_SWAP_SLIPPAGE_BPS,
          );
          if (
            !Number.isInteger(request.slippageBps) ||
            request.slippageBps < 0 ||
            request.slippageBps > configuredSlippageCap
          ) {
            return yield* Effect.fail(
              swapValidationError(
                "quote",
                "slippage_exceeded",
                `Swap slippage ${request.slippageBps}bps exceeds ${configuredSlippageCap}bps`,
              ),
            );
          }
          const response = yield* Effect.tryPromise(() =>
            jupiterFetch(
              `https://api.jup.ag/swap/v1/quote?inputMint=${encodeURIComponent(request.inputMint)}&outputMint=${encodeURIComponent(request.outputMint)}&amount=${request.amountAtomic.toString()}&slippageBps=${request.slippageBps}&asLegacyTransaction=false`,
              { headers: jupiterHeaders(), signal: AbortSignal.timeout(10_000) },
            ),
          );
          if (!response.ok) {
            return yield* Effect.fail(
              new SwapQuoteError({ message: `Jupiter quote failed: ${response.status}` }),
            );
          }
          const payload = yield* Effect.tryPromise(() =>
            // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
            response.json().then((body) => body as JsonValue),
          );
          const quote = yield* validateQuotePayload(request, payload, Date.now());
          // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
          quotedByRawPayload.set(quote.rawQuote as object, quote);
          return quote;
        });
      }

      function decodeAndSignSwapTransaction(
        transactionBase64: string,
      ): Effect.Effect<
        { readonly transactionBase64: string; readonly transactionFormat: "legacy" | "versioned" },
        SwapValidationError
      > {
        return Effect.try({
          try: () => {
            const activeWallet = wallet;
            if (!activeWallet) throw new Error("No wallet configured");
            const normalized = transactionBase64.replace(/\s/g, "");
            const bytes = Buffer.from(normalized, "base64");
            if (
              bytes.length === 0 ||
              bytes.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")
            ) {
              throw new Error("Invalid base64 transaction");
            }
            try {
              const legacy = Transaction.from(bytes);
              legacy.sign(activeWallet);
              return {
                transactionBase64: legacy.serialize().toString("base64"),
                transactionFormat: "legacy" as const,
              };
            } catch (legacyError) {
              try {
                const versioned = VersionedTransaction.deserialize(bytes);
                versioned.sign([activeWallet]);
                return {
                  transactionBase64: Buffer.from(versioned.serialize()).toString("base64"),
                  transactionFormat: "versioned" as const,
                };
              } catch (versionedError) {
                throw new AggregateError(
                  [legacyError, versionedError],
                  "Unsupported Solana transaction payload",
                );
              }
            }
          },
          catch: (cause) =>
            swapValidationError(
              "prepare",
              "malformed_payload",
              "Jupiter returned an invalid transaction payload",
              cause,
            ),
        });
      }

      function prepareSwap(quote: SwapQuote): Effect.Effect<PreparedSwap, Error> {
        return Effect.gen(function* () {
          const activeWallet = wallet;
          if (!activeWallet) {
            return yield* Effect.fail(new AdapterError({ message: "No wallet configured" }));
          }
          yield* ensureFreshQuote(quote, "prepare");
          yield* validateQuotePayload(quote.request, quote.rawQuote, quote.quotedAt);
          const response = yield* Effect.tryPromise(() =>
            jupiterFetch("https://api.jup.ag/swap/v1/swap", {
              method: "POST",
              headers: jupiterHeaders(),
              body: JSON.stringify({
                quoteResponse: quote.rawQuote,
                userPublicKey: activeWallet.publicKey.toBase58(),
                wrapAndUnwrapSol: true,
                asLegacyTransaction: false,
              }),
              signal: AbortSignal.timeout(10_000),
            }),
          );
          if (!response.ok) {
            return yield* Effect.fail(
              new AdapterError({ message: `Jupiter swap build failed: ${response.status}` }),
            );
          }
          const payload = yield* Effect.tryPromise(() => response.json());
          if (!isObject(payload) || !isStringValue(payload.swapTransaction)) {
            return yield* Effect.fail(
              swapValidationError(
                "prepare",
                "malformed_payload",
                "Jupiter swap: no transaction returned",
              ),
            );
          }
          const signed = yield* decodeAndSignSwapTransaction(payload.swapTransaction);
          const preparedAt = Date.now();
          prunePreparedState(preparedAt);
          preparedTransactions.set(signed.transactionBase64, preparedAt);
          return { quote, ...signed, preparedAt };
        });
      }

      function decodePreparedTransaction(
        prepared: PreparedSwap,
      ): Transaction | VersionedTransaction {
        const bytes = Buffer.from(prepared.transactionBase64, "base64");
        return prepared.transactionFormat === "legacy"
          ? Transaction.from(bytes)
          : VersionedTransaction.deserialize(bytes);
      }

      function simulateSwap(prepared: PreparedSwap): Effect.Effect<SwapSimulation, Error> {
        return Effect.gen(function* () {
          yield* ensureFreshQuote(prepared.quote, "simulate");
          if (!preparedTransactions.has(prepared.transactionBase64)) {
            return yield* Effect.fail(
              swapValidationError(
                "simulate",
                "malformed_payload",
                "Swap transaction was not prepared by this adapter",
              ),
            );
          }
          const transaction = yield* Effect.try({
            try: () => decodePreparedTransaction(prepared),
            catch: (cause) =>
              swapValidationError(
                "simulate",
                "malformed_payload",
                "Prepared swap transaction cannot be decoded",
                cause,
              ),
          });
          const simulation =
            transaction instanceof VersionedTransaction
              ? yield* rpcCall((conn) => conn.simulateTransaction(transaction))
              : yield* rpcCall((conn) => conn.simulateTransaction(transaction));
          if (simulation.value.err !== null) {
            return yield* Effect.fail(
              swapValidationError(
                "simulate",
                "simulation_failed",
                "Swap simulation failed",
                simulation.value.err,
              ),
            );
          }
          const simulatedAt = Date.now();
          prunePreparedState(simulatedAt);
          simulatedTransactions.set(prepared.transactionBase64, simulatedAt);
          return {
            successful: true,
            logs: simulation.value.logs ?? [],
            unitsConsumed: simulation.value.unitsConsumed ?? null,
          };
        });
      }

      function submitSwap(
        prepared: PreparedSwap,
        onBroadcast?: (signature: string) => Effect.Effect<void, Error>,
      ): Effect.Effect<string, Error> {
        return Effect.gen(function* () {
          yield* ensureFreshQuote(prepared.quote, "submit");
          prunePreparedState(Date.now());
          if (!simulatedTransactions.delete(prepared.transactionBase64)) {
            return yield* Effect.fail(
              swapValidationError(
                "submit",
                "simulation_required",
                "Swap must pass simulation before submission",
              ),
            );
          }
          preparedTransactions.delete(prepared.transactionBase64);
          const transaction = yield* Effect.try({
            try: () => decodePreparedTransaction(prepared),
            catch: (cause) =>
              swapValidationError(
                "submit",
                "malformed_payload",
                "Prepared swap transaction cannot be decoded",
                cause,
              ),
          });
          const signature = yield* rpcCall((conn) =>
            conn.sendRawTransaction(transaction.serialize(), {
              skipPreflight: false,
              preflightCommitment: "confirmed",
            }),
          );
          if (onBroadcast) yield* onBroadcast(signature);
          const confirmation = yield* rpcCall((conn) =>
            conn.confirmTransaction(signature, "confirmed"),
          ).pipe(Effect.ensuring(invalidateBalanceCaches));
          if (confirmation.value.err !== null) {
            const txError = confirmation.value.err;
            // Solana confirmations report string / structured TransactionError
            // values, not Errors — the channel promises Error, so normalize.
            const txErrorTag = Object.prototype.toString.call(txError);
            // SAFETY: The enclosing statement has validated or constructed the asserted contract before this value is consumed.
            const message =
              txErrorTag === STRING_TAG
                ? // SAFETY: The runtime guard or typed fixture immediately above this assertion establishes the required invariant.
                  // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
                  (txError as string)
                : // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
                  txErrorTag === OBJECT_TAG && "message" in (txError as object)
                  ? // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
                    String((txError as { message: unknown }).message)
                  : // SAFETY: The value is intentionally opaque at this boundary and is validated by the enclosing parser or schema before domain use.
                    String(txError as unknown);
            return yield* Effect.fail(new Error(message, { cause: txError }));
          }
          return signature;
        });
      }

      function getSwapStatus(signature: string): Effect.Effect<SwapStatus, Error> {
        return Effect.gen(function* () {
          const response = yield* rpcCall((conn) =>
            conn.getSignatureStatuses([signature], { searchTransactionHistory: true }),
          );
          const status = response.value[0];
          if (!status) return { state: "not_found", error: null };
          if (status.err !== null) {
            return { state: "failed", error: JSON.stringify(status.err) };
          }
          switch (status.confirmationStatus) {
            case "finalized":
              return { state: "finalized", error: null };
            case "confirmed":
              return { state: "confirmed", error: null };
            case "processed":
            case null:
            case undefined:
              return { state: "processed", error: null };
          }
          return { state: "processed", error: null };
        });
      }

      function getConfirmedSwapOutput(
        signature: string,
      ): Effect.Effect<{ outputAtomic: bigint; feeAtomic: bigint } | null, Error> {
        return Effect.gen(function* () {
          if (!wallet) return null;
          const response = yield* rpcCall((conn) =>
            conn.getTransaction(signature, {
              commitment: "confirmed",
              maxSupportedTransactionVersion: 0,
            }),
          );
          if (!response || !response.meta) return null;

          const message = response.transaction.message;
          const accountKeys =
            message.version === 0
              ? message.getAccountKeys({
                  accountKeysFromLookups: response.meta.loadedAddresses ?? null,
                })
              : message.getAccountKeys();
          let walletIndex = -1;
          for (let index = 0; index < accountKeys.length; index += 1) {
            if (accountKeys.get(index)?.equals(wallet.publicKey)) {
              walletIndex = index;
              break;
            }
          }
          if (walletIndex === -1) return null;

          const preBalance = response.meta.preBalances[walletIndex];
          const postBalance = response.meta.postBalances[walletIndex];
          if (!isNumberValue(preBalance) || !isNumberValue(postBalance)) return null;

          const outputAtomic = BigInt(postBalance - preBalance);
          const feeAtomic = BigInt(response.meta.fee);

          if (outputAtomic <= 0n) return null;

          return { outputAtomic, feeAtomic };
        }).pipe(Effect.catch(() => Effect.succeed(null)));
      }

      function quoteSwapUSDCForToken(
        outputMint: string,
        amountAtomic: bigint,
      ): Effect.Effect<JsonValue, Error> {
        if (!wallet) return Effect.fail(new AdapterError({ message: "No wallet configured" }));
        return quoteSwap({
          inputMint: USDC_MINT,
          outputMint,
          amountAtomic,
          slippageBps: Math.min(config.maxSwapSlippageBps ?? 50, 50),
        }).pipe(Effect.map((quote) => quote.rawQuote));
      }

      function quoteSwapToken(
        inputMint: string,
        outputMint: string,
        amountAtomic: bigint,
      ): Effect.Effect<JsonValue, Error> {
        return quoteSwap({
          inputMint,
          outputMint,
          amountAtomic,
          slippageBps: Math.min(config.maxSwapSlippageBps ?? 50, 50),
        }).pipe(Effect.map((quote) => quote.rawQuote));
      }

      function executeValidatedQuote(quote: SwapQuote): Effect.Effect<string, Error> {
        return Effect.gen(function* () {
          const prepared = yield* prepareSwap(quote);
          yield* simulateSwap(prepared);
          return yield* submitSwap(prepared);
        });
      }

      function swapUSDCForToken(
        outputMint: string,
        amountAtomic: bigint,
        prefetchedQuote?: JsonValue,
      ): Effect.Effect<string, Error> {
        return Effect.gen(function* () {
          if (amountAtomic <= 0n) {
            return yield* Effect.fail(
              new AdapterError({
                message: `Cannot swap USDC for non-positive amount: ${amountAtomic.toString()}`,
              }),
            );
          }
          const rawQuote =
            prefetchedQuote ?? (yield* quoteSwapUSDCForToken(outputMint, amountAtomic));
          // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
          const quote = quotedByRawPayload.get(rawQuote as object);
          if (
            !quote ||
            quote.request.inputMint !== USDC_MINT ||
            quote.request.outputMint !== outputMint ||
            quote.request.amountAtomic !== amountAtomic
          ) {
            return yield* Effect.fail(
              new AdapterError({
                message: `Jupiter quote does not match request: outputMint=${outputMint}, amount=${amountAtomic.toString()}`,
              }),
            );
          }
          return yield* executeValidatedQuote(quote);
        });
      }

      function swapToken(
        inputMint: string,
        outputMint: string,
        amountAtomic: bigint,
        quoteData?: JsonValue,
      ): Effect.Effect<string, Error> {
        return Effect.gen(function* () {
          const rawQuote =
            quoteData ?? (yield* quoteSwapToken(inputMint, outputMint, amountAtomic));
          // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
          const quote = quotedByRawPayload.get(rawQuote as object);
          if (!quote) {
            return yield* Effect.fail(
              new AdapterError({ message: "Validated Jupiter quote is unavailable or stale" }),
            );
          }
          if (
            quote.request.inputMint !== inputMint ||
            quote.request.outputMint !== outputMint ||
            quote.request.amountAtomic !== amountAtomic
          ) {
            return yield* Effect.fail(
              new AdapterError({
                message: `Jupiter quote does not match request: inputMint=${inputMint}, outputMint=${outputMint}, amount=${amountAtomic.toString()}`,
              }),
            );
          }
          return yield* executeValidatedQuote(quote);
        });
      }

      // ─── Pool stats ────────────────────────────────────────────────────────

      function sendInstructions(
        instructions: ReadonlyArray<TransactionInstruction>,
      ): Effect.Effect<string, Error> {
        return Effect.gen(function* () {
          if (!wallet) {
            return yield* Effect.fail(new AdapterError({ message: "No wallet configured" }));
          }
          const tx = new Transaction();
          tx.add(...instructions);
          const { blockhash } = yield* rpcCall((conn) => conn.getLatestBlockhash());
          tx.feePayer = wallet.publicKey;
          tx.recentBlockhash = blockhash;
          tx.sign(wallet);

          const signature = yield* rpcCall((conn) =>
            conn.sendRawTransaction(tx.serialize(), {
              skipPreflight: false,
              preflightCommitment: "confirmed",
            }),
          );
          yield* rpcCall((conn) => conn.confirmTransaction(signature, "confirmed"));
          return signature;
        });
      }

      // ─── Pool stats ────────────────────────────────────────────────────────

      function fetchPoolStats(
        poolAddress: string,
      ): Effect.Effect<
        { tvlUsd: number; volume24hUsd: number; fees24hUsd: number; apr: number },
        Error
      > {
        return Effect.gen(function* () {
          const dlmm = yield* getDlmm(poolAddress);
          const lbPair = dlmm.lbPair;

          const tokenXMint = lbPair.tokenXMint.toBase58();
          const tokenYMint = lbPair.tokenYMint.toBase58();

          const [tokenXMeta, tokenYMeta] = yield* Effect.all([
            getTokenMeta(tokenXMint),
            getTokenMeta(tokenYMint),
          ]);
          const tokenXDecimals = tokenXMeta.decimals;
          const tokenYDecimals = tokenYMeta.decimals;

          const [balX, balY] = yield* Effect.all([
            rpcCall((conn) => conn.getTokenAccountBalance(lbPair.reserveX)),
            rpcCall((conn) => conn.getTokenAccountBalance(lbPair.reserveY)),
          ]);

          const reserveX = Number(balX.value.amount) / Math.pow(10, tokenXDecimals);
          const reserveY = Number(balY.value.amount) / Math.pow(10, tokenYDecimals);

          const prices = yield* fetchTokenPrices([tokenXMint, tokenYMint]);
          const priceX = prices[tokenXMint] || 0;
          const priceY = prices[tokenYMint] || 0;

          const tvlUsd = reserveX * priceX + reserveY * priceY;
          const binStep = Number(lbPair.binStep);
          const turnoverRate = 0.3 + (binStep / 100) * 0.5;
          const estimatedVolume24h = tvlUsd * turnoverRate;
          const feeRate = 0.0025 + binStep / 10000;
          const fees24hUsd = estimatedVolume24h * feeRate;
          const apr = tvlUsd > 0 ? ((fees24hUsd * 365) / tvlUsd) * 100 : 0;

          return { tvlUsd, volume24hUsd: estimatedVolume24h, fees24hUsd, apr };
        }).pipe(
          Effect.catch(() => Effect.succeed({ tvlUsd: 0, volume24hUsd: 0, fees24hUsd: 0, apr: 0 })),
        );
      }

      /** Fetch and validate entry-leg prices (single-sided-X skips the Y leg). */
      function fetchEntryPrices(
        poolAddress: string,
        tokenX: string,
        tokenY: string,
        forceSingleSidedX: boolean,
      ): Effect.Effect<{ priceX: number; priceY: number }, Error> {
        return Effect.gen(function* () {
          const prices = yield* fetchTokenPrices(forceSingleSidedX ? [tokenX] : [tokenX, tokenY]);
          const priceX = prices[tokenX] ?? 0;
          const priceY = forceSingleSidedX ? 0 : (prices[tokenY] ?? 0);
          if (!priceX || (!forceSingleSidedX && !priceY)) {
            return yield* Effect.fail(
              new AdapterError({
                message: `Could not fetch token prices for ${tokenX} and ${tokenY}`,
                poolAddress,
              }),
            );
          }
          return { priceX, priceY };
        });
      }

      /** Read entry-leg balances plus native SOL when a leg needs it. */
      function readEntryBalances(
        tokenX: string,
        tokenY: string,
        forceSingleSidedX: boolean,
      ): Effect.Effect<
        { balanceX: bigint; balanceY: bigint; nativeSolBalance: bigint | undefined },
        Error
      > {
        return Effect.gen(function* () {
          const balanceX = yield* readTokenBalance(tokenX);
          const balanceY = forceSingleSidedX ? 0n : yield* readTokenBalance(tokenY);
          const nativeSolBalance =
            tokenX === SOL_MINT || (!forceSingleSidedX && tokenY === SOL_MINT)
              ? yield* readNativeSolBalance()
              : undefined;
          return { balanceX, balanceY, nativeSolBalance };
        });
      }

      /** Cap a SOL leg at the spendable balance (anything at/below the gas reserve is unfundable). */
      function capSolLegForGas(
        balance: bigint,
        isSolLeg: boolean,
        nativeSolBalance: bigint | undefined,
      ): bigint {
        if (!isSolLeg) return balance;
        return nativeSolBalance !== undefined && nativeSolBalance > GAS_RESERVE_LAMPORTS
          ? nativeSolBalance - GAS_RESERVE_LAMPORTS
          : 0n;
      }

      /** Announce which deposit path the entry takes (runner/single-sided vs two-sided). */
      function logEntryDepositMode(
        poolAddress: string,
        poolTokenX: string,
        depositMode: EntryDepositMode,
        depositXAtomic: bigint,
        positionSizeUsd: number,
        forceSingleSidedX: boolean,
      ): void {
        if (forceSingleSidedX) {
          logger.info("Runner single-sided entry: full size in the quote leg", {
            pool: poolAddress,
            mint: poolTokenX,
            amountAtomic: depositXAtomic.toString(),
          });
        } else if (depositMode !== "two-sided") {
          logger.info("Single-sided entry: depositing the full size in the held leg", {
            pool: poolAddress,
            depositMode,
            amountUsd: positionSizeUsd,
          });
        }
      }

      /**
       * Build the SDK deposit strategy. The decision loop resolves `auto`
       * per pool and passes a concrete shape; a bare `auto` config reaches
       * the adapter only from direct calls without volatility context,
       * where spot is the safe default.
       */
      function buildEntryStrategy(
        lowerBinId: number,
        upperBinId: number,
        strategySpecOption: EntryStrategySpec | undefined,
        singleSidedX: boolean | undefined,
      ): StrategyParameters {
        const strategySpec =
          strategySpecOption ??
          (config.entryStrategyType === "auto" ? "spot" : config.entryStrategyType);
        return {
          minBinId: lowerBinId,
          maxBinId: upperBinId,
          strategyType: toSdkStrategyType(strategySpec),
          ...(singleSidedX !== undefined ? { singleSidedX } : undefined),
        };
      }

      // ─── API implementation ────────────────────────────────────────────────

      let discoveryPageCount = 1;

      const api: AdapterApi = {
        hasWallet: () => wallet !== null,

        getWalletAddress: () => wallet?.publicKey.toBase58() ?? null,

        getWalletBalanceUsd: () => cachedWalletBalance,

        getWalletHoldings: () => cachedWalletHoldings,

        getNativeSolBalance: () =>
          Effect.gen(function* () {
            if (!wallet) return 0n;
            return yield* readNativeSolBalance();
          }),

        getTokenBalance: (mintAddress: string) => readTokenBalance(mintAddress),

        getTokenPrices: (mints: ReadonlyArray<string>, opts?: { readonly useFallback?: boolean }) =>
          fetchTokenPrices(mints, opts),

        getTokenPriceEvidence: (mints: ReadonlyArray<string>) =>
          fetchTokenPrices(mints, { useFallback: false }).pipe(
            Effect.map((prices) => {
              return [...new Set(mints)].flatMap((mint) => {
                const priceUsd = prices[mint];
                const observedAt =
                  tokenMetaCache.get(mint)?.meta.priceFetchedAt ??
                  priceCache.get(mint)?.fetchedAt ??
                  Date.now();
                return priceUsd !== undefined && Number.isFinite(priceUsd) && priceUsd > 0
                  ? [{ mint, priceUsd, observedAt, fallbackUsed: false as const }]
                  : [];
              });
            }),
          ),

        getTokenDecimals: (mintAddress: string) =>
          getTokenMeta(mintAddress).pipe(Effect.map((m) => m.decimals)),

        getMintAuthorities: (mintAddress: string) => getMintAuthorities(mintAddress),

        // Wash forensics: one Helius enhanced-API call on the pool's recent
        // transactions. DLMM swaps are not in Helius's parsed models, but the
        // feePayer per tx survives — the wallet-concentration/burst-density
        // signals only need who paid + when. Fail-open: any fetch/parse error,
        // a non-Helius RPC host, or the switch being off returns null.
        getPoolWashEvidence: (poolAddress) =>
          Effect.gen(function* () {
            if (config.launchWashForensicsEnabled !== true) return null;
            if (!config.heliusApiKey) return null;
            let host: string;
            try {
              host = new URL(config.solanaRpcUrl).host;
            } catch {
              return null;
            }
            if (host !== "helius-rpc.com" && !host.endsWith(".helius-rpc.com")) {
              return null;
            }
            // Helius serves the enhanced address-history API from the
            // api- prefixed host (api-mainnet.helius-rpc.com), NOT the RPC
            // host — reusing the RPC host would silently null every response
            // under the standard setup. map per network; the bare host keeps.
            const enhancedHost = host.startsWith("mainnet.")
              ? `api-mainnet.${host.slice("mainnet.".length)}`
              : host.startsWith("devnet.")
                ? `api-devnet.${host.slice("devnet.".length)}`
                : host;
            const url =
              `https://${enhancedHost}/v0/addresses/${poolAddress}/transactions` +
              `?limit=40&api-key=${encodeURIComponent(config.heliusApiKey)}`;
            const parsed: JsonValue = yield* Effect.tryPromise({
              try: async () => {
                const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
                if (!res.ok) throw new Error(`heluis wash fetch ${res.status}`);
                // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
                return (await res.json()) as JsonValue;
              },
              catch: () => null,
            }).pipe(Effect.catch(() => Effect.succeed(null)));
            if (!Array.isArray(parsed) || parsed.length === 0) return null;
            const rows: WashTradeRow[] = [];
            for (const tx of parsed) {
              if (!isObject(tx)) continue;
              // Only successful METEORA instructions count as volume: failed
              // txs (err set) and system transfers are not swap activity, and a
              // single active LP's maintenance txs must not satisfy the
              // concentration thresholds. DLMM swaps and LP ops are both
              // type UNKNOWN — the residual noise is bounded by the
              // extreme-tail thresholds.
              if (tx["err"] != null) continue;
              if (tx["type"] === "TRANSFER") continue;
              if (tx["source"] !== "METEORA") continue;
              const payer = tx["feePayer"];
              const timestamp = tx["timestamp"];
              const fee = tx["fee"];
              if (!isStringValue(payer) || !isNumberValue(timestamp) || !isNumberValue(fee)) {
                continue;
              }
              rows.push({ payer, timestamp, feeLamports: fee });
            }
            return rows.length > 0 ? scoreWashEvidence(rows) : null;
          }).pipe(Effect.catch(() => Effect.succeed(null))),

        getPoolState: (poolAddress) =>
          Effect.gen(function* () {
            const dlmm = yield* getDlmm(poolAddress);
            const lbPair = dlmm.lbPair;
            // Did this call HIT the memo? Only a FRESH fetch may re-stamp the
            // TTL after assembly — re-stamping on hits would make freshness
            // caller-cadence-dependent (a frequent caller keeps the memo alive
            // forever) and could refresh a screener-populated entry whose bins
            // are older than the TTL.
            const memoHit = (() => {
              const m = activeBinMemo.get(poolAddress);
              return (
                m !== undefined &&
                m.price !== "" &&
                Date.now() - m.fetchedAt < ACTIVE_BIN_MEMO_TTL_MS
              );
            })();
            const activeBin = yield* memoizedActiveBin(poolAddress, dlmm);

            const [tokenXMeta, tokenYMeta, stats] = yield* Effect.all([
              getTokenMeta(lbPair.tokenXMint.toBase58()),
              getTokenMeta(lbPair.tokenYMint.toBase58()),
              fetchPoolStats(poolAddress),
            ]);

            // The TTL clock starts when the pool-state ASSEMBLY completes, not
            // when the active bin was fetched: for a cold or rotating pool the
            // metadata/reserves/pricing resolution can exceed 3s, and the
            // immediately following getBinArray call must still hit the memo
            // (otherwise the dedup is defeated exactly in the high-latency,
            // high-cardinality scenario it exists for).
            if (!memoHit) {
              const assembledMemo = activeBinMemo.get(poolAddress);
              if (assembledMemo) {
                // The active bin was fetched THIS call: extend the TTL across
                // the assembly window so the immediately following getBinArray
                // still hits the memo (the data is at most the assembly
                // duration old). Hits are untouched.
                activeBinMemo.set(poolAddress, { ...assembledMemo, fetchedAt: Date.now() });
              }
            }

            return {
              address: poolAddress,
              tokenX: lbPair.tokenXMint.toBase58(),
              tokenY: lbPair.tokenYMint.toBase58(),
              tokenXSymbol: tokenXMeta.symbol,
              tokenYSymbol: tokenYMeta.symbol,
              tvlUsd: stats.tvlUsd,
              volume24hUsd: stats.volume24hUsd,
              fees24hUsd: stats.fees24hUsd,
              apr: stats.apr,
              activeBinId: activeBin.binId,
              binStep: lbPair.binStep,
              // Real human price (tokenY per tokenX), not the raw geometric
              // pricePerLamport. The SDK's BinLiquidity.pricePerToken already
              // folds in the token-decimal scale (pricePerLamport ×
              // 10^(decX - decY)); the raw price is scale-free and useless as a
              // USD-like price (it made SOL/USDC report ~0.0758 instead of ~$76).
              currentPrice: Number(activeBin.pricePerToken || activeBin.price),
              timestamp: Date.now(),
              // tvl comes from on-chain reserves × price, but volume/fees are
              // modeled — see fetchPoolStats. The Meteora Data API overlay in
              // program.ts upgrades this to "datapi" when available.
              statsSource: "heuristic" as const,
            };
          }).pipe(
            Effect.catch((err) =>
              Effect.fail(
                new AdapterError({
                  message: `Failed to get pool state: ${String(err)}`,
                  poolAddress,
                  cause: err,
                }),
              ),
            ),
          ),

        /**
         * Legacy raw-price → real-price scale factor for a pool, from the token
         * decimals already unpacked by DLMM.create: 10^(decX - decY), the exact
         * per-pool constant pricePerToken / price equals. Used only by the
         * one-time price-scale backfill. Reads NO extra RPC (getActiveBin is
         * deliberately avoided — it is the slow/timeout-prone call and the factor
         * depends only on decimals, which DLMM.create already fetched).
         */
        getPriceScale: (poolAddress) =>
          Effect.gen(function* () {
            const dlmm = yield* getDlmm(poolAddress);
            const decX = dlmm.tokenX.mint.decimals;
            const decY = dlmm.tokenY.mint.decimals;
            if (!Number.isFinite(decX) || !Number.isFinite(decY)) {
              return 1;
            }
            const factor = 10 ** (decX - decY);
            if (!Number.isFinite(factor) || factor <= 0) {
              return 1;
            }
            return factor;
          }),

        getBinArray: (poolAddress) =>
          Effect.gen(function* () {
            const dlmm = yield* getDlmm(poolAddress);
            const activeBin = yield* memoizedActiveBin(poolAddress, dlmm);
            const halfRange = 20;
            const lowerBinId = activeBin.binId - halfRange;
            const upperBinId = activeBin.binId + halfRange;
            const binStep = Number(dlmm.lbPair.binStep);

            // Real per-bin reserves from the on-chain bin arrays. The SDK fills
            // uninitialized bins with zero-amount placeholders, which is the
            // truthful "empty bin" representation. Memoized with the active bin
            // so getPoolState + getBinArray share one fetch pair.
            const realBins = yield* memoizedBinsAround(poolAddress, dlmm, halfRange).pipe(
              Effect.catch((err) => {
                logger.warn(
                  "Real bin reserves unavailable — bin-derived metrics will be marked unknown",
                  { pool: poolAddress, error: String(err) },
                );
                return Effect.succeed(null);
              }),
            );

            if (realBins === null) {
              // Explicit unknown state: metrics skip the auth/utilization gates
              // with a warning instead of consuming fabricated 1.0 values. The
              // local memo value is the best available fallback.
              return {
                lowerBinId,
                upperBinId,
                bins: [],
                activeBinId: activeBin.binId,
                binStep,
                reservesKnown: false,
              };
            }

            // Derive the bounds + active bin FROM THE FETCHED SNAPSHOT, not the
            // local memo value: the pool can move between getPoolState and the
            // bins fetch, and realBins.activeBin is that fetch's own snapshot.
            // Filtering newer bins with an older ±20 range would distort the
            // bin-utilization/concentration inputs while reporting
            // reservesKnown: true.
            const snapshotActiveBinId = realBins.activeBin;
            const snapshotLower = snapshotActiveBinId - halfRange;
            const snapshotUpper = snapshotActiveBinId + halfRange;
            const snapshotActivePrice = realBins.bins.find(
              (b) => b.binId === snapshotActiveBinId,
            )?.price;
            const basePrice =
              snapshotActivePrice !== undefined
                ? Number(snapshotActivePrice)
                : Number(activeBin.price);
            const bins: BinData[] = realBins.bins
              .filter((b) => b.binId >= snapshotLower && b.binId <= snapshotUpper)
              .map((b) => {
                const parsedPrice = Number(b.price);
                return {
                  binId: b.binId,
                  price:
                    Number.isFinite(parsedPrice) && parsedPrice > 0
                      ? parsedPrice
                      : basePrice * Math.pow(1 + binStep / 10000, b.binId - snapshotActiveBinId),
                  reserveX: BigInt(b.xAmount.toString()),
                  reserveY: BigInt(b.yAmount.toString()),
                  liquiditySupply: BigInt(b.supply.toString()),
                };
              });

            return {
              lowerBinId: snapshotLower,
              upperBinId: snapshotUpper,
              bins,
              activeBinId: snapshotActiveBinId,
              binStep,
              reservesKnown: true,
            };
          }),

        getPositions: (poolAddress, walletAddress) =>
          Effect.gen(function* () {
            const wallet = new PublicKey(walletAddress);
            const dlmm = yield* getDlmm(poolAddress);
            const { userPositions } = yield* Effect.tryPromise(() =>
              dlmm.getPositionsByUserAndLbPair(wallet),
            );

            return userPositions.map((p) => {
              const data = p.positionData;
              return {
                id: p.publicKey.toBase58(),
                poolAddress,
                poolName: `${poolAddress.slice(0, 6)}...`,
                lowerBinId: data.lowerBinId,
                upperBinId: data.upperBinId,
                liquidityShares: BigInt(data.totalXAmount.toString()),
                depositedUsd: 0,
                currentValueUsd: 0,
                unrealizedPnlUsd: 0,
                feesEarnedUsd: Number(data.feeX.toString()) + Number(data.feeY.toString()),
                openedAt: data.lastUpdatedAt * 1000,
              };
            });
          }),

        // Real on-chain position mark (trailing-stop / PnL source of truth).
        // Reads the position account's actual X/Y holdings and prices them at
        // the pool's token mints. This is what replaced the bin-drift heuristic
        // (`deposited × (1 − 0.5 × driftPct)`) whose phantom drawdowns — a
        // 5-bin drift is a 10% "loss" on a binStep-10 pool, i.e. a 0.5% price
        // move — fired the trailing stop every cycle and churned positions.
        // Deliberately fail-open: null on any read/pricing problem so the
        // decision loop falls back to the HODL-anchored mark and never fails
        // the cycle. Cached ~60s so the per-cycle value loop and the claim
        // path share one read.
        getPositionValueUsd: (poolAddress, positionPubKey) => {
          const cacheKey = `posval:${poolAddress}:${positionPubKey}`;
          const cached = positionValueCache.get(cacheKey);
          if (cached !== undefined && Date.now() - cached.fetchedAt < POSITION_VALUE_CACHE_TTL_MS) {
            return Effect.succeed(cached.value);
          }
          return Effect.gen(function* () {
            const dlmm = yield* getDlmm(poolAddress);
            const position = yield* Effect.tryPromise(() =>
              dlmm.getPosition(new PublicKey(positionPubKey)),
            );
            const positionData = position.positionData;
            const tokenXMint = dlmm.lbPair.tokenXMint.toBase58();
            const tokenYMint = dlmm.lbPair.tokenYMint.toBase58();
            // No static fallback prices: a fabricated mark would skip the
            // HODL-anchored fallback in the decision loop and could drive
            // trailing-stop / IL / dust decisions on made-up numbers. Live
            // prices only; any missing or non-positive leg fails open to null.
            const prices = yield* fetchTokenPrices([tokenXMint, tokenYMint], {
              useFallback: false,
            });
            const priceX = prices[tokenXMint];
            const priceY = prices[tokenYMint];
            if (priceX === undefined || priceX <= 0 || priceY === undefined || priceY <= 0) {
              return null;
            }
            const decimalsX = dlmm.tokenX.mint.decimals;
            const decimalsY = dlmm.tokenY.mint.decimals;
            const xUsd = (Number(positionData.totalXAmount.toString()) / 10 ** decimalsX) * priceX;
            const yUsd = (Number(positionData.totalYAmount.toString()) / 10 ** decimalsY) * priceY;
            const valueUsd = xUsd + yUsd;
            if (!Number.isFinite(valueUsd) || valueUsd <= 0) return null;
            positionValueCache.set(cacheKey, { fetchedAt: Date.now(), value: valueUsd });
            return valueUsd;
          }).pipe(
            Effect.catch(() => {
              return Effect.succeed(null);
            }),
          );
        },

        getAllWalletPositions: (walletAddress) =>
          Effect.gen(function* () {
            const wallet = new PublicKey(walletAddress);
            // DLMM.getAllLbPairPositionsByUser returns a Map<poolAddress, PositionInfo> for all pools
            const allPositions = yield* rpcCall((conn) =>
              DLMM.getAllLbPairPositionsByUser(conn, wallet),
            );

            const result: Array<{
              poolAddress: string;
              positionPubKey: string;
              lowerBinId: number;
              upperBinId: number;
            }> = [];
            for (const [poolAddress, info] of allPositions.entries()) {
              for (const pos of info.lbPairPositionsData) {
                result.push({
                  poolAddress,
                  positionPubKey: pos.publicKey.toBase58(),
                  lowerBinId: pos.positionData.lowerBinId,
                  upperBinId: pos.positionData.upperBinId,
                });
              }
            }
            return result;
          }),

        getWalletPositionsFromDatapi: (walletAddress) =>
          Effect.gen(function* () {
            const baseUrl = config.meteoraDatapiBaseUrl;
            // 90s TTL caps duplicate /portfolio/open crawls within a scan cycle
            // (the wallet is reconciled once per cycle) without serving data so
            // stale that it outraces on-chain state on a fallback read.
            const positions = yield* effectGetOpenPositions(
              baseUrl,
              walletAddress,
              datapiPositionCache,
            );
            return positions
              .filter(
                (p) =>
                  p.poolAddress !== undefined &&
                  p.lowerBin !== undefined &&
                  p.upperBin !== undefined,
              )
              .map((p) => ({
                // The Data API positionId is the on-chain position pubkey for
                // open DLMM positions; the SDK reconcile matches on this.
                // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
                poolAddress: (p as OpenPosition & { poolAddress: string }).poolAddress,
                positionPubKey: p.positionId,
                lowerBinId: p.lowerBin!,
                upperBinId: p.upperBin!,
              }));
          }).pipe(
            Effect.catch((err) =>
              Effect.fail(
                new AdapterError({
                  message: `Failed to crawl Data API positions: ${underlyingErrorMessage(err)}`,
                  cause: err,
                }),
              ),
            ),
          ),

        simulateRebalance: (poolAddress, positionPubKey, newLowerBinId, newUpperBinId) =>
          Effect.gen(function* () {
            if (!wallet) {
              return yield* Effect.fail(
                new AdapterError({
                  message: "No wallet configured — cannot simulate an on-chain rebalance",
                  poolAddress,
                }),
              );
            }

            const dlmm = yield* getDlmm(poolAddress);
            const positionPubkey = new PublicKey(positionPubKey);
            // Fresh lbPair so the simulated deltas and the position read agree
            // on the active bin.
            yield* Effect.tryPromise(() => dlmm.refetchStates());
            const position = yield* Effect.tryPromise(() => dlmm.getPosition(positionPubkey));
            const positionData = position.positionData;

            const tokenXMint = dlmm.lbPair.tokenXMint.toBase58();
            const tokenYMint = dlmm.lbPair.tokenYMint.toBase58();
            const prices = yield* fetchTokenPrices([tokenXMint, tokenYMint]);
            const decimalsX = dlmm.tokenX.mint.decimals;
            const decimalsY = dlmm.tokenY.mint.decimals;
            // The position's real claimable fees — the measurable benefit of the
            // rebalance (they are harvested by the engine's own claim path).
            const feeXUsd =
              (Number(positionData.feeX.toString()) / 10 ** decimalsX) * (prices[tokenXMint] ?? 0);
            const feeYUsd =
              (Number(positionData.feeY.toString()) / 10 ** decimalsY) * (prices[tokenYMint] ?? 0);
            const estimatedFeesUsd = feeXUsd + feeYUsd;

            const plan = buildAtomicRebalancePlan({
              activeBinId: dlmm.lbPair.activeId,
              binStep: dlmm.lbPair.binStep,
              positionData,
              newLowerBinId,
              newUpperBinId,
            });
            const simulation = yield* Effect.tryPromise(() =>
              dlmm.simulateRebalancePosition(
                positionPubkey,
                positionData,
                false,
                false,
                plan.deposits,
                plan.withdraws,
              ),
            );

            // binArrayCost / bitmapExtensionCost are quoted in SOL (SDK rent
            // constants) — the real, on-chain cost of the rebalance.
            const rentCostSol = simulation.binArrayCost + simulation.bitmapExtensionCost;
            const estimatedCostUsd = rentCostSol * config.solPriceUsd;
            const netBenefitUsd = estimatedFeesUsd - estimatedCostUsd;

            logger.info("rebalance simulation", {
              pool: poolAddress,
              position: positionPubKey,
              feeXUsd,
              feeYUsd,
              rentCostSol,
              newBinArrays: simulation.binArrayCount,
              netBenefitUsd,
            });

            return {
              estimatedFeesUsd,
              estimatedCostUsd,
              netBenefitUsd,
              source: "sdk-simulation" as const,
            };
          }).pipe(
            Effect.catch((err) =>
              Effect.fail(
                new AdapterError({
                  message: `Failed to simulate rebalance: ${underlyingErrorMessage(err)}`,
                  poolAddress,
                  cause: err,
                }),
              ),
            ),
          ),

        enterPosition: (poolAddress, lowerBinId, upperBinId, positionSizeUsd, options) =>
          Effect.gen(function* () {
            if (!wallet) {
              return yield* Effect.fail(
                new AdapterError({
                  message: "No wallet configured",
                }),
              );
            }

            const dlmm = yield* getDlmm(poolAddress);
            const pool = yield* api.getPoolState(poolAddress);

            const forceSingleSidedX = options?.forceSingleSidedX === true;
            const { priceX, priceY } = yield* fetchEntryPrices(
              poolAddress,
              pool.tokenX,
              pool.tokenY,
              forceSingleSidedX,
            );

            const halfUsd = positionSizeUsd / 2;
            const tokenXDecimals = yield* getTokenMeta(pool.tokenX).pipe(
              Effect.map((m) => m.decimals),
            );
            const tokenYDecimals = forceSingleSidedX
              ? 0
              : yield* getTokenMeta(pool.tokenY).pipe(Effect.map((m) => m.decimals));

            const requestedXAmount = computeRequiredAtomic(halfUsd, priceX, tokenXDecimals);
            const requestedYAmount = computeRequiredAtomic(halfUsd, priceY, tokenYDecimals);

            if (!forceSingleSidedX && (requestedXAmount === 0n || requestedYAmount === 0n)) {
              return yield* Effect.fail(
                new AdapterError({
                  message: "Cannot enter a position with a zero-sized token leg",
                  poolAddress,
                }),
              );
            }

            // Check balances
            const { balanceX, balanceY, nativeSolBalance } = yield* readEntryBalances(
              pool.tokenX,
              pool.tokenY,
              forceSingleSidedX,
            );
            const maxX = capSolLegForGas(balanceX, pool.tokenX === SOL_MINT, nativeSolBalance);
            const maxY = forceSingleSidedX
              ? 0n
              : capSolLegForGas(balanceY, pool.tokenY === SOL_MINT, nativeSolBalance);

            // Funding classification: two-sided when both legs cover their half
            // of the position; otherwise the SDK single-sided deposit path with
            // the held leg when it alone covers the full position size
            // (StrategyParameters.singleSidedX). "Short" means the leg cannot
            // fund its half — for a SOL leg that includes anything at or below
            // the gas reserve.
            const xShort = requestedXAmount > maxX;
            const yShort = requestedYAmount > maxY;
            const shortageX = `${pool.tokenX} required ${formatTokenAmount(requestedXAmount, tokenXDecimals)}, available ${formatTokenAmount(maxX, tokenXDecimals)}${pool.tokenX === SOL_MINT ? " after gas reserve" : ""}`;
            const shortageY = `${pool.tokenY} required ${formatTokenAmount(requestedYAmount, tokenYDecimals)}, available ${formatTokenAmount(maxY, tokenYDecimals)}${pool.tokenY === SOL_MINT ? " after gas reserve" : ""}`;

            const deposit = yield* resolveEntryDeposit({
              poolAddress,
              tokenX: pool.tokenX,
              tokenY: pool.tokenY,
              positionSizeUsd,
              priceX,
              priceY,
              tokenXDecimals,
              tokenYDecimals,
              requestedXAmount,
              requestedYAmount,
              maxX,
              maxY,
              xShort,
              yShort,
              shortageX,
              shortageY,
              forceSingleSidedX,
            });
            const {
              depositXAtomic,
              depositYAtomic,
              depositMode,
              singleSidedX,
              amountXUsd,
              amountYUsd,
            } = deposit;
            logEntryDepositMode(
              poolAddress,
              pool.tokenX,
              depositMode,
              depositXAtomic,
              positionSizeUsd,
              forceSingleSidedX,
            );

            const totalXAmount = new BN(depositXAtomic.toString());
            const totalYAmount = new BN(depositYAtomic.toString());

            const strategy = buildEntryStrategy(
              lowerBinId,
              upperBinId,
              options?.strategySpec,
              singleSidedX,
            );

            const positionKeypair = new Keypair();

            const tx = yield* Effect.tryPromise(() =>
              dlmm.initializePositionAndAddLiquidityByStrategy({
                positionPubKey: positionKeypair.publicKey,
                totalXAmount,
                totalYAmount,
                strategy,
                user: wallet.publicKey,
                slippage: 50,
              }),
            );

            const transactionLamports = getWalletSystemLamportsRequired(
              tx.instructions,
              wallet.publicKey,
            );
            const requiredLamports = transactionLamports + GAS_RESERVE_LAMPORTS;
            const actualSolBalance = yield* readNativeSolBalance({ force: true });
            if (actualSolBalance < requiredLamports) {
              return yield* Effect.fail(
                new AdapterError({
                  message: `Insufficient SOL for live entry transaction: required ${formatTokenAmount(requiredLamports, 9)} (direct System Program debits plus ${formatTokenAmount(GAS_RESERVE_LAMPORTS, 9)} reserve for fees, ATA rent and other costs), available ${formatTokenAmount(actualSolBalance, 9)}.`,
                  poolAddress,
                }),
              );
            }

            tx.feePayer = wallet.publicKey;
            const { blockhash } = yield* rpcCall((conn) => conn.getLatestBlockhash());
            tx.recentBlockhash = blockhash;
            tx.sign(wallet, positionKeypair);

            const signature = yield* rpcCall((conn) =>
              conn.sendRawTransaction(tx.serialize(), {
                skipPreflight: false,
                preflightCommitment: "confirmed",
              }),
            );

            // Invalidate AFTER confirmation, like every other tx path. Invalidating
            // before the tx lands re-fills the cache with the pre-entry balance and
            // keeps serving that stale value for the whole 30s TTL.
            yield* rpcCall((conn) => conn.confirmTransaction(signature, "confirmed"));
            yield* invalidateBalanceCaches;

            return {
              positionPubKey: positionKeypair.publicKey.toBase58(),
              txSignature: signature,
              depositMode,
              amountXUsd,
              amountYUsd,
            };
          }).pipe(
            Effect.catch((err) =>
              Effect.fail(
                new AdapterError({
                  message: `Failed to enter position: ${String(err)}`,
                  poolAddress,
                  cause: err,
                }),
              ),
            ),
          ),

        exitPosition: (poolAddress, positionPubKey) =>
          Effect.gen(function* () {
            if (!wallet) {
              return yield* Effect.fail(
                new AdapterError({
                  message: "No wallet configured",
                }),
              );
            }

            const positionPubkey = new PublicKey(positionPubKey);
            const dlmm = yield* getDlmm(poolAddress);

            const position = yield* Effect.tryPromise(() => dlmm.getPosition(positionPubkey));
            const positionData = position.positionData;
            const lowerBinId = positionData.lowerBinId;
            const upperBinId = positionData.upperBinId;

            // Empty-position reap: a position with zero principal on-chain cannot
            // be withdrawn via `removeLiquidity` — the SDK dereferences
            // `activeBins[0].binId` and THROWS for an empty account (the
            // on-chain observation that made a live EXIT decision fail every
            // cycle while the heuristic PIP mark kept showing phantom value).
            // Detect the empty state up front (one `isZero` check on data we
            // already hold), best-effort reclaim rent via `closePositionIfEmpty`,
            // and return an `isEmptyReap` result so the caller settles the ledger
            // as a no-op cleanup instead of a fabricated loss. Reclaiming the
            // account also removes it from the wallet's on-chain set, so the next
            // reconcile's chain-delete loop is a no-op and the ghost is not
            // re-discovered as an "external position".
            if (
              positionData.totalXAmountExcludeTransferFee.isZero() &&
              positionData.totalYAmountExcludeTransferFee.isZero()
            ) {
              let txSignature: string | null = null;
              const closeTx = yield* Effect.tryPromise(() =>
                dlmm.closePositionIfEmpty({ owner: wallet.publicKey, position }),
              ).pipe(Effect.catch(() => Effect.succeed(null)));
              if (closeTx) {
                try {
                  const { blockhash } = yield* rpcCall((conn) => conn.getLatestBlockhash());
                  closeTx.feePayer = wallet.publicKey;
                  closeTx.recentBlockhash = blockhash;
                  closeTx.sign(wallet);
                  const signature = yield* rpcCall((conn) =>
                    conn.sendRawTransaction(closeTx.serialize(), {
                      skipPreflight: false,
                      preflightCommitment: "confirmed",
                    }),
                  );
                  yield* rpcCall((conn) => conn.confirmTransaction(signature, "confirmed"));
                  txSignature = signature;
                } catch (err) {
                  // Rent reclaim is best-effort: the ledger reap must proceed
                  // regardless. A failed close leaves the empty account on-chain
                  // (rent-locked but inert); it carries no value, so subsequent
                  // passes keep reaping without booking anything.
                  logger.warn(
                    `[exit] empty position ${positionPubkey.toBase58()} — ledger reaped, account close failed: ${String(err)}`,
                  );
                }
              }
              yield* invalidateBalanceCaches;
              return {
                txSignature: txSignature ?? "empty-reap",
                withdrawnXAtomic: "0",
                withdrawnYAtomic: "0",
                withdrawnUsd: 0,
                pendingFeeXAtomic: "0",
                pendingFeeYAtomic: "0",
                pendingFeeUsd: 0,
                sweptRewards: [],
                isEmptyReap: true,
              };
            }

            // Pre-close snapshot of the exact on-chain amounts about to be
            // withdrawn. The close batch (`shouldClaimAndClose`) sweeps these
            // accrued swap fees AND LM rewards on-chain, so withdrawn =
            // principal + pending fees. The *ExcludeTransferFee variants equal
            // gross for plain SPL and are correct (net-of-fee) for token-2022.
            //
            // Issue #205: the SDK snapshot can understate the actual withdrawal
            const tokenXMint = dlmm.lbPair.tokenXMint.toBase58();
            const tokenYMint = dlmm.lbPair.tokenYMint.toBase58();
            const rewardOneAtomic = positionData.rewardOneExcludeTransferFee;
            const rewardTwoAtomic = positionData.rewardTwoExcludeTransferFee;
            // Reward slots (mint + pending atomic), resolved once and shared by
            // the same-mint reward exclusion on the measured withdrawal delta
            // and the sweptRewards ledger below.
            const rewardInfos = dlmm.lbPair.rewardInfos;
            const mintOf = (mint: PublicKey | undefined): string | null => {
              const base58 = mint?.toBase58();
              return base58 != null && base58 !== DEFAULT_PUBLIC_KEY ? base58 : null;
            };
            const rewardSlots = [
              { mint: mintOf(rewardInfos[0]?.mint), amountAtomic: rewardOneAtomic },
              { mint: mintOf(rewardInfos[1]?.mint), amountAtomic: rewardTwoAtomic },
            ].filter((s) => s.amountAtomic > 0n);

            // Pre-close wallet holdings WITHOUT pricing (a price lookup must not
            // delay broadcasting an exit) and a FORCED native-SOL read (bypasses
            // the 30s cache so the measured delta covers only the close window).
            // The SPL holdings baseline comes from the 30s cache: the scan cycle
            // populates it at the top of every pass, so it is already fresh and
            // returns instantly — a live `getParsedTokenAccountsByOwner` here is
            // exactly what times out on a degraded RPC and silently falls back
            // to the known-understating SDK snapshot (the phantom-loss path).
            // A cache miss still re-fetches and stays bounded by the short
            // deadline, so the exit is never postponed.
            const preClose = yield* Effect.all(
              {
                held: cachedWalletHoldings.pipe(Effect.catch(() => Effect.succeed(null))),
                nativeSol: readNativeSolBalance({ force: true }).pipe(
                  Effect.catch(() => Effect.succeed(null)),
                ),
              },
              { concurrency: "unbounded" },
            ).pipe(
              Effect.timeout(Duration.millis(2000)),
              Effect.catch(() => Effect.succeed({ held: null, nativeSol: null })),
            );
            const beforeHeld = preClose.held;
            const beforeNativeSol = preClose.nativeSol;

            const txs = yield* Effect.tryPromise(() =>
              dlmm.removeLiquidity({
                user: wallet.publicKey,
                position: positionPubkey,
                fromBinId: lowerBinId,
                toBinId: upperBinId,
                bps: new BN(10000),
                shouldClaimAndClose: true,
              }),
            );

            for (const tx of txs) {
              const { blockhash } = yield* rpcCall((conn) => conn.getLatestBlockhash());
              tx.feePayer = wallet.publicKey;
              tx.recentBlockhash = blockhash;
              tx.sign(wallet);

              const signature = yield* rpcCall((conn) =>
                conn.sendRawTransaction(tx.serialize(), {
                  skipPreflight: false,
                  preflightCommitment: "confirmed",
                }),
              );
              yield* rpcCall((conn) => conn.confirmTransaction(signature, "confirmed"));
            }
            yield* invalidateBalanceCaches;

            const snapshotWithdrawnXAtomic = positionData.totalXAmountExcludeTransferFee
              .add(positionData.feeXExcludeTransferFee)
              .toString();
            const snapshotWithdrawnYAtomic = positionData.totalYAmountExcludeTransferFee
              .add(positionData.feeYExcludeTransferFee)
              .toString();

            // Prefer the measured wallet delta (post-close minus pre-close) per
            // leg. The delta includes swept fees/rewards (shouldClaimAndClose),
            // which is exactly what the settlement must sell — same-mint rewards
            // are excluded because the exit books them separately. Falls back to
            // the SDK snapshot when the delta is unmeasurable or non-positive.
            //
            // The post-close read runs AFTER the close txs have confirmed, so a
            // slow read here only delays the accounting (never the exit) — give
            // it a generous deadline so the measured delta survives a degraded
            // RPC instead of silently booking the understating snapshot.
            const afterSnapshot = yield* Effect.all(
              {
                held: readWalletHoldingsRaw().pipe(Effect.catch(() => Effect.succeed(null))),
                nativeSol: readNativeSolBalance().pipe(Effect.catch(() => Effect.succeed(null))),
              },
              { concurrency: "unbounded" },
            ).pipe(
              Effect.timeout(Duration.millis(20000)),
              Effect.catch(() => Effect.succeed({ held: null, nativeSol: null })),
            );
            const measuredX = measureWithdrawalDelta({
              beforeHeld,
              afterHeld: afterSnapshot.held,
              beforeNativeSol,
              afterNativeSol: afterSnapshot.nativeSol,
              mint: tokenXMint,
              snapshotAmount: snapshotWithdrawnXAtomic,
            });
            const measuredY = measureWithdrawalDelta({
              beforeHeld,
              afterHeld: afterSnapshot.held,
              beforeNativeSol,
              afterNativeSol: afterSnapshot.nativeSol,
              mint: tokenYMint,
              snapshotAmount: snapshotWithdrawnYAtomic,
            });
            const withdrawnXAtomic = excludeSameMintRewards(measuredX, tokenXMint, rewardSlots);
            const withdrawnYAtomic = excludeSameMintRewards(measuredY, tokenYMint, rewardSlots);
            if (!measuredX.measured || !measuredY.measured) {
              // The measured flag distinguishes on-chain-delta withdrawals from
              // the known-understating SDK snapshot in the audit trail — a
              // silent fallback would defeat the point of #205. Exits are rare,
              // so an unbounded warn per exit is fine.
              logger.warn(
                `[exit] withdrawal delta unmeasured for ${positionPubkey.toBase58()} — booking SDK snapshot amounts (X: ${measuredX.measured ? "measured" : "snapshot"}, Y: ${measuredY.measured ? "measured" : "snapshot"})`,
              );
            }
            const pendingFeeXAtomic = positionData.feeXExcludeTransferFee.toString();
            const pendingFeeYAtomic = positionData.feeYExcludeTransferFee.toString();

            // USD pricing is best-effort and runs ONLY after the close txs land —
            // it must never abort or delay removing bleeding liquidity. Any
            // failure resolves the USD legs to null (never 0, never the mark) so
            // the caller books a NULL realized PnL; atomics are always returned.
            const accounting = yield* Effect.gen(function* () {
              const decimalsX = dlmm.tokenX.mint.decimals;
              const decimalsY = dlmm.tokenY.mint.decimals;

              const priceMints = [
                tokenXMint,
                tokenYMint,
                ...rewardSlots.map((s) => s.mint).filter((m): m is string => m != null),
              ];
              // useFallback: false — the static $165/$1 fallback map must NOT pass
              // the all-or-nothing gate here, or a FABRICATED realized would be
              // booked instead of NULL. This batch prices the withdraw legs, the
              // pending-fee legs AND the swept-reward mints, so the opt-out covers
              // every ledger-booking input at once (mirrors the wallet path).
              const prices = yield* fetchTokenPrices(priceMints, { useFallback: false }).pipe(
                Effect.catch(() => Effect.succeed(EMPTY_TOKEN_PRICES)),
              );

              // All-or-nothing on the withdrawn/pending legs: ANY unresolved leg
              // price poisons both (a partial USD value would mis-state realized
              // PnL). price<=0 (incl. the negative-cache 0) counts as unresolved.
              const priceX = prices[tokenXMint];
              const priceY = prices[tokenYMint];
              let withdrawnUsd: number | null = null;
              let pendingFeeUsd: number | null = null;
              if (priceX != null && priceX > 0 && priceY != null && priceY > 0) {
                withdrawnUsd =
                  atomicToUnits(BigInt(withdrawnXAtomic), decimalsX) * priceX +
                  atomicToUnits(BigInt(withdrawnYAtomic), decimalsY) * priceY;
                pendingFeeUsd =
                  atomicToUnits(BigInt(pendingFeeXAtomic), decimalsX) * priceX +
                  atomicToUnits(BigInt(pendingFeeYAtomic), decimalsY) * priceY;
              }

              // Reward slots price independently (mirror claimRewards): an
              // unpriceable slot records amountUsd null, never blocks the exit.
              const sweptRewards: ClaimedReward[] = [];
              for (const slot of rewardSlots) {
                let amountUsd: number | null = null;
                if (slot.mint != null) {
                  const price = prices[slot.mint];
                  if (price != null && price > 0) {
                    const decimals = yield* getTokenMeta(slot.mint).pipe(
                      Effect.map((m) => m.decimals),
                      Effect.catch(() => Effect.succeed(null)),
                    );
                    if (decimals != null) {
                      amountUsd = atomicToUnits(BigInt(slot.amountAtomic), decimals) * price;
                    }
                  }
                }
                sweptRewards.push({
                  mint: slot.mint ?? "unknown",
                  amountAtomic: Number(slot.amountAtomic.toString()),
                  amountUsd,
                });
              }

              return { withdrawnUsd, pendingFeeUsd, sweptRewards };
            }).pipe(
              Effect.catch(() =>
                Effect.succeed({
                  // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
                  withdrawnUsd: null as number | null,
                  // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
                  pendingFeeUsd: null as number | null,
                  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
                  sweptRewards: [] as ClaimedReward[],
                }),
              ),
            );

            return {
              txSignature: "batch-confirmed",
              withdrawnXAtomic,
              withdrawnYAtomic,
              withdrawnUsd: accounting.withdrawnUsd,
              pendingFeeXAtomic,
              pendingFeeYAtomic,
              pendingFeeUsd: accounting.pendingFeeUsd,
              sweptRewards: accounting.sweptRewards,
            };
          }).pipe(
            Effect.catch((err) =>
              Effect.fail(
                new AdapterError({
                  message: `Failed to exit position: ${String(err)}`,
                  poolAddress,
                  cause: err,
                }),
              ),
            ),
          ),

        placeLimitOrder: (poolAddress, request: LimitOrderRequest) =>
          Effect.gen(function* () {
            if (!wallet) {
              return yield* Effect.fail(new AdapterError({ message: "No wallet configured" }));
            }
            const dlmm = yield* getDlmm(poolAddress);
            const concreteFunctionType = Number(
              // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
              (dlmm.lbPair as { concreteFunctionType?: number }).concreteFunctionType ?? -1,
            );
            const validated = validateLimitOrderRequest(
              request,
              concreteFunctionType,
              ConcreteFunctionType.LimitOrder,
            );
            const limitOrder = new Keypair();
            const params = {
              isAskSide: validated.isAskSide,
              bins: [
                { id: validated.targetBinId, amount: new BN(validated.amountAtomic.toString()) },
              ],
              ...(validated.maxActiveBinSlippage === undefined
                ? undefined
                : {
                    relativeBin: {
                      activeId: dlmm.lbPair.activeId,
                      maxActiveBinSlippage: validated.maxActiveBinSlippage,
                    },
                  }),
            };
            const tx = yield* Effect.tryPromise(() =>
              dlmm.placeLimitOrder({
                owner: wallet.publicKey,
                payer: wallet.publicKey,
                sender: wallet.publicKey,
                limitOrder: limitOrder.publicKey,
                params,
              }),
            );
            const { blockhash } = yield* rpcCall((conn) => conn.getLatestBlockhash());
            tx.feePayer = wallet.publicKey;
            tx.recentBlockhash = blockhash;
            tx.sign(wallet, limitOrder);
            const txSignature = yield* rpcCall((conn) =>
              conn.sendRawTransaction(tx.serialize(), {
                skipPreflight: false,
                preflightCommitment: "confirmed",
              }),
            );
            yield* rpcCall((conn) => conn.confirmTransaction(txSignature, "confirmed"));
            return { orderPubKey: limitOrder.publicKey.toBase58(), txSignature };
          }).pipe(
            Effect.catch((err) =>
              Effect.fail(
                new AdapterError({
                  message: `Failed to place limit order: ${underlyingErrorMessage(err)}`,
                  poolAddress,
                  cause: err,
                }),
              ),
            ),
          ),

        cancelLimitOrder: (poolAddress, orderPubKey, binIds) =>
          Effect.gen(function* () {
            if (!wallet) {
              return yield* Effect.fail(new AdapterError({ message: "No wallet configured" }));
            }
            if (binIds.length === 0 || binIds.some((binId) => !Number.isSafeInteger(binId))) {
              return yield* Effect.fail(
                new AdapterError({ message: "Invalid limit-order bin IDs" }),
              );
            }
            const dlmm = yield* getDlmm(poolAddress);
            const tx = yield* Effect.tryPromise(() =>
              dlmm.cancelLimitOrder({
                limitOrderPubkey: new PublicKey(orderPubKey),
                owner: wallet.publicKey,
                rentReceiver: wallet.publicKey,
                binIds: [...binIds],
              }),
            );
            const { blockhash } = yield* rpcCall((conn) => conn.getLatestBlockhash());
            tx.feePayer = wallet.publicKey;
            tx.recentBlockhash = blockhash;
            tx.sign(wallet);
            const txSignature = yield* rpcCall((conn) =>
              conn.sendRawTransaction(tx.serialize(), {
                skipPreflight: false,
                preflightCommitment: "confirmed",
              }),
            );
            yield* rpcCall((conn) => conn.confirmTransaction(txSignature, "confirmed"));
            return { txSignature };
          }).pipe(
            Effect.catch((err) =>
              Effect.fail(
                new AdapterError({
                  message: `Failed to cancel limit order: ${underlyingErrorMessage(err)}`,
                  poolAddress,
                  cause: err,
                }),
              ),
            ),
          ),

        rebalancePosition: (poolAddress, positionPubKey, newLowerBinId, newUpperBinId, topUp) =>
          Effect.gen(function* () {
            if (!wallet) {
              return yield* Effect.fail(
                new AdapterError({
                  message: "No wallet configured",
                }),
              );
            }

            const dlmm = yield* getDlmm(poolAddress);
            const positionPubkey = new PublicKey(positionPubKey);
            yield* Effect.tryPromise(() => dlmm.refetchStates());
            const position = yield* Effect.tryPromise(() => dlmm.getPosition(positionPubkey));
            const positionData = position.positionData;

            const plan = buildAtomicRebalancePlan({
              activeBinId: dlmm.lbPair.activeId,
              binStep: dlmm.lbPair.binStep,
              positionData,
              newLowerBinId,
              newUpperBinId,
              ...(topUp ? { topUp } : undefined),
            });
            // Simulation first: the response carries the quoted amounts and the
            // bin-array/bitmap coverage the instruction builder needs.
            const simulation = yield* Effect.tryPromise(() =>
              dlmm.simulateRebalancePosition(
                positionPubkey,
                positionData,
                false,
                false,
                plan.deposits,
                plan.withdraws,
              ),
            );
            const { initBinArrayInstructions, rebalancePositionInstruction } =
              yield* Effect.tryPromise(() =>
                dlmm.rebalancePosition(
                  simulation,
                  new BN(MAX_ACTIVE_BIN_SLIPPAGE),
                  wallet.publicKey,
                  REBALANCE_SLIPPAGE_PERCENT,
                ),
              );

            const txSignatures: string[] = [];
            // New bin arrays must exist on-chain before the rebalance
            // instruction references them — send and confirm their init
            // transactions first. A failure here leaves the position itself
            // untouched (only rent for the new arrays is spent).
            for (
              let i = 0;
              i < initBinArrayInstructions.length;
              i += MAX_INIT_BIN_ARRAY_IXS_PER_TX
            ) {
              const chunk = initBinArrayInstructions.slice(i, i + MAX_INIT_BIN_ARRAY_IXS_PER_TX);
              txSignatures.push(yield* sendInstructions(chunk));
            }
            txSignatures.push(yield* sendInstructions(rebalancePositionInstruction));
            yield* invalidateBalanceCaches;

            logger.info("atomic rebalance executed", {
              pool: poolAddress,
              position: positionPubKey,
              newLowerBinId,
              newUpperBinId,
              txSignatures,
            });

            return { positionPubKey, txSignatures };
          }).pipe(
            Effect.catch((err) =>
              Effect.fail(
                new AdapterError({
                  message: `Failed to atomically rebalance position: ${underlyingErrorMessage(err)}`,
                  poolAddress,
                  cause: err,
                }),
              ),
            ),
          ),

        claimFees: (
          poolAddress,
          positionPubKey,
          platformFeeRate,
          revenueShareEnabled,
          revenueShareOperatorPct,
          feeWalletAddress,
        ) =>
          Effect.gen(function* () {
            if (!wallet) {
              return yield* Effect.fail(
                new AdapterError({
                  message: "No wallet configured",
                }),
              );
            }

            const positionPubkey = new PublicKey(positionPubKey);
            const dlmm = yield* getDlmm(poolAddress);

            const position = yield* Effect.tryPromise(() => dlmm.getPosition(positionPubkey));

            const feeX = Number(position.positionData.feeX.toString());
            const feeY = Number(position.positionData.feeY.toString());

            if (feeX === 0 && feeY === 0) {
              return {
                txSignature: "",
                feeX: 0,
                feeY: 0,
                platformFeeX: 0,
                platformFeeY: 0,
                netFeeX: 0,
                netFeeY: 0,
                netFeesUsd: 0,
              };
            }

            const txs = yield* Effect.tryPromise(() =>
              dlmm.claimSwapFee({
                owner: wallet.publicKey,
                position: position,
              }),
            );

            const claimInstructions = txs.flatMap((tx) => tx.instructions);

            if (claimInstructions.length === 0) {
              return {
                txSignature: "",
                feeX: 0,
                feeY: 0,
                platformFeeX: 0,
                platformFeeY: 0,
                netFeeX: 0,
                netFeeY: 0,
                netFeesUsd: 0,
              };
            }

            const feeWallet = feeWalletAddress ?? "";
            const operatorWalletAddress = wallet.publicKey.toBase58();
            const revenueShare = calculateRevenueShare(
              feeX,
              feeY,
              platformFeeRate,
              revenueShareEnabled ?? false,
              revenueShareOperatorPct ?? 0,
              feeWallet,
              operatorWalletAddress,
            );
            let transferInstructions: TransactionInstruction[] = [];
            let actualPlatformFeeX = 0;
            let actualPlatformFeeY = 0;
            let actualOperatorFeeX = 0;
            let actualOperatorFeeY = 0;

            if (revenueShare.platformFeeX > 0 || revenueShare.platformFeeY > 0) {
              if (revenueShare.isCircular) {
                logger.info("Circular wallet detected — fees retained by operator", {
                  pool: poolAddress,
                  platformFeeX: revenueShare.platformFeeX,
                  platformFeeY: revenueShare.platformFeeY,
                });
                actualPlatformFeeX = revenueShare.platformFeeX;
                actualPlatformFeeY = revenueShare.platformFeeY;
                actualOperatorFeeX = revenueShare.platformFeeX;
                actualOperatorFeeY = revenueShare.platformFeeY;
              } else if (feeWallet) {
                const feeWalletPubkey = new PublicKey(feeWallet);
                // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
                const tokenXMint = dlmm.lbPair.tokenXMint as PublicKey;
                // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
                const tokenYMint = dlmm.lbPair.tokenYMint as PublicKey;

                const mints: Array<[PublicKey, number]> = [
                  [tokenXMint, revenueShare.amountToTransferX],
                  [tokenYMint, revenueShare.amountToTransferY],
                ];

                for (const [mint, amount] of mints) {
                  if (amount < 1) continue;
                  const fromAta = yield* Effect.tryPromise(() =>
                    getAssociatedTokenAddress(mint, wallet!.publicKey),
                  );
                  const toAta = yield* Effect.tryPromise(() =>
                    getAssociatedTokenAddress(mint, feeWalletPubkey),
                  );
                  // Check if destination ATA exists
                  const toAtaInfo = yield* rpcCall((conn) => conn.getAccountInfo(toAta));
                  if (!toAtaInfo) {
                    transferInstructions.push(
                      createAssociatedTokenAccountInstruction(
                        wallet!.publicKey,
                        toAta,
                        feeWalletPubkey,
                        mint,
                      ),
                    );
                  }
                  transferInstructions.push(
                    createTransferInstruction(
                      fromAta,
                      toAta,
                      wallet!.publicKey,
                      BigInt(Math.floor(amount)),
                    ),
                  );
                }

                if (transferInstructions.length > 0) {
                  actualPlatformFeeX = revenueShare.platformFeeX;
                  actualPlatformFeeY = revenueShare.platformFeeY;
                  actualOperatorFeeX = revenueShare.operatorFeeX;
                  actualOperatorFeeY = revenueShare.operatorFeeY;
                } else {
                  logger.info("No platform fee to transfer — operator keeps full share", {
                    pool: poolAddress,
                  });
                }
              } else {
                logger.warn("No fee wallet configured — skipping platform fee transfer", {
                  pool: poolAddress,
                });
              }
            }

            const allInstructions = [...claimInstructions, ...transferInstructions];

            const { blockhash } = yield* rpcCall((conn) => conn.getLatestBlockhash());

            const messageV0 = new TransactionMessage({
              payerKey: wallet.publicKey,
              recentBlockhash: blockhash,
              instructions: allInstructions,
            }).compileToV0Message();

            const versionedTx = new VersionedTransaction(messageV0);
            versionedTx.sign([wallet]);

            const signature = yield* rpcCall((conn) =>
              conn.sendRawTransaction(versionedTx.serialize(), {
                skipPreflight: false,
                preflightCommitment: "confirmed",
              }),
            );

            yield* rpcCall((conn) => conn.confirmTransaction(signature, "confirmed"));
            yield* invalidateBalanceCaches;

            const netFeeX = feeX - actualPlatformFeeX;
            const netFeeY = feeY - actualPlatformFeeY;
            // Mint-based USD of the NET claim, priced here where dlmm + mints +
            // decimals are in scope (mirrors simulateRebalance). Null when
            // either leg is unpriceable so callers fail the compound gate closed
            // instead of booking a symbol-based mis-estimate. Pricing is
            // best-effort and must not fail an already-confirmed claim.
            // SAFETY: The enclosing statement has validated or constructed the asserted contract before this value is consumed.
            const netFeesUsd = yield* Effect.gen(function* () {
              const tokenXMint = dlmm.lbPair.tokenXMint.toBase58();
              const tokenYMint = dlmm.lbPair.tokenYMint.toBase58();
              // useFallback: false — netFeesUsd books into cumulativeFeesClaimedUsd
              // (the compound gate input), so it carries the same ledger-booking
              // responsibility as the exit path: a $165/$1 fallback fabrication
              // here would compound on phantom value. Unresolvable → null → caller
              // `?? 0` → the compound gate fails closed instead of booking fiction.
              const prices = yield* fetchTokenPrices([tokenXMint, tokenYMint], {
                useFallback: false,
              }).pipe(Effect.catch(() => Effect.succeed(EMPTY_TOKEN_PRICES)));
              const priceX = prices[tokenXMint];
              const priceY = prices[tokenYMint];
              if (priceX == null || priceX <= 0 || priceY == null || priceY <= 0) return null;
              return (
                (netFeeX / 10 ** dlmm.tokenX.mint.decimals) * priceX +
                (netFeeY / 10 ** dlmm.tokenY.mint.decimals) * priceY
              );
              // SAFETY: The runtime guard or typed fixture immediately above this assertion establishes the required invariant.
              // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
            }).pipe(Effect.catch(() => Effect.succeed(null as number | null)));

            return {
              txSignature: signature,
              feeX,
              feeY,
              platformFeeX: actualPlatformFeeX,
              platformFeeY: actualPlatformFeeY,
              netFeeX,
              netFeeY,
              netFeesUsd,
              ...(transferInstructions.length > 0
                ? { feeTransferTxSignature: signature }
                : undefined),
              ...(actualOperatorFeeX > 0 || actualOperatorFeeY > 0
                ? { operatorFeeX: actualOperatorFeeX, operatorFeeY: actualOperatorFeeY }
                : undefined),
            };
          }).pipe(
            Effect.catch((err) =>
              Effect.fail(
                new AdapterError({
                  message: `Failed to claim fees: ${String(err)}`,
                  poolAddress,
                  cause: err,
                }),
              ),
            ),
          ),

        // Economic harvest gate input (Robinhood rule 10): the position's
        // PENDING claimable swap fees priced in USD, read before any claim tx.
        // Mirrors the claimFees pricing above but on the gross pending
        // feeX/feeY (no platform split yet) — the gate compares against the
        // whole claimable amount. Null when either leg is unpriceable so
        // callers fail open (fee capture is protective). Fails on read errors;
        // the gate also fails open on failure.
        getClaimableFeesUsd: (poolAddress, positionPubKey) =>
          Effect.gen(function* () {
            const dlmm = yield* getDlmm(poolAddress);
            const position = yield* Effect.tryPromise(() =>
              dlmm.getPosition(new PublicKey(positionPubKey)),
            );

            const feeX = Number(position.positionData.feeX.toString());
            const feeY = Number(position.positionData.feeY.toString());
            if (feeX === 0 && feeY === 0) return 0;

            const tokenXMint = dlmm.lbPair.tokenXMint.toBase58();
            const tokenYMint = dlmm.lbPair.tokenYMint.toBase58();
            const prices = yield* fetchTokenPrices([tokenXMint, tokenYMint], {
              useFallback: false,
            }).pipe(Effect.catch(() => Effect.succeed(EMPTY_TOKEN_PRICES)));
            const priceX = prices[tokenXMint];
            const priceY = prices[tokenYMint];
            if (priceX == null || priceX <= 0 || priceY == null || priceY <= 0) return null;
            return (
              (feeX / 10 ** dlmm.tokenX.mint.decimals) * priceX +
              (feeY / 10 ** dlmm.tokenY.mint.decimals) * priceY
            );
          }).pipe(
            Effect.catch((err) =>
              Effect.fail(
                new AdapterError({
                  message: `Failed to read claimable fees: ${String(err)}`,
                  poolAddress,
                  cause: err,
                }),
              ),
            ),
          ),

        convertClaimedFees: (poolAddress, destination, feeX, feeY) =>
          Effect.gen(function* () {
            if (!wallet)
              return yield* Effect.fail(new AdapterError({ message: "No wallet configured" }));
            if (!Number.isFinite(feeX) || !Number.isFinite(feeY) || (feeX <= 0 && feeY <= 0))
              return yield* Effect.fail(
                new AdapterError({ message: "Cannot convert zero claimed fees" }),
              );
            const dlmm = yield* getDlmm(poolAddress);
            const inputMints = [
              dlmm.lbPair.tokenXMint.toBase58(),
              dlmm.lbPair.tokenYMint.toBase58(),
            ];
            const targetMint = destination === "accumulate-sol" ? SOL_MINT : USDC_MINT;
            const amounts = [feeX, feeY];
            const signatures: string[] = [];
            let outputAtomic = 0n;
            for (let index = 0; index < inputMints.length; index += 1) {
              const inputMint = inputMints[index];
              const amount = amounts[index];
              if (!inputMint || amount === undefined || amount <= 0) continue;
              if (inputMint === targetMint) {
                outputAtomic += BigInt(Math.trunc(amount));
                continue;
              }
              const quote = yield* quoteSwapToken(
                inputMint,
                targetMint,
                BigInt(Math.trunc(amount)),
              );
              if (!isObject(quote) || !isStringValue(quote.outAmount)) {
                return yield* Effect.fail(
                  new AdapterError({ message: "Jupiter fee conversion returned invalid output" }),
                );
              }
              const quotedOutput = quote.outAmount;
              if (!/^\d+$/.test(quotedOutput) || quotedOutput === "0") {
                return yield* Effect.fail(
                  new AdapterError({ message: "Jupiter fee conversion returned invalid output" }),
                );
              }
              signatures.push(
                yield* swapToken(inputMint, targetMint, BigInt(Math.trunc(amount)), quote),
              );
              outputAtomic += BigInt(quotedOutput);
            }
            if (outputAtomic === 0n)
              return yield* Effect.fail(
                new AdapterError({ message: "No supported fee token was converted" }),
              );
            const prices = yield* fetchTokenPrices([targetMint]);
            const decimals = yield* getTokenMeta(targetMint).pipe(
              Effect.map((meta) => meta.decimals),
            );
            const outputUsd =
              prices[targetMint] === undefined
                ? null
                : (Number(outputAtomic) / 10 ** decimals) * prices[targetMint];
            return { destination, outputAtomic, outputUsd, txSignatures: signatures };
          }),

        claimRewards: (poolAddress, positionPubKey) =>
          Effect.gen(function* () {
            if (!wallet) {
              return yield* Effect.fail(
                new AdapterError({
                  message: "No wallet configured",
                }),
              );
            }

            const positionPubkey = new PublicKey(positionPubKey);
            const dlmm = yield* getDlmm(poolAddress);
            const position = yield* Effect.tryPromise(() => dlmm.getPosition(positionPubkey));

            const pendingOne = Number(position.positionData.rewardOne.toString());
            const pendingTwo = Number(position.positionData.rewardTwo.toString());
            const hasPending =
              (Number.isFinite(pendingOne) && pendingOne > 0) ||
              (Number.isFinite(pendingTwo) && pendingTwo > 0);

            // ConcreteFunctionType gate: post-0.12.0 pools are LimitOrder-xor-
            // LiquidityMining. Legacy pools predate the field and read 0
            // (LimitOrder) — pending reward amounts are objective proof that
            // rewards streamed to this position, so they still claim (real
            // yield is never abandoned on a legacy field default).
            // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
            const concreteFunctionType = (dlmm.lbPair as { concreteFunctionType?: number })
              .concreteFunctionType;
            if (!hasPending) {
              const reason =
                concreteFunctionType === ConcreteFunctionType.LimitOrder
                  ? "pool is LimitOrder function type (no LM rewards)"
                  : "no pending rewards";
              return { skipped: true, skipReason: reason, txSignatures: [], rewards: [] };
            }

            const claimTxs = yield* Effect.tryPromise(() =>
              dlmm.claimAllLMRewards({ owner: wallet.publicKey, positions: [position] }),
            );
            if (!claimTxs || claimTxs.length === 0) {
              return {
                skipped: true,
                skipReason: "no claimable rewards",
                txSignatures: [],
                rewards: [],
              };
            }

            const txSignatures: string[] = [];
            for (const tx of claimTxs) {
              const { blockhash } = yield* rpcCall((conn) => conn.getLatestBlockhash());
              tx.feePayer = wallet.publicKey;
              tx.recentBlockhash = blockhash;
              tx.sign(wallet);
              const signature = yield* rpcCall((conn) =>
                conn.sendRawTransaction(tx.serialize(), {
                  skipPreflight: false,
                  preflightCommitment: "confirmed",
                }),
              );
              yield* rpcCall((conn) => conn.confirmTransaction(signature, "confirmed"));
              txSignatures.push(signature);
            }
            yield* invalidateBalanceCaches;

            // Slot mapping per the DLMM layout: rewardOne ↔ rewardInfos[0],
            // rewardTwo ↔ rewardInfos[1]. An all-1s mint means the slot is
            // inactive — record the mint as "unknown" and skip USD valuation.
            const rewardInfos = dlmm.lbPair.rewardInfos;
            const slots = [
              { mint: rewardInfos[0]?.mint, amountAtomic: pendingOne },
              { mint: rewardInfos[1]?.mint, amountAtomic: pendingTwo },
            ].filter((s) => Number.isFinite(s.amountAtomic) && s.amountAtomic > 0);

            const mintOf = (mint: PublicKey | undefined): string => {
              const base58 = mint?.toBase58();
              return base58 != null && base58 !== DEFAULT_PUBLIC_KEY ? base58 : "unknown";
            };
            const pricedMints = slots.map((s) => mintOf(s.mint)).filter((m) => m !== "unknown");
            const prices =
              pricedMints.length > 0
                ? yield* fetchTokenPrices(pricedMints).pipe(
                    Effect.catch(() => Effect.succeed(EMPTY_TOKEN_PRICES)),
                  )
                : {};

            const rewards: ClaimedReward[] = [];
            for (const slot of slots) {
              const mint = mintOf(slot.mint);
              let amountUsd: number | null = null;
              const price = mint !== "unknown" ? prices[mint] : undefined;
              if (price != null && price > 0) {
                const decimals = yield* getTokenMeta(mint).pipe(
                  Effect.map((m) => m.decimals),
                  Effect.catch(() => Effect.succeed(null)),
                );
                if (decimals != null) {
                  amountUsd = (slot.amountAtomic / Math.pow(10, decimals)) * price;
                } else {
                  logger.warn("Reward mint decimals unavailable — recording raw amount only", {
                    pool: poolAddress,
                    mint,
                  });
                }
              } else if (mint !== "unknown") {
                logger.warn("Reward mint price unavailable — recording raw amount only", {
                  pool: poolAddress,
                  mint,
                });
              }
              rewards.push({ mint, amountAtomic: slot.amountAtomic, amountUsd });
            }

            logger.info("LM rewards claimed", {
              pool: poolAddress,
              position: positionPubKey,
              rewards,
              txSignatures,
            });

            return { skipped: false, skipReason: null, txSignatures, rewards };
          }).pipe(
            Effect.catch((err) =>
              Effect.fail(
                new AdapterError({
                  message: `Failed to claim rewards: ${String(err)}`,
                  poolAddress,
                  cause: err,
                }),
              ),
            ),
          ),

        reportFeeCollection(event) {
          // Revenue telemetry honors the same opt-out flag as feedback —
          // posting fee events must not bypass PRISM_FEEDBACK_OPT_OUT.
          if (config.feedbackOptOut) return Effect.void;
          return Effect.gen(function* () {
            const installId = yield* getOrCreateInstallId();
            const apiKey = readApiKey();
            const headers: RequestHeaders = { "Content-Type": "application/json" };
            if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
            const res = yield* Effect.tryPromise({
              try: () =>
                fetch("https://prism-api.irfndi.workers.dev/v1/revenue/log", {
                  method: "POST",
                  headers,
                  body: JSON.stringify({ ...event, installId }),
                  signal: AbortSignal.timeout(10_000),
                }),
              // SAFETY: This branch normalizes the caught cause to the Error contract before propagation.
              catch: (cause) => cause as Error,
            });
            if (!res.ok) {
              logger.warn("Revenue report failed:", res.status);
            }
          }).pipe(
            Effect.catch((err) =>
              Effect.sync(() => logger.warn("Revenue report failed:", String(err))),
            ),
          );
        },

        discoverPools: (scanOrdinal) =>
          Effect.gen(function* () {
            const baseUrl =
              config.meteoraPoolsUrl ||
              "https://dlmm.datapi.meteora.ag/pools?page=1&page_size=1000&filter_by=is_blacklisted=false&sort_by=tvl:desc";
            const requestedPage =
              scanOrdinal === undefined
                ? null
                : selectRecurringDiscoveryPage({ scanOrdinal, pageCount: discoveryPageCount });
            if (scanOrdinal !== undefined && requestedPage === null) {
              return yield* Effect.fail(
                new DiscoverPoolsError({
                  message: `Invalid recurring discovery scan ordinal ${scanOrdinal}`,
                  url: baseUrl,
                }),
              );
            }
            const pageSize = safeMeteoraPageSize(baseUrl) ?? 1000;
            const url =
              requestedPage === null
                ? baseUrl
                : buildMeteoraDiscoveryPageUrl({
                    baseUrl,
                    page: requestedPage,
                    pageSize,
                  });
            if (url === null) {
              return yield* Effect.fail(
                new DiscoverPoolsError({
                  message: `Invalid Meteora discovery URL ${baseUrl}`,
                  url: baseUrl,
                }),
              );
            }
            const res = yield* Effect.tryPromise({
              try: () => fetch(url, { signal: AbortSignal.timeout(10_000) }),
              catch: (cause) =>
                new DiscoverPoolsError({
                  message: `Network error fetching ${url}: ${String(cause)}`,
                  url,
                  cause,
                }),
            });
            if (!res.ok) {
              logger.warn("Pool discovery: Meteora API returned non-OK", {
                url,
                status: res.status,
              });
              return yield* Effect.fail(
                new DiscoverPoolsError({
                  message: `Meteora API returned HTTP ${res.status} for ${url}. Pool discovery disabled for this cycle.`,
                  url,
                  status: res.status,
                }),
              );
            }
            const parsed: JsonValue = yield* Effect.tryPromise({
              // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
              try: () => res.json().then((body) => body as JsonValue),
              catch: (cause) =>
                new DiscoverPoolsError({
                  message: `Invalid JSON from ${url}: ${String(cause)}`,
                  url,
                  cause,
                }),
            });
            const discovery = yield* parseDiscoveryResponse(parsed, url, requestedPage, pageSize);
            discoveryPageCount = Math.max(discovery.pages, 1);
            return discovery.pools
              .filter((p) => p.tvlUsd >= config.discoveryMinTvlUsd)
              .slice(0, 50);
          }),

        // Market-scan universe refresh: the top-N pages of the TVL-ranked
        // universe in one call (no rotating-page semantics, no 50-row slice),
        // with the Data API's token-safety metadata attached for the market
        // gate. Never fails: any page/network/parse problem logs a warning and
        // yields [] so the scan falls back to its last ranked set.
        discoverPoolsTopPages: (pages) =>
          Effect.gen(function* () {
            const baseUrl =
              config.meteoraPoolsUrl ||
              "https://dlmm.datapi.meteora.ag/pools?page=1&page_size=1000&filter_by=is_blacklisted=false&sort_by=tvl:desc";
            const pageCount = Math.min(Math.max(Math.floor(pages), 1), 10);
            const fetchPage = (page: number): Effect.Effect<ReadonlyArray<DiscoveredPool>, Error> =>
              Effect.gen(function* () {
                const url = buildMarketScanPageUrl(
                  baseUrl,
                  page,
                  config.marketScanUniverseSort === "fee",
                );
                if (url === null) return [];
                const res = yield* Effect.tryPromise({
                  try: () => fetch(url.toString(), { signal: AbortSignal.timeout(15_000) }),
                  // SAFETY: This branch normalizes the caught cause to the Error contract before propagation.
                  catch: (cause) => cause as Error,
                });
                if (!res.ok) {
                  logger.warn("Market scan: page fetch non-OK", { page, status: res.status });
                  return [];
                }
                const parsed: JsonValue = yield* Effect.tryPromise({
                  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
                  try: () => res.json().then((body) => body as JsonValue),
                  // SAFETY: This branch normalizes the caught cause to the Error contract before propagation.
                  catch: (cause) => cause as Error,
                });
                if (!isPoolsEnvelope(parsed)) return [];
                const valid = parsed.data.filter(isValidPoolState);
                return valid.filter((p) => !p.launchpad).map(toDiscoveredPool);
              }).pipe(
                // Per-page failure isolation: a network error, timeout, or parse
                // failure on ONE page must not discard the pages that succeeded —
                // log a warning and yield [] for that page only.
                Effect.catch((cause) => {
                  logger.warn("Market scan: page fetch failed", {
                    page,
                    error: underlyingErrorMessage(cause),
                  });
                  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
                  return Effect.succeed([] as ReadonlyArray<DiscoveredPool>);
                }),
              );
            const pagesResult = yield* Effect.all(
              Array.from({ length: pageCount }, (_, i) => fetchPage(i + 1)),
              { concurrency: 3 },
            ).pipe(
              // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
              Effect.catch(() =>
                Effect.succeed([] as ReadonlyArray<ReadonlyArray<DiscoveredPool>>),
              ),
            );
            const byAddress = new Map<string, DiscoveredPool>();
            for (const page of pagesResult) {
              for (const pool of page) {
                if (!byAddress.has(pool.address)) byAddress.set(pool.address, pool);
              }
            }
            const merged = [...byAddress.values()];
            if (merged.length > 0) {
              logger.info("Market scan: universe refresh complete", {
                pages: pageCount,
                pools: merged.length,
              });
            }
            return merged;
          }),

        // Launch-mode radar: the top fee-yield pools (24h fee/TVL ratio desc)
        // in ONE page, with the Data API's token-safety metadata attached for
        // the launch gate. Never fails: any network/parse problem logs a
        // warning and yields [] — the radar keeps its last ranked snapshot.
        discoverHotPools: (candidateLimit) =>
          Effect.gen(function* () {
            const baseUrl =
              config.meteoraPoolsUrl ||
              "https://dlmm.datapi.meteora.ag/pools?page=1&page_size=1000&filter_by=is_blacklisted=false&sort_by=fee_tvl_ratio_24h:desc";
            let url: URL;
            try {
              url = new URL(baseUrl);
            } catch (cause) {
              // A malformed METEORA_POOLS_URL must fail open, not become a
              // sync defect that escapes the fail-open catch below.
              logger.warn("Launch radar: malformed pools URL", {
                error: underlyingErrorMessage(cause),
              });
              return [];
            }
            url.searchParams.set("page", "1");
            // candidateLimit is the UNIVERSE to gate, not the logged top-K —
            // the launch gate rejects most candidates (age/TVL/safety), so the
            // radar fetches a wide candidate set and slices top-K after gating.
            url.searchParams.set(
              "page_size",
              String(Math.min(Math.max(Math.floor(candidateLimit), 1), 1000)),
            );
            url.searchParams.set("filter_by", "is_blacklisted=false");
            url.searchParams.set("sort_by", "fee_tvl_ratio_24h:desc");
            const res = yield* Effect.tryPromise({
              try: () => fetch(url.toString(), { signal: AbortSignal.timeout(15_000) }),
              // SAFETY: This branch normalizes the caught cause to the Error contract before propagation.
              catch: (cause) => cause as Error,
            });
            if (!res.ok) {
              logger.warn("Launch radar: hot-pool fetch non-OK", { status: res.status });
              return [];
            }
            const parsed: JsonValue = yield* Effect.tryPromise({
              // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
              try: () => res.json().then((body) => body as JsonValue),
              // SAFETY: This branch normalizes the caught cause to the Error contract before propagation.
              catch: (cause) => cause as Error,
            });
            if (!isPoolsEnvelope(parsed)) return [];
            const valid = parsed.data.filter(isValidPoolState);
            return valid.filter((p) => !p.launchpad).map(toDiscoveredPool);
          }).pipe(
            Effect.catch((cause) => {
              logger.warn("Launch radar: hot-pool fetch failed", {
                error: underlyingErrorMessage(cause),
              });
              // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
              return Effect.succeed([] as ReadonlyArray<DiscoveredPool>);
            }),
          ),

        quoteSwapUSDCForToken: (outputMint: string, amountAtomic: bigint) =>
          quoteSwapUSDCForToken(outputMint, amountAtomic).pipe(
            Effect.catch((err) =>
              Effect.fail(
                new AdapterError({
                  message: `quoteSwapUSDCForToken failed: ${String(err)}`,
                  cause: err,
                }),
              ),
            ),
          ),

        quoteSwap,
        prepareSwap,
        simulateSwap,
        submitSwap,
        getSwapStatus,
        getConfirmedSwapOutput: (signature) =>
          getConfirmedSwapOutput(signature).pipe(
            Effect.catch((err) =>
              Effect.fail(
                new AdapterError({
                  message: `getConfirmedSwapOutput failed: ${String(err)}`,
                  cause: err,
                }),
              ),
            ),
          ),

        swapUSDCForToken: (outputMint: string, amountAtomic: bigint, quoteData?: JsonValue) =>
          swapUSDCForToken(outputMint, amountAtomic, quoteData).pipe(
            Effect.catch((err) =>
              Effect.fail(
                new AdapterError({
                  message: `swapUSDCForToken failed: ${String(err)}`,
                  cause: err,
                }),
              ),
            ),
          ),

        swapToken: (
          inputMint: string,
          outputMint: string,
          amountAtomic: bigint,
          quoteData?: JsonValue,
        ) =>
          swapToken(inputMint, outputMint, amountAtomic, quoteData).pipe(
            Effect.catch((err) =>
              Effect.fail(
                new AdapterError({
                  message: `swapToken failed: ${String(err)}`,
                  cause: err,
                }),
              ),
            ),
          ),

        swapUSDCForSOL: (minSolThreshold = 0.05, swapAmountUSDC = 1.0) =>
          Effect.gen(function* () {
            const activeWallet = wallet;
            if (!activeWallet) return;

            const lamports = yield* readNativeSolBalance();
            const solBalance = Number(lamports) / 1e9;

            if (solBalance >= minSolThreshold) return;

            logger.info("Low SOL balance — swapping USDC → SOL for gas", {
              solBalance: solBalance.toFixed(4),
              minThreshold: minSolThreshold,
              swapAmountUSDC,
            });

            yield* swapUSDCForToken(SOL_MINT, BigInt(Math.round(swapAmountUSDC * 1e6))).pipe(
              Effect.tap((sig) =>
                Effect.sync(() => {
                  if (sig) {
                    logger.info("Swapped USDC → SOL for gas", {
                      tx: sig,
                      amountUSDC: swapAmountUSDC,
                    });
                  }
                }),
              ),
              Effect.catch((err) =>
                Effect.sync(() => logger.warn("USDC → SOL swap failed (non-fatal):", String(err))),
              ),
            );
          }).pipe(Effect.catch(() => Effect.void)),
      };

      return api;
    }),
  );

export const AdapterLive = makeAdapterLive();
