import { describe, it, expect, vi } from "vitest";
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
  AdapterService,
  BlacklistService,
  AuditService,
  ScreenerService,
  DbService,
  MemoryService,
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
  type AgentApi,
  type MemoryApi,
  type MeteoraDatapiApi,
  type MeteoraPoolStats,
  type DiscoveredPool,
} from "../engine/services.js";
import type { PoolSnapshot } from "../engine/types.js";
import type { PositionRecord } from "../engine/db-service.js";
import type { AgentRuntimeContext } from "../engine/agent-transport.js";
import {
  defaultAppConfig,
  makePool,
  makeBinArray,
  makePosition,
  makeTestLayer,
  makeAdapter,
  makeDatapiStats,
  type DecisionRow,
  type RecordedMemory,
} from "./helpers.js";
import { stringifySafe } from "../engine/bigint-json.js";

async function runCycles(
  layer: ReturnType<typeof makeTestLayer>,
  sleepMs = 2_000,
): Promise<ReadonlyArray<DecisionRow>> {
  const test = Effect.gen(function* () {
    yield* Effect.raceFirst(program, Effect.sleep(sleepMs));
    const audit = yield* AuditService;
    return yield* audit.getRecentDecisions(200);
  });
  return Effect.runPromise(
    Effect.provide(test, layer) as unknown as Effect.Effect<
      ReadonlyArray<DecisionRow>,
      Error,
      never
    >,
  );
}

describe("phantom EXIT gating (Wave 2)", () => {
  const POOL = "PoolPhantomTvl111111111111111111111111111111";

  function previousSnapshot(): PoolSnapshot {
    return {
      poolAddress: POOL,
      timestamp: Date.now() - 600_000,
      activeBinId: 5000,
      tvlUsd: 100_000, // → -40% vs current 60k (threshold 30%)
      volume24hUsd: 30_000,
      fees24hUsd: 300,
      apr: 60,
      currentPrice: 150,
      binStep: 10,
      tokenXSymbol: "SOL",
      tokenYSymbol: "USDC",
      binArray: makeBinArray(),
    };
  }

  it("does NOT record an EXIT for a positionless pool whose TVL dropped", async () => {
    const layer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: makePool({ address: POOL, tvlUsd: 60_000 }) }),
      configOverrides: { watchlistPools: [POOL], tvlDropExitPct: 0.3 },
    });

    const test = Effect.gen(function* () {
      const db = yield* DbService;
      yield* db.saveSnapshot(previousSnapshot());
      yield* Effect.raceFirst(program, Effect.sleep(2_000));
      const audit = yield* AuditService;
      const decisions = yield* audit.getRecentDecisions(50);
      const evolutionCount = yield* db
        .getMetadata("threshold_evolution_count")
        .pipe(Effect.catch(() => Effect.succeed(null)));
      return { decisions, evolutionCount };
    });
    const { decisions, evolutionCount } = await Effect.runPromise(
      Effect.provide(test, layer) as unknown as Effect.Effect<
        { decisions: ReadonlyArray<DecisionRow>; evolutionCount: string | null },
        Error,
        never
      >,
    );

    const exits = decisions.filter((d) => d.poolAddress === POOL && d.action === "EXIT");
    expect(
      exits,
      `phantom EXIT recorded for positionless pool: ${stringifySafe(exits)}`,
    ).toHaveLength(0);
    expect(evolutionCount === null || evolutionCount === "0").toBe(true);
  }, 15_000);

  it("DOES record an EXIT for a held pool whose TVL dropped (control)", async () => {
    const layer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: makePool({ address: POOL, tvlUsd: 60_000 }) }),
      configOverrides: { watchlistPools: [POOL], tvlDropExitPct: 0.3 },
    });

    const test = Effect.gen(function* () {
      const db = yield* DbService;
      yield* db.savePosition(
        makePosition({ poolAddress: POOL, depositedUsd: 1_000, currentValueUsd: 1_000 }),
      );
      yield* db.saveSnapshot(previousSnapshot());
      yield* Effect.raceFirst(program, Effect.sleep(2_000));
      const audit = yield* AuditService;
      return yield* audit.getRecentDecisions(50);
    });
    const decisions = await Effect.runPromise(
      Effect.provide(test, layer) as unknown as Effect.Effect<
        ReadonlyArray<DecisionRow>,
        Error,
        never
      >,
    );

    const tvlExit = decisions.find(
      (d) => d.poolAddress === POOL && d.action === "EXIT" && d.reasoning.includes("TVL dropped"),
    );
    expect(tvlExit, "held pool with a TVL drop must still EXIT").toBeDefined();
  }, 15_000);

  it("does NOT set a pool cooldown for a low-yield phantom EXIT (no position)", async () => {
    const layer = makeTestLayer({
      // fees24hUsd 1 → fee/IL far below 0.5
      adapter: makeAdapter({
        [POOL]: makePool({ address: POOL, tvlUsd: 100_000, fees24hUsd: 1 }),
      }),
      configOverrides: { watchlistPools: [POOL] },
    });

    const test = Effect.gen(function* () {
      yield* Effect.raceFirst(program, Effect.sleep(2_000));
      const audit = yield* AuditService;
      const decisions = yield* audit.getRecentDecisions(50);
      const db = yield* DbService;
      const cooldown = yield* db
        .getPoolCooldown(POOL)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      return { decisions, cooldown };
    });
    const { decisions, cooldown } = await Effect.runPromise(
      Effect.provide(test, layer) as unknown as Effect.Effect<
        { decisions: ReadonlyArray<DecisionRow>; cooldown: unknown },
        Error,
        never
      >,
    );

    const exits = decisions.filter((d) => d.poolAddress === POOL && d.action === "EXIT");
    expect(
      exits,
      `phantom low-yield EXIT recorded for positionless pool: ${stringifySafe(exits)}`,
    ).toHaveLength(0);
    expect(cooldown, `phantom EXIT set a pool cooldown: ${stringifySafe(cooldown)}`).toBeNull();
  }, 15_000);
});

