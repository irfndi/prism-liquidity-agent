import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { DbLive } from "../engine/db-service.js";
import { program } from "../engine/program.js";
import { StrategyLive } from "../engine/strategy-service.js";
import { MemoryLive } from "../engine/memory-service.js";
import { RiskLive } from "../engine/risk-service.js";
import { AuditLive } from "../engine/audit-service.js";
import { AgentNoOp } from "../engine/agent-service.js";
import { AgentStateMutable } from "../engine/state-service.js";
import { ConfigService, type AppConfig } from "../engine/config-service.js";
import {
  AdapterService,
  BlacklistService,
  AuditService,
  ScreenerService,
  DbService,
  type DbApi,
  RevenueService,
  RevenueConfigService,
  ReferralService,
  AgentService,
  AgentStateService,
  McpServerService,
  HttpStatusServerService,
  EntryPrepService,
  MeteoraDatapiService,
  GeckoTerminalService,
  AlertService,
  type AdapterApi,
  type AgentApi,
  type GeckoTerminalApi,
  type MeteoraDatapiApi,
  type MeteoraPoolStats,
} from "../engine/services.js";
import type { PoolState } from "../engine/types.js";
import { defaultAppConfig, makePool, makeBinArray, makePosition, asOwner } from "./helpers.js";

// ─── Token-level execution-failure breaker (Robinhood rule 12) ──────────────
// A genuine live EXIT failure on a pool arms `token_block:<mint>` for BOTH
// legs; every ENTER gate then rejects new deployment into ANY pool holding a
// blocked leg for `tokenFailureBlockMs` (production default 1h, wired from
// TOKEN_FAILURE_BLOCK_MS in config-service.ts).

// Exit-pool legs: TOKEN_A + TOKEN_B. SHARED_POOL reuses TOKEN_A (must be
// blocked); CLEAN_POOL uses TOKEN_C/TOKEN_D (must stay free).
const TOKEN_A = "TokenABroken11111111111111111111111111111";
const TOKEN_B = "TokenBBroken11111111111111111111111111111";
const TOKEN_C = "TokenCClean1111111111111111111111111111111";
const TOKEN_D = "TokenDClean1111111111111111111111111111111";

const EXIT_POOL = "ExitPoolToken111111111111111111111111111111";
const SHARED_POOL = "SharedTokenPool1111111111111111111111111111";
const CLEAN_POOL = "CleanTokenPool1111111111111111111111111111";

const EXIT_POSITION_ID = "mock-pos-exit";

type MintAuthorities = { mintAuthority: string | null; freezeAuthority: string | null };
const NO_AUTHORITIES: MintAuthorities = { mintAuthority: null, freezeAuthority: null };

// A strong Data API payload: passes pre-filter, candidate conditions and the
// weighted-score threshold (the same fixture idle-redeploy tests enter on).
function makeDatapiStats(overrides: Partial<MeteoraPoolStats> = {}): MeteoraPoolStats {
  return {
    address: EXIT_POOL,
    name: "TEST",
    tvlUsd: 200_000,
    volume24hUsd: 40_000,
    fees24hUsd: 400,
    apr: 20,
    apy: 20,
    currentPrice: 150,
    feeTvlRatio24h: null,
    feeTvlRatio12h: null,
    feeTvlRatio1h: null,
    dynamicFeePct: null,
    baseFeePct: null,
    hasFarm: null,
    farmApr: null,
    farmApy: null,
    isBlacklisted: null,
    tokenXFreezeAuthorityDisabled: null,
    tokenYFreezeAuthorityDisabled: null,
    tokenXVerified: null,
    tokenYVerified: null,
    ...overrides,
  };
}

