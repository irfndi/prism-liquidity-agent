/** Regime gate: ORCA-inspired systemic-stress dampers (arXiv:2604.17251).
 *
 * Two advisory signals distilled from the paper's findings, stripped of the ML
 * machinery (a Random Forest over 206 features needs years of labeled data we
 * do not have; the graph-topological core does not):
 *
 * 1. Herding detection. Crashes are preceded by cross-asset correlation
 *    collapse into lockstep — the paper's top crash predictors (clustering
 *    coefficient, edge density, dominant-eigenvalue share) are all measures of
 *    "how many pairs move together". Edge density + mean pairwise correlation
 *    capture that without any eigendecomposition. High herding = systemic
 *    stress = the window where rugs cluster and fresh LP positions bleed.
 *
 * 2. Euphoria asymmetry. The paper's strongest sell signal was signal-
 *    confidence-at-extreme: extremes mark tops, not continuation. Applied
 *    here as a self-relative APR outlier test for the runner lane — a pool
 *    whose CURRENT measured APR sits at the top of its own recent history is
 *    far more likely a blow-off spike than durable yield (the persistence ring
 *    already proves multi-cycle elevation; this rejects the spike SHAPE).
 *
 * Pure module (like market-runner.ts / launch-gate.ts): no Effect services,
 * deterministic, fail-open by construction — unknown correlation state is
 * reported as `known: false` and every consumer skips the damper. Nothing
 * here ever forces an EXIT; these gates only decline NEW capital.
 */

/** One pool's per-cycle return series (oldest-first). Derived from active-bin
 *  IDs: a DLMM bin id maps monotonically to price, so the per-cycle log return
 *  is `deltaBins * ln(1 + binStep / 10_000)` — no oracle needed. */
export type ReturnSeries = ReadonlyArray<number>;

export interface HerdingAssessment {
  /** False when too few pool pairs had enough overlap to judge — consumers
   *  must treat an unknown assessment as "no opinion" (fail-open). */
  readonly known: boolean;
  /** Number of pool pairs actually compared. */
  readonly pairCount: number;
  /** Mean Pearson correlation across compared pairs, [-1, 1]. */
  readonly meanCorrelation: number;
  /** Fraction of compared pairs with correlation > 0.5 ("edges"). */
  readonly edgeDensity: number;
}

/** Pearson correlation of two equal-length return windows. Returns null when
 *  either series is degenerate (zero variance — a parked pool carries no
 *  correlation information and must not fabricate a coefficient). */
export function pearson(a: ReturnSeries, b: ReturnSeries): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i += 1) {
    sa += a[a.length - n + i]!;
    sb += b[b.length - n + i]!;
  }
  const ma = sa / n;
  const mb = sb / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[a.length - n + i]! - ma;
    const db = b[b.length - n + i]! - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va <= 0 || vb <= 0) return null;
  const denom = Math.sqrt(va * vb);
  if (denom <= 0) return null;
  return cov / denom;
}

export interface HerdingOptions {
  /** Minimum aligned points per series before a pair counts (default 12 —
   *  one scan-hour at a 5-min cadence). */
  readonly minPoints?: number | undefined;
  /** Minimum comparable pairs for the assessment to be `known` (default 6 —
   *  enough pairs that two coincidentally-linked pools cannot trip it). */
  readonly minPairs?: number | undefined;
  /** Cap on series compared (cost guard: pairs grow quadratically). */
  readonly maxPools?: number | undefined;
}

/** Cross-pool herding assessment over per-pool return series. Uses the
 *  trailing common window of each pair; series shorter than `minPoints` are
 *  skipped (cold-start pools never contribute). */
function collectUsableSeries(
  seriesByPool: ReadonlyMap<string, ReturnSeries>,
  minPoints: number,
  maxPools: number,
): Array<ReturnSeries> {
  const usable: Array<ReturnSeries> = [];
  for (const s of seriesByPool.values()) {
    if (s.length >= minPoints) usable.push(s);
    if (usable.length >= maxPools) break;
  }
  return usable;
}

interface HerdingPairTotals {
  readonly sum: number;
  readonly count: number;
  readonly edges: number;
}

function scoreHerdingPairs(usable: ReadonlyArray<ReturnSeries>): HerdingPairTotals {
  let sum = 0;
  let count = 0;
  let edges = 0;
  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      const r = pearson(usable[i]!, usable[j]!);
      if (r === null) continue;
      sum += r;
      count += 1;
      if (r > 0.5) edges += 1;
    }
  }
  return { sum, count, edges };
}

