/**
 * Backtest — replays historical pool data through the DLMM strategy
 * to evaluate decision quality without spending real capital.
 *
 * Two sources:
 *   - synthetic: stochastic mock generator (stress-test baseline)
 *   - replay:    snapshots stored in SQLite by a live paper run
 *                (set ENABLE_SNAPSHOT_CAPTURE=true on the agent)
 *
 * Usage:
 *   bun run backtest                                          # default: synthetic, 7d
 *   bun run backtest -- --seed 42                             # repeatable synthetic run
 *   bun run ops/backtest.ts --days 30 --pools <addr1,addr2>
 *   bun run ops/backtest.ts --source replay --db ./prism.db
 */
import { Effect } from "effect";
import { createLogger } from "../engine/logger.js";
import {
  DLMMStrategy,
  halfWidthForPriceCoveragePct,
  type VolumeAuthResult,
} from "../engine/strategy-service.js";
import type { PoolMetrics } from "../engine/types.js";
import { DbLive } from "../engine/db-service.js";
import { DbService } from "../engine/services.js";
import type { BacktestResult, BinArray, PoolSnapshot, PoolState } from "../engine/types.js";
import {
  evaluateReplayPool,
  type ReplayEvaluation,
  type ReplayPosition,
} from "../engine/cycle/evaluate-pool.js";

const log = createLogger("Backtest");

/** Range edges of a DLMM position expressed as bin prices. */
interface BinRangePrices {
  readonly pa: number;
  readonly pb: number;
}

/** Mark-to-market and HODL-benchmark values of a CLMM position. */
interface PositionValue {
  readonly lpValueUsd: number;
  readonly hodlValueUsd: number;
}

/** Range edges of a DLMM position expressed as bin prices. Bin i has price
 * P_i = P_anchor·(1+s)^(i−anchorBin), so the position's [lower, upper] bin
 * range maps to a CLMM price range [P_a, P_b]. */
export function binRangePrices(args: {
  anchorPrice: number;
  anchorBinId: number;
  lowerBinId: number;
  upperBinId: number;
  binStep: number;
}): BinRangePrices {
  const s = 1 + args.binStep / 10_000;
  const pa = args.anchorPrice * Math.pow(s, args.lowerBinId - args.anchorBinId);
  const pb = args.anchorPrice * Math.pow(s, args.upperBinId - args.anchorBinId);
  return { pa: pa > 0 ? pa : 1, pb: pb > 0 ? pb : 1 };
}

/**
 * Correct DLMM/CLMM position valuation (NOT the V2 full-range curve).
 *
 * A DLMM position spanning bins [lower, upper] behaves as a concentrated
 * liquidity position over the price range [P_a, P_b]. Given the deposited USD
 * value split 50/50 at the anchor price, this returns the position's
 * mark-to-market value at P1 and the HODL benchmark value (the same capital
 * never deposited), so IL = 1 − V_LP/V_HODL.
 *
 * Piecewise (a=√P_a, b=√P_b, s=√P1):
 *   P1 ≤ P_a : x = L(1/a − 1/b),           y = 0
 *   P_a<P1<P_b: x = L(1/s − 1/b),           y = L(s − a)
 *   P1 ≥ P_b : x = 0,                       y = L(b − a)
 *   V_LP = x·P1 + y
 *   V_HODL = X0·P1 + Y0   (X0,Y0 = initial 50/50 amounts)
 *
 * Crucially this does NOT stop growing once price exits the range: when P1>P_b
 * the position is fully in token1 (V_LP flat) while V_HODL keeps appreciating,
 * so IL grows without bound — the exact behavior the V2 2√r/(1+r) curve
 * wrongly asymptotes away.
 */
export function clmmPositionValue(args: {
  sizeUsd: number;
  anchorPrice: number;
  anchorBinId: number;
  currentPrice: number;
  lowerBinId: number;
  upperBinId: number;
  binStep: number;
}): PositionValue {
  const { pa, pb } = binRangePrices(args);
  const p0 = args.anchorPrice;
  const p1 = args.currentPrice;
  if (!(p0 > 0) || !(p1 > 0) || !(pb > pa)) {
    return { lpValueUsd: args.sizeUsd, hodlValueUsd: args.sizeUsd };
  }
  // 50/50 deposit at anchor: X tokens and Y tokens.
  const x0 = args.sizeUsd / 2 / p0;
  const y0 = args.sizeUsd / 2;
  const a = Math.sqrt(pa);
  const b = Math.sqrt(pb);
  // Liquidity L is a CONSTANT of the position, fixed at deposit: it is
  // recovered from the X leg at the ANCHOR price p0, never the live price.
  // Deriving it from the live price while reusing the initial x0 is a bug — it
  // inflates in-range LP value and overstates downside IL by an order of
  // magnitude.
  const s0 = Math.sqrt(p0);
  const L = x0 / (1 / s0 - 1 / b) || 0;
  if (!(L > 0)) return { lpValueUsd: args.sizeUsd, hodlValueUsd: x0 * p1 + y0 };
  const sp = Math.sqrt(p1);
  let x: number;
  let y: number;
  if (p1 <= pa) {
    x = L * (1 / a - 1 / b);
    y = 0;
  } else if (p1 >= pb) {
    x = 0;
    y = L * (b - a);
  } else {
    x = L * (1 / sp - 1 / b);
    y = L * (sp - a);
  }
  const lpValueUsd = x * p1 + y;
  const hodlValueUsd = x0 * p1 + y0;
  return { lpValueUsd, hodlValueUsd };
}
// ─── CLI parsing ─────────────────────────────────────────────────────────────

interface CliArgs {
  days: number;
  pools: ReadonlyArray<string>;
  source: "synthetic" | "replay";
  dbPath: string;
  seed?: number;
  seeds?: ReadonlyArray<number>;
  entryCostBps: number;
  exitCostBps: number;
  fixedActionCostUsd: number;
  feeShareDilutionRefWidth?: number;
}

export const MAX_SYNTHETIC_SWEEP_SEEDS = 32;
const MAX_EXECUTION_COST_BPS = 10_000;
const MAX_FIXED_ACTION_COST_USD = 100_000;

function parseUnsignedSeed(value: string, flag: "--seed" | "--seeds"): number {
  const parsed = Number(value);
  if (!value.trim() || !Number.isInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
    throw new Error(`Invalid ${flag} value: ${value}. Must be an unsigned 32-bit integer.`);
  }
  return parsed;
}

function parseBoundedNonnegative(
  value: string | undefined,
  flag: string,
  max: number,
  unit: string,
): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  if (!value?.trim() || !Number.isFinite(parsed) || parsed < 0 || parsed > max) {
    throw new Error(
      `Invalid ${flag} value: ${value ?? ""}. Must be finite, nonnegative, and at most ${max} ${unit}.`,
    );
  }
  return parsed;
}

export function parseSeedList(value: string): number[] {
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => part.length === 0)) {
    throw new Error(
      "Invalid --seeds value: expected a comma-separated list of unsigned 32-bit integers.",
    );
  }
  if (parts.length > MAX_SYNTHETIC_SWEEP_SEEDS) {
    throw new Error(
      `Invalid --seeds value: at most ${MAX_SYNTHETIC_SWEEP_SEEDS} seeds are allowed per sweep.`,
    );
  }

  const seeds = parts.map((part) => parseUnsignedSeed(part, "--seeds"));
  if (new Set(seeds).size !== seeds.length) {
    throw new Error("Invalid --seeds value: duplicate seeds are not allowed.");
  }
  return seeds;
}

function parseDays(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 3650) {
    throw new Error(`Invalid --days value: ${value}. Must be a finite number between 1 and 3650.`);
  }
  return parsed;
}

