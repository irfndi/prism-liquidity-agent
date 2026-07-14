import { Effect, Layer } from "effect";
import { AdapterService, EntryPrepService, type EntryPrepApi } from "./services.js";
import { ConfigService } from "./config-service.js";
import { EntryPrepError } from "./errors.js";
import { createLogger } from "./logger.js";
import { BN } from "@coral-xyz/anchor";

const logger = createLogger("entry-prep-service");
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DECIMALS = 6;
const GAS_RESERVE_LAMPORTS = 20_000_000n;
const SWAP_INPUT_BUFFER_PCT = 1.01; // 1% buffer to cover fees/slippage

function formatAtomic(amount: bigint, decimals: number): string {
  return (Number(amount) / 10 ** decimals).toFixed(Math.min(decimals, 6));
}

function makePrepError(
  code: EntryPrepError["code"],
  message: string,
  poolAddress: string,
  cause?: unknown,
): EntryPrepError {
  return new EntryPrepError({
    code,
    message: `[${code}] ${message}`,
    poolAddress,
    cause,
  });
}

export const EntryPrepLive = Layer.effect(
  EntryPrepService,
  Effect.gen(function* () {
    const adapter = yield* AdapterService;
    const config = yield* ConfigService;

    const api: EntryPrepApi = {
      prepareEntryTokens: (poolAddress, positionSizeUsd) =>
        Effect.gen(function* () {
          if (!config.autoSwapEntry) {
            return;
          }

          if (!adapter.hasWallet()) {
            return yield* Effect.fail(
              makePrepError("NO_WALLET", "No wallet configured for auto-swap entry", poolAddress),
            );
          }

          const pool = yield* adapter
            .getPoolState(poolAddress)
            .pipe(
              Effect.mapError((err) =>
                makePrepError(
                  "PRICE_UNAVAILABLE",
                  `Failed to fetch pool state: ${String(err)}`,
                  poolAddress,
                  err,
                ),
              ),
            );

          const [prices, tokenXDecimals, tokenYDecimals] = yield* Effect.all(
            [
              adapter
                .getTokenPrices([pool.tokenX, pool.tokenY])
                .pipe(
                  Effect.mapError((err) =>
                    makePrepError(
                      "PRICE_UNAVAILABLE",
                      `Failed to fetch token prices: ${String(err)}`,
                      poolAddress,
                      err,
                    ),
                  ),
                ),
              adapter
                .getTokenDecimals(pool.tokenX)
                .pipe(
                  Effect.mapError((err) =>
                    makePrepError(
                      "PRICE_UNAVAILABLE",
                      `Failed to fetch decimals for ${pool.tokenX}: ${String(err)}`,
                      poolAddress,
                      err,
                    ),
                  ),
                ),
              adapter
                .getTokenDecimals(pool.tokenY)
                .pipe(
                  Effect.mapError((err) =>
                    makePrepError(
                      "PRICE_UNAVAILABLE",
                      `Failed to fetch decimals for ${pool.tokenY}: ${String(err)}`,
                      poolAddress,
                      err,
                    ),
                  ),
                ),
            ],
            { concurrency: "unbounded" },
          );

          const priceX = prices[pool.tokenX] ?? 0;
          const priceY = prices[pool.tokenY] ?? 0;
          if (!priceX || !priceY) {
            return yield* Effect.fail(
              makePrepError(
                "PRICE_UNAVAILABLE",
                `Missing price for pool tokens: ${pool.tokenX}=${priceX}, ${pool.tokenY}=${priceY}`,
                poolAddress,
              ),
            );
          }

          const halfUsd = positionSizeUsd / 2;

          const requiredX = BigInt(
            new BN(Math.floor((halfUsd / priceX) * 10 ** tokenXDecimals)).toString(),
          );
          const requiredY = BigInt(
            new BN(Math.floor((halfUsd / priceY) * 10 ** tokenYDecimals)).toString(),
          );

          const readTokenBalance = (mint: string) =>
            adapter
              .getTokenBalance(mint)
              .pipe(
                Effect.mapError((err) =>
                  makePrepError(
                    "INSUFFICIENT_BALANCE_AFTER_SWAP",
                    `Failed to read balance for ${mint}: ${String(err)}`,
                    poolAddress,
                    err,
                  ),
                ),
              );

          const nativeSolLamports = yield* adapter
            .getNativeSolBalance()
            .pipe(Effect.catchAll(() => Effect.succeed(0n)));

          const balanceX =
            pool.tokenX === SOL_MINT ? nativeSolLamports : yield* readTokenBalance(pool.tokenX);
          const balanceY =
            pool.tokenY === SOL_MINT ? nativeSolLamports : yield* readTokenBalance(pool.tokenY);

          const availableX =
            pool.tokenX === SOL_MINT && balanceX > GAS_RESERVE_LAMPORTS
              ? balanceX - GAS_RESERVE_LAMPORTS
              : balanceX;
          const availableY =
            pool.tokenY === SOL_MINT && balanceY > GAS_RESERVE_LAMPORTS
              ? balanceY - GAS_RESERVE_LAMPORTS
              : balanceY;

          const deficits: Array<{
            mint: string;
            amount: bigint;
            decimals: number;
            price: number;
          }> = [];
          if (requiredX > availableX) {
            deficits.push({
              mint: pool.tokenX,
              amount: requiredX - availableX,
              decimals: tokenXDecimals,
              price: priceX,
            });
          }
          if (requiredY > availableY) {
            deficits.push({
              mint: pool.tokenY,
              amount: requiredY - availableY,
              decimals: tokenYDecimals,
              price: priceY,
            });
          }

          if (deficits.length === 0) {
            logger.info("Pool token balances sufficient for entry", { poolAddress });
            return;
          }

          logger.info("Auto-swapping USDC for missing pool tokens", {
            poolAddress,
            deficits: deficits.map((d) => ({
              mint: d.mint,
              amount: formatAtomic(d.amount, d.decimals),
            })),
          });

          for (const deficit of deficits) {
            const usdcInputAtomic = BigInt(
              Math.ceil(
                ((Number(deficit.amount) * deficit.price * 10 ** USDC_DECIMALS) /
                  10 ** deficit.decimals) *
                  SWAP_INPUT_BUFFER_PCT,
              ),
            );

            if (usdcInputAtomic <= 0n) {
              return yield* Effect.fail(
                makePrepError(
                  "SWAP_QUOTE_FAILED",
                  `Computed USDC input too small for ${deficit.mint}`,
                  poolAddress,
                ),
              );
            }

            const txSig = yield* adapter
              .swapUSDCForToken(deficit.mint, usdcInputAtomic)
              .pipe(
                Effect.mapError((err) =>
                  makePrepError(
                    "SWAP_TRANSACTION_FAILED",
                    `Failed to swap USDC -> ${deficit.mint}: ${String(err)}`,
                    poolAddress,
                    err,
                  ),
                ),
              );

            logger.info("Swapped USDC for pool token", {
              poolAddress,
              mint: deficit.mint,
              usdcInput: formatAtomic(usdcInputAtomic, USDC_DECIMALS),
              tx: txSig,
            });
          }

          const nativeSolAfter = yield* adapter
            .getNativeSolBalance()
            .pipe(Effect.catchAll(() => Effect.succeed(0n)));
          const balanceXAfter =
            pool.tokenX === SOL_MINT ? nativeSolAfter : yield* readTokenBalance(pool.tokenX);
          const balanceYAfter =
            pool.tokenY === SOL_MINT ? nativeSolAfter : yield* readTokenBalance(pool.tokenY);

          const availableXAfter =
            pool.tokenX === SOL_MINT && balanceXAfter > GAS_RESERVE_LAMPORTS
              ? balanceXAfter - GAS_RESERVE_LAMPORTS
              : balanceXAfter;
          const availableYAfter =
            pool.tokenY === SOL_MINT && balanceYAfter > GAS_RESERVE_LAMPORTS
              ? balanceYAfter - GAS_RESERVE_LAMPORTS
              : balanceYAfter;

          if (availableXAfter < requiredX || availableYAfter < requiredY) {
            return yield* Effect.fail(
              makePrepError(
                "INSUFFICIENT_BALANCE_AFTER_SWAP",
                `Balances still insufficient after swap: X=${formatAtomic(availableXAfter, tokenXDecimals)}/${formatAtomic(requiredX, tokenXDecimals)}, Y=${formatAtomic(availableYAfter, tokenYDecimals)}/${formatAtomic(requiredY, tokenYDecimals)}`,
                poolAddress,
              ),
            );
          }

          logger.info("Entry token preparation complete", { poolAddress });
        }).pipe(Effect.asVoid),
    };

    return api;
  }),
);