describe("portfolio value math (Wave 2)", () => {
  const POOL_HELD = "PoolHeld111111111111111111111111111111111";
  const POOL_NEW = "PoolNew1111111111111111111111111111111111";

  it("computes the ENTER drawdown gate against wallet + open positions", async () => {
    // Wallet: $100. Open position: deposited $950, now worth ~$902 (drifted 2
    // bins off center) → unrealized PnL ≈ -$47.50. Against a wallet-only
    // "portfolio" of $100 that is a 47% drawdown (ENTER blocked); against the
    // real portfolio of ~$1002 it is ~4.7% (ENTER allowed).
    const adapter = makeAdapter({
      [POOL_HELD]: makePool({ address: POOL_HELD, activeBinId: 5002, fees24hUsd: 100 }),
      [POOL_NEW]: makePool({ address: POOL_NEW }),
    });
    const datapi: MeteoraDatapiApi = {
      getPoolData: (addr: string) =>
        Effect.succeed(addr === POOL_NEW ? makeDatapiStats({ address: POOL_NEW }) : null),
    };
    const layer = makeTestLayer({
      adapter,
      datapi,
      configOverrides: {
        watchlistPools: [POOL_HELD, POOL_NEW],
        paperPortfolioUsd: 100,
      },
    });

    const test = Effect.gen(function* () {
      const db = yield* DbService;
      yield* db.savePosition(
        makePosition({
          poolAddress: POOL_HELD,
          depositedUsd: 950,
          currentValueUsd: 950,
          lowerBinId: 4980,
          upperBinId: 5020,
        }),
      );
      yield* Effect.raceFirst(program, Effect.sleep(2_000));
      const audit = yield* AuditService;
      return yield* audit.getRecentDecisions(50);
    });
    const decisions = await Effect.runPromise(
      Effect.provide(test, layer) as unknown as Effect.Effect<
        ReadonlyArray<DecisionRow>,
        Error,
        never
      >,
    );

    const enter = decisions.find((d) => d.poolAddress === POOL_NEW && d.action === "ENTER");
    expect(
      enter,
      `expected an ENTER decision for the strong pool, got: ${stringifySafe(decisions.map((d) => `${d.poolAddress}:${d.action}:${d.riskResult.reason}`))}`,
    ).toBeDefined();
    expect(
      enter!.riskResult.approved,
      `ENTER wrongly rejected — drawdown gate must use wallet+positions, got: ${enter!.riskResult.reason}`,
    ).toBe(true);
  }, 15_000);
});

describe("HOLD decisions skip risk evaluation (Wave 2)", () => {
  const POOL = "PoolQuiet1111111111111111111111111111111111";

  it("produces no risk-rejection audit rows and no warning memories over multiple cycles", async () => {
    const recordedMemory: RecordedMemory[] = [];
    const layer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: makePool({ address: POOL }) }),
      memoryRecorded: recordedMemory,
      configOverrides: {
        watchlistPools: [POOL],
        scanIntervalMs: 300, // several cycles inside the 1.2s race window
      },
    });

    const decisions = await runCycles(layer, 1_200);
    const forPool = decisions.filter((d) => d.poolAddress === POOL);
    expect(forPool.length, "expected at least one decision for the quiet pool").toBeGreaterThan(0);

    const rejectedHolds = forPool.filter(
      (d) => d.action === "HOLD" && d.riskResult.approved === false,
    );
    expect(
      rejectedHolds,
      `HOLD decisions were risk-rejected: ${stringifySafe(rejectedHolds.map((d) => d.riskResult.reason))}`,
    ).toHaveLength(0);

    const warnings = recordedMemory.filter((m) => m.category === "warning");
    expect(
      warnings,
      `warning memories written for HOLD rejections: ${stringifySafe(warnings)}`,
    ).toHaveLength(0);
  }, 15_000);
});

