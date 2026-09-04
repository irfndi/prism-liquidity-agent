/** @file Launch gate: turns a hot-DLMM-pool discovery snapshot into a
 * ranked launch candidate set. Pure and unit-testable — no Effect, no
 * network.
 *
 * v1 is radar/screening only: this gate decides WHICH young pools are hot
 * enough to surface on the launch radar, ranked by 1h fee yield. It fails
 * CLOSED on missing launch-critical data (createdAt, 1h fee yield, 1h
 * volume, base fee) — unlike the market gate, an absent hotness metric is a
 * rejection, because hotness is the entire point. Token-leg safety reuses
 * the market gate's leg policy verbatim (fail-open on absent metadata; the
 * per-pool screen still gates ENTER).
 */

import type { DiscoveredPool } from "./services.js";
import { isStableOrSol, marketLegPasses } from "./market-gate.js";

const HOUR_MS = 3_600_000;
// The pool's createdAt comes from the Meteora API clock, config.now from the
// engine host — allow a small skew so a pool created moments ago on the API
// clock is not rejected as "in the future" when the host clock lags.
const CLOCK_SKEW_MS = 60_000;

export interface LaunchGateConfig {
  readonly minTvlUsd: number;
  readonly maxTvlUsd: number;
  readonly maxAgeHours: number;
  readonly minVolume1hUsd: number;
  readonly minBaseFeePct: number;
  readonly minBinStep: number;
  readonly maxBinStep: number;
  /** Max 24h-volume/TVL turnover; above this is wash-trading. */
  readonly maxVolumeTurnover: number;
  /** Minimum holders for a non-stable, non-SOL leg (rug/IL pre-filter). */
  readonly minHolders: number;
  readonly stablecoinMints: ReadonlySet<string>;
  /** Current wall-clock ms (injected for determinism/testability). */
  readonly now: number;
}

export interface LaunchPoolRank {
  readonly pool: DiscoveredPool;
  /** 1h fee/TVL ratio percent (fee_tvl_ratio_1h) — the hotness metric. */
  readonly feeYield1hPct: number;
  readonly volume1hUsd: number;
  /** Rank score: feeYield1hPct (higher = hotter). */
  readonly score: number;
  /** Why the pool was admitted (first N flags). */
  readonly notes: ReadonlyArray<string>;
}

export interface LaunchGateResult {
  readonly ranked: ReadonlyArray<LaunchPoolRank>;
  /** Pools that failed the gate: the first rejection reason each, bucketed
   *  by a STABLE category (reason strings embed per-pool values like ages
   *  and TVLs, so histograms must group by category, not full string). */
  readonly rejected: ReadonlyArray<{
    readonly address: string;
    readonly reason: string;
    readonly category: LaunchRejectCategory;
  }>;
}

/** Stable rejection categories — the histogram keys. */
export type LaunchRejectCategory =
  | "missing-data"
  | "created-at"
  | "age"
  | "tvl"
  | "volume-1h"
  | "base-fee"
  | "bin-step"
  | "turnover"
  | "token-safety";

/**
 * Top-N rejection categories with counts — the radar's observable answer to
 * "why did the universe admit nothing". Groups by the stable category, not
 * the value-embedded reason string (which would fragment one cause into a
 * thousand buckets). Each bucket keeps ONE representative reason so the
 * near-miss margin survives ('age 5.9h > 6h' vs 'age 40h > 6h' — same
 * bucket, distinguishable example). Pure, extracted for testability.
 */
export function summarizeLaunchRejections(
  rejected: ReadonlyArray<{ readonly category: LaunchRejectCategory; readonly reason: string }>,
  topN = 6,
): ReadonlyArray<{
  readonly category: LaunchRejectCategory;
  readonly count: number;
  readonly example: string;
}> {
  const counts = new Map<LaunchRejectCategory, { count: number; example: string }>();
  for (const r of rejected) {
    const entry = counts.get(r.category);
    if (entry === undefined) counts.set(r.category, { count: 1, example: r.reason });
    else entry.count += 1;
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, Math.max(topN, 1))
    .map(([category, { count, example }]) => ({ category, count, example }));
}

/** Per-pool launch admission outcome. Pass carries the derived metrics the
 *  rank notes need; fail carries the first rejection (reason + category). */
type LaunchAdmissionOutcome =
  | { readonly passed: true; readonly ageHours: number; readonly volumeTurnover: number }
  | {
      readonly passed: false;
      readonly reason: string;
      readonly category: LaunchRejectCategory;
    };

