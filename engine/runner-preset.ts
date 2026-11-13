/**
 * Hot-runner preset — the "30m printing pool" strategy as pure policy.
 *
 * The shape, in the order the engine applies it:
 *
 *   scan     a Meteora pool printing >= 0.6% fee/TVL over the last 30 MINUTES,
 *            on a coarse bin step (>= 80) — the window and the granularity are
 *            what identify a pool that is earning right now rather than
 *            averaging over a day.
 *   filter   rug / PvP exclusions. This module owns only the measurable half:
 *            fee turnover relative to TVL (a pool whose "fees" dwarf its own
 *            liquidity is printing wash, not demand). The token-safety half
 *            (RugCheck, Jupiter isSus, GoPlus, blacklist) lives in the safety
 *            screen — see `screenPoolSafety`, it is not duplicated here.
 *   enter    a BELOW-MARKET ladder: the range is anchored `entryDipPct` below
 *            the active bin and split 50:50 between a `spot` leg and a
 *            `bidask` leg, so half the capital sits in the traded bins and
 *            half waits for the dip.
 *   reshape  re-anchor every `reshapeEveryBins` of active-bin drift. Reshaping
 *            also compounds the fees that were just claimed (the "257
 *            reshapes" behaviour is compounding frequency, not a knob).
 *   exit     ordered by protection: emergency take-profit, out-of-range guard,
 *            take-profit, then the break-even floor. The floor is what turns a
 *            round trip into a scratch instead of a loss.
 *
 * Everything here is pure: inputs in, verdict out, no clock, no I/O. Wiring
 * lives in program.ts.
 */

/** 30-minute fee/TVL at/above which a pool counts as printing (percent). */
export const RUNNER_PRESET_MIN_FEE_TVL_30M_PCT = 0.6;

/**
 * Minimum bin step. Coarse bins mean fewer, larger price steps, so a range
 * holds through chop and the position is not re-shaped by every tick.
 */
export const RUNNER_PRESET_MIN_BIN_STEP = 80;

/** Enter this far below the active bin (fraction of price). */
export const RUNNER_PRESET_ENTRY_DIP_PCT = 0.5;

/** Half the size in the spot leg, half in the bid-ask leg. */
export const RUNNER_PRESET_SPOT_SHARE = 0.5;

/** Re-anchor once the active bin has drifted this many bins from the anchor. */
export const RUNNER_PRESET_REANCHOR_EVERY_BINS = 5;

/** Emergency take-profit: close on a fast move this far above entry. */
export const RUNNER_PRESET_EMERGENCY_TP_PCT = 0.1;

/** Break-even floor: never give back a winner — exit at entry + this. */
export const RUNNER_PRESET_BREAK_EVEN_FLOOR_PCT = 0.001;

/**
 * Fee-turnover guard: the effective fee rate (24h fees / 24h volume) must stay
 * explainable. DLMM base fees run ~0.25%-2% by bin step even with dynamic fees,
 * so a pool whose booked fees exceed 5% of its own traded volume is reporting
 * wash-driven "fees" rather than demand — the thing the video's Fee-Turnover
 * Guard is there to exclude.
 *
 * Deliberately volume-relative and not a 30m-share-of-day ratio: a genuinely
 * hot pool SHOULD have a 30m share far above 1/48 of its day, so that ratio
 * would reject exactly the pools the strategy is hunting.
 */
export const RUNNER_PRESET_MAX_EFFECTIVE_FEE_RATE = 0.05;

export interface RunnerPoolFacts {
  /** Data-API 30m fee/TVL percent, or null when the window is missing. */
  readonly feeTvlRatio30mPct: number | null;
  readonly binStep: number;
  readonly tvlUsd: number;
  readonly fees24hUsd: number;
  readonly volume24hUsd: number;
}

export interface RunnerPresetConfig {
  readonly minFeeTvl30mPct: number;
  readonly minBinStep: number;
  readonly maxEffectiveFeeRate: number;
  /** Minimum 24h volume/TVL turnover, the dead-pool floor. */
  readonly minTurnover: number;
}

export const RUNNER_PRESET_DEFAULTS: RunnerPresetConfig = {
  minFeeTvl30mPct: RUNNER_PRESET_MIN_FEE_TVL_30M_PCT,
  minBinStep: RUNNER_PRESET_MIN_BIN_STEP,
  maxEffectiveFeeRate: RUNNER_PRESET_MAX_EFFECTIVE_FEE_RATE,
  minTurnover: 0.02,
};

export type RunnerRejectReason =
  | "fee-tvl-30m-unknown"
  | "fee-tvl-30m-below-floor"
  | "bin-step-below-floor"
  | "fee-turnover-inflated"
  | "volume-turnover-too-low";

export interface RunnerPoolVerdict {
  /** True only when every measurable condition passes. */
  readonly qualifies: boolean;
  /** Populated in evaluation order; empty when `qualifies`. */
  readonly reasons: ReadonlyArray<RunnerRejectReason>;
}

