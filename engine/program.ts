import { Effect, Layer } from "effect";
import { ConfigService, ConfigLive, type AppConfig } from "./config-service.js";
import { AdapterLive } from "./adapter-service.js";
import { StrategyLive } from "./strategy-service.js";
import { MemoryLive } from "./memory-service.js";
import { RiskLive, evaluateGasGate, evaluateCompoundGate, evaluatePerPoolAllocation, evaluatePaperValidation, convertClaimFeesToUsd } from "./risk-service.js";
import {
  computeBinVolatilityStddev,
  isHighVolatility,
  recommendBinRangeForVolatility,
  estimateRecoveryProbability,
  shouldHoldForRecovery,
} from "./strategy-service.js";
import { BlacklistLive } from "./blacklist-service.js";
import { AuditLive } from "./audit-service.js";
import { ScreenerLive } from "./screener-service.js";
import { DbLive } from "./db-service.js";
import { RevenueLive } from "./revenue-service.js";
import { RevenueConfigServiceLive } from "./revenue-config-service.js";
import { ReferralLive } from "./referral-service.js";
import { checkForAutoUpdate } from "./update-check.js";
import type { PositionRecord } from "./db-service.js";
import { DiscoverPoolsError } from "./errors.js";
import {
  AdapterService,
  StrategyService,
  MemoryService,
  RiskService,
  BlacklistService,
  AuditService,
  ScreenerService,
  DbService,
  RevenueService,
  RevenueConfigService,
  ReferralService,
  type AdapterApi,
  type DbApi,
  type MemoryApi,
  type ScreenedPool,
} from "./services.js";
import type { AgentDecision, AgentCycle, PoolState } from "./types.js";
import { randomUUID } from "crypto";

// ─── Cycle state ───────────────────────────────────────────────

let cycleInFlight = false;
let skippedCycles = 0;

// ─── Position value estimation (rough heuristic) ───────────────

export function estimatePositionValue(pos: PositionRecord, pool: PoolState): number {
  const centerBinId = (pos.lowerBinId + pos.upperBinId) / 2;
  const maxDrift = Math.max(pos.upperBinId - centerBinId, 1);
  const drift = Math.abs(pool.activeBinId - centerBinId);
  const driftPct = Math.min(drift / maxDrift, 1);
  const ilFactor = 1 - driftPct * 0.5;
  return pos.depositedUsd * ilFactor;
}

export function reconcilePositions(
  adapter: AdapterApi,
  db: DbApi,
  memory: MemoryApi,
  trackedPositions: Map<string, PositionRecord>,
  poolsToScan: ReadonlyArray<string>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (!adapter.hasWallet()) {
      return;
    }
    const walletAddress = adapter.getWalletAddress();
    if (!walletAddress) {
      return;
    }

    const onChainPositions = yield* adapter.getAllWalletPositions(walletAddress).pipe(
      Effect.catchAll((err) => {
        console.error("Reconcile: failed to fetch on-chain positions — skipping", {
          err: String(err),
        });
        return Effect.succeed(null);
      }),
    );

    if (onChainPositions === null) {
      return;
    }

    const onChainPoolSet = new Set(onChainPositions.map((p) => p.poolAddress));
    const watchedPoolSet = new Set(poolsToScan);

    for (const [poolAddress, pos] of trackedPositions) {
      if (pos.positionPubKey && !onChainPoolSet.has(poolAddress)) {
        console.warn(
          `Reconciling: position ${poolAddress} no longer on-chain — removing from tracking`,
        );
        trackedPositions.delete(poolAddress);
        yield* db.deletePosition(poolAddress).pipe(Effect.catchAll(() => Effect.void));
        yield* memory
          .upsert({
            category: "warning",
            content: `Position ${poolAddress} was closed externally (e.g. via Solscan/Meteora UI). Removed from tracking.`,
            poolAddress,
          })
          .pipe(Effect.catchAll(() => Effect.void));
      }
    }

    for (const onChainPos of onChainPositions) {
      if (
        !trackedPositions.has(onChainPos.poolAddress) &&
        watchedPoolSet.has(onChainPos.poolAddress)
      ) {
        console.warn(
          `Reconciling: discovered external position in ${onChainPos.poolAddress} — adding to tracking`,
        );
        const pool = yield* adapter.getPoolState(onChainPos.poolAddress).pipe(
          Effect.catchAll((err) => {
            console.error("Reconcile: failed to fetch pool state for external position", {
              pool: onChainPos.poolAddress,
              err: String(err),
            });
            return Effect.succeed(null);
          }),
        );
        if (pool) {
          const pos: PositionRecord = {
            poolAddress: onChainPos.poolAddress,
            positionPubKey: onChainPos.positionPubKey,
            depositedUsd: 0,
            currentValueUsd: 0,
            tokenXSymbol: pool.tokenXSymbol,
            tokenYSymbol: pool.tokenYSymbol,
            activeBinId: pool.activeBinId,
            lowerBinId: onChainPos.lowerBinId,
            upperBinId: onChainPos.upperBinId,
            timestamp: Date.now(),
            outOfRangeSince: null,
            oorCycleCount: 0,
            lastFeeClaimAt: Date.now(),
            trailingStopThreshold: null,
            highestValueUsd: null,
            lastRebalanceAt: 0,
            paperExitedAt: null,
          };
          trackedPositions.set(onChainPos.poolAddress, pos);
          yield* db.savePosition(pos).pipe(Effect.catchAll(() => Effect.void));
          yield* memory
            .upsert({
              category: "warning",
              content: `External position detected in ${onChainPos.poolAddress} and added to tracking.`,
              poolAddress: onChainPos.poolAddress,
            })
            .pipe(Effect.catchAll(() => Effect.void));
        }
      }
    }
  });
}

// ─── Build the dependency layer ──────────────────────────────────────────────

type AllServices =
  | ConfigService
  | AdapterService
  | StrategyService
  | MemoryService
  | RiskService
  | BlacklistService
  | AuditService
  | ScreenerService
  | DbService
  | RevenueService
  | RevenueConfigService
  | ReferralService;

