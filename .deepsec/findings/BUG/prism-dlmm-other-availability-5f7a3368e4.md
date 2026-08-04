# [BUG] Copy-signal feed re-fetched per pool per cycle with no caching — serial loop stalls

**File:** [`engine/copy-trading-signals.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/copy-trading-signals.ts#L101-L129) (lines 101, 121, 129)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** low  •  **Slug:** `other-availability`

## Owners

**Suggested assignee:** `irfandi@users.noreply.github.com` _(via last-committer)_

## Finding

getBoost (L121-157) performs a fresh HTTP fetch of the entire signal feed on every invocation, and the decision loop calls it once per candidate pool per scan cycle (program.ts L5962-5964 and L3208-3210) even though the response is identical across pools (pool filtering happens client-side at L133). Each fetch runs under retryEffectWithBackoff with up to 2 retries and a 10s AbortSignal timeout (L101), so a slow or unreachable endpoint can stall the single-threaded scan loop for up to ~30s per pool per cycle — N pools → N×30s — silently returning boost 0 via catchAll (L139-142). The engine's scan loop is serial (program.ts L6810), so this is a self-inflicted availability degradation whenever the configured endpoint degrades.

## Recommendation

Cache the fetched feed for the configured staleMs window (TTL cache shared across getBoost calls) and/or fetch once per cycle and pass the parsed result to all pools; also consider lowering the fetch timeout/retry budget for this advisory feed.

## Recent committers (`git log`)

- irfandi marsya <irfandi@users.noreply.github.com> (2026-07-20)
- irfandi marsya <join.mantap@gmail.com> (2026-07-19)
