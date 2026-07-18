import { describe, it, expect, vi, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  StrategyType,
  type TInitializePositionAndAddLiquidityParamsByStrategy,
} from "@meteora-ag/dlmm";
import bs58 from "bs58";
import { AdapterService } from "../engine/services.js";
import { AdapterLive } from "../engine/adapter-service.js";
import { ConfigService } from "../engine/config-service.js";
import { AuditLive } from "../engine/audit-service.js";
import { DbLive } from "../engine/db-service.js";
import { defaultAppConfig, mockFetch } from "./helpers.js";

// ─── Mocked Meteora DLMM SDK ─────────────────────────────────────────────────
// The adapter must pass the configured strategy shape through to the SDK's
// StrategyType enum and use the SDK single-sided deposit path
// (StrategyParameters.singleSidedX + a zero amount on the missing leg) when
// the wallet holds only one of the pool's tokens.

const POOL_ADDRESS = Keypair.generate().publicKey.toBase58();
const TOKEN_X = new PublicKey("So11111111111111111111111111111111111111112"); // SOL, 9 decimals
const TOKEN_Y = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // USDC, 6 decimals
const ACTIVE_BIN_ID = 5000;
const BIN_STEP = 10;
const LOWER_BIN_ID = 4980;
const UPPER_BIN_ID = 5020;

// $150 position at SOL=$150 / USDC=$1.
const POSITION_SIZE_USD = 150;
const HALF_X_ATOMIC = "500000000"; // 0.5 SOL
const HALF_Y_ATOMIC = "75000000"; // 75 USDC
const FULL_X_ATOMIC = "1000000000"; // 1 SOL
const FULL_Y_ATOMIC = "150000000"; // 150 USDC

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
    // The real initializePosition ix requires the new position's signature —
    // the adapter co-signs with the position keypair, so it must be a
    // required signer in the compiled message.
    initializePositionAndAddLiquidityByStrategy: vi.fn(
      async (params: TInitializePositionAndAddLiquidityParamsByStrategy) =>
        new Transaction().add(
          new TransactionInstruction({
            keys: [{ pubkey: params.positionPubKey, isSigner: true, isWritable: true }],
            programId: Keypair.generate().publicKey,
            data: Buffer.from([1]),
          }),
        ),
    ),
  };
}

const dlmmState = vi.hoisted(() => ({
  current: null as ReturnType<typeof makeFakeDlmm> | null,
  // Wallet balances per test: SPL token balances by mint, native SOL lamports.
  tokenBalances: new Map<string, bigint>(),
  nativeLamports: 0n,
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

// ─── Adapter layer wiring (mirrors bench/adapter-rebalance.test.ts) ─────────

const walletKeypair = Keypair.generate();
const walletPrivateKey = bs58.encode(walletKeypair.secretKey);

function makeAdapterLayer(
  overrides: Parameters<typeof defaultAppConfig>[0] = {},
): Layer.Layer<AdapterService, never, never> {
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
      ...overrides,
    }),
  );
  const auditLayer = Layer.provide(AuditLive, DbLive(":memory:"));
  return Layer.provide(AdapterLive, Layer.merge(configLayer, auditLayer)) as Layer.Layer<
    AdapterService,
    never,
    never
  >;
}

async function runEnter(
  options?: { strategyShape?: "spot" | "curve" | "bidask" },
  configOverrides: Parameters<typeof defaultAppConfig>[0] = {},
) {
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const adapter = yield* AdapterService;
        return yield* adapter.enterPosition(
          POOL_ADDRESS,
          LOWER_BIN_ID,
          UPPER_BIN_ID,
          POSITION_SIZE_USD,
          options,
        );
      }),
      makeAdapterLayer(configOverrides),
    ) as Effect.Effect<
      {
        positionPubKey: string;
        txSignature: string;
        depositMode: string;
        amountXUsd: number;
        amountYUsd: number;
      },
      unknown,
      never
    >,
  );
}

function setupFakeDlmm() {
  const fake = makeFakeDlmm();
  dlmmState.current = fake;
  return fake;
}

function mockRpcAndBalances() {
  vi.spyOn(Connection.prototype, "getLatestBlockhash").mockResolvedValue({
    blockhash: bs58.encode(new Uint8Array(32).fill(7)),
    lastValidBlockHeight: 1_000_000,
  });
  vi.spyOn(Connection.prototype, "sendRawTransaction").mockResolvedValue("mock-sig-1");
  vi.spyOn(Connection.prototype, "confirmTransaction").mockImplementation(() =>
    Promise.resolve(undefined as unknown as never),
  );
  vi.spyOn(Connection.prototype, "getBalance").mockImplementation(() =>
    Promise.resolve(Number(dlmmState.nativeLamports)),
  );
  vi.spyOn(Connection.prototype, "getParsedTokenAccountsByOwner").mockImplementation(
    (_owner, filter) => {
      const mint = (filter as { mint: PublicKey }).mint.toBase58();
      const amount = dlmmState.tokenBalances.get(mint) ?? 0n;
      const value =
        amount === 0n
          ? []
          : [
              {
                pubkey: Keypair.generate().publicKey,
                account: {
                  data: {
                    parsed: { info: { tokenAmount: { amount: amount.toString() } } },
                  },
                },
              },
            ];
      return Promise.resolve({ context: { slot: 1 }, value } as unknown as never);
    },
  );
  vi.spyOn(Connection.prototype, "getTokenAccountBalance").mockImplementation(() =>
    Promise.resolve({
      context: { slot: 1 },
      value: { amount: "1000000000", decimals: 9, uiAmount: 1, uiAmountString: "1" },
    } as unknown as never),
  );
}