describe("pool snapshot retention (Wave 2)", () => {
  const POOL = "PoolRetention11111111111111111111111111111";

  it("prunes snapshots older than the retention window and keeps recent ones", async () => {
    const now = Date.now();
    const layer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: makePool({ address: POOL }) }),
      configOverrides: { watchlistPools: [POOL] },
    });

    const test = Effect.gen(function* () {
      const db = yield* DbService;
      yield* db.saveSnapshot({
        poolAddress: POOL,
        timestamp: now - 30 * 86_400_000, // 30 days old — beyond the 14d default
        activeBinId: 5000,
        tvlUsd: 90_000,
        volume24hUsd: 30_000,
        fees24hUsd: 300,
        apr: 60,
        currentPrice: 150,
        binStep: 10,
        tokenXSymbol: "SOL",
        tokenYSymbol: "USDC",
        binArray: makeBinArray(),
      });
      yield* Effect.raceFirst(program, Effect.sleep(2_000));
      const oldRows = yield* db.getSnapshots(POOL, 0, now - 14 * 86_400_000);
      const recentRows = yield* db.getSnapshots(POOL, now - 14 * 86_400_000, now + 60_000);
      return { oldRows, recentRows };
    });
    const { oldRows, recentRows } = await Effect.runPromise(
      Effect.provide(test, layer) as unknown as Effect.Effect<
        { oldRows: ReadonlyArray<PoolSnapshot>; recentRows: ReadonlyArray<PoolSnapshot> },
        Error,
        never
      >,
    );

    expect(oldRows, "30-day-old snapshot was not pruned").toHaveLength(0);
    expect(recentRows.length, "fresh per-cycle snapshot must be retained").toBeGreaterThan(0);
  }, 15_000);
});

describe("veto deadline bounds the entire transport operation (P1)", () => {
  const POOL = "PoolVetoDeadline111111111111111111111111";

  it("interrupts a veto op stalled in connect within the veto budget and fails open", async () => {
    // enhanceDecision models a disconnected transport whose reconnect/session
    // never settles: it blocks for 60s (far past the 300ms veto deadline)
    // instead of resolving. The deadline in the veto path must interrupt it so
    // the deterministic decision proceeds — a stalled reconnect may never
    // delay a capital-protecting EXIT past AGENT_VETO_TIMEOUT_MS.
    let vetoCompleted = false;
    const stalledAgent: AgentApi = {
      ...AgentNoOp,
      enhanceDecision: () =>
        Effect.sleep(60_000).pipe(
          Effect.map(() => {
            vetoCompleted = true;
            return null;
          }),
        ),
    };
    const recordedMemory: RecordedMemory[] = [];
    const layer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: makePool({ address: POOL }) }),
      memoryRecorded: recordedMemory,
      agent: stalledAgent,
      configOverrides: {
        watchlistPools: [POOL],
        agentiveMode: true,
        agentProposalMode: "veto",
        agentVetoTimeoutMs: 300,
        scanIntervalMs: 350, // several veto failures inside the race window
      },
    });

    const startedAt = Date.now();
    const decisions = await runCycles(layer, 2_000);
    const wallMs = Date.now() - startedAt;
    const forPool = decisions.filter((d) => d.poolAddress === POOL);

    // Without the outer deadline the stalled veto blocks pool evaluation for
    // the whole window and NO decision is ever recorded (race kills program
    // while it is still stuck inside enhanceDecision).
    expect(forPool.length, "a stalled veto must not block the decision loop").toBeGreaterThan(0);
    expect(
      vetoCompleted,
      "the veto deadline must interrupt the stalled op, not let it resolve",
    ).toBe(false);
    // Fail-open throttle intact: several veto failures in ONE warning window
    // (agentProposalStaleMs = 300s) produce exactly ONE warning memory.
    const vetoWarnings = recordedMemory.filter((m) =>
      m.content.includes("Agent veto fetch failed"),
    );
    expect(vetoWarnings, "exactly one veto warning memory per window").toHaveLength(1);
    expect(wallMs, "cycle cost is the veto budget (~300ms), not the 60s stall").toBeLessThan(
      10_000,
    );
  }, 15_000);
});

// ─── Wave 20: agent position context wiring ──────────────────────────────────

