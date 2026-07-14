import { describe, it, expect, vi, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import { EntryPrepService } from "../engine/services.js";
import { EntryPrepLive, computeUsdcInputAtomic } from "../engine/entry-prep-service.js";
import { AdapterService, type AdapterApi } from "../engine/services.js";
import { ConfigService } from "../engine/config-service.js";
import { defaultAppConfig } from "./helpers.js";
import { SOL_MINT, USDC_MINT } from "../engine/constants.js";

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
    enterPosition: () => Effect.succeed({ positionPubKey: "mock-pos", txSignature: "mock-tx" }),
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
    getTokenBalance: (mint: string) => Effect.succeed(mint === USDC_MINT ? 10_000_000_000n : 0n),
    getTokenPrices: () => Effect.succeed({ [TOKEN_X]: 150, [TOKEN_Y]: 1 }),
    getTokenDecimals: () => Effect.succeed(9),
    swapUSDCForToken: () => Effect.succeed("mock-swap-tx"),
    ...mock,
  };
}

function buildLayer(adapterMock: Partial<AdapterApi> = {}, autoSwapEntry = false) {
  const adapter = makeAdapter(adapterMock);
  const adapterLayer = Layer.succeed(AdapterService, adapter);
  const configLayer = Layer.succeed(ConfigService, defaultAppConfig({ autoSwapEntry }));
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
        getNativeSolBalance: () => Effect.succeed(10_000_000_000n),
        getTokenBalance: (mint: string) => Effect.succeed(mint === TOKEN_Y ? 500_000_000n : 0n),
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
        getNativeSolBalance: () => Effect.succeed(0n),
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
    let solBalance = 10_000_000_000n;
    const tokenBalances: Record<string, bigint> = { [TOKEN_Y]: 0n };
    const swapSpy = vi.fn((mint: string) => {
      if (mint === SOL_MINT) {
        solBalance = 10_000_000_000n;
      } else {
        tokenBalances[mint] = 10_000_000_000n;
      }
      return Effect.succeed("mock-swap-tx");
    });
    const layer = buildLayer(
      {
        getNativeSolBalance: () => Effect.succeed(solBalance),
        getTokenBalance: (mint: string) =>
          Effect.succeed(mint === USDC_MINT ? 10_000_000_000n : (tokenBalances[mint] ?? 0n)),
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
    let solBalance = 0n;
    const tokenBalances: Record<string, bigint> = { [TOKEN_Y]: 0n };
    const swapSpy = vi.fn((mint: string) => {
      if (mint === SOL_MINT) {
        solBalance = 10_000_000_000n;
      } else {
        tokenBalances[mint] = 10_000_000_000n;
      }
      return Effect.succeed("mock-swap-tx");
    });
    const layer = buildLayer(
      {
        getNativeSolBalance: () => Effect.succeed(solBalance),
        getTokenBalance: (mint: string) =>
          Effect.succeed(mint === USDC_MINT ? 10_000_000_000n : (tokenBalances[mint] ?? 0n)),
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
        getNativeSolBalance: () => Effect.succeed(0n),
        getTokenBalance: (mint: string) =>
          Effect.succeed(mint === USDC_MINT ? 10_000_000_000n : 0n),
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

  it("fails with BALANCE_READ_FAILED when a balance read fails", async () => {
    const layer = buildLayer(
      {
        getNativeSolBalance: () => Effect.succeed(10_000_000_000n),
        getTokenBalance: (mint: string) => {
          if (mint === TOKEN_Y) return Effect.fail(new Error("RPC down"));
          if (mint === USDC_MINT) return Effect.succeed(10_000_000_000n);
          return Effect.succeed(0n);
        },
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
    ).rejects.toThrow(/BALANCE_READ_FAILED/);
  });

  it("fails with PRICE_UNAVAILABLE when token prices are missing", async () => {
    const layer = buildLayer(
      {
        getNativeSolBalance: () => Effect.succeed(10_000_000_000n),
        getTokenBalance: () => Effect.succeed(0n),
        getTokenPrices: () => Effect.succeed({}),
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
    ).rejects.toThrow(/PRICE_UNAVAILABLE/);
  });

  it("fails with INSUFFICIENT_USDC_BALANCE when wallet cannot cover swaps", async () => {
    const layer = buildLayer(
      {
        getNativeSolBalance: () => Effect.succeed(10_000_000_000n),
        getTokenBalance: (mint: string) => Effect.succeed(mint === USDC_MINT ? 100n : 0n),
        getTokenDecimals: (mint: string) => Effect.succeed(mint === TOKEN_X ? 9 : 6),
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
    ).rejects.toThrow(/INSUFFICIENT_USDC_BALANCE/);
  });

  it("computes USDC input without precision loss for large amounts", () => {
    // 1 unit of a 9-decimal token at $1 with a 1% buffer -> 1.01 USDC atomic.
    expect(computeUsdcInputAtomic(1_000_000_000n, 9, 1)).toBe(1_010_000n);

    // Large amount that exceeds Number.MAX_SAFE_INTEGER; no precision loss.
    expect(computeUsdcInputAtomic(1_000_000_000_000_000_000_000n, 9, 1)).toBe(
      1_010_000_000_000_000_000n,
    );

    // Fractional case that requires ceiling.
    expect(computeUsdcInputAtomic(1n, 6, 1.234_567_89)).toBe(2n);
  });
});
