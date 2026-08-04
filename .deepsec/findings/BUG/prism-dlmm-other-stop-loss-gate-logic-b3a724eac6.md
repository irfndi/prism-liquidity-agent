# [BUG] Stop-loss gate can check the wrong position and is effectively dead for HOLD decisions

**File:** [`engine/risk-service.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/risk-service.ts#L69-L74) (lines 69, 71, 72, 73, 74)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** medium  •  **Slug:** `other-stop-loss-gate-logic`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

Risk gate 5 (lines 69-78) finds the position via `ctx.positionId !== undefined ? find(p.id === positionId) : openPositions.find(p => p.poolAddress === decision.poolAddress)`. When positionId is absent (idle-redeploy, replay, and the agent path where the proposal carries no id), the pool-level find returns the FIRST position in the array — on a multi-position pool (explicitly supported, Wave 10) a profitable sibling masks a losing position, defeating the stop-loss. Additionally, the main scan path (program.ts:6000-6002) pre-approves every HOLD decision (`decision.action === "HOLD" ? { approved: true } : risk.evaluate(...)`), so the stop-loss gate only ever fires for REBALANCE; a position breached past stopLossPct has its REBALANCE denied without being routed to EXIT, so the gate can strand the position in a losing state rather than protecting capital.

## Recommendation

Resolve the stop-loss target by the decision's resolved positionId (or by matching positionPubKey) and verify the position belongs to the decision's pool; when the stop-loss gate trips for HOLD/REBALANCE, return a decision that routes to EXIT instead of a bare denial, or evaluate the gate for HOLD too.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-22)
