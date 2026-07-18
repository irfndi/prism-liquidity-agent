import { describe, it, expect, afterEach } from "vitest";
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
  type AdapterApi,
  type BlacklistApi,
  type MeteoraDatapiApi,
  type MeteoraPoolStats,
} from "../engine/services.js";
import { defaultAppConfig, makePool, makeBinArray } from "./helpers.js";
import { stringifySafe } from "../engine/bigint-json.js";

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
    isBlacklisted: null,
    tokenXFreezeAuthorityDisabled: null,
    tokenYFreezeAuthorityDisabled: null,
    ...overrides,
  };
}

function makeTestLayer(opts: {
  adapter: AdapterApi;
  blacklist: BlacklistApi;
  datapi?: MeteoraDatapiApi;
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
    Layer.provide(MemoryLive, dbLayer),
    RiskLive({
      confidenceThreshold: 0.65,
      maxRebalanceRangeBins: 50,
      stopLossPct: 0.15,
      maxPerPoolAllocationPct: 0.4,
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
