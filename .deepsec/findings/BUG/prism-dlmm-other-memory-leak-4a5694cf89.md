# [BUG] Unbounded token-risk cache never evicts entries (slow memory leak)

**File:** [`engine/token-risk-service.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/token-risk-service.ts#L172-L235) (lines 172, 199, 229, 235)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-memory-leak`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

The module-level `cache` Map (L172) is keyed by mint address and populated on every successful Jupiter consult (`cache.set` at L229 and L235) but is NEVER evicted. The TTL (`jupiterTokenRiskCacheTtlMin`) only controls when an entry is re-fetched; it does not remove entries. `clearTokenRiskCache()` is a test-only hook not called in production. The keys are attacker-influenced: `consultTokenRisks` is called from program.ts (L4189, L5403, L5448) with `[pool.tokenX, pool.tokenY]` — mints taken from on-chain DLMM pools, and any actor can create pools with novel mints. Over a long-running engine with pool discovery enabled, the cache grows without bound with every distinct mint ever seen (including negative-cache entries for delisted/unknown mints), gradually consuming memory. Realistically slow (each entry is small), but it is an unbounded growth with no upper bound and no eviction path.

## Recommendation

Add a bounded eviction strategy: cap the cache size (e.g., LRU with a max entry count), or delete entries whose `fetchedAt` is older than N TTLs, or periodically prune entries that are no longer referenced by any watched/discovered pool. A simple approach: when `cache.size` exceeds a limit, evict entries whose `fetchedAt` is oldest.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-22)
