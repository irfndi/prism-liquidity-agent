import { Effect, Layer } from "effect";
import {
  AdapterService,
  DbService,
  EntryPrepService,
  type EntryPreparationOutcome,
  type EntryPreparationReceipt,
  type EntryPrepApi,
} from "./services.js";
import { ConfigService } from "./config-service.js";
import { EntryPrepError } from "./errors.js";
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

/** Converts a USD leg requirement into the smallest token unit without floating-point division. */
export function computeRequiredAtomic(halfUsd: number, price: number, decimals: number): bigint {
  if (halfUsd <= 0 || price <= 0 || !isValidDecimals(decimals)) return 0n;
  const usdScaled = numberToScaledBigInt(halfUsd);
  const priceScaled = numberToScaledBigInt(price);
  if (priceScaled === 0n) return 0n;
  return (usdScaled * 10n ** BigInt(decimals)) / priceScaled;
}

/** Computes the buffered USDC input needed to acquire a token amount. */
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

/** Computes the buffered input amount needed for a priced token-to-token swap. */
export function computeSwapInputAtomic(
  outputAmount: bigint,
  outputDecimals: number,
  outputPriceUsd: number,
  inputDecimals: number,
  inputPriceUsd: number,
): bigint {
  if (
    !isValidDecimals(outputDecimals) ||
    !isValidDecimals(inputDecimals) ||
    outputPriceUsd <= 0 ||
    inputPriceUsd <= 0
  ) {
    return 0n;
  }
  const outputPriceScaled = numberToScaledBigInt(outputPriceUsd);
  const inputPriceScaled = numberToScaledBigInt(inputPriceUsd);
  if (outputPriceScaled <= 0n || inputPriceScaled <= 0n) return 0n;
  const numerator = outputAmount * outputPriceScaled * 10n ** BigInt(inputDecimals) * 101n;
  const denominator = 10n ** BigInt(outputDecimals) * inputPriceScaled * 100n;
  const quotient = numerator / denominator;
  return numerator % denominator === 0n ? quotient : quotient + 1n;
}

/** Owner contract for the options passed to the EntryPrepError constructor. */
interface EntryPrepOptions {
  code: EntryPrepError["code"];
  message: string;
  poolAddress: string;
  cause?: unknown;
  partialPreparation?: EntryPreparationOutcome;
}

function makePrepError(
  code: EntryPrepError["code"],
  message: string,
  poolAddress: string,
  cause?: unknown,
  partialPreparation?: EntryPreparationOutcome,
): EntryPrepError {
  const options: EntryPrepOptions = {
    code,
    message: `[${code}] ${message}`,
    poolAddress,
    cause,
  };
  if (partialPreparation !== undefined) {
    options.partialPreparation = partialPreparation;
  }
  return new EntryPrepError(options);
}

function isNonNullObject<T>(value: T): boolean {
  return value !== null && value instanceof Object && !(value instanceof Function);
}

/** The subset of a Jupiter swap quote the deficit checks read. */
interface SwapQuoteData {
  readonly outAmount?: unknown;
  readonly otherAmountThreshold?: unknown;
}

function isSwapQuoteError<T>(err: T): boolean {
  if (!isNonNullObject(err)) return false;
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  if ((err as { _tag?: string })._tag === "SwapQuoteError") return true;
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  const cause = (err as { cause?: unknown }).cause;
  if (!isNonNullObject(cause)) return false;
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  return (cause as { _tag?: string })._tag === "SwapQuoteError";
}

function parseAtomicAmount<T>(value: T): bigint | null {
  if (Object.prototype.toString.call(value) === "[object String]") {
    // Jupiter returns atomic amounts as non-negative integer strings. Reject
    // empty, non-integer, or negative strings so malformed quotes cannot throw
    // during BigInt conversion.
    // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
    const text = value as string;
    if (!/^\d+$/.test(text)) return null;
    try {
      return BigInt(text);
    } catch {
      return null;
    }
  }
  if (Object.prototype.toString.call(value) === "[object Number]") {
    // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
    const n = value as number;
    if (Number.isFinite(n) && n >= 0) return BigInt(Math.floor(n));
  }
  return null;
}

function quoteOutAmount<T>(quoteData: T): bigint {
  if (!isNonNullObject(quoteData)) return 0n;
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  return parseAtomicAmount((quoteData as SwapQuoteData).outAmount) ?? 0n;
}

