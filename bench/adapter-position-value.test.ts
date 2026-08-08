import { describe, it, expect, vi, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import bs58 from "bs58";
import { AdapterService, type AdapterApi } from "../engine/services.js";
import { AdapterLive } from "../engine/adapter-service.js";
import { ConfigService } from "../engine/config-service.js";
import { AuditLive } from "../engine/audit-service.js";
import { DbLive } from "../engine/db-service.js";
import { defaultAppConfig, mockFetch } from "./helpers.js";

// ─── Mocked Meteora DLMM SDK ─────────────────────────────────────────────────
// getPositionValueUsd must price the position's REAL on-chain X/Y holdings at
// LIVE token prices (no static fallbacks), fail open to null when a leg is
// unpriced, and never serve a pre-mutation mark after a position mutation
// (rebalance preserves positionPubKey, so the shared invalidation path must
// clear the mark cache too).

const POOL_ADDRESS = Keypair.generate().publicKey.toBase58();
const POSITION_ADDRESS = Keypair.generate().publicKey.toBase58();
const TOKEN_X = new PublicKey("So11111111111111111111111111111111111111112");
const TOKEN_Y = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const ACTIVE_BIN_ID = 5000;
const BIN_STEP = 10;
const BIN_ARRAY_FEE_SOL = 0.07143744;
const BITMAP_FEE_SOL = 0.01180416;

function makeIx(): TransactionInstruction {
  return new TransactionInstruction({
    keys: [],
    programId: Keypair.generate().publicKey,
    data: Buffer.from([1]),
  });
}

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
    feeX: new BN(0),
    feeY: new BN(0),
    ...overrides,
  };
}

