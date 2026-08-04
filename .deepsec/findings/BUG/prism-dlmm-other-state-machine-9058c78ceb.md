# [BUG] Dangling 'planned' execution_operations when the SOL balance gate rejects a live ENTER

**File:** [`engine/program.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/program.ts#L1191-L1256) (lines 1191, 1253, 1256)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-state-machine`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

executeLive persists an entry operation with status 'planned' (L1191) before the SOL-funding gates. When the gate rejects the ENTER — `getNativeSolBalance()` fails (L1253-1256) or `solBalance < MIN_SOL_FOR_ENTRY_LAMPORTS` returns — the function returns `{ executed: false, error }` without marking the operation failed or creating a rollback. The execution_operations row stays 'planned' forever, so later reconciliation (listExecutionOperations / processSettlementJobs) has no way to distinguish a genuinely in-flight entry from one that never started. This is a state-machine gap, not a wallet-risk issue, but it can mislead operators auditing autonomous-mode operations.

## Recommendation

Wrap every early-return in the ENTER path (balance-read failure, insufficient SOL, missing token prep) with a db.saveExecutionOperation({...entryOperation, status: 'failed', error}) update before returning, or defer persisting the 'planned' row until after the balance gates pass.

## Recent committers (`git log`)

- irfndi <join.mantap@gmail.com> (2026-08-03)
