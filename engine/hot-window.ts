/**
 * Hot-window capture lane.
 *
 * A config-gated, high-frequency variant of the engine's market-runner lane.
 * Where the runner lane holds high-yield pools for minutes-to-hours with a
 * net-daily floor, the hot-window lane ONLY enters a pool that is *printing
 * fees right now* (a short-window Data-API fee ratio, not historical APR) AND
 * whose depth is small enough that a tiny entry captures a meaningful share.
 * It then holds for at most a short timebox and exits — a fast, bounded,
 * repeatable fee-capture cycle instead of a long hold.
 *
 * Safety posture (deliberate):
 *  - The lane is OFF by default (`HOT_WINDOW_ENABLED=false`).
 *  - It never bypasses the existing per-pool safety screen (rug/mint-renounce/
 *    age/holder gates) or the risk tail — those run on every pool regardless
 *    of lane. These functions only decide *whether a currently-printing,
 *    correctly-sized entry is economic* and *when a held hot position must
 *    exit*.
 *  - It is bounded by a daily trip budget and a daily loss halt so a bad
 *    printing window cannot bleed the account (per-hold round-trip churn cost
 *    is the reason these pools net ≈0 if held too long).
 *
 * All functions are pure; today's trip/pnl counters are persisted by the
 * caller via the DB metadata table (keys `hot_trips:<YYYY-MM-DD>` and a
 * realized built from the closed-position ledger).
 */

export interface HotWindowConfig {
  enabled: boolean;
  /** USD entry per hot hold (size is also share-clamped below). */
  entrySizeUsd: number;
  /** Maximum pool TVL for a hot entry — beyond this depth our share is too
   *  thin for a short hold to pay for its round-trip churn. */
  maxPoolTvlUsd: number;
  /** Minimum pool TVL for a hot entry — below this the pool is a dust/rug
   *  zone and entry size would dominate it. */
  minPoolTvlUsd: number;
  /** Data-API `fee_tvl_ratio` 1h floor (percent per hour) that counts as
   *  "printing now". Measured fees only. */
  printingRatio1h: number;
  /** Minimum share (entry / pool tvl) for the hold to capture economic fees. */
  minSharePct: number;
  /** Maximum share — never whale a small pool. */
  maxSharePct: number;
  /** Maximum in-range hold before a timed EXIT (minutes). */
  holdMaxMs: number;
  /** Max hot ENTERs per day (trip budget). */
  maxTripsPerDay: number;
  /** Halt the lane when today's realized hot-window PnL falls below this. */
  dailyLossHaltUsd: number;
  /** Concurrent hot positions cap. */
  maxOpen: number;
  /** Volume-spike trigger (optional; absent = trigger disabled). A measured
   *  volume burst against the pool's OWN trailing baseline qualifies the
   *  entry even while the 1h fee ratio lags below its floor — fees lag
   *  volume, so the spike is the EARLY signal. */
  volumeSpike?: HotWindowVolumeSpikeConfig | undefined;
}

export interface HotWindowVolumeSpikeConfig {
  /** Trailing per-cycle readings forming the baseline (default 8). */
  baselineWindow: number;
  /** Current reading must exceed the baseline median by this factor. */
  spikeRatio: number;
  /** Minimum baseline points before a verdict (fail-open below). */
  minPoints: number;
  /** Absolute floor on the current 24h volume (USD) — a 3x burst on a dead
   *  pool is still a dead pool. */
  minVolumeUsd: number;
}

/** One per-cycle 24h-volume reading; callers pass oldest-first with the
 *  CURRENT reading as the last element. */
export type VolumeSeries = ReadonlyArray<number>;

export interface VolumeSpikeResult {
  readonly isSpike: boolean;
  /** Burst multiple vs the window-start reading (0 when unknown). */
  readonly ratio: number;
}

/** Detect a volume burst. The per-cycle reading is a trailing-24h ROLLING
 *  figure, so comparing adjacent readings is useless (it moves a few percent
 *  per scan no matter what). Instead the CURRENT reading is compared against
 *  the reading `baselineWindow` cycles AGO (window start): a genuine burst
 *  injects enough fresh volume over ~30 min to lift the rolling figure by a
 *  meaningful multiple, while ordinary drift does not. NOTE the arithmetic:
 *  because ~23.5h of baseline volume stays inside the rolling sum, even a
 *  pool trading 10× its normal rate for the whole window only lifts the
 *  reading ~1.2× — thresholds must live in the 1.1–1.5 band, NOT 2.5+
 *  (which would require adding 1.5 DAYS of volume in half an hour).
 *  Fail-open — fewer than `minPoints` baseline points yields NO verdict (a
 *  cold-start pool is not a signal either way). */
export function detectVolumeSpike(params: {
  volumes: VolumeSeries;
  baselineWindow: number;
  spikeRatio: number;
  minPoints: number;
}): VolumeSpikeResult {
  const finite = params.volumes.filter((v) => Number.isFinite(v) && v >= 0);
  if (finite.length < params.minPoints + 1) return { isSpike: false, ratio: 0 };
  const current = finite[finite.length - 1]!;
  const base = finite[finite.length - 1 - params.baselineWindow];
  if (base === undefined) return { isSpike: false, ratio: 0 };
  if (base <= 0) {
    // A dead pool coming alive is itself a burst when the reading is real.
    return current > 0
      ? { isSpike: true, ratio: Number.POSITIVE_INFINITY }
      : { isSpike: false, ratio: 0 };
  }
  const ratio = current / base;
  return { isSpike: ratio >= params.spikeRatio, ratio };
}

