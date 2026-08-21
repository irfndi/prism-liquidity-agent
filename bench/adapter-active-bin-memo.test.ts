/**
 * Active-bin memoization (RPC dedup): getPoolState + getBinArray previously
 * fetched the active bin TWICE per pool per cycle, and getBinsAroundActiveBin
 * re-fetched the same bin array getActiveBin just loaded (~3 wasted RPCs).
 * The short-TTL memo must make the within-cycle pair share ONE SDK fetch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { Effect, Layer } from "effect";
import { AdapterService } from "../engine/services.js";
import { makeAdapterLive, type MeteoraDlmmClient } from "../engine/adapter-service.js";
import { ConfigService } from "../engine/config-service.js";
import { AuditLive } from "../engine/audit-service.js";
import { DbLive } from "../engine/db-service.js";
import { defaultAppConfig, asOwner } from "./helpers.js";
import { unsupportedDlmmMethods } from "./dlmm-test-double.js";

const POOL_ADDRESS = Keypair.generate().publicKey.toBase58();
const TOKEN_X = Keypair.generate().publicKey;
const TOKEN_Y = Keypair.generate().publicKey;
const ACTIVE_BIN_ID = 5000;
const BIN_STEP = 10;

const walletKeypair = Keypair.generate();
const walletPrivateKey = bs58.encode(walletKeypair.secretKey);

function makeFakeDlmm() {
  return {
    ...unsupportedDlmmMethods,
    lbPair: {
      activeId: ACTIVE_BIN_ID,
      binStep: BIN_STEP,
      tokenXMint: TOKEN_X,
      tokenYMint: TOKEN_Y,
      reserveX: Keypair.generate().publicKey,
      reserveY: Keypair.generate().publicKey,
      rewardInfos: [],
    },
    tokenX: { publicKey: TOKEN_X, mint: { decimals: 9 } },
    tokenY: { publicKey: TOKEN_Y, mint: { decimals: 6 } },
    getActiveBin: vi.fn(async () => ({
      binId: ACTIVE_BIN_ID,
      price: "150",
      pricePerToken: "150",
    })),
    getBinsAroundActiveBin: vi.fn(async () => ({
      activeBin: ACTIVE_BIN_ID,
      bins: [
        {
          binId: ACTIVE_BIN_ID,
          price: "150",
          pricePerToken: "150",
          xAmount: 1n,
          yAmount: 1n,
          supply: 1n,
        },
      ],
    })),
  } satisfies MeteoraDlmmClient;
}

const dlmmState = vi.hoisted(() => ({
  // SAFETY: This test fixture is constructed to satisfy the asserted service/domain contract and is exercised by the surrounding test.
  current: null as ReturnType<typeof makeFakeDlmm> | null,
}));

const createFakeDlmm = async () => {
  if (!dlmmState.current) throw new Error("fake DLMM instance not set");
  const fake = dlmmState.current;
  if (!fake) throw new Error("fake DLMM instance not set");
  return fake;
};

function mockFetchImpl(handler: (url: string) => Promise<Response>) {
  return vi.stubGlobal(
    "fetch",
    // SAFETY: The value is intentionally opaque at this boundary and is validated by the enclosing parser or schema before domain use.
    vi.fn(async (url: string | URL | Request) => handler(String(url as unknown))),
  );
}

function makeAdapterLayer(): Layer.Layer<AdapterService, never, never> {
  const configLayer = Layer.succeed(
    ConfigService,
    defaultAppConfig({
      walletPrivateKey,
      solanaRpcUrl: "https://example.com",
      solanaRpcFallbackUrl: "",
      sqliteDbPath: ":memory:",
      autoUpdate: false,
      paperTrading: false,
      solPriceUsd: 150,
    }),
  );
  const auditLayer = Layer.provide(AuditLive, DbLive(":memory:"));
  // SAFETY: This test fixture is constructed to satisfy the asserted service/domain contract and is exercised by the surrounding test.
  return Layer.provide(
    makeAdapterLive(createFakeDlmm),
    Layer.merge(configLayer, Layer.merge(auditLayer, DbLive(":memory:"))),
  ) as Layer.Layer<AdapterService, never, never>;
}

beforeEach(() => {
  dlmmState.current = makeFakeDlmm();
  // RPC surface: reserve balances for the heuristic, mint metadata, wallet.
  vi.spyOn(Connection.prototype, "getTokenAccountBalance").mockImplementation(() =>
    asOwner<never>(
      Promise.resolve({
        context: { slot: 1 },
        value: { amount: "1000000000", decimals: 9, uiAmount: 1, uiAmountString: "1" },
      }),
    ),
  );
  vi.spyOn(Connection.prototype, "getParsedAccountInfo").mockImplementation(() =>
    asOwner<never>(
      Promise.resolve({
        value: {
          data: { parsed: { info: { decimals: 9, symbol: "SOL" } } },
        },
      }),
    ),
  );
  vi.spyOn(Connection.prototype, "getBalance").mockResolvedValue(0);
  mockFetchImpl(async (url: string) => {
    if (url.includes("api.jup.ag/price/v3")) {
      return new Response(
        JSON.stringify({
          [TOKEN_X.toBase58()]: { usdPrice: 150 },
          [TOKEN_Y.toBase58()]: { usdPrice: 1 },
        }),
        { status: 200 },
      );
    }
    return new Response("unexpected", { status: 500 });
  });
});

describe("active-bin memoization (RPC dedup)", () => {
  it("fetches the active bin and bin array ONCE across getPoolState + getBinArray", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          yield* adapter.getPoolState(POOL_ADDRESS);
          yield* adapter.getBinArray(POOL_ADDRESS);
        }),
        makeAdapterLayer(),
      ),
    );

    const dlmm = dlmmState.current!;
    expect(dlmm.getActiveBin).toHaveBeenCalledTimes(1);
    expect(dlmm.getBinsAroundActiveBin).toHaveBeenCalledTimes(1);
  });

  it("refetches after the memo expires (a later cycle sees fresh state)", async () => {
    const layer = makeAdapterLayer();
    const dlmm = dlmmState.current!;
    const realNow = Date.now.bind(Date);
    let fakeNow = realNow();
    vi.spyOn(Date, "now").mockImplementation(() => fakeNow);

    // ONE adapter lifetime (one provide): the TTL expiry must be exercised
    // against the same memo map, not a fresh layer per read.
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          // First reads within the TTL: the memo serves both.
          yield* adapter.getPoolState(POOL_ADDRESS);
          yield* adapter.getPoolState(POOL_ADDRESS);
          expect(dlmm.getActiveBin).toHaveBeenCalledTimes(1);

          // Advance the clock past the 3s TTL: the next read must refetch.
          fakeNow += 5_000;
          yield* adapter.getPoolState(POOL_ADDRESS);
        }),
        layer,
      ),
    );
    vi.restoreAllMocks();
    expect(dlmm.getActiveBin).toHaveBeenCalledTimes(2);
  });

  it("expires the bins memo half too (getBinArray refetches past the TTL)", async () => {
    const layer = makeAdapterLayer();
    const dlmm = dlmmState.current!;
    const realNow = Date.now.bind(Date);
    let fakeNow = realNow();
    vi.spyOn(Date, "now").mockImplementation(() => fakeNow);

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          yield* adapter.getBinArray(POOL_ADDRESS);
          yield* adapter.getBinArray(POOL_ADDRESS);
          expect(dlmm.getBinsAroundActiveBin).toHaveBeenCalledTimes(1);

          fakeNow += 5_000;
          yield* adapter.getBinArray(POOL_ADDRESS);
        }),
        layer,
      ),
    );
    vi.restoreAllMocks();
    expect(dlmm.getBinsAroundActiveBin).toHaveBeenCalledTimes(2);
  });

  it("getPriceScale returns 10^(decX - decY) without fetching the active bin", async () => {
    const layer = makeAdapterLayer();
    // Fake DLMM already carries tokenX.mint.decimals = 9, tokenY.mint.decimals = 6.

    const factor = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          return yield* adapter.getPriceScale!(POOL_ADDRESS);
        }),
        layer,
      ),
    );

    expect(factor).toBeCloseTo(1000, 6);
    expect(dlmmState.current!.getActiveBin).not.toHaveBeenCalled();
  });
});