describe("agent position context wiring", () => {
  const POOL = "PoolAgentPosCtx11111111111111111111111111111";

  it("passes the targeted position state to the sync-proposal advisor", async () => {
    let capturedContext: AgentRuntimeContext | undefined;
    const layer = makeTestLayer({
      adapter: makeAdapter({ [POOL]: makePool({ address: POOL, tvlUsd: 60_000 }) }),
      configOverrides: {
        watchlistPools: [POOL],
        tvlDropExitPct: 0.3,
        agentiveMode: true,
        agentProposalMode: "full",
        agentProposalTimeoutMs: 300,
      },
      agent: {
        ...AgentNoOp,
        getStatus: () =>
          Effect.succeed({ connected: true, transport: "acp", lastPromptAt: null, errorCount: 0 }),
        enhanceDecision: (decision, context) => {
          capturedContext = context;
          return Effect.succeed(null);
        },
      },
    });

    const test = Effect.gen(function* () {
      const db = yield* DbService;
      yield* db.savePosition(
        makePosition({ poolAddress: POOL, depositedUsd: 1_000, currentValueUsd: 1_000 }),
      );
      yield* db.saveSnapshot({
        poolAddress: POOL,
        timestamp: Date.now() - 600_000,
        activeBinId: 5000,
        tvlUsd: 100_000, // → -40% vs current 60k (threshold 30%)
        volume24hUsd: 30_000,
        fees24hUsd: 300,
        apr: 60,
        currentPrice: 150,
        binStep: 10,
        tokenXSymbol: "SOL",
        tokenYSymbol: "USDC",
        binArray: makeBinArray(),
      });
      yield* Effect.raceFirst(program, Effect.sleep(2_000));
    });
    await Effect.runPromise(
      Effect.provide(test, layer) as unknown as Effect.Effect<unknown, Error, never>,
    );

    expect(capturedContext, "sync advisor must be consulted for the EXIT").toBeDefined();
    expect(capturedContext?.position, "position state must reach the advisor").toBeDefined();
    expect(capturedContext?.position?.positionId).toBeDefined();
    expect(capturedContext?.position?.depositedUsd).toBe(1_000);
    expect(capturedContext?.position?.valueUsd).toBe(1_000);
    // value + fees + rewards − deposited = 0
    expect(capturedContext?.position?.unrealizedPnlUsd).toBe(0);
    expect(capturedContext?.position?.hoursHeld).toBeGreaterThanOrEqual(0);
  }, 15_000);
});

