# Auto-Swap USDC to Pool Tokens on Entry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in feature that, before a live `ENTER`, automatically swaps USDC into any missing pool token amounts so the wallet is ready for `adapter.enterPosition`.

**Architecture:** Introduce a new `EntryPrepService` that is called in `program.ts` between the existing SOL gas top-up and `adapter.enterPosition`. The service computes the 50/50 USD split, checks wallet balances, and uses the existing Jupiter swap flow (generalized from `swapUSDCForSOL`) to cover deficits. `AdapterService` gains small primitives: `getTokenBalance`, `getTokenPrices`, `getTokenDecimals`, and `swapUSDCForToken`.

**Tech Stack:** Bun, TypeScript (strict), Effect-TS, Vitest, Solana web3.js, Jupiter Swap API v1.

## Global Constraints

- Default `AUTO_SWAP_ENTRY=false` (opt-in).
- Base token is USDC only.
- Two separate swaps: `USDC -> tokenX`, `USDC -> tokenY`.
- Slippage is hardcoded to 50 bps.
- Paper-trading mode is unchanged.
- All side effects go through Effect-TS services.
- No new dependencies; reuse existing `@solana/web3.js` and native `fetch`.

---

## Task 1: Add `autoSwapEntry` config and `EntryPrepError`

**Files:**
- Modify: `engine/config-service.ts`
- Modify: `engine/errors.ts`
- Modify: `bench/helpers.ts`

**Interfaces:**
- Produces: `AppConfig.autoSwapEntry: boolean`
- Produces: `EntryPrepError` tagged error class

- [ ] **Step 1: Add `autoSwapEntry` to `AppConfig`**

In `engine/config-service.ts`, add the field after `weightedEntryScoreThreshold` (around line 150):

```typescript
  readonly weightedEntryScoreThreshold: number;
  // Auto-swap USDC into missing pool tokens before live ENTER
  readonly autoSwapEntry: boolean;
}
```

- [ ] **Step 2: Load `AUTO_SWAP_ENTRY` env var**

In `engine/config-service.ts` `loadConfig`, after the `weightedEntryScoreThreshold` line (around line 348), add:

```typescript
  const weightedEntryScoreThreshold = yield* validatedNumber(
    "WEIGHTED_ENTRY_SCORE_THRESHOLD",
    0.1,
    1.8,
  );
  const autoSwapEntry = yield* Config.boolean("AUTO_SWAP_ENTRY").pipe(
    Effect.orElseSucceed(() => false),
  );
```

Then add `autoSwapEntry` to the `cfg` object at the end:

```typescript
    weightedEntryScoreThreshold,
    autoSwapEntry,
  };
```

- [ ] **Step 3: Add `EntryPrepError`**

In `engine/errors.ts`, append:

```typescript
export class EntryPrepError extends Data.TaggedError("EntryPrepError")<{
  readonly code:
    | "PRICE_UNAVAILABLE"
    | "SWAP_QUOTE_FAILED"
    | "SWAP_TRANSACTION_FAILED"
    | "INSUFFICIENT_BALANCE_AFTER_SWAP"
    | "NO_WALLET";
  readonly message: string;
  readonly poolAddress?: string;
  readonly cause?: unknown;
}> {}
```

- [ ] **Step 4: Update test helper defaults**

In `bench/helpers.ts`, add `autoSwapEntry: false` to the object returned by `defaultAppConfig` (after `weightedEntryScoreThreshold: 1.8`):

```typescript
    weightedEntryScoreThreshold: 1.8,
    autoSwapEntry: false,
  };
```

- [ ] **Step 5: Verify config test still passes**

Run:

```bash
bunx --bun vitest run bench/config-service.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add engine/config-service.ts engine/errors.ts bench/helpers.ts
git commit -m "feat: add AUTO_SWAP_ENTRY config and EntryPrepError"
```

---

## Task 2: Extend `AdapterService` with token primitives

**Files:**
- Modify: `engine/services.ts`
- Modify: `engine/adapter-service.ts`
- Test: `bench/adapter-swap.test.ts`

