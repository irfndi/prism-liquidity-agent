# [BUG] Reward amounts stored as Number lose precision above 2^53 (documented project anti-pattern)

**File:** [`engine/rewards.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/rewards.ts#L17-L58) (lines 17, 30, 58)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** low  •  **Slug:** `other-bigint-precision`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

ClaimedReward.amountAtomic (line 17) and the metadata payload built by buildRewardClaimMetadata (line 58) store Solana atomic reward amounts as JS numbers. The upstream producer in adapter-service.ts (lines 3019-3020) converts the SDK's BN reward values via Number(position.positionData.rewardOne.toString()), which silently loses precision above Number.MAX_SAFE_INTEGER (~9.007e15) — exactly the pattern the project's own guidance (engine/bigint-json.ts stringifySafe) forbids. The same lossy value is used to compute amountUsd ((slot.amountAtomic / 10^decimals) * price) and is accumulated into cumulativeRewardsClaimedUsd in program.ts claimAllFees, so a large LM reward (e.g. >9e6 tokens of a 9-decimal mint, or low-decimal memecoins like BONK with 5 decimals) is recorded and USD-valued from a rounded number, skewing position_events metadata and cumulative PnL accounting. The scanner's 'insecure-crypto' flags at lines 5/7 are comments and are false positives.

## Recommendation

Keep raw atomic amounts as bigint/string end-to-end (use stringifySafe from engine/bigint-json.ts for metadata serialization) and convert to Number only for USD valuation after dividing by 10^decimals; change ClaimedReward.amountAtomic to string|bigint and only expose a Number for the USD value.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-19)
