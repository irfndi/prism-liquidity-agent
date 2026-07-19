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
import { Context, Effect, Layer } from "effect";
import { AdapterService, type AdapterApi } from "./services.js";
import { ConfigService } from "./config-service.js";
import { AdapterError } from "./errors.js";
import { DiscoverPoolsError } from "./errors.js";
import { SwapQuoteError } from "./errors.js";
import { createLogger } from "./logger.js";
import { getPrismUserConfigDir } from "./paths.js";
import type {
  BinArray,
  BinData,
  EntryDepositMode,
  EntryStrategyShape,
  PoolState,
  Position,
} from "./types.js";
import {
  CircuitBreaker,
  isRpcNetworkError,
  retryEffectWithBackoff,
  retryWithBackoff,
} from "./adapter-retry.js";
import bs58 from "bs58";
import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { getWalletSystemLamportsRequired } from "./live-entry-budget.js";
import { SOL_MINT, USDC_MINT, GAS_RESERVE_LAMPORTS } from "./constants.js";
import { computeRequiredAtomic } from "./entry-prep-service.js";
import type { ClaimedReward } from "./rewards.js";

const DEFAULT_PUBLIC_KEY = "11111111111111111111111111111111";

const RPC_RETRY_OPTIONS = {
  maxRetries: 1,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  rateLimitBaseDelayMs: 5_000,
} as const;
const RPC_MIN_INTERVAL_MS = 50;
const RPC_REQUEST_TIMEOUT_MS = 15_000;

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

// Effect.tryPromise wraps rejections in UnknownException; surface the original
// message so gate logs and AdapterErrors stay readable.
function underlyingErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "cause" in err) {
    const cause = (err as { cause: unknown }).cause;
    if (cause instanceof Error) return cause.message;
  }
  return err instanceof Error ? err.message : String(err);
}

