import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
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
import { createLogger } from "./logger.js";
import type { BinArray, BinData, PoolState, Position } from "./types.js";
import bs58 from "bs58";
import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const logger = createLogger("adapter-service");

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

    isCircular = feeWallet !== null && operatorWalletAddress === feeWallet;

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
    let wallet: Keypair | null = null;

    if (config.walletPrivateKey) {
      try {
        wallet = Keypair.fromSecretKey(bs58.decode(config.walletPrivateKey));
      } catch (err) {
        logger.error("Failed to load wallet", err);
        wallet = null;
      }
    }

    // ─── Fee wallet address (cached) ────────────────────────────────────────

    let cachedFeeWallet: { address: string; expiresAt: number } | null = null;
    const FEE_WALLET_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
    const FEE_WALLET_API_URL = "https://prism-api.irfndi.workers.dev";

    function fetchFeeWalletAddress(): Effect.Effect<string, never> {
      return Effect.gen(function* () {
        // Return cached if valid
        if (cachedFeeWallet && Date.now() < cachedFeeWallet.expiresAt) {
          return cachedFeeWallet.address;
        }

        // Always fetch from API — users cannot override the fee wallet
        const res = yield* Effect.tryPromise(() =>
          fetch(`${FEE_WALLET_API_URL}/v1/fee-wallet`),
        );
        if (res.ok) {
          const data = (yield* Effect.tryPromise(() => res.json())) as { address?: string };
          if (data.address) {
            cachedFeeWallet = {
              address: data.address,
              expiresAt: Date.now() + FEE_WALLET_CACHE_TTL_MS,
            };
            return data.address;
          }
        }

        return "";
      }).pipe(Effect.catchAll(() => Effect.succeed("")));
    }

    // ─── Token metadata cache ──────────────────────────────────────────────

    const tokenMetaCache = new Map<string, { symbol: string; decimals: number }>();

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

    function getTokenMeta(
      mint: string,
    ): Effect.Effect<{ symbol: string; decimals: number }, unknown> {
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
          const url = `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;
          const res = yield* Effect.tryPromise(() =>
            fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: "get-asset",
                method: "getAsset",
                params: { id: mint },
              }),
            }),
          );
          const json = (yield* Effect.tryPromise(() => res.json())) as {
            result?: {
              content?: { metadata?: { symbol?: string } };
              token_info?: { decimals?: number };
            };
          };
          const d = json.result?.token_info?.decimals;
          if (typeof d === "number") {
            const meta = {
              symbol: json.result?.content?.metadata?.symbol ?? mint.slice(0, 4),
              decimals: d,
            };
            tokenMetaCache.set(mint, meta);
            return meta;
          }
        }

        // Standard Solana RPC path: parsed account info exposes decimals
        // for any SPL mint via the Token Program (works on mainnet-beta and
        // every other standard RPC). Does NOT call Helius DAS getAsset.
        const mintPubkey = new PublicKey(mint);
        const info = yield* Effect.tryPromise(() => connection.getParsedAccountInfo(mintPubkey));
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

    function fetchTokenPrices(
      mints: ReadonlyArray<string>,
    ): Effect.Effect<Record<string, number>, unknown> {
      return Effect.gen(function* () {
        const prices: Record<string, number> = {};
        const missing: string[] = [];

        for (const mint of mints) {
          if (fallbackPrices[mint]) {
            prices[mint] = fallbackPrices[mint];
          } else {
            missing.push(mint);
          }
        }

        if (missing.length === 0) return prices;

        // Try Jupiter Price API
        try {
          const ids = missing.join(",");
          const res = yield* Effect.tryPromise(() =>
            fetch(`https://price.jup.ag/v6/price?ids=${ids}`),
          );
          if (res.ok) {
            const json = (yield* Effect.tryPromise(() => res.json())) as {
              data?: Record<string, { price: number }>;
            };
            const stillMissing: string[] = [];
            for (const mint of missing) {
              const price = json.data?.[mint]?.price;
              if (price != null) {
                prices[mint] = price;
              } else {
                stillMissing.push(mint);
              }
            }
            missing.length = 0;
            missing.push(...stillMissing);
            if (missing.length === 0) return prices;
          }
        } catch {
          // fall through
        }

        // Fallback to CoinGecko
        try {
          const ids = missing.join(",");
          const res = yield* Effect.tryPromise(() =>
            fetch(
              `https://api.coingecko.com/api/v3/simple/token_price/solana?contract_addresses=${ids}&vs_currencies=usd`,
            ),
          );
          if (res.ok) {
            const json = (yield* Effect.tryPromise(() => res.json())) as Record<
              string,
              { usd: number }
            >;
            for (const mint of missing) {
              prices[mint] = json[mint]?.usd ?? 0;
            }
            return prices;
          }
        } catch {
          // fall through
        }

        for (const mint of missing) {
          prices[mint] = 0;
        }
        return prices;
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
        const pubkey = new PublicKey(poolAddress);
        const dlmm = yield* Effect.tryPromise(() => DLMM.create(connection, pubkey));
        const lbPair = dlmm.lbPair;

        const tokenXMint = lbPair.tokenXMint.toBase58();
        const tokenYMint = lbPair.tokenYMint.toBase58();

        const [mintXInfo, mintYInfo] = yield* Effect.all([
          Effect.tryPromise(() => connection.getParsedAccountInfo(lbPair.tokenXMint)),
          Effect.tryPromise(() => connection.getParsedAccountInfo(lbPair.tokenYMint)),
        ]);

        const tokenXDecimals =
          (mintXInfo.value?.data as { parsed?: { info?: { decimals?: number } } })?.parsed?.info
            ?.decimals ?? 9;
        const tokenYDecimals =
          (mintYInfo.value?.data as { parsed?: { info?: { decimals?: number } } })?.parsed?.info
            ?.decimals ?? 6;

        const vaultX = yield* Effect.tryPromise(() =>
          connection.getTokenAccountsByOwner(pubkey, {
            mint: lbPair.tokenXMint,
          }),
        );
        const vaultY = yield* Effect.tryPromise(() =>
          connection.getTokenAccountsByOwner(pubkey, {
            mint: lbPair.tokenYMint,
          }),
        );

        let reserveX = 0;
        let reserveY = 0;

        if (vaultX.value.length > 0 && vaultX.value[0]) {
          const firstVault = vaultX.value[0] as { pubkey: PublicKey };
          const bal = yield* Effect.tryPromise(() =>
            connection.getTokenAccountBalance(firstVault.pubkey),
          );
          reserveX = Number(bal.value.amount) / Math.pow(10, tokenXDecimals);
        }
        if (vaultY.value.length > 0 && vaultY.value[0]) {
          const firstVault = vaultY.value[0] as { pubkey: PublicKey };
          const bal = yield* Effect.tryPromise(() =>
            connection.getTokenAccountBalance(firstVault.pubkey),
          );
          reserveY = Number(bal.value.amount) / Math.pow(10, tokenYDecimals);
        }

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
        Effect.gen(function* () {
          if (!wallet) return 0;
          const solBal = yield* Effect.tryPromise(() => connection.getBalance(wallet.publicKey));
          const solAmount = solBal / 1e9;
          const prices = yield* fetchTokenPrices([SOL_MINT]);
          const solPrice = prices[SOL_MINT] || 165;
          const solValue = solAmount * solPrice;

          const usdcMint = new PublicKey(USDC_MINT);
          const tokenAccounts = yield* Effect.tryPromise(() =>
            connection.getTokenAccountsByOwner(wallet.publicKey, {
              mint: usdcMint,
            }),
          );

          let usdcValue = 0;
          const firstAccount = tokenAccounts.value[0];
          if (firstAccount) {
            const bal = yield* Effect.tryPromise(() =>
              connection.getTokenAccountBalance(firstAccount.pubkey),
            );
            usdcValue = bal.value.uiAmount ?? 0;
          }

          return solValue + usdcValue;
        }).pipe(Effect.catchAll(() => Effect.succeed(0))),

      getNativeSolBalance: () =>
        Effect.gen(function* () {
          if (!wallet) return 0;
          const lamports = yield* Effect.tryPromise(() => connection.getBalance(wallet.publicKey));
          return lamports;
        }),

      getPoolState: (poolAddress) =>
        Effect.gen(function* () {
          const pubkey = new PublicKey(poolAddress);
          const dlmm = yield* Effect.tryPromise(() => DLMM.create(connection, pubkey));
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
          const pubkey = new PublicKey(poolAddress);
          const dlmm = yield* Effect.tryPromise(() => DLMM.create(connection, pubkey));
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
          const pubkey = new PublicKey(poolAddress);
          const wallet = new PublicKey(walletAddress);
          const dlmm = yield* Effect.tryPromise(() => DLMM.create(connection, pubkey));
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
            DLMM.getAllLbPairPositionsByUser(connection, wallet),
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

          try {
            const poolPubkey = new PublicKey(poolAddress);
            const dlmm = yield* Effect.tryPromise(() => DLMM.create(connection, poolPubkey));
            const pool = yield* api.getPoolState(poolAddress);

            const prices = yield* fetchTokenPrices([pool.tokenX, pool.tokenY]);
            const priceX = prices[pool.tokenX] ?? 0;
            const priceY = prices[pool.tokenY] ?? 0;

            if (!priceX || !priceY) {
              return yield* Effect.fail(
                new AdapterError({
                  message: "Could not fetch token prices",
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

            let totalXAmount = new BN(
              Math.floor((halfUsd / priceX) * Math.pow(10, tokenXDecimals)),
            );
            let totalYAmount = new BN(
              Math.floor((halfUsd / priceY) * Math.pow(10, tokenYDecimals)),
            );

            // Check balances
            const balanceX = yield* getTokenBalance(pool.tokenX);
            const balanceY = yield* getTokenBalance(pool.tokenY);
            let nativeSolBalance = 0n;
            if (pool.tokenX === SOL_MINT || pool.tokenY === SOL_MINT) {
              nativeSolBalance = BigInt(
                yield* Effect.tryPromise(() => connection.getBalance(wallet.publicKey)),
              );
            }

            const maxX = pool.tokenX === SOL_MINT ? nativeSolBalance : balanceX;
            if (BigInt(totalXAmount.toString()) > maxX) {
              totalXAmount = new BN(maxX.toString());
            }

            const maxY = pool.tokenY === SOL_MINT ? nativeSolBalance : balanceY;
            if (BigInt(totalYAmount.toString()) > maxY) {
              totalYAmount = new BN(maxY.toString());
            }

            if (totalXAmount.eq(new BN(0)) || totalYAmount.eq(new BN(0))) {
              return yield* Effect.fail(
                new AdapterError({
                  message: "Insufficient token balance",
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
            const { blockhash } = yield* Effect.tryPromise(() => connection.getLatestBlockhash());
            tx.recentBlockhash = blockhash;
            tx.sign(wallet, positionKeypair);

            const signature = yield* Effect.tryPromise(() =>
              connection.sendRawTransaction(tx.serialize(), {
                skipPreflight: false,
                preflightCommitment: "confirmed",
              }),
            );

            yield* Effect.tryPromise(() => connection.confirmTransaction(signature, "confirmed"));

            return {
              positionPubKey: positionKeypair.publicKey.toBase58(),
              txSignature: signature,
            };
          } catch (err) {
            return yield* Effect.fail(
              new AdapterError({
                message: `Failed to enter position: ${String(err)}`,
                poolAddress,
                cause: err,
              }),
            );
          }
        }),

      exitPosition: (poolAddress, positionPubKey) =>
        Effect.gen(function* () {
          if (!wallet) {
            return yield* Effect.fail(
              new AdapterError({
                message: "No wallet configured",
              }),
            );
          }

          try {
            const poolPubkey = new PublicKey(poolAddress);
            const positionPubkey = new PublicKey(positionPubKey);
            const dlmm = yield* Effect.tryPromise(() => DLMM.create(connection, poolPubkey));

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
              const { blockhash } = yield* Effect.tryPromise(() => connection.getLatestBlockhash());
              tx.feePayer = wallet.publicKey;
              tx.recentBlockhash = blockhash;
              tx.sign(wallet);

              const signature = yield* Effect.tryPromise(() =>
                connection.sendRawTransaction(tx.serialize(), {
                  skipPreflight: false,
                  preflightCommitment: "confirmed",
                }),
              );
              yield* Effect.tryPromise(() => connection.confirmTransaction(signature, "confirmed"));
            }

            return { txSignature: "batch-confirmed" };
          } catch (err) {
            return yield* Effect.fail(
              new AdapterError({
                message: `Failed to exit position: ${String(err)}`,
                poolAddress,
                cause: err,
              }),
            );
          }
        }),

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

      claimFees: (poolAddress, positionPubKey, platformFeeRate) =>
        Effect.gen(function* () {
          if (!wallet) {
            return yield* Effect.fail(
              new AdapterError({
                message: "No wallet configured",
              }),
            );
          }

          try {
            const poolPubkey = new PublicKey(poolAddress);
            const positionPubkey = new PublicKey(positionPubKey);
            const dlmm = yield* Effect.tryPromise(() => DLMM.create(connection, poolPubkey));

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

            let lastSignature = "";
            for (const tx of txs) {
              const { blockhash } = yield* Effect.tryPromise(() => connection.getLatestBlockhash());
              tx.feePayer = wallet.publicKey;
              tx.recentBlockhash = blockhash;
              tx.sign(wallet);

              const signature = yield* Effect.tryPromise(() =>
                connection.sendRawTransaction(tx.serialize(), {
                  skipPreflight: false,
                  preflightCommitment: "confirmed",
                }),
              );
              yield* Effect.tryPromise(() => connection.confirmTransaction(signature, "confirmed"));
              lastSignature = signature;
            }

            const feeWallet = yield* fetchFeeWalletAddress();
            const operatorWalletAddress = wallet.publicKey.toBase58();
            const revenueShare = calculateRevenueShare(
              feeX,
              feeY,
              platformFeeRate,
              config.revenueShareEnabled,
              config.revenueShareOperatorPct,
              feeWallet,
              operatorWalletAddress,
            );
            let feeTransferTxSignature: string | undefined;
            let actualPlatformFeeX = 0;
            let actualPlatformFeeY = 0;
            let actualOperatorFeeX = 0;
            let actualOperatorFeeY = 0;

            if (revenueShare.platformFeeX > 0 || revenueShare.platformFeeY > 0) {
              if (revenueShare.isCircular) {
                logger.info(
                  "Circular wallet detected — fees retained by operator",
                  { pool: poolAddress, platformFeeX: revenueShare.platformFeeX, platformFeeY: revenueShare.platformFeeY },
                );
                actualOperatorFeeX = revenueShare.platformFeeX;
                actualOperatorFeeY = revenueShare.platformFeeY;
              } else if (feeWallet) {
                const transferResult = yield* Effect.gen(function* () {
                  const feeWalletPubkey = new PublicKey(feeWallet);
                  const tokenXMint = dlmm.lbPair.tokenXMint as PublicKey;
                  const tokenYMint = dlmm.lbPair.tokenYMint as PublicKey;
                  const { blockhash } = yield* Effect.tryPromise(() =>
                    connection.getLatestBlockhash(),
                  );
                  const transferTx = new Transaction();
                  transferTx.feePayer = wallet.publicKey;
                  transferTx.recentBlockhash = blockhash;

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
                      connection.getAccountInfo(toAta),
                    );
                    if (!toAtaInfo) {
                      transferTx.add(
                        createAssociatedTokenAccountInstruction(
                          wallet!.publicKey,
                          toAta,
                          feeWalletPubkey,
                          mint,
                        ),
                      );
                    }
                    transferTx.add(
                      createTransferInstruction(
                        fromAta,
                        toAta,
                        wallet!.publicKey,
                        BigInt(Math.floor(amount)),
                      ),
                    );
                  }

                  if (transferTx.instructions.length === 0) {
                    logger.info("No platform fee to transfer — operator keeps full share", {
                      pool: poolAddress,
                    });
                    return undefined;
                  }

                  transferTx.sign(wallet!);
                  const sig = yield* Effect.tryPromise(() =>
                    connection.sendRawTransaction(transferTx.serialize(), {
                      skipPreflight: false,
                    }),
                  );
                  yield* Effect.tryPromise(() => connection.confirmTransaction(sig, "confirmed"));
                  return sig;
                }).pipe(
                  Effect.catchAll((err) => {
                    logger.error("Platform fee transfer failed (fees retained by user)", {
                      pool: poolAddress,
                      platformFeeX: revenueShare.platformFeeX,
                      platformFeeY: revenueShare.platformFeeY,
                      error: String(err),
                    });
                    return Effect.succeed(undefined);
                  }),
                );
                if (transferResult !== undefined) {
                  feeTransferTxSignature = transferResult;
                  actualPlatformFeeX = revenueShare.amountToTransferX;
                  actualPlatformFeeY = revenueShare.amountToTransferY;
                  actualOperatorFeeX = revenueShare.operatorFeeX;
                  actualOperatorFeeY = revenueShare.operatorFeeY;
                } else if (revenueShare.amountToTransferX === 0 && revenueShare.amountToTransferY === 0) {
                  actualOperatorFeeX = revenueShare.operatorFeeX;
                  actualOperatorFeeY = revenueShare.operatorFeeY;
                }
              } else {
                logger.warn("No fee wallet configured — skipping platform fee transfer", {
                  pool: poolAddress,
                });
              }
            }

            return {
              txSignature: lastSignature,
              feeX,
              feeY,
              platformFeeX: actualPlatformFeeX,
              platformFeeY: actualPlatformFeeY,
              netFeeX: revenueShare.netFeeX,
              netFeeY: revenueShare.netFeeY,
              ...(feeTransferTxSignature !== undefined ? { feeTransferTxSignature } : {}),
              ...(actualOperatorFeeX > 0 || actualOperatorFeeY > 0
                ? { operatorFeeX: actualOperatorFeeX, operatorFeeY: actualOperatorFeeY }
                : {}),
            };
          } catch (err) {
            return yield* Effect.fail(
              new AdapterError({
                message: `Failed to claim fees: ${String(err)}`,
                poolAddress,
                cause: err,
              }),
            );
          }
        }),

      reportFeeCollection(event) {
        void (async () => {
          try {
            const installId = getOrCreateInstallId();
            const res = await fetch(`${FEE_WALLET_API_URL}/v1/revenue/log`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
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
          const res = yield* Effect.tryPromise(() => fetch("https://dlmm-api.meteora.ag/pair/all"));
          const pairs = (yield* Effect.tryPromise(() => res.json())) as ReadonlyArray<{
            address: string;
            bin_step: number;
            base_mint: string;
            quote_mint: string;
            tvl: number;
            volume_24h: number;
            fees_24h: number;
            apr: number;
          }>;

          return pairs
            .filter((p) => p.tvl >= config.discoveryMinTvlUsd)
            .map((p) => ({
              address: p.address,
              tvlUsd: p.tvl,
              volume24hUsd: p.volume_24h,
              fees24hUsd: p.fees_24h,
              apr: p.apr,
              binStep: p.bin_step,
              tokenX: p.base_mint,
              tokenY: p.quote_mint,
            }))
            .slice(0, 50);
        }).pipe(Effect.catchAll(() => Effect.succeed([]))),

      swapUSDCForSOL: (minSolThreshold = 0.05, swapAmountUSDC = 1.0) =>
        Effect.gen(function* () {
          if (!wallet) return;

          const lamports = yield* Effect.tryPromise(() => connection.getBalance(wallet!.publicKey));
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
              connection.sendRawTransaction(swapTx.serialize(), {
                skipPreflight: false,
                preflightCommitment: "confirmed",
              }),
            );

            yield* Effect.tryPromise(() => connection.confirmTransaction(sig, "confirmed"));
            logger.info("Swapped USDC → SOL for gas", { tx: sig, amountUSDC: swapAmountUSDC });
          } catch (err) {
            logger.warn("USDC → SOL swap failed (non-fatal):", String(err));
          }
        }).pipe(Effect.catchAll(() => Effect.void)),
    };

    return api;

    function getTokenBalance(mintAddress: string): Effect.Effect<bigint, unknown> {
      if (!wallet) return Effect.succeed(0n);
      return Effect.gen(function* () {
        const mint = new PublicKey(mintAddress);
        const accounts = yield* Effect.tryPromise(() =>
          connection.getTokenAccountsByOwner(wallet!.publicKey, { mint }),
        );
        const firstAccount = accounts.value[0];
        if (!firstAccount) return 0n;
        const bal = yield* Effect.tryPromise(() =>
          connection.getTokenAccountBalance(firstAccount.pubkey),
        );
        return BigInt(bal.value.amount);
      }).pipe(Effect.catchAll(() => Effect.succeed(0n)));
    }
  }),
);
