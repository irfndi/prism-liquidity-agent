/** @file Market-scan gate: turns a raw universe snapshot into a ranked,
 * IL-safe candidate set. Pure and unit-testable — no Effect, no network.
 *
 * The per-pool scan loop remains the source of truth: it re-applies the full
 * safety screening (blacklist / freeze / token-risk overlay), metrics
 * (volume authenticity, fee/IL, bin utilization) and risk gates before any
 * ENTER. This gate only decides WHO gets scanned, ranked by economics with
 * a token-safety pre-filter so risky legs do not burn scan cycles.
 */

import type { DiscoveredPool } from "./services.js";

export interface MarketGateConfig {
  readonly minTvlUsd: number;
  /** Minimum annualized fee/TVL percent: fees24h × 365 / tvl × 100. */
  readonly minFeeApr: number;
  /** Minimum daily volume/TVL ratio (wash-trading and dead-pool guard). */
  readonly minVolumeTurnover: number;
  readonly maxVolumeTurnover: number;
  /** Minimum holders for a non-stable, non-SOL leg (rug/IL pre-filter). */
  readonly minHolders: number;
  readonly minBinStep: number;
  readonly maxBinStep: number;
  readonly stablecoinMints: ReadonlySet<string>;
}

export const SOL_MINT = "So11111111111111111111111111111111111111112";

export interface MarketPoolRank {
  readonly pool: DiscoveredPool;
  /** Annualized fee/TVL percent (the profit engine of an LP position). */
  readonly feeAprPct: number;
  /** Daily volume/TVL turnover ratio. */
  readonly volumeTurnover: number;
  /** Composite rank: feeAprPct × liquidity factor. Higher = better. */
  readonly score: number;
  /** Why the pool was admitted (first N flags). */
  readonly notes: ReadonlyArray<string>;
}

export interface MarketGateResult {
  readonly ranked: ReadonlyArray<MarketPoolRank>;
  /** Pools that failed the gate, with the first rejection reason each. */
  readonly rejected: ReadonlyArray<{ readonly address: string; readonly reason: string }>;
}

function isStableOrSol(mint: string, stablecoinMints: ReadonlySet<string>): boolean {
  return mint === SOL_MINT || stablecoinMints.has(mint);
}

/**
 * Token-safety pre-filter for one leg. Mirrors the engine's freeze/verification
 * policy at the DISCOVERY layer (fail-open when metadata is absent — the
 * per-pool screen still gates ENTER):
 * - Stablecoins and SOL: always pass (the stablecoin allowlist exemption).
 * - Verified + freeze-disabled: pass.
 * - Verified but freeze-enabled: pass only when the holder base is real
 *   (freeze authority on a verified token is an operator trust decision).
 * - Unverified: pass only when freeze-disabled AND holders >= minHolders.
 */
export function marketLegPasses(
  leg: {
    readonly isStableOrSol: boolean;
    readonly verified: boolean | undefined;
    readonly freezeDisabled: boolean | undefined;
    readonly holders: number | undefined;
  },
  minHolders: number,
): boolean {
  if (leg.isStableOrSol) return true;
  if (leg.verified === true) {
    // Verified: freeze-disabled always passes. A KNOWN freeze-enabled token
    // still needs a real holder base (operator trust decision); an ABSENT
    // holder count is unknown, not 0 — fail open (the per-pool screen still
    // gates ENTER).
    return leg.freezeDisabled === false
      ? leg.holders === undefined || leg.holders >= minHolders
      : true;
  }
  // Unverified leg: reject only a KNOWN freeze-enabled token; otherwise the
  // holder base must be real. Absent metadata (undefined) is fail-open —
  // `(holders ?? 0)` would fabricate a rejection for legacy metadata-less
  // mappings.
  if (leg.freezeDisabled === false) return false;
  return leg.holders === undefined || leg.holders >= minHolders;
}

/** Gates and ranks one universe snapshot. Pure; callers feed it the adapter's
 *  `discoverPoolsTopPages` output. */
