/**
 * TA-exhaustion EXIT (thirteenth-wave spec): automate the profitable manual
 * rule — RSI(2) > 90 with Bollinger-upper / MACD-green confluence — instead
 * of a fixed 15% TP.
 *
 * Data source: `pool_snapshots.currentPrice` history as chronological closes
 * (oldest-first). Call-site order (NOT wired here): evaluate AFTER the
 * TP-ladder branch (`evaluateTpTargetExit`, program.ts:10326) and BEFORE
 * loss-side exits, so exhaustion locks profits before capital protection.
 *
 * The confluence is price-only (#237): it never reads the position's cost
 * basis by itself, and on live paper runs it fired on positions that were
 * already net-negative. The caller therefore supplies the projected realized
 * P&L (mark value + claimed fees − cost basis − modeled close costs) and the
 * reasoning is only allowed to claim "profit-exhaustion" when that figure is
 * non-negative. The optional P&L gate (`TA_EXHAUSTION_REQUIRE_NONNEGATIVE_PNL`,
 * default off) suppresses the exit on a losing position unless the measured
 * pool fee/IL still clears its own floor. All new policy knobs preserve the
 * pre-#237 always-on behavior at their defaults.
 *
 * Cold start: every entry point returns null below
 * `TA_EXHAUSTION_MIN_POINTS` (fail-open no-vote, like drift). Parameters are
 * textbook defaults — BB(20, 2), MACD(12, 26, 9); the 35-point floor is the
 * MACD binding constraint (26 slow + 9 signal values yield current +
 * previous histogram). Strict comparisons throughout: RSI == 90 holds,
 * close == upper holds, histogram == 0 is not green.
 */

import type { AgentDecision } from "./types.js";
import { liveCloseCostsUsd, paperCloseCostsUsd } from "./fee-capture.js";

/** Minimum closes for a vote: MACD(12,26,9) current + previous histogram. */
export const TA_EXHAUSTION_MIN_POINTS = 35;
/** Wilder RSI period. */
export const TA_RSI_PERIOD = 2;
/** Overbought trip line (strict >). */
export const TA_RSI_OVERBOUGHT = 90;
/** Bollinger SMA window. */
export const TA_BB_PERIOD = 20;
/** Bollinger band width in population stddevs. */
export const TA_BB_MULT = 2;
/** MACD fast / slow / signal periods. */
export const TA_MACD_FAST_PERIOD = 12;
export const TA_MACD_SLOW_PERIOD = 26;
export const TA_MACD_SIGNAL_PERIOD = 9;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TaExhaustionPolicy {
  /** Master switch. Default true (the pre-#237 always-on behavior). */
  readonly enabled: boolean;
  /** RSI(2) strict-overbought trip line. Default 90. */
  readonly rsiThreshold: number;
  /** Minimum position age before the exit may fire. 0 disables. Default 0. */
  readonly minHoldMs: number;
  /** Require non-negative projected P&L (or a measured fee/IL clearing the
   *  floor). Default false — the pre-#237 ungated behavior. */
  readonly requireNonnegativePnl: boolean;
  /** Fee/IL ratio that satisfies the P&L gate's alternative leg. Default 1.2. */
  readonly minFeeIlRatio: number;
}

/** Behavior-preserving defaults: on, RSI > 90, no hold floor, no P&L gate. */
export const TA_EXHAUSTION_DEFAULT_POLICY: TaExhaustionPolicy = {
  enabled: true,
  rsiThreshold: TA_RSI_OVERBOUGHT,
  minHoldMs: 0,
  requireNonnegativePnl: false,
  minFeeIlRatio: 1.2,
};

/**
 * Merge partial (config-derived) overrides into the defaults. Non-finite or
 * absent numbers fall back to the documented default; booleans fall back too.
 */
export function resolveTaExhaustionPolicy(overrides: {
  readonly enabled?: boolean | undefined;
  readonly rsiThreshold?: number | undefined;
  readonly minHoldMs?: number | undefined;
  readonly requireNonnegativePnl?: boolean | undefined;
  readonly minFeeIlRatio?: number | undefined;
}): TaExhaustionPolicy {
  const defaults = TA_EXHAUSTION_DEFAULT_POLICY;
  return {
    enabled: overrides.enabled ?? defaults.enabled,
    rsiThreshold: finiteOr(overrides.rsiThreshold, defaults.rsiThreshold),
    minHoldMs: Math.max(finiteOr(overrides.minHoldMs, defaults.minHoldMs), 0),
    requireNonnegativePnl: overrides.requireNonnegativePnl ?? defaults.requireNonnegativePnl,
    minFeeIlRatio: Math.max(finiteOr(overrides.minFeeIlRatio, defaults.minFeeIlRatio), 0),
  };
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function allFinite(values: readonly number[]): boolean {
  return values.every((v) => Number.isFinite(v));
}

/** Wilder RSI over the full series. Null below period + 1 closes or on junk. */
export function computeRsi2(closes: readonly number[]): number | null {
  const period = TA_RSI_PERIOD;
  if (closes.length < period + 1 || !allFinite(closes)) return null;
  const seed = seedAverages(closes, period);
  const { avgGain, avgLoss } = smoothAverages(closes, period, seed.avgGain, seed.avgLoss);
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

interface RsiAverages {
  readonly avgGain: number;
  readonly avgLoss: number;
}
function seedAverages(closes: readonly number[], period: number): RsiAverages {
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff > 0) gainSum += diff;
    else lossSum -= diff;
  }
  return { avgGain: gainSum / period, avgLoss: lossSum / period };
}