describe("runner scale-in wiring (Heart Attack step 2)", () => {
  const POOL = "ScaleInPool111111111111111111111111111111111111";

  it("re-anchors the band and top-ups via the atomic rebalance when the price falls a step", async () => {
    const rebalanceSpy = vi.fn(() =>
      Effect.succeed({ positionPubKey: "mock-pos", txSignatures: ["mock-tx"] }),
    );
    const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const adapter = makeAdapter(
      {
        [POOL]: makePool({
          address: POOL,
          tokenX: USDC_MINT,
          tokenXSymbol: "USDC",
          currentPrice: 93,
          tvlUsd: 500_000,
        }),
      },
      {
        rebalancePosition: rebalanceSpy,
        hasWallet: () => true,
        // USDC-quoted pool: the top-up spends USDC (no SOL-leg budget
        // interaction — the SOL batch gate only applies to SOL legs).
        getTokenPrices: () => Effect.succeed({ [USDC_MINT]: 1 }),
        getTokenDecimals: () => Effect.succeed(6),
      },
    );
    const layer = makeTestLayer({
      adapter,
      configOverrides: {
        watchlistPools: [POOL],
        paperTrading: false,
        launchRunnerModeEnabled: true,
        launchRunnerScaleInEnabled: true,
        launchRunnerScaleInStepPct: 0.05,
        launchRunnerScaleInSizePct: 0.25,
        launchPositionMaxSizeUsd: 100,
      },
    });

    const test = Effect.gen(function* () {
      const db = yield* DbService;
      const position = makePosition({
        poolAddress: POOL,
        positionMode: "launch",
        launchRunner: true,
        launchRunnerAnchorPrice: 100,
        launchRunnerSteps: 0,
        positionPubKey: "mock-pos",
        depositedUsd: 1_000,
        currentValueUsd: 1_000,
      });
      yield* db.savePosition(position);
      yield* Effect.raceFirst(program, Effect.sleep(2_000));
      const saved = yield* db.getPosition(position.positionId);
      const audit = yield* AuditService;
      const decisions = yield* audit.getRecentDecisions(50);
      return { saved, decisions };
    });
    const { saved, decisions } = await Effect.runPromise(
      Effect.provide(test, layer) as unknown as Effect.Effect<
        { saved: PositionRecord | null; decisions: ReadonlyArray<DecisionRow> },
        Error,
        never
      >,
    );

    // The rebalance fired with the dip-anchored range + a quote-only top-up:
    // dip 12% @ binStep 10 -> offset -128 bins; width min(5, 127, 25) = 5.
    expect(rebalanceSpy).toHaveBeenCalledTimes(1);
    const [pool, pubkey, lower, upper, topUp] = rebalanceSpy.mock.calls[0] as unknown as [
      string,
      string,
      number,
      number,
      { amountXAtomic: bigint; amountYAtomic: bigint },
    ];
    expect(pool).toBe(POOL);
    expect(pubkey).toBe("mock-pos");
    expect(lower).toBe(5000 - 5 - 128);
    expect(upper).toBe(5000 + 5 - 128);
    expect(topUp.amountYAtomic).toBe(0n);
    expect(topUp.amountXAtomic).toBeGreaterThan(0n);
    // topUp = min(0.25 x $10k wallet, pool headroom, $100 ceiling) = $100 ->
    // 100 USDC x 1e6 micro-units.
    expect(topUp.amountXAtomic).toBe(100_000_000n);
    // The step is persisted: a restart cannot re-scale the position.
    expect(saved?.launchRunnerSteps).toBe(1);
    expect(saved?.launchRunnerAnchorPrice).toBe(93);
    const scaleIn = decisions.find((d) => d.reasoning.includes("[launch-scale-in]"));
    expect(scaleIn, "scale-in must be audited").toBeDefined();
  }, 15_000);

  it("launch pools never enter through the idle-redeploy pass even after a portfolio slot frees (regression)", async () => {
    const LAUNCH_POOL = "LaunchRedeployPool2222222222222222222222222222";
    const EXIT_POOL = "ExitFreesSlotPool11111111111111111111111111111";
    const FILLER_POOL = "FillerStaysPool1111111111111111111111111111111";
    const now = Date.now();
    // A gate-passing launch candidate: young, hot, safe legs, binStep 100.
    const discoveredPool: DiscoveredPool = {
      address: LAUNCH_POOL,
      tvlUsd: 300_000,
      volume24hUsd: 900_000,
      fees24hUsd: 2_400,
      apr: 60,
      binStep: 100,
      volume1hUsd: 100_000,
      feeYield1hPct: 5,
      baseFeePct: 2,
      createdAtMs: now - 3_600_000,
      tokenX: "So11111111111111111111111111111111111111112",
      tokenY: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      tokenXSymbol: "SOL",
      tokenYSymbol: "USDC",
      tokenXVerified: true,
      tokenYVerified: true,
      tokenXFreezeDisabled: true,
      tokenYFreezeDisabled: true,
    };
    const enterSpy = vi.fn((_pool: string, _lower: number, _upper: number, size: number) =>
      Effect.succeed({
        positionPubKey: "mock-pos",
        txSignature: "mock-tx",
        depositMode: "two-sided" as const,
        amountXUsd: size / 2,
        amountYUsd: size / 2,
      }),
    );
    const adapter = makeAdapter(
      {
        [LAUNCH_POOL]: makePool({ address: LAUNCH_POOL, binStep: 100, tvlUsd: 300_000 }),
        [EXIT_POOL]: makePool({ address: EXIT_POOL, tvlUsd: 60_000 }),
        [FILLER_POOL]: makePool({ address: FILLER_POOL, tvlUsd: 100_000 }),
      },
      {
        hasWallet: () => true,
        // A live ENTER must clear the SOL floor (MIN_SOL_FOR_ENTRY_LAMPORTS).
        getNativeSolBalance: () => Effect.succeed(2n ** 40n),
        // The idle-redeploy pass measures idle capital as LIVE USDC holdings —
        // $5k idle arms the pass (threshold 0), so the regression actually
        // exercises the redeploy queue.
        getWalletHoldings: () =>
          Effect.succeed(
            new Map<string, { readonly amountAtomic: bigint; readonly decimals: number }>([
              [
                "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                { amountAtomic: 5_000_000_000n, decimals: 6 },
              ],
            ]),
          ),
        getAllWalletPositions: () =>
          Effect.succeed([
            {
              positionPubKey: "exit-pos",
              poolAddress: EXIT_POOL,
              lowerBinId: 4980,
              upperBinId: 5020,
            },
            {
              positionPubKey: "filler-pos",
              poolAddress: FILLER_POOL,
              lowerBinId: 4980,
              upperBinId: 5020,
            },
          ]),
        discoverHotPools: () => Effect.succeed([discoveredPool]),
        enterPosition: enterSpy,
      },
    );
    // Measured stats (datapi) so the ENTER candidate gate's
    // volumeAuthenticityKnown requirement passes — a heuristic pool can
    // never enter by design.
    const datapi: MeteoraDatapiApi = {
      getPoolData: (addr: string) =>
        Effect.succeed(
          addr === LAUNCH_POOL
            ? makeDatapiStats({
                address: LAUNCH_POOL,
                tvlUsd: 300_000,
                volume24hUsd: 900_000,
                fees24hUsd: 2_400,
                apr: 60,
                feeTvlRatio1h: 0.05,
              })
            : null,
        ),
    };
    const layer = makeTestLayer({
      adapter,
      datapi,
      configOverrides: {
        // LAUNCH_POOL scans FIRST (portfolio full at 2/2 -> the launch
        // allocation rejects); EXIT_POOL is scanned later via the held-pool
        // merge, so its TVL-drop EXIT frees a slot AFTER the capture.
        watchlistPools: [LAUNCH_POOL, FILLER_POOL],
        paperTrading: false,
        idleRedeployEnabled: true,
        idleRedeployThresholdUsd: 0,
        idleRedeployMaxSizeUsd: 500,
        launchScanEnabled: true,
        launchExecutionEnabled: true,
        // Portfolio full at 2/2 (EXIT_POOL + FILLER_POOL): the LAUNCH_POOL
        // entry is rejected at the allocation gate, then EXIT_POOL's TVL-drop
        // EXIT frees a slot before the redeploy pass runs — the exact window
        // where an unguarded capture would dispatch a standard entry.
        maxOpenPositions: 2,
        dustExitUsd: 2000,
        // Normal entries cap at $100 so the redeploy's widened size ($500)
        // exceeds the captured normalEntrySizeUsd and the pass proceeds.
        maxEntrySizeUsd: 100,
        solPriceUsd: 150,
      },
    });

    const test = Effect.gen(function* () {
      const db = yield* DbService;
      // Portfolio full: one position on EXIT_POOL (will exit on the TVL
      // drop) + one on FILLER_POOL (stays). LAUNCH_POOL has none.
      yield* db.savePosition(
        makePosition({
          poolAddress: EXIT_POOL,
          positionPubKey: "exit-pos",
          depositedUsd: 1_000,
          currentValueUsd: 1_000,
          lowerBinId: 4980,
          upperBinId: 5020,
        }),
      );
      yield* db.savePosition(
        makePosition({
          poolAddress: FILLER_POOL,
          positionPubKey: "filler-pos",
          depositedUsd: 1_000,
          currentValueUsd: 1_000,
          lowerBinId: 4980,
          upperBinId: 5020,
        }),
      );
      // EXIT_POOL's position ($1k) is below the dust threshold ($2k): the
      // deterministic dust-cleanup EXIT fires, freeing a portfolio slot.
      yield* Effect.raceFirst(program, Effect.sleep(2_000));
      const positions = yield* db.getAllPositions();
      const audit = yield* AuditService;
      const decisions = yield* audit.getRecentDecisions(50);
      return { positions, decisions };
    });
    const { positions, decisions } = await Effect.runPromise(
      Effect.provide(test, layer) as unknown as Effect.Effect<
        { positions: PositionRecord[]; decisions: ReadonlyArray<DecisionRow> },
        Error,
        never
      >,
    );

    // The launch lane REJECTED the entry at the allocation gate (portfolio
    // was full) — that is correct. The regression: the pool must not then
    // be entered by the redeploy pass after EXIT_POOL's exit freed a slot,
    // because a redeploy decision carries no positionMode (no launch
    // timebox/decay/drawdown protection).
    const launchEntryRejected = decisions.some(
      (d) =>
        d.reasoning.includes("[launch-alloc-gate]") ||
        // Portfolio-full launch-cap rejection (market-runner lane: the cap
        // block now also fires when MAX_OPEN_POSITIONS is reached, before
        // the allocation gate).
        d.reasoning.includes("[launch-cap]"),
    );
    expect(launchEntryRejected, "the launch entry must have been allocation-rejected").toBe(true);
    const launchEnterCalls = enterSpy.mock.calls.filter((c) => c[0] === LAUNCH_POOL);
    expect(launchEnterCalls.length, "the redeploy must never enter the launch pool").toBe(0);
    const launchPositions = positions.filter((p) => p.poolAddress === LAUNCH_POOL);
    expect(
      launchPositions.every((p) => p.positionMode === "launch"),
      "any LAUNCH_POOL position must carry the launch lifecycle",
    ).toBe(true);
  }, 15_000);
});

