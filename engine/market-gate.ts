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
import { stableDailyFeesUsd } from "./fee-capture.js";
import { transferFeeRejectionReason } from "./transfer-fee.js";

export interface MarketGateConfig {
  readonly minTvlUsd: number;
  /** Minimum annualized fee/TVL percent: fees24h × 365 / tvl × 100. */
  readonly minFeeApr: number;
  /** Absolute 24h fee floor (USD). Percentage APR alone admits micro-pools
   *  with spectacular ratios but trivial dollars; this floor keeps only pools
   *  with real fee dollars (default 0 = disabled). */
  readonly minFees24hUsd?: number | undefined;
  /** Minimum daily volume/TVL ratio (wash-trading and dead-pool guard). */
  readonly minVolumeTurnover: number;
  readonly maxVolumeTurnover: number;
  /** Absolute 24h volume floor (USD) — real sustained volume is also the
   *  honeypot counter-signal (default 0 = disabled). */
  readonly minVolume24hUsd?: number | undefined;
  /** Minimum holders for a non-stable, non-SOL leg (rug/IL pre-filter). */
  readonly minHolders: number;
  /**
   * Rug-factory age floor (hours): reject a pool younger than this.
   * 0 disables. Unknown age (`createdAtMs` absent) fails open — the per-pool
   * screen still gates ENTER.
   */
  readonly minPoolAgeHours: number;
  readonly minBinStep: number;
  readonly maxBinStep: number;
  readonly stablecoinMints: ReadonlySet<string>;
  /**
   * Transfer-tax (Robinhood rule 4) screen override: when absent or false,
   * any leg whose mint carries a Token-2022 transfer fee is rejected.
   * Optional so legacy configs/tests compile unchanged; absent is treated
   * as false (`!== true`).
   */
  readonly allowTransferFeeTokens?: boolean;
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

export function isStableOrSol(mint: string, stablecoinMints: ReadonlySet<string>): boolean {
  return mint === SOL_MINT || stablecoinMints.has(mint);
}

/**
 * Hot-lane mint-authority rug gate. Returns a rejection reason (or null) when
 * a non-stable, non-SOL leg still has a live mint authority (not renounced) —
 * the dev can mint+dump. The strongest rug gate; it needs on-chain mint
 * authorities, which are absent from the Data API list payload, so the per-pool
 * screen passes them in. Trusted legs (stables + SOL) are exempt.
 * `requireRenounced === false` disables the gate (OpenClaw/test parity).
 *
 * Verified-scale exemption: a live mint authority is also how legitimate
 * issuers operate (tokenized equities, bridged majors — mint/burn against
 * real-world creations/redemptions REQUIRES the authority), so a minted leg
 * is exempt when it is Data-API-verified AND the pool clears
 * `exemptMinTvlUsd` (corroborated scale a dust rug cannot fake). Absent
 * bounds (or 0) restore the strict binary — verification-blind, as before.
 */
export function mintAuthorityRejectReason(
  legs: ReadonlyArray<{
    readonly symbol: string;
    readonly mint: string;
    readonly mintAuthority: string | null | undefined;
    readonly verified?: boolean | null | undefined;
  }>,
  stablecoinMints: ReadonlySet<string>,
  requireRenounced: boolean | undefined,
  exemptMinTvlUsd: number | undefined,
  poolTvlUsd: number | undefined,
): string | null {
  if (requireRenounced === false) return null;
  const mintedLegs = legs.filter(
    (leg) => leg.mintAuthority != null && !isStableOrSol(leg.mint, stablecoinMints),
  );
  if (mintedLegs.length === 0) return null;
  const scaleOk =
    exemptMinTvlUsd !== undefined &&
    exemptMinTvlUsd > 0 &&
    poolTvlUsd !== undefined &&
    poolTvlUsd >= exemptMinTvlUsd;
  const untrusted = scaleOk ? mintedLegs.filter((leg) => leg.verified !== true) : mintedLegs;
  if (untrusted.length === 0) return null;
  return `leg(s) ${untrusted
    .map((leg) => leg.symbol)
    .join(", ")} have a live mint authority (not renounced) — dev can mint+dump`;
}

/**
 * Token-safety pre-filter for one leg. Mirrors the engine's freeze/verification
 * policy at the DISCOVERY layer (fail-open when metadata is absent — the
 * per-pool screen still gates ENTER):
 * - Transfer-fee tokens (Robinhood rule 4): reject unless allowTransferFeeTokens.
 *   Checked first — a transfer tax on a "stablecoin" is exactly the screen's
 *   target, so it overrides the stablecoin allowlist exemption below.
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
    readonly transferFeeEnabled?: boolean;
  },
  minHolders: number,
  opts?: { readonly allowTransferFeeTokens: boolean | undefined },
): boolean {
  // Robinhood rule 4: a KNOWN transfer-fee mint is rejected up front. Absent
  // metadata (undefined) is not a fee — only a KNOWN fee rejects. Delegates
  // to the shared reason helper so the rule has one source of truth.
  if (transferFeeRejectionReason(undefined, leg.transferFeeEnabled, opts?.allowTransferFeeTokens)) {
    return false;
  }
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

/** Ordered market admission checks — rejection order and reason strings are
 *  contractual (screens/tests assert them). Returns the first rejection
 *  reason, or null when the pool is admitted. */
function marketFeeRejectReason(pool: DiscoveredPool, config: MarketGateConfig): string | null {
  if (hasNo24hFees(pool)) {
    return "no 24h fees";
  }
  // Absolute activity floors (volume+fees focus): percentage ratios alone
  // admit micro-pools with spectacular percentages but trivial dollars.
  // Real sustained volume doubles as the honeypot counter-signal.
  const minFees = config.minFees24hUsd ?? 0;
  if (minFees > 0 && pool.fees24hUsd < minFees) {
    return `fees24h $${pool.fees24hUsd.toFixed(0)} < $${minFees.toFixed(0)} (absolute floor)`;
  }
  const feeAprPct = (pool.fees24hUsd * 365 * 100) / pool.tvlUsd;
  if (feeAprPct < config.minFeeApr) {
    return `fee APR ${feeAprPct.toFixed(1)}% < ${config.minFeeApr}%`;
  }
  // Spike guard: a hot 24h print must be confirmed by the longer windows —
  // the minimum across usable fee/TVL windows (normalized to daily) must
  // also clear the floor, so a one-hour blow-off top cannot buy admission.
  // Fewer than 2 usable windows → unassessable → fail open (the per-pool
  // ENTER gates still apply).
  const stable = stableDailyFeesUsd(pool.feeYieldWindows, pool.tvlUsd);
  if (stable !== null && usableFeeWindows(pool.feeYieldWindows) >= 2) {
    const stableAprPct = (stable * 365 * 100) / pool.tvlUsd;
    if (stableAprPct < config.minFeeApr) {
      return `stable fee APR ${stableAprPct.toFixed(1)}% (min across windows) < ${config.minFeeApr}% — 24h spike unconfirmed`;
    }
  }
  return null;
}

/** Count of usable (finite, non-negative) fee/TVL windows. */
function usableFeeWindows(windows: DiscoveredPool["feeYieldWindows"]): number {
  if (windows == null) return 0;
  let count = 0;
  for (const value of Object.values(windows)) {
    if (value != null && Number.isFinite(value) && value >= 0) count++;
  }
  return count;
}

function marketVolumeRejectReason(pool: DiscoveredPool, config: MarketGateConfig): string | null {
  if (hasNo24hVolume(pool)) {
    return "no 24h volume";
  }
  const minVol = config.minVolume24hUsd ?? 0;
  if (minVol > 0 && pool.volume24hUsd < minVol) {
    return `volume24h $${pool.volume24hUsd.toFixed(0)} < $${minVol.toFixed(0)} (absolute floor)`;
  }
  const volumeTurnover = pool.volume24hUsd / pool.tvlUsd;
  if (volumeTurnover < config.minVolumeTurnover) {
    return `volume turnover ${volumeTurnover.toFixed(2)} < ${config.minVolumeTurnover}`;
  }
  if (volumeTurnover > config.maxVolumeTurnover) {
    return `volume turnover ${volumeTurnover.toFixed(1)} > ${config.maxVolumeTurnover} (wash)`;
  }
  return null;
}

function marketBinStepRejectReason(pool: DiscoveredPool, config: MarketGateConfig): string | null {
  if (isUltraFineBinStep(pool, config)) {
    return `binStep ${pool.binStep} < ${config.minBinStep} (ultra-fine churn)`;
  }
  if (pool.binStep > config.maxBinStep) {
    return `binStep ${pool.binStep} > ${config.maxBinStep}`;
  }
  return null;
}

function marketAdmissionReject(pool: DiscoveredPool, config: MarketGateConfig): string | null {
  if (isBelowMarketTvlFloor(pool, config)) {
    return `tvl ${pool.tvlUsd} < ${config.minTvlUsd}`;
  }
  const ageReason = marketAgeRejectReason(pool, config);
  if (ageReason !== null) {
    return ageReason;
  }
  const holderReason = marketThinHoldersRejectReason(pool, config);
  if (holderReason !== null) {
    return holderReason;
  }
  const feeReason = marketFeeRejectReason(pool, config);
  if (feeReason !== null) {
    return feeReason;
  }
  const volumeReason = marketVolumeRejectReason(pool, config);
  if (volumeReason !== null) {
    return volumeReason;
  }
  const binStepReason = marketBinStepRejectReason(pool, config);
  if (binStepReason !== null) {
    return binStepReason;
  }
  const legReason = marketLegRejectReason(pool, config);
  if (legReason !== null) {
    return legReason;
  }
  return null;
}

function isBelowMarketTvlFloor(pool: DiscoveredPool, config: MarketGateConfig): boolean {
  return !Number.isFinite(pool.tvlUsd) || pool.tvlUsd < config.minTvlUsd;
}

function hasNo24hFees(pool: DiscoveredPool): boolean {
  return !Number.isFinite(pool.fees24hUsd) || pool.fees24hUsd <= 0;
}

function hasNo24hVolume(pool: DiscoveredPool): boolean {
  return !Number.isFinite(pool.volume24hUsd) || pool.volume24hUsd <= 0;
}

function isUltraFineBinStep(pool: DiscoveredPool, config: MarketGateConfig): boolean {
  return !Number.isInteger(pool.binStep) || pool.binStep < config.minBinStep;
}

/** Rug-factory age floor: brand-new pools are the ruin tail. Fail-open on
 *  unknown age (missing metadata never blocks a legit pool), reject when
 *  the age is known and too young. */
function marketAgeRejectReason(pool: DiscoveredPool, config: MarketGateConfig): string | null {
  if (config.minPoolAgeHours > 0 && pool.createdAtMs != null && pool.createdAtMs > 0) {
    const ageHours = (Date.now() - pool.createdAtMs) / 3_600_000;
    if (ageHours < config.minPoolAgeHours) {
      return `pool age ${ageHours.toFixed(1)}h < ${config.minPoolAgeHours}h (rug-factory)`;
    }
  }
  return null;
}

/** Holder floor, HARD and independent of verification: a non-stable, non-SOL
 *  leg with dust holders is a single-cluster rug setup even when Meteora
 *  "verified" it. Fail-open on unknown holder count (the per-pool screen
 *  still gates ENTER on live data). */
function marketThinHoldersRejectReason(
  pool: DiscoveredPool,
  config: MarketGateConfig,
): string | null {
  const thinLegs = [pool.tokenX, pool.tokenY]
    .map((mint) => ({
      mint,
      holders: mint === pool.tokenX ? pool.tokenXHolders : pool.tokenYHolders,
      symbol: mint === pool.tokenX ? pool.tokenXSymbol : pool.tokenYSymbol,
    }))
    .filter((leg) => !isStableOrSol(leg.mint, config.stablecoinMints))
    .filter(
      (leg) => config.minHolders > 0 && leg.holders != null && leg.holders < config.minHolders,
    );
  if (thinLegs.length === 0) return null;
  return `leg ${thinLegs
    .map((l) => `${l.symbol ?? l.mint} (${l.holders} holders)`)
    .join(", ")} below ${config.minHolders} holders`;
}

/** Token-leg safety for BOTH legs in original order (X then Y): the
 *  transfer-fee screen first, then the shared token-safety policy. Returns
 *  the first rejection reason, or null when both legs pass. */
function marketLegRejectReason(pool: DiscoveredPool, config: MarketGateConfig): string | null {
  const xFeeReason = transferFeeRejectionReason(
    pool.tokenXSymbol,
    pool.tokenXTransferFeeEnabled,
    config.allowTransferFeeTokens,
  );
  if (xFeeReason) {
    return xFeeReason;
  }
  const xPasses = marketLegPasses(
    {
      isStableOrSol: isStableOrSol(pool.tokenX, config.stablecoinMints),
      verified: pool.tokenXVerified,
      freezeDisabled: pool.tokenXFreezeDisabled,
      holders: pool.tokenXHolders,
    },
    config.minHolders,
    { allowTransferFeeTokens: config.allowTransferFeeTokens },
  );
  if (!xPasses) {
    return `leg ${pool.tokenXSymbol ?? pool.tokenX} fails token safety (verified=${pool.tokenXVerified}, freezeDisabled=${pool.tokenXFreezeDisabled}, holders=${pool.tokenXHolders})`;
  }
  const yFeeReason = transferFeeRejectionReason(
    pool.tokenYSymbol,
    pool.tokenYTransferFeeEnabled,
    config.allowTransferFeeTokens,
  );
  if (yFeeReason) {
    return yFeeReason;
  }
  const yPasses = marketLegPasses(
    {
      isStableOrSol: isStableOrSol(pool.tokenY, config.stablecoinMints),
      verified: pool.tokenYVerified,
      freezeDisabled: pool.tokenYFreezeDisabled,
      holders: pool.tokenYHolders,
    },
    config.minHolders,
    { allowTransferFeeTokens: config.allowTransferFeeTokens },
  );
  if (!yPasses) {
    return `leg ${pool.tokenYSymbol ?? pool.tokenY} fails token safety (verified=${pool.tokenYVerified}, freezeDisabled=${pool.tokenYFreezeDisabled}, holders=${pool.tokenYHolders})`;
  }
  return null;
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
    const rejectReason = marketAdmissionReject(pool, config);
    if (rejectReason !== null) {
      rejected.push({ address: pool.address, reason: rejectReason });
      continue;
    }

    // Composite rank: fee APR is the profit engine; TVL adds a liquidity
    // factor (deeper pools → less IL per dollar and more stable fees), capped
    // so a 5×-APR small pool still outranks a deep slow pool.
    const feeAprPct = (pool.fees24hUsd * 365 * 100) / pool.tvlUsd;
    const volumeTurnover = pool.volume24hUsd / pool.tvlUsd;
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