function smoothAverages(
  closes: readonly number[],
  period: number,
  avgGain: number,
  avgLoss: number,
): RsiAverages {
  let g = avgGain;
  let l = avgLoss;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    g = (g * (period - 1) + (diff > 0 ? diff : 0)) / period;
    l = (l * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }
  return { avgGain: g, avgLoss: l };
}

interface BollingerBands {
  readonly middle: number;
  readonly upper: number;
  readonly lower: number;
}

function bollingerBands(closes: readonly number[]): BollingerBands | null {
  const n = TA_BB_PERIOD;
  if (closes.length < n) return null;
  const window = closes.slice(-n);
  if (!allFinite(window)) return null;
  let sum = 0;
  for (const v of window) sum += v;
  const middle = sum / n;
  let sq = 0;
  for (const v of window) sq += (v - middle) * (v - middle);
  const sd = Math.sqrt(sq / n);
  return { middle, upper: middle + TA_BB_MULT * sd, lower: middle - TA_BB_MULT * sd };
}

/** Upper band over the trailing BB window. Null below 20 closes or on junk. */
export function computeBollingerUpper(closes: readonly number[]): number | null {
  return bollingerBands(closes)?.upper ?? null;
}

/**
 * Bollinger %B of the last close: (close − lower) / (upper − lower).
 * 0.5 on a zero-width (flat) band. Null below 20 closes or on junk.
 */
export function computeBollingerPercentB(closes: readonly number[]): number | null {
  const bands = bollingerBands(closes);
  const close = closes[closes.length - 1];
  if (bands === null || close === undefined || !Number.isFinite(close)) return null;
  const width = bands.upper - bands.lower;
  if (width === 0) return 0.5;
  return (close - bands.lower) / width;
}

/** EMA series seeded with the SMA of the first `period` values. */
function emaSeries(values: readonly number[], period: number): number[] {
  let ema = 0;
  for (let i = 0; i < period; i++) ema += values[i]!;
  ema /= period;
  const out = [ema];
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    ema += k * (values[i]! - ema);
    out.push(ema);
  }
  return out;
}

/**
 * MACD histogram (macd − signal) current + previous. "First green" is
 * current > 0 with previous <= 0. Null below 35 closes or on junk.
 */
export function computeMacdHistogram(closes: readonly number[]): {
  readonly current: number;
  readonly previous: number;
} | null {
  if (closes.length < TA_MACD_SLOW_PERIOD + TA_MACD_SIGNAL_PERIOD || !allFinite(closes)) {
    return null;
  }
  const fast = emaSeries(closes, TA_MACD_FAST_PERIOD);
  const slow = emaSeries(closes, TA_MACD_SLOW_PERIOD);
  const offset = TA_MACD_SLOW_PERIOD - TA_MACD_FAST_PERIOD;
  const macd: number[] = slow.map((s, i) => fast[i + offset]! - s);
  const signal = emaSeries(macd, TA_MACD_SIGNAL_PERIOD);
  const hist: number[] = signal.map((s, i) => macd[i + TA_MACD_SIGNAL_PERIOD - 1]! - s);
  const current = hist[hist.length - 1];
  const previous = hist[hist.length - 2];
  if (current === undefined || previous === undefined) return null;
  return { current, previous };
}

/** Indicator snapshot behind one EXIT vote. */
export interface TaExhaustionSignals {
  readonly rsi2: number;
  readonly rsiThreshold: number;
  readonly rsiOverbought: boolean;
  readonly percentB: number;
  readonly aboveBbUpper: boolean;
  readonly histogram: number;
  readonly previousHistogram: number;
  readonly macdFirstGreen: boolean;
}

/**
 * Full indicator read. Null below `TA_EXHAUSTION_MIN_POINTS` (fail-open
 * no-vote) or on junk — never throws on market data. `rsiThreshold` defaults
 * to the textbook 90; a non-finite override falls back to it.
 */