function quoteGuaranteedOutAmount<T>(quoteData: T): bigint {
  // Jupiter's `otherAmountThreshold` is the minimum output guaranteed at the
  // quoted slippage; prefer it over the optimistic `outAmount` so a swap is
  // only submitted when it can actually cover the deficit after slippage.
  if (!isNonNullObject(quoteData)) return 0n;
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  const threshold = parseAtomicAmount((quoteData as SwapQuoteData).otherAmountThreshold);
  if (threshold !== null) return threshold;
  return quoteOutAmount(quoteData);
}

/** A single pool-token shortfall the funding phase must cover. */
interface PrepDeficit {
  readonly mint: string;
  readonly amount: bigint;
  readonly decimals: number;
  readonly price: number;
}

/** Owner contract for the entry-requirement computation. */
interface PrepRequirementsInput {
  readonly poolAddress: string;
  readonly positionSizeUsd: number;
  readonly tokenX: string;
  readonly tokenY: string;
  readonly priceX: number;
  readonly priceY: number;
  readonly tokenXDecimals: number;
  readonly tokenYDecimals: number;
  readonly xOnly: boolean;
}

/** Owner contract for the single-sided precedence check. */
interface PrepSingleSidedInput {
  readonly poolAddress: string;
  readonly positionSizeUsd: number;
  readonly tokenX: string;
  readonly tokenY: string;
  readonly priceX: number;
  readonly priceY: number;
  readonly tokenXDecimals: number;
  readonly tokenYDecimals: number;
  readonly requiredX: bigint;
  readonly requiredY: bigint;
  readonly availableX: bigint;
  readonly availableY: bigint;
  readonly xOnly: boolean;
}

/** Owner contract for deficit collection. */
interface PrepDeficitInput {
  readonly poolAddress: string;
  readonly solFunded: boolean;
  readonly tokenX: string;
  readonly tokenY: string;
  readonly requiredX: bigint;
  readonly requiredY: bigint;
  readonly availableX: bigint;
  readonly availableY: bigint;
  readonly tokenXDecimals: number;
  readonly tokenYDecimals: number;
  readonly priceX: number;
  readonly priceY: number;
}

/** Spendable balance of one leg: SOL legs keep the gas reserve back, then pending settlement claims are reserved. */
function spendableLeg(balance: bigint, isSolLeg: boolean, claimed: bigint): bigint {
  const free = isSolLeg
    ? balance > GAS_RESERVE_LAMPORTS
      ? balance - GAS_RESERVE_LAMPORTS
      : 0n
    : balance;
  return free > claimed ? free - claimed : 0n;
}

/** SOL-side requirement across both legs (a leg contributes only when it is the SOL mint). */
function solLegRequirement(
  tokenX: string,
  tokenY: string,
  requiredX: bigint,
  requiredY: bigint,
): bigint {
  return (tokenX === SOL_MINT ? requiredX : 0n) + (tokenY === SOL_MINT ? requiredY : 0n);
}

/** Resolve the atomic funding requirements for each leg (xOnly funds the X leg at full size). */
function resolvePrepRequirements(
  input: PrepRequirementsInput,
): Effect.Effect<{ requiredX: bigint; requiredY: bigint }, EntryPrepError> {
  const halfUsd = input.xOnly ? input.positionSizeUsd : input.positionSizeUsd / 2;
  const requiredX =
    computeRequiredAtomic(halfUsd, input.priceX, input.tokenXDecimals) +
    (input.tokenX === SOL_MINT ? SOL_ENTRY_TRANSACTION_BUFFER_LAMPORTS : 0n);
  const requiredY = input.xOnly
    ? 0n
    : computeRequiredAtomic(halfUsd, input.priceY, input.tokenYDecimals) +
      (input.tokenY === SOL_MINT ? SOL_ENTRY_TRANSACTION_BUFFER_LAMPORTS : 0n);
  if (!input.xOnly && (requiredX === 0n || requiredY === 0n)) {
    return Effect.fail(
      makePrepError(
        "PRICE_UNAVAILABLE",
        `Token price too small or position size too small to produce a non-zero requirement for pool tokens: ${input.tokenX}=${input.priceX}, ${input.tokenY}=${input.priceY}`,
        input.poolAddress,
      ),
    );
  }
  return Effect.succeed({ requiredX, requiredY });
}

