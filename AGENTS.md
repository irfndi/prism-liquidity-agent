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
| `package.json`                                        | Root manifest, scripts, dependencies. Current version `0.1.2`.                                                                                |
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

1. `adapter.getPoolState` + `adapter.getBinArray` fetch on-chain data (real per-bin reserves via `dlmm.getBinsAroundActiveBin`). Pool tvl/volume/fees are then resolved through a **three-tier source pipeline** and tagged with the winning `statsSource`: **(1) datapi** — `meteoraDatapi.getPoolData` overlays real TVL/volume/fees from the Meteora Data API (`statsSource: "datapi"`; the ONLY source of safety signals — blacklist/freeze/verified/farm); **(2) geckoterminal** — when datapi returns null and `GECKO_TERMINAL_ENABLED !== false`, `getGeckoPoolStats` overlays real 24h volume (`volume_usd.h24`) and reserve TVL (`reserve_in_usd`) from GeckoTerminal's keyless public API (`statsSource: "geckoterminal"`); **(3) heuristic** — the adapter's `tvlUsd × modeled-turnover` fabrication (`statsSource: "heuristic"`), the last-resort safety net for total API outage. Any tier that 404s/429s/times out/fails-to-parse falls through to the next (gecko returns null on every failure, one warning per fetch). GeckoTerminal's own `pool_fee_percentage` is **null for every concentrated-liquidity pool** (live-verified 2026-07-22 across meteora/orca/raydium-clmm/pancake/raydium-v4), so gecko `fees24hUsd = realVolume × baseFeeRate` where `baseFeeRate = 0.0025 + binStep/1e4` is the pool's binStep-derived base fee (the same model the adapter uses) applied to REAL volume. Data-API-exclusive safety signals stay null under gecko and the screener's fail-open null handling is unaffected.
2. Safety screening early-rejects the pool with a recorded rejected decision + audit + warning: (a) **Blacklist gates, never exempted** — Data API `is_blacklisted=true` → reject; `blacklist.checkPool` hits the token or deployer blacklist → reject. Both stay fail-closed and are NOT exempted by the stablecoin allowlist or the token-risk overlay (the mint authority from `adapter.getMintAuthorities` doubles as the deployer fallback for `checkPool`). (b) **Freeze gate + stablecoin allowlist** — a leg is freeze-enabled when the Data API reports `freeze_authority_disabled=false` OR the on-chain freeze authority is set; every freeze-enabled leg is **exempt** when its mint is in `STABLECOIN_MINTS` (default USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, USDT `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`, PYUSD `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo`; `STABLECOIN_MINTS=""` disables the allowlist entirely). (c) **Token-risk overlay for untrusted freeze legs** — an untrusted freeze-enabled leg consults the token-risk overlay (lazy: only when `JUPITER_TOKEN_RISK_ENABLED` and a leg actually needs adjudication): Jupiter `audit.isSus` → reject is checked FIRST, before any exemption (aggregated RugCheck+Blockaid — the only hard reject the overlay drives; a Jupiter-flagged token is rejected even if the Data API or Jupiter verifies it elsewhere), then Data API `is_verified` → exempt, Jupiter `isVerified` → pass, unknown → `FREEZE_SMART_SCREENING=true` passes the pool to the quality pipeline (warning memory + audit note) or strict reject otherwise with an actionable config hint. The pool is rejected only when an untrusted leg has freeze enabled and neither the allowlist nor the overlay clears it. Positive signals fail closed; transport/IO errors (blacklist load, RPC metadata fetch, Data API down, token-risk fetch) fail open with a warning and leave the decision unchanged.
3. `strategy.computeMetrics` produces pure metrics (fee/IL, volume authenticity, bin utilization, TVL velocity vs the previous `pool_snapshots` row). Metrics whose inputs are unavailable are reported as explicit "unknown" (`volumeAuthenticityKnown` / `feeIlRatioKnown` / `binUtilizationKnown` on `PoolMetrics`); unknown metrics skip their pre-filter/EXIT gates with a warning and block ENTER (fail-closed), never fabricate 1.0. `volumeAuthenticityKnown` AND `feeIlRatioKnown` are both true exactly when `isMeasuredStatsSource(statsSource)` — i.e. the stats came from datapi OR geckoterminal (real volume/fees). For `statsSource: "heuristic"` (fabricated volume/fees) BOTH are false: the volume-authenticity pre-filter/EXIT gates and the fee/IL gates (the `fee/IL < 0.5` EXIT and the `[fee-il-gate]` ENTER floor) **skip rather than act on fabricated numbers** — a made-up-low ratio neither forces an exit nor blocks entry. `binUtilizationKnown` is source-independent (on-chain bins). The `[fee-il-gate]` ENTER skip under heuristic does not admit the pool: the volume candidate gate requires `volumeAuthenticityKnown`, so a heuristic pool still cannot enter (it is held, not rejected for a fabricated ratio).
4. Pre-filter skips pools below `MIN_POOL_TVL_USD`, `VOLUME_AUTH_THRESHOLD` or `MIN_BIN_UTILIZATION`.
5. `memory.getRelevantContext` recalls recent warnings/patterns (errors swallowed).
6. Decision rules evaluate per position, in order: `EXIT` → `REBALANCE` → `HOLD`, then at most one `ENTER` per pool. Deterministic `EXIT` conditions (TVL drop, low fee/IL, volume authenticity, volatility gate, trailing stop) only fire for pools with a tracked position — positionless pools take the ENTER/HOLD path only. Pool-level EXIT triggers exit every position on the pool; the trailing stop, OOR tracking and REBALANCE evaluation run independently per position (see Multiple positions per pool).
7. `risk.evaluate` gates execution per decision: `EXIT` is always approved first (capital protection beats the confidence gate), then the confidence gate and remaining structural checks. `HOLD` skips risk evaluation entirely (it executes nothing; rejections used to spam warning memory and suppress the good-HOLD branch). Portfolio value for the drawdown/allocation/size gates is `walletBalanceUsd + Σ openPositions.currentValueUsd`; the per-pool gates measure the pool's AGGREGATE exposure across all its positions.
8. `audit.recordDecision` logs every decision (errors swallowed).
9. Execution updates the in-memory `trackedPositions` Map (keyed by position identity, not pool address) and persists to SQLite via `db.savePosition`. EXIT soft-closes the targeted row via `db.closePosition(positionId, …)` (sets `closed_at` + `realized_pnl_usd`, row kept for history); `db.deletePosition` is reserved for true cleanup (stale paper rows, externally-closed positions).

