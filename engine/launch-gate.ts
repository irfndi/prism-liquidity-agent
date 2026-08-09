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
    const reject = (reason: string, category: LaunchRejectCategory): void => {
      rejected.push({ address: pool.address, reason, category });
    };

    // Fail closed on missing data — hotness is the point.
    if (pool.feeYield1hPct === undefined || !Number.isFinite(pool.feeYield1hPct)) {
      reject("missing 1h fee yield", "missing-data");
      continue;
    }
    if (pool.createdAtMs === undefined) {
      reject("missing createdAt", "missing-data");
      continue;
    }
    if (!Number.isFinite(pool.createdAtMs) || pool.createdAtMs > config.now + CLOCK_SKEW_MS) {
      reject(`createdAt ${pool.createdAtMs} in the future`, "created-at");
      continue;
    }
    const ageHours = Math.max(0, config.now - pool.createdAtMs) / HOUR_MS;
    if (ageHours > config.maxAgeHours) {
      reject(`age ${ageHours.toFixed(1)}h > ${config.maxAgeHours}h`, "age");
      continue;
    }
    if (!Number.isFinite(pool.tvlUsd) || pool.tvlUsd < config.minTvlUsd) {
      reject(`tvl ${pool.tvlUsd} < ${config.minTvlUsd}`, "tvl");
      continue;
    }
    if (pool.tvlUsd > config.maxTvlUsd) {
      reject(`tvl ${pool.tvlUsd} > ${config.maxTvlUsd} (established, not a launch)`, "tvl");
      continue;
    }
    if (
      pool.volume1hUsd === undefined ||
      !Number.isFinite(pool.volume1hUsd) ||
      pool.volume1hUsd < config.minVolume1hUsd
    ) {
      reject(`1h volume ${pool.volume1hUsd} < ${config.minVolume1hUsd}`, "volume-1h");
      continue;
    }
    if (
      pool.baseFeePct === undefined ||
      !Number.isFinite(pool.baseFeePct) ||
      pool.baseFeePct < config.minBaseFeePct
    ) {
      reject(`base fee ${pool.baseFeePct} < ${config.minBaseFeePct}%`, "base-fee");
      continue;
    }
    if (
      !Number.isInteger(pool.binStep) ||
      pool.binStep < config.minBinStep ||
      pool.binStep > config.maxBinStep
    ) {
      reject(
        `binStep ${pool.binStep} outside [${config.minBinStep}, ${config.maxBinStep}]`,
        "bin-step",
      );
      continue;
    }
    // Wash-turnover guard: 24h volume/TVL must land in (0, max].
    if (!Number.isFinite(pool.volume24hUsd) || pool.volume24hUsd <= 0) {
      reject("no 24h volume (cannot compute turnover)", "turnover");
      continue;
    }
    const volumeTurnover = pool.volume24hUsd / pool.tvlUsd;
    if (volumeTurnover > config.maxVolumeTurnover) {
      reject(
        `volume turnover ${volumeTurnover.toFixed(1)} > ${config.maxVolumeTurnover} (wash)`,
        "turnover",
      );
      continue;
    }
    // Token-leg safety, same policy as the market gate.
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
    let legRejected = false;
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
        reject(`leg ${leg.symbol ?? leg.mint} fails token safety`, "token-safety");
        legRejected = true;
        break;
      }
    }
    if (legRejected) continue;

    const notes: string[] = [
      `age ${ageHours.toFixed(1)}h`,
      `turnover ${volumeTurnover.toFixed(2)}`,
    ];
    ranked.push({
      pool,
      feeYield1hPct: pool.feeYield1hPct,
      volume1hUsd: pool.volume1hUsd,
      score: pool.feeYield1hPct,
      notes,
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  return { ranked, rejected };
}
