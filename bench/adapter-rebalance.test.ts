import { describe, it, expect, vi, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  buildLiquidityStrategyParameters,
  getLiquidityStrategyParameterBuilder,
  StrategyType,
} from "@meteora-ag/dlmm";
import bs58 from "bs58";
import { AdapterService } from "../engine/services.js";
import { AdapterLive } from "../engine/adapter-service.js";
import { ConfigService } from "../engine/config-service.js";
import { AuditLive } from "../engine/audit-service.js";
import { DbLive } from "../engine/db-service.js";
import { defaultAppConfig, mockFetch } from "./helpers.js";

// ─── Mocked Meteora DLMM SDK ─────────────────────────────────────────────────
// The adapter must drive the SDK's atomic rebalance path
// (simulateRebalancePosition → rebalancePosition) and must never fall back to
// removeLiquidity + initializePositionAndAddLiquidityByStrategy.

const POOL_ADDRESS = Keypair.generate().publicKey.toBase58();
const POSITION_ADDRESS = Keypair.generate().publicKey.toBase58();
const TOKEN_X = new PublicKey("So11111111111111111111111111111111111111112");
const TOKEN_Y = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const ACTIVE_BIN_ID = 5000;
const BIN_STEP = 10;
// SDK rent quote constants (SOL) mirrored from @meteora-ag/dlmm internals:
// BIN_ARRAY_FEE = 0.07143744, BIN_ARRAY_BITMAP_FEE = 0.01180416.
const BIN_ARRAY_FEE_SOL = 0.07143744;
const BITMAP_FEE_SOL = 0.01180416;

interface FakePositionData {
  totalXAmount: string;
  totalYAmount: string;
  lowerBinId: number;
  upperBinId: number;
  feeX: BN;
  feeY: BN;
}

function makePositionData(overrides: Partial<FakePositionData> = {}): FakePositionData {
  return {
    totalXAmount: "2000000000", // 2 SOL (9 decimals)
    totalYAmount: "300000000", // 300 USDC (6 decimals)
    lowerBinId: 4960,
    upperBinId: 4980,
    feeX: new BN(1_000_000_000), // 1 SOL claimable
    feeY: new BN(50_000_000), // 50 USDC claimable
    ...overrides,
  };
}

function makeIx(): TransactionInstruction {
  return new TransactionInstruction({
    keys: [],
    programId: Keypair.generate().publicKey,
    data: Buffer.from([1]),
  });
}

const FORBIDDEN_CLOSE_REOPEN = {
  removeLiquidity: vi.fn(async () => {
    throw new Error("removeLiquidity must not be called — atomic rebalance only");
  }),
  initializePositionAndAddLiquidityByStrategy: vi.fn(async () => {
    throw new Error(
      "initializePositionAndAddLiquidityByStrategy must not be called — atomic rebalance only",
    );
  }),
};