const logger = createLogger("adapter-service");

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
      catch: (cause) => cause,
    }).pipe(Effect.catchAll(() => Effect.succeed(null)));
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
      catch: (cause) => cause,
    }).pipe(Effect.catchAll(() => Effect.void));
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
          catch: (cause) => cause,
        }).pipe(
          Effect.catchAll((err) => {
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

    function withRpcTimeout<T>(effect: Effect.Effect<T, unknown>): Effect.Effect<T, unknown> {
      return effect.pipe(
        Effect.timeoutFail({
          duration: RPC_REQUEST_TIMEOUT_MS,
          onTimeout: () => new Error("RPC request timeout after 15s"),
        }),
      );
    }

    function rpcCall<T>(
      fn: (conn: Connection) => Promise<T>,
      primaryConn: Connection = connection,
    ): Effect.Effect<T, unknown> {
      const run = (conn: Connection, breaker: CircuitBreaker): Effect.Effect<T, unknown> =>
        paceRpc(conn).pipe(
          Effect.zipRight(
            breaker.execute(
              retryEffectWithBackoff(
                withRpcTimeout(
                  Effect.tryPromise({
                    try: () => fn(conn),
                    catch: (cause) => cause,
                  }),
                ),
                RPC_RETRY_OPTIONS,
              ),
              isRpcNetworkError,
            ),
          ),
        );

      return run(primaryConn, primaryRpcCircuitBreaker).pipe(
        Effect.catchAll((err) => {
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
            ).pipe(Effect.zipRight(run(fallbackConnection, fallbackRpcCircuitBreaker)));
          }
          return Effect.fail(err);
        }),
      );
    }

    const getDlmmCached = yield* Effect.cachedFunction((poolAddress: string) => {
      return Effect.try({
        try: () => new PublicKey(poolAddress),
        catch: (cause) => cause,
      }).pipe(
        Effect.flatMap((pubkey) =>
          Effect.cachedInvalidateWithTTL(
            rpcCall((conn) => DLMM.create(conn, pubkey)),
            DLMM_CACHE_TTL_MS,
          ),
        ),
      );
    });

    function getDlmm(poolAddress: string): Effect.Effect<DLMM, unknown> {
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
    ): Effect.Effect<{ mintAuthority: string | null; freezeAuthority: string | null }, unknown> {
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

    const fetchHeliusAssetCached = yield* Effect.cachedFunction((mint: string) => {
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
          catch: (cause) => cause,
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
      return Effect.cachedInvalidateWithTTL(
        paceHeliusRequest().pipe(
          Effect.zipRight(retryEffectWithBackoff(withRpcTimeout(assetRequest), RPC_RETRY_OPTIONS)),
        ),
        HELIUS_ASSET_CACHE_TTL_MS,
      );
    });

    function fetchHeliusAsset(mint: string): Effect.Effect<HeliusAssetResponse | null, unknown> {
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

    function getTokenMeta(mint: string): Effect.Effect<TokenMeta, unknown> {
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
          const json = yield* fetchHeliusAsset(mint).pipe(
            Effect.catchAll(() => Effect.succeed(null)),
          );
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
              Effect.catchAll((err) => {
                logger.debug("Helius asset price unavailable", {
                  mint,
                  error: String(err),
                });
                return Effect.succeed(null);
              }),
              Effect.map((asset) => {
                const price = asset ? readHeliusPrice(asset) : undefined;
                if (price !== undefined) {
                  result[mint] = price;
                  setCachedPrice(mint, price);
                }
              }),
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
      }).pipe(Effect.catchAll(() => Effect.succeed({})));
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
      }).pipe(Effect.catchAll(() => Effect.succeed({})));
    }

    function fetchTokenPrices(
      mints: ReadonlyArray<string>,
    ): Effect.Effect<Record<string, number>, unknown> {
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
            setCachedPrice(mint, metadataPrice);
            prices[mint] = metadataPrice;
            continue;
          }
          const missFetchedAt = negativePriceCache.get(mint);
          if (missFetchedAt !== undefined) {
            if (Date.now() - missFetchedAt < PRICE_MISS_CACHE_TTL_MS) {
              prices[mint] = fallbackPrices[mint] ?? 0;
              continue;
            }
            negativePriceCache.delete(mint);
          }
          missing.push(mint);
        }

        if (missing.length === 0) return prices;

        const heliusPrices = yield* fetchHeliusPrices(missing);
        const stillMissing: string[] = [];
        for (const mint of missing) {
          const price = heliusPrices[mint];
          if (price !== undefined) {
            prices[mint] = price;
          } else {
            stillMissing.push(mint);
          }
        }

        if (stillMissing.length === 0) return prices;

        const jupiterPrices = yield* fetchJupiterPrices(stillMissing);
        const coinGeckoMissing: string[] = [];
        for (const mint of stillMissing) {
          const price = jupiterPrices[mint];
          if (price !== undefined) {
            prices[mint] = price;
          } else {
            coinGeckoMissing.push(mint);
          }
        }

        const cgPrices = yield* fetchCoinGeckoPrices(coinGeckoMissing);
        const unresolved: string[] = [];
        for (const mint of coinGeckoMissing) {
          const cgPrice = cgPrices[mint];
          if (cgPrice !== undefined) {
            prices[mint] = cgPrice;
          } else {
            unresolved.push(mint);
          }
        }

        for (const mint of unresolved) {
          negativePriceCache.set(mint, Date.now());
          prices[mint] = fallbackPrices[mint] ?? 0;
        }

        return prices;
      });
    }

    const WALLET_BALANCE_CACHE_TTL_MS = 30_000;
    const tokenBalanceCache = new Map<string, { value: bigint; expiresAt: number }>();
    let nativeSolBalanceCache: { value: bigint; expiresAt: number } | undefined;

    function readTokenBalance(mintAddress: string): Effect.Effect<bigint, unknown> {
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
    }): Effect.Effect<bigint, unknown> {
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

    function readWalletBalanceUsd(): Effect.Effect<number, unknown> {
      return Effect.gen(function* () {
        if (!wallet) return 0;
        const lamports = Number(yield* readNativeSolBalance());
        const prices = yield* fetchTokenPrices([SOL_MINT]);
        const solPrice = prices[SOL_MINT] ?? fallbackPrices[SOL_MINT] ?? 0;
        const usdcRaw = yield* readTokenBalance(USDC_MINT);
        return (lamports / 1e9) * solPrice + Number(usdcRaw) / 1e6;
      });
    }

    const [cachedWalletBalance, invalidateWalletBalance] = yield* Effect.cachedInvalidateWithTTL(
      readWalletBalanceUsd(),
      WALLET_BALANCE_CACHE_TTL_MS,
    );

    const invalidateBalanceCaches = Effect.sync(() => {
      tokenBalanceCache.clear();
      nativeSolBalanceCache = undefined;
    }).pipe(Effect.zipRight(invalidateWalletBalance));

    function quoteMatchesRequest(
      quoteData: Record<string, unknown>,
      inputMint: string,
      outputMint: string,
      amountAtomic: bigint,
    ): boolean {
      const quoteInputMint = quoteData.inputMint;
      if (quoteInputMint !== inputMint) return false;
      const quoteOutputMint = quoteData.outputMint;
      if (quoteOutputMint !== outputMint) return false;
      const inAmount = quoteData.inAmount;
      const expectedAmount = amountAtomic.toString();
      if (inAmount !== expectedAmount && String(inAmount) !== expectedAmount) return false;
      // A prefetched quote without a usable route should be rejected early so the
      // caller gets a clear quote failure instead of a swap-build failure.
      if (!Array.isArray(quoteData.routePlan) || quoteData.routePlan.length === 0) return false;
      return true;
    }

    function quoteSwapUSDCForToken(
      outputMint: string,
      amountAtomic: bigint,
    ): Effect.Effect<Record<string, unknown>, unknown> {
      return Effect.gen(function* () {
        const activeWallet = wallet;
        if (!activeWallet) {
          return yield* Effect.fail(new AdapterError({ message: "No wallet configured" }));
        }
        if (amountAtomic <= 0n) {
          return yield* Effect.fail(
            new SwapQuoteError({
              message: `Cannot quote swap for non-positive amount: ${amountAtomic.toString()}`,
            }),
          );
        }

        const jupiterApiKey = process.env.JUPITER_API_KEY ?? "";
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (jupiterApiKey) headers["x-api-key"] = jupiterApiKey;

        const quoteResponse = yield* Effect.tryPromise(() =>
          fetch(
            `https://api.jup.ag/swap/v1/quote?inputMint=${USDC_MINT}&outputMint=${outputMint}&amount=${amountAtomic.toString()}&slippageBps=50&asLegacyTransaction=true`,
            {
              headers: jupiterApiKey ? headers : undefined,
              signal: AbortSignal.timeout(10_000),
            },
          ),
        );

        if (!quoteResponse.ok) {
          return yield* Effect.fail(
            new SwapQuoteError({
              message: `Jupiter quote failed: ${quoteResponse.status}`,
            }),
          );
        }

        const quoteData = (yield* Effect.tryPromise(() => quoteResponse.json())) as {
          routePlan?: unknown;
        };

        if (!Array.isArray(quoteData.routePlan) || quoteData.routePlan.length === 0) {
          return yield* Effect.fail(
            new SwapQuoteError({
              message: "Jupiter quote returned no usable route",
            }),
          );
        }

        return quoteData as Record<string, unknown>;
      });
    }

    function quoteSwapToken(
      inputMint: string,
      outputMint: string,
      amountAtomic: bigint,
    ): Effect.Effect<Record<string, unknown>, unknown> {
      return Effect.gen(function* () {
        if (!wallet)
          return yield* Effect.fail(new AdapterError({ message: "No wallet configured" }));
        if (amountAtomic <= 0n)
          return yield* Effect.fail(
            new SwapQuoteError({ message: "Cannot quote non-positive fee amount" }),
          );
        const apiKey = process.env.JUPITER_API_KEY?.trim() ?? "";
        const response = yield* Effect.tryPromise(() =>
          fetch(
            `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountAtomic.toString()}&slippageBps=50&asLegacyTransaction=true`,
            {
              headers: apiKey
                ? { "Content-Type": "application/json", "x-api-key": apiKey }
                : undefined,
              signal: AbortSignal.timeout(10_000),
            },
          ),
        );
        if (!response.ok)
          return yield* Effect.fail(
            new SwapQuoteError({ message: `Jupiter quote failed: ${response.status}` }),
          );
        const quote = (yield* Effect.tryPromise(() => response.json())) as Record<string, unknown>;
        if (!quoteMatchesRequest(quote, inputMint, outputMint, amountAtomic)) {
          return yield* Effect.fail(
            new SwapQuoteError({ message: "Jupiter quote returned no validated route" }),
          );
        }
        return quote;
      });
    }

    function swapUSDCForToken(
      outputMint: string,
      amountAtomic: bigint,
      prefetchedQuote?: Record<string, unknown>,
    ): Effect.Effect<string, unknown> {
      return Effect.gen(function* () {
        const activeWallet = wallet;
        if (!activeWallet) {
          return yield* Effect.fail(new AdapterError({ message: "No wallet configured" }));
        }
        if (amountAtomic <= 0n) {
          return yield* Effect.fail(
            new AdapterError({
              message: `Cannot swap USDC for non-positive amount: ${amountAtomic.toString()}`,
            }),
          );
        }

        const jupiterApiKey = process.env.JUPITER_API_KEY ?? "";
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (jupiterApiKey) headers["x-api-key"] = jupiterApiKey;

        const quoteData =
          prefetchedQuote ?? (yield* quoteSwapUSDCForToken(outputMint, amountAtomic));

        if (
          prefetchedQuote &&
          !quoteMatchesRequest(quoteData, USDC_MINT, outputMint, amountAtomic)
        ) {
          return yield* Effect.fail(
            new AdapterError({
              message: `Prefetched Jupiter quote does not match request: outputMint=${outputMint}, amount=${amountAtomic.toString()}`,
            }),
          );
        }

        const swapResponse = yield* Effect.tryPromise(() =>
          fetch("https://api.jup.ag/swap/v1/swap", {
            method: "POST",
            headers,
            body: JSON.stringify({
              quoteResponse: quoteData,
              userPublicKey: activeWallet.publicKey.toBase58(),
              wrapAndUnwrapSol: true,
              asLegacyTransaction: true,
            }),
            signal: AbortSignal.timeout(10_000),
          }),
        );

        if (!swapResponse.ok) {
          return yield* Effect.fail(
            new AdapterError({
              message: `Jupiter swap build failed: ${swapResponse.status}`,
            }),
          );
        }

        const swapData = (yield* Effect.tryPromise(() => swapResponse.json())) as {
          swapTransaction?: string;
        };

        if (!swapData.swapTransaction) {
          return yield* Effect.fail(
            new AdapterError({ message: "Jupiter swap: no transaction returned" }),
          );
        }

        const swapTxBuf = Buffer.from(swapData.swapTransaction, "base64");
        const swapTx = Transaction.from(swapTxBuf);
        swapTx.sign(activeWallet);

        const sig = yield* rpcCall((conn) =>
          conn.sendRawTransaction(swapTx.serialize(), {
            skipPreflight: false,
            preflightCommitment: "confirmed",
          }),
        );

        yield* rpcCall((conn) => conn.confirmTransaction(sig, "confirmed"));
        yield* invalidateBalanceCaches;
        return sig;
      });
    }

    function swapToken(
      inputMint: string,
      outputMint: string,
      amountAtomic: bigint,
      quoteData?: Record<string, unknown>,
    ): Effect.Effect<string, unknown> {
      return Effect.gen(function* () {
        if (!wallet)
          return yield* Effect.fail(new AdapterError({ message: "No wallet configured" }));
        const quote = quoteData ?? (yield* quoteSwapToken(inputMint, outputMint, amountAtomic));
        if (!quoteMatchesRequest(quote, inputMint, outputMint, amountAtomic)) {
          return yield* Effect.fail(
            new AdapterError({ message: "Validated Jupiter quote does not match fee conversion" }),
          );
        }
        const apiKey = process.env.JUPITER_API_KEY?.trim() ?? "";
        const response = yield* Effect.tryPromise(() =>
          fetch("https://api.jup.ag/swap/v1/swap", {
            method: "POST",
            headers: apiKey
              ? { "Content-Type": "application/json", "x-api-key": apiKey }
              : { "Content-Type": "application/json" },
            body: JSON.stringify({
              quoteResponse: quote,
              userPublicKey: wallet!.publicKey.toBase58(),
              wrapAndUnwrapSol: true,
              asLegacyTransaction: true,
            }),
            signal: AbortSignal.timeout(10_000),
          }),
        );
        if (!response.ok)
          return yield* Effect.fail(
            new AdapterError({ message: `Jupiter fee conversion failed: ${response.status}` }),
          );
        const data = (yield* Effect.tryPromise(() => response.json())) as {
          swapTransaction?: string;
        };
        if (!data.swapTransaction)
          return yield* Effect.fail(
            new AdapterError({ message: "Jupiter fee conversion returned no transaction" }),
          );
        const transaction = Transaction.from(Buffer.from(data.swapTransaction, "base64"));
        transaction.sign(wallet);
        const signature = yield* rpcCall((conn) =>
          conn.sendRawTransaction(transaction.serialize(), {
            skipPreflight: false,
            preflightCommitment: "confirmed",
          }),
        );
        yield* rpcCall((conn) => conn.confirmTransaction(signature, "confirmed"));
        yield* invalidateBalanceCaches;
        return signature;
      });
    }

    // ─── Pool stats ────────────────────────────────────────────────────────

    function sendInstructions(
      instructions: ReadonlyArray<TransactionInstruction>,
    ): Effect.Effect<string, unknown> {
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
      unknown
    > {
      return Effect.gen(function* () {
        const dlmm = yield* getDlmm(poolAddress);
        const lbPair = dlmm.lbPair;
        const pubkey = new PublicKey(poolAddress);

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
        Effect.catchAll(() =>
          Effect.succeed({ tvlUsd: 0, volume24hUsd: 0, fees24hUsd: 0, apr: 0 }),
        ),
      );
    }

    // ─── API implementation ────────────────────────────────────────────────

    const api: AdapterApi = {
      hasWallet: () => wallet !== null,

      getWalletAddress: () => wallet?.publicKey.toBase58() ?? null,

      getWalletBalanceUsd: () => cachedWalletBalance,

      getNativeSolBalance: () =>
        Effect.gen(function* () {
          if (!wallet) return 0n;
          return yield* readNativeSolBalance();
        }),

      getTokenBalance: (mintAddress: string) => readTokenBalance(mintAddress),

      getTokenPrices: (mints: ReadonlyArray<string>) => fetchTokenPrices(mints),

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
          Effect.catchAll((err) =>
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
            Effect.catchAll((err) => {
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
          Effect.catchAll((err: unknown) =>
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

          yield* invalidateBalanceCaches;
          yield* rpcCall((conn) => conn.confirmTransaction(signature, "confirmed"));

          return {
            positionPubKey: positionKeypair.publicKey.toBase58(),
            txSignature: signature,
            depositMode,
            amountXUsd,
            amountYUsd,
          };
        }).pipe(
          Effect.catchAll((err: unknown) =>
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
          const lowerBinId = position.positionData.lowerBinId;
          const upperBinId = position.positionData.upperBinId;

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

          return { txSignature: "batch-confirmed" };
        }).pipe(
          Effect.catchAll((err: unknown) =>
            Effect.fail(
              new AdapterError({
                message: `Failed to exit position: ${String(err)}`,
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
          Effect.catchAll((err: unknown) =>
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

          return {
            txSignature: signature,
            feeX,
            feeY,
            platformFeeX: actualPlatformFeeX,
            platformFeeY: actualPlatformFeeY,
            netFeeX: feeX - actualPlatformFeeX,
            netFeeY: feeY - actualPlatformFeeY,
            ...(transferInstructions.length > 0 ? { feeTransferTxSignature: signature } : {}),
            ...(actualOperatorFeeX > 0 || actualOperatorFeeY > 0
              ? { operatorFeeX: actualOperatorFeeX, operatorFeeY: actualOperatorFeeY }
              : {}),
          };
        }).pipe(
          Effect.catchAll((err: unknown) =>
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
          if (feeX <= 0 && feeY <= 0)
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
                  Effect.catchAll(() => Effect.succeed({} as Record<string, number>)),
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
                Effect.catchAll(() => Effect.succeed(null)),
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
          Effect.catchAll((err: unknown) =>
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
            catch: (cause) => cause,
          });
          if (!res.ok) {
            logger.warn("Revenue report failed:", res.status);
          }
        }).pipe(
          Effect.catchAll((err) =>
            Effect.sync(() => logger.warn("Revenue report failed:", String(err))),
          ),
        );
      },

      discoverPools: () =>
        Effect.gen(function* () {
          const url =
            config.meteoraPoolsUrl ||
            "https://dlmm.datapi.meteora.ag/pools?page=1&page_size=1000&filter_by=is_blacklisted=false&sort_by=tvl:desc";
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
          const { data, total, pages } = parsed;
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
            .map((p) => ({
              address: p.address,
              tvlUsd: p.tvl,
              volume24hUsd: p.volume["24h"],
              fees24hUsd: p.fees["24h"],
              apr: p.apr,
              binStep: p.pool_config.bin_step,
              tokenX: p.token_x.address,
              tokenY: p.token_y.address,
            }))
            .slice(0, 50);
        }),

      quoteSwapUSDCForToken: (outputMint: string, amountAtomic: bigint) =>
        quoteSwapUSDCForToken(outputMint, amountAtomic).pipe(
          Effect.catchAll((err) =>
            Effect.fail(
              new AdapterError({
                message: `quoteSwapUSDCForToken failed: ${String(err)}`,
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
          Effect.catchAll((err) =>
            Effect.fail(
              new AdapterError({
                message: `swapUSDCForToken failed: ${String(err)}`,
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
            Effect.tap((sig) => {
              if (sig) {
                logger.info("Swapped USDC → SOL for gas", { tx: sig, amountUSDC: swapAmountUSDC });
              }
            }),
            Effect.catchAll((err) =>
              Effect.sync(() => logger.warn("USDC → SOL swap failed (non-fatal):", String(err))),
            ),
          );
        }).pipe(Effect.catchAll(() => Effect.void)),
    };

    return api;
  }),
);
