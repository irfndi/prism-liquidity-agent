import { describe, it, expect, vi, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import { Connection, Keypair } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import { AdapterService } from "../engine/services.js";
import { AdapterLive } from "../engine/adapter-service.js";
import { ConfigService } from "../engine/config-service.js";
import { AuditLive } from "../engine/audit-service.js";
import { DbLive } from "../engine/db-service.js";
import { defaultAppConfig, mockFetch } from "./helpers.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGQkZwyADt1v";
const EXOTIC_MINT = "ExoticToken1111111111111111111111111111111111";
const TOKEN_2022 = TOKEN_2022_PROGRAM_ID.toBase58();

interface FakeTokenAccount {
  readonly mint: string;
  readonly amount: string;
  readonly decimals: number;
}

function tokenAccount({ mint, amount, decimals }: FakeTokenAccount) {
  return {
    pubkey: Keypair.generate().publicKey,
    account: {
      data: { parsed: { info: { mint, tokenAmount: { amount, decimals } } } },
    },
  };
}

type TokenAccountsResult = Awaited<ReturnType<Connection["getParsedTokenAccountsByOwner"]>>;

function mockTokenAccountsByProgram(
  tokenProgram: ReadonlyArray<FakeTokenAccount>,
  token2022: ReadonlyArray<FakeTokenAccount> = [],
): void {
  vi.spyOn(Connection.prototype, "getParsedTokenAccountsByOwner").mockImplementation(
    async (_owner, filter) => {
      const programId = (
        filter as { readonly programId?: { toBase58(): string } }
      ).programId?.toBase58();
      const accounts = programId === TOKEN_2022 ? token2022 : tokenProgram;
      return { value: accounts.map(tokenAccount) } as unknown as TokenAccountsResult;
    },
  );
}

function mockJupiterPrices(prices: Record<string, number>): () => void {
  return mockFetch((async (url: string | URL | Request) => {
    if (String(url as unknown).includes("api.jup.ag/price/v3")) {
      const body: Record<string, { usdPrice: number }> = {};
      for (const [mint, price] of Object.entries(prices)) body[mint] = { usdPrice: price };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch);
}

async function readWalletBalance(): Promise<number> {
  const layer = buildAdapterLayerWithWallet();
  const program = Effect.gen(function* () {
    const adapter = yield* AdapterService;
    return yield* adapter.getWalletBalanceUsd();
  }).pipe(Effect.provide(layer));
  return Effect.runPromise(program);
}

function buildAdapterLayerWithWallet(): Layer.Layer<AdapterService, never, never> {
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

describe("AdapterService wallet balance reconciliation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sums native SOL + wSOL + USDC + an exotic token across both token programs", async () => {
    // native SOL 1 (getBalance) + wSOL ATA 1 (mint SOL_MINT) at $200 = $400,
    // USDC 3 at $1 = $3, exotic 2 at $5 = $10 → $413.
    const restore = mockJupiterPrices({ [SOL_MINT]: 200, [USDC_MINT]: 1, [EXOTIC_MINT]: 5 });
    vi.spyOn(Connection.prototype, "getBalance").mockResolvedValue(1_000_000_000);
    mockTokenAccountsByProgram(
      [
        { mint: SOL_MINT, amount: "1000000000", decimals: 9 }, // wSOL: 1 SOL
        { mint: USDC_MINT, amount: "3000000", decimals: 6 }, // 3 USDC
      ],
      [{ mint: EXOTIC_MINT, amount: "2000000", decimals: 6 }], // 2 exotic on Token-2022
    );

    try {
      expect(await readWalletBalance()).toBeCloseTo(413, 5);
    } finally {
      restore();
    }
  });

  it("resolves live prices for every token instead of any hardcoded fallback", async () => {
    // SOL price comes from the live feed ($200), and the USDC leg is the ATA
    // sum (1 + 2 = 3 USDC at $1) → $203.
    const restore = mockJupiterPrices({ [SOL_MINT]: 200, [USDC_MINT]: 1 });
    vi.spyOn(Connection.prototype, "getBalance").mockResolvedValue(1_000_000_000);
    mockTokenAccountsByProgram([
      { mint: USDC_MINT, amount: "1000000", decimals: 6 },
      { mint: USDC_MINT, amount: "2000000", decimals: 6 },
    ]);

    try {
      expect(await readWalletBalance()).toBeCloseTo(203, 5);
    } finally {
      restore();
    }
  });

  it("skips a token whose USD price cannot be resolved (fail-closed, no throw)", async () => {
    // SOL $200 + USDC $3 priced; the exotic has no price → excluded. Total =
    // $203 despite holding 2 exotic tokens.
    const restore = mockJupiterPrices({ [SOL_MINT]: 200, [USDC_MINT]: 1 });
    vi.spyOn(Connection.prototype, "getBalance").mockResolvedValue(1_000_000_000);
    mockTokenAccountsByProgram([
      { mint: USDC_MINT, amount: "3000000", decimals: 6 },
      { mint: EXOTIC_MINT, amount: "2000000", decimals: 6 },
    ]);

    try {
      expect(await readWalletBalance()).toBeCloseTo(203, 5);
    } finally {
      restore();
    }
  });

  it("never values SOL with the $165 fallback when its price is unresolved", async () => {
    // No SOL price anywhere → SOL is skipped (NOT valued at $165). Only the 3
    // USDC at $1 count → $3, explicitly not $168.
    const restore = mockJupiterPrices({ [USDC_MINT]: 1 });
    vi.spyOn(Connection.prototype, "getBalance").mockResolvedValue(1_000_000_000);
    mockTokenAccountsByProgram([{ mint: USDC_MINT, amount: "3000000", decimals: 6 }]);

    try {
      const balance = await readWalletBalance();
      expect(balance).toBeCloseTo(3, 5);
      expect(balance).not.toBeCloseTo(168, 0);
    } finally {
      restore();
    }
  });

  it("skips zero-amount token accounts", async () => {
    // A zero-amount USDC ATA must not change the sum. SOL $200 + USDC $1 = $201.
    const restore = mockJupiterPrices({ [SOL_MINT]: 200, [USDC_MINT]: 1 });
    vi.spyOn(Connection.prototype, "getBalance").mockResolvedValue(1_000_000_000);
    mockTokenAccountsByProgram([
      { mint: USDC_MINT, amount: "0", decimals: 6 },
      { mint: USDC_MINT, amount: "1000000", decimals: 6 },
    ]);

    try {
      expect(await readWalletBalance()).toBeCloseTo(201, 5);
    } finally {
      restore();
    }
  });

  it("shares concurrent wallet balance reads", async () => {
    const restore = mockJupiterPrices({ [SOL_MINT]: 200 });
    let balanceCalls = 0;

    vi.spyOn(Connection.prototype, "getBalance").mockImplementation(async () => {
      balanceCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 1_000_000_000;
    });
    mockTokenAccountsByProgram([]);

    try {
      const layer = buildAdapterLayerWithWallet();
      const program = Effect.gen(function* () {
        const adapter = yield* AdapterService;
        return yield* Effect.all([adapter.getWalletBalanceUsd(), adapter.getWalletBalanceUsd()]);
      }).pipe(Effect.provide(layer));

      const [first, second] = await Effect.runPromise(program);
      expect(first).toBe(200);
      expect(second).toBe(200);
      expect(balanceCalls).toBe(1);
    } finally {
      restore();
    }
  });
});

describe("AdapterService wallet holdings seam (getWalletHoldings)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function readWalletHoldings() {
    const layer = buildAdapterLayerWithWallet();
    const program = Effect.gen(function* () {
      const adapter = yield* AdapterService;
      return yield* adapter.getWalletHoldings();
    }).pipe(Effect.provide(layer));
    return Effect.runPromise(program);
  }

  it("returns per-mint holdings with accumulated atomics across both token programs", async () => {
    const restore = mockJupiterPrices({ [USDC_MINT]: 1, [EXOTIC_MINT]: 5 });
    vi.spyOn(Connection.prototype, "getBalance").mockResolvedValue(0);
    mockTokenAccountsByProgram(
      [
        { mint: USDC_MINT, amount: "1000000", decimals: 6 },
        { mint: USDC_MINT, amount: "2000000", decimals: 6 },
      ],
      [{ mint: EXOTIC_MINT, amount: "2000000", decimals: 6 }],
    );

    try {
      const holdings = await readWalletHoldings();
      expect(holdings.size).toBe(2);
      expect(holdings.get(USDC_MINT)).toEqual({ amountAtomic: 3_000_000n, decimals: 6 });
      expect(holdings.get(EXOTIC_MINT)).toEqual({ amountAtomic: 2_000_000n, decimals: 6 });
    } finally {
      restore();
    }
  });

  it("omits zero-amount token accounts from the holdings map", async () => {
    const restore = mockJupiterPrices({ [USDC_MINT]: 1 });
    vi.spyOn(Connection.prototype, "getBalance").mockResolvedValue(0);
    mockTokenAccountsByProgram([
      { mint: USDC_MINT, amount: "0", decimals: 6 },
      { mint: USDC_MINT, amount: "1000000", decimals: 6 },
    ]);

    try {
      const holdings = await readWalletHoldings();
      expect(holdings.get(USDC_MINT)).toEqual({ amountAtomic: 1_000_000n, decimals: 6 });
    } finally {
      restore();
    }
  });

  it("serves the balance AND the holdings from one cached snapshot read", async () => {
    // One snapshot = two token-account reads (Token Program + Token-2022);
    // the same mint reported under both programs accumulates to 2 USDC.
    // Balance + holdings + a repeat holdings read all share that snapshot.
    const restore = mockJupiterPrices({ [USDC_MINT]: 1 });
    vi.spyOn(Connection.prototype, "getBalance").mockResolvedValue(0);
    let tokenAccountReads = 0;
    vi.spyOn(Connection.prototype, "getParsedTokenAccountsByOwner").mockImplementation(async () => {
      tokenAccountReads += 1;
      return {
        value: [tokenAccount({ mint: USDC_MINT, amount: "1000000", decimals: 6 })],
      } as unknown as TokenAccountsResult;
    });

    try {
      const layer = buildAdapterLayerWithWallet();
      const program = Effect.gen(function* () {
        const adapter = yield* AdapterService;
        return yield* Effect.all([
          adapter.getWalletBalanceUsd(),
          adapter.getWalletHoldings(),
          adapter.getWalletHoldings(),
        ]);
      }).pipe(Effect.provide(layer));

      const [balance, holdings, repeatHoldings] = await Effect.runPromise(program);
      expect(balance).toBeCloseTo(2, 5);
      expect(holdings.get(USDC_MINT)).toEqual({ amountAtomic: 2_000_000n, decimals: 6 });
      expect(repeatHoldings.get(USDC_MINT)).toEqual({ amountAtomic: 2_000_000n, decimals: 6 });
      expect(tokenAccountReads).toBe(2);
    } finally {
      restore();
    }
  });

  it("returns an empty map when no wallet is configured (paper mode)", async () => {
    const configLayer = Layer.succeed(
      ConfigService,
      defaultAppConfig({
        walletPrivateKey: "",
        solanaRpcUrl: "https://example.com",
        solanaRpcFallbackUrl: "",
        sqliteDbPath: ":memory:",
        autoUpdate: false,
      }),
    );
    const auditLayer = Layer.provide(AuditLive, DbLive(":memory:"));
    const layer = Layer.provide(AdapterLive, Layer.merge(configLayer, auditLayer)) as Layer.Layer<
      AdapterService,
      never,
      never
    >;

    const holdings = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* AdapterService;
        return yield* adapter.getWalletHoldings();
      }).pipe(Effect.provide(layer)),
    );
    expect(holdings.size).toBe(0);
  });
});

