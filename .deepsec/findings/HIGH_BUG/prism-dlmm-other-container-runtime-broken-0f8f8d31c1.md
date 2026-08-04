# [HIGH_BUG] Non-root runtime user cannot create the SQLite data directory — container fails to start

**File:** [`Dockerfile`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/Dockerfile#L30-L48) (lines 30, 37, 39, 48)
**Project:** prism-dlmm
**Severity:** HIGH_BUG  •  **Confidence:** medium  •  **Slug:** `other-container-runtime-broken`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

The runtime stage creates the agent user with `useradd --system --no-create-home` (line 30) and switches to it with `USER agent` (line 39), but never creates or chowns a data directory the engine can write. The engine resolves its SQLite path via `getPrismDbPath()` (engine/paths.ts:107-110) to `~/.local/share/prism/prism.db` (i.e. `/home/agent/.local/share/prism/prism.db`), and `createDatabase()` (engine/db.ts:99-100) calls `fs.mkdirSync(path.dirname(path.resolve(dbPath)), {recursive:true})`. Since `/home/agent` was never created (--no-create-home) and `/home` is root-owned, the mkdir throws EACCES, which propagates through `DbLive` (engine/db-service.ts:142) and aborts the layer build in program.ts:791. The log path `getPrismLogsDir()` (paths.ts:113-114) is also `~/.local/share/prism/logs`, so the `chown -R agent:agent /app/logs` at line 37 targets a directory the engine never uses. The container as shipped (CMD `bun dist/index.mjs`, no SQLITE_DB_PATH/PRISM_DATA_DIR env set) cannot initialize its database or logs and will crash on startup or lose all persistence.

## Recommendation

Create a writable data directory for the agent user and point the engine at it, e.g. `RUN mkdir -p /app/data && chown -R agent:agent /app/data` plus `ENV SQLITE_DB_PATH=/app/data/prism.db PRISM_DATA_DIR=/app/data` (and PRISM_CONFIG_DIR for credentials), or create/chown the home directory (`mkdir -p /home/agent && chown -R agent:agent /home/agent`) so the default `~/.local/share/prism` paths resolve.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-11)
