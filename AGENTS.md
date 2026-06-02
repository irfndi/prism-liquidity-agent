# AGENTS.md

Notes for OpenCode sessions working in `prism-dlmm`. Read this before touching the codebase — several things in `README.md`, `CLAUDE.md`, `ARCHITECTURE.md`, and `CONTRIBUTING.md` are stale or wrong.

## Stack

- **Runtime**: Bun 1.2 (dev, tests, build). Node 20+ for Docker.
- **Language**: TypeScript with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`. Easy to trip over — read errors carefully.
- **Framework**: [Effect-TS](https://effect.website) for DI (`Context.Tag` + `Layer`). No MCP server, no Anthropic SDK calls in the hot path.
- **Storage**: SQLite via `bun:sqlite` + `sqlite-vec` (NOT Chroma — see *Things docs get wrong*).
- **Build**: `tsdown` (entry: `engine/index.ts` → `dist/engine/index.js`).
- **Lint**: `oxlint` (NOT eslint) with `typescript`/`unicorn`/`oxc` plugins. Config at `.oxlintrc.json`. `correctness: error`, `no-unused-vars` and `require-yield` are explicitly off.
- **Format**: `oxfmt` (NOT prettier). Config at `.oxfmtrc.json` (empty ignorePatterns).
- **Test**: Vitest, scoped to `bench/**/*.test.ts`.

## Commands

```bash
bun install                # install
bun run setup              # interactive .env wizard (writes .env)
bun run dev                # bun --watch engine/index.ts
bun run backtest           # bun run ops/backtest.ts
bun run test               # vitest run (bench/**/*.test.ts)
bun run test -- -t "<name>"# single test by name
bun run test -- bench/risk.test.ts  # single file
bun run test:watch         # vitest TUI (note: no `run` — interactive)
bun run lint               # tsc --noEmit && oxlint engine ops bench  (strict, slow)
bun run format             # oxfmt --write engine ops bench
bun run format:check       # oxfmt --check engine ops bench
bun run build              # tsdown → dist/engine/index.js
bun run coverage           # vitest --coverage (see Coverage exclusions below)
```

CI runs `bun install` → `bun run lint` → `bun run test` on Bun 1.2.15 / Node 20 (`.github/workflows/ci.yml`).

## Real architecture (start here)

```
engine/
├── index.ts          15-line bootstrap: Effect.runPromise(program)
├── program.ts        THE SCAN LOOP. All decision logic lives here.
├── services.ts       All Context.Tag definitions (one per service)
├── config-service.ts Env loader (Effect Config.string/.number/.boolean)
├── adapter-service.ts Meteora SDK + Helius calls (749 lines, biggest file)
├── strategy-service.ts Pure strategy math (fee/IL, vol auth, bin util)
├── risk-service.ts   Pre-execution gates
├── memory-service.ts Thin wrapper over db-service for memory ops
├── db-service.ts     SQLite queries (positions, audit, blacklists, memory)
├── db.ts             Schema + sqlite-vec setup
├── audit-service.ts  JSONL audit logger
├── blacklist-service.ts Deployer/token blacklist checks
├── screener-service.ts  Pool discovery (when ENABLE_POOL_DISCOVERY=true)
├── logger.ts         createLogger(component) → console + logs/audit-trail.jsonl
├── types.ts          Shared interfaces
└── data/             deployer-blacklist.json, token-blacklist.json
```

**There is no `probes/`, `tools/`, `adapters/`, `risk/`, or `memory/` directory.** ARCHITECTURE.md's component map is fictional. Every file is flat in `engine/`.

### Effect-TS wiring pattern

All side effects go through services defined as `Context.Tag` in `engine/services.ts`. The wiring lives in `buildLayer()` in `engine/program.ts` (lines 60–86). To add a service:

1. Define the API in `engine/services.ts` with a `Context.Tag` class.
2. Implement `YourServiceLive` in a new `engine/your-service.ts` returning a `Layer`.
3. Add it to the `Layer.mergeAll(...)` in `buildLayer()` and to the `AllServices` union.
4. `yield* YourService` inside the `Effect.gen` block in `program.ts` to consume it.

Don't import service classes directly. The whole runtime is one `Effect.gen` block.

### Decision flow (per cycle, per pool)

1. `adapter.getPoolState` + `adapter.getBinArray` — fetch on-chain
2. `blacklist.checkPool` — early reject (errors are swallowed, not raised)
3. `strategy.computeMetrics` — pure, no IO
4. Pre-filter: `tvlUsd < MIN_POOL_TVL_USD || volumeAuth < threshold || binUtil < threshold` → skip
5. `memory.getRelevantContext` for recent warnings (errors swallowed)
6. Decision rules in order: `EXIT` (TVL drop / vol auth / fee-IL<0.5) → `REBALANCE` (drift > 60% OR out-of-range grace expired) → `HOLD` (existing position) → `ENTER` (new pool, strict thresholds: `feeIlRatio > min*1.5`, `volAuth > 0.8`, `binUtil > 0.4`, `tvlUsd > min*2`)
7. `risk.evaluate` — gates execution
8. `audit.recordDecision` — every decision is logged (errors swallowed)
9. Execute: paper (`trackedPositions.set/delete`) or live (`adapter.enterPosition`/etc.)

## Things docs get wrong

These are the high-cost mistakes. Do not trust stale prose — verify in code.

- **No MCP tools.** `engine/tools/index.ts` does not exist. The "intercept `meteora_decision`" pattern in `CLAUDE.md` and the "7 MCP tools" table in `ARCHITECTURE.md` describe an older design. The current engine decides directly inside `engine/program.ts`. `@anthropic-ai/sdk` is in `package.json` deps but unused at runtime.
- **Memory is `sqlite-vec`, not Chroma.** `engine/db.ts` creates a `vec0` virtual table for embeddings. `chromadb` is a dead dependency. `CHROMA_URL` is loaded in `config-service.ts` but never read by any service. `docker-compose.yml` still exists and starts a `chromadb/chroma` container that the app does not connect to.
- **Dockerfile is broken in three independent ways.** None of the dev workflow uses it, but a `docker build` will fail: (1) `COPY tsconfig.json tsup.config.ts ./` references `tsup.config.ts` which doesn't exist (migrated to `tsdown.config.ts`); (2) `COPY src ./src` copies a directory that doesn't exist; (3) `CMD ["node", "dist/main.js"]` points to a path that doesn't exist — `tsdown` outputs `dist/engine/index.js`. If you fix it, also note the runtime expects an `agent` user with `/app/logs` writable.
- **`engine/logger-service.ts` is dead code.** It defines a `LoggerService` `Context.Tag` and an `AppLogger` interface, but no `Layer` in `buildLayer()` provides it and nothing `yield*`s it. The real logger is `createLogger(component)` from `engine/logger.ts` (synchronous, not Effect-based). Don't try to consume `LoggerService` from a service — it will fail at runtime.
- **`@xenova/transformers` downloads a ~80MB ONNX model on first call.** `engine/embeddings.ts` lazily calls `pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")` on the first `getEmbedding()`, which happens at the first decision cycle when `db.upsertMemory` / `db.queryMemory` runs. Not at startup. CI never exercises this path (no test calls `getEmbedding()`), so a local run will stall on cycle 1 for the download.
- **Bundled blacklist files are empty arrays.** `engine/data/deployer-blacklist.json` and `engine/data/token-blacklist.json` both ship as `[]`. With no custom path or entries, the blacklist service is effectively a no-op. Override via `DEPLOYER_BLACKLIST_PATH` / `TOKEN_BLACKLIST_PATH` if you want filtering.
- **Deployer blacklist check is half-wired.** `blacklist.checkPool()` accepts a deployer arg, but `program.ts:195` has a `TODO: fetch token deployer/authority from on-chain metadata and pass to checkPool`. Deployer addresses are never actually checked. Only the token-level lookup runs.
- **`@jup-ag/api` and `@anthropic-ai/sdk` are unused.** `package.json` lists both, but nothing imports them. Jupiter prices are fetched via raw `fetch("https://price.jup.ag/v6/...")`. The Anthropic SDK is fully dead — `CLAUDE_MODEL`, `ANTHROPIC_API_KEY`, and `ANTHROPIC_BASE_URL` are loaded into config but never consumed at runtime. (`ANTHROPIC_BASE_URL` is even added to the loaded config but never read.)
- **`CHANGELOG.md` describes a pre-rewrite product.** v1.0.0 (2026-04-02) claims "Claude Agent SDK integration via 7-tool MCP surface" and "Chroma-backed memory". Neither exists. The changelog has not been updated since the sqlite-vec / no-MCP rewrite. Read code, not CHANGELOG, for current architecture.
- **`CONTRIBUTING.md` paths are wrong.** It references `src/mcp/server.ts`, `src/risk/engine.ts`, and `tests/` for new tests. None of these exist. The test dir is `bench/`, the service file is `engine/risk-service.ts`, etc.
- **License mismatch.** `package.json` says MIT; `CONTRIBUTING.md` says AGPL-3.0. Do not regenerate either without checking intent.
- **`CONTRIBUTING.md` says "no console.log — use `createLogger(component)`"**. `createLogger` is exported from `engine/logger.ts` and writes to `logs/audit-trail.jsonl`. The rule is aspirational — `engine/program.ts` and `engine/index.ts` use raw `console.info/warn/error/debug` extensively. Match the file you're editing.
- **Position state is in-memory only.** `program.ts` uses a module-level `Map` (`trackedPositions`); restart loses everything. `db-service.ts` has `savePosition` / `getPosition` / `getAllPositions` methods, and the `DbService` is wired into `buildLayer()`, but `program.ts` never `yield*`s `DbService` and never calls them. The current feature branch (`feat/sqlite-persistence-meridian-restore`) is in-flight on this exact work — grep the branch for partial progress before implementing your own persistence.
- **`LOG_LEVEL` env is a no-op.** CI sets `LOG_LEVEL: error` in `.github/workflows/ci.yml`, but `engine/logger.ts`'s `emit()` always writes regardless of level. Don't expect to silence CI logs with it.
- **One ENTER per cycle in live mode.** `program.ts` line 488 silently skips `ENTER` if `trackedPositions.size > 0`. Easy to mistake for a bug.
- **Live execution is a no-op without a wallet.** `WALLET_PRIVATE_KEY` is optional; with no key, `adapter.hasWallet()` returns false and `executeLive` exits early. Paper mode is the default and the only thing verified end-to-end.
- **Coverage is misleading.** `vitest.config.ts` excludes `engine/index.ts`, `engine/program.ts`, `engine/adapter-service.ts`, `engine/services.ts`, `engine/types.ts`, `engine/logger*`, `engine/config-service.ts`, `engine/memory-service.ts`, `engine/screener-service.ts` from coverage. The 80% / 70% thresholds apply only to the remaining modules — not the whole engine.
- **bin range widths.** `engine/strategy-service.ts:105` uses `±25` (binStep ≤ 10), `±20` (≤ 25), `±15` (otherwise). `CLAUDE.md` matches. `.agents/skills/dlmm-rebalancer.md` lists different numbers (`±15/±10/±7`) — the skill is wrong.
- **Memory merge threshold.** README says "cosine distance < 0.08" (similarity > 0.92). ARCHITECTURE.md says "cosine similarity > 0.70". Code is the only source of truth here; if it matters, search `engine/memory-service.ts`/`engine/db-service.ts`.
- **Memory TTLs are in code only.** `pattern` 90d, `warning` 60d, `outcome` 180d. The `ARCHITECTURE.md` table is correct; `README.md` only mentions patterns + warnings.

