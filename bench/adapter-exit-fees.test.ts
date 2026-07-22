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
import { ConcreteFunctionType } from "@meteora-ag/dlmm";
import bs58 from "bs58";
import { AdapterService } from "../engine/services.js";
import { AdapterLive, atomicToUnits } from "../engine/adapter-service.js";
import { ConfigService } from "../engine/config-service.js";
import { AuditLive } from "../engine/audit-service.js";
import { DbLive } from "../engine/db-service.js";
import { defaultAppConfig, mockFetch } from "./helpers.js";
import { SOL_MINT, USDC_MINT } from "../engine/constants.js";

// ─── Adapter exitPosition / claimFees accounting (mocked Meteora DLMM SDK) ───
//
// exitPosition must return the exact on-chain amounts being withdrawn (read
// from the pre-close getPosition snapshot via the *ExcludeTransferFee variants)
// plus a mint-based USD valuation that FAILS CLOSED (null, never 0/mark) when
// any leg is unpriced — and pricing must never block the close tx. claimFees
// must return a mint-based netFeesUsd (null when unpriced) so the program-side
// compound gate is not fed a symbol-based mis-estimate.

const POOL_ADDRESS = Keypair.generate().publicKey.toBase58();
const POSITION_ADDRESS = Keypair.generate().publicKey.toBase58();
// Exotic mints (NOT in the adapter's fallbackPrices map) so an empty price
// mock resolves them to 0 and exercises the fail-closed null path. The priced
// tests supply explicit prices for these same mints.
const TOKEN_X = Keypair.generate().publicKey;
const TOKEN_Y = Keypair.generate().publicKey;
const REWARD_MINT = Keypair.generate().publicKey;
const NO_MINT = new PublicKey("11111111111111111111111111111111");

interface FakePositionData {
  totalXAmount: string;
  totalYAmount: string;
  totalXAmountExcludeTransferFee: BN;
  totalYAmountExcludeTransferFee: BN;
  lowerBinId: number;
  upperBinId: number;
  feeX: BN;
  feeY: BN;
  feeXExcludeTransferFee: BN;
  feeYExcludeTransferFee: BN;
  rewardOneExcludeTransferFee: BN;
  rewardTwoExcludeTransferFee: BN;
}

