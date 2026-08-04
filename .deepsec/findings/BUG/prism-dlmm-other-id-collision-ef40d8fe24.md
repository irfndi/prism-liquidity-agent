# [BUG] Client-supplied id is used as primary key in shared feedback table

**File:** [`cloudflare/workers/api/index.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/cloudflare/workers/api/index.ts#L1112-L1213) (lines 1112, 1127, 1213)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** medium  •  **Slug:** `other-id-collision`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

POST /v1/feedback requires a client-supplied `body.id` (lines 1213-1215) and storeFeedback inserts it verbatim as the `feedback` table primary key (lines 1112-1127). Because the table is shared across tenants, a second user submitting the same id gets a PK violation surfaced as a generic 500 'Failed to store feedback' — a cross-tenant denial of feedback submission (and accidental id collisions between CLI installs are silently deduped away). The codebase explicitly hardened the error-report path against exactly this pattern: upsertErrorReports derives a server-side rowId from hash(userId + fingerprint) with a comment stating 'a client-supplied report id can never collide across users' (lines ~255-262) — feedback still trusts the client id. Dedup remains user-scoped (user_id + agent_id + hash), so there is no cross-tenant data leakage, and exploitability is low since CLI ids are random UUIDs, but the asymmetry is a real integrity/availability flaw.

## Recommendation

Derive the feedback row id server-side (e.g. generateId() or a hash of userId + client id) and store the client-supplied id in a separate column, mirroring the error_logs receipts design.

## Recent committers (`git log`)

- irfndi <join.mantap@gmail.com> (2026-08-03)
