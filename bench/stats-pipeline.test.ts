import { describe, it, expect, afterEach, beforeEach } from "vitest";
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
import {
  type GeckoPoolStats,
  setGeckoRequestIntervalMsForTest,
} from "../engine/gecko-terminal-service.js";
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
  GeckoTerminalService,
  AlertService,
  type AdapterApi,
  type MeteoraDatapiApi,
  type MeteoraPoolStats,
  type EngineAlert,
} from "../engine/services.js";
import type { PoolMetrics } from "../engine/types.js";
import { defaultAppConfig, makePool, makeBinArray, makePosition } from "./helpers.js";

// ─── Stats source pipeline: datapi > geckoterminal > heuristic ──────────────
// Fabricated (heuristic) stats must never pass a volume/fee gate. This file
// drives the FULL scan loop with both stats sources injected as service stubs
// so each tier's propagation (statsSource + known flags + gate behaviour) is
// exercised end to end. The gecko client is consumed through the
// GeckoTerminalService Context.Tag, so a Layer.succeed stub feeds it directly —
// no global-fetch mocking; the datapi client is stubbed at its service too.

type MintAuthorities = { mintAuthority: string | null; freezeAuthority: string | null };
const NO_AUTHORITIES: MintAuthorities = { mintAuthority: null, freezeAuthority: null };

function makeAdapter(pools: Record<string, ReturnType<typeof makePool>>): AdapterApi {
  return {
    hasWallet: () => false,
    getWalletAddress: () => null,
    getWalletBalanceUsd: () => Effect.succeed(10_000),
    getNativeSolBalance: () => Effect.succeed(0n),
    getPoolState: (addr: string) => {
      const pool = pools[addr];
      if (!pool) return Effect.fail(new Error(`unknown pool ${addr}`));
      // Mirror the real adapter invariant: raw on-chain pool state is always
      // tagged "heuristic" until program.ts enriches it with a measured source.
      return Effect.succeed({ ...pool, statsSource: pool.statsSource ?? "heuristic" });
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
    getMintAuthorities: () => Effect.succeed(NO_AUTHORITIES),
  } as AdapterApi;
}

function makeTestLayer(opts: {
  adapter: AdapterApi;
  datapi?: MeteoraDatapiApi;
  gecko?: GeckoPoolStats | null;
  configOverrides?: Partial<AppConfig>;
  alertCapture?: EngineAlert[];
}) {
  const config = defaultAppConfig({
    scanIntervalMs: 3_600_000,
    paperTrading: true,
    agentMcpEnabled: false,
    agentHttpPort: 0,
    ...opts.configOverrides,
  });
  const dbLayer = DbLive(":memory:");
  const capture = opts.alertCapture;
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
      maxPositionsPerPool: 2,
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
    Layer.succeed(AgentService, AgentNoOp),
    AgentStateMutable({ maxPendingProposals: 50 }).layer,
    Layer.succeed(McpServerService, { start: () => Effect.void, stop: () => Effect.void }),
    Layer.succeed(HttpStatusServerService, { start: () => Effect.void, stop: () => Effect.void }),
    Layer.succeed(EntryPrepService, { prepareEntryTokens: () => Effect.void }),
    Layer.succeed(MeteoraDatapiService, opts.datapi ?? { getPoolData: () => Effect.succeed(null) }),
    Layer.succeed(GeckoTerminalService, {
      getPoolStats: () => Effect.succeed(opts.gecko ?? null),
    }),
    Layer.succeed(AlertService, {
      sendAlert: capture
        ? (alert) =>
            Effect.sync(() => {
              capture.push(alert);
            })
        : () => Effect.void,
      recordFeeClaim: () => Effect.void,
    }),
  );
}

type DecisionRow = {
  poolAddress: string;
  action: string;
  reasoning: string;
  confidence: number;
  executed: boolean;
  riskResult: { approved: boolean; reason: string };
  metrics?: PoolMetrics;
};

