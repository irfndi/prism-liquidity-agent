# [BUG] Math.random()-based report IDs are not cryptographically random

**File:** [`engine/error-reporter.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/error-reporter.ts#L163-L166) (lines 163, 164, 165, 166)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-info-disclosure`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

generateId() (L163-166) builds report IDs from Date.now() + a monotonic counter + Math.random().toString(36).slice(2,8). This is flagged by the scanner as 'Math.random in security context', but the ID is only a server-side dedup/correlation identifier and is not used for any security decision, so it is not exploitable. Noted only for completeness; no action required unless these IDs ever become security-bearing.

## Recommendation

No change required for security. If IDs ever become unguessable identifiers, switch to crypto.randomUUID().

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-13)