function makeFakeDlmm(opts: {
  positionData: FakePositionData;
  binArrayCount?: number;
  bitmapExtensionCost?: number;
  simulateError?: Error;
  rebalanceError?: Error;
}) {
  const binArrayCount = opts.binArrayCount ?? 2;
  const simulation = {
    rebalancePosition: { address: new PublicKey(POSITION_ADDRESS) },
    simulationResult: { actualAmountXDeposited: new BN(0) },
    binArrayCost: binArrayCount * BIN_ARRAY_FEE_SOL,
    binArrayCount,
    binArrayExistence: new Set<string>(),
    bitmapExtensionCost: opts.bitmapExtensionCost ?? BITMAP_FEE_SOL,
  };
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
    refetchStates: vi.fn(async () => {}),
    getPosition: vi.fn(async (pubkey: PublicKey) => ({
      publicKey: pubkey,
      positionData: opts.positionData,
    })),
    simulateRebalancePosition: opts.simulateError
      ? vi.fn(
          async (
            _positionAddress: PublicKey,
            _positionData: unknown,
            _shouldClaimFee: boolean,
            _shouldClaimReward: boolean,
            _deposits: unknown,
            _withdraws: unknown,
          ) => {
            throw opts.simulateError;
          },
        )
      : vi.fn(
          async (
            _positionAddress: PublicKey,
            _positionData: unknown,
            _shouldClaimFee: boolean,
            _shouldClaimReward: boolean,
            _deposits: unknown,
            _withdraws: unknown,
          ) => simulation,
        ),
    rebalancePosition: opts.rebalanceError
      ? vi.fn(async () => {
          throw opts.rebalanceError;
        })
      : vi.fn(async () => ({
          initBinArrayInstructions: [makeIx()],
          rebalancePositionInstruction: [makeIx(), makeIx()],
        })),
    ...FORBIDDEN_CLOSE_REOPEN,
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

// ─── Adapter layer wiring (mirrors bench/adapter-swap.test.ts) ──────────────

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

async function runWithAdapter<A, E>(effect: Effect.Effect<A, E, AdapterService>): Promise<A> {
  return Effect.runPromise(
    Effect.provide(effect, makeAdapterLayer()) as Effect.Effect<A, E, never>,
  );
}

/** Mock the blockhash/send/confirm surface and capture every sent transaction. */
function mockRpcSendPipeline(): Transaction[] {
  const sent: Transaction[] = [];
  vi.spyOn(Connection.prototype, "getLatestBlockhash").mockResolvedValue({
    blockhash: bs58.encode(new Uint8Array(32).fill(7)),
    lastValidBlockHeight: 1_000_000,
  });
  let n = 0;
  vi.spyOn(Connection.prototype, "sendRawTransaction").mockImplementation((raw) => {
    sent.push(Transaction.from(Buffer.from(raw as Uint8Array)));
    n += 1;
    return Promise.resolve(`mock-sig-${n}`);
  });
  vi.spyOn(Connection.prototype, "confirmTransaction").mockImplementation(() =>
    Promise.resolve(undefined as unknown as never),
  );
  return sent;
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

afterEach(() => {
  vi.restoreAllMocks();
  dlmmState.current = null;
});

// ─── Atomic rebalance execution ──────────────────────────────────────────────

describe("adapter.rebalancePosition (atomic via SDK rebalancePosition)", () => {
  it("preserves the position pubkey and never closes+reopens the position", async () => {
    const positionData = makePositionData();
    const fake = makeFakeDlmm({ positionData });
    dlmmState.current = fake;
    const sent = mockRpcSendPipeline();

    const result = await runWithAdapter(
      Effect.gen(function* () {
        const adapter = yield* AdapterService;
        return yield* adapter.rebalancePosition(POOL_ADDRESS, POSITION_ADDRESS, 4990, 5030);
      }),
    );

    // Identity preserved — the same position account, not a new keypair.
    expect(result.positionPubKey).toBe(POSITION_ADDRESS);
    // Close+reopen building blocks must never run.
    expect(fake.removeLiquidity).not.toHaveBeenCalled();
    expect(fake.initializePositionAndAddLiquidityByStrategy).not.toHaveBeenCalled();
    // Simulation first, then instruction building.
    expect(fake.simulateRebalancePosition).toHaveBeenCalledTimes(1);
    expect(fake.rebalancePosition).toHaveBeenCalledTimes(1);
    // Fees/rewards are claimed by the engine's own claim path — the atomic
    // instruction must not double-claim them.
    const simArgs = fake.simulateRebalancePosition.mock.calls[0]!;
    expect(simArgs[0].toBase58()).toBe(POSITION_ADDRESS);
    expect(simArgs[2]).toBe(false); // shouldClaimFee
    expect(simArgs[3]).toBe(false); // shouldClaimReward
    // Init-bin-array tx is sent and confirmed before the rebalance tx.
    expect(sent).toHaveLength(2);
    expect(sent[0]!.instructions).toHaveLength(1);
    expect(sent[1]!.instructions).toHaveLength(2);
    expect(result.txSignatures).toEqual(["mock-sig-1", "mock-sig-2"]);
  });

  it("sends a single transaction when no bin arrays need initialization", async () => {
    dlmmState.current = makeFakeDlmm({ positionData: makePositionData(), binArrayCount: 0 });
    const noInitFake = dlmmState.current;
    noInitFake.rebalancePosition = vi.fn(async () => ({
      initBinArrayInstructions: [],
      rebalancePositionInstruction: [makeIx(), makeIx()],
    }));
    const sent = mockRpcSendPipeline();

    const result = await runWithAdapter(
      Effect.gen(function* () {
        const adapter = yield* AdapterService;
        return yield* adapter.rebalancePosition(POOL_ADDRESS, POSITION_ADDRESS, 4990, 5030);
      }),
    );

    expect(sent).toHaveLength(1);
    expect(result.positionPubKey).toBe(POSITION_ADDRESS);
    expect(result.txSignatures).toEqual(["mock-sig-1"]);
  });

  it("sizes the rebalance from the position's on-chain liquidity, not paper config", async () => {
    const positionData = makePositionData();
    const fake = makeFakeDlmm({ positionData });
    dlmmState.current = fake;
    mockRpcSendPipeline();

    await runWithAdapter(
      Effect.gen(function* () {
        const adapter = yield* AdapterService;
        return yield* adapter.rebalancePosition(POOL_ADDRESS, POSITION_ADDRESS, 4990, 5030);
      }),
    );

    const simArgs = fake.simulateRebalancePosition.mock.calls[0]!;
    const deposits = simArgs[4] as Array<Record<string, BN>>;
    const withdraws = simArgs[5] as Array<{ minBinId: BN; maxBinId: BN; bps: BN }>;

    // Withdraws 100% of the position's current range — the full on-chain
    // liquidity is reshaped, never a paperPortfolioUsd-derived amount.
    expect(withdraws).toHaveLength(1);
    expect(withdraws[0]!.minBinId.toNumber()).toBe(4960);
    expect(withdraws[0]!.maxBinId.toNumber()).toBe(4980);
    expect(withdraws[0]!.bps.toNumber()).toBe(10_000);

    // Deposit strategy params are derived from the position's real token
    // amounts around the fresh active bin.
    const expected = buildLiquidityStrategyParameters(
      new BN(positionData.totalXAmount),
      new BN(positionData.totalYAmount),
      new BN(4990 - ACTIVE_BIN_ID),
      new BN(5030 - ACTIVE_BIN_ID),
      new BN(BIN_STEP),
      false,
      new BN(ACTIVE_BIN_ID),
      getLiquidityStrategyParameterBuilder(StrategyType.Spot),
    );
    expect(deposits).toHaveLength(1);
    expect(deposits[0]!.minDeltaId.toNumber()).toBe(4990 - ACTIVE_BIN_ID);
    expect(deposits[0]!.maxDeltaId.toNumber()).toBe(5030 - ACTIVE_BIN_ID);
    expect(deposits[0]!.x0.toString()).toBe(expected.x0.toString());
    expect(deposits[0]!.y0.toString()).toBe(expected.y0.toString());
    expect(deposits[0]!.deltaX.toString()).toBe(expected.deltaX.toString());
    expect(deposits[0]!.deltaY.toString()).toBe(expected.deltaY.toString());
  });

  it("adds explicit top-up amounts to the reshaped liquidity (auto-compound)", async () => {
    const positionData = makePositionData();
    const fake = makeFakeDlmm({ positionData });
    dlmmState.current = fake;
    mockRpcSendPipeline();

    await runWithAdapter(
      Effect.gen(function* () {
        const adapter = yield* AdapterService;
        return yield* adapter.rebalancePosition(POOL_ADDRESS, POSITION_ADDRESS, 4960, 4980, {
          amountXAtomic: 1_000_000_000n,
          amountYAtomic: 50_000_000n,
        });
      }),
    );

    const simArgs = fake.simulateRebalancePosition.mock.calls[0]!;
    const deposits = simArgs[4] as Array<Record<string, BN>>;
    const expected = buildLiquidityStrategyParameters(
      new BN(positionData.totalXAmount).add(new BN(1_000_000_000)),
      new BN(positionData.totalYAmount).add(new BN(50_000_000)),
      new BN(4960 - ACTIVE_BIN_ID),
      new BN(4980 - ACTIVE_BIN_ID),
      new BN(BIN_STEP),
      false,
      new BN(ACTIVE_BIN_ID),
      getLiquidityStrategyParameterBuilder(StrategyType.Spot),
    );
    expect(deposits[0]!.x0.toString()).toBe(expected.x0.toString());
    expect(deposits[0]!.y0.toString()).toBe(expected.y0.toString());
    expect(deposits[0]!.deltaX.toString()).toBe(expected.deltaX.toString());
    expect(deposits[0]!.deltaY.toString()).toBe(expected.deltaY.toString());
  });

  it("fails without sending any transaction when the SDK simulation throws", async () => {
    const fake = makeFakeDlmm({
      positionData: makePositionData(),
      simulateError: new Error("simulation reverted"),
    });
    dlmmState.current = fake;
    const sent = mockRpcSendPipeline();

    const err = await runWithAdapter(
      Effect.gen(function* () {
        const adapter = yield* AdapterService;
        return yield* adapter
          .rebalancePosition(POOL_ADDRESS, POSITION_ADDRESS, 4990, 5030)
          .pipe(Effect.flip);
      }),
    );

    expect((err as { message: string }).message).toContain("simulation reverted");
    expect(sent).toHaveLength(0);
    expect(fake.rebalancePosition).not.toHaveBeenCalled();
  });

  it("fails without sending any transaction when instruction building throws", async () => {
    const fake = makeFakeDlmm({
      positionData: makePositionData(),
      rebalanceError: new Error("account fetch failed"),
    });
    dlmmState.current = fake;
    const sent = mockRpcSendPipeline();

    const err = await runWithAdapter(
      Effect.gen(function* () {
        const adapter = yield* AdapterService;
        return yield* adapter
          .rebalancePosition(POOL_ADDRESS, POSITION_ADDRESS, 4990, 5030)
          .pipe(Effect.flip);
      }),
    );

    expect((err as { message: string }).message).toContain("account fetch failed");
    expect(sent).toHaveLength(0);
  });

  it("fails closed when no wallet is configured", async () => {
    dlmmState.current = makeFakeDlmm({ positionData: makePositionData() });
    const configLayer = Layer.succeed(
      ConfigService,
      defaultAppConfig({
        walletPrivateKey: "",
        solanaRpcUrl: "https://example.com",
        sqliteDbPath: ":memory:",
        autoUpdate: false,
        paperTrading: false,
      }),
    );
    const auditLayer = Layer.provide(AuditLive, DbLive(":memory:"));
    const layer = Layer.provide(AdapterLive, Layer.merge(configLayer, auditLayer)) as Layer.Layer<
      AdapterService,
      never,
      never
    >;

    const err = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          return yield* adapter
            .rebalancePosition(POOL_ADDRESS, POSITION_ADDRESS, 4990, 5030)
            .pipe(Effect.flip);
        }),
        layer,
      ) as Effect.Effect<unknown, never, never>,
    );

    expect((err as { message: string }).message).toContain("No wallet");
  });
});

