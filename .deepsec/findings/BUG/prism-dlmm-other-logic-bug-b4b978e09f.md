# [BUG] prism_backtest replay mode reads a different DB than prism_status/prism_positions

**File:** [`mcp-server/src/tools.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/mcp-server/src/tools.ts#L15-L266) (lines 15, 17, 245, 263, 266)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-logic-bug`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

The prism_backtest tool (lines 245-266) shells out to `prism backtest --source replay --days N --pools ...` via runPrism (line 266). The subprocess inherits the MCP server's env, but the backtest CLI (ops/backtest.ts parseArgs, line 39) hardcodes the replay DB path to `./prism.db` relative to the subprocess CWD and never reads SQLITE_DB_PATH. Meanwhile prism_status/prism_positions use getPrismDbPath() (lines 15-18) which honors SQLITE_DB_PATH and PRISM_DATA_DIR as documented in the README. Net effect: with the README's recommended `SQLITE_DB_PATH` config, replay backtests silently return 'no snapshots' (or replay stale data from a CWD-local prism.db), and the backtest's DB open (engine/db.ts createDatabase) creates a stray empty prism.db in the MCP server's CWD — contradicting the README's claim that the server only performs read-only operations. The `pools` parameter is validated only as `z.array(z.string())`, so nothing constrains an inconsistent/inaccessible DB path.

## Recommendation

Pass the resolved DB path explicitly to the backtest subprocess (e.g. append `--db <getPrismDbPath()>` when source is 'replay'), or have ops/backtest.ts resolve the path through the same SQLITE_DB_PATH/PRISM_DATA_DIR logic as engine/paths.ts. Also cap the pools array length to prevent unbounded CPU work.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-18)
