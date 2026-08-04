# [BUG] Reconciliation path never expires: jobs with missing swap evidence loop forever

**File:** [`engine/autonomous-runtime.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/autonomous-runtime.ts#L130-L361) (lines 130, 206, 216, 361)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** medium  •  **Slug:** `other-infinite-retry`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

When a confirmed swap is missing output evidence (getConfirmedSwapOutput returns null — L216) or the SOL price is unavailable (L206), the job is routed to reconciliationJob (L130-138), which sets status 'prepared' with nextRetryAt: null and no expiry check. On the next cycle, the top-of-loop guard (L152-155) only skips 'terminal' jobs or jobs with a future nextRetryAt, so the 'prepared' job is re-processed every cycle: getSwapStatus → getConfirmedSwapOutput → reconciliationJob again, indefinitely, hammering the RPC and price services every scan cycle with no terminalization. Contrast the `not_found` branch (L227-250), which explicitly checks `input.now >= job.expiresAt` and terminalizes. The catchAll path (L361-363) also routes submitted-but-unmeasurable jobs into this same never-expiring loop.

## Recommendation

Give reconciliationJob an expiry check symmetric to the not_found branch: when `now >= job.expiresAt`, terminalize the job with an operator-reconciliation error instead of re-cycling 'prepared' forever.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-08-03)
