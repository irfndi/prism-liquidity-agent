import type { PoolSnapshot } from "./types.js";

/** Minimum snapshot-window span before a measured drift replaces the proxy.
 * Below this the window annualizes minutes of jitter (same ×720/day pathology
 * the fee-window anchor fixed for established pools), so the caller falls back
 * to the stable binStep proxy instead. */
export const MIN_FEE_WINDOW_SPAN_MS = 3_600_000;

type DriftAnchor = Pick<PoolSnapshot, "currentPrice" | "timestamp">;

/** Price-drift context for fee/IL metrics, anchored to the fee window.
 * feeIl compares the trailing-24h FEE figure against IL over the SAME window,
 * so the drift endpoint must be the oldest snapshot INSIDE that window —
 * not the previous cycle. The old per-cycle anchor (elapsed ≈ 2min ×720/day)
 * annualized 2 minutes of jitter into a full day: a ±0.1% cycle wiggle read
 * as ±72%/day of phantom IL and the ratio whipsawed the floor (232/245 live
 * reads pinned at the 20 cap). A 24h endpoint measures the path the fees
 * actually priced; jitter cancels instead of compounding. Returns undefined
 * on cold start AND when the window spans less than MIN_FEE_WINDOW_SPAN_MS
 * (a young pool's minutes-long window would annualize the same jitter) —
 * both fall through to the stable binStep proxy in estimateDailyIlUsd. */
export function snapshotPriceDrift(
  previousSnapshots: ReadonlyArray<DriftAnchor>,
  previousSnapshot: DriftAnchor | undefined,
): { readonly previousPrice: number; readonly previousTimestamp: number } | undefined {
  const anchor = previousSnapshots.length > 0 ? previousSnapshots[0] : previousSnapshot;
  if (anchor === undefined) return undefined;
  const latestTimestamp = previousSnapshot?.timestamp ?? anchor.timestamp;
  if (latestTimestamp - anchor.timestamp < MIN_FEE_WINDOW_SPAN_MS) return undefined;
  return {
    previousPrice: anchor.currentPrice,
    previousTimestamp: anchor.timestamp,
  };
}

/** Merge one pool set into the active scan list without duplicates. */
export function mergePoolSet(target: Array<string>, poolSet: ReadonlySet<string>): void {
  for (const poolAddress of poolSet) {
    if (!target.includes(poolAddress)) target.push(poolAddress);
  }
}

/** Pure active-scan-set assembly: approved snapshot + market top-K + eligible
 * autonomous candidates + fallen-angel candidates + launch pools, plus every
 * held pool. Held pools must survive every rebuild: a pool that drops out of
 * the market top-K while a position is still open needs its protective exits
 * (timebox/max-age/fee-il) evaluated until it actually closes. Pure so the
 * held-pool survival invariant is unit-testable without the program harness. */
export function buildActiveScanSet(args: {
  readonly approvedPoolAddresses: ReadonlyArray<string>;
  readonly marketScanPools: ReadonlySet<string>;
  readonly autonomousCandidatePools: ReadonlySet<string>;
  readonly fallenAngelCandidatePools: ReadonlySet<string>;
  readonly launchScanPools: ReadonlySet<string>;
  readonly heldPoolAddresses: ReadonlySet<string>;
}): Array<string> {
  const active = [...args.approvedPoolAddresses];
  mergePoolSet(active, args.marketScanPools);
  mergePoolSet(active, args.autonomousCandidatePools);
  mergePoolSet(active, args.fallenAngelCandidatePools);
  mergePoolSet(active, args.launchScanPools);
  mergePoolSet(active, args.heldPoolAddresses);
  return active;
}
