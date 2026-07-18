# AGENTS.md

Notes for AI agent harnesses (OpenClaw, Hermes, acpx, custom agents) and OpenCode sessions working in `prism-liquidity-agent`. Read this before editing — several older docs (`README.md`, `CLAUDE.md`, `ARCHITECTURE.md`) describe stale designs (MCP hot path, Chroma, etc.). The current code is the source of truth.

## TL;DR for agent harnesses

You do **not** need to deploy Cloudflare resources — the API Worker, Telegram bot, D1, KV, R2 and Vectorize resources are already live. You **do** need a Helius API key.

```bash
git clone https://github.com/irfndi/prism-liquidity-agent.git
cd prism-liquidity-agent
bun install

# Required before setup and dev so telemetry, errors, and feedback have an owner
prism register

# Required — writes .env and configures the agent
prism setup --non-interactive --helius-key=$HELIUS_KEY

# Start paper trading
prism dev
```

Registration is required before setup and dev. The API account owns telemetry,
errors, feedback, and cloud account operations; Telegram remains optional.

## Project overview

Prism is an autonomous liquidity agent for Solana (currently Meteora DLMM). It scans a watchlist of pools on a configurable interval, evaluates each pool with a rule-based strategy, and decides to **HOLD**, **ENTER**, **REBALANCE** or **EXIT**. By default it runs in paper-trading mode; live on-chain execution requires an explicit wallet private key and `PAPER_TRADING=false`.

The project has three independent layers:

1. **CLI / engine** (local, required) — strategy, risk, memory, execution, backtesting, wallet management.
2. **Cloudflare Workers** (cloud, required for setup/dev) — user accounts, API keys, subscriptions, Telegram linking, and authenticated D1 telemetry/feedback.
3. **Telegram bot** (chat, optional) — monitoring via `@prism_agent_bot`; requires the API layer.

There are also optional peripheral subprojects:

- `mcp-server/` — a standalone Node-based MCP server that reads the SQLite DB and shells out to `prism`.
- `packages/autogpt-prism/` and `packages/langchain-prism/` — Python plugin skeletons with their own `pyproject.toml`.
- `skills/` and `marketplaces/` — skill definitions for agent harnesses.

## Technology stack