**Interfaces:**
- Produces: `AdapterApi.getTokenBalance(mintAddress: string) -> Effect<bigint, unknown>`
- Produces: `AdapterApi.getTokenPrices(mints: ReadonlyArray<string>) -> Effect<Record<string, number>, unknown>`
- Produces: `AdapterApi.getTokenDecimals(mintAddress: string) -> Effect<number, unknown>`
- Produces: `AdapterApi.swapUSDCForToken(outputMint: string, amountAtomic: bigint) -> Effect<string, unknown>` (returns tx signature)

- [ ] **Step 1: Add new methods to `AdapterApi`**

In `engine/services.ts`, in the `AdapterApi` interface after `swapUSDCForSOL`, add:

```typescript
  readonly getTokenBalance: (mintAddress: string) => Effect.Effect<bigint, unknown>;
  readonly getTokenPrices: (
    mints: ReadonlyArray<string>,
  ) => Effect.Effect<Record<string, number>, unknown>;
  readonly getTokenDecimals: (mintAddress: string) => Effect.Effect<number, unknown>;
  readonly swapUSDCForToken: (
    outputMint: string,
    amountAtomic: bigint,
  ) => Effect.Effect<string, unknown>;
```

- [ ] **Step 2: Implement the new methods in `adapter-service.ts`**

Inside the `api` object in `engine/adapter-service.ts`, add near `getNativeSolBalance`:

```typescript
      getTokenBalance: (mintAddress: string) => readTokenBalance(mintAddress),
      getTokenPrices: (mints: ReadonlyArray<string>) => fetchTokenPrices(mints),
      getTokenDecimals: (mintAddress: string) =>
        getTokenMeta(mintAddress).pipe(Effect.map((m) => m.decimals)),
```

Add a helper function `swapUSDCForToken` inside the `Effect.gen` that builds the API (near `swapUSDCForSOL`):

```typescript
    function swapUSDCForToken(
      outputMint: string,
      amountAtomic: bigint,
    ): Effect.Effect<string, unknown> {
      return Effect.gen(function* () {
        const activeWallet = wallet;
        if (!activeWallet) {
          return yield* Effect.fail(
            new AdapterError({ message: "No wallet configured" }),
          );
        }
        if (amountAtomic <= 0n) {
          return "";
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
            new AdapterError({
              message: `Jupiter quote failed: ${quoteResponse.status}`,
            }),
          );
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
```

Then expose it in the `api` object:

```typescript
      swapUSDCForToken: (outputMint: string, amountAtomic: bigint) =>
        swapUSDCForToken(outputMint, amountAtomic).pipe(
          Effect.catchAll((err) =>
            Effect.fail(
              new AdapterError({
                message: `swapUSDCForToken failed: ${String(err)}`,
                cause: err,
              }),
            ),
          ),
        ),
```

- [ ] **Step 3: Refactor `swapUSDCForSOL` to reuse `swapUSDCForToken`**

Replace the body of `swapUSDCForSOL` with a call to the new helper. Inside `swapUSDCForSOL`:

```typescript
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
              logger.info("Swapped USDC → SOL for gas", { tx: sig, amountUSDC: swapAmountUSDC }),
            ),
            Effect.catchAll((err) =>
              Effect.sync(() => logger.warn("USDC → SOL swap failed (non-fatal):", String(err))),
            ),
          );
        }).pipe(Effect.catchAll(() => Effect.void)),
```

- [ ] **Step 4: Write adapter-swap test**

Create `bench/adapter-swap.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { AdapterService } from "../engine/services.js";
import { AdapterLive } from "../engine/adapter-service.js";
import { ConfigService } from "../engine/config-service.js";
import { AuditLive } from "../engine/audit-service.js";
import { DbLive } from "../engine/db-service.js";
import { defaultAppConfig, mockFetch } from "./helpers.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

function buildLayer(): Layer.Layer<AdapterService, never, never> {
  const walletPrivateKey = bs58.encode(Keypair.generate().secretKey);
  const configLayer = Layer.succeed(
    ConfigService,
    defaultAppConfig({
      walletPrivateKey,
      solanaRpcUrl: "https://example.com",
      solanaRpcFallbackUrl: "",
      sqliteDbPath: ":memory:",
      autoUpdate: false,
      updateCheckIntervalMs: 216_000_000,
    }),
  );
  const auditLayer = Layer.provide(AuditLive, DbLive(":memory:"));
  return Layer.provide(AdapterLive, Layer.merge(configLayer, auditLayer)) as Layer.Layer<
    AdapterService,
    never,
    never
  >;
}

describe("AdapterService.swapUSDCForToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns tx signature on successful Jupiter swap", async () => {
    const restore = mockFetch((async (url: string | URL | Request) => {
      const u = url.toString();
      if (u.includes("/swap/v1/quote")) {
        return new Response(JSON.stringify({ routePlan: [] }), { status: 200 });
      }
      if (u.includes("/swap/v1/swap")) {
        return new Response(
          JSON.stringify({ swapTransaction: "AAAA" }),
          { status: 200 },
        );
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch);

    vi.spyOn(Connection.prototype, "sendRawTransaction").mockResolvedValue("mock-sig");
    vi.spyOn(Connection.prototype, "confirmTransaction").mockResolvedValue(undefined);

    try {
      const sig = await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          return yield* adapter.swapUSDCForToken(SOL_MINT, 1_000_000n);
        }).pipe(Effect.provide(buildLayer())),
      );
      expect(sig).toBe("mock-sig");
    } finally {
      restore();
    }
  });
});
```