## Storage & data files

- `prism.db` (SQLite, gitignored) — positions, audit, blacklists, vec0 memory. Override with `SQLITE_DB_PATH`. Tests use `:memory:`.
- `logs/audit-trail.jsonl` — appended by `createLogger` from `engine/logger.ts` (gitignored).
- `bench/tmp-audit/` — created and rewritten by `bench/audit.test.ts`. Not in `.gitignore` but should be (it appears in `git status` after running tests).
- `engine/data/deployer-blacklist.json`, `engine/data/token-blacklist.json` — default blacklist sources, override via `DEPLOYER_BLACKLIST_PATH` / `TOKEN_BLACKLIST_PATH`.

## Env vars

`.env.example` is incomplete. The full set `engine/config-service.ts` loads includes (with defaults):

`PAPER_TRADING` (true), `SCAN_INTERVAL_MS` (600000), `MIN_POOL_TVL_USD` (50000), `MIN_FEE_IL_RATIO` (1.2), `TVL_DROP_EXIT_PCT` (0.30), `VOLUME_AUTH_THRESHOLD` (0.70), `MAX_CONCURRENT_POSITIONS` (5), `MIN_REBALANCE_INTERVAL_MS` (24h), `MIN_REBALANCE_NET_BENEFIT_USD` (10), `CONFIDENCE_THRESHOLD` (0.65), `PAPER_PORTFOLIO_USD` (10000), `MIN_BIN_UTILIZATION` (0.30), `MAX_REBALANCE_RANGE_BINS` (50), `WATCHLIST_POOLS` (comma-sep), `CLAUDE_MODEL`, `CHROMA_URL` (dead), `STOP_LOSS_PCT` (0.15), `OOR_GRACE_PERIOD_CYCLES` (3), `FEE_CLAIM_INTERVAL_MS` (24h), `ENABLE_POOL_DISCOVERY` (false), `DISCOVERY_MIN_TVL_USD` (100000), `DISCOVERY_MIN_FEE_RATIO` (1.5), `DEPLOYER_BLACKLIST_PATH`, `TOKEN_BLACKLIST_PATH`, `AUDIT_LOG_PATH` (`./logs/decision-audit.jsonl`), plus `ANTHROPIC_API_KEY`, `HELIUS_API_KEY`, `SOLANA_RPC_URL`, `WALLET_PRIVATE_KEY`.

