# [BUG] Data API response pool address is never validated against the requested pool

**File:** [`engine/meteora-datapi-service.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/meteora-datapi-service.ts#L42-L100) (lines 42, 47, 93, 100)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** medium  •  **Slug:** `other-data-integrity`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

`parseMeteoraPoolStats` validates that `address` is a non-empty string (L47) but `enrichPoolWithDatapi(pool, stats)` (L93) never compares `stats.address` with `pool.address`. The stats (tvlUsd, volume24hUsd, fees24hUsd, apr, isBlacklisted, freeze flags, verified flags) are merged into the evaluated pool's state unconditionally. If the API returns a payload for a different pool — e.g. due to a redirect, a caching proxy mix-up, or a future API change — the engine would apply another pool's metrics and, more importantly, another pool's safety flags to the pool being evaluated. This could wrongfully reject a safe pool (foreign `isBlacklisted: true`) or wrongfully exempt a risky one (foreign `is_verified`/`freeze_authority_disabled` flags feeding the fail-closed freeze screen). The address field is already parsed; it should be verified against the requested pool before enrichment.

## Recommendation

In `getPoolData`, after parsing, reject (return null) unless `stats.address === poolAddress`, so mismatched payloads fall back to heuristic stats instead of being applied.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-22)
