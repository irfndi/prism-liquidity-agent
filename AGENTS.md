# AGENTS.md

Notes for AI agent harnesses (OpenClaw, Hermes, acpx, custom agents) and OpenCode sessions working in `prism-liquidity-agent` (the rename from `prism-dlmm` is in PR #24). Read this before touching the codebase — several things in `README.md`, `CLAUDE.md`, `ARCHITECTURE.md`, and `CONTRIBUTING.md` are stale or wrong.

## TL;DR for agent harnesses

If you're an agent (OpenClaw, Hermes, acpx, or custom) being asked to set up or operate Prism for a user, you do NOT need to:

- ❌ Deploy Cloudflare workers (already deployed — see [Live deployment](#live-deployment-production))
- ❌ Create D1/KV/R2/Vectorize resources (already exist)
- ❌ Set Cloudflare secrets (already configured)

You DO need to:

- ✅ Clone the repo and install dependencies
- ✅ Run `prism register` (calls the deployed API, returns an API key)
- ✅ Run `prism setup` (configures Helius key + watchlist)
- ✅ Run `prism dev` to start the trading agent

```bash
git clone https://github.com/irfndi/prism-liquidity-agent.git
cd prism-liquidity-agent
bun install
prism register                                    # gets API key from deployed API
prism setup --non-interactive --helius-key=$KEY    # configures trading agent
prism dev                                         # start paper trading
```

## Stack

- **Runtime**: Bun 1.2+ (dev, tests, build). Node 20+ for Docker.
- **Language**: TypeScript with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`. Easy to trip over — read errors carefully.
- **Framework**: [Effect-TS](https://effect.website) for DI (`Context.Tag` + `Layer`). No MCP server, no Anthropic SDK calls in the hot path.
- **Storage (engine)**: SQLite via `bun:sqlite` + `sqlite-vec` (NOT Chroma — see _Things docs get wrong_).
- **Storage (cloudflare)**: D1 database + KV + R2 + Vectorize. Separate subproject.
- **Build**: `tsdown` (entry: `engine/index.ts` → `dist/engine/index.js`).
- **Lint**: `oxlint` (NOT eslint) with `typescript`/`unicorn`/`oxc` plugins. Config at `.oxlintrc.json`. `correctness: error`, `no-unused-vars` and `require-yield` are explicitly off.
- **Format**: `oxfmt` (NOT prettier). Config at `.oxfmtrc.json` (empty ignorePatterns).
- **Test**: Vitest in two places:
  - Engine: `bench/**/*.test.ts` (uses `bun:sqlite`)
  - Cloudflare: `cloudflare/workers/**/*.test.ts` (uses `@cloudflare/vitest-pool-workers`)

## Repo layout

```
prism-liquidity-agent/
├── engine/             Core agent: strategy, adapters, risk, DB, memory, scan loop (flat dir, ~23 files)
├── cloudflare/         SEPARATE SUBPROJECT. Own package.json, vitest, wrangler config. API + Telegram bot workers
├── cli/                User-facing CLI (commander). 13 commands: register, login, whoami, wallet, telegram, etc.
├── ops/                Operational scripts: setup.ts (.env wizard), backtest.ts
├── bench/              Vitest tests for engine (pure logic only)
├── docs/               Markdown docs (install, CLI, cron, agent-harness)
├── types/              Type declarations (bs58)
└── .github/workflows/  ci.yml (engine) + deploy-cloudflare.yml (workers)
```

**There is no `probes/`, `tools/`, `adapters/`, `risk/`, or `memory/` directory.** `ARCHITECTURE.md`'s component map is fictional. Every engine file is flat in `engine/`.

## Commands (engine / root)

```bash
bun install                # install
bun run setup              # interactive .env wizard (writes .env)
bun run dev                # bun --watch engine/index.ts
bun run backtest           # bun run ops/backtest.ts
bun run test               # vitest run (bench/**/*.test.ts)
bun run test -- -t "<name>"# single test by name
bun run test -- bench/risk.test.ts  # single file
bun run test:watch         # vitest TUI (no `run` — interactive)
bun run lint               # tsc --noEmit && oxlint engine ops bench cli  (strict, slow)
bun run format             # oxfmt --write engine ops bench cli
bun run format:check       # oxfmt --check engine ops bench cli
bun run build              # tsdown → dist/engine/index.js
bun run coverage           # vitest --coverage (see Coverage exclusions below)
```

CI runs `bun install` → `bun run lint` → `bun run build` → `bun run test` on Bun canary / Node 20 (`.github/workflows/ci.yml`).

## Commands (cloudflare subproject)

```bash
cd cloudflare
bun install                                    # install CF deps
wrangler dev                                   # local dev of API worker
wrangler dev --config wrangler.telegram.toml   # local dev of Telegram bot
wrangler deploy                                # deploy API worker
wrangler deploy --config wrangler.telegram.toml  # deploy Telegram bot
wrangler d1 migrations apply prism-db --remote # apply DB migrations
wrangler d1 migrations apply prism-db --local  # apply to local D1
bun run typecheck                              # tsc --noEmit
bunx vitest run                                # 16 telegram bot tests (must use vitest 3.2.x for compatibility)
```

CI (`.github/workflows/deploy-cloudflare.yml`) on push to `main` (when `cloudflare/**` changes): install → typecheck → D1 migrations → deploy API → deploy Telegram bot.

## Live deployment (production)

| Resource              | Value                                               | Status    |
| --------------------- | --------------------------------------------------- | --------- |
| API Worker            | `https://prism-api.irfndi.workers.dev`              | ✅ Live   |
| Telegram Bot          | `https://prism-telegram-bot.irfndi.workers.dev`     | ✅ Live   |
| Bot username          | `@prism_agent_bot`                                  | ✅ Active |
| Cloudflare Account ID | `a37da71c38a2f7ab732057d87d5d0f6e`                  | Active    |
| D1 database           | `prism-db` (`0657c2b3-fdea-4b33-b11b-8d0a7b27cbc8`) | Active    |
| KV namespace          | `prism-cache` (`78d7fb5d3fab494dbc8f2940e524f22d`)  | Active    |
| R2 bucket             | `prism-backups`                                     | Active    |
| Vectorize index       | `prism-memory` (384d cosine)                        | Active    |

GitHub secrets required for CI/CD:

- `CLOUDFLARE_API_TOKEN` — Cloudflare API token with Workers, D1, KV, R2, Vectorize write access
- `CLOUDFLARE_ACCOUNT_ID` — `a37da71c38a2f7ab732057d87d5d0f6e`

CLI commands call the Cloudflare API. Telegram bot calls the API Worker via `fetch(API_BASE_URL + path)`.

## Engine architecture (start here)

```
engine/
├── index.ts          22-line bootstrap: Effect.runPromise(program) with buildLayer
├── program.ts        THE SCAN LOOP. All decision logic lives here (~792 lines).
├── services.ts       All Context.Tag definitions (one per service)
├── config-service.ts Env loader (Effect Config.string/.number/.boolean)
├── adapter-service.ts Meteora SDK + Helius calls (685 lines, biggest file)
├── strategy-service.ts Pure strategy math (fee/IL, vol auth, bin util)
├── risk-service.ts   Pre-execution gates
├── memory-service.ts Thin wrapper over db-service for memory ops
├── db-service.ts     SQLite queries (positions, audit, blacklists, memory, snapshots)
├── db.ts             Schema + sqlite-vec setup, 4-migration auto-migration system
├── audit-service.ts  JSONL audit logger
├── blacklist-service.ts Deployer/token blacklist checks
├── screener-service.ts  Pool discovery (when ENABLE_POOL_DISCOVERY=true)
├── embeddings.ts     @xenova/transformers wrapper (lazy ~80MB ONNX download on first use)
├── logger.ts         createLogger(component) → console + logs/audit-trail.jsonl
├── logger-service.ts DEAD CODE — do not consume
├── update-service.ts Auto-update mechanism
├── update-utils.ts   Update utilities (semver, GitHub API)
├── revenue-service.ts Subscription/fee modeling
├── types.ts          Shared interfaces
└── data/             deployer-blacklist.json, token-blacklist.json (both empty arrays)
```

### Effect-TS wiring pattern

All side effects go through services defined as `Context.Tag` in `engine/services.ts`. The wiring lives in `buildLayer()` in `engine/program.ts` (lines 60–86). To add a service:

1. Define the API in `engine/services.ts` with a `Context.Tag` class.
2. Implement `YourServiceLive` in a new `engine/your-service.ts` returning a `Layer`.
3. Add it to the `Layer.provide(...)` chain in `buildLayer()` (explicit `provide` is required because `merge` does NOT resolve cross-layer deps) and to the `AllServices` union.
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

## CLI commands (commander)

14 subcommands, all in `cli/`. Most spawn the engine or call the Cloudflare API:

- `setup` — interactive `.env` wizard (was `ops/setup.ts`)
- `register` — calls `POST /v1/register`, stores API key locally
- `login` — validates existing API key via `POST /v1/login`
- `whoami` — calls `GET /v1/whoami`
- `wallet {generate,import,show}` — non-custodial local keypair
- `link-telegram` — calls `POST /v1/link-telegram/start` to issue a 6-char code
- `subscription {status,renew}` — tier info
- `issue` — file GitHub issue via Cloudflare
- `support` — contact info
- `dev` — spawns `bun run dev` (engine)
- `backtest` — spawns `bun run backtest` (ops)
- `update` — checks/auto-applies updates
- `version` — current version

All API-bound commands share `cli/api.ts` (`prismApiPost` / `prismApiGet` / `readCredentials` / `writeCredentials`).
The base URL defaults to `https://prism-api.irfndi.workers.dev` and can be overridden with
`PRISM_API_URL`. Credentials are stored at `~/.config/prism/credentials.json` with `0o600` perms.

`prism` binary is `./cli/index.ts` (run via `bun run dev` or built CLI).

## Things docs get wrong

These are the high-cost mistakes. Do not trust stale prose — verify in code.

- **No MCP tools.** `engine/tools/index.ts` does not exist. The "intercept `meteora_decision`" pattern in `CLAUDE.md` and the "7 MCP tools" table in `ARCHITECTURE.md` describe an older design. The current engine decides directly inside `engine/program.ts`. `@anthropic-ai/sdk` is in `package.json` deps but unused at runtime.
- **Memory is `sqlite-vec`, not Chroma.** `engine/db.ts` creates a `vec0` virtual table for embeddings. `chromadb` is a dead dependency. `CHROMA_URL` is loaded in `config-service.ts` but never read by any service. `docker-compose.yml` still exists and starts a `chromadb/chroma` container that the app does not connect to.
- **Dockerfile is broken in three independent ways.** None of the dev workflow uses it, but a `docker build` will fail: (1) `COPY tsconfig.json tsup.config.ts ./` references `tsup.config.ts` which doesn't exist (migrated to `tsdown.config.ts`); (2) `COPY src ./src` copies a directory that doesn't exist; (3) `CMD ["node", "dist/main.js"]` points to a path that doesn't exist — `tsdown` outputs `dist/engine/index.js`. If you fix it, also note the runtime expects an `agent` user with `/app/logs` writable.
- **`engine/logger-service.ts` is dead code.** It defines a `LoggerService` `Context.Tag` and an `AppLogger` interface, but no `Layer` in `buildLayer()` provides it and nothing `yield*`s it. The real logger is `createLogger(component)` from `engine/logger.ts` (synchronous, not Effect-based). Don't try to consume `LoggerService` from a service — it will fail at runtime.
- **`@xenova/transformers` downloads a ~80MB ONNX model on first call.** `engine/embeddings.ts` now defaults to a deterministic hash-based fallback (set `EMBEDDINGS_BACKEND=onnx` to opt in). The ONNX path lazily calls `pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")` on the first `getEmbedding()` and can also crash in Node.js with a `BigInt` serialization error — when that happens, the agent logs a warning and falls back to hash embeddings automatically. CI never exercises the ONNX path; a local run with `EMBEDDINGS_BACKEND=fallback` (the default) starts in under a second.
- **`engine/bigint-json.ts` is the canonical BigInt-safe serializer.** Both `engine/audit-service.ts` and `engine/db-service.ts` use `stringifySafe()` to encode `PoolMetrics` / `BinArray` values that contain SDK-originated `bigint`s. Use this helper anywhere you'd otherwise call `JSON.stringify` on a value that might transitively contain a `bigint`.
- **Bundled blacklist files are empty arrays.** `engine/data/deployer-blacklist.json` and `engine/data/token-blacklist.json` both ship as `[]`. With no custom path or entries, the blacklist service is effectively a no-op. Override via `DEPLOYER_BLACKLIST_PATH` / `TOKEN_BLACKLIST_PATH` if you want filtering.
- **Deployer blacklist check is half-wired.** `blacklist.checkPool()` accepts a deployer arg, but `program.ts:219` has a `TODO: fetch token deployer/authority from on-chain metadata and pass to checkPool`. Deployer addresses are never actually checked. Only the token-level lookup runs.
- **`@jup-ag/api` and `@anthropic-ai/sdk` are unused.** `package.json` lists both, but nothing imports them. Jupiter prices are fetched via raw `fetch("https://price.jup.ag/v6/...")`. The Anthropic SDK is fully dead — `CLAUDE_MODEL`, `ANTHROPIC_API_KEY`, and `ANTHROPIC_BASE_URL` are loaded into config but never consumed at runtime. (`ANTHROPIC_BASE_URL` is even added to the loaded config but never read.)
- **`CHANGELOG.md` describes a pre-rewrite product.** v1.0.0 (2026-04-02) claims "Claude Agent SDK integration via 7-tool MCP surface" and "Chroma-backed memory". Neither exists. The changelog has not been updated since the sqlite-vec / no-MCP rewrite. Read code, not CHANGELOG, for current architecture.
- **`CONTRIBUTING.md` paths are wrong.** It references `src/mcp/server.ts`, `src/risk/engine.ts`, and `tests/` for new tests. None of these exist. The test dir is `bench/`, the service file is `engine/risk-service.ts`, etc.
- **License mismatch.** `package.json` says MIT; `CONTRIBUTING.md` says AGPL-3.0. Do not regenerate either without checking intent.
- **`CONTRIBUTING.md` says "no console.log — use `createLogger(component)`"**. `createLogger` is exported from `engine/logger.ts` and writes to `logs/audit-trail.jsonl`. The rule is aspirational — `engine/program.ts` and `engine/index.ts` use raw `console.info/warn/error/debug` extensively. Match the file you're editing.
- **Position state is persisted to SQLite.** `program.ts` calls `db.getAllPositions()` at startup (line 110) to populate a `Map` for fast cycle access, and `db.savePosition(...)` on every state change (ENTER, EXIT, REBALANCE, trailing-stop value update, fee claim) — 6 call sites total. The `trackedPositions` Map is just an in-memory cache; restart now preserves OOR counters, `highestValueUsd`, and trailing-stop state.
- **`LOG_LEVEL` env is a no-op.** CI sets `LOG_LEVEL: error` in `.github/workflows/ci.yml`, but `engine/logger.ts`'s `emit()` always writes regardless of level. Don't expect to silence CI logs with it.
- **One ENTER per cycle in live mode.** `program.ts:569` silently skips `ENTER` if `trackedPositions.size > 0`. Easy to mistake for a bug.
- **Live execution is a no-op without a wallet.** `WALLET_PRIVATE_KEY` is optional; with no key, `adapter.hasWallet()` returns false and `executeLive` exits early. Paper mode is the default and the only thing verified end-to-end.
- **Coverage is misleading.** `vitest.config.ts` excludes `engine/index.ts`, `engine/program.ts`, `engine/adapter-service.ts`, `engine/services.ts`, `engine/types.ts`, `engine/logger*`, `engine/config-service.ts`, `engine/memory-service.ts`, `engine/screener-service.ts` from coverage. The 80% / 70% thresholds apply only to the remaining modules — not the whole engine.
- **bin range widths.** `engine/strategy-service.ts:105` uses `±25` (binStep ≤ 10), `±20` (≤ 25), `±15` (otherwise). `CLAUDE.md` matches. `.agents/skills/dlmm-rebalancer.md` lists different numbers (`±15/±10/±7`) — the skill is wrong.
- **Memory merge threshold.** README says "cosine distance < 0.08" (similarity > 0.92). ARCHITECTURE.md says "cosine similarity > 0.70". Code is the only source of truth here; if it matters, search `engine/memory-service.ts`/`engine/db-service.ts`.
- **Memory TTLs are in code only.** `pattern` 90d, `warning` 60d, `outcome` 180d. The `ARCHITECTURE.md` table is correct; `README.md` only mentions patterns + warnings.
- **Hono `handle` is not exported in v4.x.** `cloudflare/workers/api/index.ts` previously imported `handle` from `hono/cloudflare-workers` — that adapter no longer exports it. Use `app.fetch(request, env, ctx)` directly in the `default export`.

## Storage & data files

- `prism.db` (SQLite, gitignored) — positions, audit, blacklists, vec0 memory, **pool_snapshots**. Override with `SQLITE_DB_PATH`. Tests use `:memory:`.
- `logs/audit-trail.jsonl` — appended by `createLogger` from `engine/logger.ts` (gitignored).
- `bench/tmp-audit/` — created and rewritten by `bench/audit.test.ts`. Not in `.gitignore` but should be (it appears in `git status` after running tests).
- `engine/data/deployer-blacklist.json`, `engine/data/token-blacklist.json` — default blacklist sources, override via `DEPLOYER_BLACKLIST_PATH` / `TOKEN_BLACKLIST_PATH`.
- D1 (cloudflare): `users`, `api_keys`, `telegram_link_codes`, `wallets`, `subscriptions`, `audit_log` (schema in `cloudflare/migrations/0001_initial.sql`).

## Snapshot capture & replay backtest

The agent can dump a full snapshot (pool state + bin array) into `pool_snapshots` on every cycle. This lets you replay real on-chain data through the strategy offline.

- **Enable**: set `ENABLE_SNAPSHOT_CAPTURE=true` in `.env` (only works when `PAPER_TRADING=true`).
- **Table**: `pool_snapshots` (migration v4). Fields: `pool_address`, `timestamp`, `active_bin_id`, `tvl_usd`, `volume_24h_usd`, `fees_24h_usd`, `apr`, `current_price`, `bin_step`, `token_x_symbol`, `token_y_symbol`, `bin_array_json`.
- **Bigints in bin arrays** are serialized via a custom `bigintReplacer` and deserialized back to `BigInt` — round-trip is verified in `bench/snapshot-replay.test.ts`.
- **Backtest replay**: `bun run backtest --source replay --db ./prism.db --days 7 --pools <addr>`. Reads snapshots from the DB and runs the same strategy loop as the synthetic baseline.
- **Backtest synthetic**: `bun run backtest --source synthetic --days 7` (default). Deterministic mock generator, kept as regression baseline.
- **API**: `DbApi.saveSnapshot`, `getSnapshots(pool, startMs, endMs)`, `getSnapshotPools()`, `getSnapshotCount(pool)` — defined in both `services.ts` (consumer) and `db-service.ts` (implementation).

## Env vars

`.env.example` is incomplete. The full set `engine/config-service.ts` loads includes (with defaults):

`PAPER_TRADING` (true), `SCAN_INTERVAL_MS` (600000), `MIN_POOL_TVL_USD` (50000), `MIN_FEE_IL_RATIO` (1.2), `TVL_DROP_EXIT_PCT` (0.30), `VOLUME_AUTH_THRESHOLD` (0.70), `MAX_CONCURRENT_POSITIONS` (5), `MIN_REBALANCE_INTERVAL_MS` (24h), `MIN_REBALANCE_NET_BENEFIT_USD` (10), `CONFIDENCE_THRESHOLD` (0.65), `PAPER_PORTFOLIO_USD` (10000), `MIN_BIN_UTILIZATION` (0.30), `MAX_REBALANCE_RANGE_BINS` (50), `WATCHLIST_POOLS` (comma-sep), `CLAUDE_MODEL`, `CHROMA_URL` (dead), `STOP_LOSS_PCT` (0.15), `TRAILING_STOP_PCT` (0.10), `OOR_GRACE_PERIOD_CYCLES` (3), `FEE_CLAIM_INTERVAL_MS` (24h), `ENABLE_POOL_DISCOVERY` (false), `DISCOVERY_MIN_TVL_USD` (100000), `DISCOVERY_MIN_FEE_RATIO` (1.5), `DEPLOYER_BLACKLIST_PATH`, `TOKEN_BLACKLIST_PATH`, `AUDIT_LOG_PATH` (`./logs/decision-audit.jsonl`), plus `ANTHROPIC_API_KEY`, `HELIUS_API_KEY`, `SOLANA_RPC_URL`, `WALLET_PRIVATE_KEY`, `AUTO_UPDATE` (true), `UPDATE_CHECK_INTERVAL_MS` (21600000), `UPDATE_CHANNEL` (stable), `UPDATE_GITHUB_REPO`, `UPDATE_ALLOW_DIRTY` (false).

In test mode (`VITEST=true` or `NODE_ENV=test`), missing `ANTHROPIC_API_KEY` / `HELIUS_API_KEY` default to dummy values so the suite can run without real keys.

## R2-based update mechanism (GitHub-independent)

`prism update` does **not** use `git fetch` or `git checkout`. Releases are tarballs hosted on **Cloudflare R2** (bucket `prism-backups`), so updates work even if GitHub is private or blocked.

### Flow

1. `prism update` fetches `https://r2.prism-agent.com/releases/latest.json` (R2 manifest) — or per-channel `releases/channel/{beta,dev}.json`
2. Compares `manifest.version` with the locally installed version (from `package.json`)
3. If newer, downloads the tarball from `manifest.tarball_url`
4. Verifies SHA-256 against `manifest.sha256_url` (mandatory, mismatch aborts)
5. Extracts to a temp dir, runs `bun install`, then copies the files over the current install
6. Cleans up temp dir

> **GPG signing is not yet verified client-side.** The release workflow optionally
> uploads a `.asc` signature (when the `GPG_PRIVATE_KEY` secret is configured),
> and the manifest points to it, but the updater does not currently call `gpg
--verify`. Treat the `.asc` as audit metadata until verification is wired in.

### Release process (`.github/workflows/release.yml`)

On push of a tag matching `v*.*.*`:

1. Checkout, install Bun, run `bun install`, `bun run lint`, `bun run test`
2. Build tarball (excludes `node_modules`, `dist`, `.git`, `*.db`, `logs`, `.env`, etc.)
3. Generate SHA-256 checksum
4. Sign with GPG (if `GPG_PRIVATE_KEY` secret is configured)
5. Upload tarball + checksum + signature to `prism-backups/releases/v{tag}/`
6. Update `prism-backups/releases/latest.json` (and per-channel manifests for `beta`/`dev`)
7. Optionally create a GitHub Release for visibility (falls back gracefully if GitHub is down)

### Fallback to GitHub Releases

If R2 is unreachable, `fetchLatestRelease()` automatically falls back to GitHub Releases API and extracts the same `prism-v*.tar.gz` asset. This means the update mechanism is resilient to:

- R2 outage (falls back to GitHub)
- GitHub private/blocked (R2 still works)
- Network issues (user can manually download from either)

### Config

- `UPDATE_R2_PUBLIC_URL` (default `https://r2.prism-agent.com`) — R2 public URL
- `UPDATE_GITHUB_REPO` (default `irfndi/prism-liquidity-agent`) — fallback repo
- `UPDATE_CHANNEL` (`stable` | `beta` | `dev`, default `stable`)

### CLI flags

```bash
prism update                          # check + apply latest stable from R2
prism update --check-only             # just check, don't apply
prism update --channel beta           # use beta channel
prism update --r2-url https://my-r2.example.com  # custom R2 URL
```

### R2 bucket structure

```
prism-backups/
├── releases/
│   ├── latest.json                    # latest stable manifest
│   ├── v1.2.3/
│   │   ├── prism-v1.2.3.tar.gz
│   │   ├── prism-v1.2.3.tar.gz.sha256
│   │   └── prism-v1.2.3.tar.gz.asc    # GPG signature (if configured)
│   ├── v1.2.4/
│   │   └── ...
│   └── channel/
│       ├── beta.json
│       └── dev.json
```

### Required GitHub secrets

- `CLOUDFLARE_API_TOKEN` — Cloudflare API token with R2 write access
- `CLOUDFLARE_ACCOUNT_ID` — `a37da71c38a2f7ab732057d87d5d0f6e`
- `GPG_PRIVATE_KEY` — (optional) GPG key for tarball signing
- `GITHUB_TOKEN` — (optional) for creating GitHub Releases

## Testing

- Engine tests live in `bench/*.test.ts`. There is no `tests/` directory.
- Engine suite is Effect-Layer based: each test builds a `Layer.merge(AuditLive, DbLive(":memory:"))` and provides it to the system under test. Use this pattern for new tests.
- `bench/audit.test.ts` mutates `bench/tmp-audit/` — do not commit it.
- Coverage thresholds (80% / 70%) apply only to _included_ files (see above). Don't read the coverage report as a project-wide signal.
- Cloudflare tests live in `cloudflare/workers/**/*.test.ts` and run via `@cloudflare/vitest-pool-workers`. Must use `vitest@^3.2.0` (not 4.x) due to pool compatibility — enforced in `cloudflare/package.json`.
- No integration tests, no mocks for Meteora SDK, no tests exercise the embedding pipeline or the main loop. `program.ts`, `adapter-service.ts`, and `engine/embeddings.ts` are all excluded from coverage and untested. The 4 engine test files cover pure logic only. CI passes with fake API keys because nothing real runs.

## Key constraints

- **No `any` types.** Use `unknown` and narrow. The repo has one intentional `as any` in `engine/adapter-service.ts` (parsed mint account data). Don't add more.
- **No commits without explicit request.**
- **Paper trading first** — wire all new execution paths to work in paper mode before live.
- **Risk gates run in order with early return** in `engine/risk-service.ts`. Add new gates as numbered blocks and return on first rejection — do not accumulate flags.
- **Use `app.fetch` not `handle(app)`** in Cloudflare Workers — Hono 4.x removed the `handle` export from `hono/cloudflare-workers`.

## Where to look first

- New to the codebase: `engine/index.ts` → `engine/program.ts` → `engine/services.ts` → `engine/config-service.ts`.
- Adding an engine service: `engine/services.ts` (Tag) + new `engine/x-service.ts` (Live Layer) + `buildLayer()` in `program.ts`.
- Adding a risk check: `engine/risk-service.ts` `evaluateRisk()`, plus add a `RiskConfig` field in `program.ts` `buildLayer()`.
- Changing decision rules: `evaluatePool` inside `engine/program.ts` `Effect.gen` (the logic is one ~280-line block, not split into helpers).
- Adding a Cloudflare route: `cloudflare/workers/api/index.ts`.
- Adding a Telegram command: `cloudflare/workers/telegram-bot/index.ts` (add handler + dispatch in `processUpdate`).
- Deploying: see `cloudflare/README.md` for full step-by-step.