export function taExhaustionSignals(
  closes: readonly number[],
  rsiThreshold: number = TA_RSI_OVERBOUGHT,
): TaExhaustionSignals | null {
  if (closes.length < TA_EXHAUSTION_MIN_POINTS) return null;
  const threshold = resolveRsiThreshold(rsiThreshold);
  const rsi2 = computeRsi2(closes);
  const percentB = computeBollingerPercentB(closes);
  const upper = computeBollingerUpper(closes);
  const macd = computeMacdHistogram(closes);
  const close = closes[closes.length - 1];
  if (rsi2 === null || percentB === null || upper === null || macd === null) return null;
  if (close === undefined || !Number.isFinite(close)) return null;
  return {
    rsi2,
    rsiThreshold: threshold,
    rsiOverbought: rsi2 > threshold,
    percentB,
    aboveBbUpper: close > upper,
    histogram: macd.current,
    previousHistogram: macd.previous,
    macdFirstGreen: macd.current > 0 && macd.previous <= 0,
  };
}

function resolveRsiThreshold(value: number): number {
  return Number.isFinite(value) ? value : TA_RSI_OVERBOUGHT;
}

/**
 * Pure confluence gate — Bend `K.ta_exhausted` twin and parity-test source
 * of truth: RSI overbought AND (close above BB-upper OR first MACD green).
 */
export function isTaExhausted(
  rsiOverbought: boolean,
  aboveBbUpper: boolean,
  macdFirstGreen: boolean,
): boolean {
  return rsiOverbought && (aboveBbUpper || macdFirstGreen);
}

export interface TaExhaustionNetPnlInput {
  readonly depositedUsd: number;
  readonly currentValueUsd: number;
  readonly cumulativeFeesClaimedUsd: number;
  readonly cumulativeRewardsClaimedUsd: number;
  /** Live pending swap fees (feeX/feeY) the close withdrawal will sweep.
   *  NaN when unreadable — the whole projection becomes unknown. */
  readonly pendingFeesUsd?: number | undefined;
  /** Prior paper rebalance costs the settlement debits from realized P&L. */
  readonly rebalanceCostsUsd?: number | undefined;
  /** False when the caller's mark is a fallback (live HODL/deposit) rather
   *  than a valuation of what a close would withdraw. Defaults true. */
  readonly markKnown?: boolean | undefined;
  readonly ageMs: number;
  /** Paper and live close models debit different real costs. */
  readonly paperTrading: boolean;
  readonly swapCostPct?: number | undefined;
  readonly harvestCostUsd?: number | undefined;
  readonly conversionCostPct?: number | undefined;
  readonly txCostUsd?: number | undefined;
}

/**
 * Projected realized P&L at close: mark value + claimed fees + rewards +
 * pending live fees − cost basis − prior rebalance costs − the modeled close
 * costs the settlement path debits. This is the figure the label and the
 * optional P&L gate read; it is deliberately not a ledger value (the close
 * measures the real withdrawal). Unknown inputs (an unpriced/fallback mark,
 * an unreadable pending-fee amount, a non-finite gross) return NaN — the
 * caller then labels the outcome unknown and the gate fails closed.
 */
export function taExhaustionNetPnlUsd(input: TaExhaustionNetPnlInput): number {
  if (input.markKnown === false) return Number.NaN;
  const gross =
    input.currentValueUsd +
    input.cumulativeFeesClaimedUsd +
    input.cumulativeRewardsClaimedUsd +
    (input.pendingFeesUsd ?? 0) -
    input.depositedUsd -
    (input.rebalanceCostsUsd ?? 0);
  if (!Number.isFinite(gross)) return Number.NaN;
  return gross - taCloseCostsUsd(input, taAgeDays(input.ageMs));
}

function taAgeDays(ageMs: number): number {
  const bounded = Number.isFinite(ageMs) ? ageMs : 0;
  return Math.max(bounded, 0) / DAY_MS;
}

function taCloseCostsUsd(input: TaExhaustionNetPnlInput, ageDays: number): number {
  if (input.paperTrading) {
    return paperCloseCostsUsd({
      positionSizeUsd: input.depositedUsd,
      ageDays,
      cumulativeGrossFeesUsd: input.cumulativeFeesClaimedUsd,
      swapCostPct: input.swapCostPct ?? 0.005,
      harvestCostUsd: input.harvestCostUsd ?? 0.01,
      conversionCostPct: input.conversionCostPct ?? 0.05,
      txCostUsd: input.txCostUsd ?? 0.005,
    });
  }
  return liveCloseCostsUsd({
    positionSizeUsd: input.depositedUsd,
    ageDays,
    swapCostPct: input.swapCostPct ?? 0,
    harvestCostUsd: input.harvestCostUsd ?? 0,
    txCostUsd: input.txCostUsd ?? 0,
  });
}