### Wallet balance (walletBalanceUsd)

`walletBalanceUsd` is a **per-cycle chain reconciliation**, not an incremental ledger. It is read **once at the top of `runScanCycle`** (before the per-pool loop) in `program.ts` and reused for every pool's risk/sizing context in that cycle — a transient read never fails an individual pool, and one cycle shares one consistent figure for `portfolioValueUsd = walletBalanceUsd + Σ openPositions.currentValueUsd` and the `min(walletBalanceUsd * 0.5, …)` size cap.

- **What it counts (live):** native SOL lamports (`getBalance`) plus **every SPL token account the wallet holds across BOTH the Token Program and Token-2022** — two unfiltered `getParsedTokenAccountsByOwner` reads, zero-amount (rent-only) ATAs skipped, amounts accumulated per mint. This includes wSOL ATAs (distinct storage from native SOL, so no double-count) and the pool-token residues / single-sided-entry leftovers / reward mints the old SOL+USDC-only read left invisible.
- **Valuation is fail-closed:** all discovered mints plus native SOL are priced in ONE batched `fetchTokenPrices(allMints, { useFallback: false })` (Jupiter accepts the csv; the price chain handles caching). A token with **no resolvable USD price is SKIPPED** with a one-time-per-process warn — there is deliberately **NO fallback price** in the wallet path (the old hardcoded `$165` SOL fallback is how a SOL-heavy wallet over-reported by ~$27). Shrinking the measured portfolio only pauses new entries; EXITs stay free and sizing keeps its own min floor, so capital is protected. An RPC/parse error in the read fails the Effect (the caller degrades).
- **Live read failure degrades, never fails a pool:** on a failed wallet read the cycle reuses the last known value (stale) with **one** `console.error` warn for that cycle, and keeps evaluating every pool. Paper mode (and walletless live) uses `config.paperPortfolioUsd` and never touches the chain read. The previous per-pool "live + no EXIT pending + read failed → fail the pool" branch is removed.
- **Cache + invalidation:** the 30s adapter cache (`cachedWalletBalance`) and `invalidateBalanceCaches` are unchanged; `invalidateBalanceCaches` runs after every mutating tx. `enterPosition` invalidates **AFTER** `confirmTransaction` (mirroring exit/rebalance/claims) — invalidating before confirmation re-fills the cache with the pre-tx balance and serves that stale value for the whole TTL.

### Position persistence

`trackedPositions` is only an in-memory cache, keyed by **position identity** (`PositionRecord.positionId`): the on-chain position pubkey for live positions, a stable synthetic `paper-<pool>-<uuid>` id for paper positions. At startup `program.ts` loads all rows from `positions` into the Map by `position_id`, and every state change (ENTER, EXIT, REBALANCE, trailing-stop update, fee claim) is written back to SQLite per position row. Active-position queries (`getAllPositions`) exclude rows with `paper_exited_at` or `closed_at` set; history queries (`getClosedPositions`) return them. Every per-position DB method (`getPosition`, `closePosition`, `markPaperExited`, `deletePosition`, `updatePositionValue`) takes the position id — pool addresses are no longer unique keys.

### Multiple positions per pool (Wave 10)

DLMM natively supports many positions per pool (a tight+wide range pair is a normal power-user strategy), and so does Prism: a pool may hold up to `MAX_POSITIONS_PER_POOL` positions (default 2; set 1 for legacy single-position behavior), and `MAX_OPEN_POSITIONS` still caps total open positions portfolio-wide.

