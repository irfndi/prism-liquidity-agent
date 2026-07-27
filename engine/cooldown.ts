/**
 * Exit cooldown duration math (pure — no Effect, no DB, no side effects).
 *
 * OOR exits keep the legacy escalation: the first few exits cool the pool for
 * `oorCooldownMs`; once `consecutiveOorExits + 1` reaches
 * `maxOorCooldownExits`, every subsequent exit uses `repeatOorCooldownMs`.
 *
 * Low-yield exits (fee/IL ratio or volume authenticity) are scaled by the
 * pool's measured fee density (`fees24hUsd / tvlUsd`, datapi only — see
 * program.ts): a high-fee-density pool re-enters sooner (down to
 * `feeDensityCooldownMinMs`), a thin pool stays cooled down for the full
 * static `oorCooldownMs`. Density at/above `feeDensityHighPct` → the floor;
 * at/below `feeDensityLowPct` → the static duration; between → linear
 * interpolation, clamped to the two durations. When the feature is off or
 * the density is unavailable (null), the static legacy duration is returned.
 *
 * The floor must sit strictly below the static duration. When it does not
 * (an inverted relationship the config loader also clamps at load time),
 * every density returns the static duration: normalizing the two values
 * (swapping min/max) would INVERT their meanings — high-density exits would
 * get the static duration and thin pools the larger "minimum".
 */

export type ExitCooldownTrigger = "oor" | "low-yield";

/** The subset of AppConfig the cooldown math reads. */
export interface ExitCooldownConfig {
  readonly oorCooldownMs: number;
  readonly repeatOorCooldownMs: number;
  readonly maxOorCooldownExits: number;
  readonly feeDensityCooldowns: boolean;
  readonly feeDensityCooldownMinMs: number;
  readonly feeDensityHighPct: number;
  readonly feeDensityLowPct: number;
}

export interface ExitCooldownRequest {
  readonly trigger: ExitCooldownTrigger;
  /** Consecutive OOR exits already recorded for the pool (pre-increment). */
  readonly consecutiveOorExits: number;
  readonly config: ExitCooldownConfig;
  /**
   * Measured fee density per day (`fees24hUsd / tvlUsd`). Null when the
   * density is not gate-eligible (non-datapi stats, missing TVL/fees) —
   * low-yield exits then fall back to the static duration.
   */
  readonly feeDensityPerDay: number | null;
}

function computeLowYieldCooldownMs(
  config: ExitCooldownConfig,
  feeDensityPerDay: number | null,
): number {
  const staticMs = config.oorCooldownMs;
  if (!config.feeDensityCooldowns || feeDensityPerDay === null) return staticMs;
  // The caller validates finite non-negative density and the config loader
  // guarantees a non-inverted band; the pure module guards both anyway so it
  // never returns NaN for any input (fail-safe to the static duration).
  if (!Number.isFinite(feeDensityPerDay)) return staticMs;
  const highPct = config.feeDensityHighPct;
  const lowPct = config.feeDensityLowPct;
  if (!(highPct > lowPct)) return staticMs;

  const minMs = config.feeDensityCooldownMinMs;
  // The floor must sit strictly below the static duration. An inverted
  // relationship (min >= static) is rejected rather than normalized: swapping
  // min/max would hand high-density exits the static duration and thin pools
  // the larger "minimum". Guard instead — every density gets the static
  // duration (the config loader also clamps this relationship at load time;
  // `!(minMs < staticMs)` keeps a NaN floor safe too).
  if (!(minMs < staticMs)) return staticMs;
  const floorMs = minMs;
  const ceilingMs = staticMs;

  if (feeDensityPerDay >= highPct) return floorMs;
  if (feeDensityPerDay <= lowPct) return ceilingMs;

  const t = (feeDensityPerDay - lowPct) / (highPct - lowPct);
  const interpolated = ceilingMs - t * (ceilingMs - floorMs);
  return Math.min(ceilingMs, Math.max(floorMs, interpolated));
}

export function computeCooldownForExit(request: ExitCooldownRequest): number {
  const { trigger, consecutiveOorExits, config, feeDensityPerDay } = request;
  switch (trigger) {
    case "oor":
      return consecutiveOorExits + 1 >= config.maxOorCooldownExits
        ? config.repeatOorCooldownMs
        : config.oorCooldownMs;
    case "low-yield":
      return computeLowYieldCooldownMs(config, feeDensityPerDay);
  }
}