/** Bracket-tagged EXIT reasoning for ledger slicing. */
export function taExhaustionReasoning(signals: TaExhaustionSignals, netPnlUsd: number): string {
  const leg = signals.aboveBbUpper ? "close above BB-upper" : "first-green MACD histogram";
  const base = `[ta-exhaustion] RSI(2) ${signals.rsi2.toFixed(1)} > ${signals.rsiThreshold} with ${leg} (%B ${signals.percentB.toFixed(2)}, hist ${signals.histogram.toFixed(4)})`;
  if (!Number.isFinite(netPnlUsd)) {
    return `${base} — exhaustion exit (projected P&L unknown), before loss-side gates`;
  }
  if (netPnlUsd >= 0) {
    return `${base} — profit-exhaustion (+$${netPnlUsd.toFixed(2)} net of modeled close costs), exiting before loss-side gates`;
  }
  return `${base} — exhaustion exit on a losing position (-$${Math.abs(netPnlUsd).toFixed(2)} net of modeled close costs), exiting before loss-side gates`;
}

/**
 * Optional P&L gate: when off (default) every confluence exit passes. When on,
 * a losing projected P&L is admitted only by a MEASURED fee/IL ratio at or
 * above the floor; unknown ratios fail closed.
 */
export function taExhaustionPnlGateSatisfied(input: {
  readonly netPnlUsd: number;
  readonly feeIlRatio: number | null;
  readonly policy: TaExhaustionPolicy;
}): boolean {
  if (!input.policy.requireNonnegativePnl) return true;
  if (Number.isFinite(input.netPnlUsd) && input.netPnlUsd >= 0) return true;
  const ratio = input.feeIlRatio;
  if (ratio === null || !Number.isFinite(ratio)) return false;
  const floor = Math.max(finiteOr(input.policy.minFeeIlRatio, 0), 0);
  return ratio >= floor;
}

export interface TaExhaustionExitInput {
  readonly poolAddress: string;
  readonly positionId: string;
  readonly closes: readonly number[];
  /** Position age in ms (drives the optional minimum-hold floor). */
  readonly ageMs: number;
  /** Projected realized P&L at close, net of modeled close costs. */
  readonly netPnlUsd: number;
  /** Measured pool fee/IL ratio; null when the source is modeled/unknown. */
  readonly feeIlRatio: number | null;
  readonly policy?: TaExhaustionPolicy | undefined;
}

export interface TaExhaustionVoteInput {
  readonly closes: readonly number[];
  /** Position age in ms (drives the optional minimum-hold floor). */
  readonly ageMs: number;
  readonly policy?: TaExhaustionPolicy | undefined;
}

/**
 * Enabled + mature + confluence → signals; null means no vote (fail-open).
 * The program uses this as a cheap pure preflight so the per-position
 * rebalance-cost/pending-fee reads only run when the gate would fire.
 */
export function taExhaustionVote(input: TaExhaustionVoteInput): TaExhaustionSignals | null {
  const policy = input.policy ?? TA_EXHAUSTION_DEFAULT_POLICY;
  if (!policy.enabled) return null;
  const minHoldMs = Math.max(finiteOr(policy.minHoldMs, 0), 0);
  if (!(input.ageMs >= minHoldMs)) return null;
  const signals = taExhaustionSignals(input.closes, policy.rsiThreshold);
  if (signals === null) return null;
  if (!isTaExhausted(signals.rsiOverbought, signals.aboveBbUpper, signals.macdFirstGreen)) {
    return null;
  }
  return signals;
}

/**
 * EXIT vote in `conf1PositionExit` shape (action EXIT, confidence 1.0).
 * Null when disabled, too young, cold/junk (fail-open) or without confluence.
 * The caller places it after the TP-ladder branch and before loss-side exits.
 */
export function maybeTaExhaustionExit(input: TaExhaustionExitInput): AgentDecision | null {
  const policy = input.policy ?? TA_EXHAUSTION_DEFAULT_POLICY;
  const signals = taExhaustionVote(input);
  if (signals === null) return null;
  if (
    !taExhaustionPnlGateSatisfied({
      netPnlUsd: input.netPnlUsd,
      feeIlRatio: input.feeIlRatio,
      policy,
    })
  ) {
    return null;
  }
  return {
    action: "EXIT",
    poolAddress: input.poolAddress,
    positionId: input.positionId,
    confidence: 1,
    reasoning: taExhaustionReasoning(signals, input.netPnlUsd),
  };
}