describe("AdapterService getTokenPrices fallback behavior", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function readTokenPrices(
    mints: readonly string[],
    useFallback: boolean,
  ): Promise<Record<string, number>> {
    const layer = buildAdapterLayerWithWallet();
    const program = Effect.gen(function* () {
      const adapter = yield* AdapterService;
      return yield* adapter.getTokenPrices([...mints], { useFallback });
    }).pipe(Effect.provide(layer));
    return Effect.runPromise(program);
  }

  it("resolves unresolved mints to 0 with useFallback: false instead of fabricated fallback prices", async () => {
    // All price sources fail (mockFetch 500s): fetchTokenPrices never fails —
    // every source catches its own errors and returns {} — so an unresolved
    // mint resolves to 0 with useFallback: false, and to the hardcoded
    // fallback price with the default. The stranded-status classification
    // passes useFallback: false precisely so a price-provider outage can
    // never report stranded capital at a fabricated value.
    const restore = mockFetch((async () => new Response("down", { status: 500 })) as unknown as typeof fetch);
    try {
      expect(await readTokenPrices([SOL_MINT], false)).toEqual({ [SOL_MINT]: 0 });
      expect(await readTokenPrices([SOL_MINT], true)).toEqual({ [SOL_MINT]: 165 });
    } finally {
      restore();
    }
  });
});
