import { Effect, Layer } from "effect";
import { AdapterService, EntryPrepService, type EntryPrepApi } from "./services.js";
import { ConfigService } from "./config-service.js";
import { EntryPrepError, SwapQuoteError } from "./errors.js";
import { createLogger } from "./logger.js";
import {
  SOL_MINT,
  USDC_MINT,
  GAS_RESERVE_LAMPORTS,
  SOL_ENTRY_TRANSACTION_BUFFER_LAMPORTS,
  GAS_TOP_UP_USDC,
  SOL_GAS_TOP_UP_THRESHOLD_LAMPORTS,
  MIN_SOL_FOR_GAS_LAMPORTS,
} from "./constants.js";

const logger = createLogger("entry-prep-service");
const USDC_DECIMALS = 6;
const FIXED_POINT_SCALE = 12;

function formatAtomic(amount: bigint, decimals: number): string {
  if (decimals <= 0) return amount.toString();
  const sign = amount < 0n ? "-" : "";
  const absAmount = amount < 0n ? -amount : amount;
  const divisor = 10n ** BigInt(decimals);
  const whole = (absAmount / divisor).toString();
  const frac = (absAmount % divisor).toString().padStart(decimals, "0");
  const precision = Math.min(decimals, 6);
  const trimmed = frac.slice(0, precision).replace(/0+$/, "");
  return trimmed ? `${sign}${whole}.${trimmed}` : `${sign}${whole}`;
}

function numberToScaledBigInt(value: number): bigint {
  const sign = value < 0 ? "-" : "";
  const absValue = Math.abs(value);
  const [whole, frac = ""] = absValue.toFixed(FIXED_POINT_SCALE).split(".");
  return BigInt(`${sign}${whole}${frac.padEnd(FIXED_POINT_SCALE, "0")}`);
}

function isValidDecimals(decimals: number): boolean {
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= 255;
}

export function computeRequiredAtomic(halfUsd: number, price: number, decimals: number): bigint {
  if (halfUsd <= 0 || price <= 0 || !isValidDecimals(decimals)) return 0n;
  const usdScaled = numberToScaledBigInt(halfUsd);
  const priceScaled = numberToScaledBigInt(price);
  if (priceScaled === 0n) return 0n;
  return (usdScaled * 10n ** BigInt(decimals)) / priceScaled;
}

export function computeUsdcInputAtomic(amount: bigint, decimals: number, price: number): bigint {
  if (!isValidDecimals(decimals)) return 0n;
  // Scale the floating price to a fixed-point integer without converting `amount` to Number.
  const priceScaled = numberToScaledBigInt(price);
  if (priceScaled === 0n) return 0n;
  const numerator = amount * priceScaled * 10n ** BigInt(USDC_DECIMALS) * 101n; // 1% buffer as 101/100
  const denominator = 10n ** BigInt(decimals) * 100n * 10n ** BigInt(FIXED_POINT_SCALE);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder === 0n ? quotient : quotient + 1n;
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

function isSwapQuoteError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { _tag?: string })._tag === "SwapQuoteError") return true;
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null) return false;
  return (cause as { _tag?: string })._tag === "SwapQuoteError";
}

function parseAtomicAmount(value: unknown): bigint | null {
  if (typeof value === "string") {
    // Jupiter returns atomic amounts as non-negative integer strings. Reject
    // empty, non-integer, or negative strings so malformed quotes cannot throw
    // during BigInt conversion.
    if (!/^\d+$/.test(value)) return null;
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return BigInt(Math.floor(value));
  }
  return null;
}

function quoteOutAmount(quoteData: Record<string, unknown>): bigint {
  return parseAtomicAmount(quoteData.outAmount) ?? 0n;
}