- **Runtime:** Bun `>=1.4.0-canary.1` for development, tests and engine builds. Node 22+ is used only by the Docker image and the `mcp-server` subproject.
- **Language:** TypeScript with strict settings: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes`, `noFallthroughCasesInSwitch`.
- **Framework / DI:** [Effect-TS](https://effect.website) (`Context.Tag` + `Layer`). All side effects go through services.
- **On-chain:** `@meteora-ag/dlmm` SDK + Helius RPC (`SOLANA_RPC_URL`).
- **Local storage:** SQLite via `bun:sqlite` + `sqlite-vec` for vector memory.
- **Cloud storage:** Cloudflare D1, KV, R2, Vectorize.
- **Cloud API:** Hono 4.x inside Cloudflare Workers.
- **Build:** `tsdown` (root engine entry → `dist/index.mjs`).
- **Lint:** `oxlint` with `typescript`/`unicorn`/`oxc` plugins; config in `.oxlintrc.json`.
- **Format:** `oxfmt`; config in `.oxfmtrc.json`.
- **Test:** Vitest 4.x. Engine tests require Bun and fail fast if run under Node.

## Key configuration files

| File                                                  | Purpose                                                                                                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                                        | Root manifest, scripts, dependencies. Current version `0.0.31`.                                                                               |
| `tsconfig.json`                                       | Strict TypeScript config for `engine/`, `ops/`, `bench/`, `cli/`, `types/`.                                                                   |
| `vitest.config.ts`                                    | Engine test config; coverage thresholds and exclusions.                                                                                       |
| `tsdown.config.ts`                                    | Build config for the engine bundle (`engine/index.ts` → `dist/index.mjs`).                                                                    |
| `tsdown.cli.config.ts`                                | Build config for the CLI bundle (`cli/index.ts` → `dist/cli/`).                                                                               |
| `.oxlintrc.json`                                      | `oxlint` rules: `correctness: error`, `no-unused-vars` and `require-yield` off.                                                               |
| `.oxfmtrc.json`                                       | `oxfmt` config (empty `ignorePatterns`).                                                                                                      |
| `.env.example`                                        | Example env file. **Incomplete** — canonical defaults and full env set live in `engine/config-service.ts`.                                    |
| `Dockerfile`                                          | Multi-stage Bun-based image; runtime uses `oven/bun:canary-slim`, installs `libsqlite3-0` + `ca-certificates`, runs as non-root `agent` user. |
| `scripts/prism.sh`                                    | The `prism` binary wrapper; resolves install root, sets `PRISM_INSTALL_DIR`, then runs `cli/index.ts`.                                        |
| `cloudflare/package.json`                             | Separate subproject for API + Telegram workers.                                                                                               |
| `cloudflare/wrangler.toml` / `wrangler.telegram.toml` | Cloudflare Worker configs.                                                                                                                    |
| `mcp-server/package.json`                             | Node-based MCP server subproject.                                                                                                             |
| `packages/*/pyproject.toml`                           | Python plugin skeletons (not part of the Bun build).                                                                                          |

## Repo layout

```text
prism-liquidity-agent/
├── engine/            # Core agent: strategy, adapters, risk, DB, memory, scan loop (~45 flat files)
├── cli/               # Commander-based user-facing commands
├── ops/               # Operational scripts: setup wizard, backtest, fetch-history
├── bench/             # Engine tests (Vitest, Bun-only)
├── cloudflare/        # Separate subproject: API Worker + Telegram bot
├── mcp-server/        # Separate Node subproject: stdio MCP server
├── packages/          # Python plugin skeletons (AutoGPT, LangChain)
├── scripts/           # install.sh, postinstall.js, build-bundle.ts, generate-vec-embed.ts, etc.
├── skills/            # Runtime skill definitions for agent harnesses
├── marketplaces/      # Marketplace skill listings
├── docs/              # User and agent-harness documentation
└── types/             # Type declarations (bs58)
```

There is no `src/`, `adapters/`, `risk/`, `memory/` or `tools/` directory inside the engine. Every engine module is flat in `engine/`.

## Build, run and test commands

### Root (engine + CLI)

```bash
bun install                 # installs deps + runs postinstall (writes default .env, generates sqlite-vec embed)
bun run setup               # interactive .env wizard (also available as `prism setup`)
bun run lint                # tsc --noEmit && oxlint engine ops bench cli
bun run format              # oxfmt --write engine ops bench cli
bun run format:check        # oxfmt --check engine ops bench cli
bun run build               # tsdown engine/index.ts -> dist/index.mjs
bun run test                # vitest run (bench/**/*.test.ts); REQUIRES Bun
bun run test -- -t "name"   # single test by name
bun run test -- bench/risk.test.ts
bun run test:watch          # vitest interactive TUI
bun run coverage            # vitest --coverage
bun run backtest            # bun run ops/backtest.ts
bun run dev                 # bun --watch engine/index.ts (see Direct-execution guard below)
```

### Cloudflare subproject

```bash
cd cloudflare
bun install
bun run typecheck              # tsc --noEmit
wrangler dev                   # API worker local dev
wrangler dev --config wrangler.telegram.toml   # Telegram bot local dev
wrangler deploy                # deploy API worker
wrangler deploy --config wrangler.telegram.toml  # deploy Telegram bot
wrangler d1 migrations apply prism-db --remote
bunx vitest run                # Cloudflare worker tests
```

### MCP server subproject

```bash
cd mcp-server
npm install
npm run build                  # tsc
npm test                       # node --import tsx --test test/*.test.ts
```

### CLI entry points

- `prism <command>` — the supported user entry point. The wrapper resolves the install root and runs `cli/index.ts`.
- `bun cli/index.ts <command>` — source development entry point.
- `bun run dev` runs `engine/index.ts` directly, but `engine/index.ts` refuses direct execution unless `PRISM_ALLOW_DIRECT=true`. The CLI `prism dev` sets this flag and calls `runEngine()` from `engine/run-engine.ts`.

## Runtime architecture

### Entry points

- `engine/index.ts` — short bootstrap that imports `run-engine.js` and blocks accidental direct execution.
- `engine/run-engine.ts` — loads config, sets up error reporting, redirects stdout/stderr to `logs/engine.log`, and runs `program` with `buildLayer(config)`.
- `engine/program.ts` — the main scan loop and decision logic. It is a single large `Effect.gen` block.
- `cli/index.ts` — Commander program that registers all subcommands.

### Effect-TS service wiring

All engine side effects are exposed through `Context.Tag` services defined in `engine/services.ts`.

To add a service:

1. Define the API in `engine/services.ts` as a `Context.Tag` class.
2. Implement `YourServiceLive` in a new `engine/your-service.ts` returning a `Layer`.
3. Add it to the `AllServices` union and to the `Layer.merge` chain in `engine/program.ts` `buildLayer()`.
4. Consume it with `yield* YourService` inside the `Effect.gen` block.

Do not import service implementations directly in program logic. `Layer.provide` is used where cross-layer dependencies exist; `Layer.merge` does **not** resolve cross-layer dependencies.

### Decision loop (per cycle, per pool)

1. `adapter.getPoolState` + `adapter.getBinArray` fetch on-chain data (real per-bin reserves via `dlmm.getBinsAroundActiveBin`). `meteoraDatapi.getPoolData` then overlays real TVL/volume/fees from the Meteora Data API (`statsSource: "datapi"`); on API failure it logs a warning and the adapter's heuristic stats are used (`statsSource: "heuristic"`).
2. Safety screening early-rejects the pool with a recorded rejected decision + audit + warning: (a) Data API `is_blacklisted=true` or `freeze_authority_disabled=false`; (b) on-chain freeze authority set on either mint (`adapter.getMintAuthorities`, mint authority doubles as the deployer fallback); (c) `blacklist.checkPool` hits the token or deployer blacklist. Positive signals fail closed; transport/IO errors (blacklist load, RPC metadata fetch, Data API down) fail open with a warning.
3. `strategy.computeMetrics` produces pure metrics (fee/IL, volume authenticity, bin utilization, TVL velocity vs the previous `pool_snapshots` row). Metrics whose inputs are unavailable are reported as explicit "unknown" (`volumeAuthenticityKnown` / `binUtilizationKnown` on `PoolMetrics`); unknown metrics skip their pre-filter/EXIT gates with a warning and block ENTER (fail-closed), never fabricate 1.0.
4. Pre-filter skips pools below `MIN_POOL_TVL_USD`, `VOLUME_AUTH_THRESHOLD` or `MIN_BIN_UTILIZATION`.
5. `memory.getRelevantContext` recalls recent warnings/patterns (errors swallowed).
6. Decision rules evaluate, in order: `EXIT` → `REBALANCE` → `HOLD` → `ENTER`. Deterministic `EXIT` conditions (TVL drop, low fee/IL, volume authenticity, volatility gate, trailing stop) only fire for pools with a tracked position — positionless pools take the ENTER/HOLD path only.
7. `risk.evaluate` gates execution: `EXIT` is always approved first (capital protection beats the confidence gate), then the confidence gate and remaining structural checks. `HOLD` skips risk evaluation entirely (it executes nothing; rejections used to spam warning memory and suppress the good-HOLD branch). Portfolio value for the drawdown/allocation/size gates is `walletBalanceUsd + Σ openPositions.currentValueUsd`.
8. `audit.recordDecision` logs every decision (errors swallowed).
9. Execution updates the in-memory `trackedPositions` Map and persists to SQLite via `db.savePosition`. EXIT soft-closes the row via `db.closePosition` (sets `closed_at` + `realized_pnl_usd`, row kept for history); `db.deletePosition` is reserved for true cleanup (stale paper rows, externally-closed positions).

### Position persistence

`trackedPositions` is only an in-memory cache. At startup `program.ts` loads all rows from `positions` into the Map, and every state change (ENTER, EXIT, REBALANCE, trailing-stop update, fee claim) is written back to SQLite. Active-position queries (`getAllPositions`) exclude rows with `paper_exited_at` or `closed_at` set; history queries (`getClosedPositions`) return them.

### PnL accounting

Each position row carries `entry_price_usd` (pool `currentPrice` at ENTER), `entry_amount_x_usd` / `entry_amount_y_usd` (USD value of each leg at entry — the documented 50/50 model, half the entry size per leg, since the adapter does not return actual on-chain deposit amounts), `cumulative_fees_claimed_usd`, `closed_at` and `realized_pnl_usd`. Every lifecycle transition also appends to the append-only `position_events` log (`ENTER` / `EXIT` / `REBALANCE` / `CLAIM` / `COMPOUND` with value, fees, price and metadata).

`depositedUsd` is the cost basis. Auto-compounded fees become new cost basis when redeposited (they were already counted in `cumulative_fees_claimed_usd` when claimed, so total-PnL math stays continuous); `currentValueUsd` and `highestValueUsd` adjust in lockstep via `applyCompoundToCostBasis` in `engine/pnl.ts` so the trailing stop is not distorted. Pure analytics live in `engine/pnl.ts`: unrealized PnL = `currentValueUsd + cumulativeFeesClaimedUsd − depositedUsd`; HODL benchmark = `entryAmountXUsd × (currentPrice / entryPrice) + entryAmountYUsd`; fee APR = fees / cost basis annualized by position age; time-in-range is approximated as `1 − (current OOR stint / age)` (recovered past stints are not tracked and count as in-range time — a documented overestimate).

Positions opened before migration v16 have NULL entry fields: analytics and the CLI degrade gracefully (no HODL benchmark / IL-vs-HODL — shown as `n/a` — and PnL falls back to the legacy `currentValueUsd − depositedUsd` model). The CLI surfaces all of this in `prism portfolio` (per-position + totals), `prism portfolio history` (realized PnL from `closed_at` rows) and `prism status`; the current price for the HODL benchmark comes from the latest `pool_snapshots` row.

### Agent runtime overlay

When `AGENTIC_MODE=true`, the engine can talk to a local agent harness (Hermes via ACP, OpenClaw via Gateway WebSocket). It exposes:

- **MCP server** over stdio — tools `prism_status`, `prism_positions`, `prism_decisions`, `prism_config`, plus proposal tools when enabled. Enable with `AGENT_MCP_ENABLED=true`.
- **HTTP fallback** on `127.0.0.1:AGENT_HTTP_PORT` — endpoints `/health`, `/status`, `/positions`, `/decisions`, `/config`, and (when proposal mode allows) `/propose` + `/approve`.

**Proposal modes** (`AGENT_PROPOSAL_MODE`, default `veto`):

| Mode | Applied to execution? | Authority |
| --- | --- | --- |
| `veto` | Yes (overlay only) | May **reduce confidence** or force `HOLD` only. Legacy safety overlay. |
| `suggest` | No | Advisory log only; never changes the decision. |
| `supervised` | Only human-approved queue | `ENTER`/`REBALANCE` require an approved queued proposal (`AGENT_APPROVAL_TOKEN`). Deterministic `EXIT` stays free. No sync-advisor apply. |
| `full` | Yes, after validation | May change action except non-`ENTER`→`ENTER` and safety-`EXIT` downgrades. `HOLD`→`REBALANCE` still must pass min-interval / gas / recovery gates. |

Defaults stay fail-closed (`AGENTIC_MODE=false`, mode `veto`, empty tokens). `/approve` requires a distinct `AGENT_APPROVAL_TOKEN` (no fallback to the proposal enqueue token). No remote LLM API keys are used.

### Proactive Telegram alerts

`engine/alert-service.ts` (`AlertService`) maps engine events to alert types (`position_out_of_range`, `range_warning`, `exit_executed`, `risk_rejection`, `fee_milestone`) and POSTs them to `POST /v1/alerts` with the registered API key. The API worker stores each alert in the `alerts` D1 table and forwards it to the bot worker (`POST /internal/deliver-alert`, `BOT_API_SECRET`-authenticated) which pushes the Telegram message. Per-rule cooldowns and the fee-milestone accumulator persist in the SQLite `metadata` table (keys `alert_cooldown:*`, `alert_fee_total_usd`, `alert_fee_next_milestone_usd`) so restarts do not reset throttling. The service **fails open**: delivery errors are logged and swallowed, never blocking a scan cycle. Alerts are a user-requested utility, not telemetry — `PRISM_FEEDBACK_OPT_OUT` does not affect them. Opt-outs: `ALERTS_ENABLED=false` engine-side, `/alerts off` per-user bot-side (users `alerts_enabled` flag).

## Code style and conventions

- **No `any` types.** Use `unknown` and narrow. The repo intentionally contains one `as any` in `engine/adapter-service.ts` for parsed mint account data; do not add more.
- **Strict TypeScript.** Read compiler errors carefully — `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `noImplicitOverride` are enabled.
- **Logging.** Prefer `createLogger(component)` from `engine/logger.ts`. It writes structured JSON to `logs/audit-trail.jsonl`. Some legacy files still use raw `console.*`; match the file you are editing, and do not introduce new raw `console.log` in new code.
- **Effect patterns.** Keep side effects inside services. Use `Effect.catchAll` / `Effect.catchAllCause` for recoverable errors. Use `Effect.gen` for sequential logic.
- **Risk gates.** Add new checks as numbered blocks in `engine/risk-service.ts` `evaluateRisk()` and return early on the first rejection. Do not accumulate flags.
- **Paper trading first.** Any new execution path must work in paper mode before being wired to live on-chain code.
- **BigInt JSON.** Use `stringifySafe` from `engine/bigint-json.ts` whenever serializing values that may contain SDK-originated `bigint`s.
- **Formatting.** Run `bun run format` before finishing. CI enforces `oxfmt --check`.