function makeProgramAdapter(
  pools: Map<string, PoolState>,
  overrides: Partial<AdapterApi> = {},
): AdapterApi {
  return {
    // hasWallet=true so live EXITs reach exitPosition (the real failure
    // path); getWalletAddress=null keeps reconcilePositions a no-op (it
    // early-returns on a null address) so seeded positions survive.
    hasWallet: () => true,
    getWalletAddress: () => null,
    getWalletBalanceUsd: () => Effect.succeed(10_000),
    getWalletHoldings: () =>
      Effect.succeed(new Map<string, { amountAtomic: bigint; decimals: number }>()),
    getNativeSolBalance: () => Effect.succeed(10_000_000_000n), // 10 SOL — clears the live-ENTER SOL floor
    getPoolState: (addr: string) => {
      const pool = pools.get(addr);
      return pool ? Effect.succeed(pool) : Effect.fail(new Error(`unknown pool ${addr}`));
    },
    getBinArray: () => Effect.succeed(makeBinArray()),
    getPositions: () => Effect.succeed([]),
    getAllWalletPositions: () => Effect.succeed([]),
    simulateRebalance: () =>
      Effect.succeed({
        estimatedFeesUsd: 0,
        estimatedCostUsd: 0,
        netBenefitUsd: 0,
        source: "pool-heuristic" as const,
      }),
    enterPosition: (_pool: string, _l: number, _u: number, sizeUsd: number) =>
      Effect.succeed({
        positionPubKey: "mock-pos",
        txSignature: "mock-tx",
        depositMode: "two-sided" as const,
        amountXUsd: sizeUsd / 2,
        amountYUsd: sizeUsd / 2,
      }),
    exitPosition: () => Effect.succeed({ txSignature: "mock-tx" }),
    rebalancePosition: () =>
      Effect.succeed({ positionPubKey: "mock-pos", txSignatures: ["mock-tx"] }),
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
    claimRewards: () =>
      Effect.succeed({ skipped: true, skipReason: "none", txSignatures: [], rewards: [] }),
    discoverPools: () => Effect.succeed([]),
    reportFeeCollection: () => Effect.void,
    swapUSDCForSOL: () => Effect.void,
    getTokenBalance: () => Effect.succeed(0n),
    getTokenPrices: () => Effect.succeed({}),
    getTokenDecimals: () => Effect.succeed(9),
    quoteSwapUSDCForToken: () => Effect.succeed({}),
    swapUSDCForToken: () => Effect.succeed("mock-swap-tx"),
    getMintAuthorities: () => Effect.succeed(NO_AUTHORITIES),
    ...overrides,
  } as AdapterApi;
}

function makeProgramLayer(opts: {
  adapter: AdapterApi;
  datapi?: MeteoraDatapiApi;
  configOverrides?: Partial<AppConfig>;
  agentApi?: AgentApi;
  agentStateLayer?: Layer.Layer<AgentStateService, never, never>;
  gecko?: GeckoTerminalApi;
}) {
  const config = defaultAppConfig({
    paperTrading: true,
    agentMcpEnabled: false,
    agentHttpPort: 0,
    autoUpdate: false,
    scanIntervalMs: 600_000,
    ...opts.configOverrides,
  });
  const dbLayer = DbLive(":memory:");
  return Layer.mergeAll(
    Layer.succeed(ConfigService, config),
    Layer.succeed(AdapterService, opts.adapter),
    StrategyLive,
    Layer.provide(MemoryLive, dbLayer),
    RiskLive({
      confidenceThreshold: config.confidenceThreshold,
      maxRebalanceRangeBins: config.maxRebalanceRangeBins,
      stopLossPct: config.stopLossPct,
      maxPerPoolAllocationPct: config.maxPerPoolAllocationPct,
      maxPositionsPerPool: config.maxPositionsPerPool,
    }),
    Layer.succeed(BlacklistService, {
      isDeployerBlacklisted: () => false,
      isTokenBlacklisted: () => false,
      checkPool: () => Effect.void,
    }),
    Layer.provide(AuditLive, dbLayer),
    Layer.succeed(ScreenerService, { screenPools: () => Effect.succeed([]) }),
    dbLayer,
    Layer.succeed(RevenueService, {
      calculateTier: () => "free",
      calculatePlatformFee: () => ({ platformFeeUsd: 0, netFeeX: 0, netFeeY: 0 }),
      calculateCreditDiscount: () => 0,
    }),
    Layer.succeed(RevenueConfigService, {
      getConfig: () =>
        Effect.succeed({
          tier: "free",
          platformFeeRate: 0,
          revenueShareEnabled: false,
          revenueShareOperatorPct: 0,
          feeWalletAddress: "",
        }),
      refreshConfig: () =>
        Effect.succeed({
          tier: "free",
          platformFeeRate: 0,
          revenueShareEnabled: false,
          revenueShareOperatorPct: 0,
          feeWalletAddress: "",
        }),
    }),
    Layer.succeed(ReferralService, {
      generateCode: () => Effect.succeed("code"),
      validateCode: () => Effect.succeed({ valid: false }),
      applyReferral: () => Effect.void,
      getReferralCount: () => Effect.succeed(0),
    }),
    Layer.succeed(AgentService, opts.agentApi ?? AgentNoOp),
    opts.agentStateLayer ?? AgentStateMutable({ maxPendingProposals: 50 }).layer,
    Layer.succeed(McpServerService, { start: () => Effect.void, stop: () => Effect.void }),
    Layer.succeed(HttpStatusServerService, { start: () => Effect.void, stop: () => Effect.void }),
    Layer.succeed(EntryPrepService, { prepareEntryTokens: () => Effect.succeed(undefined) }),
    Layer.succeed(MeteoraDatapiService, opts.datapi ?? { getPoolData: () => Effect.succeed(null) }),
    Layer.succeed(GeckoTerminalService, opts.gecko ?? { getPoolStats: () => Effect.succeed(null) }),
    Layer.succeed(AlertService, {
      sendAlert: () => Effect.void,
      recordFeeClaim: () => Effect.void,
    }),
  );
}

