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
import { AdapterLive } from "../engine/adapter-service.js";
import { ConfigService } from "../engine/config-service.js";
import { AuditLive } from "../engine/audit-service.js";
import { DbLive } from "../engine/db-service.js";
import { defaultAppConfig } from "./helpers.js";

const POOL_ADDRESS = Keypair.generate().publicKey.toBase58();
const TOKEN_X = Keypair.generate().publicKey;
const TOKEN_Y = Keypair.generate().publicKey;
const ACTIVE_BIN_ID = 5000;
const BIN_STEP = 10;

const walletKeypair = Keypair.generate();
const walletPrivateKey = bs58.encode(walletKeypair.secretKey);

function makeFakeDlmm() {
  return {
    lbPair: {
      activeId: ACTIVE_BIN_ID,
      binStep: BIN_STEP,
      tokenXMint: TOKEN_X,
      tokenYMint: TOKEN_Y,
      reserveX: Keypair.generate().publicKey,
      reserveY: Keypair.generate().publicKey,
    },
    tokenX: { publicKey: TOKEN_X, mint: { decimals: 9 } },
    tokenY: { publicKey: TOKEN_Y, mint: { decimals: 6 } },
    getActiveBin: vi.fn(async () => ({ binId: ACTIVE_BIN_ID, price: "150" })),
    getBinsAroundActiveBin: vi.fn(async () => ({
      activeBin: ACTIVE_BIN_ID,
      bins: [{ binId: ACTIVE_BIN_ID, price: "150", xAmount: 1n, yAmount: 1n, supply: 1n }],
    })),
  };
}

const dlmmState = vi.hoisted(() => ({
  current: null as ReturnType<typeof makeFakeDlmm> | null,
}));

vi.mock("@meteora-ag/dlmm", async (importActual) => {
  const actual = await importActual<typeof import("@meteora-ag/dlmm")>();
  class FakeDLMM {
    static async create() {
      if (!dlmmState.current) throw new Error("fake DLMM instance not set");
      return dlmmState.current;
    }
  }
  return { ...actual, default: FakeDLMM };
});

function mockFetchImpl(handler: (url: string) => Promise<Response>) {
  return vi.stubGlobal(
    "fetch",
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
  return Layer.provide(AdapterLive, Layer.merge(configLayer, auditLayer)) as Layer.Layer<
    AdapterService,
    never,
    never
  >;
}

beforeEach(() => {
  dlmmState.current = makeFakeDlmm();
  // RPC surface: reserve balances for the heuristic, mint metadata, wallet.
  vi.spyOn(Connection.prototype, "getTokenAccountBalance").mockImplementation(() =>
    Promise.resolve({
      context: { slot: 1 },
      value: { amount: "1000000000", decimals: 9, uiAmount: 1, uiAmountString: "1" },
    } as unknown as never),
  );
  vi.spyOn(Connection.prototype, "getParsedAccountInfo").mockImplementation(() =>
    Promise.resolve({
      value: {
        data: { parsed: { info: { decimals: 9, symbol: "SOL" } } },
      },
    } as unknown as never),
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

    // First read within the TTL: the memo serves it.
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          yield* adapter.getPoolState(POOL_ADDRESS);
          yield* adapter.getPoolState(POOL_ADDRESS);
        }),
        layer,
      ),
    );
    expect(dlmm.getActiveBin).toHaveBeenCalledTimes(1);

    // Advance the clock past the 3s TTL on the SAME layer: the memo expires
    // and the next read must see fresh on-chain state.
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 5_000);
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          yield* adapter.getPoolState(POOL_ADDRESS);
        }),
        layer,
      ),
    );
    vi.restoreAllMocks();
    expect(dlmm.getActiveBin).toHaveBeenCalledTimes(2);
  });
});
