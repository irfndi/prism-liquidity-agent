// ─── LM farm reward accounting (pure helpers) ────────────────────────────────
//
// Data model (Wave 8):
// - Rewards are tracked SEPARATELY from swap fees. `cumulativeFeesClaimedUsd`
//   stays fee-pure so fee APR (engine/pnl.ts) never includes farm yield;
//   `cumulativeRewardsClaimedUsd` accumulates the USD-valued portion of reward
//   claims. Total PnL includes both (see computePositionAnalytics).
// - A reward whose mint price is unavailable is still claimed and recorded
//   with its raw atomic amount and `amountUsd: null`; only USD-priced amounts
//   add to `cumulativeRewardsClaimedUsd`. Claiming is never blocked on pricing.

/** One claimed LM reward slot (rewardOne → rewardInfos[0], rewardTwo → [1]). */
export interface ClaimedReward {
  /** Reward mint (base58), or "unknown" when the pool exposes none. */
  readonly mint: string;
  /** Claimed amount in the reward mint's atomic units (pre-transfer-fee). */
  readonly amountAtomic: number;
  /** USD value at claim time; null when the mint price is unavailable. */
  readonly amountUsd: number | null;
}

export interface RewardClaimSummary {
  /** Sum of the USD-priced reward amounts (unpriced rewards excluded). */
  readonly totalUsd: number;
  /** Rewards recorded without a USD value (price unavailable). */
  readonly unpricedCount: number;
  readonly totalCount: number;
}

export function summarizeRewardClaim(rewards: ReadonlyArray<ClaimedReward>): RewardClaimSummary {
  let totalUsd = 0;
  let unpricedCount = 0;
  for (const reward of rewards) {
    if (reward.amountUsd != null) {
      totalUsd += reward.amountUsd;
    } else {
      unpricedCount += 1;
    }
  }
  return { totalUsd, unpricedCount, totalCount: rewards.length };
}

/**
 * Metadata payload for a reward CLAIM position event. `kind: "lm_reward"`
 * distinguishes reward claims from swap-fee CLAIM rows (which carry only a
 * txSignature), and fees_usd stays NULL on reward rows so fee queries stay
 * fee-pure. Raw atomic amounts are always recorded, USD when priced.
 */
export function buildRewardClaimMetadata(args: {
  readonly txSignatures: ReadonlyArray<string>;
  readonly rewards: ReadonlyArray<ClaimedReward>;
}): Record<string, unknown> {
  return {
    kind: "lm_reward",
    txSignatures: [...args.txSignatures],
    rewards: args.rewards.map((r) => ({
      mint: r.mint,
      amountAtomic: r.amountAtomic,
      amountUsd: r.amountUsd,
    })),
  };
}
