import { Effect, Layer } from "effect";
import {
  AdapterService,
  DbService,
  EntryPrepService,
  type AdapterApi,
  type EntryPreparationOutcome,
  type EntryPreparationReceipt,
  type EntryPrepApi,
  type PreparedSwap,
  type SwapQuote,
  type SwapRequest,
  type SwapSimulation,
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
/** Price lookup with a zero fallback for mints missing from the quote. */
function priceOrZero(prices: Record<string, number>, mint: string): number {
  return prices[mint] ?? 0;
}

/** Mints whose prices the preparation must load (runner xOnly skips the Y leg). */
function prepPriceMints(
  tokenX: string,
  tokenY: string,
  xOnly: boolean,
  solFunded: boolean,
): string[] {
  if (xOnly) return solFunded ? [tokenX, SOL_MINT] : [tokenX];
  if (solFunded) return [tokenX, tokenY, SOL_MINT];
  return [tokenX, tokenY];
}

/** Leg-price gate (runner xOnly skips the Y leg). */
function prepPricesValid(priceX: number, priceY: number, xOnly: boolean): boolean {
  if (!isUsablePrice(priceX)) return false;
  if (xOnly) return true;
  return isUsablePrice(priceY);
}

/** SOL-funded mode covers canary and live autonomous operation. */
function solFundedFromMode(mode: string): boolean {
  if (mode === "canary") return true;
  return mode === "live";
}

/** Skip preparation when neither auto-swap nor SOL-funded mode is active. */
function shouldSkipPrep(autoSwapEntry: boolean, solFunded: boolean): boolean {
  if (autoSwapEntry) return false;
  return !solFunded;
}

/** Pending settlement claim reserved against a mint (missing claims reserve nothing). */
function claimFor(claims: Map<string, bigint>, mint: string): bigint {
  return claims.get(mint) ?? 0n;
}

/** A price is usable when it is finite and positive. */
function isUsablePrice(price: number): boolean {
  return Number.isFinite(price) && price > 0;
}

/** Fail-fast error when a USDC leg is short outside SOL-funded mode. */
function legUsdcShortfallError(
  mint: string,
  solFunded: boolean,
  required: bigint,
  available: bigint,
  legLabel: string,
  poolAddress: string,
): EntryPrepError | null {
  if (solFunded || mint !== USDC_MINT || required <= available) return null;
  return makePrepError(
    "INSUFFICIENT_USDC_BALANCE",
    `Wallet USDC balance ${formatAtomic(available, USDC_DECIMALS)} is less than required ${formatAtomic(required, USDC_DECIMALS)} for pool token ${legLabel}`,
    poolAddress,
  );
}

/** Single-leg funding shortfall (SOL legs need no swap inside SOL-funded mode). */
function legDeficit(
  mint: string,
  required: bigint,
  available: bigint,
  decimals: number,
  price: number,
  solFunded: boolean,
): PrepDeficit | null {
  if (required <= available) return null;
  if (!solFunded || mint !== SOL_MINT)
    return { mint, amount: required - available, decimals, price };
  return null;
}

interface SolSwapOps {
  readonly quoteSwap: (request: SwapRequest) => Effect.Effect<SwapQuote, Error, never>;
  readonly prepareSwap: (quote: SwapQuote) => Effect.Effect<PreparedSwap, Error, never>;
  readonly simulateSwap: (prepared: PreparedSwap) => Effect.Effect<SwapSimulation, Error, never>;
  readonly submitSwap: (prepared: PreparedSwap) => Effect.Effect<string, Error, never>;
}
/** Acquired fill from a balance delta (floored at zero — fees can exceed it). */
function acquiredFill(balanceBefore: bigint, balanceAfter: bigint): bigint {
  return balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0n;
}

function solSwapOps(adapter: AdapterApi): SolSwapOps | null {
  const { quoteSwap, prepareSwap, simulateSwap, submitSwap } = adapter;
  if (!quoteSwap || !prepareSwap || !simulateSwap || !submitSwap) return null;
  return { quoteSwap, prepareSwap, simulateSwap, submitSwap };
}

/** USDC atoms reserved for the gas top-up (zero when the wallet holds enough SOL). */
function gasTopUpFor(nativeSol: bigint): bigint {
  if (nativeSol >= SOL_GAS_TOP_UP_THRESHOLD_LAMPORTS) return 0n;
  return BigInt(GAS_TOP_UP_USDC) * 10n ** BigInt(USDC_DECIMALS);
}

/** Both legs meet their buffered requirements after funding swaps. */
function legsFunded(
  balanceX: bigint,
  balanceY: bigint,
  requiredX: bigint,
  requiredY: bigint,
): boolean {
  if (balanceX < requiredX) return false;
  return balanceY >= requiredY;
}

/** Spendable amount after reserving pending settlement claims. */
function spendableAfterClaim(balance: bigint, claimed: bigint): bigint {
  return balance > claimed ? balance - claimed : 0n;
}

/** Full insufficient-USDC error including the gas top-up note. */
function insufficientUsdcError(
  spendable: bigint,
  claimed: bigint,
  required: bigint,
  topUp: boolean,
  poolAddress: string,
): EntryPrepError {
  const gasNote = topUp ? " + gas top-up" : "";
  return makePrepError(
    "INSUFFICIENT_USDC_BALANCE",
    `Wallet USDC balance ${formatAtomic(spendable, USDC_DECIMALS)} (after ${formatAtomic(claimed, USDC_DECIMALS)} pending settlement claims) is less than required ${formatAtomic(required, USDC_DECIMALS)} for auto-swap entry (swaps + USDC pool leg${gasNote})`,
    poolAddress,
  );
}

/** Gas check after USDC swaps consumed native SOL fees. */
function gasDepleted(swapped: boolean, nativeAfter: bigint): boolean {
  if (!swapped) return false;
  return nativeAfter < MIN_SOL_FOR_GAS_LAMPORTS;
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
  const shortX = legUsdcShortfallError(
    input.tokenX,
    input.solFunded,
    input.requiredX,
    input.availableX,
    "X",
    input.poolAddress,
  );
  if (shortX !== null) return Effect.fail(shortX);
  const shortY = legUsdcShortfallError(
    input.tokenY,
    input.solFunded,
    input.requiredY,
    input.availableY,
    "Y",
    input.poolAddress,
  );
  if (shortY !== null) return Effect.fail(shortY);
  const deficits: PrepDeficit[] = [];
  const deficitX = legDeficit(
    input.tokenX,
    input.requiredX,
    input.availableX,
    input.tokenXDecimals,
    input.priceX,
    input.solFunded,
  );
  if (deficitX !== null) deficits.push(deficitX);
  const deficitY = legDeficit(
    input.tokenY,
    input.requiredY,
    input.availableY,
    input.tokenYDecimals,
    input.priceY,
    input.solFunded,
  );
  if (deficitY !== null) deficits.push(deficitY);
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
    /** Native SOL read with preparation error mapping. */
    function readNativeSol(poolAddress: string): Effect.Effect<bigint, EntryPrepError> {
      return adapter
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
    }

    /** Token balance read with preparation error mapping. */
    function readMintBalance(
      mint: string,
      poolAddress: string,
    ): Effect.Effect<bigint, EntryPrepError> {
      return adapter
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
    }

    /** Leg balance: SOL legs resolve to the already-read native balance. */
    function readLegBalance(
      mint: string,
      nativeSol: bigint,
      poolAddress: string,
    ): Effect.Effect<bigint, EntryPrepError> {
      if (mint === SOL_MINT) return Effect.succeed(nativeSol);
      return readMintBalance(mint, poolAddress);
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
              .getTokenPrices(prepPriceMints(pool.tokenX, pool.tokenY, xOnly, solFunded))
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
        const priceX = priceOrZero(prices, pool.tokenX);
        const priceY = priceOrZero(prices, pool.tokenY);
        const solPrice = priceOrZero(prices, SOL_MINT);
        if (!prepPricesValid(priceX, priceY, xOnly)) {
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
          const solFunded = solFundedFromMode(config.autonomousTokenMode);
          // Runner mode: only the quote (X) leg is funded — the dip-anchored
          // deposit is single-sided X, so acquiring the Y half is a wasted swap.
          const xOnly = opts?.xOnly === true;
          if (shouldSkipPrep(config.autoSwapEntry, solFunded)) {
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
          const nativeSolLamports = yield* readNativeSol(poolAddress);
          // Issue #201: a pending settlement job claims wallet funds that
          // this entry must not spend — a concurrent entry consuming the
          // exit settlement's USDC was the root cause of the field stranding
          // ($41.91 expected, $24.35 in wallet). Reserve the sum of
          // non-final job amounts per mint by subtracting it from the
          // spendable balance (floor 0). A claim read failure fails open.
          const pendingClaims = yield* readPendingSettlementClaims();
          const claimedX = claimFor(pendingClaims, pool.tokenX);
          const claimedY = claimFor(pendingClaims, pool.tokenY);

          const balanceX = yield* readLegBalance(pool.tokenX, nativeSolLamports, poolAddress);
          const balanceY = xOnly
            ? 0n
            : yield* readLegBalance(pool.tokenY, nativeSolLamports, poolAddress);

          const availableX = spendableLeg(balanceX, pool.tokenX === SOL_MINT, claimedX);
          const availableY = spendableLeg(balanceY, pool.tokenY === SOL_MINT, claimedY);
          /** Post-swap leg read for the SOL-funded phase (reconciliation failures carry the partial receipts). */
          function readSolPhaseLeg(
            mint: string,
            nativeAfter: bigint,
            receipts: EntryPreparationReceipt[],
          ): Effect.Effect<bigint, EntryPrepError> {
            if (mint === SOL_MINT) return Effect.succeed(nativeAfter);
            return readMintBalance(mint, poolAddress).pipe(
              Effect.mapError((err) =>
                makePrepError(
                  "SWAP_TRANSACTION_FAILED",
                  `Final ${mint} balance reconciliation failed: ${String(err)}`,
                  poolAddress,
                  err,
                  { status: "partial", receipts: [...receipts] },
                ),
              ),
            );
          }

          /** Post-swap leg read for the USDC phase. */
          function readUsdcPhaseLeg(
            mint: string,
            nativeAfter: bigint,
          ): Effect.Effect<bigint, EntryPrepError> {
            if (mint === SOL_MINT) return Effect.succeed(nativeAfter);
            return readMintBalance(mint, poolAddress);
          }

          /** Fail when a computed USDC input is too small to quote. */
          function failOnTinyUsdcInput(
            usdcInput: bigint,
            mint: string,
          ): Effect.Effect<void, EntryPrepError> {
            if (usdcInput > 0n) return Effect.void;
            return Effect.fail(
              makePrepError(
                "SWAP_QUOTE_FAILED",
                `Computed USDC input too small for ${mint}`,
                poolAddress,
              ),
            );
          }

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
              const swapOps = solSwapOps(adapter);
              if (!swapOps) {
                return yield* Effect.fail(
                  makePrepError(
                    "SWAP_TRANSACTION_FAILED",
                    "Generic swap operations are unavailable for SOL-funded entry",
                    poolAddress,
                  ),
                );
              }
              if (!isUsablePrice(solPrice)) {
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
                  swapOps
                    .quoteSwap({
                      inputMint: SOL_MINT,
                      outputMint: deficit.mint,
                      amountAtomic,
                      slippageBps: Math.min(config.maxSwapSlippageBps ?? 50, 50),
                    })
                    .pipe(
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
                  swapOps.prepareSwap(quote).pipe(
                    Effect.flatMap((operation) =>
                      swapOps.simulateSwap(operation).pipe(Effect.as({ deficit, operation })),
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
                const balanceBefore = yield* readMintBalance(deficit.mint, poolAddress);
                const signature = yield* swapOps
                  .submitSwap(operation)
                  .pipe(
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
                const balanceAfter = yield* readMintBalance(deficit.mint, poolAddress).pipe(
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
                const acquiredAmountAtomic = acquiredFill(balanceBefore, balanceAfter);
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
              const nativeSolAfter = yield* readNativeSol(poolAddress).pipe(
                Effect.mapError((err) =>
                  makePrepError(
                    "SWAP_TRANSACTION_FAILED",
                    `Final SOL balance reconciliation failed: ${String(err)}`,
                    poolAddress,
                    err,
                    { status: "partial", receipts: [...receipts] },
                  ),
                ),
              );
              const balanceXAfter = yield* readSolPhaseLeg(pool.tokenX, nativeSolAfter, receipts);
              const balanceYAfter = yield* readSolPhaseLeg(pool.tokenY, nativeSolAfter, receipts);
              if (!legsFunded(balanceXAfter, balanceYAfter, requiredX, requiredY)) {
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
              const usdcBalance = yield* readMintBalance(USDC_MINT, poolAddress);
              // Issue #201: even when neither pool leg is USDC, the funding swaps
              // spend wallet USDC — subtract pending USDC settlement claims so a
              // token/token entry cannot consume USDC an exit settlement is about
              // to sell.
              const usdcClaimed = claimFor(pendingClaims, USDC_MINT);
              const spendableUsdc = spendableAfterClaim(usdcBalance, usdcClaimed);
              const totalUsdcInputAtomic = deficits.reduce(
                (sum, deficit) =>
                  sum + computeUsdcInputAtomic(deficit.amount, deficit.decimals, deficit.price),
                0n,
              );
              const requiredUsdcPoolLeg =
                (pool.tokenX === USDC_MINT ? requiredX : 0n) +
                (pool.tokenY === USDC_MINT ? requiredY : 0n);
              const needsGasTopUp = nativeSolLamports < SOL_GAS_TOP_UP_THRESHOLD_LAMPORTS;
              const gasTopUpAtomic = gasTopUpFor(nativeSolLamports);
              const totalUsdcRequired = totalUsdcInputAtomic + requiredUsdcPoolLeg + gasTopUpAtomic;
              if (spendableUsdc < totalUsdcRequired) {
                return yield* Effect.fail(
                  insufficientUsdcError(
                    spendableUsdc,
                    usdcClaimed,
                    totalUsdcRequired,
                    needsGasTopUp,
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
                yield* failOnTinyUsdcInput(usdcInputAtomic, deficit.mint);
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
              const nativeSolAfter = swapped ? yield* readNativeSol(poolAddress) : 0n;
              const balanceXAfter = yield* readUsdcPhaseLeg(pool.tokenX, nativeSolAfter);
              const balanceYAfter = yield* readUsdcPhaseLeg(pool.tokenY, nativeSolAfter);
              // For SOL legs, requiredX/Y already include SOL_ENTRY_TRANSACTION_BUFFER_LAMPORTS,
              // so compare the raw post-swap balance against the buffered requirement.
              // Re-subtracting GAS_RESERVE_LAMPORTS here would double-count the reserve.
              if (!legsFunded(balanceXAfter, balanceYAfter, requiredX, requiredY)) {
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
              if (gasDepleted(swapped, nativeSolAfter)) {
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