## Testing

- Engine tests live in `bench/**/*.test.ts`. There is no `tests/` directory for the engine.
- Engine tests **require Bun**. `vitest.config.ts` throws a clear error if `typeof Bun === "undefined"`.
- Most engine tests build isolated Effect layers, e.g. `Layer.merge(AuditLive, DbLive(":memory:"))`.
- `bench/audit.test.ts` writes to `bench/tmp-audit/` — do not commit it.
- Coverage is configured in `vitest.config.ts`:
  - Thresholds: `statements 75`, `branches 60`, `functions 75`, `lines 75`.
  - Excluded from coverage: `engine/index.ts`, `engine/program.ts`, `engine/adapter-service.ts`, `engine/services.ts`, `engine/types.ts`, `engine/logger.ts`, `engine/config-service.ts`, `engine/memory-service.ts`, `engine/screener-service.ts`.
- Cloudflare tests live in `cloudflare/workers/**/*.test.ts` and run with `@cloudflare/vitest-pool-workers`.
- The `mcp-server` subproject uses Node's built-in test runner with `tsx`.

## Deployment and release

### CI (engine)

`.github/workflows/ci.yml` runs on pushes/PRs to `main`/`master`:

1. `bun install`
2. `bun run scripts/generate-vec-embed.ts linux x64`
3. `bun run lint`
4. `bun run build`
5. `bun run test`