function isUnknownFeeYield(pool: DiscoveredPool): boolean {
  return pool.feeYield1hPct === undefined || !Number.isFinite(pool.feeYield1hPct);
}

function isFutureCreatedAt(createdAtMs: number, now: number): boolean {
  return !Number.isFinite(createdAtMs) || createdAtMs > now + CLOCK_SKEW_MS;
}

function isBelowLaunchTvlFloor(pool: DiscoveredPool, config: LaunchGateConfig): boolean {
  return !Number.isFinite(pool.tvlUsd) || pool.tvlUsd < config.minTvlUsd;
}

function isThin1hVolume(pool: DiscoveredPool, config: LaunchGateConfig): boolean {
  return (
    pool.volume1hUsd === undefined ||
    !Number.isFinite(pool.volume1hUsd) ||
    pool.volume1hUsd < config.minVolume1hUsd
  );
}

function isThinBaseFee(pool: DiscoveredPool, config: LaunchGateConfig): boolean {
  return (
    pool.baseFeePct === undefined ||
    !Number.isFinite(pool.baseFeePct) ||
    pool.baseFeePct < config.minBaseFeePct
  );
}

function isBinStepOutsideLaunchBand(pool: DiscoveredPool, config: LaunchGateConfig): boolean {
  return (
    !Number.isInteger(pool.binStep) ||
    pool.binStep < config.minBinStep ||
    pool.binStep > config.maxBinStep
  );
}

function hasNo24hVolume(pool: DiscoveredPool): boolean {
  return !Number.isFinite(pool.volume24hUsd) || pool.volume24hUsd <= 0;
}

/** Token-leg safety, same policy as the market gate. Returns the rejection
 *  reason of the first failing leg, or null when both legs pass. */
function launchLegRejectReason(pool: DiscoveredPool, config: LaunchGateConfig): string | null {
  const legs = [
    {
      mint: pool.tokenX,
      symbol: pool.tokenXSymbol,
      verified: pool.tokenXVerified,
      freezeDisabled: pool.tokenXFreezeDisabled,
      holders: pool.tokenXHolders,
    },
    {
      mint: pool.tokenY,
      symbol: pool.tokenYSymbol,
      verified: pool.tokenYVerified,
      freezeDisabled: pool.tokenYFreezeDisabled,
      holders: pool.tokenYHolders,
    },
  ];
  for (const leg of legs) {
    if (
      !marketLegPasses(
        {
          isStableOrSol: isStableOrSol(leg.mint, config.stablecoinMints),
          verified: leg.verified,
          freezeDisabled: leg.freezeDisabled,
          holders: leg.holders,
        },
        config.minHolders,
      )
    ) {
      return `leg ${leg.symbol ?? leg.mint} fails token safety`;
    }
  }
  return null;
}

function poolAgeHours(createdAtMs: number | undefined, now: number): number {
  if (createdAtMs === undefined) return 0;
  return Math.max(0, now - createdAtMs) / HOUR_MS;
}

function rejectMissingData(pool: DiscoveredPool): LaunchAdmissionOutcome | null {
  if (isUnknownFeeYield(pool)) {
    return { passed: false, reason: "missing 1h fee yield", category: "missing-data" };
  }
  if (pool.createdAtMs === undefined) {
    return { passed: false, reason: "missing createdAt", category: "missing-data" };
  }
  return null;
}

function rejectBadAge(
  pool: DiscoveredPool,
  config: LaunchGateConfig,
): LaunchAdmissionOutcome | null {
  if (pool.createdAtMs === undefined) return null;
  if (isFutureCreatedAt(pool.createdAtMs, config.now)) {
    return {
      passed: false,
      reason: `createdAt ${pool.createdAtMs} in the future`,
      category: "created-at",
    };
  }
  const ageHours = poolAgeHours(pool.createdAtMs, config.now);
  if (ageHours > config.maxAgeHours) {
    return {
      passed: false,
      reason: `age ${ageHours.toFixed(1)}h > ${config.maxAgeHours}h`,
      category: "age",
    };
  }
  return null;
}

function rejectBadTvl(
  pool: DiscoveredPool,
  config: LaunchGateConfig,
): LaunchAdmissionOutcome | null {
  if (isBelowLaunchTvlFloor(pool, config)) {
    return { passed: false, reason: `tvl ${pool.tvlUsd} < ${config.minTvlUsd}`, category: "tvl" };
  }
  if (pool.tvlUsd > config.maxTvlUsd) {
    return {
      passed: false,
      reason: `tvl ${pool.tvlUsd} > ${config.maxTvlUsd} (established, not a launch)`,
      category: "tvl",
    };
  }
  return null;
}