- **Key model.** The `positions` table is keyed by `position_id` (migration v18 rebuilds the table; live rows keep their pubkey, legacy paper rows get `paper-<pool>` synthetic ids). `position_events` gained a `position_id` column (backfilled from `position_pubkey`) so lifecycle events stay attributable per position, paper included.
- **Risk gate 2 rework.** The old duplicate-pool guard ("Already holding position in pool — use REBALANCE instead") is replaced by the per-pool position-count cap: ENTER is rejected only when the pool is at `MAX_POSITIONS_PER_POOL`. Per-pool exposure is bounded by the allocation framework across the SUM of that pool's positions: `evaluatePerPoolAllocation` and risk gate 6 both compute `poolCap = maxPerPoolAllocationPct × portfolioValue − Σ poolPositions.currentValueUsd` and cap/reject the proposed size against the remaining headroom.
- **Decision loop.** `evaluatePool` returns one decision per held position plus at most one ENTER per pool-cycle. The ENTER slot is skipped when any position of the pool exits in the same cycle (never exit-and-reenter in one pass). `AgentDecision.positionId` carries the target position through risk evaluation and execution; untargeted EXIT/REBALANCE decisions resolve to the pool's single position or fail closed when ambiguous.
- **Reconcile.** `reconcilePositions` matches on-chain positions to rows by `position_pubkey`: a tracked live position missing from the wallet's on-chain set is treated as externally closed and only its own row is removed; range drift syncs onto the record with the same pubkey; a newly discovered on-chain position on a watched pool adds a new row (a second position on an already-tracked pool is discovered, not skipped).
- **Events & alerts.** `position_events` rows carry both `pool_address` and `position_id`; per-position flows (OOR tracking, range-consumption warnings, fee claims, exits) target the right row. Telegram alert cooldowns key on `type + pool + positionId` for position-originated alerts so two positions on one pool throttle independently.
- **CLI.** `prism portfolio` and `prism portfolio history` list every position individually, each labeled with a `Position:` identity line (pubkey or synthetic id); summaries aggregate across all positions. `prism status` is unchanged in shape.

### PnL accounting

Each position row carries `entry_price_usd` (pool `currentPrice` at ENTER), `entry_amount_x_usd` / `entry_amount_y_usd` (USD value of each leg at entry — 50/50 for a two-sided entry, full-size/zero for a single-sided entry, as executed and reported by the adapter), `cumulative_fees_claimed_usd`, `closed_at` and `realized_pnl_usd`. Every lifecycle transition also appends to the append-only `position_events` log (`ENTER` / `EXIT` / `REBALANCE` / `CLAIM` / `COMPOUND` with value, fees, price and metadata — ENTER metadata records `depositMode` and `strategyShape`).

`depositedUsd` is the cost basis. Auto-compounded fees become new cost basis when redeposited (they were already counted in `cumulative_fees_claimed_usd` when claimed, so total-PnL math stays continuous); `currentValueUsd` and `highestValueUsd` adjust in lockstep via `applyCompoundToCostBasis` in `engine/pnl.ts` so the trailing stop is not distorted. Pure analytics live in `engine/pnl.ts`: unrealized PnL = `currentValueUsd + cumulativeFeesClaimedUsd + cumulativeRewardsClaimedUsd − depositedUsd` (rewards added in Wave 8 — see Farm rewards); HODL benchmark = `entryAmountXUsd × (currentPrice / entryPrice) + entryAmountYUsd`; fee APR = fees / cost basis annualized by position age (fee-pure — never includes rewards); time-in-range is approximated as `1 − (current OOR stint / age)` (recovered past stints are not tracked and count as in-range time — a documented overestimate).

Positions opened before migration v16 have NULL entry fields: analytics and the CLI degrade gracefully (no HODL benchmark / IL-vs-HODL — shown as `n/a` — and PnL falls back to the legacy `currentValueUsd − depositedUsd` model). The CLI surfaces all of this in `prism portfolio` (per-position + totals), `prism portfolio history` (realized PnL from `closed_at` rows) and `prism status`; the current price for the HODL benchmark comes from the latest `pool_snapshots` row. A zero entry leg is **not** NULL: single-sided entries produce a HODL benchmark from the held leg alone (`entryAmountXUsd × price ratio + 0`, or flat `entryAmountYUsd` for a Y-only entry).

**Realized PnL is computed from the exit withdrawal, not a mark.** `adapter.exitPosition` snapshots the position immediately before the close batch and returns the withdrawn/pending-fee atomics (principal + unswept fees via the `*ExcludeTransferFee` variants) plus a mint-based USD valuation; the live EXIT realizes `realized = withdrawnUsd (incl. unswept fees + recompounded) + PRIOR cumulativeFeesClaimedUsd + cumulativeRewardsClaimedUsd − depositedUsd`. The exit sweep is credited into `cumulativeFeesClaimedUsd` / `cumulativeRewardsClaimedUsd` AFTER that computation (a `fee_claims` row + CLAIM event tagged `metadata.kind = "exit_sweep"` / `"exit_sweep_reward"`) — only for fee-APR / display / event continuity, never as a realized input — so recompounded fees (in both the withdrawal and the basis) and prior claims each count exactly once across every `FEE_DESTINATION` mode. When the withdrawal USD cannot be priced (any leg unpriced or amounts absent), realized is recorded as **NULL** (n/a) — never 0, never the last mark — with the raw atomic amounts + `lastMarkUsd` + `pricing: "unresolved"` in the EXIT event metadata, and a one-time warning memory entry; the close transaction is never blocked by pricing (closing bleeding liquidity outranks the ledger). A failed on-chain close flags the pool into `reconcileRequestedPools` so the next cycle's reconcile re-reads the wallet's real positions and drops a half-closed row (the phantom-row guard).

**Claim cadence.** `claimFees` prices the net claim mint-based inside the adapter (`netFeesUsd`, consumed as `netFeesUsd ?? 0` so an unpriceable claim fails the compound gate closed). A zero-fee claim cycle intentionally does NOT re-arm the `feeClaimIntervalMs` gate: it retries every scan (one `getPosition` RPC, no transaction) for fast fee capture, while `FEE_CLAIM_INTERVAL_MS` gates only the live compounding frequency.