### Cloudflare deploy

`.github/workflows/deploy-cloudflare.yml` runs when `cloudflare/**` changes on `main`:

1. `bun install` inside `cloudflare/`
2. `bun run typecheck`
3. Apply D1 migrations (`--remote`)
4. Deploy API worker
5. Deploy Telegram bot worker

Required secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

### Release

`.github/workflows/release.yml` runs on `v*.*.*` tags:

1. Verifies `package.json` version matches the tag.
2. Runs lint + tests.
3. Builds platform bundles for `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64` via `scripts/build-bundle.ts`.
4. Builds a source tarball.
5. Generates SHA-256 checksums and optional GPG signatures.
6. Uploads assets to Cloudflare R2 (`prism-backups/releases/v{VERSION}/`).
7. Updates `prism-backups/releases/latest.json` and per-channel manifests (`beta`, `dev`).
8. Creates or updates a GitHub Release.

`prism update` downloads from R2 and verifies SHA-256; it falls back to GitHub Releases if R2 is unreachable.

### Docker

The `Dockerfile` builds the engine bundle with `oven/bun:canary-slim`, then copies `dist/`, `node_modules/` and `package.json` into a runtime stage that installs `libsqlite3-0` and `ca-certificates`. The container runs as the `agent` user and executes `bun dist/index.mjs`.