/** The three pools under test: EXIT (fails), SHARED (shares a leg), CLEAN. */
function makePools(): Map<string, PoolState> {
  return new Map([
    [
      EXIT_POOL,
      makePool({
        address: EXIT_POOL,
        tokenX: TOKEN_A,
        tokenY: TOKEN_B,
        tokenXSymbol: "TOK_A",
        tokenYSymbol: "TOK_B",
        tvlUsd: 60_000, // → -40% vs the 100k previous snapshot (threshold 30%)
      }),
    ],
    [
      SHARED_POOL,
      makePool({
        address: SHARED_POOL,
        tokenX: TOKEN_A,
        tokenY: TOKEN_C,
        tokenXSymbol: "TOK_A",
        tokenYSymbol: "TOK_C",
      }),
    ],
    [
      CLEAN_POOL,
      makePool({
        address: CLEAN_POOL,
        tokenX: TOKEN_C,
        tokenY: TOKEN_D,
        tokenXSymbol: "TOK_C",
        tokenYSymbol: "TOK_D",
      }),
    ],
  ]);
}

function makeDatapi(): MeteoraDatapiApi {
  return {
    getPoolData: (addr: string) =>
      Effect.succeed(
        addr === SHARED_POOL || addr === CLEAN_POOL ? makeDatapiStats({ address: addr }) : null,
      ),
  };
}

/** Seed an open position on EXIT_POOL plus the dropped-TVL snapshot that triggers it. */
function seedFailingExit(db: DbApi): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    yield* db.savePosition(
      makePosition({
        poolAddress: EXIT_POOL,
        positionPubKey: EXIT_POSITION_ID,
        depositedUsd: 1000,
        currentValueUsd: 1000,
      }),
    );
    yield* db.saveSnapshot({
      poolAddress: EXIT_POOL,
      timestamp: Date.now() - 600_000,
      activeBinId: 5000,
      tvlUsd: 100_000, // → -40% vs current 60k (threshold 30%)
      volume24hUsd: 30_000,
      fees24hUsd: 300,
      apr: 60,
      currentPrice: 150,
      binStep: 10,
      tokenXSymbol: "TOK_A",
      tokenYSymbol: "TOK_B",
      binArray: makeBinArray(),
    });
  });
}

/** Close the failed position so a second cycle has no EXIT to re-arm the block. */
function closeExitPosition(db: DbApi): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    yield* db.closePosition(EXIT_POSITION_ID, 0);
  });
}

interface DecisionRow {
  action: string;
  executed: boolean;
  reasoning: string;
  poolAddress: string;
  confidence: number;
}

type TokenBlocks = {
  [TOKEN_A]: string | null;
  [TOKEN_B]: string | null;
  [TOKEN_C]: string | null;
  [TOKEN_D]: string | null;
};

