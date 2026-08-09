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
export function launchPositionExit(input: LaunchPositionExitInput): LaunchPositionExitResult {
  const ageHours = (input.now - input.createdAtMs) / HOUR_MS;
  if (ageHours >= input.timeboxHours) {
    return { exit: true, reason: "timebox" };
  }

  if (
    input.peakFees1hUsd !== null &&
    input.currentFees1hUsd !== null &&
    input.peakFees1hUsd > 0 &&
    input.currentFees1hUsd < input.peakFees1hUsd * input.volumeDecayExitPct
  ) {
    return { exit: true, reason: "volume-decay" };
  }

  if (
    input.drawdownPct > 0 &&
    input.peakValueUsd !== null &&
    input.currentValueUsd <= input.peakValueUsd * (1 - input.drawdownPct)
  ) {
    return { exit: true, reason: "drawdown" };
  }

  if (input.feeIlRatio !== null && input.feeIlRatio < 0.5) {
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