// ─── Launch-lane edge cases: no exit-and-reenter, scale-in on exit, ─────────
// ─── wash-forensics gate, launch-cap boundary ───────────────────────────────

// A gate-passing launch candidate: young, hot, safe legs, binStep 100 (the
// exact shape the radar admits — proven by the idle-redeploy regression test).
function makeHotDiscoveredPool(address: string): DiscoveredPool {
  const now = Date.now();
  return {
    address,
    tvlUsd: 300_000,
    volume24hUsd: 900_000,
    fees24hUsd: 2_400,
    apr: 60,
    binStep: 100,
    volume1hUsd: 100_000,
    feeYield1hPct: 5,
    baseFeePct: 2,
    createdAtMs: now - 3_600_000,
    tokenX: "So11111111111111111111111111111111111111112",
    tokenY: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    tokenXSymbol: "SOL",
    tokenYSymbol: "USDC",
    tokenXVerified: true,
    tokenYVerified: true,
    tokenXFreezeDisabled: true,
    tokenYFreezeDisabled: true,
  };
}

// Measured datapi stats so the launch ENTER candidate chain's
// volumeAuthenticityKnown requirement passes — a heuristic pool can never
// enter by design.
function makeHotDatapi(address: string): MeteoraDatapiApi {
  return {
    getPoolData: (addr: string) =>
      Effect.succeed(
        addr === address
          ? makeDatapiStats({
              address,
              tvlUsd: 300_000,
              volume24hUsd: 900_000,
              fees24hUsd: 2_400,
              apr: 60,
              feeTvlRatio1h: 0.05,
            })
          : null,
      ),
  };
}

// makePosition hardcodes a fresh `timestamp`; the launch timebox exits on
// position AGE, so extend the helper locally (helpers.ts stays untouched).
function makeAgedPosition(
  ageMs: number,
  overrides: Parameters<typeof makePosition>[0] = {},
): PositionRecord {
  return { ...makePosition(overrides), timestamp: Date.now() - ageMs };
}