**Paper fee accrual.** Paper positions never claim on-chain, so each scan accrues a notional fee — pool `fees24hUsd` × capped TVL share (`min(depositedUsd/tvlUsd, 1)`) × a binary in-range gate × elapsed/24h (one scan interval on the first cycle, capped at 2× the scan interval after) — into `cumulativeFeesClaimedUsd` as a CLAIM event (`metadata.kind = "paper_accrual"`), giving paper realized PnL real meaning. Accrual requires a MEASURED stats source (`isMeasuredStatsSource(pool.statsSource)` — datapi OR geckoterminal, both carry real fees): when both real sources are down `getPoolState` supplies a positive MODELED `fees24hUsd` under `statsSource: "heuristic"`, and the gate skips it — so no paper position books fabricated CLAIM income on a heuristic cycle, while datapi AND gecko cycles accrue from real fees. Out-of-range positions likewise accrue nothing; `currentValueUsd` is never touched (unrealized PnL already sums claimed fees).

### Entry strategy shapes and single-sided deposits

Live position creation uses the Meteora SDK's native deposit distributions via `ENTRY_STRATEGY_TYPE` (default `spot`): `spot` (uniform), `curve` (concentrated around the active bin), `bidask` (edge-weighted), or `auto`. With `auto`, the decision loop resolves the shape per pool from recent volatility metrics (`recommendStrategyShape` in `engine/strategy-service.ts`): a dominant trend (|net bin drift| ≥ max(3, 2σ)) → `bidask`, high-volatility chop (σ ≥ `VOLATILITY_EXIT_STDDEV`) → `spot`, calm/mean-reverting → `curve`. The adapter maps the shape to the SDK `StrategyType` enum (`toSdkStrategyType`); a bare `auto` reaching the adapter without a resolved shape falls back to `spot` (the adapter has no volatility context). The W6 atomic rebalance deliberately keeps `StrategyType.Spot`: it redeposits the position's existing (arbitrary-ratio) holdings, and Spot's uniform imbalanced distribution is the only shape that makes no price-direction assumption about the redeposit.

**Single-sided entry.** When the wallet cannot fund one leg's half of a two-sided deposit but the other leg alone covers the full position size, `enterPosition` takes the SDK single-sided deposit path (`StrategyParameters.singleSidedX` + a zero amount on the missing leg) instead of failing: the entire position size is deposited in the held token (never silently downsized). Precedence vs the `AUTO_SWAP_ENTRY` USDC top-up: single-sided native deposit wins whenever it is feasible (the held token is one of the pair and covers the full size — no swap slippage, and it works even when the missing leg is USDC itself, which the swap path cannot top up); the auto-swap remains the fallback for every other deficit shape (both legs missing, or the held leg short of full size). Entry fails closed with a clear error when neither path is possible. Paper entries derive their range from the same `strategy.recommendBinRange()` live uses (no hardcoded width), so paper validates the real entry behavior.

**Volatility-adaptive range width (Wave 9).** Range half-widths are resolved once per pool-cycle by `resolveRangeHalfWidth` in `engine/strategy-service.ts` and shared by the entry (paper + live) and rebalance paths. The static baseline is `ENTRY_RANGE_HALF_WIDTH_BINS` when set (> 0), else the binStep tier (25/20/15). `VOLATILITY_ADAPTIVE_RANGES` defaults to `true` (set `false` to opt out into static widths): when on, the baseline scales with measured realized volatility: `halfWidth = base × clamp(σ / 2, 0.5, 2)` where σ is the active-bin stddev already computed for the volatility exit gate — high-vol regimes widen (fewer forced rebalances), calm regimes narrow (fee concentration). The result is always clamped to [5 bins, floor(`MAX_REBALANCE_RANGE_BINS` / 2)] so the full range never exceeds the risk cap; raise `MAX_REBALANCE_RANGE_BINS` (e.g. 100) to unlock the full 2× widening for fine-binStep pools. Cold start (fewer than 2 bin snapshots, σ = 0) returns the bounded baseline — no fabricated jumps during warmup. When adaptation is disabled the legacy binary high-vol widening (`VOLATILITY_WIDE_HALF_WIDTH_BINS` on the rebalance path) is preserved unchanged. Width and W7 shape are orthogonal knobs — `recommendStrategyShape` is untouched.

### Farm rewards (liquidity mining)

DLMM farms stream up to 2 reward tokens to active-bin liquidity. Prism is farm-aware in three places:

- **Claiming.** `adapter.claimRewards(poolAddress, positionPubKey)` claims LM rewards via the SDK's `claimAllLMRewards` (LM-only — never `claimAllRewardsByPosition`, which would also move swap fees through a path the engine does not account for). It rides the same periodic cadence as swap-fee claims (the per-position `feeClaimIntervalMs` gate in `claimAllFees`) and is gated by `FARM_REWARDS_ENABLED` (default `true`). The shared `lastFeeClaimAt` gate timestamp means "last on-chain claim of either kind": a successful reward claim re-arms it, so a zero-swap-fee farm position claims once per interval instead of re-firing every scan cycle (the fee path only updates it on non-zero claims). Skip semantics, not errors: (a) the pool's `concreteFunctionType` is `LimitOrder` (post-0.12.0 pools are LimitOrder-xor-LiquidityMining) with nothing pending, or (b) the position has no pending `rewardOne`/`rewardTwo` — so repeated cycles are idempotent no-ops and nothing is ever double-claimed. Legacy pools predate `concreteFunctionType` and read 0 (`LimitOrder`); a position with objectively pending rewards still claims — real yield is never abandoned on a legacy field default. Amounts recorded are the pending `rewardOne`/`rewardTwo` read immediately before the claim, mapped to mints via `lbPair.rewardInfos[0]`/`[1]`.
- **Accounting.** Rewards are tracked **separately** from swap fees: `cumulative_rewards_claimed_usd` (migration v17) accumulates only the USD-priced portion of claims, while `cumulative_fees_claimed_usd` stays fee-pure (fee APR never includes farm yield). Each claim appends a `CLAIM` row to `position_events` with `fees_usd = NULL` and `metadata.kind = "lm_reward"` carrying the raw `{mint, amountAtomic, amountUsd}` entries and tx signatures. A reward whose mint price is unavailable is still claimed and recorded with `amountUsd: null` (plus a warning memory entry) — claiming never blocks on pricing. Total PnL (unrealized and realized) includes claimed rewards; `prism portfolio` and `prism status` show a `Rewards:` line when the total is positive.
- **Scoring.** The Data API's `has_farm` + `farm_apr` (annualized percent — note the API's adjacent `apr` is a daily rate; `farm_apr` is not) flow through `enrichPoolWithDatapi` onto `PoolState.hasFarm`/`farmAprPct` and into `PoolMetrics.farmAprPct` (null = no farm or unknown; 0 = farm with no current rate). `weightedEntryScore` adds a bounded farm term, `min(farmAprPct / FARM_APR_SCORE_REFERENCE_PCT (100), 1) × FARM_SCORE_WEIGHT (1)`, so a farm pool outranks an otherwise-identical non-farm pool. The term is a fixed constant, deliberately outside the Darwinian `SignalWeights`, so weight evolution cannot inflate farm yield above fee/IL quality signals.

### Fee accumulation (Wave 13)

After a successful fee claim, `FEE_DESTINATION=compound` redeposits as before; `accumulate-quote` and `accumulate-sol` convert the claimed fee through the typed Jupiter adapter seam and retain the proceeds instead of recompounding. Paper mode records the accumulation without calling Jupiter. Live conversion is fail-closed for missing wallets, missing or malformed routes, zero output, quote/build/confirmation failures, or unsupported destinations.

### IL protection

`IL_PROTECTION_ENABLED` (default `true`) is the master switch for two gates that keep impermanent loss from quietly eating fees:

- **Entry fee/IL floor.** When IL protection is on, ENTER is rejected with an audited `[fee-il-gate]` decision when the known `feeIlRatio < MIN_FEE_IL_RATIO` (default `1.2`). `feeIlRatio` is never null — `strategy-service.ts` returns a 0-20 value (0 when there are no fees or zero TVL, 20 when fees accrue with zero estimated IL) — so the numeric compare is unknown-free and fail-closed on 0: a pool whose expected fees cannot cover its estimated IL never enters. The evolved ×1.5 ENTER signal term is unchanged.
- **IL-dominance fast EXIT.** For a tracked position it fires only when ALL hold: IL protection on; the position is out of range (`outOfRangeSince != null`, so fees have stopped accruing and IL is actively bleeding); entry legs are known (`computeHodlValueUsd` non-null — pre-v16 rows with NULL entry legs fail-open and skip); `hodlValue − currentValue > 0`; that IL exceeds `cumulativeFeesClaimedUsd × IL_DOMINANCE_EXIT_FACTOR` (default 2); and it exceeds `IL_DOMINANCE_MIN_USD` (default 5). `currentValueUsd` is the heuristic `estimatePositionValue` mark refreshed per cycle, not an oracle price; the HODL benchmark is the real on-chain entry legs. It rides the W15 fast-EXIT seam: an `il_dominance` critical alert position-scoped plus a position-targeted EXIT at confidence 1, inserted after the W15 branch and ahead of the TVL-drop EXIT.
- **Token-risk ENTER gate.** When `JUPITER_TOKEN_RISK_ENABLED`, ENTER is also rejected with an audited `[token-risk]` decision when either leg carries a hard-risk signal — Jupiter `audit.isSus` (aggregated RugCheck+Blockaid) or `organicScoreLabel: "low"`. Advisory and fail-open: unknown, disabled, or failed signals never block entry. It reuses the per-cycle token-risk cache, so a second consult costs no network call when the screening seam already fetched the mints.

### Token-risk overlay (Jupiter + Data API)

The token-risk overlay (`engine/token-risk-service.ts`) is advisory corroboration on top of the existing Data API `is_blacklisted` / `freeze_authority_disabled` + on-chain authority + blacklist pipeline; the only hard reject it drives is Jupiter's aggregated `audit.isSus` flag on UNTRUSTED mints, and it is checked FIRST — before the Data API `is_verified` exemption, so a Jupiter-flagged token is rejected even if it is verified elsewhere. It reads the Jupiter Tokens API V2 (`api.jup.ag/tokens/v2/search`, batched ≤100 mints/request, keyless or with `JUPITER_API_KEY` for a higher rate limit) plus the Meteora Data API `is_verified` field. Everything is fail-open: unknown mints, fetch failures, and a disabled switch leave decisions unchanged — on a fetch failure the overlay logs a single warning and serves the last cached (possibly stale) signals, and it never blocks the scan cycle. Like the depeg detector it is a module-function design with an injectable `fetchImpl` (plain exported functions, not an Effect `Context.Tag` service) so adding it does not ripple through the test layers. Trust boundary: a verified freeze-authority token still retains on-chain freeze authority — if the issuer exercises it, position exit can be blocked mechanically; exempting verified freeze tokens beyond the `STABLECOIN_MINTS` majors is an operator trust decision.