function makePositionData(overrides: Partial<FakePositionData> = {}): FakePositionData {
  return {
    // Gross and net-of-transfer-fee start equal (plain SPL); tests that pin the
    // transfer-fee behaviour override the two sides independently.
    totalXAmount: "2000000000",
    totalYAmount: "300000000",
    totalXAmountExcludeTransferFee: new BN(2_000_000_000),
    totalYAmountExcludeTransferFee: new BN(300_000_000),
    lowerBinId: 4960,
    upperBinId: 4980,
    feeX: new BN(0),
    feeY: new BN(0),
    feeXExcludeTransferFee: new BN(0),
    feeYExcludeTransferFee: new BN(0),
    rewardOneExcludeTransferFee: new BN(0),
    rewardTwoExcludeTransferFee: new BN(0),
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

function makeTx(): Transaction {
  const tx = new Transaction();
  tx.recentBlockhash = bs58.encode(new Uint8Array(32).fill(3));
  tx.add(makeIx());
  return tx;
}

function makeFakeDlmm(opts: { positionData: FakePositionData }) {
  return {
    lbPair: {
      activeId: 5000,
      binStep: 10,
      tokenXMint: TOKEN_X,
      tokenYMint: TOKEN_Y,
      reserveX: Keypair.generate().publicKey,
      reserveY: Keypair.generate().publicKey,
      concreteFunctionType: ConcreteFunctionType.LiquidityMining,
      rewardInfos: [
        { mint: REWARD_MINT, vault: Keypair.generate().publicKey },
        { mint: NO_MINT, vault: Keypair.generate().publicKey },
      ],
    },
    tokenX: { publicKey: TOKEN_X, mint: { decimals: 9 } },
    tokenY: { publicKey: TOKEN_Y, mint: { decimals: 6 } },
    getPosition: vi.fn(async (pubkey: PublicKey) => ({
      publicKey: pubkey,
      positionData: opts.positionData,
    })),
    removeLiquidity: vi.fn(async (_args: unknown) => [makeTx()]),
    claimSwapFee: vi.fn(async (_args: unknown) => [makeTx()]),
  };
}

// A pool whose legs ARE in the adapter's fallbackPrices map (SOL $165 / USDC $1),
// so an empty price-provider mock exercises the useFallback:false opt-out: the
// pre-fix default would fabricate a nonzero USD, the fix must return null.
function makeSolUsdcFakeDlmm(opts: { positionData: FakePositionData }) {
  const sol = new PublicKey(SOL_MINT);
  const usdc = new PublicKey(USDC_MINT);
  return {
    lbPair: {
      activeId: 5000,
      binStep: 10,
      tokenXMint: sol,
      tokenYMint: usdc,
      reserveX: Keypair.generate().publicKey,
      reserveY: Keypair.generate().publicKey,
      concreteFunctionType: ConcreteFunctionType.LiquidityMining,
      rewardInfos: [
        { mint: NO_MINT, vault: Keypair.generate().publicKey },
        { mint: NO_MINT, vault: Keypair.generate().publicKey },
      ],
    },
    tokenX: { publicKey: sol, mint: { decimals: 9 } },
    tokenY: { publicKey: usdc, mint: { decimals: 6 } },
    getPosition: vi.fn(async (pubkey: PublicKey) => ({
      publicKey: pubkey,
      positionData: opts.positionData,
    })),
    removeLiquidity: vi.fn(async (_args: unknown) => [makeTx()]),
    claimSwapFee: vi.fn(async (_args: unknown) => [makeTx()]),
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

// ─── Adapter layer wiring (mirrors bench/adapter-rewards.test.ts) ─────────

const walletKeypair = Keypair.generate();
const walletPrivateKey = bs58.encode(walletKeypair.secretKey);

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

async function runWithAdapter<A, E>(effect: Effect.Effect<A, E, AdapterService>): Promise<A> {
  return Effect.runPromise(
    Effect.provide(effect, makeAdapterLayer()) as Effect.Effect<A, E, never>,
  );
}

function mockRpcSendPipeline(): void {
  vi.spyOn(Connection.prototype, "getLatestBlockhash").mockResolvedValue({
    blockhash: bs58.encode(new Uint8Array(32).fill(7)),
    lastValidBlockHeight: 1_000_000,
  });
  let n = 0;
  vi.spyOn(Connection.prototype, "sendRawTransaction").mockImplementation(() => {
    n += 1;
    return Promise.resolve(`mock-exit-sig-${n}`);
  });
  vi.spyOn(Connection.prototype, "confirmTransaction").mockImplementation(() =>
    Promise.resolve(undefined as unknown as never),
  );
}

function mockRewardMintDecimals(decimals = 6): void {
  vi.spyOn(Connection.prototype, "getParsedAccountInfo").mockImplementation((pubkey) => {
    if (pubkey.toBase58() === REWARD_MINT.toBase58()) {
      return Promise.resolve({
        context: { slot: 1 },
        value: {
          executable: false,
          lamports: 1,
          owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
          rentEpoch: 0,
          data: {
            program: "spl-token",
            parsed: { info: { decimals }, type: "mint" },
            space: 82,
          },
        } as never,
      });
    }
    return Promise.resolve({ context: { slot: 1 }, value: null } as never);
  });
}

// Empty `prices` → exotic mints are unpriced (no fallback) → adapter sees 0 →
// the fail-closed null path.
function mockPrices(prices: Record<string, number>): () => void {
  return mockFetch((async (url: string | URL | Request) => {
    const u = url.toString();
    if (u.includes("api.jup.ag/price/v3")) {
      const body: Record<string, { usdPrice: number }> = {};
      for (const [mint, usdPrice] of Object.entries(prices)) {
        body[mint] = { usdPrice };
      }
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch);
}

describe("AdapterService.exitPosition accounting", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    dlmmState.current = null;
  });

  it("returns withdrawn atomics (total+fee), mint-based USD, and priced swept rewards", async () => {
    dlmmState.current = makeFakeDlmm({
      positionData: makePositionData({
        feeX: new BN(100_000_000),
        feeY: new BN(10_000_000),
        feeXExcludeTransferFee: new BN(100_000_000),
        feeYExcludeTransferFee: new BN(10_000_000),
        rewardOneExcludeTransferFee: new BN(250_000_000),
      }),
    });
    mockRpcSendPipeline();
    mockRewardMintDecimals(6);
    const restore = mockPrices({
      [TOKEN_X.toBase58()]: 150,
      [TOKEN_Y.toBase58()]: 1,
      [REWARD_MINT.toBase58()]: 0.4,
    });
    try {
      const result = await runWithAdapter(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          return yield* adapter.exitPosition(POOL_ADDRESS, POSITION_ADDRESS);
        }),
      );
      // removeLiquidity ran (the close was not aborted by pricing).
      expect(dlmmState.current.removeLiquidity).toHaveBeenCalledTimes(1);
      // withdrawn = principal + swept fees, in the *ExcludeTransferFee variants.
      expect(result.withdrawnXAtomic).toBe("2100000000"); // 2 + 0.1
      expect(result.withdrawnYAtomic).toBe("310000000"); // 300 + 10
      expect(result.pendingFeeXAtomic).toBe("100000000");
      expect(result.pendingFeeYAtomic).toBe("10000000");
      // 2.1 × 150 + 310 × 1 = 625 ; fees 0.1 × 150 + 10 × 1 = 25.
      expect(result.withdrawnUsd).toBeCloseTo(625, 6);
      expect(result.pendingFeeUsd).toBeCloseTo(25, 6);
      // Swept LM reward priced from its own mint + decimals.
      expect(result.sweptRewards).toHaveLength(1);
      const reward = result.sweptRewards![0]!;
      expect(reward.mint).toBe(REWARD_MINT.toBase58());
      expect(reward.amountAtomic).toBe(250_000_000);
      expect(reward.amountUsd).toBeCloseTo(100, 6); // 250 × 0.4
    } finally {
      restore();
    }
  });

  it("uses the *ExcludeTransferFee amounts when gross ≠ net-of-transfer-fee", async () => {
    dlmmState.current = makeFakeDlmm({
      positionData: makePositionData({
        // Gross amounts differ from the net-of-transfer-fee amounts; the exit
        // must report the net-of-transfer-fee (what the wallet actually gets).
        totalXAmount: "9999999999",
        feeX: new BN(999),
        totalXAmountExcludeTransferFee: new BN(2_000_000_000),
        feeXExcludeTransferFee: new BN(100_000_000),
        totalYAmountExcludeTransferFee: new BN(300_000_000),
        feeYExcludeTransferFee: new BN(0),
      }),
    });
    mockRpcSendPipeline();
    const restore = mockPrices({
      [TOKEN_X.toBase58()]: 150,
      [TOKEN_Y.toBase58()]: 1,
    });
    try {
      const result = await runWithAdapter(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          return yield* adapter.exitPosition(POOL_ADDRESS, POSITION_ADDRESS);
        }),
      );
      // 2e9 + 1e8 from the ExcludeTransferFee fields — NOT the gross 9999999999 + 999.
      expect(result.withdrawnXAtomic).toBe("2100000000");
      expect(result.pendingFeeXAtomic).toBe("100000000");
    } finally {
      restore();
    }
  });

  it("returns null USD when pricing is unresolved, still closes and returns atomics", async () => {
    dlmmState.current = makeFakeDlmm({
      positionData: makePositionData({
        feeXExcludeTransferFee: new BN(100_000_000),
        feeYExcludeTransferFee: new BN(10_000_000),
      }),
    });
    mockRpcSendPipeline();
    // No prices for the exotic mints → unresolved → fail closed.
    const restore = mockPrices({});
    try {
      const result = await runWithAdapter(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          return yield* adapter.exitPosition(POOL_ADDRESS, POSITION_ADDRESS);
        }),
      );
      // The close still ran (pricing failure never aborts the tx) and atomics
      // are always returned …
      expect(dlmmState.current.removeLiquidity).toHaveBeenCalledTimes(1);
      expect(result.withdrawnXAtomic).toBe("2100000000");
      expect(result.withdrawnYAtomic).toBe("310000000");
      // … but the USD legs are null, never 0 and never a fabricated mark.
      expect(result.withdrawnUsd).toBeNull();
      expect(result.pendingFeeUsd).toBeNull();
    } finally {
      restore();
    }
  });

  it("does NOT fabricate a realized from the $165/$1 fallback map when legs resolve only via fallback", async () => {
    // SOL/USDC legs ARE in the adapter's fallbackPrices map (SOL=165, USDC=1).
    // With an empty price-provider mock, the pre-fix default (useFallback:true)
    // would fabricate withdrawnUsd = 2 SOL × 165 + 300 USDC × 1 = 630 and pass
    // the all-or-nothing gate. The fix opts out (useFallback:false) → resolves
    // to 0 → null, so no fabricated realized can reach the ledger.
    dlmmState.current = makeSolUsdcFakeDlmm({
      positionData: makePositionData(), // 2 SOL (2e9 atomic) + 300 USDC (3e8), fees 0
    });
    mockRpcSendPipeline();
    const restore = mockPrices({}); // providers return nothing → fallback-only resolution
    try {
      const result = await runWithAdapter(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          return yield* adapter.exitPosition(POOL_ADDRESS, POSITION_ADDRESS);
        }),
      );
      // Close still ran and atomics are present …
      expect(dlmmState.current.removeLiquidity).toHaveBeenCalledTimes(1);
      expect(result.withdrawnXAtomic).toBe("2000000000");
      expect(result.withdrawnYAtomic).toBe("300000000");
      // … but USD is null, and specifically NOT the 630 the fallback would forge.
      expect(result.withdrawnUsd).toBeNull();
      expect(result.withdrawnUsd).not.toBeCloseTo(630, 6);
      expect(result.pendingFeeUsd).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("AdapterService.claimFees netFeesUsd", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    dlmmState.current = null;
  });

  it("prices the net claim mint-based", async () => {
    dlmmState.current = makeFakeDlmm({
      positionData: makePositionData({ feeY: new BN(25_000_000) }), // 25 USDC-d (6 dec)
    });
    mockRpcSendPipeline();
    const restore = mockPrices({
      [TOKEN_X.toBase58()]: 150,
      [TOKEN_Y.toBase58()]: 1,
    });
    try {
      const result = await runWithAdapter(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          return yield* adapter.claimFees(POOL_ADDRESS, POSITION_ADDRESS);
        }),
      );
      // net 0 X + 25 Y → 0 × 150 + 25 × 1 = 25.
      expect(result.netFeesUsd).toBeCloseTo(25, 6);
    } finally {
      restore();
    }
  });

  it("returns null netFeesUsd when either leg is unpriceable", async () => {
    dlmmState.current = makeFakeDlmm({
      positionData: makePositionData({ feeY: new BN(25_000_000) }),
    });
    mockRpcSendPipeline();
    const restore = mockPrices({}); // exotic mints unpriced
    try {
      const result = await runWithAdapter(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          return yield* adapter.claimFees(POOL_ADDRESS, POSITION_ADDRESS);
        }),
      );
      expect(result.netFeesUsd).toBeNull();
    } finally {
      restore();
    }
  });

  it("does NOT fabricate netFeesUsd from the SOL fallback when the leg resolves only via fallback", async () => {
    // A 1 SOL fee on a SOL/USDC pool. Empty price providers → pre-fix default
    // would forge netFeesUsd = 1 SOL × $165; the useFallback:false opt-out must
    // resolve to 0 → null so the compound gate fails closed, not on $165 fiction.
    dlmmState.current = makeSolUsdcFakeDlmm({
      positionData: makePositionData({ feeX: new BN(1_000_000_000) }), // 1 SOL (9 dec)
    });
    mockRpcSendPipeline();
    const restore = mockPrices({}); // fallback-only resolution
    try {
      const result = await runWithAdapter(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          return yield* adapter.claimFees(POOL_ADDRESS, POSITION_ADDRESS);
        }),
      );
      expect(result.netFeesUsd).toBeNull();
      expect(result.netFeesUsd).not.toBeCloseTo(165, 6);
    } finally {
      restore();
    }
  });

  it("returns 0 netFeesUsd on the zero-fee shortcut", async () => {
    dlmmState.current = makeFakeDlmm({
      positionData: makePositionData({ feeX: new BN(0), feeY: new BN(0) }),
    });
    mockRpcSendPipeline();
    const result = await runWithAdapter(
      Effect.gen(function* () {
        const adapter = yield* AdapterService;
        return yield* adapter.claimFees(POOL_ADDRESS, POSITION_ADDRESS);
      }),
    );
    expect(result.netFeesUsd).toBe(0);
    // Zero-fee path claims nothing on-chain.
    expect(dlmmState.current.claimSwapFee).not.toHaveBeenCalled();
  });
});

describe("atomicToUnits", () => {
  it("converts above-2^53 atomic amounts exactly", () => {
    // 1e18 atomic exceeds Number.MAX_SAFE_INTEGER; a naive Number() would lose
    // low bits. The bigint split keeps the whole part exact: 1e18 / 1e5 = 1e13.
    expect(atomicToUnits(1_000_000_000_000_000_000n, 5)).toBe(10_000_000_000_000);
  });

  it("preserves the fractional part", () => {
    expect(atomicToUnits(123_456_789n, 6)).toBeCloseTo(123.456789, 12);
  });
});
