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
import { AdapterLive } from "../engine/adapter-service.js";
import { ConfigService } from "../engine/config-service.js";
import { AuditLive } from "../engine/audit-service.js";
import { DbLive } from "../engine/db-service.js";
import { defaultAppConfig, mockFetch } from "./helpers.js";

// ─── Wave 8: LM farm reward claiming (mocked Meteora DLMM SDK) ───────────────
// The adapter must claim farm rewards via the SDK's claimAllLMRewards (LM-only
// — never claimAllRewardsByPosition, which would also move swap fees through a
// path the engine does not account for). Pending amounts are read from the
// position's rewardOne/rewardTwo BEFORE claiming; claiming when nothing is
// pending is a skip, not an error.

const POOL_ADDRESS = Keypair.generate().publicKey.toBase58();
const POSITION_ADDRESS = Keypair.generate().publicKey.toBase58();
const TOKEN_X = new PublicKey("So11111111111111111111111111111111111111112");
const TOKEN_Y = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const REWARD_MINT = Keypair.generate().publicKey;
const REWARD_MINT_2 = Keypair.generate().publicKey;
const NO_MINT = new PublicKey("11111111111111111111111111111111");

interface FakePositionData {
  totalXAmount: string;
  totalYAmount: string;
  lowerBinId: number;
  upperBinId: number;
  feeX: BN;
  feeY: BN;
  rewardOne: BN;
  rewardTwo: BN;
}