- [ ] **Step 5: Run the new test**

Run:

```bash
bunx --bun vitest run bench/adapter-swap.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add engine/services.ts engine/adapter-service.ts bench/adapter-swap.test.ts
git commit -m "feat(adapter): add token balance, price, decimals and USDC->token swap primitives"
```

---

## Task 3: Create `EntryPrepService`

**Files:**
- Modify: `engine/services.ts`
- Create: `engine/entry-prep-service.ts`
- Test: `bench/entry-prep.test.ts`

**Interfaces:**
- Consumes: `AdapterService.getPoolState`, `AdapterService.getTokenBalance`, `AdapterService.getTokenPrices`, `AdapterService.getTokenDecimals`, `AdapterService.getNativeSolBalance`, `AdapterService.swapUSDCForToken`
- Consumes: `ConfigService.autoSwapEntry`
- Produces: `EntryPrepService.prepareEntryTokens(poolAddress: string, positionSizeUsd: number) -> Effect<void, EntryPrepError>`

- [ ] **Step 1: Add `EntryPrepService` tag and API**

In `engine/services.ts`, add the import for `EntryPrepError` at the top:

```typescript
import type { EntryPrepError } from "./errors.js";
```

Then add after `AdapterService`:

```typescript
export interface EntryPrepApi {
  readonly prepareEntryTokens: (
    poolAddress: string,
    positionSizeUsd: number,
  ) => Effect.Effect<void, EntryPrepError>;
}

export class EntryPrepService extends Context.Tag("EntryPrepService")<
  EntryPrepService,
  EntryPrepApi
>() {}
```

- [ ] **Step 2: Create `engine/entry-prep-service.ts`**