export function gateAndRankMarketPools(
  pools: ReadonlyArray<DiscoveredPool>,
  config: MarketGateConfig,
): MarketGateResult {
  const ranked: MarketPoolRank[] = [];
  const rejected: Array<{ readonly address: string; readonly reason: string }> = [];

  for (const pool of pools) {
    const reject = (reason: string): void => {
      rejected.push({ address: pool.address, reason });
    };

    if (!Number.isFinite(pool.tvlUsd) || pool.tvlUsd < config.minTvlUsd) {
      reject(`tvl ${pool.tvlUsd} < ${config.minTvlUsd}`);
      continue;
    }
    if (!Number.isFinite(pool.fees24hUsd) || pool.fees24hUsd <= 0) {
      reject("no 24h fees");
      continue;
    }
    const feeAprPct = (pool.fees24hUsd * 365 * 100) / pool.tvlUsd;
    if (feeAprPct < config.minFeeApr) {
      reject(`fee APR ${feeAprPct.toFixed(1)}% < ${config.minFeeApr}%`);
      continue;
    }
    if (!Number.isFinite(pool.volume24hUsd) || pool.volume24hUsd <= 0) {
      reject("no 24h volume");
      continue;
    }
    const volumeTurnover = pool.volume24hUsd / pool.tvlUsd;
    if (volumeTurnover < config.minVolumeTurnover) {
      reject(`volume turnover ${volumeTurnover.toFixed(2)} < ${config.minVolumeTurnover}`);
      continue;
    }
    if (volumeTurnover > config.maxVolumeTurnover) {
      reject(`volume turnover ${volumeTurnover.toFixed(1)} > ${config.maxVolumeTurnover} (wash)`);
      continue;
    }
    if (!Number.isInteger(pool.binStep) || pool.binStep < config.minBinStep) {
      reject(`binStep ${pool.binStep} < ${config.minBinStep} (ultra-fine churn)`);
      continue;
    }
    if (pool.binStep > config.maxBinStep) {
      reject(`binStep ${pool.binStep} > ${config.maxBinStep}`);
      continue;
    }
    const xPasses = marketLegPasses(
      {
        isStableOrSol: isStableOrSol(pool.tokenX, config.stablecoinMints),
        verified: pool.tokenXVerified,
        freezeDisabled: pool.tokenXFreezeDisabled,
        holders: pool.tokenXHolders,
      },
      config.minHolders,
    );
    if (!xPasses) {
      reject(
        `leg ${pool.tokenXSymbol ?? pool.tokenX} fails token safety (verified=${pool.tokenXVerified}, freezeDisabled=${pool.tokenXFreezeDisabled}, holders=${pool.tokenXHolders})`,
      );
      continue;
    }
    const yPasses = marketLegPasses(
      {
        isStableOrSol: isStableOrSol(pool.tokenY, config.stablecoinMints),
        verified: pool.tokenYVerified,
        freezeDisabled: pool.tokenYFreezeDisabled,
        holders: pool.tokenYHolders,
      },
      config.minHolders,
    );
    if (!yPasses) {
      reject(
        `leg ${pool.tokenYSymbol ?? pool.tokenY} fails token safety (verified=${pool.tokenYVerified}, freezeDisabled=${pool.tokenYFreezeDisabled}, holders=${pool.tokenYHolders})`,
      );
      continue;
    }

    // Composite rank: fee APR is the profit engine; TVL adds a liquidity
    // factor (deeper pools → less IL per dollar and more stable fees), capped
    // so a 5×-APR small pool still outranks a deep slow pool.
    const liquidityFactor = Math.min(Math.max(Math.log10(pool.tvlUsd) / 6, 0.6), 1.4);
    const score = feeAprPct * liquidityFactor;
    const notes: string[] = [
      `fee APR ${feeAprPct.toFixed(1)}%`,
      `turnover ${volumeTurnover.toFixed(2)}`,
    ];
    ranked.push({ pool, feeAprPct, volumeTurnover, score, notes });
  }

  ranked.sort((a, b) => b.score - a.score);
  return { ranked, rejected };
}