/** Read the token_block metadata rows (null when absent). */
function readTokenBlocks(db: DbApi): Effect.Effect<TokenBlocks, never> {
  return Effect.gen(function* () {
    const read = (mint: string) =>
      db.getMetadata(`token_block:${mint}`).pipe(Effect.catch(() => Effect.succeed(null)));
    const [a, b, c, d] = yield* Effect.all([
      read(TOKEN_A),
      read(TOKEN_B),
      read(TOKEN_C),
      read(TOKEN_D),
    ]);
    return { [TOKEN_A]: a, [TOKEN_B]: b, [TOKEN_C]: c, [TOKEN_D]: d };
  });
}

// Each test constructs its layer explicitly and provides it once; the single
// provide means ONE DbLive(":memory:") instance is shared by the program run,
// the metadata reads and both cycles of the expiry test.
function provideLayer<R, E, Req>(
  test: Effect.Effect<R, E, Req>,
  layer: Layer.Layer<never, never, never>,
): Promise<R> {
  return Effect.runPromise(asOwner<Effect.Effect<R, Error, never>>(Effect.provide(test, layer)));
}

describe("token-level execution-failure breaker (Robinhood rule 12)", () => {
  it("(a)+(b)+(c): failed EXIT blocks both legs; a different pool sharing a leg is [token-block] rejected; clean tokens proceed", async () => {
    const layer = makeProgramLayer({
      adapter: makeProgramAdapter(makePools(), {
        exitPosition: () => Effect.fail(new Error("close tx failed")),
      }),
      datapi: makeDatapi(),
      configOverrides: {
        paperTrading: false,
        watchlistPools: [EXIT_POOL, SHARED_POOL, CLEAN_POOL],
        tvlDropExitPct: 0.3,
        tokenFailureBlockMs: 3_600_000,
      },
    });

    const test = Effect.gen(function* () {
      const db = yield* DbService;
      yield* seedFailingExit(db);
      yield* Effect.raceFirst(program, Effect.sleep(2_500));
      const audit = yield* AuditService;
      const decisions = yield* audit.getRecentDecisions(200);
      const blocks = yield* readTokenBlocks(db);
      return { decisions, blocks };
    });

    const { decisions, blocks } = await provideLayer(test, layer as never);

    // (a) the genuine live EXIT failed on EXIT_POOL...
    const failedExit = decisions.find(
      (d) => d.poolAddress === EXIT_POOL && d.action === "EXIT" && !d.executed,
    );
    expect(failedExit, "the live EXIT must have been attempted and failed").toBeDefined();

    // ...and armed a token block for BOTH of its legs, and only its legs.
    expect(blocks[TOKEN_A], "token_block for the failed EXIT's X leg must be set").not.toBeNull();
    expect(blocks[TOKEN_B], "token_block for the failed EXIT's Y leg must be set").not.toBeNull();
    expect(blocks[TOKEN_C], "unrelated leg must not be blocked").toBeNull();
    expect(blocks[TOKEN_D], "unrelated leg must not be blocked").toBeNull();

    // (b) an ENTER into a DIFFERENT pool sharing a blocked leg is rejected
    // with the [token-block] tag and never executes.
    const sharedEnter = decisions.find(
      (d) => d.poolAddress === SHARED_POOL && d.action === "ENTER",
    );
    expect(sharedEnter, "the shared-leg pool must produce an ENTER decision").toBeDefined();
    expect(sharedEnter!.reasoning, "rejection must carry the [token-block] tag").toContain(
      "[token-block]",
    );
    expect(sharedEnter!.executed, "a blocked-token ENTER must never execute").toBe(false);

    // (c) an ENTER with clean legs proceeds untouched.
    const cleanEnter = decisions.find((d) => d.poolAddress === CLEAN_POOL && d.action === "ENTER");
    expect(cleanEnter, "the clean pool must produce an ENTER decision").toBeDefined();
    expect(cleanEnter!.reasoning).not.toContain("[token-block]");
    expect(cleanEnter!.executed, "clean-token ENTER must execute").toBe(true);
  }, 20_000);

  it("(d): the block expires after tokenFailureBlockMs and the ENTER proceeds", async () => {
    const layer = makeProgramLayer({
      adapter: makeProgramAdapter(makePools(), {
        exitPosition: () => Effect.fail(new Error("close tx failed")),
      }),
      datapi: makeDatapi(),
      configOverrides: {
        paperTrading: false,
        watchlistPools: [EXIT_POOL, SHARED_POOL, CLEAN_POOL],
        tvlDropExitPct: 0.3,
        // Small window for the expiry proof — production wires this from the
        // TOKEN_FAILURE_BLOCK_MS env var (clamped 60s–1h in config-service.ts);
        // the gate reads config.tokenFailureBlockMs ?? 3_600_000. The sleep
        // below waits on the REAL clock because the breaker stamps
        // Date.now() on write and expires on Date.now() - blockAt at read —
        // deterministic fake timers would have to drive two full Effect fiber
        // cycles and the engine clock in lockstep; 150ms is the honest proof.
        tokenFailureBlockMs: 60,
      },
    });

    const test = Effect.gen(function* () {
      const db = yield* DbService;
      // Cycle 1: the failed EXIT arms the block and the shared-leg ENTER is
      // rejected while it is active.
      yield* seedFailingExit(db);
      yield* Effect.raceFirst(program, Effect.sleep(2_500));
      const audit = yield* AuditService;
      const decisions1 = yield* audit.getRecentDecisions(200);

      // Let the block window lapse, close the failed position so no cycle-2
      // EXIT re-arms it, then run a fresh cycle on the same DB.
      yield* closeExitPosition(db);
      yield* Effect.sleep(150);
      yield* Effect.raceFirst(program, Effect.sleep(2_500));
      const decisions2 = yield* audit.getRecentDecisions(200);
      return { decisions1, decisions2 };
    });

    const { decisions1, decisions2 } = await provideLayer(test, layer as never);

    const rejected1 = decisions1.find(
      (d) =>
        d.poolAddress === SHARED_POOL &&
        d.action === "ENTER" &&
        d.reasoning.includes("[token-block]"),
    );
    expect(rejected1, "shared-leg ENTER must be rejected while the block is active").toBeDefined();

    const sharedEnter2 = decisions2.find(
      (d) => d.poolAddress === SHARED_POOL && d.action === "ENTER" && d.executed,
    );
    expect(sharedEnter2, "after expiry the shared-leg pool must ENTER and execute").toBeDefined();
    expect(sharedEnter2!.reasoning, "expired block must not reject the ENTER").not.toContain(
      "[token-block]",
    );
  }, 20_000);
});

