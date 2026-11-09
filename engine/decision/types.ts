import type { ActionType } from "../types.js";

/**
 * Pure decision-kernel contracts.
 *
 * The kernel is the long-term replacement for the branch chain inside
 * `evaluatePool`: rules read an immutable fact snapshot and a versioned policy,
 * and emit proposals that are arbitrated by explicit tier. No Effect services,
 * no I/O, no clock reads — everything the decision needs is a field.
 *
 * See docs/plan/2026-10-30-decision-kernel-refactor.md.
 */

export type RulePhase = "guard" | "entry" | "manage" | "exit" | "portfolio";
export type RuleScope = "pool" | "position";

/**
 * Explicit precedence. A capital-protection EXIT can never lose to an entry,
 * and a safety veto can never lose to anything. Within a tier the arbiter ranks
 * by net expectancy, so "which rule wins" is a property of the system, not of
 * the order branches happen to appear in.
 */
export const DECISION_TIER = {
  safety: 100,
  protect: 80,
  lifecycle: 60,
  yield: 40,
  rebalance: 20,
  entry: 10,
} as const;

export type DecisionTier = (typeof DECISION_TIER)[keyof typeof DECISION_TIER];

/** Pool-level facts for one cycle. Unknown values are explicit, never 0-as-known. */
export interface PoolFacts {
  readonly poolAddress: string;
  readonly activeBinId: number;
  readonly tvlUsd: number;
  /** Fractional TVL change vs the previous snapshot (negative = drain). */
  readonly tvlVelocity: number;
  readonly fees24hUsd: number;
  readonly feeIlRatio: number;
  readonly feeIlRatioKnown: boolean;
  readonly volumeAuthenticity: number;
  readonly volumeAuthenticityKnown: boolean;
  readonly binUtilization: number;
  readonly binUtilizationKnown: boolean;
  readonly netDriftBins: number | null;
}

export interface PositionFacts {
  readonly positionId: string;
  readonly poolAddress: string;
  readonly lowerBinId: number;
  readonly upperBinId: number;
  readonly openedAt: number;
  readonly depositedUsd: number;
  readonly currentValueUsd: number;
  readonly highestValueUsd: number;
  readonly cumulativeFeesClaimedUsd: number;
  readonly cumulativeRewardsClaimedUsd: number;
  readonly outOfRangeSince: number | null;
  /** HODL benchmark at the current price; null when entry legs are unknown. */
  readonly hodlValueUsd: number | null;
}

export interface PortfolioFacts {
  readonly portfolioValueUsd: number;
  readonly openPositionCount: number;
}

export interface MarketFacts {
  /** Cycle timestamp (ms epoch). Injected so rules never read the clock. */
  readonly now: number;
}

export interface CycleFacts {
  readonly pool: PoolFacts;
  readonly positions: readonly PositionFacts[];
  readonly portfolio: PortfolioFacts;
  readonly market: MarketFacts;
}

/**
 * Versioned policy. One object per regime; env selects the policy set rather
 * than one flag per gate. Serializes to JSON for replay and for the Rust host.
 */
export interface DecisionPolicy {
  readonly version: string;
  readonly trailingStopPct: number;
  readonly ilProtectionEnabled: boolean;
  readonly ilDominanceExitFactor: number;
  readonly ilDominanceMinUsd: number;
  readonly tvlDropExitPct: number;
  readonly volumeAuthExitThreshold: number;
  readonly feeIlExitRatio: number;
  readonly minYieldExitAgeMs: number;
  readonly holdBiasEnabled: boolean;
}

export interface RuleContext {
  readonly facts: CycleFacts;
  /** null on the pool-scope pass; set on each per-position pass. */
  readonly position: PositionFacts | null;
  readonly policy: DecisionPolicy;
}

export interface RuleHit {
  readonly action: ActionType;
  readonly confidence: number;
  /** Bracket-tagged for the existing audit vocabulary, e.g. `[trailing-stop] …`. */
  readonly reason: string;
  /** Net expectancy for arbitration; omitted when the rule has no economics. */
  readonly expectedValueUsd?: number;
  readonly costsUsd?: number;
}

export interface Rule {
  readonly id: string;
  readonly phase: RulePhase;
  readonly tier: DecisionTier;
  readonly scope: RuleScope;
  evaluate(context: RuleContext): RuleHit | null;
}

export interface Proposal {
  readonly ruleId: string;
  readonly phase: RulePhase;
  readonly tier: DecisionTier;
  readonly action: ActionType;
  readonly confidence: number;
  readonly reason: string;
  readonly expectedValueUsd: number | null;
  readonly costsUsd: number | null;
  readonly positionId: string | null;
}