## Security and privacy

- **`.env` permissions.** `setup.ts` writes `.env` with mode `0o600` and backs up any existing file.
- **Credentials.** API keys are stored in `${PRISM_CONFIG_DIR:-~/.config/prism}/credentials.json` with `0o600`.
- **Wallet keys.** `WALLET_PRIVATE_KEY` is optional. Without it, `adapter.hasWallet()` returns false and live execution is a no-op. Paper trading is the default and is the only path verified end-to-end.
- **Direct-execution guard.** `engine/index.ts` exits unless invoked through the CLI (`prism dev` / `bun cli/index.ts dev`) or `PRISM_ALLOW_DIRECT=true` is set.
- **Install telemetry.** Anonymous install pings are sent at install, setup, dev-start and register. They use a random local UUID stored in `~/.config/prism/install-id` and include no PII. Set `PRISM_API_URL` to a non-existent host to block pings.
- **Feedback.** `prism feedback` submits authenticated records to Prism Cloud D1 and keeps a local SQLite record for deduplication/outage recovery. Opt out with `PRISM_FEEDBACK_OPT_OUT=true`.
- **Auto-update integrity.** The updater verifies SHA-256 checksums before applying a release. GPG signatures are generated but **not yet verified client-side**.
- **Secret sanitization.** `engine/error-reporter.ts` strips sensitive values from telemetry.
- **Telegram bot ↔ API shared secret.** `BOT_API_SECRET` (wrangler secret, set on BOTH workers with the same value) authenticates the bot to the API via the `X-Bot-Api-Secret` header. `/v1/register-telegram`, `/v1/whoami-telegram`, `/v1/agent-status` and the telegram-binding path of `/v1/register` fail closed (401) when it is missing or unset. Plain CLI `/v1/register` (no `telegram_id`) does not need it.
- **Telegram webhook fails closed.** The bot worker rejects every webhook POST unless `TELEGRAM_WEBHOOK_SECRET` is set AND the `X-Telegram-Bot-Api-Secret-Token` header matches it (constant-time comparison). Set the same value in Telegram's `setWebhook?secret_token=...`.
- **Telegram link codes.** Codes are `LINK-` + 16 hex chars (64-bit CSPRNG), expire after 10 minutes (`expires_at` is unixepoch INTEGER in D1), allow 5 confirm attempts before burning, are limited to 10 confirm attempts/hour/IP, and requesting a new code invalidates the user's outstanding codes.
- **Group-chat refusals.** The bot only answers `/register`, `/whoami`, `/status`, `/link` and link-code confirmations in private chats, and HTML-escapes user-controlled text in `parse_mode: HTML` replies.