// Runs a single cycle after seeding positions, then returns audit rows (with the
// metrics snapshot, which carries pool.statsSource + the known flags).
function runWithSeed(
  layer: ReturnType<typeof makeTestLayer>,
  positions: ReadonlyArray<ReturnType<typeof makePosition>>,
): Promise<ReadonlyArray<DecisionRow>> {
  const test = Effect.gen(function* () {
    const db = yield* DbService;
    for (const pos of positions) {
      yield* db.savePosition(pos);
    }
    yield* Effect.raceFirst(program, Effect.sleep(2_000));
    const audit = yield* AuditService;
    return yield* audit.getRecentDecisions(200);
  });
  return Effect.runPromise(
    Effect.provide(test, layer) as Effect.Effect<ReadonlyArray<DecisionRow>, unknown, never>,
  );
}

// Parsed gecko fixture (what the real client returns after parsing a 200 with
// pool_fee_percentage null). The default makePool binStep is 10, so the consumer
// passes baseFeeRate = 0.0025 + binStep/1e4 = 0.0035 and the real client would
// compute fees24hUsd = volume24hUsd × 0.0035 — baking that value in here keeps
// the stub byte-for-byte equivalent to the parsed live response.
function geckoStats(volume24hUsd: number, reserveUsd: number): GeckoPoolStats {
  return {
    tvlUsd: reserveUsd,
    volume24hUsd,
    fees24hUsd: volume24hUsd * 0.0035,
    basePriceUsd: 150,
    quotePriceUsd: 1,
  };
}

// Data-API-shaped pool stats (measured fees) for the datapi enrichment path.
function makeDatapiStats(): MeteoraPoolStats {
  return {
    address: POOL,
    name: "SOL-USDC",
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
  };
}

const POOL = "PoolStatsPipeline1111111111111111111111111";

function poolRows(rows: ReadonlyArray<DecisionRow>): ReadonlyArray<DecisionRow> {
  return rows.filter((r) => r.poolAddress === POOL);
}

// The gecko client is now stubbed at the service level, so these cycles never
// touch the real HTTP client; the pacing hook is kept (and restored) defensively
// so a shared-module interval change in another test cannot leak into this file.
beforeEach(() => {
  setGeckoRequestIntervalMsForTest(0);
});

afterEach(() => {
  setGeckoRequestIntervalMsForTest(2_100);
});