/**
 * Single-sided precedence (Wave 7): when exactly one leg cannot fund its
 * half and the other leg alone covers a full-size single-sided deposit, the
 * adapter's native single-sided path wins over the USDC auto-swap (no swap
 * slippage, works even when the missing leg is USDC itself). Returns true
 * when the entry is already fundable and preparation must stop.
 */
function singleSidedNativeDeposit(input: PrepSingleSidedInput): Effect.Effect<boolean, never> {
  const xLegShort = input.requiredX > input.availableX;
  const yLegShort = input.requiredY > input.availableY;
  // Under xOnly the adapter's forceSingleSidedX owns the balance
  // check — the precedence skip would otherwise swallow an X
  // shortfall and return unprepared.
  if (input.xOnly || xLegShort === yLegShort) return Effect.succeed(false);
  const heldIsX = yLegShort;
  const heldMint = heldIsX ? input.tokenX : input.tokenY;
  const heldDecimals = heldIsX ? input.tokenXDecimals : input.tokenYDecimals;
  const heldPrice = heldIsX ? input.priceX : input.priceY;
  const heldAvailable = heldIsX ? input.availableX : input.availableY;
  const fullSizeRequired =
    computeRequiredAtomic(input.positionSizeUsd, heldPrice, heldDecimals) +
    (heldMint === SOL_MINT ? SOL_ENTRY_TRANSACTION_BUFFER_LAMPORTS : 0n);
  if (fullSizeRequired > 0n && heldAvailable >= fullSizeRequired) {
    logger.info(
      "Single-sided native deposit preferred over USDC auto-swap (held leg covers the full size)",
      {
        poolAddress: input.poolAddress,
        heldMint,
        heldAvailable: formatAtomic(heldAvailable, heldDecimals),
        fullSizeRequired: formatAtomic(fullSizeRequired, heldDecimals),
      },
    );
    return Effect.succeed(true);
  }
  return Effect.succeed(false);
}

/** Collect per-leg funding shortfalls (USDC legs fail fast outside SOL-funded mode). */
function collectPrepDeficits(
  input: PrepDeficitInput,
): Effect.Effect<PrepDeficit[], EntryPrepError> {
  const deficits: PrepDeficit[] = [];
  if (input.requiredX > input.availableX) {
    if (!input.solFunded && input.tokenX === USDC_MINT) {
      return Effect.fail(
        makePrepError(
          "INSUFFICIENT_USDC_BALANCE",
          `Wallet USDC balance ${formatAtomic(input.availableX, USDC_DECIMALS)} is less than required ${formatAtomic(input.requiredX, USDC_DECIMALS)} for pool token X`,
          input.poolAddress,
        ),
      );
    }
    if (!input.solFunded || input.tokenX !== SOL_MINT) {
      deficits.push({
        mint: input.tokenX,
        amount: input.requiredX - input.availableX,
        decimals: input.tokenXDecimals,
        price: input.priceX,
      });
    }
  }
  if (input.requiredY > input.availableY) {
    if (!input.solFunded && input.tokenY === USDC_MINT) {
      return Effect.fail(
        makePrepError(
          "INSUFFICIENT_USDC_BALANCE",
          `Wallet USDC balance ${formatAtomic(input.availableY, USDC_DECIMALS)} is less than required ${formatAtomic(input.requiredY, USDC_DECIMALS)} for pool token Y`,
          input.poolAddress,
        ),
      );
    }
    if (!input.solFunded || input.tokenY !== SOL_MINT) {
      deficits.push({
        mint: input.tokenY,
        amount: input.requiredY - input.availableY,
        decimals: input.tokenYDecimals,
        price: input.priceY,
      });
    }
  }
  return Effect.succeed(deficits);
}

