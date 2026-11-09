/**
 * Pure fact derivation for the decision path (kernel Phase 1).
 *
 * Everything here is a deterministic projection of data the cycle already
 * fetched: no Effect, no services, no clock, no I/O. `evaluatePool` assembles
 * these facts once and reads them instead of re-deriving values inline, and the
 * decision kernel consumes the same shapes (see `engine/decision/types.ts`).
 *
 * Unknown stays unknown: a missing metric keeps its `*Known = false` flag and a
 * missing drift is `null`, never 0-as-known.
 */
import type { PoolMetrics, PoolState } from "../types.js";
import type { PositionRecord } from "../db-service.js";
import type { PoolFacts, PositionFacts } from "../decision/types.js";
import { computeHodlValueUsd } from "../pnl.js";
import { computeBinVolatilityStddev } from "../strategy-service.js";

/** Net active-bin drift + realized volatility over the recent-bin ring. */
export interface PoolDriftMetrics {
  readonly netDriftBins: number;
  readonly volatilityStddev: number;
  readonly volatilityBins: ReadonlyArray<number>;
  readonly recentBins: ReadonlyArray<number>;
}

/**
 * Net drift is the last-minus-first active bin over the ring — the momentum
 * signal shared by the entry-shape resolution, the drift gate and runner
 * admission. A ring with fewer than two observations reports drift 0 (cold
 * start); callers that must fail open on unknown drift also receive the empty
 * `recentBins` so they can tell the cases apart.
 */
export function resolvePoolDriftMetrics(
  binHistory: ReadonlyMap<string, ReadonlyArray<number>>,
  poolAddress: string,
  volatilityLookbackSnapshots: number,
): PoolDriftMetrics {
  const recentBins = binHistory.get(poolAddress) ?? [];
  const netDriftBins =
    recentBins.length >= 2 ? recentBins[recentBins.length - 1]! - recentBins[0]! : 0;
  const lookback = Math.max(2, volatilityLookbackSnapshots);
  const volatilityBins =
    recentBins.length > lookback ? recentBins.slice(recentBins.length - lookback) : recentBins;
  return {
    netDriftBins,
    volatilityStddev: computeBinVolatilityStddev(volatilityBins),
    volatilityBins,
    recentBins,
  };
}

/**
 * HODL benchmark at the current price, or null when the position predates the
 * entry-leg migration (v16) or its entry price is unusable. A zero entry leg is
 * NOT unknown: it produces the benchmark of the single held leg.
 */
export function hodlBenchmarkUsd(pos: PositionRecord, currentPriceUsd: number): number | null {
  if (pos.entryAmountXUsd == null || pos.entryAmountYUsd == null || pos.entryPriceUsd == null) {
    return null;
  }
  return computeHodlValueUsd(
    pos.entryAmountXUsd,
    pos.entryAmountYUsd,
    pos.entryPriceUsd,
    currentPriceUsd,
  );
}

/** Canonical pool facts for one decision cycle (identity projection, no math). */
export function assemblePoolFacts(input: {
  readonly pool: PoolState;
  readonly metrics: PoolMetrics;
}): PoolFacts {
  const { pool, metrics } = input;
  return {
    poolAddress: pool.address,
    activeBinId: pool.activeBinId,
    tvlUsd: pool.tvlUsd,
    tvlVelocity: metrics.tvlVelocity,
    fees24hUsd: pool.fees24hUsd,
    feeIlRatio: metrics.feeIlRatio,
    feeIlRatioKnown: metrics.feeIlRatioKnown,
    volumeAuthenticity: metrics.volumeAuthenticity,
    volumeAuthenticityKnown: metrics.volumeAuthenticityKnown,
    binUtilization: metrics.binUtilization,
    binUtilizationKnown: metrics.binUtilizationKnown,
    netDriftBins: metrics.netDriftBins ?? null,
  };
}

/** Canonical facts for one tracked position; `hodlValueUsd` may be unknown. */
export function assemblePositionFacts(
  pos: PositionRecord,
  hodlValueUsd: number | null,
): PositionFacts {
  return {
    positionId: pos.positionId,
    poolAddress: pos.poolAddress,
    lowerBinId: pos.lowerBinId,
    upperBinId: pos.upperBinId,
    openedAt: pos.timestamp,
    depositedUsd: pos.depositedUsd,
    currentValueUsd: pos.currentValueUsd,
    highestValueUsd: pos.highestValueUsd ?? pos.depositedUsd,
    cumulativeFeesClaimedUsd: pos.cumulativeFeesClaimedUsd,
    cumulativeRewardsClaimedUsd: pos.cumulativeRewardsClaimedUsd,
    outOfRangeSince: pos.outOfRangeSince,
    hodlValueUsd,
  };
}