In test mode (`VITEST=true` or `NODE_ENV=test`), missing `ANTHROPIC_API_KEY` / `HELIUS_API_KEY` default to dummy values so the suite can run without real keys.

## Testing

- Tests live in `bench/*.test.ts`. There is no `tests/` directory.
- The suite is Effect-Layer based: each test builds a `Layer.merge(AuditLive, DbLive(":memory:"))` and provides it to the system under test. Use this pattern for new tests.
- `bench/audit.test.ts` mutates `bench/tmp-audit/` — do not commit it.
- Coverage thresholds (80% / 70%) apply only to *included* files (see above). Don't read the coverage report as a project-wide signal.
- No integration tests, no mocks for Meteora SDK, no tests exercise the embedding pipeline or the main loop. `program.ts`, `adapter-service.ts`, and `engine/embeddings.ts` are all excluded from coverage and untested. The 4 test files cover pure logic only. CI passes with fake API keys because nothing real runs.

## Key constraints

- **No `any` types.** Use `unknown` and narrow. The repo has one intentional `as any` in `engine/adapter-service.ts` (parsed mint account data). Don't add more.
- **No commits without explicit request.**
- **Paper trading first** — wire all new execution paths to work in paper mode before live.
- **Risk gates run in order with early return** in `engine/risk-service.ts`. Add new gates as numbered blocks and return on first rejection — do not accumulate flags.

## Where to look first

- New to the codebase: `engine/index.ts` → `engine/program.ts` → `engine/services.ts` → `engine/config-service.ts`.
- Adding a service: `engine/services.ts` (Tag) + new `engine/x-service.ts` (Live Layer) + `buildLayer()` in `program.ts`.
- Adding a risk check: `engine/risk-service.ts` `evaluateRisk()`, plus add a `RiskConfig` field in `program.ts` `buildLayer()`.
- Changing decision rules: `evaluatePool` inside `engine/program.ts` `Effect.gen` (the logic is one ~280-line block, not split into helpers).
