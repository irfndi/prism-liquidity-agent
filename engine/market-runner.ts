/** Market-runner lane: high-yield rotation for the market scan.
 *
 * A market-scan pool whose MEASURED (datapi) fee APR clears the runner floor
 * enters with the LAUNCH posture (time-boxed, dip-anchored, scale-in) instead
 * of the flat normal posture — the engine holds HIGH-YIELD pools rather than
 * flat majors. The rotation exits the lowest-APR held position when the
 * portfolio is full and a much hotter runner is available.
 *
 * Pure module (like market-gate.ts / launch-gate.ts): no Effect services,
 * deterministic tests.
 */

export const DEFAULT_RUNNER_MIN_FEE_APR = 500;
export const DEFAULT_ROTATION_APR_MULT = 5;

/** A market-scan pool is a RUNNER when the lane is enabled, the pool is in
 * the market scan set, its fees are MEASURED (datapi — modeled gecko /
 * heuristic fees never classify, same measured-only exclusion as paper fee
 * accrual), and its fee APR clears the runner floor. */
export function isMarketRunnerPool(params: {
  enabled: boolean;
  marketScanPools: ReadonlySet<string>;
  poolAddress: string;
  statsSource: string | undefined;
  feeAprPct: number;
  runnerMinFeeApr: number | undefined;
}): boolean {
  if (!params.enabled) return false;
  if (!params.marketScanPools.has(params.poolAddress)) return false;
  if (params.statsSource !== "datapi") return false;
  return params.feeAprPct >= (params.runnerMinFeeApr ?? DEFAULT_RUNNER_MIN_FEE_APR);
}

export interface HeldPositionApr {
  readonly poolAddress: string;
  readonly feeAprPct: number;
  /** Pool TVL at the last evaluation — the net-fee capture model needs it to
   * estimate the position's share of fees (small entries on deep pools
   * capture a fraction of the headline APR). */
  readonly tvlUsd: number;
}

/** The lowest-APR held position, or null when every held position's APR is
 * unknown/zero (nothing to rotate out of). Unmeasured held pools never
 * rotate — fail-closed, a made-up-low APR must not sell a real position.
 * `excludePoolAddress` (the candidate runner) is never a rotation target —
 * a held position on the runner pool must not be exited while the same pool
 * re-enters in the same cycle. */
export function lowestAprHeldPosition(
  positions: Iterable<{ readonly poolAddress: string }>,
  poolAprByAddress: ReadonlyMap<string, { feeAprPct: number; tvlUsd: number }>,
  excludePoolAddress?: string,
): HeldPositionApr | null {
  let worst: HeldPositionApr | null = null;
  for (const pos of positions) {
    if (pos.poolAddress === excludePoolAddress) continue;
    const entry = poolAprByAddress.get(pos.poolAddress);
    if (!entry) continue;
    const apr = entry.feeAprPct;
    if (apr <= 0) continue;
    if (!worst || apr < worst.feeAprPct) {
      worst = { poolAddress: pos.poolAddress, feeAprPct: apr, tvlUsd: entry.tvlUsd };
    }
  }
  return worst;
}

/** Rotation fires when the candidate runner's APR >= the worst held APR times
 * the configured multiplier — a 5,000% runner vs a flat 25% major clears it;
 * a 30% marginal pool does not. */
export function shouldRotate(
  candidateAprPct: number,
  worst: HeldPositionApr | null,
  aprMult?: number,
): boolean {
  if (!worst) return false;
  return candidateAprPct >= worst.feeAprPct * (aprMult ?? DEFAULT_ROTATION_APR_MULT);
}

/** Trailing consecutive above-floor APR observations (newest-first). Breaks
 * on the first below-floor OR stale (> maxGapMs old) observation — two
 * cycles three days apart are not "consecutive". This is the persistence
 * gate behind runner admission and rotation: a single-cycle fee spike must
 * never qualify a pool (rule: require fee production across consecutive
 * observations). */
export function consecutiveAboveFloorObservations(
  observations: ReadonlyArray<{ at: number; apr: number }>,
  floorApr: number,
  now: number,
  maxGapMs: number,
): number {
  let count = 0;
  for (const o of observations) {
    if (now - o.at > maxGapMs) break;
    if (o.apr < floorApr) break;
    count += 1;
  }
  return count;
}