function quoteGuaranteedOutAmount(quoteData: Record<string, unknown>): bigint {
  // Jupiter's `otherAmountThreshold` is the minimum output guaranteed at the
  // quoted slippage; prefer it over the optimistic `outAmount` so a swap is
  // only submitted when it can actually cover the deficit after slippage.
  const threshold = parseAtomicAmount(quoteData.otherAmountThreshold);
  if (threshold !== null) return threshold;
  return quoteOutAmount(quoteData);
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

          for (const [mint, decimals] of [
            [pool.tokenX, tokenXDecimals],
            [pool.tokenY, tokenYDecimals],
          ] as const) {
            if (!isValidDecimals(decimals)) {
              return yield* Effect.fail(
                makePrepError(
                  "PRICE_UNAVAILABLE",
                  `Invalid decimals for ${mint}: ${decimals}`,
                  poolAddress,
                ),
              );
            }
          }

          const priceX = prices[pool.tokenX] ?? 0;
          const priceY = prices[pool.tokenY] ?? 0;
          if (!Number.isFinite(priceX) || priceX <= 0 || !Number.isFinite(priceY) || priceY <= 0) {
            return yield* Effect.fail(
              makePrepError(
                "PRICE_UNAVAILABLE",
                `Invalid or missing price for pool tokens: ${pool.tokenX}=${priceX}, ${pool.tokenY}=${priceY}`,
                poolAddress,
              ),
            );
          }

          const halfUsd = positionSizeUsd / 2;

          const requiredX =
            computeRequiredAtomic(halfUsd, priceX, tokenXDecimals) +
            (pool.tokenX === SOL_MINT ? SOL_ENTRY_TRANSACTION_BUFFER_LAMPORTS : 0n);
          const requiredY =
            computeRequiredAtomic(halfUsd, priceY, tokenYDecimals) +
            (pool.tokenY === SOL_MINT ? SOL_ENTRY_TRANSACTION_BUFFER_LAMPORTS : 0n);

          if (requiredX === 0n || requiredY === 0n) {
            return yield* Effect.fail(
              makePrepError(
                "PRICE_UNAVAILABLE",
                `Token price too small or position size too small to produce a non-zero requirement for pool tokens: ${pool.tokenX}=${priceX}, ${pool.tokenY}=${priceY}`,
                poolAddress,
              ),
            );
          }

          const readTokenBalance = (mint: string) =>
            adapter
              .getTokenBalance(mint)
              .pipe(
                Effect.mapError((err) =>
                  makePrepError(
                    "BALANCE_READ_FAILED",
                    `Failed to read balance for ${mint}: ${String(err)}`,
                    poolAddress,
                    err,
                  ),
                ),
              );

          const readNativeSolBalance = () =>
            adapter
              .getNativeSolBalance()
              .pipe(
                Effect.mapError((err) =>
                  makePrepError(
                    "BALANCE_READ_FAILED",
                    `Failed to read native SOL balance: ${String(err)}`,
                    poolAddress,
                    err,
                  ),
                ),
              );

          const poolNeedsSol = pool.tokenX === SOL_MINT || pool.tokenY === SOL_MINT;
          const nativeSolLamports = yield* readNativeSolBalance();

          const balanceX =
            pool.tokenX === SOL_MINT ? nativeSolLamports : yield* readTokenBalance(pool.tokenX);
          const balanceY =
            pool.tokenY === SOL_MINT ? nativeSolLamports : yield* readTokenBalance(pool.tokenY);

          const availableX =
            pool.tokenX === SOL_MINT
              ? balanceX > GAS_RESERVE_LAMPORTS
                ? balanceX - GAS_RESERVE_LAMPORTS
                : 0n
              : balanceX;
          const availableY =
            pool.tokenY === SOL_MINT
              ? balanceY > GAS_RESERVE_LAMPORTS
                ? balanceY - GAS_RESERVE_LAMPORTS
                : 0n
              : balanceY;

          // Single-sided precedence (Wave 7): when exactly one leg cannot fund
          // its half and the other leg alone covers a full-size single-sided
          // deposit, skip the USDC auto-swap entirely — the adapter's
          // enterPosition executes the native single-sided deposit instead
          // (no swap slippage, works even when the missing leg is USDC
          // itself). The auto-swap path below remains the fallback for every
          // other deficit shape.
          const xLegShort = requiredX > availableX;
          const yLegShort = requiredY > availableY;
          if (xLegShort !== yLegShort) {
            const heldIsX = yLegShort;
            const heldMint = heldIsX ? pool.tokenX : pool.tokenY;
            const heldDecimals = heldIsX ? tokenXDecimals : tokenYDecimals;
            const heldPrice = heldIsX ? priceX : priceY;
            const heldAvailable = heldIsX ? availableX : availableY;
            const fullSizeRequired =
              computeRequiredAtomic(positionSizeUsd, heldPrice, heldDecimals) +
              (heldMint === SOL_MINT ? SOL_ENTRY_TRANSACTION_BUFFER_LAMPORTS : 0n);
            if (fullSizeRequired > 0n && heldAvailable >= fullSizeRequired) {
              logger.info(
                "Single-sided native deposit preferred over USDC auto-swap (held leg covers the full size)",
                {
                  poolAddress,
                  heldMint,
                  heldAvailable: formatAtomic(heldAvailable, heldDecimals),
                  fullSizeRequired: formatAtomic(fullSizeRequired, heldDecimals),
                },
              );
              return;
            }
          }

          const deficits: Array<{
            mint: string;
            amount: bigint;
            decimals: number;
            price: number;
          }> = [];
          if (requiredX > availableX) {
            if (pool.tokenX === USDC_MINT) {
              return yield* Effect.fail(
                makePrepError(
                  "INSUFFICIENT_USDC_BALANCE",
                  `Wallet USDC balance ${formatAtomic(availableX, USDC_DECIMALS)} is less than required ${formatAtomic(requiredX, USDC_DECIMALS)} for pool token X`,
                  poolAddress,
                ),
              );
            }
            deficits.push({
              mint: pool.tokenX,
              amount: requiredX - availableX,
              decimals: tokenXDecimals,
              price: priceX,
            });
          }
          if (requiredY > availableY) {
            if (pool.tokenY === USDC_MINT) {
              return yield* Effect.fail(
                makePrepError(
                  "INSUFFICIENT_USDC_BALANCE",
                  `Wallet USDC balance ${formatAtomic(availableY, USDC_DECIMALS)} is less than required ${formatAtomic(requiredY, USDC_DECIMALS)} for pool token Y`,
                  poolAddress,
                ),
              );
            }
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

          const usdcBalance = yield* readTokenBalance(USDC_MINT);
          const totalUsdcInputAtomic = deficits.reduce(
            (sum, deficit) =>
              sum + computeUsdcInputAtomic(deficit.amount, deficit.decimals, deficit.price),
            0n,
          );

          const requiredUsdcPoolLeg =
            (pool.tokenX === USDC_MINT ? requiredX : 0n) +
            (pool.tokenY === USDC_MINT ? requiredY : 0n);
          const needsGasTopUp = nativeSolLamports < SOL_GAS_TOP_UP_THRESHOLD_LAMPORTS;
          const gasTopUpAtomic = needsGasTopUp
            ? BigInt(GAS_TOP_UP_USDC) * 10n ** BigInt(USDC_DECIMALS)
            : 0n;
          const totalUsdcRequired = totalUsdcInputAtomic + requiredUsdcPoolLeg + gasTopUpAtomic;

          if (usdcBalance < totalUsdcRequired) {
            const gasNote = needsGasTopUp ? " + gas top-up" : "";
            return yield* Effect.fail(
              makePrepError(
                "INSUFFICIENT_USDC_BALANCE",
                `Wallet USDC balance ${formatAtomic(usdcBalance, USDC_DECIMALS)} is less than required ${formatAtomic(totalUsdcRequired, USDC_DECIMALS)} for auto-swap entry (swaps + USDC pool leg${gasNote})`,
                poolAddress,
              ),
            );
          }

          logger.info("Auto-swapping USDC for missing pool tokens", {
            poolAddress,
            totalUsdcInput: formatAtomic(totalUsdcInputAtomic, USDC_DECIMALS),
            deficits: deficits.map((d) => ({
              mint: d.mint,
              amount: formatAtomic(d.amount, d.decimals),
            })),
          });

          // Preflight every swap quote before submitting any transaction. This
          // prevents partial preparation where one leg is swapped successfully
          // and then a quote failure on the other leg leaves the wallet altered.
          const quoteResults = yield* Effect.all(
            deficits.map((deficit) => {
              const usdcInputAtomic = computeUsdcInputAtomic(
                deficit.amount,
                deficit.decimals,
                deficit.price,
              );
              if (usdcInputAtomic <= 0n) {
                return Effect.fail(
                  makePrepError(
                    "SWAP_QUOTE_FAILED",
                    `Computed USDC input too small for ${deficit.mint}`,
                    poolAddress,
                  ),
                );
              }
              return adapter.quoteSwapUSDCForToken(deficit.mint, usdcInputAtomic).pipe(
                Effect.mapError((err) =>
                  makePrepError(
                    "SWAP_QUOTE_FAILED",
                    `Failed to quote swap USDC -> ${deficit.mint}: ${String(err)}`,
                    poolAddress,
                    err,
                  ),
                ),
                Effect.flatMap((quoteData) => {
                  const outAmount = quoteGuaranteedOutAmount(quoteData);
                  if (outAmount < deficit.amount) {
                    return Effect.fail(
                      makePrepError(
                        "SWAP_QUOTE_FAILED",
                        `Quoted output for ${deficit.mint} (${formatAtomic(outAmount, deficit.decimals)}) is less than required deficit (${formatAtomic(deficit.amount, deficit.decimals)})`,
                        poolAddress,
                      ),
                    );
                  }
                  return Effect.succeed({ deficit, quoteData });
                }),
              );
            }),
            { concurrency: "unbounded" },
          );
          const preflightedQuotes = new Map(
            quoteResults.map(({ deficit, quoteData }) => [deficit.mint, quoteData]),
          );

          let swapped = false;
          for (const deficit of deficits) {
            const usdcInputAtomic = computeUsdcInputAtomic(
              deficit.amount,
              deficit.decimals,
              deficit.price,
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

            const quoteData = preflightedQuotes.get(deficit.mint);
            const txSig = yield* adapter
              .swapUSDCForToken(deficit.mint, usdcInputAtomic, quoteData)
              .pipe(
                Effect.mapError((err) => {
                  if (isSwapQuoteError(err)) {
                    return makePrepError(
                      "SWAP_QUOTE_FAILED",
                      `Failed to quote swap USDC -> ${deficit.mint}: ${String(err)}`,
                      poolAddress,
                      err,
                    );
                  }
                  return makePrepError(
                    "SWAP_TRANSACTION_FAILED",
                    `Failed to swap USDC -> ${deficit.mint}: ${String(err)}`,
                    poolAddress,
                    err,
                  );
                }),
              );

            swapped = true;
            logger.info("Swapped USDC for pool token", {
              poolAddress,
              mint: deficit.mint,
              usdcInput: formatAtomic(usdcInputAtomic, USDC_DECIMALS),
              tx: txSig,
            });
          }

          const nativeSolAfter = swapped ? yield* readNativeSolBalance() : 0n;
          const balanceXAfter =
            pool.tokenX === SOL_MINT ? nativeSolAfter : yield* readTokenBalance(pool.tokenX);
          const balanceYAfter =
            pool.tokenY === SOL_MINT ? nativeSolAfter : yield* readTokenBalance(pool.tokenY);

          // For SOL legs, requiredX/Y already include SOL_ENTRY_TRANSACTION_BUFFER_LAMPORTS,
          // so compare the raw post-swap balance against the buffered requirement.
          // Re-subtracting GAS_RESERVE_LAMPORTS here would double-count the reserve.
          if (balanceXAfter < requiredX || balanceYAfter < requiredY) {
            return yield* Effect.fail(
              makePrepError(
                "INSUFFICIENT_BALANCE_AFTER_SWAP",
                `Balances still insufficient after swap: X=${formatAtomic(balanceXAfter, tokenXDecimals)}/${formatAtomic(requiredX, tokenXDecimals)}, Y=${formatAtomic(balanceYAfter, tokenYDecimals)}/${formatAtomic(requiredY, tokenYDecimals)}`,
                poolAddress,
              ),
            );
          }

          // Swaps consumed native SOL fees; ensure the wallet still has enough
          // gas for the final enterPosition transaction. Use the same threshold
          // as the live entry gate so the two checks stay aligned.
          if (swapped && nativeSolAfter < MIN_SOL_FOR_GAS_LAMPORTS) {
            return yield* Effect.fail(
              makePrepError(
                "INSUFFICIENT_BALANCE_AFTER_SWAP",
                `Native SOL balance ${formatAtomic(nativeSolAfter, 9)} is below minimum ${formatAtomic(MIN_SOL_FOR_GAS_LAMPORTS, 9)} required for gas after swap`,
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