export interface HotWindowEnterInput {
  config: HotWindowConfig;
  /** Measured Data-API 1h fee/TVL ratio (percent), or null when unmeasured. */
  feeTvlRatio1h: number | null;
  tvlUsd: number;
  /** Precomputed volume-spike verdict for this pool (when the caller has the
   *  snapshot history to compute one). Absent/null = no spike evidence. */
  volumeSpike?: VolumeSpikeResult | null | undefined;
  /** Current measured 24h volume (USD) — the absolute floor for the spike
   *  trigger. Null/unmeasured disables the spike path. */
  volume24hUsd?: number | null | undefined;
}

export interface HotWindowEnterResult {
  qualify: boolean;
  sizeUsd: number;
  rejectReason?: string;
}

/**
 * Is this pool a hot-window ENTER right now?
 *  - EITHER trigger A (printing): measured 1h fee ratio above its floor —
 *    fees realized NOW; OR trigger B (burst, when configured): a measured
 *    volume spike vs the pool's own trailing baseline AND an absolute volume
 *    floor — volume LEADS fees, so the burst is the early signal;
 *  - pool within the depth band [minPoolTvl, min(maxPoolTvl, entry/minSharePct)]
 *    so a tiny entry captures a meaningful share without whaling the pool;
 *  - fail-closed: no qualifying measured signal or out-of-band depth => no entry.
 */
export function evaluateHotWindowEnter(input: HotWindowEnterInput): HotWindowEnterResult {
  const c = input.config;
  if (!c.enabled) {
    return { qualify: false, sizeUsd: 0, rejectReason: "hot-window disabled" };
  }

  // Trigger A: measured printing-now fee ratio.
  const ratioKnown =
    input.feeTvlRatio1h !== null &&
    Number.isFinite(input.feeTvlRatio1h) &&
    (input.feeTvlRatio1h ?? 0) >= 0;
  const printing = ratioKnown && input.feeTvlRatio1h! >= c.printingRatio1h;

  // Trigger B: measured volume burst vs own baseline (early signal).
  let bursting = false;
  if (c.volumeSpike !== undefined) {
    const spike = input.volumeSpike;
    const volKnown = input.volume24hUsd !== null && Number.isFinite(input.volume24hUsd);
    bursting =
      spike !== null &&
      spike !== undefined &&
      spike.isSpike &&
      volKnown &&
      (input.volume24hUsd ?? 0) >= c.volumeSpike.minVolumeUsd;
  }

  if (!printing && !bursting) {
    if (!ratioKnown) {
      return { qualify: false, sizeUsd: 0, rejectReason: "no measured 1h printing signal" };
    }
    return {
      qualify: false,
      sizeUsd: 0,
      rejectReason: `1h fee ratio ${input.feeTvlRatio1h?.toFixed(2)} < floor ${c.printingRatio1h}`,
    };
  }
  if (c.entrySizeUsd <= 0 || input.tvlUsd <= 0) {
    return { qualify: false, sizeUsd: 0, rejectReason: "non-positive tvl or entry size" };
  }
  const tvl = input.tvlUsd;
  // Share-economic depth band.
  const minShareTvl = c.entrySizeUsd / c.maxSharePct; // below => we'd dominate
  const maxShareTvl = c.entrySizeUsd / c.minSharePct; // above => share too thin
  const depthCap = Math.min(c.maxPoolTvlUsd, maxShareTvl);
  if (tvl < c.minPoolTvlUsd) {
    return {
      qualify: false,
      sizeUsd: 0,
      rejectReason: `tvl ${tvl.toFixed(0)} < min ${c.minPoolTvlUsd}`,
    };
  }
  if (tvl > depthCap) {
    return {
      qualify: false,
      sizeUsd: 0,
      rejectReason: `tvl ${tvl.toFixed(0)} > depth cap ${depthCap.toFixed(0)} (share < min ${(c.minSharePct * 100).toFixed(1)}%)`,
    };
  }
  if (tvl < minShareTvl) {
    return {
      qualify: false,
      sizeUsd: 0,
      rejectReason: `tvl ${tvl.toFixed(0)} < ${minShareTvl.toFixed(0)} (entry would exceed ${(c.maxSharePct * 100).toFixed(0)}% of depth)`,
    };
  }
  return { qualify: true, sizeUsd: c.entrySizeUsd };
}

export interface HotWindowExitInput {
  config: HotWindowConfig;
  /** Milliseconds since the position entered. */
  ageMs: number;
  /** When the position went out of range, or null when in-range (fees accrue). */
  outOfRangeSince: number | null;
  /** Set when the lane is halted by a daily loss — force an exit. */
  halted: boolean;
}

export interface HotWindowExitResult {
  exit: boolean;
  reason?: "timebox" | "oor" | "halt";
}

/**
 * A held hot position exits when: it is out of range (fees stopped and IL is
 * bleeding — exit immediately, never twiddle a hot position OOR), or it has
 * been held past the short timebox (a hot window does not last), or the daily
 * loss halt is armed. Fail-closed: an unknown age (non-finite) exits.
 */
export function evaluateHotWindowExit(input: HotWindowExitInput): HotWindowExitResult {
  const c = input.config;
  if (input.halted) {
    return { exit: true, reason: "halt" };
  }
  if (input.outOfRangeSince !== null) {
    return { exit: true, reason: "oor" };
  }
  if (!Number.isFinite(input.ageMs) || input.ageMs >= c.holdMaxMs) {
    return { exit: true, reason: "timebox" };
  }
  return { exit: false };
}

/** Date key used for the daily trip/pnl counters. */
export function hotWindowDayKey(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