// ─── Rug-token breaker (catastrophic realized loss) ────────────────────────
// A position closed at a catastrophic realized loss (default ≥50% of its cost
// basis) marks a rug/drained token: the engine arms `token_rug_block:<mint>`
// for the NON-STABLE legs only and blocks re-entry into that token (any pool
// holding it), while the stable base leg stays free so USDC/SOL are never
// locked out of every other pool.

// Rug pool legs: RUG_TOKEN (the drained token) + RUG_BASE (an operator-declared
// stable, via stablecoinMints override). RUG_SHARED reuses RUG_TOKEN (must be
// blocked); RUG_BASE_POOL reuses RUG_BASE (must stay free).
const RUG_TOKEN = "RugTokenEvil1111111111111111111111111111111";
const RUG_BASE = "RugBaseStable111111111111111111111111111111";
const RUG_POOL = "RugPoolDead11111111111111111111111111111111";
const RUG_SHARED_POOL = "RugSharedTokenPool11111111111111111111111";
const RUG_BASE_POOL = "RugBaseTokenPool1111111111111111111111111";

function makeRugPools(): Map<string, PoolState> {
  return new Map([
    [
      RUG_POOL,
      makePool({
        address: RUG_POOL,
        tokenX: RUG_TOKEN,
        tokenY: RUG_BASE,
        tokenXSymbol: "RUG",
        tokenYSymbol: "BASE",
        tvlUsd: 60_000, // → -40% vs the 100k previous snapshot (threshold 30%)
      }),
    ],
    [
      RUG_SHARED_POOL,
      makePool({
        address: RUG_SHARED_POOL,
        tokenX: RUG_TOKEN,
        tokenY: TOKEN_C,
        tokenXSymbol: "RUG",
        tokenYSymbol: "TOK_C",
      }),
    ],
    [
      RUG_BASE_POOL,
      makePool({
        address: RUG_BASE_POOL,
        tokenX: RUG_BASE,
        tokenY: TOKEN_D,
        tokenXSymbol: "BASE",
        tokenYSymbol: "TOK_D",
      }),
    ],
  ]);
}

