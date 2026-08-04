# [BUG] Non-atomic request pacing allows concurrent bursts past the 30 req/min GeckoTerminal keyless limit

**File:** [`engine/gecko-terminal-service.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/gecko-terminal-service.ts#L211-L217) (lines 211, 212, 213, 214, 215, 216, 217)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** medium  •  **Slug:** `other-pacing-race`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

getGeckoPoolStats() (L213-219) implements the 2.1s inter-request pacing with a module-level lastGeckoRequestAt timestamp using a check-then-act sequence: `nextAllowedAt > now` is evaluated, then `lastGeckoRequestAt = Date.now()` is set. The check and the update are not atomic, so when the discovery fan-out evaluates multiple pools concurrently (the file's own comment notes 'Discovery can fan out ~50 pools per cycle'), several calls can observe nextAllowedAt <= now simultaneously and all fire in the same instant, bursting past the 28-30 req/min ceiling. The documented consequence is 429 responses, which the fail-through (returns null, falls back to the adapter's heuristic) absorbs; the impact is degraded stats quality rather than a crash, and the code anticipates it. Still, the race defeats the stated purpose of the pacing and can hammer the public API during a Data API outage.

## Recommendation

Make the pacing reservation atomic (e.g., serialize getGeckoPoolStats through a mutex/semaphore, or compute nextAllowedAt from the last RESERVED slot rather than the last completed request), so concurrent callers back off instead of bursting.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-27)