export function buildLayer(cfg?: AppConfig): Layer.Layer<AllServices, never, never> {
  const dbLayer = DbLive(cfg?.sqliteDbPath);
  const configLayer = ConfigLive;

  const adapter = Layer.provide(AdapterLive, configLayer);
  const memory = Layer.provide(MemoryLive, dbLayer);
  const audit = Layer.provide(AuditLive, dbLayer);

  const screenerDeps = Layer.merge(adapter, StrategyLive);
  const screener = Layer.provide(
    ScreenerLive({
      minTvlUsd: cfg?.discoveryMinTvlUsd ?? 100_000,
      minFeeRatio: cfg?.discoveryMinFeeRatio ?? 1.5,
      volumeAuthThreshold: cfg?.volumeAuthThreshold ?? 0.7,
      minBinUtilization: cfg?.minBinUtilization ?? 0.3,
    }),
    screenerDeps,
  );

  const risk = RiskLive({
    confidenceThreshold: cfg?.confidenceThreshold ?? 0.65,
    maxOpenPositions: cfg?.maxOpenPositions ?? 3,
    maxRebalanceRangeBins: cfg?.maxRebalanceRangeBins ?? 50,
    stopLossPct: cfg?.stopLossPct ?? 0.15,
  });
  const blacklist = BlacklistLive({
    deployerBlacklistPath: cfg?.deployerBlacklistPath ?? "./engine/data/deployer-blacklist.json",
    tokenBlacklistPath: cfg?.tokenBlacklistPath ?? "./engine/data/token-blacklist.json",
  });

  const revenueConfigDeps = Layer.merge(dbLayer, configLayer);
  const revenueConfig = Layer.provide(RevenueConfigServiceLive, revenueConfigDeps);

  const merged = Layer.merge(adapter, StrategyLive);
  const merged2 = Layer.merge(merged, dbLayer);
  const merged3 = Layer.merge(merged2, memory);
  const merged4 = Layer.merge(merged3, risk);
  const merged5 = Layer.merge(merged4, blacklist);
  const merged6 = Layer.merge(merged5, audit);
  const merged7 = Layer.merge(merged6, screener);
  const merged8 = Layer.merge(merged7, configLayer);
  const merged9 = Layer.merge(merged8, RevenueLive);
  const merged10 = Layer.merge(merged9, ReferralLive);
  const merged11 = Layer.merge(merged10, revenueConfig);

  return merged11 as Layer.Layer<AllServices, never, never>;
}

// ─── Main program ────────────────────────────────────────────────────────────

