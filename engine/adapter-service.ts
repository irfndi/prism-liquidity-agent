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
  type PositionData,
  type RebalanceWithDeposit,
  type RebalanceWithWithdraw,
  type StrategyParameters,
} from "@meteora-ag/dlmm";
import { BN } from "@coral-xyz/anchor";
import { Effect, Layer } from "effect";
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
import { AdapterError, underlyingErrorMessage } from "./errors.js";
import { DiscoverPoolsError } from "./errors.js";
import { SwapQuoteError, SwapValidationError } from "./errors.js";
import { createLogger } from "./logger.js";
import { getPrismUserConfigDir } from "./paths.js";
import type { BinData, EntryDepositMode, EntryStrategyShape } from "./types.js";
import { CircuitBreaker, isRpcNetworkError, retryEffectWithBackoff } from "./adapter-retry.js";
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

const DEFAULT_PUBLIC_KEY = "11111111111111111111111111111111";

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
export function toSdkStrategyType(shape: EntryStrategyShape): StrategyType {
  switch (shape) {
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
  positionData: Pick<PositionData, "totalXAmount" | "totalYAmount" | "lowerBinId" | "upperBinId">;
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

/** Convert atomic token amounts to decimal units without Number() precision
 * loss above 2^53: split into whole + fractional bigint parts and compose. */
export function atomicToUnits(amountAtomic: bigint, decimals: number): number {
  const base = 10n ** BigInt(decimals);
  const whole = amountAtomic / base;
  const frac = amountAtomic % base;
  return Number(whole) + Number(frac) / Number(base);
}
const logger = createLogger("adapter-service");

// Mints we have already warned about for being unpriceable during wallet
// reconciliation. A perpetually-unpriceable token (e.g. a dust ATA with no
// price feed) warns once per process instead of every scan cycle.
const warnedUnpricedWalletMints = new Set<string>();
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

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPoolsEnvelope(v: unknown): v is MeteoraPoolsEnvelope {
  if (!isObject(v)) return false;
  if (typeof v["total"] !== "number") return false;
  if (typeof v["pages"] !== "number") return false;
  if (typeof v["current_page"] !== "number") return false;
  if (typeof v["page_size"] !== "number") return false;
  if (!Array.isArray(v["data"])) return false;
  return true;
}

function isValidPoolShape(v: unknown): v is MeteoraPool {
  if (!isObject(v)) return false;
  if (typeof v["address"] !== "string") return false;
  if (typeof v["tvl"] !== "number") return false;
  if (typeof v["apr"] !== "number") return false;
  if (
    !isObject(v["token_x"]) ||
    typeof (v["token_x"] as Record<string, unknown>)["address"] !== "string"
  )
    return false;
  if (
    !isObject(v["token_y"]) ||
    typeof (v["token_y"] as Record<string, unknown>)["address"] !== "string"
  )
    return false;
  if (!isObject(v["pool_config"])) return false;
  const cfg = v["pool_config"] as Record<string, unknown>;
  if (typeof cfg["bin_step"] !== "number") return false;
  if (!isObject(v["volume"])) return false;
  const vol = v["volume"] as Record<string, unknown>;
  if (typeof vol["24h"] !== "number") return false;
  if (!isObject(v["fees"])) return false;
  const fees = v["fees"] as Record<string, unknown>;
  if (typeof fees["24h"] !== "number") return false;
  return true;
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
  return {
    address: p.address,
    tvlUsd: p.tvl,
    volume24hUsd: p.volume["24h"],
    fees24hUsd: p.fees["24h"],
    apr: p.apr,
    binStep: p.pool_config.bin_step,
    tokenX: tokenX.address,
    tokenY: tokenY.address,
    ...(typeof p.created_at === "number" && Number.isFinite(p.created_at) && p.created_at > 0
      ? {
          createdAtMs: p.created_at > 1_000_000_000_000 ? p.created_at : p.created_at * 1000,
        }
      : {}),
    tokenXSymbol: tokenX.symbol,
    tokenYSymbol: tokenY.symbol,
    tokenXVerified: tokenX.is_verified,
    tokenYVerified: tokenY.is_verified,
    tokenXFreezeDisabled: tokenX.freeze_authority_disabled,
    tokenYFreezeDisabled: tokenY.freeze_authority_disabled,
    tokenXHolders: tokenX.holders,
    tokenYHolders: tokenY.holders,
  };
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array(length=${v.length})`;
  if (typeof v === "object")
    return `object(keys=${Object.keys(v as object)
      .slice(0, 5)
      .join(",")})`;
  return typeof v;
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

export const AdapterLive = Layer.effect(
  AdapterService,
  Effect.gen(function* () {
    const config = yield* ConfigService;

    const connection = new Connection(config.solanaRpcUrl, "confirmed");
    const fallbackConnection =
      config.solanaRpcFallbackUrl.trim() &&
      config.solanaRpcFallbackUrl.trim() !== config.solanaRpcUrl.trim()
        ? new Connection(config.solanaRpcFallbackUrl, "confirmed")
        : null;
    const wallet = config.walletPrivateKey
      ? yield* Effect.try({
          try: () => Keypair.fromSecretKey(bs58.decode(config.walletPrivateKey)),
          catch: (cause) => cause as Error,
        }).pipe(
          Effect.catch((err) => {
            logger.error("Failed to load wallet", err);
            return Effect.succeed(null);
          }),
        )
      : null;

    const DLMM_CACHE_TTL_MS = 5 * 60 * 1000;
    const primaryRpcCircuitBreaker = new CircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 30_000,
    });
    const fallbackRpcCircuitBreaker = fallbackConnection
      ? new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 30_000 })
      : null;
    const nextRpcStartAt = new Map<Connection, number>();
    let nextHeliusRequestAt = 0;

    function paceRpc(conn: Connection): Effect.Effect<void> {
      return Effect.sync(() => {
        const now = Date.now();
        const nextStartAt = nextRpcStartAt.get(conn) ?? now;
        const waitMs = Math.max(0, nextStartAt - now);
        nextRpcStartAt.set(conn, Math.max(now, nextStartAt) + RPC_MIN_INTERVAL_MS);
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

    function rpcCall<T>(
      fn: (conn: Connection) => Promise<T>,
      primaryConn: Connection = connection,
    ): Effect.Effect<T, Error> {
      const run = (conn: Connection, breaker: CircuitBreaker): Effect.Effect<T, Error> =>
        paceRpc(conn).pipe(
          Effect.andThen(
            breaker.execute(
              retryEffectWithBackoff(
                withRpcTimeout(
                  Effect.tryPromise({
                    try: () => fn(conn),
                    catch: (cause) => cause as Error,
                  }),
                ),
                RPC_RETRY_OPTIONS,
              ),
              isRpcNetworkError,
            ),
          ),
        );

      return run(primaryConn, primaryRpcCircuitBreaker).pipe(
        Effect.catch((err) => {
          if (
            fallbackConnection &&
            fallbackRpcCircuitBreaker &&
            primaryConn === connection &&
            isRpcNetworkError(err)
          ) {
            return Effect.sync(() =>
              logger.warn("Primary RPC failed, trying fallback RPC", {
                error: err instanceof Error ? err.message : String(err),
              }),
            ).pipe(Effect.andThen(run(fallbackConnection, fallbackRpcCircuitBreaker)));
          }
          return Effect.fail(err);
        }),
      );
    }

    const dlmmCacheEntries = new Map<
      string,
      Effect.Effect<[Effect.Effect<DLMM, Error>, Effect.Effect<void>], Error>
    >();
    function getDlmmCached(
      poolAddress: string,
    ): Effect.Effect<[Effect.Effect<DLMM, Error>, Effect.Effect<void>], Error> {
      const existing = dlmmCacheEntries.get(poolAddress);
      if (existing) return existing;
      const entry = Effect.try({
        try: () => new PublicKey(poolAddress),
        catch: (cause) => cause as Error,
      }).pipe(
        Effect.flatMap((pubkey) =>
          Effect.cachedInvalidateWithTTL(
            rpcCall((conn) => DLMM.create(conn, pubkey)),
            DLMM_CACHE_TTL_MS,
          ),
        ),
      );
      dlmmCacheEntries.set(poolAddress, entry);
      return entry;
    }

    function getDlmm(poolAddress: string): Effect.Effect<DLMM, Error> {
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

    const tokenMetaCache = new Map<string, TokenMeta>();
    const HELIUS_ASSET_CACHE_TTL_MS = 5 * 60 * 1000;

    // Mint authorities are quasi-static (revocation is one-way), so a long TTL
    // is safe and keeps the per-cycle safety screening to one RPC call per
    // mint per hour.
    const MINT_AUTHORITIES_CACHE_TTL_MS = 60 * 60 * 1000;
    interface MintAuthoritiesEntry {
      readonly mintAuthority: string | null;
      readonly freezeAuthority: string | null;
      readonly fetchedAt: number;
    }
    const mintAuthoritiesCache = new Map<string, MintAuthoritiesEntry>();

    function getMintAuthorities(
      mintAddress: string,
    ): Effect.Effect<{ mintAuthority: string | null; freezeAuthority: string | null }, Error> {
      return Effect.gen(function* () {
        const cached = mintAuthoritiesCache.get(mintAddress);
        if (cached && Date.now() - cached.fetchedAt < MINT_AUTHORITIES_CACHE_TTL_MS) {
          return { mintAuthority: cached.mintAuthority, freezeAuthority: cached.freezeAuthority };
        }
        const mintPubkey = new PublicKey(mintAddress);
        const info = yield* rpcCall((conn) => conn.getParsedAccountInfo(mintPubkey));
        const parsed = (
          info.value?.data as {
            parsed?: { info?: { mintAuthority?: unknown; freezeAuthority?: unknown } };
          }
        )?.parsed?.info;
        const mintAuthority =
          typeof parsed?.mintAuthority === "string" ? parsed.mintAuthority : null;
        const freezeAuthority =
          typeof parsed?.freezeAuthority === "string" ? parsed.freezeAuthority : null;
        mintAuthoritiesCache.set(mintAddress, {
          mintAuthority,
          freezeAuthority,
          fetchedAt: Date.now(),
        });
        return { mintAuthority, freezeAuthority };
      });
    }

    function readHeliusPrice(asset: HeliusAssetResponse): number | undefined {
      const priceInfo = asset.result?.token_info?.price_info;
      const price = priceInfo?.price_per_token;
      const currency = priceInfo?.currency?.toUpperCase();
      if (
        typeof price !== "number" ||
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
      if (!config.heliusApiKey) return Effect.succeed(null);
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
    const KNOWN_MINT_DECIMALS: Record<string, { symbol: string; decimals: number }> = {
      [SOL_MINT]: { symbol: "SOL", decimals: 9 },
      [USDC_MINT]: { symbol: "USDC", decimals: 6 },
      Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: "USDT", decimals: 6 },
      "7i5KKsX2weiTkry7jA4ZwSu2SmtUa4rCCi4t8U9b3bR2": { symbol: "USDS", decimals: 6 },
      J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYk6U5Yf9sW: { symbol: "JitoSOL", decimals: 9 },
      JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { symbol: "JUP", decimals: 6 },
    };

    function getTokenMeta(mint: string): Effect.Effect<TokenMeta, Error> {
      return Effect.gen(function* () {
        const cached = tokenMetaCache.get(mint);
        if (cached) return cached;

        // Fast path: known mints (SOL, USDC, USDT, etc.) — no network.
        const known = KNOWN_MINT_DECIMALS[mint];
        if (known) {
          tokenMetaCache.set(mint, known);
          return known;
        }

        // Helius path: DAS getAsset returns token_info.decimals for any
        // mint Helius has indexed. Only available when heliusApiKey is set.
        if (config.heliusApiKey) {
          const json = yield* fetchHeliusAsset(mint).pipe(Effect.catch(() => Effect.succeed(null)));
          const d = json?.result?.token_info?.decimals;
          if (typeof d === "number") {
            const priceUsd = json ? readHeliusPrice(json) : undefined;
            const meta = {
              symbol: json?.result?.content?.metadata?.symbol ?? mint.slice(0, 4),
              decimals: d,
              ...(priceUsd !== undefined ? { priceUsd, priceFetchedAt: Date.now() } : {}),
            };
            tokenMetaCache.set(mint, meta);
            return meta;
          }
        }

        // Standard Solana RPC path: parsed account info exposes decimals
        // for any SPL mint via the Token Program (works on mainnet-beta and
        // every other standard RPC). Does NOT call Helius DAS getAsset.
        const mintPubkey = new PublicKey(mint);
        const info = yield* rpcCall((conn) => conn.getParsedAccountInfo(mintPubkey));
        const parsed = (info.value?.data as { parsed?: { info?: { decimals?: number } } })?.parsed
          ?.info;
        if (typeof parsed?.decimals === "number") {
          const meta = { symbol: mint.slice(0, 4), decimals: parsed.decimals };
          tokenMetaCache.set(mint, meta);
          return meta;
        }

        return yield* Effect.fail(
          new Error(`Cannot resolve decimals for mint ${mint} via Helius or standard RPC`),
        );
      });
    }

    // ─── Price fetching ────────────────────────────────────────────────────

    const fallbackPrices: Record<string, number> = {
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
          fetch(`https://api.jup.ag/price/v3?ids=${ids}`, requestInit),
        );
        if (!res.ok) return {};
        const json = (yield* Effect.tryPromise(() => res.json())) as Record<
          string,
          { readonly usdPrice?: number; readonly price?: number } | undefined
        > & {
          readonly data?: Record<string, { readonly price?: number } | undefined>;
        };
        const result: Record<string, number> = {};
        for (const mint of missing) {
          const price = json[mint]?.usdPrice ?? json.data?.[mint]?.price;
          if (typeof price === "number" && Number.isFinite(price) && price > 0) {
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
            const json = (yield* Effect.tryPromise(() => res.json())) as Record<
              string,
              { readonly usd?: number } | undefined
            >;
            for (const mint of batch) {
              const price = json[mint]?.usd;
              if (typeof price === "number" && Number.isFinite(price) && price > 0) {
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
        const prices: Record<string, number> = {};
        const missing: string[] = [];

        for (const mint of new Set(mints)) {
          const cached = getCachedPrice(mint);
          if (cached !== undefined) {
            prices[mint] = cached;
            continue;
          }
          const metadataPrice = tokenMetaCache.get(mint)?.priceUsd;
          if (metadataPrice !== undefined && Number.isFinite(metadataPrice) && metadataPrice > 0) {
            const metadataFetchedAt = tokenMetaCache.get(mint)?.priceFetchedAt;
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

        if (missing.length === 0) return prices;

        const sourcesAttempted: string[] = [];

        const heliusPrices = yield* fetchHeliusPrices(missing);
        if (config.heliusApiKey) sourcesAttempted.push("helius");
        const stillMissing: string[] = [];
        for (const mint of missing) {
          const price = heliusPrices[mint];
          if (price !== undefined) {
            prices[mint] = price;
            if (provenanceOut && !useFallback) {
              provenanceOut.set(mint, sourcesAttempted.join(","));
            }
          } else {
            stillMissing.push(mint);
          }
        }

        if (stillMissing.length === 0) {
          return prices;
        }

        sourcesAttempted.push("jupiter");
        const jupiterPrices = yield* fetchJupiterPrices(stillMissing);
        const coinGeckoMissing: string[] = [];
        for (const mint of stillMissing) {
          const price = jupiterPrices[mint];
          if (price !== undefined) {
            prices[mint] = price;
            if (provenanceOut && !useFallback) {
              provenanceOut.set(mint, sourcesAttempted.join(","));
            }
          } else {
            coinGeckoMissing.push(mint);
          }
        }

        if (coinGeckoMissing.length > 0) sourcesAttempted.push("coingecko");

        const cgPrices = yield* fetchCoinGeckoPrices(coinGeckoMissing);
        const unresolved: string[] = [];
        for (const mint of coinGeckoMissing) {
          const cgPrice = cgPrices[mint];
          if (cgPrice !== undefined) {
            prices[mint] = cgPrice;
            if (provenanceOut && !useFallback) {
              provenanceOut.set(mint, sourcesAttempted.join(","));
            }
          } else {
            unresolved.push(mint);
          }
        }

        for (const mint of unresolved) {
          negativePriceCache.set(mint, Date.now());
          prices[mint] = useFallback ? (fallbackPrices[mint] ?? 0) : 0;
          if (provenanceOut && !useFallback) {
            provenanceOut.set(mint, sourcesAttempted.join(","));
          }
        }

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
          if (typeof amount === "string") total += BigInt(amount);
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
        if (!opts?.force && nativeSolBalanceCache && nativeSolBalanceCache.expiresAt > Date.now()) {
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
        // legacy Token Program and Token-2022. Two unfiltered reads (no mint
        // filter) capture all ATAs — pool-token residues, single-sided-entry
        // leftovers, reward mints and wSOL ATAs — which the old SOL+USDC-only
        // read left invisible. Amounts accumulate per mint.
        const held = new Map<string, { amountAtomic: bigint; decimals: number }>();
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
            if (typeof mint !== "string") continue;
            const tokenAmount = info["tokenAmount"];
            if (!isObject(tokenAmount)) continue;
            const amountRaw = tokenAmount["amount"];
            const decimals = tokenAmount["decimals"];
            if (typeof amountRaw !== "string" || typeof decimals !== "number") continue;
            if (!/^\d+$/.test(amountRaw)) continue;
            const amountAtomic = BigInt(amountRaw);
            if (amountAtomic <= 0n) continue; // skip empty / rent-only ATAs
            const existing = held.get(mint);
            if (existing) existing.amountAtomic += amountAtomic;
            else held.set(mint, { amountAtomic, decimals });
          }
        }

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
          if (typeof solPrice === "number" && solPrice > 0) {
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
          if (typeof price !== "number" || price <= 0) {
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

    const [cachedWalletSnapshot, invalidateWalletSnapshot] = yield* Effect.cachedInvalidateWithTTL(
      readWalletSnapshot(),
      WALLET_BALANCE_CACHE_TTL_MS,
    );
    const cachedWalletBalance = Effect.map(cachedWalletSnapshot, (snapshot) => snapshot.totalUsd);
    const cachedWalletHoldings = Effect.map(cachedWalletSnapshot, (snapshot) => snapshot.held);

    const invalidateBalanceCaches = Effect.sync(() => {
      tokenBalanceCache.clear();
      nativeSolBalanceCache = undefined;
      // Position marks read the same on-chain accounts a mutation rewrites:
      // a rebalance preserves positionPubKey, so without clearing this cache
      // the next valuation would serve a pre-mutation mark (up to 60s) into
      // trailing-stop / IL / dust decisions.
      positionValueCache.clear();
    }).pipe(Effect.andThen(invalidateWalletSnapshot));

    const quotedByRawPayload = new WeakMap<Record<string, unknown>, SwapQuote>();
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

    function isRecord(value: unknown): value is Record<string, unknown> {
      return typeof value === "object" && value !== null && !Array.isArray(value);
    }

    function parseAtomicString(value: unknown): bigint | null {
      if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
      try {
        return BigInt(value);
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

    function validateQuotePayload(
      request: SwapRequest,
      payload: unknown,
      quotedAt: number,
    ): Effect.Effect<SwapQuote, SwapValidationError> {
      if (!isRecord(payload)) {
        return Effect.fail(
          swapValidationError("quote", "malformed_payload", "Jupiter quote is not an object"),
        );
      }
      if (payload.inputMint !== request.inputMint || payload.outputMint !== request.outputMint) {
        return Effect.fail(
          swapValidationError("quote", "mint_mismatch", "Jupiter quote mints do not match request"),
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
      const priceImpactPct =
        typeof payload.priceImpactPct === "string" ? Number(payload.priceImpactPct) : Number.NaN;
      const priceImpactBps = priceImpactPct * 10_000;
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
      const outAmountAtomic = parseAtomicString(payload.outAmount);
      const minimumOutAmountAtomic = parseAtomicString(payload.otherAmountThreshold);
      if (
        outAmountAtomic === null ||
        outAmountAtomic <= 0n ||
        minimumOutAmountAtomic === null ||
        minimumOutAmountAtomic <= 0n ||
        minimumOutAmountAtomic > outAmountAtomic
      ) {
        return Effect.fail(
          swapValidationError("quote", "malformed_payload", "Jupiter quote amounts are invalid"),
        );
      }
      if (!Array.isArray(payload.routePlan) || payload.routePlan.length === 0) {
        return Effect.fail(
          swapValidationError("quote", "route_mismatch", "Jupiter quote returned no usable route"),
        );
      }
      const route: Array<{ readonly inputMint: string; readonly outputMint: string }> = [];
      for (const step of payload.routePlan) {
        if (!isRecord(step) || !isRecord(step.swapInfo)) {
          return Effect.fail(
            swapValidationError("quote", "malformed_payload", "Jupiter route step is malformed"),
          );
        }
        const routeInputMint = step.swapInfo.inputMint;
        const routeOutputMint = step.swapInfo.outputMint;
        if (typeof routeInputMint !== "string" || typeof routeOutputMint !== "string") {
          return Effect.fail(
            swapValidationError("quote", "malformed_payload", "Jupiter route mints are malformed"),
          );
        }
        route.push({ inputMint: routeInputMint, outputMint: routeOutputMint });
      }
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
      return Effect.succeed({
        request,
        outAmountAtomic,
        minimumOutAmountAtomic,
        priceImpactBps,
        quotedAt,
        route,
        rawQuote: payload,
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

    function jupiterHeaders(): Record<string, string> {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
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
          fetch(
            `https://api.jup.ag/swap/v1/quote?inputMint=${encodeURIComponent(request.inputMint)}&outputMint=${encodeURIComponent(request.outputMint)}&amount=${request.amountAtomic.toString()}&slippageBps=${request.slippageBps}&asLegacyTransaction=false`,
            { headers: jupiterHeaders(), signal: AbortSignal.timeout(10_000) },
          ),
        );
        if (!response.ok) {
          return yield* Effect.fail(
            new SwapQuoteError({ message: `Jupiter quote failed: ${response.status}` }),
          );
        }
        const payload = yield* Effect.tryPromise(() => response.json());
        const quote = yield* validateQuotePayload(request, payload, Date.now());
        quotedByRawPayload.set(quote.rawQuote, quote);
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
          fetch("https://api.jup.ag/swap/v1/swap", {
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
        if (!isRecord(payload) || typeof payload.swapTransaction !== "string") {
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

    function decodePreparedTransaction(prepared: PreparedSwap): Transaction | VersionedTransaction {
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
          return yield* Effect.fail(
            new Error(
              typeof txError === "string"
                ? txError
                : typeof txError === "object" && txError !== null && "message" in txError
                  ? String((txError as { message: unknown }).message)
                  : String(txError as unknown),
              { cause: txError },
            ),
          );
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
        if (status.err !== null) return { state: "failed", error: String(status.err as unknown) };
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
        if (typeof preBalance !== "number" || typeof postBalance !== "number") return null;

        const outputAtomic = BigInt(postBalance - preBalance);
        const feeAtomic = BigInt(response.meta.fee);

        if (outputAtomic <= 0n) return null;

        return { outputAtomic, feeAtomic };
      }).pipe(Effect.catch(() => Effect.succeed(null)));
    }

    function quoteSwapUSDCForToken(
      outputMint: string,
      amountAtomic: bigint,
    ): Effect.Effect<Record<string, unknown>, Error> {
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
    ): Effect.Effect<Record<string, unknown>, Error> {
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
      prefetchedQuote?: Record<string, unknown>,
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
        const quote = quotedByRawPayload.get(rawQuote);
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
      quoteData?: Record<string, unknown>,
    ): Effect.Effect<string, Error> {
      return Effect.gen(function* () {
        const rawQuote = quoteData ?? (yield* quoteSwapToken(inputMint, outputMint, amountAtomic));
        const quote = quotedByRawPayload.get(rawQuote);
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
                tokenMetaCache.get(mint)?.priceFetchedAt ??
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

      getPoolState: (poolAddress) =>
        Effect.gen(function* () {
          const dlmm = yield* getDlmm(poolAddress);
          const lbPair = dlmm.lbPair;
          const activeBin = yield* Effect.tryPromise(() => dlmm.getActiveBin());

          const [tokenXMeta, tokenYMeta, stats] = yield* Effect.all([
            getTokenMeta(lbPair.tokenXMint.toBase58()),
            getTokenMeta(lbPair.tokenYMint.toBase58()),
            fetchPoolStats(poolAddress),
          ]);

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
            currentPrice: Number(activeBin.price),
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

      getBinArray: (poolAddress) =>
        Effect.gen(function* () {
          const dlmm = yield* getDlmm(poolAddress);
          const activeBin = yield* Effect.tryPromise(() => dlmm.getActiveBin());
          const halfRange = 20;
          const lowerBinId = activeBin.binId - halfRange;
          const upperBinId = activeBin.binId + halfRange;
          const binStep = Number(dlmm.lbPair.binStep);

          // Real per-bin reserves from the on-chain bin arrays. The SDK fills
          // uninitialized bins with zero-amount placeholders, which is the
          // truthful "empty bin" representation.
          const realBins = yield* Effect.tryPromise(() =>
            dlmm.getBinsAroundActiveBin(halfRange, halfRange),
          ).pipe(
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
            // with a warning instead of consuming fabricated 1.0 values.
            return {
              lowerBinId,
              upperBinId,
              bins: [],
              activeBinId: activeBin.binId,
              binStep,
              reservesKnown: false,
            };
          }

          const basePrice = Number(activeBin.price);
          const bins: BinData[] = realBins.bins
            .filter((b) => b.binId >= lowerBinId && b.binId <= upperBinId)
            .map((b) => {
              const parsedPrice = Number(b.price);
              return {
                binId: b.binId,
                price:
                  Number.isFinite(parsedPrice) && parsedPrice > 0
                    ? parsedPrice
                    : basePrice * Math.pow(1 + binStep / 10000, b.binId - activeBin.binId),
                reserveX: BigInt(b.xAmount.toString()),
                reserveY: BigInt(b.yAmount.toString()),
                liquiditySupply: BigInt(b.supply.toString()),
              };
            });

          return {
            lowerBinId,
            upperBinId,
            bins,
            activeBinId: activeBin.binId,
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
          Effect.catch((err: unknown) =>
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

          const prices = yield* fetchTokenPrices([pool.tokenX, pool.tokenY]);
          const priceX = prices[pool.tokenX] ?? 0;
          const priceY = prices[pool.tokenY] ?? 0;

          if (!priceX || !priceY) {
            return yield* Effect.fail(
              new AdapterError({
                message: `Could not fetch token prices for ${pool.tokenX} and ${pool.tokenY}`,
                poolAddress,
              }),
            );
          }

          const halfUsd = positionSizeUsd / 2;
          const tokenXDecimals = yield* getTokenMeta(pool.tokenX).pipe(
            Effect.map((m) => m.decimals),
          );
          const tokenYDecimals = yield* getTokenMeta(pool.tokenY).pipe(
            Effect.map((m) => m.decimals),
          );

          const requestedXAmount = computeRequiredAtomic(halfUsd, priceX, tokenXDecimals);
          const requestedYAmount = computeRequiredAtomic(halfUsd, priceY, tokenYDecimals);

          if (requestedXAmount === 0n || requestedYAmount === 0n) {
            return yield* Effect.fail(
              new AdapterError({
                message: "Cannot enter a position with a zero-sized token leg",
                poolAddress,
              }),
            );
          }

          // Check balances
          const balanceX = yield* readTokenBalance(pool.tokenX);
          const balanceY = yield* readTokenBalance(pool.tokenY);
          const nativeSolBalance =
            pool.tokenX === SOL_MINT || pool.tokenY === SOL_MINT
              ? yield* readNativeSolBalance()
              : undefined;

          const maxX =
            pool.tokenX === SOL_MINT
              ? nativeSolBalance !== undefined && nativeSolBalance > GAS_RESERVE_LAMPORTS
                ? nativeSolBalance - GAS_RESERVE_LAMPORTS
                : 0n
              : balanceX;

          const maxY =
            pool.tokenY === SOL_MINT
              ? nativeSolBalance !== undefined && nativeSolBalance > GAS_RESERVE_LAMPORTS
                ? nativeSolBalance - GAS_RESERVE_LAMPORTS
                : 0n
              : balanceY;

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

          let depositXAtomic = requestedXAmount;
          let depositYAtomic = requestedYAmount;
          let depositMode: EntryDepositMode = "two-sided";
          let singleSidedX: boolean | undefined;
          let amountXUsd = halfUsd;
          let amountYUsd = halfUsd;

          if (xShort && yShort) {
            return yield* Effect.fail(
              new AdapterError({
                message: `Insufficient token balance: ${shortageX}; ${shortageY}. Neither pool token can fund the entry — fund one pool token up to the full position size for a single-sided deposit, or enable AUTO_SWAP_ENTRY with a USDC balance.`,
                poolAddress,
              }),
            );
          }

          if (xShort || yShort) {
            const heldIsX = yShort;
            const heldMint = heldIsX ? pool.tokenX : pool.tokenY;
            const heldDecimals = heldIsX ? tokenXDecimals : tokenYDecimals;
            const heldPrice = heldIsX ? priceX : priceY;
            const heldAvailable = heldIsX ? maxX : maxY;
            const missingShortage = heldIsX ? shortageY : shortageX;
            // Single-sided deposits place the entire position in the held
            // token — never silently downsized to the available half.
            const fullSizeAtomic = computeRequiredAtomic(positionSizeUsd, heldPrice, heldDecimals);
            if (fullSizeAtomic === 0n || fullSizeAtomic > heldAvailable) {
              return yield* Effect.fail(
                new AdapterError({
                  message: `Single-sided entry impossible for ${heldMint}: available ${formatTokenAmount(heldAvailable, heldDecimals)} is below the full-size requirement ${formatTokenAmount(fullSizeAtomic, heldDecimals)} for a $${positionSizeUsd} single-sided deposit (${missingShortage}). Fund the held token up to the full position size or enable AUTO_SWAP_ENTRY.`,
                  poolAddress,
                }),
              );
            }
            if (heldIsX) {
              depositXAtomic = fullSizeAtomic;
              depositYAtomic = 0n;
              singleSidedX = true;
              depositMode = "single-sided-x";
              amountXUsd = positionSizeUsd;
              amountYUsd = 0;
            } else {
              depositXAtomic = 0n;
              depositYAtomic = fullSizeAtomic;
              singleSidedX = false;
              depositMode = "single-sided-y";
              amountXUsd = 0;
              amountYUsd = positionSizeUsd;
            }
            logger.info("Single-sided entry: depositing the full size in the held leg", {
              pool: poolAddress,
              heldMint,
              depositMode,
              amountUsd: positionSizeUsd,
            });
          }

          const totalXAmount = new BN(depositXAtomic.toString());
          const totalYAmount = new BN(depositYAtomic.toString());

          // The decision loop resolves `auto` per pool and passes a concrete
          // shape; a bare `auto` config reaches the adapter only from direct
          // calls without volatility context, where spot is the safe default.
          const strategyShape =
            options?.strategyShape ??
            (config.entryStrategyType === "auto" ? "spot" : config.entryStrategyType);
          const strategy: StrategyParameters = {
            minBinId: lowerBinId,
            maxBinId: upperBinId,
            strategyType: toSdkStrategyType(strategyShape),
            ...(singleSidedX !== undefined ? { singleSidedX } : {}),
          };

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
          Effect.catch((err: unknown) =>
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

          // Pre-close snapshot of the exact on-chain amounts about to be
          // withdrawn. The close batch (`shouldClaimAndClose`) sweeps these
          // accrued swap fees AND LM rewards on-chain, so withdrawn =
          // principal + pending fees. The *ExcludeTransferFee variants equal
          // gross for plain SPL and are correct (net-of-fee) for token-2022.
          const withdrawnXAtomic = positionData.totalXAmountExcludeTransferFee
            .add(positionData.feeXExcludeTransferFee)
            .toString();
          const withdrawnYAtomic = positionData.totalYAmountExcludeTransferFee
            .add(positionData.feeYExcludeTransferFee)
            .toString();
          const pendingFeeXAtomic = positionData.feeXExcludeTransferFee.toString();
          const pendingFeeYAtomic = positionData.feeYExcludeTransferFee.toString();
          const rewardOneAtomic = positionData.rewardOneExcludeTransferFee;
          const rewardTwoAtomic = positionData.rewardTwoExcludeTransferFee;

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

          // USD pricing is best-effort and runs ONLY after the close txs land —
          // it must never abort or delay removing bleeding liquidity. Any
          // failure resolves the USD legs to null (never 0, never the mark) so
          // the caller books a NULL realized PnL; atomics are always returned.
          const accounting = yield* Effect.gen(function* () {
            const tokenXMint = dlmm.lbPair.tokenXMint.toBase58();
            const tokenYMint = dlmm.lbPair.tokenYMint.toBase58();
            const decimalsX = dlmm.tokenX.mint.decimals;
            const decimalsY = dlmm.tokenY.mint.decimals;

            const rewardInfos = dlmm.lbPair.rewardInfos;
            const mintOf = (mint: PublicKey | undefined): string | null => {
              const base58 = mint?.toBase58();
              return base58 != null && base58 !== DEFAULT_PUBLIC_KEY ? base58 : null;
            };
            const rewardSlots = [
              {
                mint: mintOf(rewardInfos[0]?.mint),
                amountAtomic: Number(rewardOneAtomic.toString()),
              },
              {
                mint: mintOf(rewardInfos[1]?.mint),
                amountAtomic: Number(rewardTwoAtomic.toString()),
              },
            ].filter((s) => Number.isFinite(s.amountAtomic) && s.amountAtomic > 0);

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
              Effect.catch(() => Effect.succeed({} as Record<string, number>)),
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
                amountAtomic: slot.amountAtomic,
                amountUsd,
              });
            }

            return { withdrawnUsd, pendingFeeUsd, sweptRewards };
          }).pipe(
            Effect.catch(() =>
              Effect.succeed({
                withdrawnUsd: null as number | null,
                pendingFeeUsd: null as number | null,
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
          Effect.catch((err: unknown) =>
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
              ? {}
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
          Effect.catch((err: unknown) =>
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
            return yield* Effect.fail(new AdapterError({ message: "Invalid limit-order bin IDs" }));
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
          Effect.catch((err: unknown) =>
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
            ...(topUp ? { topUp } : {}),
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
          for (let i = 0; i < initBinArrayInstructions.length; i += MAX_INIT_BIN_ARRAY_IXS_PER_TX) {
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
          Effect.catch((err: unknown) =>
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
              const tokenXMint = dlmm.lbPair.tokenXMint as PublicKey;
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
            }).pipe(Effect.catch(() => Effect.succeed({} as Record<string, number>)));
            const priceX = prices[tokenXMint];
            const priceY = prices[tokenYMint];
            if (priceX == null || priceX <= 0 || priceY == null || priceY <= 0) return null;
            return (
              (netFeeX / 10 ** dlmm.tokenX.mint.decimals) * priceX +
              (netFeeY / 10 ** dlmm.tokenY.mint.decimals) * priceY
            );
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
            ...(transferInstructions.length > 0 ? { feeTransferTxSignature: signature } : {}),
            ...(actualOperatorFeeX > 0 || actualOperatorFeeY > 0
              ? { operatorFeeX: actualOperatorFeeX, operatorFeeY: actualOperatorFeeY }
              : {}),
          };
        }).pipe(
          Effect.catch((err: unknown) =>
            Effect.fail(
              new AdapterError({
                message: `Failed to claim fees: ${String(err)}`,
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
          const inputMints = [dlmm.lbPair.tokenXMint.toBase58(), dlmm.lbPair.tokenYMint.toBase58()];
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
            const quote = yield* quoteSwapToken(inputMint, targetMint, BigInt(Math.trunc(amount)));
            const quotedOutput = quote.outAmount;
            if (
              typeof quotedOutput !== "string" ||
              !/^\d+$/.test(quotedOutput) ||
              quotedOutput === "0"
            ) {
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
                  Effect.catch(() => Effect.succeed({} as Record<string, number>)),
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
          Effect.catch((err: unknown) =>
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
          const apiKey = yield* Effect.try({
            try: () => {
              const credsPath = path.join(getPrismUserConfigDir(), "credentials.json");
              const creds = JSON.parse(fs.readFileSync(credsPath, "utf-8")) as {
                apiKey?: unknown;
              };
              return typeof creds.apiKey === "string" ? creds.apiKey : "";
            },
            catch: () => "",
          });
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
          const res = yield* Effect.tryPromise({
            try: () =>
              fetch("https://prism-api.irfndi.workers.dev/v1/revenue/log", {
                method: "POST",
                headers,
                body: JSON.stringify({ ...event, installId }),
                signal: AbortSignal.timeout(10_000),
              }),
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
          let pageSize = 1000;
          try {
            const configured = Number(new URL(baseUrl).searchParams.get("page_size") ?? 1000);
            if (Number.isSafeInteger(configured) && configured > 0) pageSize = configured;
          } catch {}
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
          const parsed: unknown = yield* Effect.tryPromise({
            try: () => res.json(),
            catch: (cause) =>
              new DiscoverPoolsError({
                message: `Invalid JSON from ${url}: ${String(cause)}`,
                url,
                cause,
              }),
          });
          if (!isPoolsEnvelope(parsed)) {
            return yield* Effect.fail(
              new DiscoverPoolsError({
                message: `Meteora API returned non-envelope payload (${describe(parsed)}) from ${url}`,
                url,
              }),
            );
          }
          const {
            data,
            total,
            pages,
            current_page: currentPage,
            page_size: responsePageSize,
          } = parsed;
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
            (requestedPage === null ||
              (currentPage === requestedPage && responsePageSize === pageSize));
          if (!paginationValid) {
            return yield* Effect.fail(
              new DiscoverPoolsError({
                message: `Meteora API returned malformed pagination metadata from ${url}`,
                url,
              }),
            );
          }
          discoveryPageCount = Math.max(pages, 1);
          const valid = data.filter(isValidPoolShape);
          if (data.length > 0 && valid.length === 0) {
            // Every row failed shape validation: almost always a schema change
            // upstream, not random data noise. Fail loud so the regression is
            // visible instead of silently masking it as an empty result.
            logger.warn(
              "Pool discovery: ALL pool objects had invalid shape; treating as a schema error",
              { dropped: data.length, kept: 0, total, pages },
            );
            return yield* Effect.fail(
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
          return valid
            .filter((p) => p.tvl >= config.discoveryMinTvlUsd && !p.launchpad)
            .map(toDiscoveredPool)
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
              const url = new URL(baseUrl);
              url.searchParams.set("page", String(page));
              url.searchParams.set("page_size", "1000");
              const res = yield* Effect.tryPromise({
                try: () => fetch(url.toString(), { signal: AbortSignal.timeout(15_000) }),
                catch: (cause) => cause as Error,
              });
              if (!res.ok) {
                logger.warn("Market scan: page fetch non-OK", { page, status: res.status });
                return [];
              }
              const parsed: unknown = yield* Effect.tryPromise({
                try: () => res.json(),
                catch: (cause) => cause as Error,
              });
              if (!isPoolsEnvelope(parsed)) return [];
              const valid = parsed.data.filter(isValidPoolShape);
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
                return Effect.succeed([] as ReadonlyArray<DiscoveredPool>);
              }),
            );
          const pagesResult = yield* Effect.all(
            Array.from({ length: pageCount }, (_, i) => fetchPage(i + 1)),
            { concurrency: 3 },
          ).pipe(
            Effect.catch(() => Effect.succeed([] as ReadonlyArray<ReadonlyArray<DiscoveredPool>>)),
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

      swapUSDCForToken: (
        outputMint: string,
        amountAtomic: bigint,
        quoteData?: Record<string, unknown>,
      ) =>
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
        quoteData?: Record<string, unknown>,
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
