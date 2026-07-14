import { describe, it, expect, vi, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import { EntryPrepService } from "../engine/services.js";
import {
  EntryPrepLive,
  computeRequiredAtomic,
  computeUsdcInputAtomic,
} from "../engine/entry-prep-service.js";
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

  it("propagates getNativeSolBalance failure as BALANCE_READ_FAILED without swapping", async () => {
    const swapSpy = vi.fn().mockReturnValue(Effect.succeed("mock-swap-tx"));
    const layer = buildLayer(
      {
        getNativeSolBalance: () => Effect.fail(new Error("RPC down")),
        getTokenBalance: (mint: string) =>
          Effect.succeed(mint === USDC_MINT ? 10_000_000_000n : 0n),
        getTokenDecimals: (mint: string) => Effect.succeed(mint === TOKEN_X ? 9 : 6),
        swapUSDCForToken: swapSpy,
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

    expect(swapSpy).not.toHaveBeenCalled();
  });

  it("fails with INSUFFICIENT_USDC_BALANCE when a pool leg is USDC and wallet lacks it", async () => {
    const swapSpy = vi.fn().mockReturnValue(Effect.succeed("mock-swap-tx"));
    const layer = buildLayer(
      {
        getPoolState: () =>
          Effect.succeed({
            address: POOL_ADDRESS,
            tokenX: TOKEN_X,
            tokenY: USDC_MINT,
            tokenXSymbol: "SOL",
            tokenYSymbol: "USDC",
            tvlUsd: 100_000,
            volume24hUsd: 30_000,
            fees24hUsd: 300,
            apr: 60,
            activeBinId: 5000,
            binStep: 10,
            currentPrice: 1,
            timestamp: Date.now(),
          }),
        getNativeSolBalance: () => Effect.succeed(10_000_000_000n),
        getTokenBalance: (mint: string) => Effect.succeed(mint === USDC_MINT ? 100n : 0n),
        getTokenPrices: () => Effect.succeed({ [TOKEN_X]: 150, [USDC_MINT]: 1 }),
        getTokenDecimals: (mint: string) => Effect.succeed(mint === TOKEN_X ? 9 : 6),
        swapUSDCForToken: swapSpy,
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

    expect(swapSpy).not.toHaveBeenCalled();
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

  it("computes required token amounts without unsafe Number conversion", () => {
    // $0.000001 token with 9 decimals and a $100 position (halfUsd = 50).
    // The old Number path overflowed / was rejected by BN for this case.
    expect(computeRequiredAtomic(50, 0.000_001, 9)).toBe(50_000_000_000_000_000n);

    // Spot-check against the original formula for a normal-priced token.
    // $500 of SOL at $150 with 9 decimals -> floor(500/150 * 10^9) = 3_333_333_333.
    expect(computeRequiredAtomic(500, 150, 9)).toBe(3_333_333_333n);
  });

  it("fails without swapping when USDC pool leg leaves insufficient USDC for swaps", async () => {
    const swapSpy = vi.fn().mockReturnValue(Effect.succeed("mock-swap-tx"));
    const layer = buildLayer(
      {
        getPoolState: () =>
          Effect.succeed({
            address: POOL_ADDRESS,
            tokenX: TOKEN_Y,
            tokenY: USDC_MINT,
            tokenXSymbol: "FAKE",
            tokenYSymbol: "USDC",
            tvlUsd: 100_000,
            volume24hUsd: 30_000,
            fees24hUsd: 300,
            apr: 60,
            activeBinId: 5000,
            binStep: 10,
            currentPrice: 1,
            timestamp: Date.now(),
          }),
        getNativeSolBalance: () => Effect.succeed(0n),
        getTokenBalance: (mint: string) => Effect.succeed(mint === USDC_MINT ? 600_000_000n : 0n),
        getTokenPrices: () => Effect.succeed({ [TOKEN_Y]: 1, [USDC_MINT]: 1 }),
        getTokenDecimals: () => Effect.succeed(6),
        swapUSDCForToken: swapSpy,
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

    expect(swapSpy).not.toHaveBeenCalled();
  });

  it("fails with PRICE_UNAVAILABLE for infinite or negative token prices", async () => {
    const layer = buildLayer(
      {
        getTokenPrices: () =>
          Effect.succeed({ [TOKEN_X]: Number.POSITIVE_INFINITY, [TOKEN_Y]: -1 }),
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

  it("treats SOL below gas reserve as unavailable and swaps for it", async () => {
    let solBalance = 1_000_000n;
    const tokenBalances: Record<string, bigint> = { [TOKEN_Y]: 10_000_000_000n };
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

    expect(swapSpy).toHaveBeenCalledWith(SOL_MINT, expect.any(BigInt));
  });

  it("does not read native SOL balance for pools without a SOL leg", async () => {
    const OTHER_TOKEN = "OtherToken1111111111111111111111111111111";
    const swapSpy = vi.fn().mockReturnValue(Effect.succeed("mock-swap-tx"));
    const layer = buildLayer(
      {
        getPoolState: () =>
          Effect.succeed({
            address: POOL_ADDRESS,
            tokenX: TOKEN_Y,
            tokenY: OTHER_TOKEN,
            tokenXSymbol: "FAKE",
            tokenYSymbol: "OTHER",
            tvlUsd: 100_000,
            volume24hUsd: 30_000,
            fees24hUsd: 300,
            apr: 60,
            activeBinId: 5000,
            binStep: 10,
            currentPrice: 1,
            timestamp: Date.now(),
          }),
        getNativeSolBalance: () => Effect.fail(new Error("RPC down")),
        getTokenBalance: (mint: string) =>
          Effect.succeed(mint === TOKEN_Y || mint === OTHER_TOKEN ? 10_000_000_000n : 0n),
        getTokenPrices: () => Effect.succeed({ [TOKEN_Y]: 1, [OTHER_TOKEN]: 1 }),
        getTokenDecimals: () => Effect.succeed(6),
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
});
