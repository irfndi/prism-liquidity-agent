# [BUG] Unguarded JSON.parse on DB-sourced riskResultJson can fail the whole getRecentDecisions call

**File:** [`engine/audit-service.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/audit-service.ts#L46-L48) (lines 46, 48)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** medium  •  **Slug:** `other-unhandled-parse`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

`getRecentDecisions` (L36-55) parses `row.riskResultJson` with a bare `JSON.parse` (L48) and `row.metricsJson` with `parseBigIntSafe` (L46) with no try/catch. The data is written by this same code path, so it is normally valid — but any corrupted row (partial write, manual DB edit, schema drift, disk corruption) throws inside `Effect.sync`, converting the whole call into a defect. All current callers in program.ts wrap the call in `Effect.catchAll(() => Effect.succeed([]))`, so the practical impact is a silently emptied recent-decisions history (agent context, /decisions data, overlay context) rather than a crash — a fail-open that hides the corruption. `randomUUID` usage for the audit row id (L20) is correct and not a vulnerability.

## Recommendation

Wrap each row's JSON parsing in a try/catch (or use Effect.try) and skip rows that fail to parse, logging a warning, so one corrupt row degrades the history instead of emptying it.

## Recent committers (`git log`)

- irfandi marsya <join.mantap@gmail.com> (2026-07-19)
