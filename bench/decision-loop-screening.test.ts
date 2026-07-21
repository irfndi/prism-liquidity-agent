import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { Effect, Layer } from "effect";
import { StrategyLive } from "../engine/strategy-service.js";
import { program } from "../engine/program.js";
import { DbLive } from "../engine/db-service.js";
import { MemoryLive } from "../engine/memory-service.js";
import { RiskLive } from "../engine/risk-service.js";
import { AuditLive } from "../engine/audit-service.js";
import { AgentNoOp } from "../engine/agent-service.js";
import { AgentStateMutable } from "../engine/state-service.js";
import { ConfigService, type AppConfig } from "../engine/config-service.js";
import { BlacklistLive } from "../engine/blacklist-service.js";
import {
  AdapterService,
  BlacklistService,
  AuditService,
  ScreenerService,
  DbService,
  RevenueService,
  RevenueConfigService,
  ReferralService,
  AgentService,
  McpServerService,
  HttpStatusServerService,
  EntryPrepService,
  MeteoraDatapiService,
  AlertService,
  MemoryService,
  type AdapterApi,
  type BlacklistApi,
  type MeteoraDatapiApi,
  type MeteoraPoolStats,
  type MemoryApi,
} from "../engine/services.js";
import { defaultAppConfig, makePool, makeBinArray, mockFetch } from "./helpers.js";
import { stringifySafe } from "../engine/bigint-json.js";
import { clearTokenRiskCache } from "../engine/token-risk-service.js";

// ─── Wave 2: blacklist unswallow + safety screening ──────────────────────────

const POOL = "PoolScreen11111111111111111111111111111111111";
const TOKEN_X = "So11111111111111111111111111111111111111112";
const TOKEN_Y = "FakeToken1111111111111111111111111111111111";
const BAD_DEPLOYER = "BadDeployer111111111111111111111111111111";

const tmpDir = path.resolve("bench/tmp-wave2-screening");
const deployerPath = path.join(tmpDir, "deployer-blacklist.json");
const tokenPath = path.join(tmpDir, "token-blacklist.json");

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeBlacklistFiles(deployers: ReadonlyArray<string>, tokens: ReadonlyArray<string>) {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(deployerPath, stringifySafe(deployers));
  fs.writeFileSync(tokenPath, stringifySafe(tokens));
}

type MintAuthorities = { mintAuthority: string | null; freezeAuthority: string | null };