```typescript
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
              new EntryPrepError({
                code: "NO_WALLET",
                message: "No wallet configured for auto-swap entry",
                poolAddress,
              }),
            );
          }

          const pool = yield* adapter.getPoolState(poolAddress).pipe(
            Effect.mapError((err) =>
              new EntryPrepError({
                code: "PRICE_UNAVAILABLE",
                message: `Failed to fetch pool state: ${String(err)}`,
                poolAddress,
                cause: err,
              }),
            ),
          );

          const [prices, tokenXDecimals, tokenYDecimals] = yield* Effect.all(
            [
              adapter.getTokenPrices([pool.tokenX, pool.tokenY]).pipe(
                Effect.mapError((err) =>
                  new EntryPrepError({
                    code: "PRICE_UNAVAILABLE",
                    message: `Failed to fetch token prices: ${String(err)}`,
                    poolAddress,
                    cause: err,
                  }),
                ),
              ),
              adapter.getTokenDecimals(pool.tokenX).pipe(
                Effect.mapError((err) =>
                  new EntryPrepError({
                    code: "PRICE_UNAVAILABLE",
                    message: `Failed to fetch decimals for ${pool.tokenX}: ${String(err)}`,
                    poolAddress,
                    cause: err,
                  }),
                ),
              ),
              adapter.getTokenDecimals(pool.tokenY).pipe(
                Effect.mapError((err) =>
                  new EntryPrepError({
                    code: "PRICE_UNAVAILABLE",
                    message: `Failed to fetch decimals for ${pool.tokenY}: ${String(err)}`,
                    poolAddress,
                    cause: err,
                  }),
                ),
              ),
            ],
            { concurrency: "unbounded" },
          );

          const priceX = prices[pool.tokenX] ?? 0;
          const priceY = prices[pool.tokenY] ?? 0;
          if (!priceX || !priceY) {
            return yield* Effect.fail(
              new EntryPrepError({
                code: "PRICE_UNAVAILABLE",
                message: `Missing price for pool tokens: ${pool.tokenX}=${priceX}, ${pool.tokenY}=${priceY}`,
                poolAddress,
              }),
            );
          }

          const halfUsd = positionSizeUsd / 2;

          const requiredX = BigInt(
            new BN(Math.floor((halfUsd / priceX) * 10 ** tokenXDecimals)).toString(),
          );
          const requiredY = BigInt(
            new BN(Math.floor((halfUsd / priceY) * 10 ** tokenYDecimals)).toString(),
          );

          const nativeSolLamports = yield* adapter.getNativeSolBalance().pipe(
            Effect.catchAll(() => Effect.succeed(0n)),
          );

          const balanceX =
            pool.tokenX === SOL_MINT ? nativeSolLamports : yield* adapter.getTokenBalance(pool.tokenX);
          const balanceY =
            pool.tokenY === SOL_MINT ? nativeSolLamports : yield* adapter.getTokenBalance(pool.tokenY);

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
                (Number(deficit.amount) * deficit.price * 10 ** USDC_DECIMALS) /
                  10 ** deficit.decimals *
                  SWAP_INPUT_BUFFER_PCT,
              ),
            );

            if (usdcInputAtomic <= 0n) {
              return yield* Effect.fail(
                new EntryPrepError({
                  code: "SWAP_QUOTE_FAILED",
                  message: `Computed USDC input too small for ${deficit.mint}`,
                  poolAddress,
                }),
              );
            }

            const txSig = yield* adapter.swapUSDCForToken(deficit.mint, usdcInputAtomic).pipe(
              Effect.mapError((err) =>
                new EntryPrepError({
                  code: "SWAP_TRANSACTION_FAILED",
                  message: `Failed to swap USDC -> ${deficit.mint}: ${String(err)}`,
                  poolAddress,
                  cause: err,
                }),
              ),
            );

            logger.info("Swapped USDC for pool token", {
              poolAddress,
              mint: deficit.mint,
              usdcInput: formatAtomic(usdcInputAtomic, USDC_DECIMALS),
              tx: txSig,
            });
          }

          const nativeSolAfter = yield* adapter.getNativeSolBalance().pipe(
            Effect.catchAll(() => Effect.succeed(0n)),
          );
          const balanceXAfter =
            pool.tokenX === SOL_MINT
              ? nativeSolAfter
              : yield* adapter.getTokenBalance(pool.tokenX);
          const balanceYAfter =
            pool.tokenY === SOL_MINT
              ? nativeSolAfter
              : yield* adapter.getTokenBalance(pool.tokenY);

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
              new EntryPrepError({
                code: "INSUFFICIENT_BALANCE_AFTER_SWAP",
                message: `Balances still insufficient after swap: X=${formatAtomic(availableXAfter, tokenXDecimals)}/${formatAtomic(requiredX, tokenXDecimals)}, Y=${formatAtomic(availableYAfter, tokenYDecimals)}/${formatAtomic(requiredY, tokenYDecimals)}`,
                poolAddress,
              }),
            );
          }

          logger.info("Entry token preparation complete", { poolAddress });
        }).pipe(
          Effect.catchAll((err) => Effect.fail(err)),
        ),
    };

    return api;
  }),
);
```

- [ ] **Step 3: Write `EntryPrepService` tests**

