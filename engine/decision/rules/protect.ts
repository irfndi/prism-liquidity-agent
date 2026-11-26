import type { CycleFacts, DecisionPolicy, PositionFacts } from "../types.js";
import { DECISION_TIER, type Rule } from "../types.js";

/**
 * First extracted tier of the live decision chain. Semantics are copied from
 * the current conditions in `engine/program.ts` — this is a refactor, not a
 * strategy change:
 *
 * - trailing stop       replay kernel mirrors it: drawdown > pct
 * - IL dominance        program.ts `checkIlDominanceExit`
 * - TVL drop            program.ts `checkTvlDropExit`
 * - volume authenticity program.ts `checkVolumeAuthExit`
 * - fee/IL collapse     program.ts `checkFeeIlExit`
 *
 * Ordering inside the chain is encoded by tier, and the golden-diff migration
 * (Phase 2) will verify the kernel reproduces the live decisions exactly.
 */

function finite(value: number): boolean {
  return Number.isFinite(value);
}

/** Drawdown fraction from the tracked peak, or null when inputs are unusable. */
function drawdownFromPeak(position: PositionFacts): number | null {
  const peak = position.highestValueUsd;
  const current = position.currentValueUsd;
  if (!finite(peak) || !finite(current) || peak <= 0 || current < 0) return null;
  const drawdown = (peak - current) / peak;
  return finite(drawdown) ? drawdown : null;
}

/** Positive IL in USD when the HODL benchmark is known, else null. */
function ilUsdOf(position: PositionFacts): number | null {
  const hodl = position.hodlValueUsd;
  const current = position.currentValueUsd;
  if (hodl === null || !finite(hodl) || !finite(current) || current < 0) return null;
  const ilUsd = hodl - current;
  return finite(ilUsd) && ilUsd > 0 ? ilUsd : null;
}

/** Fee/IL ratio when the maturity-gated collapse condition holds, else null. */
function feeIlExitRatio(
  facts: CycleFacts,
  position: PositionFacts,
  policy: DecisionPolicy,
): number | null {
  if (!facts.pool.feeIlRatioKnown) return null;
  const ratio = facts.pool.feeIlRatio;
  if (!finite(ratio) || !(ratio < policy.feeIlExitRatio)) return null;

  const ageMs = facts.market.now - position.openedAt;
  if (!finite(ageMs) || ageMs < policy.minYieldExitAgeMs) return null;

  const inRange = position.outOfRangeSince === null;
  const stillHealthy = position.currentValueUsd >= position.depositedUsd * 0.9;
  if (policy.holdBiasEnabled && inRange && stillHealthy) return null;
  return ratio;
}

/** Volume-authenticity score when its collapse exit applies, else null. */
function volumeAuthExitScore(
  facts: CycleFacts,
  position: PositionFacts,
  policy: DecisionPolicy,
): number | null {
  if (!facts.pool.volumeAuthenticityKnown) return null;
  const score = facts.pool.volumeAuthenticity;
  if (!finite(score) || !(score < policy.volumeAuthExitThreshold)) return null;
  if (policy.holdBiasEnabled && position.outOfRangeSince === null) return null;
  return score;
}

export const trailingStopRule: Rule = {
  id: "trailing-stop",
  phase: "exit",
  tier: DECISION_TIER.protect,
  scope: "position",
  evaluate: ({ position, policy }) => {
    if (position === null) return null;
    const drawdown = drawdownFromPeak(position);
    if (drawdown === null || drawdown <= policy.trailingStopPct) return null;
    return {
      action: "EXIT",
      confidence: 1,
      reason: `[trailing-stop] Value dropped ${(drawdown * 100).toFixed(1)}% from peak`,
    };
  },
};

export const ilDominanceRule: Rule = {
  id: "il-dominance",
  phase: "exit",
  tier: DECISION_TIER.protect,
  scope: "position",
  evaluate: ({ position, policy }) => {
    if (position === null || !policy.ilProtectionEnabled) return null;
    if (position.outOfRangeSince === null) return null;
    const ilUsd = ilUsdOf(position);
    if (ilUsd === null) return null;
    const feesUsd = position.cumulativeFeesClaimedUsd;
    if (!finite(feesUsd) || ilUsd <= feesUsd * policy.ilDominanceExitFactor) return null;
    if (ilUsd <= policy.ilDominanceMinUsd) return null;
    return {
      action: "EXIT",
      confidence: 1,
      reason:
        `[il-dominance] $${ilUsd.toFixed(2)} IL exceeds ${policy.ilDominanceExitFactor}× ` +
        `cumulative fees ($${feesUsd.toFixed(2)}) while out of range`,
    };
  },
};

export const tvlDropRule: Rule = {
  id: "tvl-drop",
  phase: "exit",
  tier: DECISION_TIER.protect,
  scope: "pool",
  evaluate: ({ facts, policy }) => {
    const velocity = facts.pool.tvlVelocity;
    if (!finite(velocity) || !finite(policy.tvlDropExitPct)) return null;
    if (!(velocity < -policy.tvlDropExitPct)) return null;
    return {
      action: "EXIT",
      confidence: 0.85,
      reason: `[tvl-drop] TVL dropped ${(Math.abs(velocity) * 100).toFixed(1)}% — capital protection exit`,
    };
  },
};

export const volumeAuthenticityRule: Rule = {
  id: "volume-authenticity",
  phase: "exit",
  tier: DECISION_TIER.yield,
  scope: "position",
  evaluate: ({ facts, position, policy }) => {
    if (position === null) return null;
    const score = volumeAuthExitScore(facts, position, policy);
    if (score === null) return null;
    return {
      action: "EXIT",
      confidence: 0.8,
      reason: `[volume-authenticity] Volume authenticity ${score.toFixed(2)} below threshold`,
    };
  },
};

export const feeIlCollapseRule: Rule = {
  id: "fee-il",
  phase: "exit",
  tier: DECISION_TIER.yield,
  scope: "position",
  evaluate: ({ facts, position, policy }) => {
    if (position === null) return null;
    const ratio = feeIlExitRatio(facts, position, policy);
    if (ratio === null) return null;
    return {
      action: "EXIT",
      confidence: 0.75,
      reason: `[fee-il] Fee/IL ${ratio.toFixed(2)} below ${policy.feeIlExitRatio} after min hold age`,
    };
  },
};

/** Exit rules extracted so far, in registry order (arbitration re-ranks). */
export const EXIT_RULES: readonly Rule[] = [
  trailingStopRule,
  ilDominanceRule,
  tvlDropRule,
  volumeAuthenticityRule,
  feeIlCollapseRule,
];