function finiteNonNegative(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

/**
 * Screen one pool against the scanner and the measurable filter.
 *
 * Unknown 30m data is a REJECT, not a pass: the whole strategy keys on that
 * window, so a pool the API cannot describe is not a candidate. The 24h-only
 * checks (turnover, fee share) fail open when their inputs are missing —
 * they are secondary guards, and the safety screen still runs.
 */
export function assessRunnerPool(
  facts: RunnerPoolFacts,
  config: RunnerPresetConfig = RUNNER_PRESET_DEFAULTS,
): RunnerPoolVerdict {
  const reasons = [...scanReasons(facts, config), ...filterReasons(facts, config)];
  return { qualifies: reasons.length === 0, reasons };
}

/** The two scanner conditions: the 30m window and the bin granularity. */
function scanReasons(
  facts: RunnerPoolFacts,
  config: RunnerPresetConfig,
): ReadonlyArray<RunnerRejectReason> {
  const reasons: RunnerRejectReason[] = [];
  if (!finiteNonNegative(facts.feeTvlRatio30mPct)) {
    // Unknown is a REJECT: the strategy keys on this window entirely.
    reasons.push("fee-tvl-30m-unknown");
  } else if (facts.feeTvlRatio30mPct < config.minFeeTvl30mPct) {
    reasons.push("fee-tvl-30m-below-floor");
  }
  if (!Number.isFinite(facts.binStep) || facts.binStep < config.minBinStep) {
    reasons.push("bin-step-below-floor");
  }
  return reasons;
}

/** The measurable half of the rug/PvP filter: turnover and fee plausibility. */
function filterReasons(
  facts: RunnerPoolFacts,
  config: RunnerPresetConfig,
): ReadonlyArray<RunnerRejectReason> {
  const reasons: RunnerRejectReason[] = [];
  if (facts.tvlUsd > 0 && Number.isFinite(facts.volume24hUsd)) {
    if (facts.volume24hUsd / facts.tvlUsd < config.minTurnover) {
      reasons.push("volume-turnover-too-low");
    }
  }
  // Booked fees must be explainable by traded volume.
  if (facts.volume24hUsd > 0 && Number.isFinite(facts.fees24hUsd)) {
    if (facts.fees24hUsd / facts.volume24hUsd > config.maxEffectiveFeeRate) {
      reasons.push("fee-turnover-inflated");
    }
  }
  return reasons;
}

export type RunnerEntryLeg = "spot" | "bidask";

export interface RunnerEntryPlanInput {
  readonly binStep: number;
  /** Total position size in USD. */
  readonly sizeUsd: number;
  readonly dipPct?: number;
  readonly spotShare?: number;
  /** Operator range half-width cap, in bins. */
  readonly maxHalfWidthBins: number;
  /** Half-width the range would use without the dip anchor. */
  readonly baseHalfWidthBins: number;
}

export interface RunnerEntryPlan {
  /** Bins BELOW the active bin the range is anchored at (>= 0). */
  readonly dipOffsetBins: number;
  readonly halfWidthBins: number;
  /** Exactly two legs, splitting the size; the fractions sum to 1. */
  readonly legs: ReadonlyArray<{ readonly leg: RunnerEntryLeg; readonly sizeUsd: number }>;
}

/**
 * Below-market split entry.
 *
 * The dip offset converts a price percentage into whole bins for this pool's
 * bin step (a 50% dip is log(2)/log(1+step) bins, clamped to at least one).
 * The half-width is clamped to the operator cap so a wide base range cannot
 * escape it, and the split is rounded once, on the spot leg, so the two legs
 * always sum to exactly `sizeUsd`.
 */
export function planRunnerEntry(input: RunnerEntryPlanInput): RunnerEntryPlan {
  const dipPct = input.dipPct ?? RUNNER_PRESET_ENTRY_DIP_PCT;
  const spotShare = Math.min(Math.max(input.spotShare ?? RUNNER_PRESET_SPOT_SHARE, 0), 1);
  const halfWidth = Math.max(
    1,
    Math.min(
      Math.floor(Number.isFinite(input.baseHalfWidthBins) ? input.baseHalfWidthBins : 1),
      Math.max(1, Math.floor(input.maxHalfWidthBins)),
    ),
  );
  const spotUsd = Math.round(input.sizeUsd * spotShare * 100) / 100;
  return {
    dipOffsetBins: dipOffsetBins(input.binStep, dipPct),
    halfWidthBins: halfWidth,
    legs: [
      { leg: "spot", sizeUsd: spotUsd },
      { leg: "bidask", sizeUsd: Math.round((input.sizeUsd - spotUsd) * 100) / 100 },
    ],
  };
}

/**
 * Bins equivalent to a fractional price dip for this bin step.
 *
 * A bin step `s` (basis points) moves price by a factor `1 + s/10000` per bin,
 * so `dip` needs `ln(1-dip)/ln(1+s/1e4)` bins. Clamped to at least one bin:
 * a dip smaller than half a step still means "anchor below", never "at".
 * Non-finite or out-of-range inputs yield 0 (the caller falls back to a
 * centred range rather than inventing an offset).
 */
export function dipOffsetBins(binStep: number, dipPct: number): number {
  if (!Number.isFinite(binStep) || binStep <= 0) return 0;
  if (!Number.isFinite(dipPct) || dipPct <= 0 || dipPct >= 1) return 0;
  const perBin = Math.log(1 + binStep / 10_000);
  if (!(perBin > 0)) return 0;
  return Math.max(1, Math.round(-Math.log(1 - dipPct) / perBin));
}

export interface ReanchorInput {
  /** Active bin id the range was last anchored at. */
  readonly anchorBinId: number;
  /** Current active bin id. */
  readonly activeBinId: number;
  /** Drift that triggers a reshape, in bins. */
  readonly everyBins?: number;
}

export interface ReanchorDecision {
  readonly reanchor: boolean;
  /** Signed drift in bins (positive = price moved up). */
  readonly driftBins: number;
}

/**
 * Re-anchor when the active bin has drifted `everyBins` in EITHER direction.
 * A one-sided rule would let a position run out of range on the way down while
 * staying put on the way up, which is the failure the video's "adjust every 5
 * bins" is there to prevent.
 */
export function shouldReanchorRunner(input: ReanchorInput): ReanchorDecision {
  const everyBins = input.everyBins ?? RUNNER_PRESET_REANCHOR_EVERY_BINS;
  if (!Number.isFinite(input.anchorBinId) || !Number.isFinite(input.activeBinId)) {
    return { reanchor: false, driftBins: 0 };
  }
  const driftBins = input.activeBinId - input.anchorBinId;
  if (!Number.isFinite(everyBins) || everyBins <= 0) return { reanchor: false, driftBins };
  return { reanchor: Math.abs(driftBins) >= everyBins, driftBins };
}

export type RunnerExitReason =
  | "emergency-take-profit"
  | "out-of-range"
  | "take-profit"
  | "break-even";

export interface RunnerExitInput {
  /** Current pool price. */
  readonly currentPrice: number;
  /** Price the position was opened at. */
  readonly entryPrice: number;
  /** Active bin in range? */
  readonly inRange: boolean;
  /** Emergency TP threshold as a fraction above entry. */
  readonly emergencyTakeProfitPct?: number;
  /** Regular TP threshold as a fraction above entry. */
  readonly takeProfitPct?: number;
  /** Break-even floor as a fraction above entry. */
  readonly breakEvenFloorPct?: number;
}

export interface RunnerExitVerdict {
  readonly reason: RunnerExitReason | null;
  /** Signed price change vs entry, as a fraction. */
  readonly pnlPct: number;
}

/**
 * Exit precedence, most protective first.
 *
 * 1. `emergency-take-profit` — a fast move to +10% is banked before it can
 *    revert; this fires at or above the emergency threshold.
 * 2. `out-of-range` — the range no longer earns, so the position is recycled
 *    rather than held for the fee-accrual that stopped.
 * 3. `take-profit` — the ordinary target.
 * 4. `break-even` — once price is back at entry + 0.1%, the round trip is
 *    closed as a scratch instead of risking a reversal into a loss.
 *
 * Emergency and regular TP overlap by construction when the emergency
 * threshold is the lower of the two; the emergency branch is checked first so
 * the label always names the tighter rule that fired.
 */
/** Tolerance for rational-threshold comparisons: a price exactly at the floor
 *  computes to 0.0009999… in binary floating point and must still fire. */
const RATIO_EPSILON = 1e-9;

export function evaluateRunnerExit(input: RunnerExitInput): RunnerExitVerdict {
  if (!usablePrice(input.entryPrice) || !Number.isFinite(input.currentPrice)) {
    return { reason: null, pnlPct: 0 };
  }
  const pnlPct = (input.currentPrice - input.entryPrice) / input.entryPrice;
  return { reason: firstExitReason(input, pnlPct), pnlPct };
}

function usablePrice(price: number): boolean {
  return Number.isFinite(price) && price > 0;
}

/**
 * Exit precedence, most protective first: emergency TP, out-of-range, TP,
 * break-even floor. Emergency is checked before the ordinary target so the
 * label always names the tighter rule that fired.
 */
function firstExitReason(input: RunnerExitInput, pnlPct: number): RunnerExitReason | null {
  const emergency = input.emergencyTakeProfitPct ?? RUNNER_PRESET_EMERGENCY_TP_PCT;
  const takeProfit = input.takeProfitPct ?? emergency;
  const floor = input.breakEvenFloorPct ?? RUNNER_PRESET_BREAK_EVEN_FLOOR_PCT;
  if (pnlPct + RATIO_EPSILON >= emergency) return "emergency-take-profit";
  if (!input.inRange) return "out-of-range";
  if (pnlPct + RATIO_EPSILON >= takeProfit) return "take-profit";
  if (pnlPct + RATIO_EPSILON >= floor) return "break-even";
  return null;
}