## Important environment variables

`.env.example` is a partial reference. `engine/config-service.ts` is the canonical source of defaults and validation.

| Variable                      | Default                                                            | Meaning                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `HELIUS_API_KEY`              | —                                                                  | Required for Solana RPC. In test mode defaults to a dummy value.                                                   |
| `SOLANA_RPC_URL`              | Helius URL if key present                                          | RPC endpoint. Falls back to public Solana RPC if absent.                                                           |
| `WALLET_PRIVATE_KEY`          | —                                                                  | Optional; required only for live trading.                                                                          |
| `PAPER_TRADING`               | `true`                                                             | Simulated positions by default.                                                                                    |
| `SCAN_INTERVAL_MS`            | `600000`                                                           | Time between scan cycles (10 min).                                                                                 |
| `WATCHLIST_POOLS`             | —                                                                  | Comma-separated Meteora DLMM pool addresses.                                                                       |
| `ENABLE_POOL_DISCOVERY`       | `false`                                                            | Opt-in discovery; live mode should use explicit approved watchlist pools.                                         |
| `MIN_POOL_TVL_USD`            | `50000`                                                            | Skip watched pools below this TVL.                                                                                  |
| `DISCOVERY_MIN_TVL_USD`       | `1000000`                                                          | Minimum TVL for opt-in automatic discovery.                                                                         |
| `VOLUME_AUTH_THRESHOLD`       | `0.70`                                                             | Minimum volume authenticity score.                                                                                 |
| `CONFIDENCE_THRESHOLD`        | `0.65`                                                             | Minimum confidence to act.                                                                                         |
| `STOP_LOSS_PCT`               | `0.15`                                                             | Drawdown that blocks HOLD/REBALANCE.                                                                               |
| `TRAILING_STOP_PCT`           | `0.10`                                                             | Drawdown from peak that triggers EXIT.                                                                             |
| `MAX_OPEN_POSITIONS`          | `3`                                                                | Concurrent positions cap.                                                                                          |
| `MAX_PER_POOL_ALLOCATION_PCT` | `0.4`                                                              | Max portfolio share for one pool.                                                                                  |
| `SQLITE_DB_PATH`              | `~/.local/share/prism/prism.db` (bundled) or `./prism.db` (source) | SQLite database path.                                                                                              |
| `ENABLE_SNAPSHOT_CAPTURE`     | `false`                                                            | Store full bin-array detail in per-cycle snapshots (paper only). Lightweight per-cycle snapshot rows are always persisted — TVL velocity and IL drift need the history. |
| `SNAPSHOT_RETENTION_DAYS`     | `14`                                                               | Days of `pool_snapshots` history to keep; older rows are pruned once per day (first cycle prunes immediately). |
| `METEORA_DATA_API_URL`        | `https://dlmm.datapi.meteora.ag`                                   | Base URL for the Meteora Data API used to enrich pool TVL/volume/fees. On failure the engine falls back to heuristic stats with a warning.                              |
| `EMBEDDINGS_BACKEND`          | `fallback`                                                         | `fallback` = deterministic hash vectors; `onnx` = Xenova/MiniLM (downloads ~80MB).                                 |
| `AGENTIC_MODE`                | `false`                                                            | Enable agent runtime overlay.                                                                                      |
| `AGENT_MCP_ENABLED`           | `false`                                                            | Expose stdio MCP server.                                                                                           |
| `AGENT_HTTP_PORT`             | `0`                                                                | Local HTTP status port (`0` = disabled).                                                                           |
| `AGENT_PROPOSAL_MODE`         | `veto`                                                             | `veto` \| `suggest` \| `supervised` \| `full` (see Agent runtime overlay).                                         |
| `AGENT_PROPOSAL_TOKEN`        | `""`                                                               | Bearer token for `/propose` enqueue. Empty disables enqueue.                                                       |
| `AGENT_APPROVAL_TOKEN`        | `""`                                                               | Bearer token for `/approve` / MCP approve. Required for supervised; no fallback to proposal token.                 |
| `AGENT_PROPOSAL_MAX_QUEUE_SIZE` | `50`                                                             | Max pending proposals in the in-memory queue.                                                                      |
| `AUTO_UPDATE`                 | `true`                                                             | Check for releases periodically.                                                                                   |
| `UPDATE_CHANNEL`              | `stable`                                                           | `stable`, `beta` or `dev`.                                                                                         |
| `UPDATE_R2_PUBLIC_URL`        | `https://pub-2f55c98709e74d1d900b89ec20f8f1fc.r2.dev`              | Release CDN. `.env.example` contains a stale `r2.prism-agent.com` value; the code fallback is the source of truth. |
| `PRISM_CONFIG_DIR`            | `~/.config/prism`                                                  | Override the shared credentials and config directory.                                                              |
| `PRISM_FEEDBACK_OPT_OUT`      | `false`                                                            | Disable automatic feedback.                                                                                        |
| `ALERTS_ENABLED`              | `true`                                                             | Master switch for proactive Telegram alerts (engine-side). Delivery still requires registration + Telegram link.   |
| `ALERT_COOLDOWN_MINUTES`      | `120`                                                              | Per-rule (alert type + pool) cooldown between pushed alerts. Persisted in SQLite metadata.                         |
| `ALERT_FEE_MILESTONE_USD`     | `10`                                                               | USD step between cumulative-fee milestone alerts.                                                                  |