Create `bench/entry-prep.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import { EntryPrepService } from "../engine/services.js";
import { EntryPrepLive } from "../engine/entry-prep-service.js";
import { AdapterService, type AdapterApi } from "../engine/services.js";
import { ConfigService } from "../engine/config-service.js";
import { defaultAppConfig } from "./helpers.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_X = SOL_MINT;
const TOKEN_Y = "FakeToken1111111111111111111111111111111111";
const POOL_ADDRESS = "TestPool111111111111111111111111111111111111";

function makeAdapter(mock: Partial<AdapterApi> = {}): AdapterApi {
  return {
    hasWallet: () => true,
    getWalletAddress: () => "mock-wallet",
    getWalletBalanceUsd: () => Effect.succeed(10_000),
    getNativeSolBalance: () => Effect.succeed(1_000_000_000n),
    getPoolState: () =>
      Effect.succeed({
        address: POOL_ADDRESS,
        tokenX: TOKEN_X,
        tokenY: TOKEN_Y,
        tokenXSymbol: "SOL",
        tokenYSymbol: "FAKE",
        tvlUsd: 100_000,
        volume24hUsd: 30_000,
        fees24hUsd: 300,
        apr: 60,
        activeBinId: 5000,
        binStep: 10,
        currentPrice: 150,
        timestamp: Date.now(),
      }),
    getBinArray: () => Effect.fail(new Error("not used")),
    getPositions: () => Effect.succeed([]),
    getAllWalletPositions: () => Effect.succeed([]),
    simulateRebalance: () =>
      Effect.succeed({ estimatedIlUsd: 0, estimatedFeesUsd: 0, netBenefitUsd: 0 }),
    enterPosition: () =>
      Effect.succeed({ positionPubKey: "mock-pos", txSignature: "mock-tx" }),
    exitPosition: () => Effect.succeed({ txSignature: "mock-tx" }),
    rebalancePosition: () =>
      Effect.succeed({ newPositionPubKey: "mock-pos", txSignatures: ["mock-tx"] }),
    claimFees: () =>
      Effect.succeed({
        txSignature: "mock-tx",
        feeX: 0,
        feeY: 0,
        platformFeeX: 0,
        platformFeeY: 0,
        netFeeX: 0,
        netFeeY: 0,
      }),
    discoverPools: () => Effect.succeed([]),
    reportFeeCollection: () => Effect.void,
    swapUSDCForSOL: () => Effect.void,
    getTokenBalance: () => Effect.succeed(0n),
    getTokenPrices: () => Effect.succeed({ [TOKEN_X]: 150, [TOKEN_Y]: 1 }),
    getTokenDecimals: () => Effect.succeed(9),
    swapUSDCForToken: () => Effect.succeed("mock-swap-tx"),
    ...mock,
  };
}

function buildLayer(adapterMock: Partial<AdapterApi> = {}, autoSwapEntry = false) {
  const adapter = makeAdapter(adapterMock);
  const adapterLayer = Layer.succeed(AdapterService, adapter);
  const configLayer = Layer.succeed(
    ConfigService,
    defaultAppConfig({ autoSwapEntry }),
  );
  return Layer.provide(EntryPrepLive, Layer.merge(adapterLayer, configLayer));
}

describe("EntryPrepService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does nothing when balances are sufficient", async () => {
    const swapSpy = vi.fn().mockReturnValue(Effect.succeed("mock-swap-tx"));
    const layer = buildLayer(
      {
        getTokenBalance: (mint: string) =>
          Effect.succeed(mint === TOKEN_X ? 10_000_000_000n : 1_000_000n),
        getTokenDecimals: (mint: string) => Effect.succeed(mint === TOKEN_X ? 9 : 6),
        swapUSDCForToken: swapSpy,
      },
      true,
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const prep = yield* EntryPrepService;
        return yield* prep.prepareEntryTokens(POOL_ADDRESS, 1_000);
      }).pipe(Effect.provide(layer)),
    );

    expect(swapSpy).not.toHaveBeenCalled();
  });

  it("skips swap when autoSwapEntry is false", async () => {
    const swapSpy = vi.fn().mockReturnValue(Effect.succeed("mock-swap-tx"));
    const layer = buildLayer(
      {
        getTokenBalance: () => Effect.succeed(0n),
        swapUSDCForToken: swapSpy,
      },
      false,
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const prep = yield* EntryPrepService;
        return yield* prep.prepareEntryTokens(POOL_ADDRESS, 1_000);
      }).pipe(Effect.provide(layer)),
    );

    expect(swapSpy).not.toHaveBeenCalled();
  });

  it("swaps USDC for one missing leg", async () => {
    const swapSpy = vi.fn().mockReturnValue(Effect.succeed("mock-swap-tx"));
    const layer = buildLayer(
      {
        getTokenBalance: (mint: string) =>
          Effect.succeed(mint === TOKEN_X ? 10_000_000_000n : 0n),
        getTokenDecimals: (mint: string) => Effect.succeed(mint === TOKEN_X ? 9 : 6),
        swapUSDCForToken: swapSpy,
      },
      true,
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const prep = yield* EntryPrepService;
        return yield* prep.prepareEntryTokens(POOL_ADDRESS, 1_000);
      }).pipe(Effect.provide(layer)),
    );

    expect(swapSpy).toHaveBeenCalledTimes(1);
    expect(swapSpy).toHaveBeenCalledWith(TOKEN_Y, expect.any(BigInt));
  });

  it("swaps USDC for both missing legs", async () => {
    const swapSpy = vi.fn().mockReturnValue(Effect.succeed("mock-swap-tx"));
    const layer = buildLayer(
      {
        getTokenBalance: () => Effect.succeed(0n),
        getTokenDecimals: (mint: string) => Effect.succeed(mint === TOKEN_X ? 9 : 6),
        swapUSDCForToken: swapSpy,
      },
      true,
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const prep = yield* EntryPrepService;
        return yield* prep.prepareEntryTokens(POOL_ADDRESS, 1_000);
      }).pipe(Effect.provide(layer)),
    );

    expect(swapSpy).toHaveBeenCalledTimes(2);
  });

  it("fails when balance is still insufficient after swap", async () => {
    const layer = buildLayer(
      {
        getTokenBalance: () => Effect.succeed(0n),
        getTokenDecimals: (mint: string) => Effect.succeed(mint === TOKEN_X ? 9 : 6),
        swapUSDCForToken: () => Effect.succeed("mock-swap-tx"),
      },
      true,
    );

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const prep = yield* EntryPrepService;
          return yield* prep.prepareEntryTokens(POOL_ADDRESS, 1_000);
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow(/INSUFFICIENT_BALANCE_AFTER_SWAP/);
  });
});
```