// ─── Rebalance simulation (feeds the gas-aware gate) ─────────────────────────

describe("adapter.simulateRebalance (SDK simulation of the real position)", () => {
  it("reports real claimable fees and quoted bin-array rent, not fabricated constants", async () => {
    const positionData = makePositionData();
    dlmmState.current = makeFakeDlmm({ positionData });
    const restore = mockTokenPrices();

    try {
      const sim = await runWithAdapter(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          return yield* adapter.simulateRebalance(POOL_ADDRESS, POSITION_ADDRESS, 4990, 5030);
        }),
      );

      expect(sim.source).toBe("sdk-simulation");
      // Real claimable fees: 1 SOL × $150 + 50 USDC × $1.
      expect(sim.estimatedFeesUsd).toBeCloseTo(200, 6);
      // Quoted rent: (2 bin arrays + bitmap extension) × $150/SOL.
      const expectedRentSol = 2 * BIN_ARRAY_FEE_SOL + BITMAP_FEE_SOL;
      expect(sim.estimatedCostUsd).toBeCloseTo(expectedRentSol * 150, 6);
      expect(sim.netBenefitUsd).toBeCloseTo(200 - expectedRentSol * 150, 6);
    } finally {
      restore();
    }
  });

  it("targets the requested range via full-withdraw + redeposit simulation", async () => {
    const positionData = makePositionData();
    const fake = makeFakeDlmm({ positionData });
    dlmmState.current = fake;
    const restore = mockTokenPrices();

    try {
      await runWithAdapter(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          return yield* adapter.simulateRebalance(POOL_ADDRESS, POSITION_ADDRESS, 4995, 5015);
        }),
      );

      const simArgs = fake.simulateRebalancePosition.mock.calls[0]!;
      expect(simArgs[0].toBase58()).toBe(POSITION_ADDRESS);
      expect(simArgs[2]).toBe(false);
      expect(simArgs[3]).toBe(false);
      const deposits = simArgs[4] as Array<{ minDeltaId: BN; maxDeltaId: BN }>;
      const withdraws = simArgs[5] as Array<{ bps: BN }>;
      expect(deposits[0]!.minDeltaId.toNumber()).toBe(4995 - ACTIVE_BIN_ID);
      expect(deposits[0]!.maxDeltaId.toNumber()).toBe(5015 - ACTIVE_BIN_ID);
      expect(withdraws[0]!.bps.toNumber()).toBe(10_000);
    } finally {
      restore();
    }
  });

  it("propagates SDK failures so the decision gate can fail closed", async () => {
    dlmmState.current = makeFakeDlmm({
      positionData: makePositionData(),
      simulateError: new Error("rpc timeout"),
    });
    const restore = mockTokenPrices();

    try {
      const err = await runWithAdapter(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          return yield* adapter
            .simulateRebalance(POOL_ADDRESS, POSITION_ADDRESS, 4990, 5030)
            .pipe(Effect.flip);
        }),
      );
      expect(String((err as { message?: string }).message ?? err)).toContain("rpc timeout");
    } finally {
      restore();
    }
  });
});