function mockTokenPrices(): () => void {
  return mockFetch((async (url: string | URL | Request) => {
    const u = url.toString();
    if (u.includes("api.jup.ag/price/v3")) {
      return new Response(
        JSON.stringify({
          [TOKEN_X.toBase58()]: { usdPrice: 150 },
          [TOKEN_Y.toBase58()]: { usdPrice: 1 },
        }),
        { status: 200 },
      );
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch);
}

function capturedStrategy() {
  const fake = dlmmState.current!;
  expect(fake.initializePositionAndAddLiquidityByStrategy).toHaveBeenCalledTimes(1);
  const params = fake.initializePositionAndAddLiquidityByStrategy.mock
    .calls[0]![0] as TInitializePositionAndAddLiquidityParamsByStrategy;
  return params;
}

afterEach(() => {
  vi.restoreAllMocks();
  dlmmState.current = null;
  dlmmState.tokenBalances = new Map();
  dlmmState.nativeLamports = 0n;
});

describe("adapter.enterPosition (strategy shapes + single-sided)", () => {
  it("passes StrategyType.Spot for a two-sided entry by default", async () => {
    setupFakeDlmm();
    mockRpcAndBalances();
    const restore = mockTokenPrices();
    dlmmState.nativeLamports = 2_000_000_000n; // 2 SOL
    dlmmState.tokenBalances = new Map([[TOKEN_Y.toBase58(), 200_000_000n]]); // 200 USDC

    try {
      const result = await runEnter();

      expect(result.txSignature).toBe("mock-sig-1");
      expect(result.depositMode).toBe("two-sided");
      expect(result.amountXUsd).toBe(75);
      expect(result.amountYUsd).toBe(75);

      const params = capturedStrategy();
      expect(params.strategy.minBinId).toBe(LOWER_BIN_ID);
      expect(params.strategy.maxBinId).toBe(UPPER_BIN_ID);
      expect(params.strategy.strategyType).toBe(StrategyType.Spot);
      // Two-sided deposits never set the single-sided flag.
      expect("singleSidedX" in params.strategy).toBe(false);
      expect(params.totalXAmount.toString()).toBe(HALF_X_ATOMIC);
      expect(params.totalYAmount.toString()).toBe(HALF_Y_ATOMIC);
    } finally {
      restore();
    }
  });

  it("maps ENTRY_STRATEGY_TYPE=curve to StrategyType.Curve", async () => {
    setupFakeDlmm();
    mockRpcAndBalances();
    const restore = mockTokenPrices();
    dlmmState.nativeLamports = 2_000_000_000n;
    dlmmState.tokenBalances = new Map([[TOKEN_Y.toBase58(), 200_000_000n]]);

    try {
      await runEnter(undefined, { entryStrategyType: "curve" });
      expect(capturedStrategy().strategy.strategyType).toBe(StrategyType.Curve);
    } finally {
      restore();
    }
  });

  it("maps ENTRY_STRATEGY_TYPE=bidask to StrategyType.BidAsk", async () => {
    setupFakeDlmm();
    mockRpcAndBalances();
    const restore = mockTokenPrices();
    dlmmState.nativeLamports = 2_000_000_000n;
    dlmmState.tokenBalances = new Map([[TOKEN_Y.toBase58(), 200_000_000n]]);

    try {
      await runEnter(undefined, { entryStrategyType: "bidask" });
      expect(capturedStrategy().strategy.strategyType).toBe(StrategyType.BidAsk);
    } finally {
      restore();
    }
  });

  it("lets the caller override the configured shape (auto regime resolution)", async () => {
    setupFakeDlmm();
    mockRpcAndBalances();
    const restore = mockTokenPrices();
    dlmmState.nativeLamports = 2_000_000_000n;
    dlmmState.tokenBalances = new Map([[TOKEN_Y.toBase58(), 200_000_000n]]);

    try {
      await runEnter({ strategyShape: "bidask" }, { entryStrategyType: "spot" });
      expect(capturedStrategy().strategy.strategyType).toBe(StrategyType.BidAsk);
    } finally {
      restore();
    }
  });

  it("falls back to Spot for ENTRY_STRATEGY_TYPE=auto without a resolved shape", async () => {
    setupFakeDlmm();
    mockRpcAndBalances();
    const restore = mockTokenPrices();
    dlmmState.nativeLamports = 2_000_000_000n;
    dlmmState.tokenBalances = new Map([[TOKEN_Y.toBase58(), 200_000_000n]]);

    try {
      await runEnter(undefined, { entryStrategyType: "auto" });
      expect(capturedStrategy().strategy.strategyType).toBe(StrategyType.Spot);
    } finally {
      restore();
    }
  });

  it("deposits single-sided X when the Y leg is unavailable, flagging singleSidedX", async () => {
    setupFakeDlmm();
    mockRpcAndBalances();
    const restore = mockTokenPrices();
    dlmmState.nativeLamports = 2_000_000_000n; // 2 SOL covers the full $150
    dlmmState.tokenBalances = new Map([[TOKEN_Y.toBase58(), 0n]]); // no USDC

    try {
      const result = await runEnter();

      expect(result.depositMode).toBe("single-sided-x");
      expect(result.amountXUsd).toBe(150);
      expect(result.amountYUsd).toBe(0);

      const params = capturedStrategy();
      expect(params.strategy.singleSidedX).toBe(true);
      // Full position size goes into the held leg; the missing leg is zero.
      expect(params.totalXAmount.toString()).toBe(FULL_X_ATOMIC);
      expect(params.totalYAmount.toString()).toBe("0");
    } finally {
      restore();
    }
  });

  it("deposits single-sided Y when the X leg is unavailable, clearing singleSidedX", async () => {
    setupFakeDlmm();
    mockRpcAndBalances();
    const restore = mockTokenPrices();
    // 0.1 SOL: after the gas reserve the X leg cannot fund its $75 half, but
    // the wallet still pays entry gas.
    dlmmState.nativeLamports = 100_000_000n;
    dlmmState.tokenBalances = new Map([[TOKEN_Y.toBase58(), 300_000_000n]]); // 300 USDC

    try {
      const result = await runEnter();

      expect(result.depositMode).toBe("single-sided-y");
      expect(result.amountXUsd).toBe(0);
      expect(result.amountYUsd).toBe(150);

      const params = capturedStrategy();
      expect(params.strategy.singleSidedX).toBe(false);
      expect(params.totalXAmount.toString()).toBe("0");
      expect(params.totalYAmount.toString()).toBe(FULL_Y_ATOMIC);
    } finally {
      restore();
    }
  });

  it("combines the configured shape with the single-sided flag", async () => {
    setupFakeDlmm();
    mockRpcAndBalances();
    const restore = mockTokenPrices();
    dlmmState.nativeLamports = 2_000_000_000n;
    dlmmState.tokenBalances = new Map([[TOKEN_Y.toBase58(), 0n]]);

    try {
      await runEnter(undefined, { entryStrategyType: "curve" });
      const params = capturedStrategy();
      expect(params.strategy.strategyType).toBe(StrategyType.Curve);
      expect(params.strategy.singleSidedX).toBe(true);
    } finally {
      restore();
    }
  });

  it("fails closed with a clear error when the wallet holds neither pool token", async () => {
    setupFakeDlmm();
    mockRpcAndBalances();
    const restore = mockTokenPrices();
    dlmmState.nativeLamports = 100_000_000n; // X leg short after gas reserve
    dlmmState.tokenBalances = new Map([[TOKEN_Y.toBase58(), 10_000_000n]]); // $10 < $75 half

    try {
      const err = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const adapter = yield* AdapterService;
            return yield* adapter
              .enterPosition(POOL_ADDRESS, LOWER_BIN_ID, UPPER_BIN_ID, POSITION_SIZE_USD)
              .pipe(Effect.flip);
          }),
          makeAdapterLayer(),
        ) as Effect.Effect<{ message: string }, never, never>,
      );

      expect(err.message).toContain("Failed to enter position");
      expect(err.message).toContain("Insufficient token balance");
      expect(err.message).toContain("single-sided");
      expect(dlmmState.current!.initializePositionAndAddLiquidityByStrategy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("fails closed when the held leg cannot fund the full single-sided size", async () => {
    setupFakeDlmm();
    mockRpcAndBalances();
    const restore = mockTokenPrices();
    // 0.6 SOL funds the $75 half but not the $150 single-sided deposit.
    dlmmState.nativeLamports = 600_000_000n;
    dlmmState.tokenBalances = new Map([[TOKEN_Y.toBase58(), 0n]]);

    try {
      const err = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const adapter = yield* AdapterService;
            return yield* adapter
              .enterPosition(POOL_ADDRESS, LOWER_BIN_ID, UPPER_BIN_ID, POSITION_SIZE_USD)
              .pipe(Effect.flip);
          }),
          makeAdapterLayer(),
        ) as Effect.Effect<{ message: string }, never, never>,
      );

      expect(err.message).toContain("Failed to enter position");
      expect(err.message).toContain("Single-sided");
      expect(dlmmState.current!.initializePositionAndAddLiquidityByStrategy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
