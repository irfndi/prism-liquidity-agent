# [BUG] Reward atomic amounts typed as number, enabling silent BigInt precision loss in claim accounting

**File:** [`engine/rewards.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/rewards.ts#L17-L58) (lines 17, 58)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-bigint-precision`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

ClaimedReward.amountAtomic is declared as `number` (L17) and propagated into position-event metadata by buildRewardClaimMetadata (L58). To satisfy this type, the adapter converts SDK BN values with Number(bn.toString()) — engine/adapter-service.ts L2454/L2458 (exit sweep: `Number(rewardOneAtomic.toString())`) and L3019-L3020 (claimRewards: `Number(position.positionData.rewardOne.toString())`). This is the exact precision antipattern the repo's own guidelines call out (SDK BN values must stay strings/bigint; the exit-withdrawal path does this correctly with .toString() + BigInt round-trip). For reward claims above Number.MAX_SAFE_INTEGER (~9.0e15 atomic units — e.g. >~9M units of a 9-decimal high-supply LM reward token), the recorded amountAtomic silently rounds (up to ~1024 atomic units at 2^64 scale), so the CLAIM/EXIT event metadata in SQLite records amounts that differ from what the chain actually paid, and the derived reward USD ((amountAtomic / 10^decimals) * price, adapter L3104 and L2506) inherits the rounding. Relative error is tiny (~2^-53) so there is no fund loss or materially wrong PnL, and the on-chain claim itself is unaffected — this is an accounting-fidelity defect, but it contradicts the documented stringifySafe/BigInt pattern and corrupts the append-only event ledger for large claims. The hasPending gate (adapter L3021-L3023) is unaffected since positive values stay positive under rounding.

## Recommendation

Change ClaimedReward.amountAtomic to bigint (or string, matching the exit-withdrawal atomics), convert SDK BN values via .toString() instead of Number(), and compute USD via atomicToUnits(BigInt(...), decimals) as the exit path already does. Update buildRewardClaimMetadata to serialize the atomic as a string.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-19)
