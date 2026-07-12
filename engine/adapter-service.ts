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
import DLMM from "@meteora-ag/dlmm";
import { BN } from "@coral-xyz/anchor";
import { Context, Effect, Layer } from "effect";
import { AdapterService, type AdapterApi } from "./services.js";
import { ConfigService } from "./config-service.js";
import { AdapterError } from "./errors.js";
import { DiscoverPoolsError } from "./errors.js";
import { createLogger } from "./logger.js";
import type { BinArray, BinData, PoolState, Position } from "./types.js";
import { CircuitBreaker, isRpcNetworkError, retryWithBackoff } from "./adapter-retry.js";
import bs58 from "bs58";
import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const GAS_RESERVE_LAMPORTS = 20_000_000n; // 0.02 SOL reserved for transaction fees
const RPC_RETRY_OPTIONS = {
  maxRetries: 2,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  rateLimitBaseDelayMs: 5_000,
} as const;

function formatTokenAmount(amount: bigint, decimals: number): string {
  return (Number(amount) / 10 ** decimals).toFixed(Math.min(decimals, 6));
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

const INSTALL_ID_FILE = path.join(os.homedir(), ".config", "prism", "install-id");
let cachedInstallId: string | null = null;

function getOrCreateInstallId(): string {
  if (cachedInstallId) return cachedInstallId;
  try {
    if (fs.existsSync(INSTALL_ID_FILE)) {
      const existing = fs.readFileSync(INSTALL_ID_FILE, "utf-8").trim();
      if (existing.length >= 8 && existing.length <= 128) {
        cachedInstallId = existing;
        return cachedInstallId;
      }
    }
  } catch {
    // fall through to generate
  }
  const id = randomUUID();
  try {
    const dir = path.dirname(INSTALL_ID_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(INSTALL_ID_FILE, id, { mode: 0o600 });
    fs.chmodSync(INSTALL_ID_FILE, 0o600);
  } catch {
    // keep in memory for this session even if persistence failed
  }
  cachedInstallId = id;
  return id;
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
    let wallet: Keypair | null = null;

    if (config.walletPrivateKey) {
      try {
        wallet = Keypair.fromSecretKey(bs58.decode(config.walletPrivateKey));
      } catch (err) {
        logger.error("Failed to load wallet", err);
        wallet = null;
      }
    }

    // ─── DLMM instance cache (5-minute TTL, promise-based for dedup) ────

    const DLMM_CACHE_TTL_MS = 5 * 60 * 1000;
    const dlmmCache = new Map<string, { promise: Promise<DLMM>; timestamp: number }>();
    const primaryRpcCircuitBreaker = new CircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 30_000,
    });
    const fallbackRpcCircuitBreaker = fallbackConnection
      ? new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 30_000 })
      : null;

    const evictionInterval = setInterval(() => {
      const cutoff = Date.now() - DLMM_CACHE_TTL_MS;
      for (const [key, entry] of dlmmCache) {
        if (entry.timestamp <= cutoff) {
          dlmmCache.delete(key);
        }
      }
    }, DLMM_CACHE_TTL_MS);
    evictionInterval.unref();

    async function getDlmm(poolAddress: string): Promise<DLMM> {
      const cached = dlmmCache.get(poolAddress);
      if (cached && Date.now() - cached.timestamp < DLMM_CACHE_TTL_MS) {
        cached.timestamp = Date.now();
        return cached.promise;
      }
      const pubkey = new PublicKey(poolAddress);
      const promise = rpcCall((conn) => DLMM.create(conn, pubkey)).catch((err) => {
        dlmmCache.delete(poolAddress);
        throw err;
      });
      dlmmCache.set(poolAddress, { promise, timestamp: Date.now() });
      return promise;
    }

    async function rpcCall<T>(
      fn: (conn: Connection) => Promise<T>,
      primaryConn: Connection = connection,
    ): Promise<T> {
      const run = (conn: Connection, breaker: CircuitBreaker): Promise<T> =>
        breaker.execute(
          () => retryWithBackoff(() => fn(conn), RPC_RETRY_OPTIONS),
          isRpcNetworkError,
        );

      try {
        return await run(primaryConn, primaryRpcCircuitBreaker);
      } catch (err) {
        if (
          fallbackConnection &&
          fallbackRpcCircuitBreaker &&
          primaryConn === connection &&
          isRpcNetworkError(err)
        ) {
          logger.warn("Primary RPC failed, trying fallback RPC", {
            error: err instanceof Error ? err.message : String(err),
          });
          return await run(fallbackConnection, fallbackRpcCircuitBreaker);
        }
        throw err;
      }
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
    const heliusAssetCache = new Map<
      string,
      { readonly promise: Promise<HeliusAssetResponse>; readonly fetchedAt: number }
    >();

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

    async function fetchHeliusAsset(mint: string): Promise<HeliusAssetResponse | null> {
      if (!config.heliusApiKey) return null;

      const cached = heliusAssetCache.get(mint);
      if (cached && Date.now() - cached.fetchedAt < HELIUS_ASSET_CACHE_TTL_MS) {
        return cached.promise;
      }

      const url = `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;
      const promise = retryWithBackoff(async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "get-asset",
            method: "getAsset",
            params: { id: mint },
          }),
          signal: AbortSignal.timeout(10_000),
        });
        const json = (await res.json()) as HeliusAssetResponse;
        if (!res.ok) {
          throw Object.assign(new Error(`Helius getAsset returned HTTP ${res.status}`), {
            code: res.status,
          });
        }
        if (json.error) {
          throw Object.assign(new Error(json.error.message ?? "Helius getAsset failed"), {
            code: json.error.code ?? -32005,
          });
        }
        return json;
      }, RPC_RETRY_OPTIONS).catch((err: unknown) => {
        heliusAssetCache.delete(mint);
        throw err;
      });

      heliusAssetCache.set(mint, { promise, fetchedAt: Date.now() });
      return promise;
    }

    // Known mint decimals (avoids network roundtrips for common SPL tokens).
    // If a mint is missing here and the RPC doesn't expose decimals via the
    // standard SPL Token program (or via Helius DAS getAsset), getTokenMeta
    // falls back to 6 — the historical default. For non-Helius RPCs we use
    // the SPL Token program (parsed account info), which returns decimals
    // for any valid SPL mint, instead of the Helius-specific getAsset RPC.
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
          const json = yield* Effect.tryPromise(() => fetchHeliusAsset(mint)).pipe(
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
        const info = yield* Effect.tryPromise(() =>
          rpcCall((conn) => conn.getParsedAccountInfo(mintPubkey)),
        );
        const parsed = (info.value?.data as { parsed?: { info?: { decimals?: number } } })?.parsed
          ?.info;
        if (typeof parsed?.decimals === "number") {
          const meta = { symbol: mint.slice(0, 4), decimals: parsed.decimals };
          tokenMetaCache.set(mint, meta);
          return meta;
        }

        // Last-resort fallback for non-SPL mints (e.g., Token-2022 with
        // exotic extensions). Surface the failure so callers can decide
        // rather than silently mis-sizing positions.
        return yield* Effect.fail(
          new Error(`Cannot resolve decimals for mint ${mint} via Helius or standard RPC`),
        );
      }).pipe(Effect.catchAll(() => Effect.succeed({ symbol: mint.slice(0, 4), decimals: 6 })));
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
        for (const mint of missing) {
          const asset = yield* Effect.tryPromise(() => fetchHeliusAsset(mint)).pipe(
            Effect.catchAll((err) => {
              logger.debug("Helius asset price unavailable", {
                mint,
                error: String(err),
              });
              return Effect.succeed(null);
            }),
          );
          const price = asset ? readHeliusPrice(asset) : undefined;
          if (price !== undefined) {
            result[mint] = price;
            setCachedPrice(mint, price);
          }
        }
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
    let walletBalanceCache: { readonly value: number; readonly fetchedAt: number } | null = null;
    let walletBalanceInFlight: Promise<number> | null = null;

    function invalidateWalletBalanceCache(): void {
      walletBalanceCache = null;
    }

    async function readTokenBalance(mintAddress: string): Promise<bigint> {
      const activeWallet = wallet;
      if (!activeWallet) return 0n;
      const mint = new PublicKey(mintAddress);
      const accounts = await rpcCall((conn) =>
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
      return total;
    }

    async function readWalletBalanceUsd(): Promise<number> {
      const activeWallet = wallet;
      if (!activeWallet) return 0;
      const lamports = await rpcCall((conn) => conn.getBalance(activeWallet.publicKey));
      const prices = await Effect.runPromise(fetchTokenPrices([SOL_MINT]));
      const solPrice = prices[SOL_MINT] ?? fallbackPrices[SOL_MINT] ?? 0;
      const usdcRaw = await readTokenBalance(USDC_MINT);
      return (lamports / 1e9) * solPrice + Number(usdcRaw) / 1e6;
    }

    // ─── Pool stats ────────────────────────────────────────────────────────

    function fetchPoolStats(
      poolAddress: string,
    ): Effect.Effect<
      { tvlUsd: number; volume24hUsd: number; fees24hUsd: number; apr: number },
      unknown
    > {
      return Effect.gen(function* () {
        const dlmm = yield* Effect.tryPromise(() => getDlmm(poolAddress));
        const lbPair = dlmm.lbPair;
        const pubkey = new PublicKey(poolAddress);

        const tokenXMint = lbPair.tokenXMint.toBase58();
        const tokenYMint = lbPair.tokenYMint.toBase58();

        const [mintXInfo, mintYInfo] = yield* Effect.all([
          Effect.tryPromise(() => rpcCall((conn) => conn.getParsedAccountInfo(lbPair.tokenXMint))),
          Effect.tryPromise(() => rpcCall((conn) => conn.getParsedAccountInfo(lbPair.tokenYMint))),
        ]);

        const tokenXDecimals =
          (mintXInfo.value?.data as { parsed?: { info?: { decimals?: number } } })?.parsed?.info
            ?.decimals ?? 9;
        const tokenYDecimals =
          (mintYInfo.value?.data as { parsed?: { info?: { decimals?: number } } })?.parsed?.info
            ?.decimals ?? 6;

        const [balX, balY] = yield* Effect.all([
          Effect.tryPromise(() => rpcCall((conn) => conn.getTokenAccountBalance(lbPair.reserveX))),
          Effect.tryPromise(() => rpcCall((conn) => conn.getTokenAccountBalance(lbPair.reserveY))),
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

      getWalletBalanceUsd: () =>
        Effect.tryPromise(() => {
          if (!wallet) return Promise.resolve(0);
          const now = Date.now();
          if (
            walletBalanceCache &&
            now - walletBalanceCache.fetchedAt < WALLET_BALANCE_CACHE_TTL_MS
          ) {
            return Promise.resolve(walletBalanceCache.value);
          }
          if (walletBalanceInFlight) return walletBalanceInFlight;
          const promise = readWalletBalanceUsd()
            .then((value) => {
              walletBalanceCache = { value, fetchedAt: Date.now() };
              return value;
            })
            .finally(() => {
              walletBalanceInFlight = null;
            });
          walletBalanceInFlight = promise;
          return promise;
        }),

      getNativeSolBalance: () =>
        Effect.gen(function* () {
          if (!wallet) return 0;
          const lamports = yield* Effect.tryPromise(() =>
            rpcCall((conn) => conn.getBalance(wallet.publicKey)),
          );
          return lamports;
        }),

      getPoolState: (poolAddress) =>
        Effect.gen(function* () {
          const dlmm = yield* Effect.tryPromise(() => getDlmm(poolAddress));
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
          const dlmm = yield* Effect.tryPromise(() => getDlmm(poolAddress));
          const activeBin = yield* Effect.tryPromise(() => dlmm.getActiveBin());
          const halfRange = 20;
          const lowerBinId = activeBin.binId - halfRange;
          const upperBinId = activeBin.binId + halfRange;
          const binStep = Number(dlmm.lbPair.binStep);

          const bins: BinData[] = [];
          const basePrice = Number(activeBin.price);
          for (let i = lowerBinId; i <= upperBinId; i++) {
            const price = basePrice * Math.pow(1 + binStep / 10000, i - activeBin.binId);
            bins.push({
              binId: i,
              price,
              reserveX: 0n,
              reserveY: 0n,
              // Synthetic bins lack real reserves; 1n is required so
              // computeBinUtilization counts them as active. Without this,
              // passesPreFilter rejects every pool (bin util == 0).
              liquiditySupply: 1n,
            });
          }

          return {
            lowerBinId,
            upperBinId,
            bins,
            activeBinId: activeBin.binId,
            binStep,
          };
        }),

      getPositions: (poolAddress, walletAddress) =>
        Effect.gen(function* () {
          const wallet = new PublicKey(walletAddress);
          const dlmm = yield* Effect.tryPromise(() => getDlmm(poolAddress));
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
          const allPositions = yield* Effect.tryPromise(() =>
            rpcCall((conn) => DLMM.getAllLbPairPositionsByUser(conn, wallet)),
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

      simulateRebalance: (poolAddress, newLowerBinId, newUpperBinId) =>
        Effect.gen(function* () {
          const pool = yield* api.getPoolState(poolAddress);

          const rangeWidth = Math.max(newUpperBinId - newLowerBinId, 0);

          // Fee estimate: proportional to pool's 24h fees, scaled by our range width
          // A narrower range captures fewer fees but is more capital-efficient.
          const feeCaptureRatio = Math.min(rangeWidth / 100, 1.0);
          const estimatedFeesUsd = pool.fees24hUsd * feeCaptureRatio;

          // IL estimate for rebalancing: small fixed cost (tx fees + temporary IL).
          // The old heuristic (rangeWidth * 0.5) was wrong — rebalancing to center
          // on the active bin eliminates OOR IL, it doesn't create new IL.
          const estimatedIlUsd = 0.5;

          const netBenefitUsd = estimatedFeesUsd - estimatedIlUsd;

          return { estimatedIlUsd, estimatedFeesUsd, netBenefitUsd };
        }),

      enterPosition: (poolAddress, lowerBinId, upperBinId, positionSizeUsd) =>
        Effect.gen(function* () {
          if (!wallet) {
            return yield* Effect.fail(
              new AdapterError({
                message: "No wallet configured",
              }),
            );
          }

          const dlmm = yield* Effect.tryPromise(() => getDlmm(poolAddress));
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

          let totalXAmount = new BN(Math.floor((halfUsd / priceX) * Math.pow(10, tokenXDecimals)));
          let totalYAmount = new BN(Math.floor((halfUsd / priceY) * Math.pow(10, tokenYDecimals)));
          const requestedXAmount = BigInt(totalXAmount.toString());
          const requestedYAmount = BigInt(totalYAmount.toString());

          // Check balances
          const balanceX = yield* getTokenBalance(pool.tokenX);
          const balanceY = yield* getTokenBalance(pool.tokenY);
          let nativeSolBalance = 0n;
          if (pool.tokenX === SOL_MINT || pool.tokenY === SOL_MINT) {
            nativeSolBalance = BigInt(
              yield* Effect.tryPromise(() => rpcCall((conn) => conn.getBalance(wallet.publicKey))),
            );
          }

          const maxX =
            pool.tokenX === SOL_MINT
              ? nativeSolBalance > GAS_RESERVE_LAMPORTS
                ? nativeSolBalance - GAS_RESERVE_LAMPORTS
                : 0n
              : balanceX;
          if (BigInt(totalXAmount.toString()) > maxX) {
            totalXAmount = new BN(maxX.toString());
          }

          const maxY =
            pool.tokenY === SOL_MINT
              ? nativeSolBalance > GAS_RESERVE_LAMPORTS
                ? nativeSolBalance - GAS_RESERVE_LAMPORTS
                : 0n
              : balanceY;
          if (BigInt(totalYAmount.toString()) > maxY) {
            totalYAmount = new BN(maxY.toString());
          }

          if (
            (pool.tokenX === SOL_MINT && maxX === 0n) ||
            (pool.tokenY === SOL_MINT && maxY === 0n)
          ) {
            const shortages: string[] = [];
            if (pool.tokenX === SOL_MINT && maxX === 0n) {
              shortages.push(
                `${pool.tokenX} required ${formatTokenAmount(requestedXAmount, tokenXDecimals)}, available ${formatTokenAmount(maxX, tokenXDecimals)} after gas reserve`,
              );
            }
            if (pool.tokenY === SOL_MINT && maxY === 0n) {
              shortages.push(
                `${pool.tokenY} required ${formatTokenAmount(requestedYAmount, tokenYDecimals)}, available ${formatTokenAmount(maxY, tokenYDecimals)} after gas reserve`,
              );
            }
            return yield* Effect.fail(
              new AdapterError({
                message: `Insufficient native SOL balance after reserving gas: ${shortages.join("; ")}`,
                poolAddress,
              }),
            );
          }

          if (totalXAmount.eq(new BN(0)) || totalYAmount.eq(new BN(0))) {
            const shortages: string[] = [];
            if (totalXAmount.eq(new BN(0))) {
              shortages.push(
                `${pool.tokenX} required ${formatTokenAmount(requestedXAmount, tokenXDecimals)}, available ${formatTokenAmount(maxX, tokenXDecimals)}`,
              );
            }
            if (totalYAmount.eq(new BN(0))) {
              shortages.push(
                `${pool.tokenY} required ${formatTokenAmount(requestedYAmount, tokenYDecimals)}, available ${formatTokenAmount(maxY, tokenYDecimals)}`,
              );
            }
            return yield* Effect.fail(
              new AdapterError({
                message: `Insufficient token balance: ${shortages.join("; ")}. Wallet must hold both pool tokens before live entry.`,
                poolAddress,
              }),
            );
          }

          const positionKeypair = new Keypair();
          const strategy = {
            minBinId: lowerBinId,
            maxBinId: upperBinId,
            strategyType: 0,
          };

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

          tx.feePayer = wallet.publicKey;
          const { blockhash } = yield* Effect.tryPromise(() =>
            rpcCall((conn) => conn.getLatestBlockhash()),
          );
          tx.recentBlockhash = blockhash;
          tx.sign(wallet, positionKeypair);

          const signature = yield* Effect.tryPromise(() =>
            rpcCall((conn) =>
              conn.sendRawTransaction(tx.serialize(), {
                skipPreflight: false,
                preflightCommitment: "confirmed",
              }),
            ),
          );

          yield* Effect.tryPromise(() =>
            rpcCall((conn) => conn.confirmTransaction(signature, "confirmed")),
          );
          invalidateWalletBalanceCache();

          return {
            positionPubKey: positionKeypair.publicKey.toBase58(),
            txSignature: signature,
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
          const dlmm = yield* Effect.tryPromise(() => getDlmm(poolAddress));

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
            const { blockhash } = yield* Effect.tryPromise(() =>
              rpcCall((conn) => conn.getLatestBlockhash()),
            );
            tx.feePayer = wallet.publicKey;
            tx.recentBlockhash = blockhash;
            tx.sign(wallet);

            const signature = yield* Effect.tryPromise(() =>
              rpcCall((conn) =>
                conn.sendRawTransaction(tx.serialize(), {
                  skipPreflight: false,
                  preflightCommitment: "confirmed",
                }),
              ),
            );
            yield* Effect.tryPromise(() =>
              rpcCall((conn) => conn.confirmTransaction(signature, "confirmed")),
            );
          }
          invalidateWalletBalanceCache();

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

      rebalancePosition: (poolAddress, positionPubKey, newLowerBinId, newUpperBinId) =>
        Effect.gen(function* () {
          // NOTE: Sequential exit-then-enter, not atomic. If enter fails after
          // exit succeeds, the position is lost without rollback. Retaining
          // position state for recovery would require significant refactoring.
          yield* api.exitPosition(poolAddress, positionPubKey);
          const pool = yield* api.getPoolState(poolAddress);
          const positionSizeUsd = Math.min(config.paperPortfolioUsd * 0.2, pool.tvlUsd * 0.01);
          const enterResult = yield* api.enterPosition(
            poolAddress,
            newLowerBinId,
            newUpperBinId,
            positionSizeUsd,
          );
          return {
            newPositionPubKey: enterResult.positionPubKey,
            txSignatures: ["batch-confirmed", enterResult.txSignature],
          };
        }),

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
          const dlmm = yield* Effect.tryPromise(() => getDlmm(poolAddress));

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
                const toAtaInfo = yield* Effect.tryPromise(() =>
                  rpcCall((conn) => conn.getAccountInfo(toAta)),
                );
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

          const { blockhash } = yield* Effect.tryPromise(() =>
            rpcCall((conn) => conn.getLatestBlockhash()),
          );

          const messageV0 = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: blockhash,
            instructions: allInstructions,
          }).compileToV0Message();

          const versionedTx = new VersionedTransaction(messageV0);
          versionedTx.sign([wallet]);

          const signature = yield* Effect.tryPromise(() =>
            rpcCall((conn) =>
              conn.sendRawTransaction(versionedTx.serialize(), {
                skipPreflight: false,
                preflightCommitment: "confirmed",
              }),
            ),
          );

          yield* Effect.tryPromise(() =>
            rpcCall((conn) => conn.confirmTransaction(signature, "confirmed")),
          );
          invalidateWalletBalanceCache();

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

      reportFeeCollection(event) {
        void (async () => {
          try {
            const installId = getOrCreateInstallId();
            let apiKey = "";
            try {
              const credsPath = path.join(os.homedir(), ".config", "prism", "credentials.json");
              const creds = JSON.parse(fs.readFileSync(credsPath, "utf-8"));
              apiKey = creds.apiKey ?? "";
            } catch {
              apiKey = "";
            }
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
            const res = await fetch("https://prism-api.irfndi.workers.dev/v1/revenue/log", {
              method: "POST",
              headers,
              body: JSON.stringify({ ...event, installId }),
            });
            if (!res.ok) logger.warn("Revenue report failed:", res.status);
          } catch (err) {
            logger.warn("Revenue report failed:", String(err));
          }
        })();
      },

      discoverPools: () =>
        Effect.gen(function* () {
          const url =
            config.meteoraPoolsUrl ||
            "https://dlmm.datapi.meteora.ag/pools?page=1&page_size=1000&filter_by=is_blacklisted=false&sort_by=tvl:desc";
          const res = yield* Effect.tryPromise({
            try: async () => {
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 10_000);
              try {
                return await fetch(url, { signal: controller.signal });
              } finally {
                clearTimeout(timeout);
              }
            },
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
            .filter((p) => p.tvl >= config.discoveryMinTvlUsd)
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

      swapUSDCForSOL: (minSolThreshold = 0.05, swapAmountUSDC = 1.0) =>
        Effect.gen(function* () {
          if (!wallet) return;

          const lamports = yield* Effect.tryPromise(() =>
            rpcCall((conn) => conn.getBalance(wallet!.publicKey)),
          );
          const solBalance = lamports / 1e9;

          if (solBalance >= minSolThreshold) return;

          logger.info("Low SOL balance — swapping USDC → SOL for gas", {
            solBalance: solBalance.toFixed(4),
            minThreshold: minSolThreshold,
            swapAmountUSDC,
          });

          try {
            const jupiterApiKey = process.env.JUPITER_API_KEY ?? "";
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (jupiterApiKey) headers["x-api-key"] = jupiterApiKey;

            const quoteResponse = yield* Effect.tryPromise(() =>
              fetch(
                `https://api.jup.ag/swap/v1/quote?inputMint=${USDC_MINT}&outputMint=${SOL_MINT}&amount=${Math.round(swapAmountUSDC * 1e6)}&slippageBps=50&asLegacyTransaction=true`,
                { headers: jupiterApiKey ? headers : undefined },
              ),
            );

            if (!quoteResponse.ok) {
              logger.warn("Jupiter quote failed:", quoteResponse.status);
              return;
            }

            const quoteData = (yield* Effect.tryPromise(() => quoteResponse.json())) as {
              routePlan?: unknown;
            };

            const swapResponse = yield* Effect.tryPromise(() =>
              fetch("https://api.jup.ag/swap/v1/swap", {
                method: "POST",
                headers,
                body: JSON.stringify({
                  quoteResponse: quoteData,
                  userPublicKey: wallet!.publicKey.toBase58(),
                  wrapAndUnwrapSol: true,
                  asLegacyTransaction: true,
                }),
              }),
            );

            if (!swapResponse.ok) {
              logger.warn("Jupiter swap build failed:", swapResponse.status);
              return;
            }

            const swapData = (yield* Effect.tryPromise(() => swapResponse.json())) as {
              swapTransaction?: string;
            };

            if (!swapData.swapTransaction) {
              logger.warn("Jupiter swap: no transaction returned");
              return;
            }

            const swapTxBuf = Buffer.from(swapData.swapTransaction, "base64");
            const swapTx = Transaction.from(swapTxBuf);
            swapTx.sign(wallet!);

            const sig = yield* Effect.tryPromise(() =>
              rpcCall((conn) =>
                conn.sendRawTransaction(swapTx.serialize(), {
                  skipPreflight: false,
                  preflightCommitment: "confirmed",
                }),
              ),
            );

            yield* Effect.tryPromise(() =>
              rpcCall((conn) => conn.confirmTransaction(sig, "confirmed")),
            );
            invalidateWalletBalanceCache();
            logger.info("Swapped USDC → SOL for gas", { tx: sig, amountUSDC: swapAmountUSDC });
          } catch (err) {
            logger.warn("USDC → SOL swap failed (non-fatal):", String(err));
          }
        }).pipe(Effect.catchAll(() => Effect.void)),
    };

    return api;

    function getTokenBalance(mintAddress: string): Effect.Effect<bigint, unknown> {
      return Effect.tryPromise(() => readTokenBalance(mintAddress));
    }
  }),
);
