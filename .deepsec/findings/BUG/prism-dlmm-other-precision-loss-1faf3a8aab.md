# [BUG] Exit-sweep fee amounts converted with Number() lose precision

**File:** [`engine/program.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/program.ts#L1804-L1805) (lines 1804, 1805)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-precision-loss`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

In executeLive's EXIT path, `const pendingFeeX = Number(exitResultData?.pendingFeeXAtomic ?? "0")` (L1804-1805) round-trips the adapter's atomic exit-sweep amounts through a float before booking them into fee_claims (pendingFeeX/pendingFeeY) and the cumulative fee ledger. Above 2^53 the booked fee is wrong, corrupting realized-PnL inputs and the fee_claims report to the revenue API. Same root cause as the adapter finding; the engine already keeps withPnl in bigint elsewhere.

## Recommendation

Keep pendingFeeX/pendingFeeY as bigint strings end-to-end (they are already strings from the adapter) and only convert to number for USD display via atomicToUnits.

## Recent committers (`git log`)

- irfndi <join.mantap@gmail.com> (2026-08-03)