function splitPoolList(value: string): ReadonlyArray<string> {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The four bounded-cost flags share this value-presence guard and message. */
function requireCostValue(next: string | undefined, flag: string): string {
  if (!next || next.startsWith("--")) {
    throw new Error(`Invalid ${flag} value: expected a finite nonnegative number.`);
  }
  return next;
}

/** Consume-count handler for one CLI flag; returns 0 when the flag did not match. */
type ArgHandler = (out: CliArgs, next: string | undefined) => number;

/** Owner contract: every backtest CLI flag maps to exactly one handler. */
interface ArgHandlerTable {
  [flag: string]: ArgHandler;
}

const ARG_HANDLERS: ArgHandlerTable = {
  "--days": (out, next) => {
    if (!next) return 0;
    out.days = parseDays(next);
    return 1;
  },
  "--pools": (out, next) => {
    if (!next) return 0;
    out.pools = splitPoolList(next);
    return 1;
  },
  "--source": (out, next) => {
    if (next !== "synthetic" && next !== "replay") return 0;
    out.source = next;
    return 1;
  },
  "--db": (out, next) => {
    if (!next) return 0;
    out.dbPath = next;
    return 1;
  },
  "--seed": (out, next) => {
    if (!next) return 0;
    if (out.seeds !== undefined) {
      throw new Error("The --seed and --seeds options are mutually exclusive.");
    }
    out.seed = parseUnsignedSeed(next, "--seed");
    return 1;
  },
  "--seeds": (out, next) => {
    if (!next || next.startsWith("--")) {
      throw new Error(
        "Invalid --seeds value: expected a comma-separated list of unsigned 32-bit integers.",
      );
    }
    if (out.seed !== undefined) {
      throw new Error("The --seed and --seeds options are mutually exclusive.");
    }
    out.seeds = parseSeedList(next);
    return 1;
  },
  "--entry-cost-bps": (out, next) => {
    out.entryCostBps = parseBoundedNonnegative(
      requireCostValue(next, "--entry-cost-bps"),
      "--entry-cost-bps",
      MAX_EXECUTION_COST_BPS,
      "bps",
    );
    return 1;
  },
  "--exit-cost-bps": (out, next) => {
    out.exitCostBps = parseBoundedNonnegative(
      requireCostValue(next, "--exit-cost-bps"),
      "--exit-cost-bps",
      MAX_EXECUTION_COST_BPS,
      "bps",
    );
    return 1;
  },
  "--fixed-action-cost-usd": (out, next) => {
    out.fixedActionCostUsd = parseBoundedNonnegative(
      requireCostValue(next, "--fixed-action-cost-usd"),
      "--fixed-action-cost-usd",
      MAX_FIXED_ACTION_COST_USD,
      "USD",
    );
    return 1;
  },
  "--fee-share-ref-width": (out, next) => {
    out.feeShareDilutionRefWidth = parseBoundedNonnegative(
      requireCostValue(next, "--fee-share-ref-width"),
      "--fee-share-ref-width",
      10_000,
      "bins",
    );
    return 1;
  },
};

export function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const out: CliArgs = {
    days: 7,
    pools: ["5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6"],
    source: "synthetic",
    dbPath: "./prism.db",
    entryCostBps: 0,
    exitCostBps: 0,
    fixedActionCostUsd: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== undefined && Object.hasOwn(ARG_HANDLERS, flag)) {
      i += ARG_HANDLERS[flag]!(out, argv[i + 1]);
    }
  }
  if (out.seeds !== undefined && out.source !== "synthetic") {
    throw new Error("The --seeds option is only supported with the synthetic source.");
  }
  return out;
}

/** Small deterministic PRNG for repeatable synthetic research runs. */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// ─── Synthetic data (regression baseline) ────────────────────────────────────

function summarizeCounts(
  rec: Readonly<Record<string, number>> | undefined,
  fmt: (v: number) => string = (v) => `${v}`,
): string {
  if (!rec) return "-";
  const entries = Object.entries(rec);
  if (entries.length === 0) return "-";
  return entries.map(([k, v]) => `${k}:${fmt(v)}`).join(" ");
}

interface HistoryTick {
  pool: PoolState;
  binArray: BinArray;
}

/**
 * Synthetic history is a STRESS TEST, not a realistic market:
 * - TVL changes by roughly ±1% per tick, so it is time-varying but still
 *   quasi-constant; TVL-dependent gates see almost no sustained drain.
 * - Every bin's liquiditySupply is random BigInt (all >0), so binUtil is always
 *   1.0; the binUtil pre-filter can never reject synthetic ticks. Together these
 *   make reported win rates / Sharpe a lower-bound stress-test only.
 * - Randomness is intentionally unseeded, so repeated synthetic runs are not
 *   reproducible. Use replay for repeatable analysis of captured snapshots.
 */
export function generateMockHistory(
  poolAddress: string,
  days: number,
  startTvl: number,
  random: () => number = Math.random,
  endMs: number = Date.now(),
): HistoryTick[] {
  const history: HistoryTick[] = [];
  const intervalMs = 10 * 60 * 1000; // 10 min
  const ticks = (days * 24 * 60 * 60 * 1000) / intervalMs;

  let tvl = startTvl;
  let price = 100;
  let activeBin = 5000;
  let trend = 0;
  let volatility = 0.015;

  for (let i = 0; i < ticks; i++) {
    const timestamp = endMs - (ticks - i) * intervalMs;

    if (i % 720 === 0) {
      volatility = 0.005 + random() * 0.025;
      trend = (random() - 0.5) * 0.004;
    }

    if (random() < 0.02) {
      const jump = (random() - 0.5) * 0.08;
      price *= 1 + jump;
      activeBin += Math.floor(jump * 200);
    }

    const shock = (random() - 0.5) * volatility * 2;
    tvl *= 1 + (random() - 0.49) * 0.02;
    price *= 1 + trend + shock;
    activeBin += Math.floor(trend * 200 + shock * 100 + (random() - 0.5) * 10);

    const pool: PoolState = {
      address: poolAddress,
      tokenX: "So11111111111111111111111111111111111111112",
      tokenY: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      tokenXSymbol: "SOL",
      tokenYSymbol: "USDC",
      tvlUsd: Math.max(tvl, 1000),
      volume24hUsd: tvl * (0.3 + random() * 0.5),
      fees24hUsd: tvl * 0.003 * (0.5 + random() * 0.5),
      apr: 40 + random() * 80,
      activeBinId: activeBin,
      binStep: 10,
      currentPrice: price,
      timestamp,
      // Synthetic ticks FABRICATE volume/fees, so they are explicitly classified
      // as the fabricated source — NOT datapi. This keeps the measured-fee-rate
      // authenticity check DISABLED here, exactly as the trust model intends for
      // a source-less pool (unknown != datapi).
      statsSource: "heuristic",
    };

    const bins = Array.from({ length: 40 }, (_, j) => ({
      binId: activeBin - 20 + j,
      price: price * (1 + (j - 20) * 0.001),
      reserveX: BigInt(Math.floor(random() * 1e9)),
      reserveY: BigInt(Math.floor(random() * 1e9)),
      liquiditySupply: BigInt(Math.floor(random() * 1e12)),
    }));

    const binArray: BinArray = {
      lowerBinId: activeBin - 20,
      upperBinId: activeBin + 20,
      bins,
      activeBinId: activeBin,
    };

    history.push({ pool, binArray });
  }

  return history;
}

// ─── Snapshot loading (replay source) ─────────────────────────────────────────