function makeAdapter(hooks: {
  getMintAuthorities?: (mint: string) => Effect.Effect<MintAuthorities, unknown>;
}): AdapterApi {
  return {
    hasWallet: () => false,
    getWalletAddress: () => null,
    getWalletBalanceUsd: () => Effect.succeed(10_000),
    getNativeSolBalance: () => Effect.succeed(0n),
    getPoolState: () => Effect.succeed(makePool({ address: POOL })),
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
    enterPosition: (
      _poolAddress: string,
      _lowerBinId: number,
      _upperBinId: number,
      positionSizeUsd: number,
    ) =>
      Effect.succeed({
        positionPubKey: "mock-pos",
        txSignature: "mock-tx",
        depositMode: "two-sided" as const,
        amountXUsd: positionSizeUsd / 2,
        amountYUsd: positionSizeUsd / 2,
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
      Effect.succeed({
        skipped: true,
        skipReason: "no pending rewards",
        txSignatures: [],
        rewards: [],
      }),
    discoverPools: () => Effect.succeed([]),
    reportFeeCollection: () => Effect.void,
    swapUSDCForSOL: () => Effect.void,
    getTokenBalance: () => Effect.succeed(0n),
    getTokenPrices: () => Effect.succeed({}),
    getTokenDecimals: () => Effect.succeed(9),
    quoteSwapUSDCForToken: () => Effect.succeed({}),
    swapUSDCForToken: () => Effect.succeed("mock-swap-tx"),
    getMintAuthorities:
      hooks.getMintAuthorities ??
      (() => Effect.succeed({ mintAuthority: null, freezeAuthority: null })),
  } as AdapterApi;
}

function makeDatapiStats(overrides: Partial<MeteoraPoolStats> = {}): MeteoraPoolStats {
  return {
    address: POOL,
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

interface RecordedMemory {
  category: string;
  content: string;
  poolAddress?: string | undefined;
}

function makeRecordingMemory(record: RecordedMemory[]): MemoryApi {
  return {
    initialize: () => Effect.void,
    upsert: (entry) =>
      Effect.sync(() => {
        record.push({
          category: entry.category,
          content: entry.content,
          poolAddress: entry.poolAddress,
        });
      }),
    getRelevantContext: () => Effect.succeed([]),
    pruneExpired: () => Effect.succeed(0),
    recordOutcome: () => Effect.void,
  };
}

function makeTestLayer(opts: {
  adapter: AdapterApi;
  blacklist: BlacklistApi;
  datapi?: MeteoraDatapiApi;
  memoryRecorded?: RecordedMemory[];
  configOverrides?: Partial<AppConfig>;
}) {
  const config = defaultAppConfig({
    watchlistPools: [POOL],
    scanIntervalMs: 3_600_000,
    paperTrading: true,
    agentMcpEnabled: false,
    agentHttpPort: 0,
    ...opts.configOverrides,
  });
  const dbLayer = DbLive(":memory:");
  return Layer.mergeAll(
    Layer.succeed(ConfigService, config),
    Layer.succeed(AdapterService, opts.adapter),
    StrategyLive,
    opts.memoryRecorded
      ? Layer.succeed(MemoryService, makeRecordingMemory(opts.memoryRecorded))
      : Layer.provide(MemoryLive, dbLayer),
    RiskLive({
      confidenceThreshold: 0.65,
      maxRebalanceRangeBins: 50,
      stopLossPct: 0.15,
      maxPerPoolAllocationPct: 0.4,
      maxPositionsPerPool: 2,
    }),
    Layer.succeed(BlacklistService, opts.blacklist),
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
    Layer.succeed(AgentService, AgentNoOp),
    AgentStateMutable({ maxPendingProposals: 50 }).layer,
    Layer.succeed(McpServerService, { start: () => Effect.void, stop: () => Effect.void }),
    Layer.succeed(HttpStatusServerService, { start: () => Effect.void, stop: () => Effect.void }),
    Layer.succeed(EntryPrepService, { prepareEntryTokens: () => Effect.void }),
    Layer.succeed(MeteoraDatapiService, opts.datapi ?? { getPoolData: () => Effect.succeed(null) }),
    Layer.succeed(AlertService, {
      sendAlert: () => Effect.void,
      recordFeeClaim: () => Effect.void,
    }),
  );
}

async function runOneCycle(layer: ReturnType<typeof makeTestLayer>) {
  const test = Effect.gen(function* () {
    // program loops forever on the scheduler; race it against a timer so the
    // first (immediate) scan cycle runs and then we interrupt it.
    yield* Effect.raceFirst(program, Effect.sleep(2_000));
    const audit = yield* AuditService;
    return yield* audit.getRecentDecisions(50);
  });
  return Effect.runPromise(
    Effect.provide(test, layer) as Effect.Effect<
      ReadonlyArray<{
        poolAddress: string;
        action: string;
        reasoning: string;
        riskResult: { approved: boolean; reason: string };
      }>,
      unknown,
      never
    >,
  );
}

describe("safety screening + blacklist enforcement (Wave 2)", () => {
  it("rejects a pool whose token mint is blacklisted (fail-closed, recorded)", async () => {
    writeBlacklistFiles([], [TOKEN_Y]);
    const layer = makeTestLayer({
      adapter: makeAdapter({}),
      blacklist: Effect.runSync(
        Effect.provide(
          Effect.gen(function* () {
            return yield* BlacklistService;
          }),
          BlacklistLive({ deployerBlacklistPath: deployerPath, tokenBlacklistPath: tokenPath }),
        ),
      ),
    });

    const decisions = await runOneCycle(layer);
    const forPool = decisions.filter((d) => d.poolAddress === POOL);
    expect(
      forPool,
      `expected exactly one recorded (rejected) decision, got: ${stringifySafe(forPool)}`,
    ).toHaveLength(1);
    expect(forPool[0]!.riskResult.approved).toBe(false);
    expect(forPool[0]!.reasoning.toLowerCase()).toContain("blacklist");
  }, 15_000);

  it("rejects a pool whose token deployer (on-chain mint authority) is blacklisted", async () => {
    writeBlacklistFiles([BAD_DEPLOYER], []);
    const layer = makeTestLayer({
      adapter: makeAdapter({
        getMintAuthorities: (mint: string) =>
          Effect.succeed({
            mintAuthority: mint === TOKEN_X ? BAD_DEPLOYER : null,
            freezeAuthority: null,
          }),
      }),
      blacklist: Effect.runSync(
        Effect.provide(
          Effect.gen(function* () {
            return yield* BlacklistService;
          }),
          BlacklistLive({ deployerBlacklistPath: deployerPath, tokenBlacklistPath: tokenPath }),
        ),
      ),
    });

    const decisions = await runOneCycle(layer);
    const forPool = decisions.filter((d) => d.poolAddress === POOL);
    expect(
      forPool,
      `expected exactly one recorded (rejected) decision, got: ${stringifySafe(forPool)}`,
    ).toHaveLength(1);
    expect(forPool[0]!.riskResult.approved).toBe(false);
    expect(forPool[0]!.reasoning.toLowerCase()).toContain("deployer");
  }, 15_000);

  it("fails open when the blacklist service throws a non-BlacklistError (transport error)", async () => {
    const layer = makeTestLayer({
      adapter: makeAdapter({}),
      blacklist: {
        isDeployerBlacklisted: () => false,
        isTokenBlacklisted: () => false,
        checkPool: () => Effect.fail(new Error("disk on fire")),
      },
    });

    const decisions = await runOneCycle(layer);
    const forPool = decisions.filter((d) => d.poolAddress === POOL);
    expect(
      forPool.length,
      "pool should still be processed when the blacklist transport fails",
    ).toBeGreaterThan(0);
    expect(
      forPool.every((d) => d.riskResult.approved),
      `expected no risk/screening rejections, got: ${stringifySafe(forPool.map((d) => d.riskResult))}`,
    ).toBe(true);
  }, 15_000);

  it("rejects a pool the Meteora Data API flags as is_blacklisted", async () => {
    const layer = makeTestLayer({
      adapter: makeAdapter({}),
      blacklist: {
        isDeployerBlacklisted: () => false,
        isTokenBlacklisted: () => false,
        checkPool: () => Effect.void,
      },
      datapi: { getPoolData: () => Effect.succeed(makeDatapiStats({ isBlacklisted: true })) },
    });

    const decisions = await runOneCycle(layer);
    const forPool = decisions.filter((d) => d.poolAddress === POOL);
    expect(
      forPool,
      `expected exactly one recorded (rejected) decision, got: ${stringifySafe(forPool)}`,
    ).toHaveLength(1);
    expect(forPool[0]!.riskResult.approved).toBe(false);
    expect(forPool[0]!.reasoning.toLowerCase()).toContain("blacklist");
  }, 15_000);

  it("rejects a pool whose token has freeze authority enabled per the Data API", async () => {
    const layer = makeTestLayer({
      adapter: makeAdapter({}),
      blacklist: {
        isDeployerBlacklisted: () => false,
        isTokenBlacklisted: () => false,
        checkPool: () => Effect.void,
      },
      datapi: {
        getPoolData: () =>
          Effect.succeed(makeDatapiStats({ tokenXFreezeAuthorityDisabled: false })),
      },
    });

    const decisions = await runOneCycle(layer);
    const forPool = decisions.filter((d) => d.poolAddress === POOL);
    expect(
      forPool,
      `expected exactly one recorded (rejected) decision, got: ${stringifySafe(forPool)}`,
    ).toHaveLength(1);
    expect(forPool[0]!.riskResult.approved).toBe(false);
    expect(forPool[0]!.reasoning.toLowerCase()).toContain("freeze authority");
  }, 15_000);

  it("rejects a pool whose token has an on-chain freeze authority set", async () => {
    const layer = makeTestLayer({
      adapter: makeAdapter({
        getMintAuthorities: (mint: string) =>
          Effect.succeed({
            mintAuthority: null,
            freezeAuthority: mint === TOKEN_Y ? "FreezeAuth1111111111111111111111111" : null,
          }),
      }),
      blacklist: {
        isDeployerBlacklisted: () => false,
        isTokenBlacklisted: () => false,
        checkPool: () => Effect.void,
      },
    });

    const decisions = await runOneCycle(layer);
    const forPool = decisions.filter((d) => d.poolAddress === POOL);
    expect(
      forPool,
      `expected exactly one recorded (rejected) decision, got: ${stringifySafe(forPool)}`,
    ).toHaveLength(1);
    expect(forPool[0]!.riskResult.approved).toBe(false);
    expect(forPool[0]!.reasoning.toLowerCase()).toContain("freeze authority");
  }, 15_000);

  it("fails open when the mint-authority RPC lookup fails (metadata unavailable)", async () => {
    const layer = makeTestLayer({
      adapter: makeAdapter({
        getMintAuthorities: () => Effect.fail(new Error("RPC unreachable")),
      }),
      blacklist: {
        isDeployerBlacklisted: () => false,
        isTokenBlacklisted: () => false,
        checkPool: () => Effect.void,
      },
    });

    const decisions = await runOneCycle(layer);
    const forPool = decisions.filter((d) => d.poolAddress === POOL);
    expect(
      forPool.length,
      "pool should still be processed when metadata is unavailable",
    ).toBeGreaterThan(0);
    expect(
      forPool.every((d) => d.riskResult.approved),
      `expected no screening rejections, got: ${stringifySafe(forPool.map((d) => d.riskResult))}`,
    ).toBe(true);
  }, 15_000);
});

// ─── Wave 17: freeze-authority allowlist + smart screening ───────────────────

describe("freeze-authority allowlist + smart screening (Wave 17)", () => {
  const noBlacklist: BlacklistApi = {
    isDeployerBlacklisted: () => false,
    isTokenBlacklisted: () => false,
    checkPool: () => Effect.void,
  };

  it("processes a pool whose on-chain freeze-authority mint is on the trusted stablecoin allowlist", async () => {
    const layer = makeTestLayer({
      adapter: makeAdapter({
        getMintAuthorities: (mint: string) =>
          Effect.succeed({
            mintAuthority: null,
            // Freeze authority set on the USDC leg, which is allowlisted below.
            freezeAuthority: mint === TOKEN_Y ? "FreezeAuth1111111111111111111111111" : null,
          }),
      }),
      blacklist: noBlacklist,
      configOverrides: { stablecoinMints: new Set([TOKEN_Y]) },
    });

    const decisions = await runOneCycle(layer);
    const forPool = decisions.filter((d) => d.poolAddress === POOL);
    expect(forPool.length, "trusted freeze-enabled pool should still be processed").toBeGreaterThan(
      0,
    );
    expect(
      forPool.every((d) => d.riskResult.approved),
      `expected no screening rejection for an allowlisted freeze mint, got: ${stringifySafe(forPool.map((d) => d.riskResult))}`,
    ).toBe(true);
  }, 15_000);

  it("processes a pool whose Data-API freeze flag is on a stablecoin-listed mint", async () => {
    const layer = makeTestLayer({
      adapter: makeAdapter({}),
      blacklist: noBlacklist,
      datapi: {
        getPoolData: () =>
          Effect.succeed(makeDatapiStats({ tokenXFreezeAuthorityDisabled: false })),
      },
      configOverrides: { stablecoinMints: new Set([TOKEN_X]) },
    });

    const decisions = await runOneCycle(layer);
    const forPool = decisions.filter((d) => d.poolAddress === POOL);
    expect(forPool.length, "trusted freeze-enabled pool should still be processed").toBeGreaterThan(
      0,
    );
    expect(
      forPool.every((d) => d.riskResult.approved),
      `expected no screening rejection for an allowlisted freeze mint, got: ${stringifySafe(forPool.map((d) => d.riskResult))}`,
    ).toBe(true);
  }, 15_000);

  it("passes an UNTRUSTED freeze-enabled pool to the pipeline when FREEZE_SMART_SCREENING is on", async () => {
    const layer = makeTestLayer({
      adapter: makeAdapter({
        getMintAuthorities: (mint: string) =>
          Effect.succeed({
            mintAuthority: null,
            freezeAuthority: mint === TOKEN_Y ? "FreezeAuth1111111111111111111111111" : null,
          }),
      }),
      blacklist: noBlacklist,
      // defaultAppConfig pins stablecoinMints empty → TOKEN_Y is untrusted.
      configOverrides: { freezeSmartScreening: true },
    });

    const decisions = await runOneCycle(layer);
    const forPool = decisions.filter((d) => d.poolAddress === POOL);
    expect(
      forPool.length,
      "smart-screened freeze pool should continue into the pipeline, not be rejected",
    ).toBeGreaterThan(0);
    expect(
      forPool.every((d) => d.riskResult.approved),
      `expected an approved pipeline decision (no safety rejection), got: ${stringifySafe(forPool.map((d) => d.riskResult))}`,
    ).toBe(true);
    expect(
      forPool.some((d) => d.reasoning.toLowerCase().includes("[safety]")),
      "smart pass-through must NOT write a rejected [safety] HOLD audit record",
    ).toBe(false);
  }, 15_000);

  it("rejects an UNTRUSTED freeze-enabled pool with an actionable hint when the flag is off", async () => {
    const layer = makeTestLayer({
      adapter: makeAdapter({
        getMintAuthorities: (mint: string) =>
          Effect.succeed({
            mintAuthority: null,
            freezeAuthority: mint === TOKEN_Y ? "FreezeAuth1111111111111111111111111" : null,
          }),
      }),
      blacklist: noBlacklist,
      // freezeSmartScreening defaults to false in defaultAppConfig.
    });

    const decisions = await runOneCycle(layer);
    const forPool = decisions.filter((d) => d.poolAddress === POOL);
    expect(forPool).toHaveLength(1);
    expect(forPool[0]!.riskResult.approved).toBe(false);
    const reasoning = forPool[0]!.reasoning.toLowerCase();
    expect(reasoning).toContain("freeze authority");
    expect(reasoning, "rejection must name the actionable remediation knobs").toContain(
      "stablecoin_mints",
    );
    expect(reasoning).toContain("freeze_smart_screening");
  }, 15_000);

  it("still rejects freeze on a stablecoin-addressed mint when the allowlist is explicitly empty", async () => {
    const layer = makeTestLayer({
      adapter: makeAdapter({
        getMintAuthorities: (mint: string) =>
          Effect.succeed({
            mintAuthority: null,
            // Freeze authority on the USDC-addressed leg.
            freezeAuthority: mint === TOKEN_Y ? "FreezeAuth1111111111111111111111111" : null,
          }),
      }),
      blacklist: noBlacklist,
      // STABLECOIN_MINTS="" disables exemptions entirely.
      configOverrides: { stablecoinMints: new Set() },
    });

    const decisions = await runOneCycle(layer);
    const forPool = decisions.filter((d) => d.poolAddress === POOL);
    expect(forPool).toHaveLength(1);
    expect(forPool[0]!.riskResult.approved).toBe(false);
    expect(forPool[0]!.reasoning.toLowerCase()).toContain("freeze authority");
  }, 15_000);
});

// ─── Wave 18: token-risk overlay (Jupiter + Data API is_verified) ────────────

// The overlay's module-level cache is keyed by mint and shared across tests, so
// every test starts from an empty cache (TOKEN_X/TOKEN_Y are reused constants).
beforeEach(() => {
  clearTokenRiskCache();
});

describe("token-risk overlay + freeze screening (Wave 18)", () => {
  const noBlacklist: BlacklistApi = {
    isDeployerBlacklisted: () => false,
    isTokenBlacklisted: () => false,
    checkPool: () => Effect.void,
  };

  function jupiterFetch(entries: ReadonlyArray<unknown>): () => void {
    return mockFetch(async () => new Response(JSON.stringify(entries), { status: 200 }));
  }

  function freezeOnLegY(): AdapterApi {
    return makeAdapter({
      getMintAuthorities: (mint: string) =>
        Effect.succeed({
          mintAuthority: null,
          freezeAuthority: mint === TOKEN_Y ? "FreezeAuth1111111111111111111111111" : null,
        }),
    });
  }

  it("(8) exempts a freeze-enabled untrusted leg the Data API marks is_verified (master off)", async () => {
    const recordedMemory: RecordedMemory[] = [];
    const layer = makeTestLayer({
      adapter: freezeOnLegY(),
      blacklist: noBlacklist,
      memoryRecorded: recordedMemory,
      datapi: {
        getPoolData: () =>
          Effect.succeed(
            makeDatapiStats({ tokenYFreezeAuthorityDisabled: false, tokenYVerified: true }),
          ),
      },
      // master stays pinned false (default fixture) — the Data API verification
      // exemption does not require a Jupiter fetch.
    });

    const decisions = await runOneCycle(layer);
    const forPool = decisions.filter((d) => d.poolAddress === POOL);
    expect(
      forPool.length,
      "Data-API-verified freeze pool should be processed, not rejected",
    ).toBeGreaterThan(0);
    expect(
      forPool.every((d) => d.riskResult.approved),
      `expected no safety rejection, got: ${stringifySafe(forPool.map((d) => d.riskResult))}`,
    ).toBe(true);
    const warnings = recordedMemory.filter((m) => m.category === "warning");
    expect(
      warnings.some((m) => m.content.toLowerCase().includes("verified")),
      `expected a Data API verification exemption warning, got: ${stringifySafe(warnings)}`,
    ).toBe(true);
  }, 15_000);

  it("(9) hard-rejects when Jupiter flags the untrusted freeze leg isSus", async () => {
    const restore = jupiterFetch([
      { address: TOKEN_Y, audit: { isSus: true }, isVerified: null, organicScore: 5 },
    ]);
    try {
      const layer = makeTestLayer({
        adapter: freezeOnLegY(),
        blacklist: noBlacklist,
        configOverrides: { jupiterTokenRiskEnabled: true },
      });

      const decisions = await runOneCycle(layer);
      const forPool = decisions.filter((d) => d.poolAddress === POOL);
      expect(forPool).toHaveLength(1);
      expect(forPool[0]!.riskResult.approved).toBe(false);
      const reasoning = forPool[0]!.reasoning.toLowerCase();
      expect(reasoning).toContain("suspicious");
      expect(reasoning).toContain(TOKEN_Y.toLowerCase());
    } finally {
      restore();
    }
  }, 15_000);

  it("(10) passes a freeze leg that Jupiter marks isVerified (and not isSus)", async () => {
    const restore = jupiterFetch([
      { address: TOKEN_Y, audit: { isSus: false }, isVerified: true, organicScoreLabel: "high" },
    ]);
    try {
      const layer = makeTestLayer({
        adapter: freezeOnLegY(),
        blacklist: noBlacklist,
        configOverrides: { jupiterTokenRiskEnabled: true },
      });

      const decisions = await runOneCycle(layer);
      const forPool = decisions.filter((d) => d.poolAddress === POOL);
      expect(
        forPool.length,
        "Jupiter-verified freeze pool should be processed, not rejected",
      ).toBeGreaterThan(0);
      expect(
        forPool.every((d) => d.riskResult.approved),
        `expected no safety rejection, got: ${stringifySafe(forPool.map((d) => d.riskResult))}`,
      ).toBe(true);
    } finally {
      restore();
    }
  }, 15_000);

  it("(11) a disabled overlay performs zero fetches and keeps the strict reject", async () => {
    let calls = 0;
    const restore = mockFetch(async () => {
      calls += 1;
      return new Response("[]", { status: 200 });
    });
    try {
      const layer = makeTestLayer({
        adapter: freezeOnLegY(),
        blacklist: noBlacklist,
        // master pinned false by the default fixture (jupiterTokenRiskEnabled).
      });

      const decisions = await runOneCycle(layer);
      const forPool = decisions.filter((d) => d.poolAddress === POOL);
      expect(forPool).toHaveLength(1);
      expect(forPool[0]!.riskResult.approved).toBe(false);
      expect(forPool[0]!.reasoning.toLowerCase()).toContain("freeze authority");
      expect(calls).toBe(0);
    } finally {
      restore();
    }
  }, 15_000);

  it("(13) a pool rejected by a local ENTER gate performs zero Jupiter fetches (token-risk consult deferred until local eligibility)", async () => {
    let jupiterCalls = 0;
    const restore = mockFetch(async (url: string | URL | Request) => {
      if (String(url).includes("api.jup.ag")) jupiterCalls += 1;
      // Served ONLY if the gate consults early (pre-fix behavior): this flag
      // would have stolen the audit reason from the local fee/IL gate.
      return new Response(JSON.stringify([{ address: TOKEN_Y, audit: { isSus: true } }]), {
        status: 200,
      });
    });
    try {
      const layer = makeTestLayer({
        adapter: makeAdapter({}),
        blacklist: noBlacklist,
        // feeIlRatio caps at 20 (strategy-service MAX_FEE_IL_RATIO), so a
        // floor of 25 guarantees the local [fee-il-gate] rejects this pool
        // deterministically, independent of computed metrics.
        configOverrides: {
          jupiterTokenRiskEnabled: true,
          ilProtectionEnabled: true,
          minFeeIlRatio: 25,
        },
      });

      const decisions = await runOneCycle(layer);
      const forPool = decisions.filter((d) => d.poolAddress === POOL);
      expect(jupiterCalls, "locally-ineligible pool must not trigger a Jupiter consult").toBe(0);
      expect(forPool.length).toBeGreaterThan(0);
      const rejected = forPool.find((d) => !d.riskResult.approved);
      expect(rejected).toBeDefined();
      expect(rejected!.reasoning.toLowerCase()).toContain("fee-il");
    } finally {
      restore();
    }
  }, 15_000);

  it("(12) hard-rejects a Data-API-verified untrusted freeze leg when Jupiter flags it isSus (isSus beats verified)", async () => {
    // Freeze-enabled leg X is ALSO marked is_verified by the Data API. Under the
    // old datapiVerified-first ordering this leg would be exempted; isSus must be
    // checked first so the spoofed positive cannot cancel the hard reject.
    const restore = jupiterFetch([
      { address: TOKEN_X, audit: { isSus: true }, isVerified: true, organicScoreLabel: "high" },
    ]);
    try {
      const layer = makeTestLayer({
        adapter: makeAdapter({}),
        blacklist: noBlacklist,
        datapi: {
          getPoolData: () =>
            Effect.succeed(
              makeDatapiStats({ tokenXFreezeAuthorityDisabled: false, tokenXVerified: true }),
            ),
        },
        configOverrides: { jupiterTokenRiskEnabled: true },
      });

      const decisions = await runOneCycle(layer);
      const forPool = decisions.filter((d) => d.poolAddress === POOL);
      expect(forPool).toHaveLength(1);
      expect(forPool[0]!.riskResult.approved).toBe(false);
      const reasoning = forPool[0]!.reasoning.toLowerCase();
      expect(reasoning).toContain("suspicious");
      expect(reasoning).toContain(TOKEN_X.toLowerCase());
    } finally {
      restore();
    }
  }, 15_000);
});