describe("no exit-and-reenter in one pass (launch lane)", () => {
  const POOL = "NoExitReenterPool11111111111111111111111111111";

  it("never emits an ENTER for a pool whose EXIT executed this cycle", async () => {
    const layer = makeTestLayer({
      adapter: makeAdapter(
        { [POOL]: makePool({ address: POOL, binStep: 100, tvlUsd: 300_000 }) },
        { discoverHotPools: () => Effect.succeed([makeHotDiscoveredPool(POOL)]) },
      ),
      // Measured datapi stats: without them the ENTER candidate gate blocks
      // every entry by design, and the no-exit-and-reenter guard test would
      // pass vacuously (the pool could never ENTER regardless of the guard).
      datapi: makeHotDatapi(POOL),
      configOverrides: {
        watchlistPools: [POOL],
        launchScanEnabled: true,
        launchExecutionEnabled: true,
        // The held $1k position is below the $2k dust threshold: the
        // deterministic dust EXIT fires this cycle. The pool is ALSO a
        // gate-passing launch candidate — with only this one position the
        // exit frees the slot, so an unguarded ENTER slot would approve the
        // re-entry; only the no-exit-and-reenter guard can stop it.
        dustExitUsd: 2_000,
      },
    });

    const test = Effect.gen(function* () {
      const db = yield* DbService;
      yield* db.savePosition(
        makePosition({ poolAddress: POOL, depositedUsd: 1_000, currentValueUsd: 1_000 }),
      );
      yield* Effect.raceFirst(program, Effect.sleep(2_000));
      const audit = yield* AuditService;
      return yield* audit.getRecentDecisions(50);
    });
    const decisions = await Effect.runPromise(
      Effect.provide(test, layer) as unknown as Effect.Effect<
        ReadonlyArray<DecisionRow>,
        Error,
        never
      >,
    );

    const exit = decisions.find(
      (d) =>
        d.poolAddress === POOL && d.action === "EXIT" && d.reasoning.includes("[dust-cleanup]"),
    );
    expect(exit, "the dust EXIT must fire for the held position").toBeDefined();
    const enters = decisions.filter((d) => d.poolAddress === POOL && d.action === "ENTER");
    expect(
      enters,
      `no exit-and-reenter: a pool that exited this cycle must not ENTER in the same pass, got ${stringifySafe(enters)}`,
    ).toHaveLength(0);
  }, 15_000);
});

describe("runner scale-in never fires on an exiting position", () => {
  const POOL = "ScaleInExitPool1111111111111111111111111111111";

  it("the timebox EXIT wins over a runner scale-in when both would fire", async () => {
    const rebalanceSpy = vi.fn(() =>
      Effect.succeed({ positionPubKey: "mock-pos", txSignatures: ["mock-tx"] }),
    );
    const exitSpy = vi.fn(() => Effect.succeed({ txSignature: "mock-tx" }));
    const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const adapter = makeAdapter(
      {
        [POOL]: makePool({
          address: POOL,
          tokenX: USDC_MINT,
          tokenXSymbol: "USDC",
          // -7% vs the $100 anchor: a full scale-in step (5%), so the
          // scale-in branch WOULD fire — if the timebox exit did not preempt
          // it ("never scale into a dying position").
          currentPrice: 93,
          tvlUsd: 500_000,
        }),
      },
      {
        rebalancePosition: rebalanceSpy,
        exitPosition: exitSpy,
        hasWallet: () => true,
        // USDC-quoted pool: the top-up spends USDC (no SOL-leg budget
        // interaction — the SOL batch gate only applies to SOL legs).
        getTokenPrices: () => Effect.succeed({ [USDC_MINT]: 1 }),
        getTokenDecimals: () => Effect.succeed(6),
      },
    );
    const layer = makeTestLayer({
      adapter,
      configOverrides: {
        watchlistPools: [POOL],
        paperTrading: false,
        launchRunnerModeEnabled: true,
        launchRunnerScaleInEnabled: true,
        launchRunnerScaleInStepPct: 0.05,
        launchRunnerScaleInSizePct: 0.25,
        launchPositionMaxSizeUsd: 100,
        // 1h timebox (config minimum); the runner position is 2h old.
        launchTimeboxHours: 1,
      },
    });

    const test = Effect.gen(function* () {
      const db = yield* DbService;
      yield* db.savePosition(
        makeAgedPosition(2 * 3_600_000, {
          poolAddress: POOL,
          positionMode: "launch",
          launchRunner: true,
          launchRunnerAnchorPrice: 100,
          launchRunnerSteps: 0,
          positionPubKey: "mock-pos",
          depositedUsd: 1_000,
          currentValueUsd: 1_000,
        }),
      );
      yield* Effect.raceFirst(program, Effect.sleep(2_000));
      const audit = yield* AuditService;
      const decisions = yield* audit.getRecentDecisions(50);
      return { decisions };
    });
    const { decisions } = await Effect.runPromise(
      Effect.provide(test, layer) as unknown as Effect.Effect<
        { decisions: ReadonlyArray<DecisionRow> },
        Error,
        never
      >,
    );

    const timeboxExit = decisions.find(
      (d) =>
        d.poolAddress === POOL && d.action === "EXIT" && d.reasoning.includes("[launch-timebox]"),
    );
    expect(timeboxExit, "the timebox EXIT must fire for the aged runner position").toBeDefined();
    const scaleIn = decisions.find(
      (d) =>
        d.poolAddress === POOL &&
        d.action === "REBALANCE" &&
        d.reasoning.includes("[launch-scale-in]"),
    );
    expect(scaleIn, "a runner position that exits this cycle must never scale in").toBeUndefined();
    expect(
      rebalanceSpy,
      "no rebalance may be dispatched for an exiting position",
    ).not.toHaveBeenCalled();
    expect(exitSpy, "the timebox EXIT must execute").toHaveBeenCalledTimes(1);
  }, 15_000);
});

