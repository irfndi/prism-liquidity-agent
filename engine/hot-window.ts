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
}

export interface HotWindowEnterInput {
  config: HotWindowConfig;
  /** Measured Data-API 1h fee/TVL ratio (percent), or null when unmeasured. */
  feeTvlRatio1h: number | null;
  tvlUsd: number;
}

export interface HotWindowEnterResult {
  qualify: boolean;
  sizeUsd: number;
  rejectReason?: string;
}

/**
 * Is this pool a hot-window ENTER right now?
 *  - measured printing signal present and above the floor (currently printing,
 *    never stale historical APR);
 *  - pool within the depth band [minPoolTvl, min(maxPoolTvl, entry/minSharePct)]
 *    so a tiny entry captures a meaningful share without whaling the pool;
 *  - fail-closed: missing measured fees or out-of-band depth => no entry.
 */
export function evaluateHotWindowEnter(input: HotWindowEnterInput): HotWindowEnterResult {
  const c = input.config;
  if (!c.enabled) {
    return { qualify: false, sizeUsd: 0, rejectReason: "hot-window disabled" };
  }
  if (input.feeTvlRatio1h === null || !Number.isFinite(input.feeTvlRatio1h)) {
    return { qualify: false, sizeUsd: 0, rejectReason: "no measured 1h printing signal" };
  }
  if (input.feeTvlRatio1h < c.printingRatio1h) {
    return {
      qualify: false,
      sizeUsd: 0,
      rejectReason: `1h fee ratio ${input.feeTvlRatio1h.toFixed(2)} < floor ${c.printingRatio1h}`,
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
