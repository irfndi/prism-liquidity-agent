# [BUG] Replay source reads CWD-relative ./prism.db, ignoring SQLITE_DB_PATH/PRISM_DATA_DIR

**File:** [`ops/backtest.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/ops/backtest.ts#L39-L476) (lines 39, 149, 476)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-logic-bug`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

parseArgs() defaults `dbPath` to `"./prism.db"` (line 39) relative to the process CWD and never consults `SQLITE_DB_PATH` or `PRISM_DATA_DIR`, which are the canonical DB paths used by the engine (engine/paths.ts getPrismDbPath) and by the MCP server's status/positions tools. Running `prism backtest --source replay` from any directory other than the project root (e.g., the compiled binary from home, or the MCP server whose CWD is the app dir) silently reads the wrong database — loadSnapshots catches the error and returns [] (lines 155-166), so the user just sees 'no snapshots found' or, worse, replays stale snapshots from an unrelated prism.db sitting in the CWD. Additionally, DbLive→createDatabase (engine/db.ts:99-103) creates the file and runs WAL/migrations if missing, so a stray empty prism.db is created as a side effect.

## Recommendation

Resolve the replay DB path through the same canonical resolution as the engine (honor SQLITE_DB_PATH, then PRISM_DATA_DIR/prism.db, matching engine/paths.ts getPrismDbPath) instead of a hardcoded CWD-relative default.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-27)
