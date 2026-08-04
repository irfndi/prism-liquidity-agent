# [BUG] Canary GC keep-guard compares full R2 path against bare directory names (dead protection)

**File:** [`.github/workflows/ci.yml`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/.github/workflows/ci.yml#L309-L356) (lines 309, 322, 356)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-logic-bug`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

In the 'Garbage-collect old canary builds' step, `keep = process.env.BUILD_DIR` receives `releases/canary/<TS>-<SHA8>` (set by canary-prepare as build_dir=releases/canary/${TS}-${SHA8}, passed at L309), but the byDir map is keyed by `parts[2]` — the bare `<TS>-<SHA8>` directory name. `keepDirs.add(keep)` therefore never matches any entry in `dirs`, so the commented invariant 'never delete the just-published ${BUILD_DIR}' is not actually enforced. The just-published build survives only because dir names sort chronologically and the newest is always inside `dirs.slice(length-5)`. If that ordering ever breaks — e.g. an older prepared run publishing after a newer one under the cancel-in-progress concurrency group, or clock skew making the fresh timestamp sort earlier — GC will delete the just-published canary assets while the manifest pointer (flipped last) still references them, breaking the canary channel for all `prism update --canary` users.

## Recommendation

Normalize the keep value before adding it to the set, e.g. `keepDirs.add(keep.split('/').pop())` or compare `releases/canary/${dir}` === keep, and add a guard that aborts deletion if the keep dir is not present among the listed dirs.

## Recent committers (`git log`)

- irfndi <join.mantap@gmail.com> (2026-08-03)
- dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com> (2026-07-20)