function rejectThinFlow(
  pool: DiscoveredPool,
  config: LaunchGateConfig,
): LaunchAdmissionOutcome | null {
  if (isThin1hVolume(pool, config)) {
    return {
      passed: false,
      reason: `1h volume ${pool.volume1hUsd} < ${config.minVolume1hUsd}`,
      category: "volume-1h",
    };
  }
  if (isThinBaseFee(pool, config)) {
    return {
      passed: false,
      reason: `base fee ${pool.baseFeePct} < ${config.minBaseFeePct}%`,
      category: "base-fee",
    };
  }
  if (isBinStepOutsideLaunchBand(pool, config)) {
    return {
      passed: false,
      reason: `binStep ${pool.binStep} outside [${config.minBinStep}, ${config.maxBinStep}]`,
      category: "bin-step",
    };
  }
  return null;
}

function rejectWashTurnover(
  pool: DiscoveredPool,
  config: LaunchGateConfig,
): LaunchAdmissionOutcome | null {
  // Wash-turnover guard: 24h volume/TVL must land in (0, max].
  if (hasNo24hVolume(pool)) {
    return {
      passed: false,
      reason: "no 24h volume (cannot compute turnover)",
      category: "turnover",
    };
  }
  const volumeTurnover = pool.volume24hUsd / pool.tvlUsd;
  if (volumeTurnover > config.maxVolumeTurnover) {
    return {
      passed: false,
      reason: `volume turnover ${volumeTurnover.toFixed(1)} > ${config.maxVolumeTurnover} (wash)`,
      category: "turnover",
    };
  }
  return null;
}

/** Ordered launch admission checks — rejection order, reason strings and
 *  stable categories are contractual (radar histograms bucket on category). */
function launchAdmission(pool: DiscoveredPool, config: LaunchGateConfig): LaunchAdmissionOutcome {
  // Fail closed on missing data — hotness is the point. Stage order, reason
  // strings and stable categories are contractual (radar histograms bucket
  // on category); each stage below preserves them in order.
  const missing = rejectMissingData(pool);
  if (missing !== null) return missing;
  const age = rejectBadAge(pool, config);
  if (age !== null) return age;
  const tvl = rejectBadTvl(pool, config);
  if (tvl !== null) return tvl;
  const flow = rejectThinFlow(pool, config);
  if (flow !== null) return flow;
  const turnover = rejectWashTurnover(pool, config);
  if (turnover !== null) return turnover;
  const legReason = launchLegRejectReason(pool, config);
  if (legReason !== null) {
    return { passed: false, reason: legReason, category: "token-safety" };
  }
  return {
    passed: true,
    ageHours: poolAgeHours(pool.createdAtMs, config.now),
    volumeTurnover: pool.volume24hUsd / pool.tvlUsd,
  };
}

/** Admission already rejected pools missing these metrics; a fail-closed 0
 *  backstop only satisfies the rank contract if that invariant ever breaks. */
function admissionSafe(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}

/** Gates and ranks one launch-radar snapshot. Pure; callers feed it the
 *  adapter's `discoverHotPools` output. */
export function gateAndRankLaunchPools(
  pools: ReadonlyArray<DiscoveredPool>,
  config: LaunchGateConfig,
): LaunchGateResult {
  const ranked: LaunchPoolRank[] = [];
  const rejected: Array<{
    readonly address: string;
    readonly reason: string;
    readonly category: LaunchRejectCategory;
  }> = [];

  for (const pool of pools) {
    const admission = launchAdmission(pool, config);
    if (!admission.passed) {
      rejected.push({
        address: pool.address,
        reason: admission.reason,
        category: admission.category,
      });
      continue;
    }
    ranked.push({
      pool,
      // Unreachable in practice: launchAdmission rejects pools with missing
      // fee yield / 1h volume (missing-data category) before rank
      feeYield1hPct: admissionSafe(pool.feeYield1hPct),
      volume1hUsd: admissionSafe(pool.volume1hUsd),
      score: admissionSafe(pool.feeYield1hPct),
      notes: [
        `age ${admission.ageHours.toFixed(1)}h`,
        `turnover ${admission.volumeTurnover.toFixed(2)}`,
      ],
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  return { ranked, rejected };
}