async function loadSnapshots(
  dbPath: string,
  pool: string,
  endMs: number,
  days: number,
): Promise<ReadonlyArray<PoolSnapshot>> {
  const layer = DbLive(dbPath);
  const startMs = endMs - days * 24 * 60 * 60 * 1000;
  const effect = Effect.gen(function* () {
    const db = yield* DbService;
    return yield* db.getSnapshots(pool, startMs, endMs);
  });
  try {
    return await Effect.runPromise(Effect.provide(effect, layer));
  } catch (err) {
    log.error("Failed to load snapshots", {
      pool,
      dbPath,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// ─── Strategy params + run loop (shared by both sources) ─────────────────────

export interface BacktestConfig {
  halfWidth: number;
  driftThreshold: number;
  minHoldTicks: number;
  minNetBenefitUsd: number;
  maxRebalances: number;
  maxPositionsPerPool: number;
  /** Optional round-trip execution costs; omitted values preserve zero-cost behavior. */
  entryCostBps?: number;
  exitCostBps?: number;
  fixedActionCostUsd?: number;
  /**
   * Price-coverage floor for the entry range half-width (percent each side),
   * mirroring the engine's MIN_RANGE_HALF_WIDTH_PCT. When > 0, the effective
   * half-width is max(halfWidth, halfWidthForPriceCoveragePct(binStep, pct)) —
   * so a fine-binStep pool (SOL/USDC binStep 4) is never stuck at ±1% price
   * coverage no matter how the fixed bin-count halfWidth is set. 0 = off
   * (fixed bin-count behavior). Lets the backtest prove out whether a
   * price-coverage floor actually curbs the out-of-range IL bleed.
   */
  minPriceCoveragePct?: number;
  /**
   * When a snapshot's bin array is empty, bin utilization is UNKNOWN (not 0).
   * Default true: the pre-filter skips the bin-util requirement so the replay
   * admits (paper DB stores bins:[] for every row). False degrades the unknown
   * to 0 and rejects exactly as before — parity with the pre-fix replay.
   */
  backtestTolerateEmptyBins?: boolean;
  /**
   * IL-dominance fast EXIT (W15 seam), mirroring the live engine's
   * IL_PROTECTION_ENABLED=true default. When on, an out-of-range position exits
   * as soon as its range-aware IL (HODL − LP value) exceeds cumulative fees ×
   * factor and the USD floor — capping the unbounded out-of-range IL bleed.
   */
  ilProtectionEnabled?: boolean;
  ilDominanceExitFactor?: number;
  ilDominanceMinUsd?: number;
  /**
   * Concentration-aware fee share. The default fee model returns a
   * width-independent share (position size ÷ pool TVL) whenever the range is
   * in-range — a real DLMM position that spreads its liquidity over many bins
   * captures a SMALLER fraction of active-bin fees per dollar. When this is set
   * to the baseline (narrow) half-width, the per-tick share is scaled by
   * min(1, refWidth ÷ effectiveWidth), so a range diluted k× captures ~1/k of
   * the fee income the width-independent model assigns. Puts a conservative
   * floor on the fee side of any range-widening profitability claim.
   */
  feeShareDilutionRefWidth?: number;
}

export interface NamedBacktestResult {
  readonly name: string;
  readonly result: BacktestResult;
}

export interface SeededBacktestResult extends NamedBacktestResult {
  readonly seed: number;
}

export interface BacktestSweepAggregate {
  readonly name: string;
  readonly seedCount: number;
  readonly meanNetPnlUsd: number;
  readonly netPnlStdDevUsd: number;
  readonly minNetPnlUsd: number;
  readonly maxNetPnlUsd: number;
  readonly meanWinRate: number;
  readonly winRateStdDev: number;
  readonly minWinRate: number;
  readonly maxWinRate: number;
  readonly profitableRuns: number;
}

function mean(values: ReadonlyArray<number>): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function populationStdDev(values: ReadonlyArray<number>, average: number): number {
  const variance = mean(values.map((value) => (value - average) ** 2));
  return Math.sqrt(Math.max(variance, 0));
}

/** Aggregate deterministic synthetic runs by configuration. */
export function aggregateBacktestResults(
  results: ReadonlyArray<SeededBacktestResult>,
): BacktestSweepAggregate[] {
  const byConfig = new Map<string, SeededBacktestResult[]>();
  for (const result of results) {
    const group = byConfig.get(result.name) ?? [];
    group.push(result);
    byConfig.set(result.name, group);
  }

  return [...byConfig.entries()].map(([name, group]) => {
    const netPnl = group.map(({ result }) => result.netPnlUsd);
    const winRates = group.map(({ result }) => result.winRate);
    const meanNetPnlUsd = mean(netPnl);
    const meanWinRate = mean(winRates);
    return {
      name,
      seedCount: group.length,
      meanNetPnlUsd,
      netPnlStdDevUsd: populationStdDev(netPnl, meanNetPnlUsd),
      minNetPnlUsd: Math.min(...netPnl),
      maxNetPnlUsd: Math.max(...netPnl),
      meanWinRate,
      winRateStdDev: populationStdDev(winRates, meanWinRate),
      minWinRate: Math.min(...winRates),
      maxWinRate: Math.max(...winRates),
      profitableRuns: netPnl.filter((value) => value > 0).length,
    };
  });
}

function descendingMetric(value: number): number {
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function ascendingMetric(value: number): number {
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

/**
 * Rank configurations by economic outcome first. The remaining metrics only
 * break exact net-PnL ties, and the name makes the result stable even when all
 * numeric metrics are equal.
 */
export function rankBacktestResults(
  results: ReadonlyArray<NamedBacktestResult>,
): NamedBacktestResult[] {
  return [...results].sort((a, b) => {
    const netPnl = descendingMetric(b.result.netPnlUsd) - descendingMetric(a.result.netPnlUsd);
    if (netPnl !== 0) return netPnl;

    const winRate = descendingMetric(b.result.winRate) - descendingMetric(a.result.winRate);
    if (winRate !== 0) return winRate;

    const sharpe = descendingMetric(b.result.sharpeRatio) - descendingMetric(a.result.sharpeRatio);
    if (sharpe !== 0) return sharpe;

    const il = ascendingMetric(a.result.totalIlUsd) - ascendingMetric(b.result.totalIlUsd);
    if (il !== 0) return il;

    const rebalances = a.result.totalRebalances - b.result.totalRebalances;
    if (rebalances !== 0) return rebalances;

    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

/** Detect data frequency for Sharpe annualization: first positive adjacent
 *  timestamp diff (duplicate/out-of-order timestamps guarded); 10-minute
 *  default when none is found. */
function inferTickIntervalMs(ticks: ReadonlyArray<HistoryTick>): number {
  for (let i = 1; i < ticks.length; i++) {
    const diff = ticks[i]!.pool.timestamp - ticks[i - 1]!.pool.timestamp;
    if (diff > 0) return diff;
  }
  return 10 * 60 * 1000;
}

/** Price-coverage floor (MIN_RANGE_HALF_WIDTH_PCT): when set, the effective
 *  half-width is never narrower than the bins needed to span that percent of
 *  price each side on this pool's binStep. For a fine-binStep pool (SOL/USDC
 *  binStep 4) this lifts a fixed halfWidth of 25 (~±1%) up to a range that
 *  actually holds the price path, curbing out-of-range IL. 0 = fixed bin-count. */
function resolveEffectiveHalfWidth(binStep: number, cfg: BacktestConfig): number {
  if (cfg.minPriceCoveragePct === undefined || cfg.minPriceCoveragePct <= 0) {
    return cfg.halfWidth;
  }
  return Math.max(cfg.halfWidth, halfWidthForPriceCoveragePct(binStep, cfg.minPriceCoveragePct));
}

/** Guard the replay kernel against an empty tick strip. */
function requireNonEmptyTicks(tickCount: number): void {
  if (tickCount === 0) {
    throw new Error("Empty history");
  }
}

/** Opening anchor for range-aware IL marking: price and bin of the first tick. */
function initialReferencePoint(ticks: ReadonlyArray<HistoryTick>): readonly [number, number] {
  return [ticks[0]?.pool.currentPrice ?? 1, ticks[0]?.pool.activeBinId ?? 0];
}

/** Whether an active bin sits inside a [lower, upper] position range. */
function isBinInRange(activeBinId: number, lowerBinId: number, upperBinId: number): boolean {
  return activeBinId >= lowerBinId && activeBinId <= upperBinId;
}

/** Append one tick's normalized portfolio return to the Sharpe series. */
function appendTickReturn(returns: number[], prevValue: number, nextValue: number): void {
  returns.push(prevValue > 0 ? (nextValue - prevValue) / prevValue : 0);
}

/** Annualized Sharpe of the replay return series (population std-dev). */
function computeSharpeRatio(returns: ReadonlyArray<number>, ticksPerYear: number): number {
  const avg = mean(returns);
  const std = populationStdDev(returns, avg);
  return std > 0 ? (avg / std) * Math.sqrt(ticksPerYear) : 0;
}

/** Per-exit-reason win-rate and hold-time summaries. */
interface ExitReasonSummaries {
  readonly winrateByExitReason: Record<string, number>;
  readonly avgHoldHoursByExitReason: Record<string, number>;
}

/** Collapse the exit census into per-reason win rates and hold times. */
function summarizeExitStats(
  exitCounts: Record<string, number>,
  exitWins: Record<string, number>,
  exitHoldHours: Record<string, number[]>,
): ExitReasonSummaries {
  const winrateByExitReason: Record<string, number> = {};
  const avgHoldHoursByExitReason: Record<string, number> = {};
  for (const reason of Object.keys(exitCounts)) {
    winrateByExitReason[reason] = (exitWins[reason] ?? 0) / exitCounts[reason]!;
    const hours = exitHoldHours[reason] ?? [];
    avgHoldHoursByExitReason[reason] =
      hours.length > 0 ? hours.reduce((a, b) => a + b, 0) / hours.length : 0;
  }
  return { winrateByExitReason, avgHoldHoursByExitReason };
}

/** EXIT notional: the live position value, or the deployed size when unknown. */
function resolveExitNotional(currentValueUsd: number | undefined, positionSizeUsd: number): number {
  return currentValueUsd ?? positionSizeUsd;
}

/** HOLD bookkeeping: ratchet the position peak to the live value. */
function trackPositionPeak(peakUsd: number, currentValueUsd: number | undefined): number {
  return Math.max(peakUsd, currentValueUsd ?? 0);
}

/** Census tag for an EXIT: the IL-dominance fast exit versus trailing stop. */
function exitReasonTag(isIlDominance: boolean): string {
  return isIlDominance ? "il-dominance" : "trailing-stop";
}

/** Half of a symmetric bin range, never zero so drift stays finite. */
function positionHalfWidthOf(lowerBinId: number, upperBinId: number): number {
  return (upperBinId - lowerBinId) / 2 || 1;
}

/** Economic-rebalance gate: held long enough and drifted past the threshold. */
function shouldRebalancePosition(
  hasPosition: boolean,
  rebalances: number,
  maxRebalances: number,
  tickIndex: number,
  lastRebalanceTick: number,
  minHoldTicks: number,
  binDrift: number,
  driftThreshold: number,
): boolean {
  return (
    hasPosition &&
    rebalances < maxRebalances &&
    tickIndex - lastRebalanceTick >= minHoldTicks &&
    binDrift > driftThreshold
  );
}

/** In-range fees the new range would earn over the coming hold window. */
function sumFeesInNextWindow(
  ticks: ReadonlyArray<HistoryTick>,
  tickIndex: number,
  minHoldTicks: number,
  lowerBinId: number,
  upperBinId: number,
  feeForTick: (tickIndex: number) => number,
): number {
  let fees = 0;
  const end = Math.min(tickIndex + minHoldTicks, ticks.length);
  for (let j = tickIndex + 1; j < end; j++) {
    if (isBinInRange(ticks[j]!.pool.activeBinId, lowerBinId, upperBinId)) {
      fees += feeForTick(j);
    }
  }
  return fees;
}

/** Drift-exit gate: the active bin has left the position range. */
function shouldExitOnDrift(binDrift: number, hasPosition: boolean): boolean {
  return binDrift > 0.9 && hasPosition;
}

/** Calm-pool re-entry gate: flat after an exit and the drift has settled. */
function shouldReenterAfterDrift(hasPosition: boolean, binDrift: number): boolean {
  return !hasPosition && binDrift < 0.3;
}

export function runBacktestFromTicks(
  ticks: ReadonlyArray<HistoryTick>,
  cfg: BacktestConfig,
): BacktestResult {
  const strategy = DLMMStrategy;
  const initialValue = 10_000;
  let portfolioValue = initialValue;
  let rebalances = 0;
  let wins = 0;
  let totalFees = 0;
  let totalIl = 0;

  requireNonEmptyTicks(ticks.length);

  const tickIntervalMs = inferTickIntervalMs(ticks);
  const ticksPerYear = (365 * 24 * 60 * 60 * 1000) / tickIntervalMs;

  const effectiveHalfWidth = resolveEffectiveHalfWidth(ticks[0]!.pool.binStep, cfg);

  let previousTvl = ticks[0]!.pool.tvlUsd;
  let currentLowerBinId = ticks[0]!.pool.activeBinId - effectiveHalfWidth;
  let currentUpperBinId = ticks[0]!.pool.activeBinId + effectiveHalfWidth;
  let hasPosition = false;
  let positionSizeUsd = 0;
  let positionPeakUsd = 0;
  let lastRebalanceTick = -cfg.minHoldTicks;

  // ── Admit/reject census + exit stats (backtest fidelity telemetry) ────────
  // enterAttempts === admitted + sum(rejectionsByReason): every no-position
  // tick is exactly one of {pre-filter reject, risk reject, admit}.
  let enterAttempts = 0;
  let admitted = 0;
  const rejections: Record<string, number> = {};
  const exitCounts: Record<string, number> = {};
  const exitWins: Record<string, number> = {};
  const exitHoldHours: Record<string, number[]> = {};
  let entryTimestamp = 0;
  let entryDepositedUsd = 0;
  let positionFeesUsd = 0;
  let [referencePrice, referenceBinId] = initialReferencePoint(ticks);
  let emptyBinBypassNoted = false;

  // Rejected tick: flatten the return and advance the TVL baseline.
  function skipTick(tick: HistoryTick): void {
    previousTvl = tick.pool.tvlUsd;
    strategyReturns.push(0);
  }

  // Admit/reject census: every no-position tick is exactly one of
  // {pre-filter reject, risk reject, admit}; enterAttempts never counts
  // ticks while a position is held.
  function recordRejection(tag: string): void {
    if (hasPosition) return;
    enterAttempts++;
    rejections[tag] = (rejections[tag] ?? 0) + 1;
  }

  function recordExit(reason: string, atTick: number, realizedValueUsd: number): void {
    exitCounts[reason] = (exitCounts[reason] ?? 0) + 1;
    // A win = the hold realized (position value at exit + fees earned during
    // the hold) at least the deposited amount.
    if (realizedValueUsd >= entryDepositedUsd) exitWins[reason] = (exitWins[reason] ?? 0) + 1;
    const holdHours =
      entryTimestamp > 0 ? (ticks[atTick]!.pool.timestamp - entryTimestamp) / 3_600_000 : 0;
    (exitHoldHours[reason] ??= []).push(Math.max(0, holdHours));
    entryTimestamp = 0;
    entryDepositedUsd = 0;
    positionFeesUsd = 0;
  }

  function executionCostUsd(notionalUsd: number, costBps: number | undefined): number {
    const rateBps = costBps !== undefined && Number.isFinite(costBps) && costBps >= 0 ? costBps : 0;
    const fixedCost =
      cfg.fixedActionCostUsd !== undefined &&
      Number.isFinite(cfg.fixedActionCostUsd) &&
      cfg.fixedActionCostUsd >= 0
        ? cfg.fixedActionCostUsd
        : 0;
    return Math.max(0, notionalUsd) * (rateBps / 10_000) + fixedCost;
  }

  const strategyReturns: number[] = [0];
  let prevPortfolioValue = initialValue;

  // Pre-filter evaluation for one tick: bin-util unknown handling (empty-bin
  // tolerance) plus the strategy gate. Returns the rejection tag or null.
  function evaluateTickPreFilter(
    tick: HistoryTick,
    metrics: ReturnType<typeof strategy.computeMetrics>,
    auth: ReturnType<typeof strategy.checkVolumeAuthenticity>,
  ): string | null {
    // Empty bin array => bin utilization is UNKNOWN, not 0. The paper DB stores
    // bins:[] for every snapshot row, so treating it as 0 rejects every tick
    // and the replay measures nothing. Tolerate by default (mirrors the live
    // "unknown metrics skip their gate" rule); with tolerance OFF the unknown
    // degrades to 0 and the gate rejects exactly as the pre-fix replay did.
    const binsEmpty = tick.binArray.bins.length === 0;
    const tolerateEmptyBins = cfg.backtestTolerateEmptyBins ?? true;
    const binUtilKnown = binsEmpty ? !tolerateEmptyBins : metrics.binUtilizationKnown;
    if (binsEmpty && tolerateEmptyBins && !emptyBinBypassNoted) {
      emptyBinBypassNoted = true;
      log.debug(
        "Empty bin array — bin utilization UNKNOWN, skipping the bin-util pre-filter gate",
        { pool: tick.pool.address, timestamp: tick.pool.timestamp },
      );
    }
    const preFilterPass = strategy.passesPreFilter(
      tick.pool,
      auth.score,
      metrics.binUtilization,
      50_000,
      0.7,
      0.3,
      // Mirror the live call: unknown metrics skip their gate instead of
      // auto-failing on a fabricated 0 (metrics.volumeAuthenticityKnown).
      metrics.volumeAuthenticityKnown,
      binUtilKnown,
    );
    if (preFilterPass) return null;
    // Tag the rejection so the census can separate data-quality gates
    // (branch order mirrors passesPreFilter's && chain).
    return tick.pool.tvlUsd < 50_000
      ? "[tvl-gate]"
      : metrics.volumeAuthenticityKnown && auth.score < 0.7
        ? "[auth-gate]"
        : "[bin-util-gate]";
  }

  // Helper: compute position's share of pool fees for this tick.
  // fees24hUsd is a 24h aggregate; scale it by the actual elapsed time since
  // the preceding snapshot, then apply the position share of pool TVL.
  function feesForTick(tickIndex: number): number {
    const tick = ticks[tickIndex]!;
    const tvl = tick.pool.tvlUsd;
    if (tvl <= 0) return 0;
    const elapsedMs =
      tickIndex > 0 ? ticks[tickIndex]!.pool.timestamp - ticks[tickIndex - 1]!.pool.timestamp : 0;
    const intervalMs = elapsedMs > 0 ? elapsedMs : tickIntervalMs;
    const ticksPerYearForInterval = (365 * 24 * 60 * 60 * 1000) / intervalMs;
    // Fee share is the deployed position size, not the whole portfolio; fall
    // back to the portfolio value when no position size is recorded yet.
    const size = positionSizeUsd > 0 ? positionSizeUsd : portfolioValue;
    const positionShare = Math.min(size / tvl, 1);
    // Concentration-aware dilution: a position spread over `effectiveHalfWidth`
    // bins captures ~(refWidth ÷ effectiveWidth) of the fee income the
    // width-independent model assigns, because the same capital is thinned
    // across more bins and only bins near the active market earn fees. Only
    // applies when the caller opts in with a (narrow) reference width.
    const dilution =
      cfg.feeShareDilutionRefWidth && cfg.feeShareDilutionRefWidth > 0 && effectiveHalfWidth > 0
        ? Math.min(1, cfg.feeShareDilutionRefWidth / effectiveHalfWidth)
        : 1;
    return (tick.pool.fees24hUsd / ticksPerYearForInterval) * 365 * positionShare * dilution;
  }

  // In-range fee accrual for the tick: portfolio + held-position fees.
  function accrueFees(tickIndex: number, inRange: boolean): number {
    const feesThisTick = hasPosition && inRange ? feesForTick(tickIndex) : 0;
    totalFees += feesThisTick;
    portfolioValue += feesThisTick;
    if (hasPosition) positionFeesUsd += feesThisTick;
    return feesThisTick;
  }

  // Mark the open position to the current DLMM value (correct range-aware IL,
  // includes token depreciation — NOT a flat floor). Falls back to full size
  // when the anchor is unknown.
  function markPositionValue(tick: HistoryTick): number {
    return clmmPositionValue({
      sizeUsd: positionSizeUsd,
      anchorPrice: referencePrice,
      anchorBinId: referenceBinId,
      currentPrice: tick.pool.currentPrice,
      lowerBinId: currentLowerBinId,
      upperBinId: currentUpperBinId,
      binStep: tick.pool.binStep,
    }).lpValueUsd;
  }

  // Build the replay kernel's view of the open position: range-aware CLMM
  // valuation (LP value + the HODL benchmark buried in the same model) so the
  // IL-dominance fast EXIT can mark real IL. Undefined when no position.
  function buildReplayPosition(tick: HistoryTick, inRange: boolean) {
    if (!hasPosition) return undefined;
    const val = clmmPositionValue({
      sizeUsd: positionSizeUsd,
      anchorPrice: referencePrice,
      anchorBinId: referenceBinId,
      currentPrice: tick.pool.currentPrice,
      lowerBinId: currentLowerBinId,
      upperBinId: currentUpperBinId,
      binStep: tick.pool.binStep,
    });
    return {
      poolAddress: tick.pool.address,
      positionPubKey: `replay-${tick.pool.address}`,
      lowerBinId: currentLowerBinId,
      upperBinId: currentUpperBinId,
      depositedUsd: positionSizeUsd,
      currentValueUsd: val.lpValueUsd,
      highestValueUsd: positionPeakUsd,
      // IL-dominance inputs (the live engine's W15 seam): the position is
      // OOR once the active bin leaves the range, HODL comes from the same
      // CLMM model, and fees accrued reflect what fees would dominate.
      outOfRange: !inRange,
      hodlValueUsd: val.hodlValueUsd,
      cumulativeFeesClaimedUsd: positionFeesUsd,
    };
  }

  // Feed one tick through the shared decision/risk kernel.
  function runReplayKernel(
    tick: HistoryTick,
    metrics: ReturnType<typeof strategy.computeMetrics>,
    replayPosition: ReturnType<typeof buildReplayPosition>,
    portfolioValueUsd: number,
  ) {
    return evaluateReplayPool({
      poolAddress: tick.pool.address,
      activeBinId: tick.pool.activeBinId,
      metrics,
      position: replayPosition,
      openPositions: replayPosition ? [replayPosition] : [],
      portfolioValueUsd,
      recentPnlUsd: portfolioValueUsd - initialValue,
      memoryWarningCount: 0,
      confidenceThreshold: 0.65,
      trailingStopPct: 0.1,
      risk: {
        confidenceThreshold: 0.65,
        maxRebalanceRangeBins: effectiveHalfWidth * 2,
        stopLossPct: 0.15,
        maxPerPoolAllocationPct: 0.4,
        maxPositionsPerPool: cfg.maxPositionsPerPool,
      },
      proposedSizeUsd: Math.min(portfolioValueUsd * 0.2, 2_000),
      ilProtectionEnabled: cfg.ilProtectionEnabled ?? true,
      ilDominanceExitFactor: cfg.ilDominanceExitFactor ?? 2,
      ilDominanceMinUsd: cfg.ilDominanceMinUsd ?? 5,
    });
  }

  for (let i = 0; i < ticks.length; i++) {
    const tick = ticks[i]!;
    const metrics = strategy.computeMetrics(tick.pool, tick.binArray, previousTvl);
    // Match computeMetrics' wiring so this standalone auth score stays consistent
    // with metrics.volumeAuthenticity: fees are measured only under the Data API.
    const auth = strategy.checkVolumeAuthenticity(tick.pool, tick.pool.statsSource === "datapi");

    const rejectionTag = evaluateTickPreFilter(tick, metrics, auth);
    if (rejectionTag !== null) {
      recordRejection(rejectionTag);
      skipTick(tick);
      continue;
    }

    const inRange = isBinInRange(tick.pool.activeBinId, currentLowerBinId, currentUpperBinId);
    const feesThisTick = accrueFees(i, inRange);

    const replayPosition = buildReplayPosition(tick, inRange);
    const replay = runReplayKernel(tick, metrics, replayPosition, portfolioValue);
    if (!replay.riskApproved) {
      recordRejection(replay.rejectTag ?? "[risk-gate]");
      skipTick(tick);
      continue;
    }
    portfolioValue = applyReplayDecision(replay, replayPosition, tick, i, portfolioValue);

    portfolioValue = applyRebalanceDriftOrReenter(tick, i, feesThisTick, portfolioValue);

    previousTvl = tick.pool.tvlUsd;
    appendTickReturn(strategyReturns, prevPortfolioValue, portfolioValue);
    prevPortfolioValue = portfolioValue;
  }

  // Replay decision application: ENTER opens the position (paying the entry
  // cost), EXIT realizes it (the IL-dominance exit ALSO realizes the IL it
  // capped — mirroring the live engine, where closing an out-of-range
  // position converts its IL into a realized loss), HOLD tracks the peak.
  function applyReplayDecision(
    replay: ReturnType<typeof runReplayKernel>,
    replayPosition: ReturnType<typeof buildReplayPosition>,
    tick: HistoryTick,
    tickIndex: number,
    portfolioValueUsd: number,
  ): number {
    let value = portfolioValueUsd;
    if (replay.decision.action === "ENTER") {
      hasPosition = true;
      positionSizeUsd = replay.adjustedSizeUsd;
      positionPeakUsd = positionSizeUsd;
      const entryCostUsd = executionCostUsd(positionSizeUsd, cfg.entryCostBps);
      value -= entryCostUsd;
      admitted++;
      enterAttempts++;
      entryTimestamp = tick.pool.timestamp;
      entryDepositedUsd = positionSizeUsd + entryCostUsd;
      positionFeesUsd = 0;
      referencePrice = tick.pool.currentPrice;
      referenceBinId = tick.pool.activeBinId;
      return value;
    }
    if (replay.decision.action === "EXIT") {
      // The IL-dominance exit fires EARLIER than the trail stop, so it caps
      // the unbounded OOR bleed instead of waiting for a drawn-down breach.
      const isIlDominance = replay.decision.reasoning.startsWith("IL dominance");
      const realizedLoss =
        isIlDominance && replayPosition !== undefined
          ? Math.max(0, replayPosition.hodlValueUsd - replayPosition.currentValueUsd)
          : 0;
      const exitNotionalUsd = resolveExitNotional(replayPosition?.currentValueUsd, positionSizeUsd);
      const exitCostUsd = executionCostUsd(exitNotionalUsd, cfg.exitCostBps);
      totalIl += realizedLoss;
      value -= realizedLoss + exitCostUsd;
      recordExit(
        exitReasonTag(isIlDominance),
        tickIndex,
        exitNotionalUsd + positionFeesUsd - exitCostUsd,
      );
      hasPosition = false;
      positionSizeUsd = 0;
      positionPeakUsd = 0;
      return value;
    }
    if (hasPosition) {
      positionPeakUsd = trackPositionPeak(positionPeakUsd, replayPosition?.currentValueUsd);
    }
    return value;
  }

  // Post-decision drift handling: economic rebalance (IL + swap cost vs
  // expected fees), drift exit, or automatic re-entry on a calm pool.
  function applyRebalanceDriftOrReenter(
    tick: HistoryTick,
    tickIndex: number,
    feesThisTick: number,
    portfolioValueUsd: number,
  ): number {
    let value = portfolioValueUsd;
    const positionCenter = (currentLowerBinId + currentUpperBinId) / 2;
    const positionHalfWidth = positionHalfWidthOf(currentLowerBinId, currentUpperBinId);
    const binDrift = Math.abs(tick.pool.activeBinId - positionCenter) / positionHalfWidth;

    if (
      shouldRebalancePosition(
        hasPosition,
        rebalances,
        cfg.maxRebalances,
        tickIndex,
        lastRebalanceTick,
        cfg.minHoldTicks,
        binDrift,
        cfg.driftThreshold,
      )
    ) {
      // Real IL vs the HODL benchmark. The position is a concentrated DLMM
      // range: IL = V_HODL − V_LP, which grows UNBOUNDED once price exits the
      // range (LP stuck in one token while HODL keeps appreciating).
      const val = clmmPositionValue({
        sizeUsd: positionSizeUsd,
        anchorPrice: referencePrice,
        anchorBinId: referenceBinId,
        currentPrice: tick.pool.currentPrice,
        lowerBinId: currentLowerBinId,
        upperBinId: currentUpperBinId,
        binStep: tick.pool.binStep,
      });
      const ilCost = Math.max(0, val.hodlValueUsd - val.lpValueUsd);
      const swapCost = value * 0.0005;
      const totalCost = ilCost + swapCost;
      const expectedFeesAhead = feesThisTick * cfg.minHoldTicks * 0.7;
      const netBenefit = expectedFeesAhead - totalCost;

      if (netBenefit > cfg.minNetBenefitUsd) {
        rebalances++;
        totalIl += totalCost;
        value -= totalCost;
        currentLowerBinId = tick.pool.activeBinId - effectiveHalfWidth;
        currentUpperBinId = tick.pool.activeBinId + effectiveHalfWidth;
        referencePrice = tick.pool.currentPrice;
        referenceBinId = tick.pool.activeBinId;
        lastRebalanceTick = tickIndex;
        const feesInNextWindow = sumFeesInNextWindow(
          ticks,
          tickIndex,
          cfg.minHoldTicks,
          currentLowerBinId,
          currentUpperBinId,
          feesForTick,
        );
        if (feesInNextWindow > totalCost) wins++;
      }
      return value;
    }
    if (shouldExitOnDrift(binDrift, hasPosition)) {
      // Drift exit realizes the same range-aware IL vs HODL, plus a small exit
      // cost — apply it BEFORE classifying the win so an at-cost exit never
      // records as a win.
      const val = clmmPositionValue({
        sizeUsd: positionSizeUsd,
        anchorPrice: referencePrice,
        anchorBinId: referenceBinId,
        currentPrice: tick.pool.currentPrice,
        lowerBinId: currentLowerBinId,
        upperBinId: currentUpperBinId,
        binStep: tick.pool.binStep,
      });
      const driftIlUsd = Math.max(0, val.hodlValueUsd - val.lpValueUsd);
      const driftExitNotionalUsd = hasPosition ? markPositionValue(tick) : positionSizeUsd;
      const configuredExitCostUsd = executionCostUsd(driftExitNotionalUsd, cfg.exitCostBps);
      const existingDriftExitCostUsd = value * 0.0005;
      const driftExitRealizedUsd =
        driftExitNotionalUsd +
        positionFeesUsd -
        driftIlUsd -
        existingDriftExitCostUsd -
        configuredExitCostUsd;
      totalIl += driftIlUsd;
      value -= driftIlUsd + existingDriftExitCostUsd + configuredExitCostUsd;
      recordExit("drift", tickIndex, driftExitRealizedUsd);
      hasPosition = false;
      positionSizeUsd = 0;
      positionPeakUsd = 0;
      return value;
    }
    if (shouldReenterAfterDrift(hasPosition, binDrift)) {
      hasPosition = true;
      // Same proposed size the replay ENTER path uses, so position value and
      // fee accrual stay consistent after an automatic re-entry.
      positionSizeUsd = Math.min(value * 0.2, 2_000);
      positionPeakUsd = positionSizeUsd;
      currentLowerBinId = tick.pool.activeBinId - effectiveHalfWidth;
      currentUpperBinId = tick.pool.activeBinId + effectiveHalfWidth;
      lastRebalanceTick = tickIndex;
      // ponytail: unreachable while the replay ENTER admits every no-position
      // tick, but keep the census hold-trackers correct if that ever changes.
      entryTimestamp = tick.pool.timestamp;
      const entryCostUsd = executionCostUsd(positionSizeUsd, cfg.entryCostBps);
      value -= entryCostUsd;
      entryDepositedUsd = positionSizeUsd + entryCostUsd;
      positionFeesUsd = 0;
      referencePrice = tick.pool.currentPrice;
      referenceBinId = tick.pool.activeBinId;
    }
    return value;
  }

  const sharpe = computeSharpeRatio(strategyReturns, ticksPerYear);

  const { winrateByExitReason, avgHoldHoursByExitReason } = summarizeExitStats(
    exitCounts,
    exitWins,
    exitHoldHours,
  );

  return {
    poolAddress: ticks[0]!.pool.address,
    startDate: ticks[0]!.pool.timestamp,
    endDate: ticks[ticks.length - 1]!.pool.timestamp,
    initialValueUsd: initialValue,
    finalValueUsd: portfolioValue,
    totalFeesUsd: totalFees,
    totalIlUsd: totalIl,
    netPnlUsd: portfolioValue - initialValue,
    totalRebalances: rebalances,
    winRate: rebalances > 0 ? wins / rebalances : 0,
    sharpeRatio: sharpe,
    enterAttempts,
    admitted,
    rejectionsByReason: rejections,
    exitsByReason: exitCounts,
    winrateByExitReason,
    avgHoldHoursByExitReason,
  };
}

export function snapshotsToTicks(snaps: ReadonlyArray<PoolSnapshot>): HistoryTick[] {
  return snaps.map((s) => {
    const pool: PoolState = {
      address: s.poolAddress,
      tokenX: "",
      tokenY: "",
      tokenXSymbol: s.tokenXSymbol,
      tokenYSymbol: s.tokenYSymbol,
      tvlUsd: s.tvlUsd,
      volume24hUsd: s.volume24hUsd,
      fees24hUsd: s.fees24hUsd,
      apr: s.apr,
      activeBinId: s.activeBinId,
      binStep: s.binStep,
      currentPrice: s.currentPrice,
      timestamp: s.timestamp,
      // Restore the persisted provenance so replay keeps the live trust model: a
      // datapi snapshot replays gate-on, a source-less legacy row replays as the
      // conservative "heuristic" (gate off). Never leave the tick undefined.
      statsSource: s.statsSource ?? "heuristic",
    };
    return { pool, binArray: s.binArray };
  });
}

/** Owner type for one named sweep configuration. */
interface NamedBacktestConfig {
  readonly name: string;
  readonly cfg: BacktestConfig;
}

/** Static replay-limitation banner (source-independent half). */
function logReplayLimitations(): void {
  log.warn("═══════════════════════════════════════════════════════════════");
  log.warn("  BACKTEST LIMITATIONS — read before interpreting results");
  log.warn("═══════════════════════════════════════════════════════════════");
  log.warn("  • Replay and synthetic ticks use time-varying TVL values.");
  log.warn("    Synthetic TVL is only a quasi-constant random walk; it is not a");
  log.warn("    realistic liquidity-drain model. Replay reflects captured TVL.");
  log.warn("  • Replay uses the shared risk kernel for ENTER sizing, confidence,");
  log.warn("    allocation, and trailing-stop EXIT decisions.");
  log.warn("    Live-only effects remain unavailable: memory retrieval/persistence,");
  log.warn("    agent proposals, gas/recovery gates, and on-chain execution.");
  log.warn("  • Each pool runs independently with $10K. Total PnL is the");
  log.warn("    sum of 6 independent portfolios ($60K deployed, not $10K).");
}

/** Synthetic-source half of the banner; silent for replay runs. */
function logSyntheticLimitations(
  source: "synthetic" | "replay",
  seeds: ReadonlyArray<number> | undefined,
  seed: number | undefined,
): void {
  if (source !== "synthetic") return;
  log.warn("  • Synthetic TVL is quasi-constant (tvl *= 1±1% per tick) and");
  log.warn("    synthetic bins use random liquiditySupply so binUtil=1.0 always.");
  log.warn("    The binUtil gate never rejects; TVL-dependent gates see no real");
  log.warn("    drain. Results are a LOWER-BOUND STRESS TEST only — not a");
  log.warn("    realistic PnL / Sharpe / win-rate estimate.");
  if (seeds !== undefined) {
    log.warn(
      `    Synthetic randomness is deterministic across ${seeds.length} seeds: ${seeds.join(",")}.`,
    );
  } else if (seed === undefined) {
    log.warn("    Synthetic randomness is unseeded and therefore non-reproducible.");
  } else {
    log.warn(`    Synthetic randomness is deterministic with seed ${seed}.`);
  }
  log.warn("    See generateMockHistory comment for the synthetic model.");
}

/** Execution-cost line of the banner; silent at zero cost. */
function logExecutionCostWarning(
  entryCostBps: number,
  exitCostBps: number,
  fixedActionCostUsd: number,
): void {
  if (entryCostBps > 0 || exitCostBps > 0 || fixedActionCostUsd > 0) {
    log.warn(
      `  • Execution costs: entry=${entryCostBps}bps, exit=${exitCostBps}bps, ` +
        `fixed=${fixedActionCostUsd.toFixed(2)} USD/action.`,
    );
  }
}

/** Fee-dilution line of the banner; silent when the model is off. */
function logFeeDilutionWarning(feeShareDilutionRefWidth: number | undefined): void {
  if (feeShareDilutionRefWidth !== undefined && feeShareDilutionRefWidth > 0) {
    log.warn(
      `  • Fee-share dilution enabled with reference width ${feeShareDilutionRefWidth} bins.`,
    );
  }
}

/** One sweep config plus the run's execution-cost overrides. */
function withBacktestExecutionCosts(
  cfg: BacktestConfig,
  entryCostBps: number,
  exitCostBps: number,
  fixedActionCostUsd: number,
  feeShareDilutionRefWidth: number | undefined,
): BacktestConfig {
  if (feeShareDilutionRefWidth === undefined) {
    return { ...cfg, entryCostBps, exitCostBps, fixedActionCostUsd };
  }
  return { ...cfg, entryCostBps, exitCostBps, fixedActionCostUsd, feeShareDilutionRefWidth };
}

/** The four sweep configurations with the run's execution costs applied. */
function buildBacktestConfigs(
  tolerateEmptyBins: boolean,
  entryCostBps: number,
  exitCostBps: number,
  fixedActionCostUsd: number,
  feeShareDilutionRefWidth: number | undefined,
): ReadonlyArray<NamedBacktestConfig> {
  const base: ReadonlyArray<NamedBacktestConfig> = [
    {
      name: "C1-conservative",
      cfg: {
        halfWidth: 100,
        driftThreshold: 0.75,
        minHoldTicks: 144,
        minNetBenefitUsd: 15,
        maxRebalances: 20,
        maxPositionsPerPool: 2,
        backtestTolerateEmptyBins: tolerateEmptyBins,
      },
    },
    {
      name: "C2-balanced",
      cfg: {
        halfWidth: 80,
        driftThreshold: 0.65,
        minHoldTicks: 72,
        minNetBenefitUsd: 10,
        maxRebalances: 30,
        maxPositionsPerPool: 2,
        backtestTolerateEmptyBins: tolerateEmptyBins,
      },
    },
    {
      name: "C3-aggressive",
      cfg: {
        halfWidth: 60,
        driftThreshold: 0.55,
        minHoldTicks: 36,
        minNetBenefitUsd: 5,
        maxRebalances: 50,
        maxPositionsPerPool: 2,
        backtestTolerateEmptyBins: tolerateEmptyBins,
      },
    },
    {
      name: "C4-wide-patient",
      cfg: {
        halfWidth: 100,
        driftThreshold: 0.8,
        minHoldTicks: 288,
        minNetBenefitUsd: 25,
        maxRebalances: 10,
        maxPositionsPerPool: 2,
        backtestTolerateEmptyBins: tolerateEmptyBins,
      },
    },
  ];
  return base.map(({ name, cfg }) => ({
    name,
    cfg: withBacktestExecutionCosts(
      cfg,
      entryCostBps,
      exitCostBps,
      fixedActionCostUsd,
      feeShareDilutionRefWidth,
    ),
  }));
}

/** Deterministic randomness for one synthetic run: PRNG plus time anchor. */
function resolveSyntheticRandomness(seed: number | undefined): readonly [() => number, number] {
  if (seed === undefined) return [Math.random, Date.now()];
  return [createSeededRandom(seed), Date.UTC(2020, 0, 1)];
}

/** Multi-seed robustness sweep for one pool (synthetic source only). */
function runSeededSweep(
  poolAddress: string,
  days: number,
  seeds: ReadonlyArray<number>,
  configs: ReadonlyArray<NamedBacktestConfig>,
): void {
  const endMs = Date.UTC(2020, 0, 1);
  const seededResults = seeds.flatMap((seed) => {
    const ticks = generateMockHistory(poolAddress, days, 100_000, createSeededRandom(seed), endMs);
    return configs.map(({ name, cfg }) => ({
      name,
      seed,
      result: runBacktestFromTicks(ticks, cfg),
    }));
  });
  const aggregates = aggregateBacktestResults(seededResults);
  const table = aggregates.map((summary) => ({
    Config: summary.name,
    Seeds: summary.seedCount,
    "Mean Net PnL": `$${summary.meanNetPnlUsd.toFixed(0)}`,
    "Net PnL σ": `$${summary.netPnlStdDevUsd.toFixed(0)}`,
    "Net PnL Range": `$${summary.minNetPnlUsd.toFixed(0)}..$${summary.maxNetPnlUsd.toFixed(0)}`,
    "Mean Win %": `${(summary.meanWinRate * 100).toFixed(0)}%`,
    "Win % σ": `${(summary.winRateStdDev * 100).toFixed(1)}pp`,
    "Win % Range": `${(summary.minWinRate * 100).toFixed(0)}..${(summary.maxWinRate * 100).toFixed(0)}%`,
    Profitable: `${summary.profitableRuns}/${summary.seedCount}`,
  }));
  log.info(`Synthetic robustness sweep: ${JSON.stringify(table)}`);
}

/** Ticks for one pool: synthetic strip or DB replay (null = no snapshots). */
async function loadBacktestTicks(
  poolAddress: string,
  source: "synthetic" | "replay",
  days: number,
  dbPath: string,
  seed: number | undefined,
): Promise<HistoryTick[] | null> {
  if (source === "synthetic") {
    const [random, endMs] = resolveSyntheticRandomness(seed);
    const ticks = generateMockHistory(poolAddress, days, 100_000, random, endMs);
    if (seed !== undefined) {
      log.info(`  synthetic seed=${seed}`);
    }
    return ticks;
  }
  const snaps = await loadSnapshots(dbPath, poolAddress, Date.now(), days);
  if (snaps.length === 0) {
    log.info(
      `  no snapshots for ${poolAddress} in last ${days}d (db=${dbPath}). ` +
        `Did you run the agent with ENABLE_SNAPSHOT_CAPTURE=true?`,
    );
    return null;
  }
  const ticks = snapshotsToTicks(snaps);
  log.info(`  loaded ${snaps.length} snapshots from ${dbPath}`);
  return ticks;
}

/** Full sweep for one pool: load ticks, run every config, log the table. */
async function processBacktestPool(
  poolAddress: string,
  source: "synthetic" | "replay",
  days: number,
  dbPath: string,
  seeds: ReadonlyArray<number> | undefined,
  seed: number | undefined,
  configs: ReadonlyArray<NamedBacktestConfig>,
): Promise<void> {
  log.info(`\n=== Pool: ${poolAddress} (source=${source}, days=${days}) ===\n`);
  if (source === "synthetic" && seeds !== undefined) {
    runSeededSweep(poolAddress, days, seeds, configs);
    return;
  }
  const ticks = await loadBacktestTicks(poolAddress, source, days, dbPath, seed);
  if (ticks === null) return;
  const results = configs.map(({ name, cfg }) => ({
    name,
    result: runBacktestFromTicks(ticks, cfg),
  }));
  const table = results.map(({ name, result: r }) => ({
    Config: name,
    "Net PnL": `$${r.netPnlUsd.toFixed(0)}`,
    Fees: `$${r.totalFeesUsd.toFixed(0)}`,
    IL: `$${r.totalIlUsd.toFixed(0)}`,
    Rebal: r.totalRebalances,
    "Win %": `${(r.winRate * 100).toFixed(0)}%`,
    Sharpe: r.sharpeRatio.toFixed(2),
    Admits: `${r.admitted ?? 0}/${r.enterAttempts ?? 0}`,
    Rejects: summarizeCounts(r.rejectionsByReason),
    "Exit WR": summarizeCounts(r.winrateByExitReason, (v) => `${(v * 100).toFixed(0)}%`),
    "Hold(h)": summarizeCounts(r.avgHoldHoursByExitReason, (v) => v.toFixed(1)),
  }));
  log.info(`Results table: ${JSON.stringify(table)}`);
  const [best] = rankBacktestResults(results);
  if (!best) throw new Error(`No backtest result for ${poolAddress}`);
  log.info("Best config", {
    pool: poolAddress,
    config: best.name,
    netPnlUsd: best.result.netPnlUsd.toFixed(2),
    winRate: (best.result.winRate * 100).toFixed(1) + "%",
    rebalances: best.result.totalRebalances,
  });
  log.info(`  Best: ${best.name} (net=$${best.result.netPnlUsd.toFixed(0)})`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function runBacktest(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv);

  logReplayLimitations();
  logSyntheticLimitations(args.source, args.seeds, args.seed);
  log.warn("  • clmmPositionValue marks price movement and token depreciation");
  log.warn("    through the range-aware LP/HODL valuation. It does not model");
  log.warn("    live-only execution effects such as slippage, gas, or oracle");
  log.warn("    outages; those remain outside this replay.");
  logExecutionCostWarning(args.entryCostBps, args.exitCostBps, args.fixedActionCostUsd);
  logFeeDilutionWarning(args.feeShareDilutionRefWidth);
  log.warn("═══════════════════════════════════════════════════════════════");

  // Mirror the live config-service default (BACKTEST_TOLERATE_EMPTY_BINS,
  // default true) so `bun run backtest` admits empty-bin snapshots exactly
  // like the agent's replay does.
  const tolerateEmptyBins = process.env.BACKTEST_TOLERATE_EMPTY_BINS !== "false";
  const configs = buildBacktestConfigs(
    tolerateEmptyBins,
    args.entryCostBps,
    args.exitCostBps,
    args.fixedActionCostUsd,
    args.feeShareDilutionRefWidth,
  );

  for (const pool of args.pools) {
    await processBacktestPool(
      pool,
      args.source,
      args.days,
      args.dbPath,
      args.seeds,
      args.seed,
      configs,
    );
  }
}

export { runBacktest };

const isDirectBacktestExecution =
  Boolean(globalThis.Bun) &&
  (Bun.main?.endsWith("ops/backtest.ts") || Bun.main?.endsWith("ops/backtest.js"));
if (isDirectBacktestExecution) {
  if (process.env.PRISM_ALLOW_DIRECT !== "true") {
    console.error("Error: Direct backtest execution is not allowed.");
    console.error('Use "prism backtest" instead.');
    process.exit(1);
  }
  runBacktest(process.argv.slice(2)).catch((err) => {
    log.error("Backtest failed", { error: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  });
}