describe("stats source propagation — datapi vs gecko vs heuristic", () => {
  it("datapi down + gecko up → enriches geckoterminal: volume/TVL known, fees NOT known (modeled) so [fee-il-gate] SKIPS", async () => {
    // gecko volume 100 × 0.0035 = fees ≈ 0.35 on tvl 100_000 → a low fee/IL
    // ratio (< 1.2). Gecko volume + TVL are REAL (volumeAuthenticityKnown=true),
    // but gecko fees are a binStep base-rate MODEL (pool_fee_percentage is null
    // for every CL pool — only the Data API measures fees), so
    // feeIlRatioKnown=false and even with ilProtectionEnabled the hard ENTER
    // floor must SKIP rather than act on the modeled ratio.
    const layer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: makePool({ address: POOL }) }),
      datapi: { getPoolData: () => Effect.succeed(null) }, // datapi down
      gecko: geckoStats(100, 100_000),
      configOverrides: {
        watchlistPools: [POOL],
        ilProtectionEnabled: true,
        geckoTerminalEnabled: true,
      },
    });
    const rows = await runWithSeed(layer, []);
    const rows_ = poolRows(rows);
    const metrics = rows_.find((r) => r.metrics !== undefined)?.metrics;
    expect(metrics, "expected an audited decision carrying metrics").toBeDefined();
    expect(metrics!.pool.statsSource).toBe("geckoterminal");
    expect(metrics!.volumeAuthenticityKnown, "gecko volume + TVL ARE real").toBe(true);
    expect(metrics!.feeIlRatioKnown, "gecko fees are modeled, not measured").toBe(false);
    const gateRejects = rows_.filter(
      (d) => d.action === "ENTER" && d.reasoning.includes("[fee-il-gate]"),
    );
    expect(gateRejects, "modeled gecko fees must not drive the hard fee/IL floor").toHaveLength(0);
  }, 15_000);

  it("a high-quality gecko pool still ENTERs via the volume candidate path (volume known)", async () => {
    // High real volume on moderate TVL → vol/tvl 4 (authenticity 1.0), so the
    // pool clears the MEASURED ENTER conditions on gecko stats:
    // volumeAuthenticityKnown=true (real gecko volume) unlocks the candidate gate,
    // and the modeled fee/IL is EXCLUDED from the ×1.5 candidate requirement and
    // the weightedEntryScore fee term (the Data API exposes per-pool baseFeePct,
    // so the binStep model can OVERSTATE fees — exclusion, not directional trust).
    // With the fee signal absent, the measured auth/bin-util/TVL terms alone clear
    // the weighted-score threshold; the datapi-only [fee-il-gate] skip (fees
    // modeled) must not keep a good pool out.
    const layer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: makePool({ address: POOL, tvlUsd: 5_000_000 }) }),
      datapi: { getPoolData: () => Effect.succeed(null) },
      gecko: geckoStats(20_000_000, 5_000_000),
      configOverrides: { watchlistPools: [POOL], geckoTerminalEnabled: true },
    });
    const rows = await runWithSeed(layer, []);
    const rows_ = poolRows(rows);
    const enters = rows_.filter((d) => d.action === "ENTER");
    expect(enters, "volume-known gecko pool must reach the ENTER push").toHaveLength(1);
    expect(enters[0]!.reasoning).toContain("Strong pool");
  }, 15_000);

  it("datapi down + gecko down → heuristic, known-flags false, [fee-il-gate] skipped (volume-unknown blocks entry instead)", async () => {
    // Same low-fee pool, but BOTH real sources are down → heuristic. The OLD
    // behaviour rejected ENTER via [fee-il-gate] on the FABRICATED ratio; it must
    // now skip — the volume candidate gate (volumeAuthenticityKnown required)
    // keeps the pool out, just not via a made-up fee/IL number.
    const layer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: makePool({ address: POOL, fees24hUsd: 1 }) }),
      datapi: { getPoolData: () => Effect.succeed(null) },
      gecko: null, // gecko down
      configOverrides: {
        watchlistPools: [POOL],
        ilProtectionEnabled: true,
        geckoTerminalEnabled: true,
      },
    });
    const rows = await runWithSeed(layer, []);
    const rows_ = poolRows(rows);
    const metrics = rows_.find((r) => r.metrics !== undefined)?.metrics;
    expect(metrics).toBeDefined();
    expect(metrics!.pool.statsSource).toBe("heuristic");
    expect(metrics!.volumeAuthenticityKnown).toBe(false);
    expect(metrics!.feeIlRatioKnown).toBe(false);
    // No [fee-il-gate] rejection (fabricated ratio must not reject), and no
    // ENTER at all (volume-unknown path).
    const gateRejects = rows_.filter((d) => d.reasoning.includes("[fee-il-gate]"));
    expect(gateRejects, "heuristic must not reject via [fee-il-gate]").toHaveLength(0);
    const enters = rows_.filter((d) => d.action === "ENTER");
    expect(enters, "volume-unknown heuristic pool must not ENTER").toHaveLength(0);
  }, 15_000);

  it("heuristic fee/IL EXIT gate is skipped despite a fabricated-low ratio (tracked position stays)", async () => {
    // In-range paper position on a stable heuristic pool whose modeled fee/IL is
    // < 0.5. The fee/IL EXIT MUST skip (feeIlRatioKnown=false) rather than dump
    // the position on a fabricated low-fee number. No other EXIT fires (stable
    // TVL, in-range, no drawdown), so the position is held.
    // fees 0.3 on tvl 100_000 → fee/IL ≈ 0.12-0.24, reliably < 0.5, so the old
    // (unguarded) code WOULD have fired the fee/IL EXIT here.
    const layer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: makePool({ address: POOL, fees24hUsd: 0.3 }) }),
      datapi: { getPoolData: () => Effect.succeed(null) },
      gecko: null, // gecko down
      configOverrides: { watchlistPools: [POOL], geckoTerminalEnabled: true },
    });
    const position = makePosition({
      poolAddress: POOL,
      depositedUsd: 1000,
      currentValueUsd: 1000,
    });
    const rows = await runWithSeed(layer, [position]);
    const rows_ = poolRows(rows);
    const feeIlExits = rows_.filter(
      (d) => d.action === "EXIT" && d.reasoning.includes("Fee/IL ratio"),
    );
    expect(feeIlExits, "heuristic fabricated-low fee/IL must not force an EXIT").toHaveLength(0);
    const metrics = rows_.find((r) => r.metrics !== undefined)?.metrics;
    expect(metrics).toBeDefined();
    expect(metrics!.feeIlRatioKnown).toBe(false);
    const exits = rows_.filter((d) => d.action === "EXIT");
    expect(exits, "stable in-range heuristic position is held, not exited").toHaveLength(0);
  }, 15_000);
});

