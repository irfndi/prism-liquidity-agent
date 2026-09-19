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
 * Cold start: every entry point returns null below
 * `TA_EXHAUSTION_MIN_POINTS` (fail-open no-vote, like drift). Parameters are
 * textbook defaults — BB(20, 2), MACD(12, 26, 9); the 35-point floor is the
 * MACD binding constraint (26 slow + 9 signal values yield current +
 * previous histogram). Strict comparisons throughout: RSI == 90 holds,
 * close == upper holds, histogram == 0 is not green.
 */

import type { AgentDecision } from "./types.js";

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
  readonly rsiOverbought: boolean;
  readonly percentB: number;
  readonly aboveBbUpper: boolean;
  readonly histogram: number;
  readonly previousHistogram: number;
  readonly macdFirstGreen: boolean;
}

/**
 * Full indicator read. Null below `TA_EXHAUSTION_MIN_POINTS` (fail-open
 * no-vote) or on junk — never throws on market data.
 */
export function taExhaustionSignals(closes: readonly number[]): TaExhaustionSignals | null {
  if (closes.length < TA_EXHAUSTION_MIN_POINTS) return null;
  const rsi2 = computeRsi2(closes);
  const percentB = computeBollingerPercentB(closes);
  const upper = computeBollingerUpper(closes);
  const macd = computeMacdHistogram(closes);
  const close = closes[closes.length - 1];
  if (rsi2 === null || percentB === null || upper === null || macd === null) return null;
  if (close === undefined || !Number.isFinite(close)) return null;
  return {
    rsi2,
    rsiOverbought: rsi2 > TA_RSI_OVERBOUGHT,
    percentB,
    aboveBbUpper: close > upper,
    histogram: macd.current,
    previousHistogram: macd.previous,
    macdFirstGreen: macd.current > 0 && macd.previous <= 0,
  };
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

/** Bracket-tagged EXIT reasoning for ledger slicing. */
export function taExhaustionReasoning(signals: TaExhaustionSignals): string {
  const leg = signals.aboveBbUpper ? "close above BB-upper" : "first-green MACD histogram";
  return `[ta-exhaustion] RSI(2) ${signals.rsi2.toFixed(1)} > 90 with ${leg} (%B ${signals.percentB.toFixed(2)}, hist ${signals.histogram.toFixed(4)}) — profit-exhaustion, exiting before loss-side gates`;
}

export interface TaExhaustionExitInput {
  readonly poolAddress: string;
  readonly positionId: string;
  readonly closes: readonly number[];
}

/**
 * EXIT vote in `conf1PositionExit` shape (action EXIT, confidence 1.0).
 * Null when cold/junk (fail-open) or without confluence — the caller places
 * it after the TP-ladder branch and before loss-side exits.
 */
export function maybeTaExhaustionExit(input: TaExhaustionExitInput): AgentDecision | null {
  const signals = taExhaustionSignals(input.closes);
  if (signals === null) return null;
  if (!isTaExhausted(signals.rsiOverbought, signals.aboveBbUpper, signals.macdFirstGreen)) {
    return null;
  }
  return {
    action: "EXIT",
    poolAddress: input.poolAddress,
    positionId: input.positionId,
    confidence: 1,
    reasoning: taExhaustionReasoning(signals),
  };
}