function buildHerdingAssessment(
  sum: number,
  count: number,
  edges: number,
  minPairs: number,
): HerdingAssessment {
  if (count < minPairs) {
    return { known: false, pairCount: count, meanCorrelation: 0, edgeDensity: 0 };
  }
  return {
    known: true,
    pairCount: count,
    meanCorrelation: sum / count,
    edgeDensity: edges / count,
  };
}

export function assessHerding(
  seriesByPool: ReadonlyMap<string, ReturnSeries>,
  options?: HerdingOptions,
): HerdingAssessment {
  const opts = options ?? {};
  const usable = collectUsableSeries(seriesByPool, opts.minPoints ?? 12, opts.maxPools ?? 64);
  const totals = scoreHerdingPairs(usable);
  return buildHerdingAssessment(totals.sum, totals.count, totals.edges, opts.minPairs ?? 6);
}

export interface HerdingThresholds {
  /** Block when edge density reaches this fraction (default 0.8 — ORCA's
   *  crash signature is near-total lockstep, not mild co-movement). */
  readonly edgeDensityThreshold?: number | undefined;
  /** Alternative trigger: mean pairwise correlation (default 0.6). */
  readonly meanCorrThreshold?: number | undefined;
}

/** True when the (known) assessment clears a herding threshold. An unknown
 *  assessment never blocks — fail-open. Either trigger suffices: edge
 *  density catches "many strong pairs", mean correlation catches "moderately
 *  elevated everywhere". */
export function herdingBlocksEntry(
  assessment: HerdingAssessment,
  thresholds?: HerdingThresholds,
): boolean {
  if (!assessment.known) return false;
  const edgeThreshold = thresholds?.edgeDensityThreshold ?? 0.8;
  const corrThreshold = thresholds?.meanCorrThreshold ?? 0.6;
  return assessment.edgeDensity >= edgeThreshold || assessment.meanCorrelation >= corrThreshold;
}

/** Percentile rank (0..1) of `value` within `samples` — fraction of samples
 *  strictly below it. Empty input returns 0.5 (no information, no opinion). */
export function percentileRank(samples: ReadonlyArray<number>, value: number): number {
  if (samples.length === 0) return 0.5;
  let below = 0;
  for (const s of samples) {
    if (s < value) below += 1;
  }
  return below / samples.length;
}

function median(samples: ReadonlyArray<number>): number {
  const sorted = [...samples].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export const DEFAULT_APR_OUTLIER_PERCENTILE = 0.98;
/** A spike must at least double the pool's typical APR to count as euphoria —
 *  rank alone is too coarse on a 3-5 sample ring (any new all-time high ranks
 *  1.0, which would flag a steadily-climbing durable pool every cycle). */
export const DEFAULT_APR_OUTLIER_MIN_SPIKE_RATIO = 2;

export interface AprOutlierParams {
  /** This pool's PRIOR fee-APR observations (newest-first), excluding the
   *  current one — the same ring the persistence gate stores. */
  readonly priorAprs: ReadonlyArray<number>;
  /** The current measured fee APR under test. */
  readonly currentApr: number;
  /** Rank at/above which the current APR is an outlier (default 0.98). */
  readonly outlierPercentile?: number | undefined;
  /** Current APR must exceed the pool's median APR by this factor (default 2). */
  readonly minSpikeRatio?: number | undefined;
}

/** Euphoria damper: true when the current APR is BOTH a top-percentile
 *  extreme of the pool's OWN recent history AND a vertical spike (≥
 *  `minSpikeRatio` × its median) — a blow-off, not a plateau. Needs at least
 *  3 prior observations (less history than that cannot establish a
 *  distribution); fewer fails open. Durable high APR is flat-high (prior
 *  observations equally elevated → low self-rank AND low ratio) and passes. */
export function isAprSelfOutlier(params: AprOutlierParams): boolean {
  const pct = params.outlierPercentile ?? DEFAULT_APR_OUTLIER_PERCENTILE;
  if (pct <= 0) return false;
  if (!Number.isFinite(params.currentApr)) return false;
  const prior = params.priorAprs.filter((a) => Number.isFinite(a));
  if (prior.length < 3) return false;
  const med = median(prior);
  if (med <= 0) return params.currentApr > 0;
  const ratio = params.minSpikeRatio ?? DEFAULT_APR_OUTLIER_MIN_SPIKE_RATIO;
  return percentileRank(prior, params.currentApr) >= pct && params.currentApr >= med * ratio;
}
