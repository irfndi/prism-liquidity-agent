# [BUG] BigInt→Number precision loss in fee/reward accounting corrupts platform-fee transfers

**File:** [`engine/adapter-service.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/adapter-service.ts#L2753-L2041) (lines 2753, 2754, 2850, 2854, 3019, 2454, 2041)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-precision-loss`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

The DLMM SDK returns BN amounts; converting them with Number() silently loses precision above 2^53 (~9.007e15). In claimFees (L2753-2754) `const feeX = Number(position.positionData.feeX.toString())` feeds calculateRevenueShare → platformFeeX = Math.floor(feeX * rate), and the actual on-chain fee transfer is built from the already-imprecise float: `createTransferInstruction(fromAta, toAta, wallet, BigInt(Math.floor(amount)))` (L2850-2854). claimRewards (L3019: `Number(position.positionData.rewardOne.toString())`) and exitPosition reward slots (L2454/2458) have the same defect, and getPositions (L2041) reports `feesEarnedUsd: Number(data.feeX.toString()) + Number(data.feeY.toString())` — raw atomic units mislabeled as USD. For 9-decimal tokens, precision loss starts above ~9M tokens of fees; a whale position can cause the platform-fee transfer amount and the fee_claims ledger to be wrong (operator over-/under-paid), and the mislabeled 'USD' figure is displayed in agent status. This violates the codebase's own documented convention (atomicToUnits/stringifySafe in engine/bigint-json.ts), which the same file uses correctly elsewhere (atomicToUnits in readWalletSnapshot).

## Recommendation

Keep fee/reward amounts in bigint/BN until the transfer boundary: compute the platform share with bigint arithmetic (e.g. feeXAtomic * rateBps / 10000) and pass BigInt directly to createTransferInstruction. Use atomicToUnits()/stringifySafe() for any USD/display conversion, and fix getPositions to convert atomics to USD with real prices instead of raw atomics.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-08-03)