- [ ] **Step 4: Run the new tests**

Run:

```bash
bunx --bun vitest run bench/entry-prep.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add engine/services.ts engine/entry-prep-service.ts bench/entry-prep.test.ts
git commit -m "feat(entry-prep): add EntryPrepService to swap USDC for missing pool tokens"
```

---

## Task 4: Wire `EntryPrepService` into `program.ts`

**Files:**
- Modify: `engine/program.ts`
- Test: `bench/program.test.ts`

**Interfaces:**
- Consumes: `EntryPrepService.prepareEntryTokens`
- Produces: live `ENTER` calls `prepareEntryTokens` before `enterPosition`

- [ ] **Step 1: Import `EntryPrepService` and `EntryPrepLive`**

In `engine/program.ts`, add to the import from `./services.js`:

```typescript
  EntryPrepService,
  type /* ... existing ... */,
} from "./services.js";
```

Add a new import near the other service-live imports:

```typescript
import { EntryPrepLive } from "./entry-prep-service.js";
```

- [ ] **Step 2: Add `EntryPrepService` to `AllServices`**

In `engine/program.ts`, add `EntryPrepService` to the `AllServices` union:

```typescript
type AllServices =
  | ConfigService
  | AdapterService
  | StrategyService
  | MemoryService
  | RiskService
  | BlacklistService
  | AuditService
  | ScreenerService
  | DbService
  | RevenueService
  | RevenueConfigService
  | ReferralService
  | AgentService
  | AgentStateService
  | McpServerService
  | HttpStatusServerService
  | EntryPrepService;
```

- [ ] **Step 3: Build the `EntryPrepService` layer**

In `engine/program.ts` `buildLayer`, after `const revenueConfig = ...`, add:

```typescript
  const entryPrepDeps = Layer.merge(adapter, configLayer);
  const entryPrep = Layer.provide(EntryPrepLive, entryPrepDeps);
```

Then merge `entryPrep` into the layer chain. Change:

```typescript
  const merged11 = Layer.merge(merged10, revenueConfig);
```

To:

```typescript
  const merged11 = Layer.merge(merged10, revenueConfig);
  const merged11a = Layer.merge(merged11, entryPrep);
```

And update all subsequent references (`merged12`, `merged13`, ...) to start from `merged11a` instead of `merged11`.

- [ ] **Step 4: Consume `EntryPrepService` in live ENTER path**

In `engine/program.ts`, the `executeLive` function currently captures `adapter`, `strategy`, `db`, etc. from outer scope. Find where `executeLive` is defined and ensure `entryPrep` is in scope, or yield `EntryPrepService` inside the function.

