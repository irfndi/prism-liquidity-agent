/**
 * Left-tail hard stop (ledger-driven): age-free EXIT when mark PnL
 * (current + claimed fees + rewards − deposited) falls to or below
 * -(deposited × maxLossPct). Capital protection — independent of trailing
 * stop (peak-based) and of economic-exit maturity.
 */

export interface PositionLossCapInput {
  readonly depositedUsd: number;
  readonly currentValueUsd: number;
  readonly cumulativeFeesClaimedUsd: number;
  readonly cumulativeRewardsClaimedUsd: number;
  /** Fraction of deposited USD. ≤0 disables. Clamped to [0, 1] when active. */
  readonly maxLossPct: number;
}

function finiteNonNeg(n: number): boolean {
  return Number.isFinite(n) && n >= 0;
}

/** Unrealized total PnL including claimed fees/rewards (same shape as engine PnL). */
export function positionMarkPnlUsd(input: {
  readonly depositedUsd: number;
  readonly currentValueUsd: number;
  readonly cumulativeFeesClaimedUsd: number;
  readonly cumulativeRewardsClaimedUsd: number;
}): number | null {
  const { depositedUsd, currentValueUsd, cumulativeFeesClaimedUsd, cumulativeRewardsClaimedUsd } =
    input;
  if (
    !finiteNonNeg(depositedUsd) ||
    depositedUsd <= 0 ||
    !Number.isFinite(currentValueUsd) ||
    !finiteNonNeg(cumulativeFeesClaimedUsd) ||
    !finiteNonNeg(cumulativeRewardsClaimedUsd)
  ) {
    return null;
  }
  return currentValueUsd + cumulativeFeesClaimedUsd + cumulativeRewardsClaimedUsd - depositedUsd;
}

/** True when mark PnL ≤ -(deposited × maxLossPct). */
export function isPositionLossCapBreached(input: PositionLossCapInput): boolean {
  const pct = input.maxLossPct;
  if (!Number.isFinite(pct) || pct <= 0) return false;
  const floorPct = Math.min(pct, 1);
  const pnl = positionMarkPnlUsd(input);
  if (pnl === null) return false;
  return pnl <= -(input.depositedUsd * floorPct);
}

/** Bracket-tagged EXIT reasoning for ledger slicing. */
export function positionLossCapReasoning(input: PositionLossCapInput): string {
  const pnl = positionMarkPnlUsd(input) ?? 0;
  const pct = Math.min(Math.max(input.maxLossPct, 0), 1);
  const lossPct = input.depositedUsd > 0 ? (-pnl / input.depositedUsd) * 100 : 0;
  return `[position-loss-cap] mark PnL $${pnl.toFixed(2)} (${lossPct.toFixed(1)}% of deposit) ≤ -${(pct * 100).toFixed(0)}% floor`;
}