export const program = Effect.gen(function* () {
  const config = yield* ConfigService;
  const adapter = yield* AdapterService;
  const strategy = yield* StrategyService;
  const memory = yield* MemoryService;
  const risk = yield* RiskService;
  const blacklist = yield* BlacklistService;
  const audit = yield* AuditService;
  const screener = yield* ScreenerService;
  const db = yield* DbService;
  const revenueConfigSvc = yield* RevenueConfigService;
  const referral = yield* ReferralService;

  // Load persisted positions at startup
  const allPositions = yield* db.getAllPositions().pipe(Effect.catchAll(() => Effect.succeed([])));
  const trackedPositions = new Map<string, PositionRecord>();
  for (const pos of allPositions) {
    trackedPositions.set(pos.poolAddress, pos);
  }

  // F2: per-pool recent active-bin history (in-memory ring buffer; resets on restart)
  const binHistoryCap = Math.max(
    config.volatilityLookbackSnapshots,
    config.oorRecoveryLookbackCycles,
    2,
  );
  const binHistory = new Map<string, number[]>();
  const pushBinHistory = (poolAddress: string, activeBinId: number): void => {
    const arr = binHistory.get(poolAddress) ?? [];
    arr.push(activeBinId);
    if (arr.length > binHistoryCap) arr.shift();
    binHistory.set(poolAddress, arr);
  };

  // F6: paper-trading day counter — persisted in metadata table so it
  // survives restarts. Increments when the day boundary rolls over.
  const PAPER_DAYS_KEY = "paperTradingDaysAccumulated";
  const PAPER_DAYS_LAST_KEY = "paperTradingLastDayIso";
  const todayIso = (): string => new Date().toISOString().slice(0, 10);

  const tickPaperDays = Effect.gen(function* () {
    if (!config.paperTrading) return 0;
    const lastDay = yield* db
      .getMetadata(PAPER_DAYS_LAST_KEY)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    const today = todayIso();
    if (lastDay === today) return 0;
    const stored = yield* db
      .getMetadata(PAPER_DAYS_KEY)
      .pipe(Effect.catchAll(() => Effect.succeed("0")));
    const current = Number(stored) || 0;
    const next = current + 1;
    yield* db
      .setMetadataBatch([
        { key: PAPER_DAYS_KEY, value: String(next) },
        { key: PAPER_DAYS_LAST_KEY, value: today },
      ])
      .pipe(Effect.catchAll(() => Effect.void));
    if (next % 7 === 0) {
      console.info(`[paper-validation] ${next} paper days accumulated`);
    }
    return next;
  });

  const readPaperDays = Effect.gen(function* () {
    const stored = yield* db
      .getMetadata(PAPER_DAYS_KEY)
      .pipe(Effect.catchAll(() => Effect.succeed("0")));
    return Number(stored) || 0;
  });

  if (!config.paperTrading) {
    const paperExited = yield* db
      .getPaperExitedPositions()
      .pipe(Effect.catchAll(() => Effect.succeed([])));
    if (paperExited.length > 0) {
      console.warn(
        `Found ${paperExited.length} paper-exited position(s) from a previous paper-trading run. ` +
          `If you entered these in live mode, the on-chain position is NOT closed by the paper exit — ` +
          `close it manually. The engine tracks these rows to prevent re-entering the same pool ` +
          `while the on-chain position is still open.`,
      );
      for (const pos of paperExited) {
        console.warn(`  Paper-exited: ${pos.poolAddress}`);
        if (pos.positionPubKey) {
          trackedPositions.set(pos.poolAddress, pos);
        }
      }
      for (const pos of paperExited) {
        if (!pos.positionPubKey) {
          yield* db.deletePosition(pos.poolAddress).pipe(Effect.catchAll(() => Effect.void));
        }
      }
    }
  }

  // ─── Pool discovery ────────────────────────────────────────────────────────

  let poolsToScan = [...config.watchlistPools];

  if (config.enablePoolDiscovery) {
    const screened = yield* screener.screenPools().pipe(
      Effect.catchAll((err) => {
        if (err instanceof DiscoverPoolsError || (err as { _tag?: string })?._tag === "DiscoverPoolsError") {
          console.warn(
            "Pool discovery failed; falling back to watchlist-only mode:",
            err instanceof Error ? err.message : String(err),
          );
          return Effect.succeed([] as ReadonlyArray<ScreenedPool>);
        }
        // Non-discovery error: let it propagate so the cycle fails loudly
        // instead of silently masking bugs as an empty discovery result.
        return Effect.fail(err);
      }),
    );
    if (screened.length > 0) {
      console.info(`Discovered ${screened.length} candidate pools`);
      const top3 = screened.slice(0, 3);
      for (const pool of top3) {
        console.info(`  Candidate: ${pool.address} (fee/IL: ${pool.feeIlRatio.toFixed(2)})`);
        if (!poolsToScan.includes(pool.address)) {
          poolsToScan.push(pool.address);
        }
      }
    }
  }

  yield* reconcilePositions(adapter, db, memory, trackedPositions, poolsToScan);

  // ─── Scan cycle ────────────────────────────────────────────────────────────

  const runScanCycle = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      const cycle: AgentCycle = {
        cycleId: randomUUID(),
        startedAt: Date.now(),
        poolsScanned: 0,
        poolsActioned: 0,
        decisions: [],
        totalGasCostSol: 0,
        paperTrading: config.paperTrading,
      };

      console.info("Scan cycle started", { cycleId: cycle.cycleId });

      if (poolsToScan.length === 0) {
        console.info("No pools configured — skipping cycle");
        cycle.completedAt = Date.now();
        return;
      }

      for (const poolAddress of poolsToScan) {
        const decision = yield* evaluatePool(poolAddress, cycle.cycleId).pipe(
          Effect.catchAll((err) => {
            console.error("Error processing pool", { poolAddress, err: String(err) });
            return Effect.succeed(null);
          }),
        );

        if (decision) {
          cycle.decisions.push(decision);
          cycle.poolsActioned++;
        }
        cycle.poolsScanned++;
      }

      cycle.completedAt = Date.now();
      const durationMs = cycle.completedAt - cycle.startedAt;
      console.info("Scan cycle complete", {
        cycleId: cycle.cycleId,
        scanned: cycle.poolsScanned,
        actioned: cycle.poolsActioned,
        durationSec: (durationMs / 1000).toFixed(1),
      });

      // Prune expired memories after each cycle
      yield* memory.pruneExpired().pipe(Effect.catchAll(() => Effect.void));
    });

  // ─── Per-pool evaluation ───────────────────────────────────────────────────

  const evaluatePool = (
    poolAddress: string,
    cycleId: string,
  ): Effect.Effect<AgentDecision | null, unknown> =>
    Effect.gen(function* () {
      const pool = yield* adapter.getPoolState(poolAddress);
      const binArray = yield* adapter.getBinArray(poolAddress);
      pushBinHistory(poolAddress, pool.activeBinId);

      if (config.enableSnapshotCapture && config.paperTrading) {
        yield* db
          .saveSnapshot({
            poolAddress,
            timestamp: pool.timestamp,
            activeBinId: pool.activeBinId,
            tvlUsd: pool.tvlUsd,
            volume24hUsd: pool.volume24hUsd,
            fees24hUsd: pool.fees24hUsd,
            apr: pool.apr,
            currentPrice: pool.currentPrice,
            binStep: pool.binStep,
            tokenXSymbol: pool.tokenXSymbol,
            tokenYSymbol: pool.tokenYSymbol,
            binArray: { ...binArray, binStep: pool.binStep },
          })
          .pipe(
            Effect.catchAll((err) => {
              console.warn("Snapshot save failed", { pool: poolAddress, err });
              return Effect.void;
            }),
          );
      }

      // Blacklist check (token mints only; deployer info not yet fetched)
      // TODO: fetch token deployer/authority from on-chain metadata and pass to checkPool
      yield* blacklist
        .checkPool(poolAddress, pool.tokenX, pool.tokenY)
        .pipe(Effect.catchAll(() => Effect.void));

      const metrics = strategy.computeMetrics(pool, binArray, 0);

      // Pre-filter
      if (
        !strategy.passesPreFilter(
          pool,
          metrics.volumeAuthenticity,
          metrics.binUtilization,
          config.minPoolTvlUsd,
          config.volumeAuthThreshold,
          config.minBinUtilization,
        )
      ) {
        console.debug("Pool failed pre-filter", { pool: poolAddress });
        return null;
      }

      // Check memory for warnings
      const warnings = yield* memory
        .getRelevantContext(`warnings for pool ${poolAddress}`, 3, poolAddress)
        .pipe(Effect.catchAll(() => Effect.succeed([])));
      const hasRecentWarning = warnings.some(
        (w) => w.category === "warning" && w.createdAt > Date.now() - 7 * 24 * 60 * 60 * 1000,
      );

      // Decision rules
      const feeIlRatio = metrics.feeIlRatio;
      const volumeAuth = metrics.volumeAuthenticity;
      const tvlVelocity = metrics.tvlVelocity;
      const binUtilization = metrics.binUtilization;

      let decision: AgentDecision | null = null;

      // OOR tracking must run before EXIT conditions so that out-of-range
      // cycle counts accumulate even when fee/IL triggers an EXIT.
      const pos = trackedPositions.get(poolAddress);
      let hasPosition = !!pos;
      if (pos) {
        const inRange = pool.activeBinId >= pos.lowerBinId && pool.activeBinId <= pos.upperBinId;
        if (!inRange) {
          if (pos.outOfRangeSince === null) {
            pos.outOfRangeSince = Date.now();
          }
          pos.oorCycleCount++;
        } else {
          pos.outOfRangeSince = null;
          pos.oorCycleCount = 0;
        }
      }

      if (pos && pos.positionPubKey && adapter.hasWallet()) {
        const walletAddress = adapter.getWalletAddress();
        if (walletAddress) {
          const onChainPositions = yield* adapter.getPositions(poolAddress, walletAddress).pipe(
            Effect.catchAll((err) => {
              console.error("Per-cycle reconcile: failed to fetch positions — skipping", {
                pool: poolAddress,
                err: String(err),
              });
              return Effect.succeed(null);
            }),
          );
          if (onChainPositions !== null) {
            const stillOnChain = onChainPositions.some((p) => p.id === pos.positionPubKey);
            if (!stillOnChain) {
              console.warn(
                `Per-cycle reconcile: position ${poolAddress} no longer on-chain — removing from tracking`,
              );
              trackedPositions.delete(poolAddress);
              yield* db.deletePosition(poolAddress).pipe(Effect.catchAll(() => Effect.void));
              yield* memory
                .upsert({
                  category: "warning",
                  content: `Position ${poolAddress} was closed externally during this cycle. Removed from tracking.`,
                  poolAddress,
                })
                .pipe(Effect.catchAll(() => Effect.void));
              hasPosition = false;
            }
          }
        }
      }

      // EXIT conditions (capital protection)
      if (tvlVelocity < -config.tvlDropExitPct) {
        decision = {
          action: "EXIT",
          poolAddress,
          confidence: 0.85,
          reasoning: `TVL dropped ${(Math.abs(tvlVelocity) * 100).toFixed(1)}% — capital protection exit`,
        };
        yield* memory
          .upsert({
            category: "warning",
            content: `Pool ${poolAddress} TVL dropped sharply. Exit triggered.`,
            poolAddress,
          })
          .pipe(Effect.catchAll(() => Effect.void));
      } else if (volumeAuth < config.volumeAuthThreshold) {
        decision = {
          action: "EXIT",
          poolAddress,
          confidence: 0.8,
          reasoning: `Volume authenticity ${volumeAuth.toFixed(2)} below threshold`,
        };
      } else if (feeIlRatio < 0.5) {
        decision = {
          action: "EXIT",
          poolAddress,
          confidence: 0.75,
          reasoning: `Fee/IL ratio ${feeIlRatio.toFixed(2)} below 0.5`,
        };
      }

      // Trailing exit (profit protection)
      if (!decision) {
        if (pos && hasPosition) {
          const estimatedValue = estimatePositionValue(pos, pool);
          pos.currentValueUsd = estimatedValue;
          const highest = pos.highestValueUsd ?? pos.depositedUsd;
          if (estimatedValue > highest) {
            pos.highestValueUsd = estimatedValue;
          }
          const drawdown = highest > 0 ? (highest - estimatedValue) / highest : 0;
          if (drawdown > config.trailingStopPct) {
            decision = {
              action: "EXIT",
              poolAddress,
              confidence: 0.8,
              reasoning: `Trailing stop: value dropped ${(drawdown * 100).toFixed(1)}% from peak $${highest.toFixed(2)}`,
            };
          }
          // Persist updated values
          yield* db.savePosition(pos).pipe(Effect.catchAll(() => Effect.void));
        }
      }

      const walletBalanceUsd = adapter.hasWallet()
        ? yield* adapter
            .getWalletBalanceUsd()
            .pipe(Effect.catchAll(() => Effect.succeed(config.paperPortfolioUsd)))
        : config.paperPortfolioUsd;

      // REBALANCE check
      if (!decision) {
        const currentLowerBinId = pos?.lowerBinId ?? pool.activeBinId - 20;
        const currentUpperBinId = pos?.upperBinId ?? pool.activeBinId + 20;
        const positionCenter = (currentLowerBinId + currentUpperBinId) / 2;
        const positionHalfWidth = (currentUpperBinId - currentLowerBinId) / 2;
        const driftPct = Math.abs(pool.activeBinId - positionCenter) / (positionHalfWidth || 1);
        const lastRebal = pos?.lastRebalanceAt ?? 0;
        const timeSinceRebal = Date.now() - lastRebal;

        const oorGraceExpired =
          hasPosition && pos && pos.oorCycleCount >= config.oorGracePeriodCycles;

        // F2: compute recent bin volatility
        const recentBins = binHistory.get(poolAddress) ?? [];
        const volatilityLookback = Math.max(2, config.volatilityLookbackSnapshots);
        const volatilityBins =
          recentBins.length > volatilityLookback
            ? recentBins.slice(recentBins.length - volatilityLookback)
            : recentBins;
        const volatilityStddev = computeBinVolatilityStddev(volatilityBins);
        const highVol = isHighVolatility(volatilityStddev, config.volatilityExitStddev);

        // F4: slice the history to the configured recovery lookback window.
        // The full ring buffer is sized to hold at least
        // max(volatilityLookbackSnapshots, oorRecoveryLookbackCycles); volatility
        // uses the full buffer while recovery slices to its own window.
        const recoveryLookback = Math.max(2, config.oorRecoveryLookbackCycles);
        const recoveryBins =
          recentBins.length > recoveryLookback
              ? recentBins.slice(recentBins.length - recoveryLookback)
              : recentBins;

        if (
          hasPosition &&
          highVol &&
          driftPct > 0.6 &&
          (timeSinceRebal >= config.minRebalanceIntervalMs || oorGraceExpired)
        ) {
          console.info(
            `[vol-gate] EXITING ${poolAddress} — high volatility (stddev=${volatilityStddev.toFixed(2)}, threshold=${config.volatilityExitStddev}). Drift=${(driftPct * 100).toFixed(0)}%`,
          );
          decision = {
            action: "EXIT",
            poolAddress,
            confidence: 0.8,
            reasoning: `High volatility (σ=${volatilityStddev.toFixed(2)}) + ${(driftPct * 100).toFixed(0)}% drift — exit to wallet rather than rebalancing into new range`,
          };
          yield* memory
            .upsert({
              category: "warning",
              content: `Volatility-gate EXIT for ${poolAddress}: stddev=${volatilityStddev.toFixed(2)} over ${volatilityBins.length} snapshots`,
              poolAddress,
            })
            .pipe(Effect.catchAll(() => Effect.void));
        } else if (
          hasPosition &&
          (driftPct > 0.6 || oorGraceExpired) &&
          (timeSinceRebal >= config.minRebalanceIntervalMs || oorGraceExpired)
        ) {
          const recommended = highVol
            ? recommendBinRangeForVolatility(
                pool.activeBinId,
                pool.binStep,
                true,
                config.volatilityWideHalfWidthBins,
              )
            : strategy.recommendBinRange(pool.activeBinId, pool.binStep);
          const sim = yield* adapter.simulateRebalance(
            poolAddress,
            recommended.lowerBinId,
            recommended.upperBinId,
          );

          // F1: gas-aware gate — skip rebalance when gas cost > N days of position fees
          // Use currentValueUsd (not depositedUsd) so the share reflects the
          // position's present value, not its original deposit. If current
          // value is unknown (reconciled positions), fall back to 0 which
          // makes the gas gate reject — a conservative default.
          const positionSharePct =
            pool.tvlUsd > 0 && pos && pos.currentValueUsd > 0
              ? Math.min(pos.currentValueUsd / pool.tvlUsd, 1)
              : 0;
          const positionDailyFeesUsd = pool.fees24hUsd * positionSharePct;
          const gasGate = evaluateGasGate({
            rebalanceGasCostSol: config.rebalanceGasCostSol,
            solPriceUsd: config.solPriceUsd,
            positionDailyFeesUsd,
            minDaysOfFeesPaidAhead: config.gasAwareMinDaysOfFeesPaidAhead,
          });
          if (!gasGate.approved) {
            console.info(
              `[gas-gate] Holding ${poolAddress} — ${gasGate.reason} (gas=$${gasGate.gasCostUsd.toFixed(2)}, threshold=$${gasGate.feesThresholdUsd.toFixed(2)})`,
            );
            yield* memory
              .upsert({
                category: "warning",
                content: `Gas-aware rebalance gate held ${poolAddress}: ${gasGate.reason}`,
                poolAddress,
              })
              .pipe(Effect.catchAll(() => Effect.void));
            yield* audit
              .recordDecision({
                timestamp: Date.now(),
                cycleId,
                poolAddress,
                action: "HOLD",
                confidence: 0,
                reasoning: `[gas-gate] ${gasGate.reason}`,
                metrics,
                riskResult: { approved: false, reason: `[gas-gate] ${gasGate.reason}` },
                executed: false,
                paperTrading: config.paperTrading,
              })
              .pipe(Effect.catchAll(() => Effect.void));
          } else {
            // F4: OOR recovery probability — if the recent bin path is
            // mean-reverting enough to plausibly recover, hold rather than
            // rebalance. Otherwise rebalance as usual.
            const recoveryProb = estimateRecoveryProbability(
              recoveryBins,
              Math.abs(pool.activeBinId - positionCenter),
            );
            const holdForRecovery = shouldHoldForRecovery(
              recoveryProb,
              config.oorRecoveryHoldThreshold,
            );
            if (holdForRecovery) {
              console.info(
                `[recovery-gate] Holding ${poolAddress} — recovery prob ${recoveryProb.toFixed(2)} >= ${config.oorRecoveryHoldThreshold}`,
              );
              yield* memory
                .upsert({
                  category: "pattern",
                  content: `OOR recovery prediction held ${poolAddress}: probability ${recoveryProb.toFixed(2)}`,
                  poolAddress,
                })
                .pipe(Effect.catchAll(() => Effect.void));
              yield* audit
                .recordDecision({
                  timestamp: Date.now(),
                  cycleId,
                  poolAddress,
                  action: "HOLD",
                  confidence: recoveryProb,
                  reasoning: `[recovery-gate] probability ${recoveryProb.toFixed(2)} >= ${config.oorRecoveryHoldThreshold} — expecting mean-reversion`,
                  metrics,
                  riskResult: {
                    approved: false,
                    reason: `[recovery-gate] probability ${recoveryProb.toFixed(2)} above hold threshold`,
                  },
                  executed: false,
                  paperTrading: config.paperTrading,
                })
                .pipe(Effect.catchAll(() => Effect.void));
            } else if (
              sim.netBenefitUsd > config.minRebalanceNetBenefitUsd ||
              recoveryProb <= config.oorRecoveryForceRebalanceThreshold
            ) {
              const forceRebalance = recoveryProb <= config.oorRecoveryForceRebalanceThreshold;
              decision = {
                action: "REBALANCE",
                poolAddress,
                confidence: Math.min(0.7 + feeIlRatio * 0.1, 0.9),
                reasoning: forceRebalance
                  ? `[recovery-gate] force-rebalance — probability ${recoveryProb.toFixed(2)} <= ${config.oorRecoveryForceRebalanceThreshold}. Drift ${(driftPct * 100).toFixed(0)}%`
                  : `Drift ${(driftPct * 100).toFixed(0)}%. Net benefit: $${sim.netBenefitUsd.toFixed(2)}`,
                rebalanceParams: {
                  newLowerBinId: recommended.lowerBinId,
                  newUpperBinId: recommended.upperBinId,
                  slippageBps: 50,
                },
              };
            }
          }
        }

        // HOLD or ENTER
        if (!decision) {
          if (hasPosition) {
            if (feeIlRatio > config.minFeeIlRatio && !hasRecentWarning) {
              decision = {
                action: "HOLD",
                poolAddress,
                confidence: Math.min(0.6 + feeIlRatio * 0.05, 0.9),
                reasoning: `Fee/IL ${feeIlRatio.toFixed(2)} above threshold. Holding.`,
              };
            }
          } else {
            if (
              feeIlRatio > config.minFeeIlRatio * 1.5 &&
              volumeAuth > 0.8 &&
              binUtilization > 0.4 &&
              pool.tvlUsd > config.minPoolTvlUsd * 2
            ) {
              const maxPositionSize = Math.min(walletBalanceUsd * 0.5, pool.tvlUsd * 0.005, 500);
              const proposedSizeUsd = Math.max(maxPositionSize, 10);

              // F5: per-pool allocation cap — split across maxOpenPositions pools
              // so a single SOL/USDC exposure doesn't dominate the portfolio.
              // F5 fix: use the actual fetched wallet balance (live) or paper
              // portfolio default (paper) as portfolioValueUsd. Previously this
              // hardcoded config.paperPortfolioUsd which made live caps wrong.
              const allocation = evaluatePerPoolAllocation({
                proposedDepositUsd: proposedSizeUsd,
                portfolioValueUsd: walletBalanceUsd,
                openPositions: Array.from(trackedPositions.values()).map((p) => ({
                  id: p.poolAddress,
                  poolAddress: p.poolAddress,
                  poolName: `${p.tokenXSymbol}/${p.tokenYSymbol}`,
                  lowerBinId: p.lowerBinId,
                  upperBinId: p.upperBinId,
                  liquidityShares: 0n,
                  depositedUsd: p.depositedUsd,
                  currentValueUsd: p.currentValueUsd,
                  unrealizedPnlUsd: p.currentValueUsd - p.depositedUsd,
                  feesEarnedUsd: 0,
                  openedAt: p.timestamp,
                })),
                maxPerPoolAllocationPct: config.maxPerPoolAllocationPct,
                maxOpenPositions: config.maxOpenPositions,
              });
              if (!allocation.approved) {
                console.info(
                  `[alloc-gate] Skipping ENTER ${poolAddress} — ${allocation.reason}`,
                );
                yield* memory
                  .upsert({
                    category: "pattern",
                    content: `Allocation gate skipped ENTER on ${poolAddress}: ${allocation.reason}`,
                    poolAddress,
                  })
                  .pipe(Effect.catchAll(() => Effect.void));
                yield* audit
                  .recordDecision({
                    timestamp: Date.now(),
                    cycleId,
                    poolAddress,
                    action: "ENTER",
                    confidence: 0,
                    reasoning: `[alloc-gate] ${allocation.reason}`,
                    metrics,
                    riskResult: { approved: false, reason: `[alloc-gate] ${allocation.reason}` },
                    executed: false,
                    paperTrading: config.paperTrading,
                  })
                  .pipe(Effect.catchAll(() => Effect.void));
                return null;
              }
              const positionSizeUsd = allocation.adjustedDepositUsd;

              decision = {
                action: "ENTER",
                poolAddress,
                confidence: Math.min(0.5 + feeIlRatio * 0.05, 0.85),
                reasoning: `Strong pool: Fee/IL ${feeIlRatio.toFixed(2)}, auth ${volumeAuth.toFixed(2)}, TVL $${pool.tvlUsd.toFixed(0)}`,
                positionSizeUsd,
              };
            }
          }
        }
      }

      if (!decision) {
        decision = {
          action: "HOLD",
          poolAddress,
          confidence: 0.5,
          reasoning: `No strong signal. Fee/IL: ${feeIlRatio.toFixed(2)}`,
        };
      }

      // Risk evaluation
      const openPositions = Array.from(trackedPositions.values()).map((p) => ({
        id: p.poolAddress,
        poolAddress: p.poolAddress,
        poolName: `${p.tokenXSymbol}/${p.tokenYSymbol}`,
        lowerBinId: p.lowerBinId,
        upperBinId: p.upperBinId,
        liquidityShares: 0n,
        depositedUsd: p.depositedUsd,
        currentValueUsd: p.currentValueUsd,
        unrealizedPnlUsd: p.currentValueUsd - p.depositedUsd,
        feesEarnedUsd: 0,
        openedAt: p.timestamp,
      }));

      const portfolioValueUsd = walletBalanceUsd;
      const recentPnlUsd = openPositions.reduce((sum, pos) => sum + pos.unrealizedPnlUsd, 0);

      const riskResult = risk.evaluate(decision, {
        openPositions,
        portfolioValueUsd,
        recentPnlUsd,
      });

      // Apply risk-adjusted position size cap
      if (riskResult.adjustedSizeUsd && decision.action === "ENTER") {
        decision.positionSizeUsd = riskResult.adjustedSizeUsd;
        decision.reasoning += ` (size capped to $${riskResult.adjustedSizeUsd.toFixed(0)})`;
      }

      if (!riskResult.approved) {
        console.warn("Risk engine rejected", {
          reason: riskResult.reason,
          pool: poolAddress,
        });
        yield* audit
          .recordDecision({
            timestamp: Date.now(),
            cycleId,
            poolAddress,
            action: decision.action,
            confidence: decision.confidence,
            reasoning: decision.reasoning,
            metrics,
            riskResult,
            executed: false,
            paperTrading: config.paperTrading,
          })
          .pipe(Effect.catchAll(() => Effect.void));
        yield* memory
          .upsert({
            category: "warning",
            content: `Decision rejected: ${riskResult.reason}. Action: ${decision.action}`,
            poolAddress,
          })
          .pipe(Effect.catchAll(() => Effect.void));
        return decision;
      }

      // Execute
      let executed = false;

      // F6: paper-trading validation gate — only blocks ENTER, runs only in live mode
      if (!config.paperTrading && decision.action === "ENTER") {
        const paperDays = yield* readPaperDays;
        const validation = evaluatePaperValidation({
          paperTrading: false,
          paperDaysAccumulated: paperDays,
          minDays: config.paperValidationMinDays,
          enforce: config.paperValidationEnforce,
        });
        if (validation.warning) {
          console.warn(`[paper-validation] ${validation.warning}`);
        }
        if (!validation.approved) {
          console.warn(
            `[paper-validation] Blocking live ENTER on ${poolAddress} — ${validation.reason}`,
          );
          yield* memory
            .upsert({
              category: "warning",
              content: `Paper validation gate blocked live ENTER on ${poolAddress}: ${validation.reason}`,
              poolAddress,
            })
            .pipe(Effect.catchAll(() => Effect.void));
          yield* audit
            .recordDecision({
              timestamp: Date.now(),
              cycleId,
              poolAddress,
              action: decision.action,
              confidence: decision.confidence,
              reasoning: `[paper-validation] ${validation.reason}`,
              metrics,
              riskResult: { approved: false, reason: validation.reason },
              executed: false,
              paperTrading: false,
            })
            .pipe(Effect.catchAll(() => Effect.void));
          return decision;
        }
      }

      if (config.paperTrading) {
        // F6: tickPaperDays increments the day counter only in paper mode (live ticks don't affect it)
        yield* tickPaperDays;
        console.info("[PAPER] Would execute", {
          action: decision.action,
          pool: poolAddress,
        });
        executed = yield* executePaper(decision, pool);
      } else {
        executed = yield* executeLive(decision, pool);
      }

      // Audit after execution
      yield* audit
        .recordDecision({
          timestamp: Date.now(),
          cycleId,
          poolAddress,
          action: decision.action,
          confidence: decision.confidence,
          reasoning: decision.reasoning,
          metrics,
          riskResult,
          executed,
          paperTrading: config.paperTrading,
        })
        .pipe(Effect.catchAll(() => Effect.void));

      return decision;
    });

  // ─── Paper execution ───────────────────────────────────────────────────────

  const executePaper = (
    decision: AgentDecision,
    pool: { activeBinId: number; binStep: number; tokenXSymbol: string; tokenYSymbol: string },
  ): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (decision.action === "ENTER" && decision.positionSizeUsd) {
        const existing = trackedPositions.get(decision.poolAddress);
        const liveExited =
          existing && existing.paperExitedAt !== null && existing.positionPubKey !== null;
        const pos: PositionRecord = {
          poolAddress: decision.poolAddress,
          positionPubKey: liveExited ? existing!.positionPubKey : null,
          depositedUsd: decision.positionSizeUsd,
          currentValueUsd: decision.positionSizeUsd,
          tokenXSymbol: pool.tokenXSymbol,
          tokenYSymbol: pool.tokenYSymbol,
          activeBinId: pool.activeBinId,
          lowerBinId: pool.activeBinId - 20,
          upperBinId: pool.activeBinId + 20,
          timestamp: Date.now(),
          outOfRangeSince: null,
          oorCycleCount: 0,
          lastFeeClaimAt: Date.now(),
          trailingStopThreshold: null,
          highestValueUsd: null,
          lastRebalanceAt: 0,
          paperExitedAt: liveExited ? existing!.paperExitedAt : null,
        };
        trackedPositions.set(decision.poolAddress, pos);
        yield* db.savePosition(pos).pipe(Effect.catchAll(() => Effect.void));
      } else if (decision.action === "EXIT") {
        const pos = trackedPositions.get(decision.poolAddress);
        if (pos?.positionPubKey) {
          if (config.paperModeExitLive) {
            console.warn(
              `[PAPER] PAPER_MODE_EXIT_LIVE is enabled — executing live EXIT for ${decision.poolAddress}`,
            );
            return yield* executeLive(decision, pool);
          }
          // Live position — paper trading must not "exit" it without an on-chain tx.
          // Skip and warn so the user can switch to live mode to actually close it.
          console.warn(
            `[PAPER] Skipping EXIT for ${decision.poolAddress} — this is a live position ` +
              `(pubKey: ${pos.positionPubKey}). Switch to live mode to close it on-chain.`,
          );
          return false;
        }
        yield* db.markPaperExited(decision.poolAddress).pipe(Effect.catchAll(() => Effect.void));
        trackedPositions.delete(decision.poolAddress);
      } else if (
        decision.action === "REBALANCE" &&
        decision.rebalanceParams &&
        trackedPositions.has(decision.poolAddress)
      ) {
        const current = trackedPositions.get(decision.poolAddress)!;
        const updated: PositionRecord = {
          ...current,
          lowerBinId: decision.rebalanceParams.newLowerBinId,
          upperBinId: decision.rebalanceParams.newUpperBinId,
          lastRebalanceAt: Date.now(),
        };
        trackedPositions.set(decision.poolAddress, updated);
        yield* db.savePosition(updated).pipe(Effect.catchAll(() => Effect.void));
      }
      return true;
    });

  // ─── Live execution ────────────────────────────────────────────────────────

  const executeLive = (
    decision: AgentDecision,
    pool: { activeBinId: number; binStep: number; tokenXSymbol: string; tokenYSymbol: string },
  ): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (!adapter.hasWallet()) {
        console.error("Live trading enabled but no wallet configured");
        return false;
      }

      // F5 allocation gate already caps the number of simultaneously open
      // positions via evaluatePerPoolAllocation (rejected in the decision
      // flow before we reach executeLive). No additional hard cap here so
      // live mode honors maxOpenPositions.

      if (decision.action === "ENTER") {
        yield* adapter.swapUSDCForSOL(0.05, 2.0).pipe(Effect.catchAll(() => Effect.void));

        const lamports = yield* adapter
          .getNativeSolBalance()
          .pipe(Effect.catchAll(() => Effect.succeed(0)));
        const solBalance = lamports / 1e9;
        if (solBalance < 0.03) {
          console.warn("Insufficient SOL for gas — skipping ENTER");
          return false;
        }
      }

      if (decision.action === "ENTER" && decision.positionSizeUsd) {
        const recommended = strategy.recommendBinRange(pool.activeBinId, pool.binStep);
        const result = yield* adapter
          .enterPosition(
            decision.poolAddress,
            recommended.lowerBinId,
            recommended.upperBinId,
            decision.positionSizeUsd,
          )
          .pipe(
            Effect.tap((r) =>
              console.info("Live position entered", {
                pool: decision.poolAddress,
                position: r.positionPubKey,
                tx: r.txSignature,
              }),
            ),
            Effect.catchAll((err) => {
              console.error("Live ENTER failed", {
                pool: decision.poolAddress,
                err: (err as { message?: string }).message ?? String(err),
              });
              return Effect.succeed(null);
            }),
          );

        if (result) {
          const pos: PositionRecord = {
            poolAddress: decision.poolAddress,
            positionPubKey: result.positionPubKey,
            depositedUsd: decision.positionSizeUsd,
            currentValueUsd: decision.positionSizeUsd,
            tokenXSymbol: pool.tokenXSymbol,
            tokenYSymbol: pool.tokenYSymbol,
            activeBinId: pool.activeBinId,
            lowerBinId: recommended.lowerBinId,
            upperBinId: recommended.upperBinId,
            timestamp: Date.now(),
            outOfRangeSince: null,
            oorCycleCount: 0,
            lastFeeClaimAt: Date.now(),
            trailingStopThreshold: null,
            highestValueUsd: null,
            lastRebalanceAt: 0,
            paperExitedAt: null,
          };
          trackedPositions.set(decision.poolAddress, pos);
          yield* db.savePosition(pos).pipe(Effect.catchAll(() => Effect.void));
          return true;
        }
        return false;
      } else if (decision.action === "EXIT") {
        const pos = trackedPositions.get(decision.poolAddress);
        let exited = false;
        if (pos?.positionPubKey) {
          const result = yield* adapter.exitPosition(decision.poolAddress, pos.positionPubKey).pipe(
            Effect.tap(() =>
              console.info("Live position exited", {
                pool: decision.poolAddress,
              }),
            ),
            Effect.catchAll((err) => {
              console.error("Live EXIT failed", {
                pool: decision.poolAddress,
                err: (err as { message?: string }).message ?? String(err),
              });
              return Effect.succeed(null);
            }),
          );
          exited = result !== null;
        } else {
          exited = true;
        }
        if (exited) {
          trackedPositions.delete(decision.poolAddress);
          yield* db.deletePosition(decision.poolAddress).pipe(Effect.catchAll(() => Effect.void));
        }
        return exited;
      } else if (decision.action === "REBALANCE" && decision.rebalanceParams) {
        const pos = trackedPositions.get(decision.poolAddress);
        if (pos?.positionPubKey) {
          const revenueConfigResult = yield* revenueConfigSvc.getConfig();
          const platformFeeRate = revenueConfigResult.platformFeeRate;
          const revenueShareEnabled = revenueConfigResult.revenueShareEnabled;
          const revenueShareOperatorPct = revenueConfigResult.revenueShareOperatorPct;
          const tier = revenueConfigResult.tier;

          // Claim fees before rebalancing (with platform fee)
          const claimResult = yield* adapter
            .claimFees(
              decision.poolAddress,
              pos.positionPubKey,
              platformFeeRate,
              revenueShareEnabled,
              revenueShareOperatorPct,
              revenueConfigResult.feeWalletAddress,
            )
            .pipe(Effect.catchAll(() => Effect.succeed(null)));

          if (claimResult && (claimResult.feeX > 0 || claimResult.feeY > 0)) {
            yield* db
              .saveFeeClaim({
                id: randomUUID(),
                poolAddress: decision.poolAddress,
                positionPubkey: pos.positionPubKey,
                feeX: claimResult.feeX,
                feeY: claimResult.feeY,
                platformFeeX: claimResult.platformFeeX,
                platformFeeY: claimResult.platformFeeY,
                netFeeX: claimResult.netFeeX,
                netFeeY: claimResult.netFeeY,
                operatorFeeX: claimResult.operatorFeeX ?? 0,
                operatorFeeY: claimResult.operatorFeeY ?? 0,
                txSignature: claimResult.txSignature,
                feeTransferTxSignature: claimResult.feeTransferTxSignature ?? null,
                reportedToApi: false,
                createdAt: Date.now(),
              })
              .pipe(Effect.catchAll(() => Effect.void));

            if (
              claimResult.platformFeeX > 0 ||
              claimResult.platformFeeY > 0 ||
              (claimResult.operatorFeeX ?? 0) > 0 ||
              (claimResult.operatorFeeY ?? 0) > 0
            ) {
              adapter.reportFeeCollection({
                poolAddress: decision.poolAddress,
                positionPubkey: pos.positionPubKey,
                feeX: claimResult.feeX,
                feeY: claimResult.feeY,
                platformFeeX: claimResult.platformFeeX,
                platformFeeY: claimResult.platformFeeY,
                tier,
                txSignature: claimResult.txSignature,
                ...(claimResult.feeTransferTxSignature != null && {
                  feeTransferTxSignature: claimResult.feeTransferTxSignature,
                }),
                ...(claimResult.operatorFeeX != null && {
                  operatorFeeX: claimResult.operatorFeeX,
                }),
                ...(claimResult.operatorFeeY != null && {
                  operatorFeeY: claimResult.operatorFeeY,
                }),
              });
            }
          }

          const result = yield* adapter
            .rebalancePosition(
              decision.poolAddress,
              pos.positionPubKey,
              decision.rebalanceParams.newLowerBinId,
              decision.rebalanceParams.newUpperBinId,
            )
            .pipe(
              Effect.tap((r) =>
                console.info("Live position rebalanced", {
                  pool: decision.poolAddress,
                  newPosition: r.newPositionPubKey,
                }),
              ),
              Effect.catchAll((err) => {
                console.error("Live REBALANCE failed", {
                  pool: decision.poolAddress,
                  err: (err as { message?: string }).message ?? String(err),
                });
                return Effect.succeed(null);
              }),
            );

          if (result) {
            const updated: PositionRecord = {
              ...pos,
              positionPubKey: result.newPositionPubKey,
              lowerBinId: decision.rebalanceParams.newLowerBinId,
              upperBinId: decision.rebalanceParams.newUpperBinId,
              lastFeeClaimAt: Date.now(),
              lastRebalanceAt: Date.now(),
            };
            trackedPositions.set(decision.poolAddress, updated);
            yield* db.savePosition(updated).pipe(Effect.catchAll(() => Effect.void));
            return true;
          }
          return false;
        }
      }
      return false;
    });

  // ─── Periodic fee claiming ─────────────────────────────────────────────────

  const claimAllFees = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      const revenueConfigResult = yield* revenueConfigSvc.getConfig();
      const platformFeeRate = revenueConfigResult.platformFeeRate;
      const revenueShareEnabled = revenueConfigResult.revenueShareEnabled;
      const revenueShareOperatorPct = revenueConfigResult.revenueShareOperatorPct;
      const tier = revenueConfigResult.tier;

      for (const [poolAddress, pos] of trackedPositions) {
        if (pos.positionPubKey && Date.now() - pos.lastFeeClaimAt > config.feeClaimIntervalMs) {
          const result = yield* adapter
            .claimFees(
              poolAddress,
              pos.positionPubKey,
              platformFeeRate,
              revenueShareEnabled,
              revenueShareOperatorPct,
              revenueConfigResult.feeWalletAddress,
            )
            .pipe(
              Effect.tap((r) =>
                console.info("Fees claimed", {
                  pool: poolAddress,
                  tier,
                  feeX: r.feeX,
                  feeY: r.feeY,
                  platformFeeX: r.platformFeeX,
                  platformFeeY: r.platformFeeY,
                  netFeeX: r.netFeeX,
                  netFeeY: r.netFeeY,
                  tx: r.txSignature,
                }),
              ),
              Effect.catchAll(() => Effect.succeed(null)),
            );
          if (!result || (result.feeX === 0 && result.feeY === 0)) {
            continue;
          }

          yield* db
            .saveFeeClaim({
              id: randomUUID(),
              poolAddress,
              positionPubkey: pos.positionPubKey,
              feeX: result.feeX,
              feeY: result.feeY,
              platformFeeX: result.platformFeeX,
              platformFeeY: result.platformFeeY,
              netFeeX: result.netFeeX,
              netFeeY: result.netFeeY,
              operatorFeeX: result.operatorFeeX ?? 0,
              operatorFeeY: result.operatorFeeY ?? 0,
              txSignature: result.txSignature,
              feeTransferTxSignature: result.feeTransferTxSignature ?? null,
              reportedToApi: false,
              createdAt: Date.now(),
            })
            .pipe(Effect.catchAll(() => Effect.void));

          if (
            result.platformFeeX > 0 ||
            result.platformFeeY > 0 ||
            (result.operatorFeeX ?? 0) > 0 ||
            (result.operatorFeeY ?? 0) > 0
          ) {
            adapter.reportFeeCollection({
              poolAddress,
              positionPubkey: pos.positionPubKey,
              feeX: result.feeX,
              feeY: result.feeY,
              platformFeeX: result.platformFeeX,
              platformFeeY: result.platformFeeY,
              tier,
              txSignature: result.txSignature,
              ...(result.feeTransferTxSignature != null && {
                feeTransferTxSignature: result.feeTransferTxSignature,
              }),
              ...(result.operatorFeeX != null && {
                operatorFeeX: result.operatorFeeX,
              }),
              ...(result.operatorFeeY != null && {
                operatorFeeY: result.operatorFeeY,
              }),
            });
          }

          pos.lastFeeClaimAt = Date.now();
          yield* db.savePosition(pos).pipe(Effect.catchAll(() => Effect.void));

          // F3: fee compounding — if AUTO_COMPOUND_FEES is on and the net fees
          // cleared the cost threshold, redeposit them into the same range.
          // This closes + reopens the position around the same bins so the
          // claimed fees become new liquidity instead of sitting in the wallet.
          if (config.autoCompoundFees && config.paperTrading === false) {
            const netFeesUsd = convertClaimFeesToUsd({
              netFeeXRaw: result.netFeeX,
              netFeeYRaw: result.netFeeY,
              tokenXSymbol: pos.tokenXSymbol,
              tokenYSymbol: pos.tokenYSymbol,
              solPriceUsd: config.solPriceUsd,
            });
            const rebalanceGasCostUsd = config.rebalanceGasCostSol * config.solPriceUsd;
            const compoundGate = evaluateCompoundGate({
              netFeesUsd,
              minCompoundFeesUsd: config.minCompoundFeesUsd,
              compoundGasBufferUsd: config.compoundGasBufferUsd,
              rebalanceGasCostUsd,
            });
            if (compoundGate.approved) {
              console.info(
                `[compound] Redeeming fees back into ${poolAddress} — ${compoundGate.reason}`,
              );
              const compoundResult = yield* adapter
                .rebalancePosition(
                  poolAddress,
                  pos.positionPubKey,
                  pos.lowerBinId,
                  pos.upperBinId,
                )
                .pipe(
                  Effect.tap((r) =>
                    console.info("Compound rebalance succeeded", {
                      pool: poolAddress,
                      newPosition: r.newPositionPubKey,
                    }),
                  ),
                  Effect.catchAll((err) => {
                    console.warn("Compound rebalance failed", {
                      pool: poolAddress,
                      err: (err as { message?: string }).message ?? String(err),
                    });
                    return Effect.succeed(null);
                  }),
                );
              if (compoundResult) {
                pos.positionPubKey = compoundResult.newPositionPubKey;
                pos.lastRebalanceAt = Date.now();
                pos.depositedUsd += netFeesUsd;
                yield* db.savePosition(pos).pipe(Effect.catchAll(() => Effect.void));
                yield* memory
                  .upsert({
                    category: "pattern",
                    content: `Auto-compounded $${netFeesUsd.toFixed(2)} fees into ${poolAddress} (savings $${compoundGate.savingsUsd.toFixed(2)})`,
                    poolAddress,
                  })
                  .pipe(Effect.catchAll(() => Effect.void));
              }
            }
          }
        }
      }
    });

  // ─── Run initial cycle and schedule ────────────────────────────────────────

  yield* memory.initialize().pipe(Effect.catchAll(() => Effect.void));

  // Run first cycle
  yield* runScanCycle();

  // Schedule periodic cycles
  const layer = buildLayer(config);

  const interval = setInterval(() => {
    if (cycleInFlight) {
      skippedCycles++;
      console.warn("Skipping cycle — previous still running", {
        skippedCycles,
      });
      return;
    }
    cycleInFlight = true;
    Effect.runPromise(
      Effect.gen(function* () {
        yield* reconcilePositions(adapter, db, memory, trackedPositions, poolsToScan);
        yield* claimAllFees();
        yield* checkForAutoUpdate(config, db);
        yield* runScanCycle();
      }).pipe(
        Effect.provide(layer),
        Effect.catchAll((err) => {
          console.error("Cycle error:", err);
          return Effect.void;
        }),
        Effect.tap(() =>
          Effect.sync(() => {
            cycleInFlight = false;
          }),
        ),
      ),
    ).catch((err) => {
      console.error("Fatal cycle error:", err);
      cycleInFlight = false;
    });
  }, config.scanIntervalMs);

  process.on("SIGINT", () => {
    clearInterval(interval);
    console.info("Received SIGINT — shutting down");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    clearInterval(interval);
    console.info("Received SIGTERM — shutting down");
    process.exit(0);
  });

  // Keep process alive
  yield* Effect.never;
});
