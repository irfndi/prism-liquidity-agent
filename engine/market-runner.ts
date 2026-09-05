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
/** Default runner drift floor: matches the normal-lane drift-gate default
 *  (MARKET_SCAN_MAX_NEGATIVE_DRIFT_BINS = -8). A runner below this floor is a
 *  sustained decliner, not a dip. */
export const DEFAULT_RUNNER_MIN_DRIFT_BINS = -8;

/** A market-scan pool is a RUNNER when the lane is enabled, the pool is in
 * the market scan set, its fees are MEASURED (datapi — modeled gecko /
 * heuristic fees never classify, same measured-only exclusion as paper fee
 * accrual), and its fee APR clears the runner floor. The drift floor keeps the
 * dip-ladder honest: a runner whose net active-bin drift sits BELOW
 * `runnerMinDriftBins` is a sustained decliner, not a shakeout — it is never
 * admitted even when its APR is enormous (the normal lane's drift-gate would
 * have rejected it). Unknown drift (no bin history) fails OPEN — it cannot
 * prove a decline, so admission is not blocked on a cold start. */
function passesRunnerDriftFloor(
  netDriftBins: number | null | undefined,
  runnerMinDriftBins: number | undefined,
): boolean {
  if (netDriftBins === undefined) return true;
  if (netDriftBins === null) return true;
  if (!Number.isFinite(netDriftBins)) return true;
  return netDriftBins >= (runnerMinDriftBins ?? DEFAULT_RUNNER_MIN_DRIFT_BINS);
}

export function isMarketRunnerPool(params: {
  enabled: boolean;
  marketScanPools: ReadonlySet<string>;
  poolAddress: string;
  statsSource: string | undefined;
  feeAprPct: number;
  runnerMinFeeApr: number | undefined;
  /** Net active-bin drift over the recent-bin window, or null when unknown. */
  netDriftBins?: number | null;
  runnerMinDriftBins?: number | undefined;
}): boolean {
  if (!params.enabled) return false;
  if (!params.marketScanPools.has(params.poolAddress)) return false;
  if (params.statsSource !== "datapi") return false;
  if (params.feeAprPct < (params.runnerMinFeeApr ?? DEFAULT_RUNNER_MIN_FEE_APR)) return false;
  if (!passesRunnerDriftFloor(params.netDriftBins, params.runnerMinDriftBins)) return false;
  return true;
}

export interface HeldPositionApr {
  readonly poolAddress: string;
  readonly feeAprPct: number;
  /** Pool TVL at the last evaluation — the net-fee capture model needs it to
   * estimate the position's share of fees (small entries on deep pools
   * capture a fraction of the headline APR). */
  readonly tvlUsd: number;
}

/** Rotation-target eligibility filters (all optional; absent = no filter). */
export interface RotationTargetFilter {
  /** Economic-exit maturity gate (MIN_YIELD_EXIT_AGE_MS, default 4h): a held
   *  position younger than this is never a rotation target. Rotation is the
   *  same economic-exit class as the yield-regression exit — it must not
   *  churn a minutes-old entry (2026-08-21 field incident: a $20 position
   *  entered at 14:32 was rotation-exited at 14:37 for −$0.01). Only
   *  capital-protection exits stay age-free. */
  readonly minAgeMs?: number | undefined;
  /** Clock override for tests. */
  readonly nowMs?: number | undefined;
}

function resolveRotationNowMs(nowMs: number | undefined): number {
  if (nowMs === undefined) return Date.now();
  return nowMs;
}

function rotationPositionSkipped(
  poolAddress: string,
  openedAt: number | undefined,
  excludePoolAddress: string | undefined,
  nowMs: number,
  minAgeMs: number | undefined,
): boolean {
  if (poolAddress === excludePoolAddress) return true;
  if (minAgeMs === undefined) return false;
  if (minAgeMs <= 0) return false;
  return nowMs - (openedAt ?? 0) < minAgeMs;
}

function rotationCandidateApr(feeAprPct: number | undefined): number | null {
  if (feeAprPct === undefined) return null;
  if (feeAprPct <= 0) return null;
  return feeAprPct;
}

/** The lowest-APR held position, or null when every eligible held position's
 *  APR is unknown/zero (nothing to rotate out of). Unmeasured held pools never
 *  rotate — fail-closed, a made-up-low APR must not sell a real position.
 *  `excludePoolAddress` (the candidate runner) is never a rotation target —
 *  a held position on the runner pool must not be exited while the same pool
 *  re-enters in the same cycle. Positions failing `filter` (too young) are
 *  skipped; if every held position is filtered out the result is null and no
 *  rotation fires this cycle. */
export function lowestAprHeldPosition(
  positions: Iterable<{ readonly poolAddress: string; readonly openedAt?: number }>,
  poolAprByAddress: ReadonlyMap<string, { feeAprPct: number; tvlUsd: number }>,
  excludePoolAddress?: string,
  filter?: RotationTargetFilter,
): HeldPositionApr | null {
  const nowMs = resolveRotationNowMs(filter?.nowMs);
  const minAgeMs = filter?.minAgeMs;
  let worst: HeldPositionApr | null = null;
  for (const pos of positions) {
    if (
      rotationPositionSkipped(pos.poolAddress, pos.openedAt, excludePoolAddress, nowMs, minAgeMs)
    ) {
      continue;
    }
    const entry = poolAprByAddress.get(pos.poolAddress);
    if (entry === undefined) continue;
    const apr = rotationCandidateApr(entry.feeAprPct);
    if (apr === null) continue;
    if (worst === null || apr < worst.feeAprPct) {
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
  if (!Number.isFinite(candidateAprPct) || candidateAprPct <= 0) return false;
  if (!Number.isFinite(worst.feeAprPct) || worst.feeAprPct < 0) return false;
  const multiplier = aprMult ?? DEFAULT_ROTATION_APR_MULT;
  if (!Number.isFinite(multiplier) || multiplier < 1) return false;
  return candidateAprPct > worst.feeAprPct && candidateAprPct >= worst.feeAprPct * multiplier;
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
