# [MEDIUM] Agent proposal positionId is not validated against the proposal's poolAddress — cross-pool position targeting

**File:** [`engine/risk-service.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/risk-service.ts#L346-L358) (lines 346, 351, 358)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-position-targeting`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

In evaluateAgentProposal, positionId is taken verbatim from the proposal (line 346: `let positionId = proposal.positionId ?? ctx.originalDecision?.positionId`) with no check that the position belongs to proposal.poolAddress (or even exists in ctx.openPositions). The adjusted decision (line 358) carries it through, and the executor resolves it directly by id (program.ts resolveTargetPosition: `trackedPositions.get(decision.positionId)` with no pool-membership check). The pool-scannability check in the HTTP queue (http-status-server.ts) only validates poolAddress against watchlist/held pools, not positionId. A proposal submitter holding the proposal token (or a prompt-injected sync agent) can therefore submit an EXIT/REBALANCE for a watched pool while naming the positionId of a position on a DIFFERENT pool. EXIT is unconditionally approved by risk gate 1, and every risk gate that should protect the target (stop-loss, active-bin containment, per-pool allocation) evaluates the wrong pool's data. The comment on lines 341-344 claims untargeted ambiguity 'fails closed at execution', but an explicitly named cross-pool id does not fail closed.

## Recommendation

In evaluateAgentProposal, reject proposals whose positionId is not present in ctx.openPositions with pos.poolAddress === proposal.poolAddress; also enforce the same in resolveTargetPosition in program.ts as defense in depth.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-22)