In test mode (`NODE_ENV=test` or `VITEST=true`), missing `HELIUS_API_KEY` defaults to `test-helius-key` and `SOLANA_RPC_URL` defaults to `https://example.com`.

## Common gotchas

- **`bun run dev` is guarded.** Use `prism dev` or `bun cli/index.ts dev`. Set `PRISM_ALLOW_DIRECT=true` only if you deliberately need direct execution.
- **`LOG_LEVEL` does not silence output.** `engine/logger.ts` always emits and writes to `logs/audit-trail.jsonl` regardless of level.
- **Coverage thresholds apply only to included files.** Several large engine modules are excluded from coverage.
- **Embeddings default to fallback.** The ONNX backend downloads ~80MB on first use and can crash with BigInt serialization errors in Node; the engine automatically falls back.
- **Bundled blacklists are empty.** `engine/data/deployer-blacklist.json` and `engine/data/token-blacklist.json` ship as `[]`. Override with `DEPLOYER_BLACKLIST_PATH` / `TOKEN_BLACKLIST_PATH`.
- **Live discovery is opt-in.** Keep `ENABLE_POOL_DISCOVERY=false` and configure `WATCHLIST_POOLS` with approved pools. Automatic discovery also excludes Meteora launchpad pools.
- **Deployer blacklist uses the mint-authority fallback.** Each cycle the engine fetches on-chain mint authorities (`adapter.getMintAuthorities`, 1h cache) and passes the mint authority to `blacklist.checkPool()` as the deployer fallback; Metaplex update-authority metadata is not fetched. Pools flagged by the Data API (`is_blacklisted`, `freeze_authority_disabled=false`) or with an on-chain freeze authority set are rejected before metric evaluation — note this screens out freeze-authority-enabled tokens (e.g. USDC) by design.
- **One ENTER per live cycle.** In live mode, `ENTER` is silently skipped if any position is already open.
- **Live rebalances are atomic.** `adapter.rebalancePosition` uses the Meteora SDK's atomic path (`simulateRebalancePosition` → `dlmm.rebalancePosition` → init-bin-array tx, then one rebalance tx) instead of close+reopen: the position account and its `positionPubKey` are preserved, so entry accounting and cumulative fees survive, and there is no zero-exposure window. The reshaped size is the position's current on-chain liquidity (full withdraw + redeposit) plus an explicit `topUp` only from auto-compound (just-claimed net fees) — never paper config. Fees are still claimed by the engine's own claim path first, so the atomic instruction runs with `shouldClaimFee=false` (no double-claim). The gate is simulation-first: live `simulateRebalance` returns the position's real claimable fees and the quoted bin-array/bitmap rent (paper mode keeps a pool-level heuristic via `estimatePaperRebalanceBenefit`). Simulation/transport failure fails closed (no rebalance that cycle); an execution failure flags the pool for the next cycle's reconcile, which also re-syncs a tracked position's range when the same on-chain position has drifted.
- **Live entry balance policy.** Live entries fail closed when requested token amount exceeds the wallet balance; they are not silently downsized.
- **Live entry retry policy.** Deterministic insufficient-token failures are exponentially backed off per pool (30 minutes to 6 hours) to avoid repeating doomed entries and amplifying RPC load.
- **Scan metrics.** Cycle logs report `decided`, `executed`, and `failed` pools separately; `decided` is not a success count.
- **Scan failure semantics.** `failed` counts processing or execution failures; risk and backoff gates are rejected decisions recorded in the audit trail, not execution failures.
- **sqlite-vec extension.** Source installs rely on `scripts/generate-vec-embed.ts` to create `engine/sqlite-vec-embedded.ts`; bundled installs provide the native extension via `PRISM_VEC0_PATH`.
- **Backtest is a simplified simulation.** It does not replicate the full decision loop (no risk gates, memory, dynamic ENTER/EXIT sizing, trailing stop). Use it as a regression baseline, not a performance forecast.
- **Screener bin-utilization filter is bounded.** Discovery data comes from the Data API without per-bin data, so `minBinUtilization` is enforced only for the first 10 screened candidates via an on-chain `getBinArray` probe; the rest pass through and the per-pool scan loop re-applies the gate.
- **Risk size cap follows `MAX_PER_POOL_ALLOCATION_PCT`.** The per-position cap in `risk-service.ts` is the configured allocation pct (default 40%), not a hardcoded constant.
- **`.env.example` is stale in places.** For example, its `UPDATE_R2_PUBLIC_URL` default does not match the code fallback. Always verify against `engine/config-service.ts`.

## Where to look first

- New to the codebase: `engine/index.ts` → `engine/run-engine.ts` → `engine/program.ts` → `engine/services.ts` → `engine/config-service.ts`.
- Adding a service: `engine/services.ts` (Tag) + new `engine/x-service.ts` (Layer) + `buildLayer()` in `engine/program.ts`.
- Adding a risk check: `engine/risk-service.ts` `evaluateRisk()`.
- Changing decision rules: the `evaluatePool` block inside `engine/program.ts`.
- Adding a Cloudflare route: `cloudflare/workers/api/index.ts`.
- Adding a Telegram command: `cloudflare/workers/telegram-bot/index.ts`.
- Deploying Cloudflare: `cloudflare/README.md`.