### Depeg and liquidity-drain alerts (Wave 15)

Allowlisted stablecoin depeg detection and sudden snapshot TVL/volume drain detection produce position-scoped fast `EXIT` signals. They use the existing W5 alert transport, per-rule cooldowns, and fail-open delivery behavior; an alert-delivery failure never blocks the scan cycle.

### Copy-trading signals (Wave 16)

Opt-in copy signals accept only configured wallet allowlists and fresh, validated, deduplicated observations. Retries fail open, the confidence boost is capped at `0.05`, and an incoming signal cannot downgrade `EXIT`; signals are applied before the unchanged risk gates. Copy signals are advisory input, not execution authority.

### Limit-order status (Wave 14)

W14 remains blocked and is not implemented. The current Meteora SDK path provides no trusted linkage between a placed limit order and the engine's position, no reliable fill or expiry reconciliation, no freshness-bearing quote that can safely drive the order lifecycle, and no safe post-withdraw sizing contract for redeposit. Until those lifecycle facts are available from a supported SDK/API path, Prism must not place or cancel limit orders or claim W14 acceptance.

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

Veto-fetch failures log the underlying gateway error (Effect wraps rejections in `UnknownException`; the cause is unwrapped so the real reason surfaces) and the per-pool warn is throttled to one warn per `AGENT_PROPOSAL_STALE_MS` window (suppressed occurrences drop to debug). The gateway transport is no longer selected when `AGENT_GATEWAY_TOKEN` is empty: an explicit `AGENT_RUNTIME=openclaw` with an empty token emits one actionable startup warning ("AGENT_GATEWAY_TOKEN is required for the OpenClaw gateway runtime; decision review disabled") and disables veto review, while `auto` falls back to the Hermes/ACP transport when available (info-logged) and otherwise falls through. `getStatus().connected` is truthful — it reports `false` when the startup connect actually failed. Fail-open semantics are preserved: a transport or fetch failure never alters the decision.

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
7. Updates `prism-backups/releases/latest.json` and per-channel manifests (`beta`, `dev`; the `canary` pointer is written by `ci.yml` on `main`, NOT by this workflow).
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
| `STABLECOIN_MINTS`            | USDC/USDT/PYUSD                                                    | Trusted stablecoin mints exempt from freeze-authority screening (allowlist). Empty (`=""`) disables the allowlist entirely; entries are pubkey-validated fail-closed. |
| `FREEZE_SMART_SCREENING`      | `false`                                                            | Pass untrusted freeze-enabled pools to the quality pipeline (warning memory + audit note) instead of rejecting.    |
| `JUPITER_TOKEN_RISK_ENABLED`  | `true`                                                             | Enable the Jupiter/Data-API token-risk overlay for freeze adjudication and the ENTER token-risk gate.              |
| `JUPITER_TOKEN_RISK_CACHE_TTL_MIN` | `30`                                                            | Minutes a Jupiter token-risk signal is cached before refresh (min 1).                                             |
| `IL_PROTECTION_ENABLED`       | `true`                                                             | Master switch for the entry fee/IL floor and the IL-dominance fast EXIT. See IL protection.                        |
| `MIN_FEE_IL_RATIO`            | `1.2`                                                              | Minimum fee/IL ratio to HOLD; also a hard ENTER floor when IL protection is on (entry fees must beat estimated IL). |
| `IL_DOMINANCE_EXIT_FACTOR`    | `2`                                                                | IL-dominance EXIT fires when IL (USD) exceeds cumulative-fees × this factor (min 1).                               |
| `IL_DOMINANCE_MIN_USD`        | `5`                                                                | Minimum IL (USD) before the IL-dominance fast EXIT may fire (min 0).                                              |
| `CONFIDENCE_THRESHOLD`        | `0.65`                                                             | Minimum confidence to act.                                                                                         |
| `STOP_LOSS_PCT`               | `0.15`                                                             | Drawdown that blocks HOLD/REBALANCE.                                                                               |
| `TRAILING_STOP_PCT`           | `0.10`                                                             | Drawdown from peak that triggers EXIT.                                                                             |
| `MAX_OPEN_POSITIONS`          | `3`                                                                | Concurrent positions cap (total, portfolio-wide).                                                                    |
| `MAX_POSITIONS_PER_POOL`      | `2`                                                                | Max simultaneous positions on one pool (Wave 10). Aggregate per-pool exposure stays bounded by `MAX_PER_POOL_ALLOCATION_PCT`. Set `1` for legacy single-position behavior. |
| `MAX_PER_POOL_ALLOCATION_PCT` | `0.4`                                                              | Max portfolio share for one pool (aggregate across all of that pool's positions).                                     |
| `SQLITE_DB_PATH`              | `~/.local/share/prism/prism.db` (bundled) or `./prism.db` (source) | SQLite database path.                                                                                              |
| `ENABLE_SNAPSHOT_CAPTURE`     | `false`                                                            | Store full bin-array detail in per-cycle snapshots (paper only). Lightweight per-cycle snapshot rows are always persisted — TVL velocity and IL drift need the history. |
| `SNAPSHOT_RETENTION_DAYS`     | `14`                                                               | Days of `pool_snapshots` history to keep; older rows are pruned once per day (first cycle prunes immediately). |
| `METEORA_DATA_API_URL`        | `https://dlmm.datapi.meteora.ag`                                   | Base URL for the Meteora Data API used to enrich pool TVL/volume/fees. On failure the engine falls back to GeckoTerminal, then the heuristic (last resort), with a warning.                              |
| `GECKO_TERMINAL_ENABLED`      | `true`                                                             | Master switch for the GeckoTerminal secondary pool-stats source (tried when the Data API is down). Set `false` to skip gecko and fall straight to the heuristic. Pinned `false` in the test fixture so program tests never touch the network. |
| `GECKO_TERMINAL_API_URL`      | `https://api.geckoterminal.com/api/v2`                            | Base URL for the GeckoTerminal public API (keyless, 30 req/min); the `/networks/solana/pools/{address}` path is appended in code. Real volume/TVL; fees = real volume × the pool's binStep-derived base fee (`pool_fee_percentage` is null for CL pools). |
| `EMBEDDINGS_BACKEND`          | `fallback`                                                         | `fallback` = deterministic hash vectors; `onnx` = Xenova/MiniLM (downloads ~80MB).                                 |
| `ENTRY_STRATEGY_TYPE`         | `spot`                                                             | DLMM deposit distribution for new positions: `spot` \| `curve` \| `bidask` \| `auto` (auto picks per pool from volatility/trend; see Entry strategy shapes). |
| `ENTRY_RANGE_HALF_WIDTH_BINS` | `0`                                                                | Static baseline range half-width (bins each side) for entries/rebalances. `0` = binStep-tiered default (25/20/15). Bounded by `MAX_REBALANCE_RANGE_BINS`; see Volatility-adaptive range width. |
| `VOLATILITY_ADAPTIVE_RANGES`  | `true`                                                             | Scale the range half-width by measured realized volatility (high vol → wider, calm → narrower); on by default, set `false` for static widths. Cold start falls back to the baseline; see Volatility-adaptive range width. |
| `FARM_REWARDS_ENABLED`        | `true`                                                             | Master switch for periodic LM farm reward claims (live only). Scoring stays farm-aware regardless. See Farm rewards. |
| `AGENTIC_MODE`                | `false`                                                            | Enable agent runtime overlay.                                                                                      |
| `AGENT_MCP_ENABLED`           | `false`                                                            | Expose stdio MCP server.                                                                                           |
| `AGENT_HTTP_PORT`             | `0`                                                                | Local HTTP status port (`0` = disabled).                                                                           |
| `AGENT_PROMPT_TIMEOUT_MS`     | `60000`                                                            | Prompt/check-in timeout (min 1000). 60s default because first-token latency for slow models can exceed 15s; raise for slower runtimes. |
| `AGENT_PROPOSAL_MODE`         | `veto`                                                             | `veto` \| `suggest` \| `supervised` \| `full` (see Agent runtime overlay).                                         |
| `AGENT_PROPOSAL_TOKEN`        | `""`                                                               | Bearer token for `/propose` enqueue. Empty disables enqueue.                                                       |
| `AGENT_APPROVAL_TOKEN`        | `""`                                                               | Bearer token for `/approve` / MCP approve. Required for supervised; no fallback to proposal token.                 |
| `AGENT_PROPOSAL_MAX_QUEUE_SIZE` | `50`                                                             | Max pending proposals in the in-memory queue.                                                                      |
| `AUTO_UPDATE`                 | `true`                                                             | Check for releases periodically.                                                                                   |
| `UPDATE_CHANNEL`              | `stable`                                                           | `stable`, `beta`, `dev` or `canary`.                                                                               |
| `UPDATE_R2_PUBLIC_URL`        | `https://pub-2f55c98709e74d1d900b89ec20f8f1fc.r2.dev`              | Release CDN. `.env.example` contains a stale `r2.prism-agent.com` value; the code fallback is the source of truth. |
| `PRISM_CONFIG_DIR`            | `~/.config/prism`                                                  | Override the shared credentials and config directory.                                                              |
| `PRISM_FEEDBACK_OPT_OUT`      | `false`                                                            | Disable automatic feedback.                                                                                        |
| `ALERTS_ENABLED`              | `true`                                                             | Master switch for proactive Telegram alerts (engine-side). Delivery still requires registration + Telegram link.   |
| `ALERT_COOLDOWN_MINUTES`      | `120`                                                              | Per-rule (alert type + pool) cooldown between pushed alerts. Persisted in SQLite metadata.                         |
| `ALERT_FEE_MILESTONE_USD`     | `10`                                                               | USD step between cumulative-fee milestone alerts.                                                                  |

In test mode (`NODE_ENV=test` or `VITEST=true`), missing `HELIUS_API_KEY` defaults to `test-helius-key` and `SOLANA_RPC_URL` defaults to `https://example.com`.

## Common gotchas

- `WATCHLIST_POOLS` is parsed as comma-separated Solana public keys during configuration loading; invalid entries fail closed with the variable name and offending values. Numeric settings clamp to their configured bounds and emit a structured warning; non-finite values use the documented fallback.
- `RevenueService` and `ReferralService` remain standalone library services with direct unit coverage, but are no longer wired into the production engine layer because the scan program has no consumers. `RevenueConfigService` remains wired for fee-share configuration.

- **`bun run dev` is guarded.** Use `prism dev` or `bun cli/index.ts dev`. Set `PRISM_ALLOW_DIRECT=true` only if you deliberately need direct execution.
- **`LOG_LEVEL` does not silence output.** `engine/logger.ts` always emits and writes to `logs/audit-trail.jsonl` regardless of level.
- **Coverage thresholds apply only to included files.** Several large engine modules are excluded from coverage.
- **Embeddings default to fallback.** The ONNX backend downloads ~80MB on first use and can crash with BigInt serialization errors in Node; the engine automatically falls back.
- **Bundled blacklists are empty.** `engine/data/deployer-blacklist.json` and `engine/data/token-blacklist.json` ship as `[]`. Override with `DEPLOYER_BLACKLIST_PATH` / `TOKEN_BLACKLIST_PATH`.
- **Live discovery is opt-in.** Keep `ENABLE_POOL_DISCOVERY=false` and configure `WATCHLIST_POOLS` with approved pools. Automatic discovery also excludes Meteora launchpad pools.
- **Deployer blacklist uses the mint-authority fallback.** Each cycle the engine fetches on-chain mint authorities (`adapter.getMintAuthorities`, 1h cache) and passes the mint authority to `blacklist.checkPool()` as the deployer fallback; Metaplex update-authority metadata is not fetched. Pools flagged by the Data API (`is_blacklisted`) or by the token/deployer blacklist are rejected before metric evaluation and are NEVER exempted. Freeze-authority screening is now allowlist-aware: freeze-authority tokens on `STABLECOIN_MINTS` (default USDC/USDT/PYUSD) are exempted; other freeze-enabled tokens pass when the Data API or Jupiter verifies them, when `FREEZE_SMART_SCREENING=true` (with a warning memory + audit note), and are rejected otherwise with an actionable config hint. See IL protection and Token-risk overlay.
- **ENTER caps per cycle.** At most one ENTER per pool per cycle, up to `MAX_POSITIONS_PER_POOL` positions on that pool (default 2) and `MAX_OPEN_POSITIONS` positions in total. A pool that exited a position in the same cycle never re-enters in that pass; the aggregate per-pool exposure gate (`MAX_PER_POOL_ALLOCATION_PCT` across the sum of the pool's positions) can still cap or reject the new entry.
- **Live rebalances are atomic.** `adapter.rebalancePosition` uses the Meteora SDK's atomic path (`simulateRebalancePosition` → `dlmm.rebalancePosition` → init-bin-array tx, then one rebalance tx) instead of close+reopen: the position account and its `positionPubKey` are preserved, so entry accounting and cumulative fees survive, and there is no zero-exposure window. The reshaped size is the position's current on-chain liquidity (full withdraw + redeposit) plus an explicit `topUp` only from auto-compound (just-claimed net fees) — never paper config. Fees are still claimed by the engine's own claim path first, so the atomic instruction runs with `shouldClaimFee=false` (no double-claim). The gate is simulation-first: live `simulateRebalance` returns the position's real claimable fees and the quoted bin-array/bitmap rent (paper mode keeps a pool-level heuristic via `estimatePaperRebalanceBenefit`). Simulation/transport failure fails closed (no rebalance that cycle); an execution failure flags the pool for the next cycle's reconcile, which also re-syncs a tracked position's range when the same on-chain position has drifted.
- **Live entry balance policy.** Live entries fail closed when the wallet cannot fund the entry; they are not silently downsized. When exactly one leg is short but the held leg covers the full position size, entry takes the SDK single-sided deposit path (full size in the held token) instead of failing — see Entry strategy shapes and single-sided deposits.
- **Live entry retry policy.** Deterministic insufficient-token failures are exponentially backed off per pool (30 minutes to 6 hours) to avoid repeating doomed entries and amplifying RPC load.
- **Scan metrics.** Cycle logs report `decided`, `executed`, and `failed` pools separately; `decided` is not a success count.
- **Scan failure semantics.** `failed` counts processing or execution failures; risk and backoff gates are rejected decisions recorded in the audit trail, not execution failures.
- **sqlite-vec extension.** Source installs rely on `scripts/generate-vec-embed.ts` to create `engine/sqlite-vec-embedded.ts`; bundled installs provide the native extension via `PRISM_VEC0_PATH`.
- **`prism doctor` fails on dead vector memory.** The `memory` check runs the sqlite-vec availability probe and reports FAIL (driving exit 1) when vector memory cannot load, with platform-specific remediation (macOS `brew install sqlite`; Linux/Docker `libsqlite3-0` / `sqlite-libs`; otherwise verify `PRISM_VEC0_PATH` and the shipped `lib/vec0.*`). The companion `native-bindings` check is WARN-only. The `bigint: Failed to load bindings` warning it references no longer fires at startup: release bundles alias `bigint-buffer` (a `@solana/web3.js` dependency) to its bindings-free pure-JS `dist/browser.js` entry (`tsdown.config.ts` / `tsdown.cli.config.ts`), so `require('bindings')` is never bundled, and source runs install a startup `console.warn` filter (`engine/bigint-warning-filter.ts`) as defense-in-depth. The pure-JS path is bit-for-bit identical to the native addon, so this is a no-op functionally; the doctor check now documents why a user might still see a single debug line, not a warning. Root cause fixed this release: `vec_memory` declared `REAL` auxiliary columns that vec0 (TEXT/INTEGER/DOUBLE/BLOB only) could never construct, so the table silently failed to create and memory recall/recording was dead on every install; the aux columns are now `DOUBLE`.
- **Backtest fidelity (Wave 11).** Replay uses the shared decision/risk kernel for position identity, per-pool and portfolio caps, trailing-stop behavior, memory inputs, and dynamic sizing. It remains an offline simulation: it does not submit live transactions, reproduce RPC/SDK transport timing, or forecast execution quality, slippage, or fills. Treat results as deterministic strategy regression and parity checks, not a performance forecast.
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
