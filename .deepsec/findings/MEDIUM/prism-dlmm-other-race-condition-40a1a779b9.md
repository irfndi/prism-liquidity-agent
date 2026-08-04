# [MEDIUM] Settlement job double-submit race: no atomic claim before live swap submission

**File:** [`engine/autonomous-runtime.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/autonomous-runtime.ts#L152-L361) (lines 152, 312, 321, 361)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-race-condition`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

processSettlementJobs (L146) reads the full job list via db.listSettlementJobs and processes each due job with no atomic claim: the job is saved as 'prepared' (L312) via a blind `INSERT ... ON CONFLICT(id) DO UPDATE` upsert (db-service.ts L1218-1230) with no `WHERE status='retryable'` guard, then submitSwap is executed (L321). Two processes sharing the same SQLite DB (restart overlap during graceful shutdown, or a second agent instance) can both read the same due job and both submit a full-amount swap for the position's tokens — on-chain double-sell. A second vector: if the adapter's sendRawTransaction throws after broadcast (RPC error), the signature is unknowable, the onBroadcast callback (L323-330) never fires, `submitted` stays false, and the job is retried with the full amount re-quoted (L361-372) — the first tx may land later, selling the tokens twice. The code mitigates the known-signature case (the `not_found` branch at L227-250 deliberately keeps the job 'submitted' to avoid rearming submission), but the unknown-signature and cross-process cases are unguarded. The scanner's 'weak cipher' flags at L18/L39 are false positives.

## Recommendation

Claim the job atomically before submission (e.g., `UPDATE settlement_jobs SET status='claimed' WHERE id=? AND status IN ('retryable','submitted') AND next_retry_at <= ?` and check rowsAffected; bail if zero). For the indeterminate-submit case, persist the submitted intent before calling sendRawTransaction and require explicit operator/status reconciliation when the signature is unknown, rather than blindly re-quoting the full amount.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-08-03)