export const EntryPrepLive = Layer.effect(
  EntryPrepService,
  Effect.gen(function* () {
    const adapter = yield* AdapterService;
    const config = yield* ConfigService;
    const db = yield* DbService;

    /** Fail the preparation when a leg's decimals are unusable. */
    function validateTokenDecimals(
      entries: ReadonlyArray<readonly [string, number]>,
      poolAddress: string,
    ): Effect.Effect<void, EntryPrepError> {
      for (const [mint, decimals] of entries) {
        if (!isValidDecimals(decimals)) {
          return Effect.fail(
            makePrepError(
              "PRICE_UNAVAILABLE",
              "Invalid decimals for " + mint + ": " + String(decimals),
              poolAddress,
            ),
          );
        }
      }
      return Effect.void;
    }

    /**
     * Load and validate everything the funding math needs: pool state,
     * leg prices, and leg decimals. Runner xOnly mode skips the Y leg.
     */
    function loadPrepMarketData(
      poolAddress: string,
      xOnly: boolean,
      solFunded: boolean,
    ): Effect.Effect<
      {
        pool: Effect.Success<ReturnType<typeof adapter.getPoolState>>;
        priceX: number;
        priceY: number;
        tokenXDecimals: number;
        tokenYDecimals: number;
        solPrice: number;
      },
      EntryPrepError
    > {
      return Effect.gen(function* () {
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
        const [prices, tokenXDecimals, maybeTokenYDecimals] = yield* Effect.all(
          [
            adapter
              .getTokenPrices(
                xOnly
                  ? [pool.tokenX, ...(solFunded ? [SOL_MINT] : [])]
                  : solFunded
                    ? [pool.tokenX, pool.tokenY, SOL_MINT]
                    : [pool.tokenX, pool.tokenY],
              )
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
            ...(xOnly
              ? []
              : [
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
                ]),
          ],
          { concurrency: "unbounded" },
        );
        const tokenYDecimals = maybeTokenYDecimals ?? 0;
        yield* validateTokenDecimals(
          [
            [pool.tokenX, tokenXDecimals],
            ...(xOnly ? [] : [[pool.tokenY, tokenYDecimals] as const]),
          ],
          poolAddress,
        );
        const priceX = prices[pool.tokenX] ?? 0;
        const priceY = prices[pool.tokenY] ?? 0;
        const solPrice = prices[SOL_MINT] ?? 0;
        if (
          !Number.isFinite(priceX) ||
          priceX <= 0 ||
          (!xOnly && (!Number.isFinite(priceY) || priceY <= 0))
        ) {
          return yield* Effect.fail(
            makePrepError(
              "PRICE_UNAVAILABLE",
              `Invalid or missing price for pool tokens: ${pool.tokenX}=${priceX}, ${pool.tokenY}=${priceY}`,
              poolAddress,
            ),
          );
        }
        return { pool, priceX, priceY, tokenXDecimals, tokenYDecimals, solPrice };
      });
    }

    /**
     * Issue #201: a pending settlement job claims wallet funds that this
     * entry must not spend. Reserve the sum of non-final job amounts per
     * mint (a claim read failure fails open).
     */
    function readPendingSettlementClaims(): Effect.Effect<Map<string, bigint>, never> {
      return Effect.gen(function* () {
        const pendingClaims = new Map<string, bigint>();
        const executionWallet = adapter.getWalletAddress();
        if (executionWallet === null) return pendingClaims;
        const activeJobs = yield* db
          .listSettlementJobs(executionWallet, config.agentInstanceId)
          .pipe(Effect.catch(() => Effect.succeed([])));
        for (const job of activeJobs) {
          if (job.status === "confirmed" || job.status === "terminal") continue;
          let claim: bigint;
          try {
            claim = BigInt(job.amountAtomic);
          } catch {
            continue;
          }
          if (claim <= 0n) continue;
          pendingClaims.set(job.tokenMint, (pendingClaims.get(job.tokenMint) ?? 0n) + claim);
        }
        return pendingClaims;
      });
    }

    const api: EntryPrepApi = {
      prepareEntryTokens: (poolAddress, positionSizeUsd, opts) =>
        Effect.gen(function* () {
          const autonomousMode = config.autonomousTokenMode ?? "off";
          const solFunded = autonomousMode === "canary" || autonomousMode === "live";
          // Runner mode: only the quote (X) leg is funded — the dip-anchored
          // deposit is single-sided X, so acquiring the Y half is a wasted swap.
          const xOnly = opts?.xOnly === true;
          if (!config.autoSwapEntry && !solFunded) {
            return;
          }

          if (!adapter.hasWallet()) {
            return yield* Effect.fail(
              makePrepError("NO_WALLET", "No wallet configured for auto-swap entry", poolAddress),
            );
          }

          const { pool, priceX, priceY, tokenXDecimals, tokenYDecimals, solPrice } =
            yield* loadPrepMarketData(poolAddress, xOnly, solFunded);

          const { requiredX, requiredY } = yield* resolvePrepRequirements({
            poolAddress,
            positionSizeUsd,
            tokenX: pool.tokenX,
            tokenY: pool.tokenY,
            priceX,
            priceY,
            tokenXDecimals,
            tokenYDecimals,
            xOnly,
          });
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

          const nativeSolLamports = yield* readNativeSolBalance();

          // Issue #201: a pending settlement job claims wallet funds that
          // this entry must not spend — a concurrent entry consuming the
          // exit settlement's USDC was the root cause of the field stranding
          // ($41.91 expected, $24.35 in wallet). Reserve the sum of
          // non-final job amounts per mint by subtracting it from the
          // spendable balance (floor 0). A claim read failure fails open.
          const pendingClaims = yield* readPendingSettlementClaims();
          const claimedX = pendingClaims.get(pool.tokenX) ?? 0n;
          const claimedY = pendingClaims.get(pool.tokenY) ?? 0n;

          const balanceX =
            pool.tokenX === SOL_MINT ? nativeSolLamports : yield* readTokenBalance(pool.tokenX);
          const balanceY = xOnly
            ? 0n
            : pool.tokenY === SOL_MINT
              ? nativeSolLamports
              : yield* readTokenBalance(pool.tokenY);

          const availableX = spendableLeg(balanceX, pool.tokenX === SOL_MINT, claimedX);
          const availableY = spendableLeg(balanceY, pool.tokenY === SOL_MINT, claimedY);

          // Single-sided precedence (Wave 7): when exactly one leg cannot fund
          // its half and the other leg alone covers a full-size single-sided
          // deposit, skip the USDC auto-swap entirely — the adapter's
          // enterPosition executes the native single-sided deposit instead
          // (no swap slippage, works even when the missing leg is USDC
          // itself). The auto-swap path below remains the fallback for every
          // other deficit shape.
          const singleSidedReady = yield* singleSidedNativeDeposit({
            poolAddress,
            positionSizeUsd,
            tokenX: pool.tokenX,
            tokenY: pool.tokenY,
            priceX,
            priceY,
            tokenXDecimals,
            tokenYDecimals,
            requiredX,
            requiredY,
            availableX,
            availableY,
            xOnly,
          });
          if (singleSidedReady) return;
          const deficits = yield* collectPrepDeficits({
            poolAddress,
            solFunded,
            tokenX: pool.tokenX,
            tokenY: pool.tokenY,
            requiredX,
            requiredY,
            availableX,
            availableY,
            tokenXDecimals,
            tokenYDecimals,
            priceX,
            priceY,
          });
          if (deficits.length === 0) {
            logger.info("Pool token balances sufficient for entry", { poolAddress });
            return;
          }

          // SOL-funded phase: quote, prepare, submit and reconcile one swap per
          // deficit out of native SOL. Nested so the main preparation flow stays
          // a thin orchestrator; every name below closes over the phase context.
          function runSolFundedPhase(): Effect.Effect<
            { status: "complete"; receipts: EntryPreparationReceipt[] },
            EntryPrepError
          > {
            return Effect.gen(function* () {
              const quoteSwap = adapter.quoteSwap;
              const prepareSwap = adapter.prepareSwap;
              const simulateSwap = adapter.simulateSwap;
              const submitSwap = adapter.submitSwap;
              if (!quoteSwap || !prepareSwap || !simulateSwap || !submitSwap) {
                return yield* Effect.fail(
                  makePrepError(
                    "SWAP_TRANSACTION_FAILED",
                    "Generic swap operations are unavailable for SOL-funded entry",
                    poolAddress,
                  ),
                );
              }
              if (!Number.isFinite(solPrice) || solPrice <= 0) {
                return yield* Effect.fail(
                  makePrepError(
                    "PRICE_UNAVAILABLE",
                    `Invalid or missing SOL price: ${solPrice}`,
                    poolAddress,
                  ),
                );
              }
              const requests = deficits.map((deficit) => ({
                deficit,
                amountAtomic: computeSwapInputAtomic(
                  deficit.amount,
                  deficit.decimals,
                  deficit.price,
                  9,
                  solPrice,
                ),
              }));
              if (requests.some(({ amountAtomic }) => amountAtomic <= 0n)) {
                return yield* Effect.fail(
                  makePrepError(
                    "SWAP_QUOTE_FAILED",
                    "Computed SOL input is too small for a pool-token deficit",
                    poolAddress,
                  ),
                );
              }
              const poolSolRequirement = solLegRequirement(
                pool.tokenX,
                pool.tokenY,
                requiredX,
                requiredY,
              );
              const totalSolRequired =
                poolSolRequirement +
                requests.reduce((total, request) => total + request.amountAtomic, 0n);
              const spendableSol = spendableLeg(nativeSolLamports, true, 0n);
              if (spendableSol < totalSolRequired) {
                return yield* Effect.fail(
                  makePrepError(
                    "INSUFFICIENT_BALANCE_AFTER_SWAP",
                    `Spendable SOL ${formatAtomic(spendableSol, 9)} is less than required ${formatAtomic(totalSolRequired, 9)} for entry funding`,
                    poolAddress,
                  ),
                );
              }
              const quoted = yield* Effect.all(
                requests.map(({ deficit, amountAtomic }) =>
                  quoteSwap({
                    inputMint: SOL_MINT,
                    outputMint: deficit.mint,
                    amountAtomic,
                    slippageBps: Math.min(config.maxSwapSlippageBps ?? 50, 50),
                  }).pipe(
                    Effect.mapError((err) =>
                      makePrepError(
                        "SWAP_QUOTE_FAILED",
                        `Failed to quote swap SOL -> ${deficit.mint}: ${String(err)}`,
                        poolAddress,
                        err,
                      ),
                    ),
                    Effect.flatMap((quote) =>
                      quote.minimumOutAmountAtomic >= deficit.amount
                        ? Effect.succeed({ deficit, quote })
                        : Effect.fail(
                            makePrepError(
                              "SWAP_QUOTE_FAILED",
                              `Guaranteed output for ${deficit.mint} is below its deficit`,
                              poolAddress,
                            ),
                          ),
                    ),
                  ),
                ),
                { concurrency: "unbounded" },
              );
              const prepared = yield* Effect.all(
                quoted.map(({ deficit, quote }) =>
                  prepareSwap(quote).pipe(
                    Effect.flatMap((operation) =>
                      simulateSwap(operation).pipe(Effect.as({ deficit, operation })),
                    ),
                    Effect.mapError((err) =>
                      makePrepError(
                        "SWAP_TRANSACTION_FAILED",
                        `Failed to prepare or simulate SOL -> ${deficit.mint}: ${String(err)}`,
                        poolAddress,
                        err,
                      ),
                    ),
                  ),
                ),
                { concurrency: "unbounded" },
              );
              let submittedCount = 0;
              const receipts: EntryPreparationReceipt[] = [];
              for (const { deficit, operation } of prepared) {
                const balanceBefore = yield* readTokenBalance(deficit.mint);
                const signature = yield* submitSwap(operation).pipe(
                  Effect.mapError((err) =>
                    makePrepError(
                      "SWAP_TRANSACTION_FAILED",
                      `SOL-funded entry stopped after ${submittedCount} of ${prepared.length} submissions while swapping ${deficit.mint}: ${String(err)}`,
                      poolAddress,
                      err,
                      receipts.length === 0
                        ? undefined
                        : { status: "partial", receipts: [...receipts] },
                    ),
                  ),
                );
                submittedCount += 1;
                const balanceAfter = yield* readTokenBalance(deficit.mint).pipe(
                  Effect.mapError((err) =>
                    makePrepError(
                      "SWAP_TRANSACTION_FAILED",
                      `Swap ${signature} submitted but fill could not be read: ${String(err)}`,
                      poolAddress,
                      err,
                      {
                        status: "partial",
                        receipts: [
                          ...receipts,
                          {
                            inputMint: SOL_MINT,
                            outputMint: deficit.mint,
                            inputAmountAtomic: operation.quote.request.amountAtomic,
                            acquiredAmountAtomic: 0n,
                            txSignature: signature,
                          },
                        ],
                      },
                    ),
                  ),
                );
                const acquiredAmountAtomic =
                  balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0n;
                receipts.push({
                  inputMint: SOL_MINT,
                  outputMint: deficit.mint,
                  inputAmountAtomic: operation.quote.request.amountAtomic,
                  acquiredAmountAtomic,
                  txSignature: signature,
                });
                logger.info("Submitted SOL-funded pool-token swap", {
                  poolAddress,
                  mint: deficit.mint,
                  tx: signature,
                  submittedCount,
                  total: prepared.length,
                });
              }
              const partialPreparation = { status: "partial" as const, receipts: [...receipts] };
              const nativeSolAfter = yield* readNativeSolBalance().pipe(
                Effect.mapError((err) =>
                  makePrepError(
                    "SWAP_TRANSACTION_FAILED",
                    `Final SOL balance reconciliation failed: ${String(err)}`,
                    poolAddress,
                    err,
                    partialPreparation,
                  ),
                ),
              );
              const balanceXAfter =
                pool.tokenX === SOL_MINT
                  ? nativeSolAfter
                  : yield* readTokenBalance(pool.tokenX).pipe(
                      Effect.mapError((err) =>
                        makePrepError(
                          "SWAP_TRANSACTION_FAILED",
                          `Final ${pool.tokenX} balance reconciliation failed: ${String(err)}`,
                          poolAddress,
                          err,
                          partialPreparation,
                        ),
                      ),
                    );
              const balanceYAfter =
                pool.tokenY === SOL_MINT
                  ? nativeSolAfter
                  : yield* readTokenBalance(pool.tokenY).pipe(
                      Effect.mapError((err) =>
                        makePrepError(
                          "SWAP_TRANSACTION_FAILED",
                          `Final ${pool.tokenY} balance reconciliation failed: ${String(err)}`,
                          poolAddress,
                          err,
                          partialPreparation,
                        ),
                      ),
                    );
              if (balanceXAfter < requiredX || balanceYAfter < requiredY) {
                return yield* Effect.fail(
                  makePrepError(
                    "INSUFFICIENT_BALANCE_AFTER_SWAP",
                    `Balances still insufficient after SOL-funded swaps: X=${formatAtomic(balanceXAfter, tokenXDecimals)}/${formatAtomic(requiredX, tokenXDecimals)}, Y=${formatAtomic(balanceYAfter, tokenYDecimals)}/${formatAtomic(requiredY, tokenYDecimals)}`,
                    poolAddress,
                    undefined,
                    { status: "partial", receipts: [...receipts] },
                  ),
                );
              }
              if (nativeSolAfter < MIN_SOL_FOR_GAS_LAMPORTS) {
                return yield* Effect.fail(
                  makePrepError(
                    "INSUFFICIENT_BALANCE_AFTER_SWAP",
                    `Native SOL balance ${formatAtomic(nativeSolAfter, 9)} is below the gas minimum after swaps`,
                    poolAddress,
                    undefined,
                    { status: "partial", receipts: [...receipts] },
                  ),
                );
              }
              logger.info("SOL-funded entry token preparation complete", { poolAddress });
              return { status: "complete", receipts };
            });
          }

          if (solFunded) return yield* runSolFundedPhase();

          // USDC-funded phase: preflight every leg quote, swap USDC for the
          // missing legs, then reconcile. Nested so the main preparation flow
          // stays a thin orchestrator; every name below closes over the context.
          function runUsdcPhase(): Effect.Effect<void, EntryPrepError> {
            return Effect.gen(function* () {
              const usdcBalance = yield* readTokenBalance(USDC_MINT);
              // Issue #201: even when neither pool leg is USDC, the funding swaps
              // spend wallet USDC — subtract pending USDC settlement claims so a
              // token/token entry cannot consume USDC an exit settlement is about
              // to sell.
              const usdcClaimed = pendingClaims.get(USDC_MINT) ?? 0n;
              const spendableUsdc = usdcBalance > usdcClaimed ? usdcBalance - usdcClaimed : 0n;
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
              if (spendableUsdc < totalUsdcRequired) {
                const gasNote = needsGasTopUp ? " + gas top-up" : "";
                return yield* Effect.fail(
                  makePrepError(
                    "INSUFFICIENT_USDC_BALANCE",
                    `Wallet USDC balance ${formatAtomic(spendableUsdc, USDC_DECIMALS)} (after ${formatAtomic(usdcClaimed, USDC_DECIMALS)} pending settlement claims) is less than required ${formatAtomic(totalUsdcRequired, USDC_DECIMALS)} for auto-swap entry (swaps + USDC pool leg${gasNote})`,
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
            });
          }

          yield* runUsdcPhase();
        }),
    };

    return api;
  }),
);
