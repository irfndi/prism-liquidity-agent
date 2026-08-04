# [BUG] TOCTOU race in acquireLock allows two concurrent launchers to both acquire the dev lock

**File:** [`cli/lockfile.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/cli/lockfile.ts#L162-L178) (lines 162, 164, 171, 176, 178)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** medium  •  **Slug:** `other-race-condition`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

The stale-lock reclaim path in acquireLock (lines 162-180) has an unlink-then-create race that the ownership re-validation does not fully close. Scenario: (1) Two `prism dev` processes A and B both read the same stale lockfile whose PID is dead (both pass the `isProcessAlive` check at line 152). (2) A unlinks the stale lock (line 164) and creates a fresh lock with A's pid (line 171); A's re-read (line 176) confirms `pid === process.pid` and A returns `{ acquired: true }` (line 178). (3) B — whose decision to unlink was made from its earlier read of the stale lock and whose unlink at line 164 is unconditional (it does not re-verify the file content) — now unlinks A's *fresh* lock. (4) B creates its own lock (line 171) and re-reads its own pid, returning `{ acquired: true }`. Both A and B now believe they hold the lock. The re-validation at lines 173-180 only protects against another process creating the lock *between* B's unlink and B's create; it does not protect A's freshly-created lock from being removed by B's unconditional unlink. Because `cli/dev.ts` gates the engine on `acquireLock()` and then proceeds to live trading, two concurrent instances would both run the trading engine against the same wallet simultaneously — duplicate ENTER/EXIT/REBALANCE transactions, conflicting position state, and potential financial loss. The existing bench test (`bench/cli-dev-lockfile.test.ts` "does not steal from a live owner between atomic create and read") only covers the case where the second process's create fails with EEXIST, not the unlink-after-recreate interleaving.

## Recommendation

Re-read the lockfile immediately before unlinking and only unlink if it still contains the exact stale `{pid, timestamp}` that was read earlier (compare content, not just existence); alternatively use an atomic locking primitive such as `flock`/`fs-ext`, or a lock directory created with `mkdir` (atomic) instead of an unlink-based reclaim, or use `fs.link` with a unique temp name so ownership is provable. The current unlinkSync is a destructive operation that races with any concurrent re-creator.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-07)
