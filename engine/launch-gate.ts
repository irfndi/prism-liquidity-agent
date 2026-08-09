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
  /** Pools that failed the gate, with the first rejection reason each. */
  readonly rejected: ReadonlyArray<{ readonly address: string; readonly reason: string }>;
}

/** Gates and ranks one launch-radar snapshot. Pure; callers feed it the
 *  adapter's `discoverHotPools` output. */
export function gateAndRankLaunchPools(
  pools: ReadonlyArray<DiscoveredPool>,
  config: LaunchGateConfig,
): LaunchGateResult {
  const ranked: LaunchPoolRank[] = [];
  const rejected: Array<{ readonly address: string; readonly reason: string }> = [];

  for (const pool of pools) {
    const reject = (reason: string): void => {
      rejected.push({ address: pool.address, reason });
    };

    // Fail closed on missing data — hotness is the point.
    if (pool.feeYield1hPct === undefined || !Number.isFinite(pool.feeYield1hPct)) {
      reject("missing 1h fee yield");
      continue;
    }
    if (pool.createdAtMs === undefined) {
      reject("missing createdAt");
      continue;
    }
    if (!Number.isFinite(pool.createdAtMs) || pool.createdAtMs > config.now) {
      reject(`createdAt ${pool.createdAtMs} in the future`);
      continue;
    }
    const ageHours = (config.now - pool.createdAtMs) / HOUR_MS;
    if (ageHours > config.maxAgeHours) {
      reject(`age ${ageHours.toFixed(1)}h > ${config.maxAgeHours}h`);
      continue;
    }
    if (!Number.isFinite(pool.tvlUsd) || pool.tvlUsd < config.minTvlUsd) {
      reject(`tvl ${pool.tvlUsd} < ${config.minTvlUsd}`);
      continue;
    }
    if (pool.tvlUsd > config.maxTvlUsd) {
      reject(`tvl ${pool.tvlUsd} > ${config.maxTvlUsd} (established, not a launch)`);
      continue;
    }
    if (
      pool.volume1hUsd === undefined ||
      !Number.isFinite(pool.volume1hUsd) ||
      pool.volume1hUsd < config.minVolume1hUsd
    ) {
      reject(`1h volume ${pool.volume1hUsd} < ${config.minVolume1hUsd}`);
      continue;
    }
    if (
      pool.baseFeePct === undefined ||
      !Number.isFinite(pool.baseFeePct) ||
      pool.baseFeePct < config.minBaseFeePct
    ) {
      reject(`base fee ${pool.baseFeePct} < ${config.minBaseFeePct}%`);
      continue;
    }
    if (
      !Number.isInteger(pool.binStep) ||
      pool.binStep < config.minBinStep ||
      pool.binStep > config.maxBinStep
    ) {
      reject(`binStep ${pool.binStep} outside [${config.minBinStep}, ${config.maxBinStep}]`);
      continue;
    }
    // Wash-turnover guard: 24h volume/TVL must land in (0, max].
    if (!Number.isFinite(pool.volume24hUsd) || pool.volume24hUsd <= 0) {
      reject("no 24h volume (cannot compute turnover)");
      continue;
    }
    const volumeTurnover = pool.volume24hUsd / pool.tvlUsd;
    if (volumeTurnover > config.maxVolumeTurnover) {
      reject(`volume turnover ${volumeTurnover.toFixed(1)} > ${config.maxVolumeTurnover} (wash)`);
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
        reject(`leg ${leg.symbol ?? leg.mint} fails token safety`);
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