/** Strong stats for the two pools that must reach the ENTER gate this cycle. */
function makeRugDatapi(): MeteoraDatapiApi {
  return {
    getPoolData: (addr: string) =>
      Effect.succeed(
        addr === RUG_SHARED_POOL || addr === RUG_BASE_POOL
          ? makeDatapiStats({ address: addr })
          : null,
      ),
  };
}

/** Seed a position on RUG_POOL that will realize a -95% loss when it exits. */
function seedRugExit(db: DbApi): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    yield* db.savePosition(
      makePosition({
        poolAddress: RUG_POOL,
        positionPubKey: "mock-rug-pos",
        positionId: "mock-rug-pos",
        depositedUsd: 1000,
        currentValueUsd: 50,
      }),
    );
    yield* db.saveSnapshot({
      poolAddress: RUG_POOL,
      timestamp: Date.now() - 600_000,
      activeBinId: 5000,
      tvlUsd: 100_000, // → -40% vs current 60k (threshold 30%)
      volume24hUsd: 30_000,
      fees24hUsd: 300,
      apr: 60,
      currentPrice: 150,
      binStep: 10,
      tokenXSymbol: "RUG",
      tokenYSymbol: "BASE",
      binArray: makeBinArray(),
    });
  });
}

/** Read the token_rug_block metadata rows for the two rug-pool legs. */
function readRugBlocks(
  db: DbApi,
): Effect.Effect<{ [RUG_TOKEN]: string | null; [RUG_BASE]: string | null }, never> {
  return Effect.gen(function* () {
    const read = (mint: string) =>
      db.getMetadata(`token_rug_block:${mint}`).pipe(Effect.catch(() => Effect.succeed(null)));
    const [rug, base] = yield* Effect.all([read(RUG_TOKEN), read(RUG_BASE)]);
    return { [RUG_TOKEN]: rug, [RUG_BASE]: base };
  });
}

describe("rug-token breaker (catastrophic realized loss)", () => {
  it("arms token_rug_block for the non-stable leg only and blocks re-entry into the drained token", async () => {
    const layer = makeProgramLayer({
      adapter: makeProgramAdapter(makeRugPools(), {
        // A successful live EXIT that withdraws only $50 of the $1000 basis →
        // realized -95% → the rug threshold (default 50%) arms the block.
        exitPosition: () => Effect.succeed({ txSignature: "mock-tx", withdrawnUsd: 50 }),
      }),
      datapi: makeRugDatapi(),
      configOverrides: {
        paperTrading: false,
        watchlistPools: [RUG_POOL, RUG_SHARED_POOL, RUG_BASE_POOL],
        tvlDropExitPct: 0.3,
        stablecoinMints: new Set([RUG_BASE]),
      },
    });

    const test = Effect.gen(function* () {
      const db = yield* DbService;
      yield* seedRugExit(db);
      yield* Effect.raceFirst(program, Effect.sleep(2_500));
      const audit = yield* AuditService;
      const decisions = yield* audit.getRecentDecisions(200);
      const blocks = yield* readRugBlocks(db);
      return { decisions, blocks };
    });

    const { decisions, blocks } = await provideLayer(test, layer as never);

    expect(blocks[RUG_TOKEN], "drained token must be rug-blocked").not.toBeNull();
    expect(blocks[RUG_BASE], "stable base leg must NOT be rug-blocked").toBeNull();

    const sharedEnter = decisions.find(
      (d) => d.poolAddress === RUG_SHARED_POOL && d.action === "ENTER",
    );
    expect(sharedEnter, "shared-rugged-leg pool must reach the ENTER gate").toBeDefined();
    expect(sharedEnter!.reasoning, "shared-rugged-leg ENTER must carry [token-block]").toContain(
      "[token-block]",
    );
    expect(sharedEnter!.executed, "shared-rugged-leg ENTER must never execute").toBe(false);

    const baseEnter = decisions.find(
      (d) => d.poolAddress === RUG_BASE_POOL && d.action === "ENTER",
    );
    expect(baseEnter, "stable-base pool must reach the ENTER gate").toBeDefined();
    expect(baseEnter!.reasoning, "stable-base pool must not be token-blocked").not.toContain(
      "[token-block]",
    );
  }, 20_000);
});
