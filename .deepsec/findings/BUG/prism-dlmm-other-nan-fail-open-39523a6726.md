# [BUG] NaN inputs fail open through the capital-protection gates

**File:** [`engine/risk-service.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/risk-service.ts#L465-L92) (lines 465, 469, 528, 542, 92)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** low  •  **Slug:** `other-nan-fail-open`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

evaluateGasGate (line 465) and evaluateCompoundGate (line 528) use threshold comparisons that are all false for NaN: `gasCostUsd <= 0` (line 469), `positionDailyFeesUsd <= 0`, `gasCostUsd > feesThresholdUsd`, and `savingsUsd <= 0` (line 542) all pass when the operand is NaN, so a NaN gas cost, SOL price, daily-fee estimate, or net-fee value approves the gate. evaluateRisk gate 6 (lines 92-111) has the same shape: `Math.max(NaN, 0)` is NaN, so `decision.positionSizeUsd > NaN` is false and the per-pool size cap is silently skipped. Config-sourced values are clamped by validatedNumber, but computed values (e.g. positionDailyFeesUsd = pool.fees24hUsd * positionSharePct in program.ts:4990, built from unvalidated API fee data) can be NaN, which would dissolve the gate. The gates are fail-open rather than fail-closed on malformed numeric input.

## Recommendation

Guard every gate input with Number.isFinite and reject (fail closed) when any input is NaN/Infinity; apply the same guard to portfolioValueUsd before computing the per-pool cap in evaluateRisk.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-22)