function makeFakeDlmm(opts: { positionData: FakePositionData }) {
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
    simulateRebalancePosition: vi.fn(async () => ({
      rebalancePosition: { address: new PublicKey(POSITION_ADDRESS) },
      simulationResult: { actualAmountXDeposited: new BN(0) },
      binArrayCost: 2 * BIN_ARRAY_FEE_SOL,
      binArrayCount: 2,
      binArrayExistence: new Set<string>(),
      bitmapExtensionCost: BITMAP_FEE_SOL,
    })),
    rebalancePosition: vi.fn(async () => ({
      initBinArrayInstructions: [makeIx()],
      rebalancePositionInstruction: [makeIx(), makeIx()],
    })),
    removeLiquidity: vi.fn(async () => {
      throw new Error("removeLiquidity must not be called");
    }),
    initializePositionAndAddLiquidityByStrategy: vi.fn(async () => {
      throw new Error("initializePositionAndAddLiquidityByStrategy must not be called");
    }),
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
      solPriceUsd: 150, // static fallback price — must NEVER be used by the mark
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

// getPositionValueUsd is optional in the service contract (program.ts guards
// it too); the adapter under test always provides it.
function readPositionValueUsd(
  adapter: AdapterApi,
  poolAddress: string,
  positionPubKey: string,
): Effect.Effect<number | null, never, never> {
  const read = adapter.getPositionValueUsd;
  if (read == null) return Effect.succeed(null);
  return read(poolAddress, positionPubKey);
}

function mockTokenPrices(prices: Record<string, number>): () => void {
  return mockFetch((async (url: string | URL | Request) => {
    const u = String(url as unknown);
    if (u.includes("api.jup.ag/price/v3")) {
      const body: Record<string, { usdPrice: number }> = {};
      for (const [mint, price] of Object.entries(prices)) body[mint] = { usdPrice: price };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch);
}

function mockRpcSendPipeline(): void {
  vi.spyOn(Connection.prototype, "getLatestBlockhash").mockResolvedValue({
    blockhash: bs58.encode(new Uint8Array(32).fill(7)),
    lastValidBlockHeight: 1_000_000,
  });
  let n = 0;
  vi.spyOn(Connection.prototype, "sendRawTransaction").mockImplementation((raw) => {
    void raw;
    n += 1;
    return Promise.resolve(`mock-sig-${n}`);
  });
  vi.spyOn(Connection.prototype, "confirmTransaction").mockImplementation(() =>
    Promise.resolve(undefined as unknown as never),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  dlmmState.current = null;
});

// ─── Real on-chain position mark ─────────────────────────────────────────────

describe("adapter.getPositionValueUsd (real on-chain mark)", () => {
  it("prices the position's on-chain X/Y holdings at live token prices", async () => {
    const positionData = makePositionData(); // 2 SOL + 300 USDC
    dlmmState.current = makeFakeDlmm({ positionData });
    const restore = mockTokenPrices({ [TOKEN_X.toBase58()]: 200, [TOKEN_Y.toBase58()]: 1 });

    try {
      const value = await runWithAdapter(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          return yield* readPositionValueUsd(adapter, POOL_ADDRESS, POSITION_ADDRESS);
        }),
      );
      // 2 SOL × $200 + 300 USDC × $1 = $700
      expect(value).toBeCloseTo(700, 5);
    } finally {
      restore();
    }
  });

  it("serves the cached mark within the TTL without re-reading the position", async () => {
    const positionData = makePositionData();
    const fake = makeFakeDlmm({ positionData });
    dlmmState.current = fake;
    const restore = mockTokenPrices({ [TOKEN_X.toBase58()]: 200, [TOKEN_Y.toBase58()]: 1 });

    try {
      const [first, second] = await runWithAdapter(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          const a = yield* readPositionValueUsd(adapter, POOL_ADDRESS, POSITION_ADDRESS);
          const b = yield* readPositionValueUsd(adapter, POOL_ADDRESS, POSITION_ADDRESS);
          return [a, b] as const;
        }),
      );
      expect(first).toBeCloseTo(700, 5);
      expect(second).toBeCloseTo(700, 5);
      expect(fake.getPosition).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("returns null when a leg's live price is unavailable — never a static fallback mark", async () => {
    // Jupiter prices only USDC; SOL has no live price. The config carries a
    // static solPriceUsd=150 fallback — if the mark used fallback prices it
    // would fabricate 2×150 + 300×1 = $600 and skip the HODL-anchored
    // fallback. Fail-open null is the only correct answer.
    const positionData = makePositionData();
    dlmmState.current = makeFakeDlmm({ positionData });
    const restore = mockTokenPrices({ [TOKEN_Y.toBase58()]: 1 });

    try {
      const value = await runWithAdapter(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          return yield* readPositionValueUsd(adapter, POOL_ADDRESS, POSITION_ADDRESS);
        }),
      );
      expect(value).toBeNull();
    } finally {
      restore();
    }
  });

  it("returns null when a leg's live price is non-positive", async () => {
    const positionData = makePositionData();
    dlmmState.current = makeFakeDlmm({ positionData });
    // Jupiter reports a 0 price for SOL — treat as unpriced, fail open.
    const restore = mockTokenPrices({ [TOKEN_X.toBase58()]: 0, [TOKEN_Y.toBase58()]: 1 });

    try {
      const value = await runWithAdapter(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          return yield* readPositionValueUsd(adapter, POOL_ADDRESS, POSITION_ADDRESS);
        }),
      );
      expect(value).toBeNull();
    } finally {
      restore();
    }
  });

  it("clears the mark cache on the shared invalidation path after a position mutation", async () => {
    // A rebalance preserves positionPubKey; without cache invalidation the
    // next valuation would serve the pre-rebalance mark for up to 60s.
    const positionData = makePositionData(); // 2 SOL + 300 USDC → $700
    const fake = makeFakeDlmm({ positionData });
    dlmmState.current = fake;
    mockRpcSendPipeline();
    const restore = mockTokenPrices({ [TOKEN_X.toBase58()]: 200, [TOKEN_Y.toBase58()]: 1 });

    try {
      const first = await runWithAdapter(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          return yield* readPositionValueUsd(adapter, POOL_ADDRESS, POSITION_ADDRESS);
        }),
      );
      expect(first).toBeCloseTo(700, 5);

      // Mutate the position's on-chain holdings (what a rebalance would do).
      positionData.totalXAmount = "1000000000"; // 1 SOL + 300 USDC → $500
      positionData.totalYAmount = "300000000";

      const result = await runWithAdapter(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          return yield* adapter.rebalancePosition(POOL_ADDRESS, POSITION_ADDRESS, 4990, 5030);
        }),
      );
      expect(result.positionPubKey).toBe(POSITION_ADDRESS);
      expect(fake.removeLiquidity).not.toHaveBeenCalled();
      expect(fake.initializePositionAndAddLiquidityByStrategy).not.toHaveBeenCalled();

      // The mark after the mutation must be the FRESH read ($500), not the
      // stale pre-rebalance $700.
      const second = await runWithAdapter(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          return yield* readPositionValueUsd(adapter, POOL_ADDRESS, POSITION_ADDRESS);
        }),
      );
      expect(second).toBeCloseTo(500, 5);
      // 1 initial read + 1 rebalance read + 1 post-rebalance read — the last
      // read must NOT have hit the cache.
      expect(fake.getPosition).toHaveBeenCalledTimes(3);
    } finally {
      restore();
    }
  });
});