The simplest approach is to add `const entryPrep = yield* EntryPrepService;` at the top of the `Effect.gen` inside `executeLive`, then insert the call after the SOL gas top-up block.

After the SOL balance check (around line 1830), and before the `if (decision.action === "ENTER" && decision.positionSizeUsd)` block, add:

```typescript
      if (decision.action === "ENTER" && decision.positionSizeUsd) {
        const entryPrep = yield* EntryPrepService;
        const prepResult = yield* entryPrep
          .prepareEntryTokens(decision.poolAddress, decision.positionSizeUsd)
          .pipe(
            Effect.matchEffect({
              onSuccess: () => Effect.succeed({ error: undefined as string | undefined }),
              onFailure: (err) =>
                Effect.succeed({
                  error: `Entry token preparation failed: ${err instanceof Error ? err.message : String(err)}`,
                }),
            }),
          );
        if (prepResult.error) {
          console.warn(prepResult.error, { pool: decision.poolAddress });
          return { executed: false, error: prepResult.error };
        }
      }
```

The existing `if (decision.action === "ENTER" && decision.positionSizeUsd)` block should remain after this new block.

- [ ] **Step 5: Add integration test for live ENTER path**

Open `bench/program.test.ts` and add a focused test that verifies `prepareEntryTokens` is called when `AUTO_SWAP_ENTRY=true` and the action is `ENTER`. Use the existing test helpers in that file to build the program layer.

The test should:
1. Create a mocked `EntryPrepService` layer with a `vi.fn()` spy for `prepareEntryTokens`.
2. Merge it into the program layer.
3. Trigger a live `ENTER` decision.
4. Assert `prepareEntryTokens(decision.poolAddress, decision.positionSizeUsd)` was called.

If `bench/program.test.ts` does not expose a convenient way to invoke `executeLive` directly, skip the new test in that file and rely on the `bench/entry-prep.test.ts` unit tests plus the lint/build checks.

- [ ] **Step 6: Run tests**

Run:

```bash
bunx --bun vitest run bench/program.test.ts bench/entry-prep.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add engine/program.ts bench/program.test.ts
git commit -m "feat(program): wire EntryPrepService into live ENTER path"
```

---

## Task 5: Document the new env var

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add `AUTO_SWAP_ENTRY` to `.env.example`**

Under the `# ── Features ──────────────────────────────────────────────` section, after `ENABLE_SNAPSHOT_CAPTURE=false`, add:

```bash
# Auto-swap USDC into missing pool tokens before live ENTER (default: false)
AUTO_SWAP_ENTRY=false
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs(env): document AUTO_SWAP_ENTRY option"
```

---

## Task 6: Final verification

- [ ] **Step 1: Run the full test suite**

```bash
bun run test
```

Expected: All tests pass.

- [ ] **Step 2: Run lint and typecheck**

```bash
bun run lint
```

Expected: No TypeScript or oxlint errors.

- [ ] **Step 3: Run formatter check**

```bash
bun run format:check
```

Expected: No formatting issues. If there are, run `bun run format` and commit the result.

- [ ] **Step 4: Build**

```bash
bun run build
```

Expected: Build succeeds.

- [ ] **Step 5: Final commit if formatting changed files**

```bash
git add -A
git commit -m "style: apply oxfmt"
```

---

## Spec Coverage Checklist

| Spec Requirement | Task |
|------------------|------|
| Opt-in via `AUTO_SWAP_ENTRY`, default `false` | Task 1 |
| USDC-only base token | Tasks 2 & 3 |
| Two separate swaps for 50/50 split | Task 3 |
| 50 bps slippage, hardcoded | Tasks 2 & 3 |
| Paper-trading mode unchanged | Task 4 (only wired into live `executeLive`) |
| Encapsulated `EntryPrepService` | Task 3 |
| Effect-TS service wiring | Tasks 2, 3, 4 |
| Error handling with `EntryPrepError` | Tasks 1 & 3 |
| Tests | Tasks 2, 3, 4 |
| Env var documentation | Task 5 |

## Placeholder Scan

- No `TBD`, `TODO`, or `implement later`.
- No vague "add error handling" steps.
- Every task ends with a test command and a commit.
- All file paths are exact.