// Data-API stats shaped to yield a KNOWN fee/IL ratio well below the ×1.5
// candidate floor (fees low relative to real TVL) while authenticity stays 1.0
// (moderate volume, fee rate in-band). Proves a known ratio still gates the
// volume-candidate ENTER path that an unknown (gecko) ratio is excluded from.
function lowFeeDatapiStats(): MeteoraPoolStats {
  return {
    ...makeDatapiStats(),
    tvlUsd: 5_000_000,
    volume24hUsd: 100_000,
    fees24hUsd: 50, // ratio ≈ fees/(tvl × ilFraction) < 1.8 for any multiplier ≥ 1
  };
}

describe("modeled fee/IL is excluded from EVERY ENTER gate (fees unknown)", () => {
  // The modeled/fabricated fee/IL ratio (feeIlRatioKnown=false) must not gate
  // entry in EITHER direction — the Data API exposes per-pool baseFeePct, so the
  // generic binStep model can OVERSTATE fees and the ratio can OVERSTATE
  // economics. A gecko pool therefore ENTERs on the measured volume/bin-util/TVL
  // conditions even when its modeled ratio would FAIL the ×1.5 candidate floor,
  // while a datapi pool with a genuinely KNOWN low ratio is still gated.

  it("(a) gecko pool ENTERs on measured signals despite a modeled ratio that fails the ×1.5 floor", async () => {
    // Modest real gecko volume against high TVL → authenticity 1.0 and bin util
    // 1.0 (every measured condition passes), but fees = volume × 0.0035 are tiny
    // → the MODELED fee/IL sits far below minFeeIlRatio × 1.5. Pre-fix the
    // candidate conjunct `feeIlRatio > 1.8` was false, so no ENTER decision
    // existed (HOLD); post-fix the conjunct is conditional-true for unknown
    // ratios and the pool is admitted on the measured conditions alone. (The
    // recorded ENTER decision may still be risk-rejected for confidence — a
    // separate gate; what proves exclusion is that the candidate gate no longer
    // blocks on the modeled ratio, so the "Strong pool" decision is recorded.)
    const layer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: makePool({ address: POOL, tvlUsd: 5_000_000 }) }),
      datapi: { getPoolData: () => Effect.succeed(null) }, // datapi down → gecko
      gecko: geckoStats(15_000, 5_000_000),
      configOverrides: {
        watchlistPools: [POOL],
        ilProtectionEnabled: true,
        geckoTerminalEnabled: true,
      },
    });
    const rows = await runWithSeed(layer, []);
    const rows_ = poolRows(rows);
    const metrics = rows_.find((r) => r.metrics !== undefined)?.metrics;
    expect(metrics, "expected an audited decision carrying metrics").toBeDefined();
    expect(metrics!.pool.statsSource).toBe("geckoterminal");
    expect(metrics!.volumeAuthenticityKnown).toBe(true);
    expect(metrics!.feeIlRatioKnown, "gecko fees are modeled, not measured").toBe(false);
    // The modeled ratio WOULD have failed the old ×1.5 candidate conjunct…
    expect(metrics!.feeIlRatio).toBeLessThan(1.8); // default minFeeIlRatio 1.2 × 1.5
    // …yet the pool reaches the ENTER push on measured signals (the "Strong
    // pool" reasoning is set only inside the candidate gate's score branch).
    const enters = rows_.filter((d) => d.action === "ENTER" && d.reasoning.includes("Strong pool"));
    expect(
      enters,
      "gecko pool must ENTER on measured signals despite the failing modeled ratio",
    ).toHaveLength(1);
  }, 15_000);

  it("(b) datapi pool with a KNOWN ratio below the ×1.5 floor does NOT enter (known ratio still gates)", async () => {
    // Measured datapi pool: authenticity 1.0, bin util 1.0, high TVL — every
    // MEASURED candidate condition passes, but the real fee/IL is below ×1.5.
    // ilProtectionEnabled=false isolates the volume-candidate path (the hard
    // [fee-il-gate] floor is off), so the known ratio alone blocks entry — the
    // mirror image of (a), proving the exclusion is keyed on feeIlRatioKnown.
    const layer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: makePool({ address: POOL, tvlUsd: 5_000_000 }) }),
      datapi: { getPoolData: () => Effect.succeed(lowFeeDatapiStats()) },
      configOverrides: {
        watchlistPools: [POOL],
        ilProtectionEnabled: false,
        geckoTerminalEnabled: true,
      },
    });
    const rows = await runWithSeed(layer, []);
    const rows_ = poolRows(rows);
    const metrics = rows_.find((r) => r.metrics !== undefined)?.metrics;
    expect(metrics, "expected an audited decision carrying metrics").toBeDefined();
    expect(metrics!.pool.statsSource).toBe("datapi");
    expect(metrics!.feeIlRatioKnown, "datapi fees are measured").toBe(true);
    expect(metrics!.feeIlRatio).toBeLessThan(1.8); // below the ×1.5 candidate floor
    const enters = rows_.filter((d) => d.action === "ENTER" && d.reasoning.includes("Strong pool"));
    expect(enters, "a known sub-×1.5 ratio must still gate the volume candidate").toHaveLength(0);
    const holds = rows_.filter((d) => d.action === "HOLD");
    expect(
      holds,
      "the pool falls through to HOLD when the known ratio fails the candidate",
    ).toHaveLength(1);
  }, 15_000);
});