function makePositionData(overrides: Partial<FakePositionData> = {}): FakePositionData {
  return {
    totalXAmount: "2000000000",
    totalYAmount: "300000000",
    lowerBinId: 4960,
    upperBinId: 4980,
    feeX: new BN(0),
    feeY: new BN(0),
    rewardOne: new BN(250_000_000), // 250 reward tokens (6 decimals)
    rewardTwo: new BN(0),
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

function makeClaimTx(): Transaction {
  const tx = new Transaction();
  tx.recentBlockhash = bs58.encode(new Uint8Array(32).fill(3));
  tx.add(makeIx());
  return tx;
}

const FORBIDDEN_COMBINED_CLAIM = {
  claimAllRewardsByPosition: vi.fn(async () => {
    throw new Error(
      "claimAllRewardsByPosition must not be called — it also claims swap fees outside the engine accounting",
    );
  }),
};

function makeFakeDlmm(opts: {
  positionData: FakePositionData;
  concreteFunctionType?: number;
  claimError?: Error;
  emptyClaimTxs?: boolean;
}) {
  return {
    lbPair: {
      activeId: 5000,
      binStep: 10,
      tokenXMint: TOKEN_X,
      tokenYMint: TOKEN_Y,
      reserveX: Keypair.generate().publicKey,
      reserveY: Keypair.generate().publicKey,
      concreteFunctionType: opts.concreteFunctionType ?? ConcreteFunctionType.LiquidityMining,
      rewardInfos: [
        { mint: REWARD_MINT, vault: Keypair.generate().publicKey },
        { mint: NO_MINT, vault: Keypair.generate().publicKey },
      ],
    },
    tokenX: { publicKey: TOKEN_X, mint: { decimals: 9 } },
    tokenY: { publicKey: TOKEN_Y, mint: { decimals: 6 } },
    refetchStates: vi.fn(async () => {}),
    getPosition: vi.fn(async (pubkey: PublicKey) => ({
      publicKey: pubkey,
      positionData: opts.positionData,
    })),
    claimAllLMRewards: opts.claimError
      ? vi.fn(async (_args: { owner: PublicKey; positions: unknown[] }) => {
          throw opts.claimError;
        })
      : vi.fn(async (_args: { owner: PublicKey; positions: unknown[] }) =>
          opts.emptyClaimTxs ? [] : [makeClaimTx()],
        ),
    ...FORBIDDEN_COMBINED_CLAIM,
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

function mockRpcSendPipeline(): void {
  vi.spyOn(Connection.prototype, "getLatestBlockhash").mockResolvedValue({
    blockhash: bs58.encode(new Uint8Array(32).fill(7)),
    lastValidBlockHeight: 1_000_000,
  });
  let n = 0;
  vi.spyOn(Connection.prototype, "sendRawTransaction").mockImplementation(() => {
    n += 1;
    return Promise.resolve(`mock-reward-sig-${n}`);
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

describe("AdapterService.claimRewards", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    dlmmState.current = null;
  });

  it("(v) claims pending LM rewards, records amounts once with mint + USD", async () => {
    const positionData = makePositionData();
    dlmmState.current = makeFakeDlmm({ positionData });
    mockRpcSendPipeline();
    mockRewardMintDecimals(6);
    const restore = mockPrices({ [REWARD_MINT.toBase58()]: 0.4 });
    try {
      const result = await runWithAdapter(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          return yield* adapter.claimRewards(POOL_ADDRESS, POSITION_ADDRESS);
        }),
      );
      expect(result.skipped).toBe(false);
      expect(dlmmState.current.claimAllLMRewards).toHaveBeenCalledTimes(1);
      const call = dlmmState.current.claimAllLMRewards.mock.calls[0]?.[0] as {
        owner: PublicKey;
        positions: unknown[];
      };
      expect(call.owner.toBase58()).toBe(walletKeypair.publicKey.toBase58());
      expect(call.positions).toHaveLength(1);
      const claimedPosition = call.positions[0] as { publicKey: PublicKey };
      expect(claimedPosition.publicKey.toBase58()).toBe(POSITION_ADDRESS);
      expect(result.txSignatures).toEqual(["mock-reward-sig-1"]);
      expect(result.rewards).toHaveLength(1);
      const reward = result.rewards[0]!;
      expect(reward.mint).toBe(REWARD_MINT.toBase58());
      expect(reward.amountAtomic).toBe(250_000_000);
      // 250 tokens × $0.40 = $100
      expect(reward.amountUsd).toBeCloseTo(100, 6);
    } finally {
      restore();
    }
  });

  it("(v) zero pending rewards → skipped, SDK claim never called (idempotent no-op)", async () => {
    const positionData = makePositionData({ rewardOne: new BN(0), rewardTwo: new BN(0) });
    dlmmState.current = makeFakeDlmm({ positionData });
    mockRpcSendPipeline();
    const result = await runWithAdapter(
      Effect.gen(function* () {
        const adapter = yield* AdapterService;
        return yield* adapter.claimRewards(POOL_ADDRESS, POSITION_ADDRESS);
      }),
    );
    expect(result.skipped).toBe(true);
    expect(result.rewards).toEqual([]);
    expect(result.txSignatures).toEqual([]);
    expect(dlmmState.current.claimAllLMRewards).not.toHaveBeenCalled();
  });

  it("(v) LimitOrder function-type pool with nothing pending → claim skipped silently", async () => {
    const positionData = makePositionData({ rewardOne: new BN(0), rewardTwo: new BN(0) });
    dlmmState.current = makeFakeDlmm({
      positionData,
      concreteFunctionType: ConcreteFunctionType.LimitOrder,
    });
    mockRpcSendPipeline();
    const result = await runWithAdapter(
      Effect.gen(function* () {
        const adapter = yield* AdapterService;
        return yield* adapter.claimRewards(POOL_ADDRESS, POSITION_ADDRESS);
      }),
    );
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toMatch(/limit.?order|function type/i);
    expect(dlmmState.current.claimAllLMRewards).not.toHaveBeenCalled();
  });

  it("(v) legacy pool reading LimitOrder but with pending rewards still claims (real yield is never abandoned)", async () => {
    const positionData = makePositionData();
    dlmmState.current = makeFakeDlmm({
      positionData,
      concreteFunctionType: ConcreteFunctionType.LimitOrder,
    });
    mockRpcSendPipeline();
    mockRewardMintDecimals(6);
    const restore = mockPrices({ [REWARD_MINT.toBase58()]: 0.4 });
    try {
      const result = await runWithAdapter(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          return yield* adapter.claimRewards(POOL_ADDRESS, POSITION_ADDRESS);
        }),
      );
      expect(result.skipped).toBe(false);
      expect(dlmmState.current.claimAllLMRewards).toHaveBeenCalledTimes(1);
      expect(result.rewards).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("(v) reward price unavailable → raw amounts recorded, USD null, no crash", async () => {
    const positionData = makePositionData();
    dlmmState.current = makeFakeDlmm({ positionData });
    mockRpcSendPipeline();
    mockRewardMintDecimals(6);
    // Every price source fails.
    const restore = mockFetch(() => Promise.resolve(new Response("down", { status: 500 })));
    try {
      const result = await runWithAdapter(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          return yield* adapter.claimRewards(POOL_ADDRESS, POSITION_ADDRESS);
        }),
      );
      expect(result.skipped).toBe(false);
      expect(result.rewards).toHaveLength(1);
      const reward = result.rewards[0]!;
      expect(reward.amountAtomic).toBe(250_000_000);
      expect(reward.amountUsd).toBeNull();
    } finally {
      restore();
    }
  });

  it("(v) second cycle after a claim is a no-op (no double-claim)", async () => {
    // First cycle: rewards pending. After the claim the on-chain pending
    // amounts reset to zero — the next cycle must skip without calling the SDK.
    const claimedPosition = makePositionData({ rewardOne: new BN(0), rewardTwo: new BN(0) });
    dlmmState.current = makeFakeDlmm({ positionData: claimedPosition });
    mockRpcSendPipeline();
    const result = await runWithAdapter(
      Effect.gen(function* () {
        const adapter = yield* AdapterService;
        return yield* adapter.claimRewards(POOL_ADDRESS, POSITION_ADDRESS);
      }),
    );
    expect(result.skipped).toBe(true);
    expect(dlmmState.current.claimAllLMRewards).not.toHaveBeenCalled();
  });

  it("(v) SDK returns no claim transactions → skipped, nothing recorded", async () => {
    const positionData = makePositionData();
    dlmmState.current = makeFakeDlmm({ positionData, emptyClaimTxs: true });
    mockRpcSendPipeline();
    const result = await runWithAdapter(
      Effect.gen(function* () {
        const adapter = yield* AdapterService;
        return yield* adapter.claimRewards(POOL_ADDRESS, POSITION_ADDRESS);
      }),
    );
    expect(result.skipped).toBe(true);
    expect(result.rewards).toEqual([]);
  });

  it("(v) both reward slots claimed when both have pending amounts", async () => {
    const positionData = makePositionData({ rewardTwo: new BN(50_000_000) });
    const fake = makeFakeDlmm({ positionData });
    fake.lbPair.rewardInfos[1] = { mint: REWARD_MINT_2, vault: Keypair.generate().publicKey };
    dlmmState.current = fake;
    mockRpcSendPipeline();
    vi.spyOn(Connection.prototype, "getParsedAccountInfo").mockImplementation(() =>
      Promise.resolve({
        context: { slot: 1 },
        value: {
          executable: false,
          lamports: 1,
          owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
          rentEpoch: 0,
          data: {
            program: "spl-token",
            parsed: { info: { decimals: 6 }, type: "mint" },
            space: 82,
          },
        } as never,
      }),
    );
    const restore = mockPrices({
      [REWARD_MINT.toBase58()]: 0.4,
      [REWARD_MINT_2.toBase58()]: 2,
    });
    try {
      const result = await runWithAdapter(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          return yield* adapter.claimRewards(POOL_ADDRESS, POSITION_ADDRESS);
        }),
      );
      expect(result.skipped).toBe(false);
      expect(result.rewards).toHaveLength(2);
      const first = result.rewards.find((r) => r.mint === REWARD_MINT.toBase58());
      const second = result.rewards.find((r) => r.mint === REWARD_MINT_2.toBase58());
      expect(first?.amountUsd).toBeCloseTo(100, 6); // 250 × $0.40
      expect(second?.amountUsd).toBeCloseTo(100, 6); // 50 × $2
    } finally {
      restore();
    }
  });
});
