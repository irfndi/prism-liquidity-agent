/**
 * Launch Mode v2 — pure launch-lane policy (Slice A).
 *
 * Launch-gated pools run on a separate time-boxed execution lane with
 * launch-specific exits. This module is deliberately pure: every input is
 * passed in, nothing is imported, no state is kept — it is unit-testable in
 * isolation (see bench/launch-position.test.ts).
 */

export interface LaunchPositionExitInput {
  /** Position open timestamp (ms epoch). */
  createdAtMs: number;
  /** Current time (ms epoch). */
  now: number;
  /** Time-box: exit once the position reaches this age. Hours. */
  timeboxHours: number;
  /** Exit when current 1h fees fall below this fraction of the observed peak. */
  volumeDecayExitPct: number;
  /** Hard stop: exit when value drops to <= (1 - this) of peak value. */
  drawdownPct: number;
  /** Current 1h fees in USD (measured datapi only upstream); null if unknown. */
  currentFees1hUsd: number | null;
  /** Observed peak 1h fees in USD; null if never measured. */
  peakFees1hUsd: number | null;
  /** Current position value in USD. */
  currentValueUsd: number;
  /** Peak position value in USD (position.highestValueUsd); null if unknown. */
  peakValueUsd: number | null;
  /** Fee/IL ratio from metrics; null if unknown. */
  feeIlRatio: number | null;
}

export type LaunchExitReason = "timebox" | "volume-decay" | "drawdown" | "fee-il";

export interface LaunchPositionExitResult {
  exit: boolean;
  reason: LaunchExitReason | null;
}

const HOUR_MS = 3.6e6;

/**
 * Evaluate the four independent launch exit rules; the first hit wins.
 *
 * - timebox:      ageHours >= timeboxHours
 * - volume-decay: peak and current fees known, peak > 0, and
 *                 current < peak * volumeDecayExitPct
 * - drawdown:     peak value known and current <= peak * (1 - drawdownPct)
 * - fee-il:       ratio known and < 0.5 (the conservative lane's floor)
 *
 * Unknown values (null peak/fees) never fire their rule — the timebox stays
 * the backstop for data-starved positions.
 */
function isTimeboxExpired(now: number, createdAtMs: number, timeboxHours: number): boolean {
  return (now - createdAtMs) / HOUR_MS >= timeboxHours;
}

function hasVolumeDecayed(
  peakFees1hUsd: number | null,
  currentFees1hUsd: number | null,
  volumeDecayExitPct: number,
): boolean {
  if (peakFees1hUsd === null || currentFees1hUsd === null) return false;
  if (peakFees1hUsd <= 0) return false;
  return currentFees1hUsd < peakFees1hUsd * volumeDecayExitPct;
}

function hasDrawdownHit(
  drawdownPct: number,
  peakValueUsd: number | null,
  currentValueUsd: number,
): boolean {
  if (drawdownPct <= 0 || peakValueUsd === null) return false;
  return currentValueUsd <= peakValueUsd * (1 - drawdownPct);
}

function isFeeIlBreached(feeIlRatio: number | null): boolean {
  if (feeIlRatio === null) return false;
  return feeIlRatio < 0.5;
}

export function launchPositionExit(input: LaunchPositionExitInput): LaunchPositionExitResult {
  if (isTimeboxExpired(input.now, input.createdAtMs, input.timeboxHours)) {
    return { exit: true, reason: "timebox" };
  }
  if (hasVolumeDecayed(input.peakFees1hUsd, input.currentFees1hUsd, input.volumeDecayExitPct)) {
    return { exit: true, reason: "volume-decay" };
  }
  if (hasDrawdownHit(input.drawdownPct, input.peakValueUsd, input.currentValueUsd)) {
    return { exit: true, reason: "drawdown" };
  }
  if (isFeeIlBreached(input.feeIlRatio)) {
    return { exit: true, reason: "fee-il" };
  }
  return { exit: false, reason: null };
}

export interface LaunchEntrySizeInput {
  walletUsd: number;
  poolTvlUsd: number;
  maxSizeUsd: number;
}

/**
 * Launch entry sizing: min(maxSizeUsd, 0.005 x pool TVL, 0.5 x wallet),
 * floored at 0 so degenerate/negative inputs never size a position.
 */
export function launchEntrySizeUsd(input: LaunchEntrySizeInput): number {
  return Math.max(0, Math.min(input.maxSizeUsd, 0.005 * input.poolTvlUsd, 0.5 * input.walletUsd));
}

export interface ScaleInDecisionInput {
  /** The price the runner band was last anchored at (entry price, then each
   *  scale-in's re-anchor). */
  readonly anchorPrice: number;
  /** Current pool price. */
  readonly currentPrice: number;
  /** Re-anchor when the price falls this fraction below the anchor. */
  readonly stepPct: number;
  /** Steps already taken on this position (persisted, restart-safe). */
  readonly steps: number;
  readonly maxSteps: number;
}

export interface ScaleInDecision {
  readonly scale: boolean;
  readonly reason: string | null;
}

/**
 * Runner scale-in trigger: re-anchor the dip band + add capital when the
 * price falls a full step below the last anchor, up to maxSteps. The band
 * TRACKS the dip (re-anchored at dip% below the NEW price) — accumulating
 * quote liquidity into the falling price instead of holding a stale band.
 */
export function shouldScaleInRunner(input: ScaleInDecisionInput): ScaleInDecision {
  if (input.steps >= input.maxSteps) {
    return { scale: false, reason: `max steps reached (${input.steps}/${input.maxSteps})` };
  }
  if (!Number.isFinite(input.anchorPrice) || input.anchorPrice <= 0) {
    return { scale: false, reason: "anchor price unknown" };
  }
  if (input.currentPrice <= 0 || !Number.isFinite(input.currentPrice)) {
    return { scale: false, reason: "current price unknown" };
  }
  const drop = 1 - input.currentPrice / input.anchorPrice;
  if (drop < input.stepPct) {
    return {
      scale: false,
      reason: `price drop ${(drop * 100).toFixed(2)}% < step ${(input.stepPct * 100).toFixed(0)}%`,
    };
  }
  return {
    scale: true,
    reason: `price fell ${(drop * 100).toFixed(2)}% below anchor — re-anchoring + scaling in (step ${input.steps + 1}/${input.maxSteps})`,
  };
}

export interface ScaleInTopUpInput {
  /** Remaining quote capital in the wallet (USD). */
  readonly walletUsd: number;
  /** Fraction of the wallet added per step. */
  readonly sizePct: number;
  /** Remaining per-pool allocation headroom (USD) — the aggregate exposure
   *  cap from the risk tail. */
  readonly poolCapUsd: number;
  /** Hard ceiling for one scale-in top-up. */
  readonly maxTopUpUsd: number;
}

/**
 * Scale-in top-up sizing: min(sizePct x wallet, per-pool headroom, hard
 * ceiling), floored at 0. The per-pool allocation cap applies because a
 * scale-in ADDS new capital to the pool's aggregate exposure (unlike the
 * fee-compound top-up, which only reinvests already-owned fees).
 */
export function scaleInTopUpUsd(input: ScaleInTopUpInput): number {
  return Math.max(
    0,
    Math.min(input.sizePct * input.walletUsd, input.poolCapUsd, input.maxTopUpUsd),
  );
}