describe("paper notional-fee accrual respects the stats source", () => {
  // In-range paper position; the accrual gate is statsSource === "datapi":
  // ONLY Data-API-measured fees accrue. Gecko fees are a binStep base-rate
  // MODEL on real volume (pool_fee_percentage is null for CL pools) and
  // heuristic fees are fabricated — neither books paper CLAIM income.
  const SEEDED_POSITION_ID = `paper-${POOL}`;

  function inRangePaperPosition() {
    return makePosition({ poolAddress: POOL, depositedUsd: 1000, currentValueUsd: 1000 });
  }

  function readAccruedFees(layer: ReturnType<typeof makeTestLayer>): Promise<number> {
    const test = Effect.gen(function* () {
      const db = yield* DbService;
      yield* db.savePosition(inRangePaperPosition());
      yield* Effect.raceFirst(program, Effect.sleep(2_000));
      const positions = yield* db.getAllPositions();
      // Match the seeded row by identity: a high-quality pool may also ENTER in
      // the same cycle and add a second (zero-fee) position on the pool.
      const pos = positions.find((p) => p.positionId === SEEDED_POSITION_ID);
      return pos?.cumulativeFeesClaimedUsd ?? -1;
    });
    return Effect.runPromise(Effect.provide(test, layer) as Effect.Effect<number, unknown, never>);
  }

  it("accrues under datapi stats (measured fees)", async () => {
    const layer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: makePool({ address: POOL, tvlUsd: 5_000_000 }) }),
      datapi: { getPoolData: () => Effect.succeed(makeDatapiStats()) },
      configOverrides: { watchlistPools: [POOL], geckoTerminalEnabled: true },
    });
    const accrued = await readAccruedFees(layer);
    expect(accrued, "datapi measured fees should accrue to a paper position").toBeGreaterThan(0);
  }, 15_000);

  it("does NOT accrue under gecko stats (fees are a base-rate model, not measured)", async () => {
    const layer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: makePool({ address: POOL, tvlUsd: 5_000_000 }) }),
      datapi: { getPoolData: () => Effect.succeed(null) },
      gecko: geckoStats(50_000_000, 5_000_000), // high real volume → modeled fees
      configOverrides: { watchlistPools: [POOL], geckoTerminalEnabled: true },
    });
    const accrued = await readAccruedFees(layer);
    expect(accrued, "modeled gecko fees must not accrue to a paper position").toBe(0);
  }, 15_000);

  it("does NOT accrue under heuristic stats (fabricated fees, both sources down)", async () => {
    // Heuristic getPoolState ships a POSITIVE modeled fees24hUsd, yet accrual
    // must stay 0 because statsSource === "heuristic".
    const layer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: makePool({ address: POOL, tvlUsd: 5_000_000 }) }),
      datapi: { getPoolData: () => Effect.succeed(null) },
      gecko: null, // gecko down
      configOverrides: { watchlistPools: [POOL], geckoTerminalEnabled: true },
    });
    const accrued = await readAccruedFees(layer);
    expect(accrued, "heuristic fabricated fees must not accrue").toBe(0);
  }, 15_000);
});