describe("launch wash-forensics ENTER gate", () => {
  const POOL = "WashForensicsPool11111111111111111111111111111";

  it("rejects a launch ENTER with [wash-forensics] when the evidence is suspicious", async () => {
    const washSpy = vi.fn((addr: string) =>
      Effect.succeed(
        addr === POOL
          ? {
              tradeCount: 200,
              distinctPayers: 3,
              txsPerSecond: 5,
              uniquePayerRate: 0.015,
              feeCv: null,
              suspicious: true,
              reason: "3 wallet(s) produced 200 recent trades — concentrated",
            }
          : null,
      ),
    );
    const layer = makeTestLayer({
      adapter: makeAdapter(
        { [POOL]: makePool({ address: POOL, binStep: 100, tvlUsd: 300_000 }) },
        {
          discoverHotPools: () => Effect.succeed([makeHotDiscoveredPool(POOL)]),
          getPoolWashEvidence: washSpy,
        },
      ),
      configOverrides: {
        watchlistPools: [POOL],
        launchScanEnabled: true,
        launchExecutionEnabled: true,
        launchWashForensicsEnabled: true,
      },
    });

    const decisions = await runCycles(layer, 2_000);
    const forPool = decisions.filter((d) => d.poolAddress === POOL);
    const washRejection = forPool.find(
      (d) => d.action === "ENTER" && d.reasoning.includes("[wash-forensics]"),
    );
    expect(
      washRejection,
      `expected a [wash-forensics] ENTER rejection, got ${stringifySafe(forPool)}`,
    ).toBeDefined();
    expect(washRejection!.riskResult.approved).toBe(false);
    expect(washRejection!.executed).toBe(false);
    // The gate reads the radar-refreshed wash evidence, which is fetched
    // exactly once per admitted top-K pool.
    expect(washSpy).toHaveBeenCalledWith(POOL);
  }, 15_000);
});

describe("launch-cap boundary", () => {
  const CANDIDATE = "LaunchCapCandidate1111111111111111111111111";
  const FILLER = "LaunchCapFiller111111111111111111111111111111";

  it("rejects the next launch ENTER with [launch-cap] at launchMaxOpenPositions", async () => {
    const layer = makeTestLayer({
      adapter: makeAdapter(
        {
          [CANDIDATE]: makePool({ address: CANDIDATE, binStep: 100, tvlUsd: 300_000 }),
          [FILLER]: makePool({ address: FILLER, tvlUsd: 100_000 }),
        },
        { discoverHotPools: () => Effect.succeed([makeHotDiscoveredPool(CANDIDATE)]) },
      ),
      datapi: makeHotDatapi(CANDIDATE),
      configOverrides: {
        watchlistPools: [CANDIDATE, FILLER],
        launchScanEnabled: true,
        launchExecutionEnabled: true,
        // The single launch slot is already occupied by the FILLER position.
        launchMaxOpenPositions: 1,
        launchPositionMaxSizeUsd: 100,
      },
    });

    const test = Effect.gen(function* () {
      const db = yield* DbService;
      yield* db.savePosition(
        makePosition({
          poolAddress: FILLER,
          positionMode: "launch",
          depositedUsd: 1_000,
          currentValueUsd: 1_000,
        }),
      );
      yield* Effect.raceFirst(program, Effect.sleep(2_000));
      const audit = yield* AuditService;
      return yield* audit.getRecentDecisions(50);
    });
    const decisions = await Effect.runPromise(
      Effect.provide(test, layer) as unknown as Effect.Effect<
        ReadonlyArray<DecisionRow>,
        Error,
        never
      >,
    );

    const forCandidate = decisions.filter((d) => d.poolAddress === CANDIDATE);
    const capRejection = forCandidate.find(
      (d) => d.action === "ENTER" && d.reasoning.includes("[launch-cap]"),
    );
    expect(
      capRejection,
      `expected a [launch-cap] ENTER rejection, got ${stringifySafe(forCandidate)}`,
    ).toBeDefined();
    expect(capRejection!.riskResult.approved).toBe(false);
    expect(capRejection!.executed).toBe(false);
  }, 15_000);
});
