# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project does

`prism` is an autonomous liquidity rebalancing agent for Meteora DLMM pools on Solana. It runs a rule-based scan loop every 10 minutes (configurable), evaluates each watched pool against fee/IL, volume authenticity, and drift metrics, then decides: **HOLD**, **REBALANCE**, **EXIT**, or **ENTER**. All decisions pass through a risk gate before any on-chain action. Paper trading is the default.

## Architecture

### Scan Loop (`engine/index.ts`)

The main loop is timer-driven, not event-driven:

```
await tick() on startup, then setInterval(tick, SCAN_INTERVAL_MS)
```

`tick()` guards against overlapping cycles via `cycleInFlight`. If a cycle exceeds the interval, subsequent ticks are skipped and a warning is logged with a `skippedCycles` counter.

Per-pool, `runRuleBasedAgent()` executes sequentially:

1. `adapter.getPoolState()` + `adapter.getBinArray()` — fetch on-chain data
2. `strategy.computeMetrics()` — fee/IL ratio, volume auth score, bin utilization, TVL velocity
3. `memory.getRelevantContext()` — check for recent warnings on this pool
4. `passesPreFilter()` — TVL, auth, bin util gates (hard reject before decision logic)
5. Decision rules (in order):
   - **EXIT** if TVL dropped > `TVL_DROP_EXIT_PCT`, auth < threshold, fee/IL < 0.5, or trailing stop breached
   - **REBALANCE** if drift > 60% of range edge AND `timeSinceRebal >= MIN_REBALANCE_INTERVAL_MS` AND simulated net benefit > `MIN_REBALANCE_NET_BENEFIT_USD`
   - **HOLD** for existing positions with strong fee/IL and no recent warnings
   - **ENTER** for new pools with fee/IL > threshold*1.5, auth > 0.8, util > 0.4, TVL > `MIN_POOL_TVL_USD * 2`
6. `risk.evaluate()` — confidence, concurrent positions, duplicate pool, drawdown, size cap, bin range validation
7. Execute (paper or live) + `memory.recordOutcome()`

Positions are persisted to SQLite via `DbService`. On startup, open positions are loaded from the database so the agent survives restarts without losing track of OOR positions.

### Live Trading (`engine/adapter-service.ts`)

`MeteoraAdapter` wraps the `@meteora-ag/dlmm` SDK:

- Wallet is optional. If `WALLET_PRIVATE_KEY` is set, it loads a `Keypair`; otherwise all execution paths are no-ops.
- `enterPosition()` deposits a 50/50 split by value (Spot strategy), capping each side to the wallet's actual token balance. Checks native SOL balance for wrapped SOL pairs.
- `exitPosition()` removes 100% liquidity, claims fees, and closes the position.
- `rebalancePosition()` is a sequential exit-then-enter, not an atomic operation.
- `swapViaJupiter()` is available for token swaps via Jupiter v6 API but is not used by the main loop.
- `getNativeSolBalance()` returns raw lamports from `connection.getBalance(wallet.publicKey)` for gas pre-flight checks.

### Pool Data Sources

`getPoolState()` and `fetchPoolStats()` do not call a Meteora REST API. They compute TVL, volume, fees, and APR from:

1. On-chain vault token account balances
2. Token prices from Jupiter Price API (fallback: CoinGecko, then hardcoded map)
3. Token metadata from Helius DAS `getAsset`

`getBinArray()` builds **synthetic bins** (prices only, zero reserves) because the DLMM SDK's `getBinsBetweenLowerAndUpperBound` crashes on many mainnet pools with sparse bin arrays. The bin step is read from `lbPair.binStep`.

### Fee/IL Math (`engine/strategy-service.ts`)

`computeFeeIlRatio()` uses the actual DLMM bin step to convert drift distance into a price ratio, then applies the standard CPMM IL formula:

```
priceRatio r = (1 + binStep/10_000)^binsDrifted
IL fraction  = 2√r / (1 + r) − 1
```

This replaced a prior flat 0.2% per-bin coefficient that misestimated IL on high-step pools.

`recommendBinRange()` returns asymmetric half-widths based on bin step: ±25 for ≤10bps, ±20 for 11–25bps, ±15 for >25bps.

### SQLite Persistence (`engine/db-service.ts`, `engine/db.ts`)

All local state lives in a single SQLite database (`bun:sqlite` + `sqlite-vec`):

- `positions` — open position records with trailing-stop columns
- `audit` — decision trail (replaced JSONL file streaming)
- `blacklists` — cached rejections
- `vec_memory` — virtual `vec0` table for embeddings (384-dim floats) with auxiliary metadata columns

Auto-migration system (`engine/db.ts`):

- `_migrations` table tracks applied versions
- `hasColumn()` guards make ALTER TABLE migrations idempotent
- Migrations run on every `createDatabase()` call

On macOS, `Database.setCustomSQLite()` points to the Homebrew `libsqlite3.dylib` so extension loading works for `sqlite-vec`.

### Memory (`engine/memory-service.ts`)

Memory is now SQLite-backed via `sqlite-vec` instead of ChromaDB. Three TTL tiers:

| Category | TTL |
|----------|-----|
| `pattern` | 90 days |
| `warning` | 60 days |
| `outcome` | 180 days |

`getRelevantContext()` reranks by blending similarity (70%) with recency decay (30%, 30-day half-life). Embeddings are generated with `@xenova/transformers`.

### Trailing Exit / Profit Protection (`engine/program.ts`)

Existing positions are revalued each cycle via `estimatePositionValue()` (bin-drift heuristic). The highest value seen is tracked in `highestValueUsd`. If drawdown from peak exceeds `TRAILING_STOP_PCT` (default 10%), the decision is overridden to **EXIT**.

`estimatePositionValue(pos, pool)` roughly interpolates IL based on how far the active bin has drifted from the position range center: full value at center, 50% at the far edge.

### Risk Gates (`engine/risk-service.ts`)

Checks execute in order with early return:

1. Confidence < `CONFIDENCE_THRESHOLD` → reject
2. Max concurrent positions reached → reject ENTER
   - **Duplicate pool guard** → reject ENTER if same pool already held (use REBALANCE instead)
3. EXIT → always approved (capital protection)
4. Portfolio drawdown > 10% → pause ENTER
5. Stop-loss triggered (`STOP_LOSS_PCT` exceeded) → reject HOLD/REBALANCE
6. Position size > 30% portfolio → cap to 30% and approve
7. Rebalance range inverted or > `MAX_REBALANCE_RANGE_BINS` → reject

### Config (`engine/config-service.ts`)

Effect-TS `Config` module with `Config.string` / `Config.number` / `Config.boolean` and `orElseSucceed` fallbacks. No hard exit on missing envs — every value has a sensible default. Test environment (`VITEST=true` or `NODE_ENV=test`) auto-injects dummy API keys so tests run without real credentials.

Key env additions:

| Variable | Default | Description |
|----------|---------|-------------|
| `TRAILING_STOP_PCT` | `0.10` | Drawdown from peak that triggers EXIT |
| `SQLITE_DB_PATH` | `./prism.db` | SQLite database file path |

### Backtest (`ops/backtest.ts`)

Generates synthetic 30-day price history via random walk with regime-switching volatility and occasional jump shocks. Runs a grid search over 4 parameter combinations (conservative → aggressive) and reports net PnL, win rate, and Sharpe ratio per config.

## Dev commands

```bash
bun run dev              # run with hot reload
bun run backtest         # historical simulation with grid search
bun run test             # vitest suite (bench/**/*.test.ts) — runs via Bun runtime
bun run test:watch       # vitest in watch mode
bun run lint             # tsc --noEmit && oxlint engine ops bench cli (strict, slow)
bun run setup            # interactive .env wizard
```

Run a single test:

```bash
bun run test -- --reporter=verbose bench/strategy.test.ts
bun run test -- --reporter=verbose -t "rejects inverted bin range"
```

Tests **must** execute under Bun because `bun:sqlite` is not available in Node.js. The `package.json` scripts already use `bunx --bun vitest run`.

## Effect-TS wiring notes

`buildLayer()` in `engine/program.ts` explicitly wires cross-layer dependencies with `Layer.provide()` because `Layer.merge` does **not** resolve requirements during construction:

```ts
const adapter = Layer.provide(AdapterLive, configLayer);
const memory  = Layer.provide(MemoryLive, dbLayer);
const audit   = Layer.provide(AuditLive, dbLayer);
const screenerDeps = Layer.merge(adapter, StrategyLive);
const screener = Layer.provide(ScreenerLive({...}), screenerDeps);
```

`exactOptionalPropertyTypes: true` in `tsconfig.json` breaks Effect-TS v3 `Effect.provide` narrowing. Tests use an `any` cast helper: `Effect.runSync((Effect.provide as any)(effect, layer))`.

## Key constraints

- Never use `console.log` — use `createLogger(component)` from `engine/logger.ts`. It writes to stdout + `logs/audit-trail.jsonl`.
- Paper trading is the default — `PAPER_TRADING=true` in `.env`
- No `any` types in production code — use `unknown` and narrow. The codebase has intentional `as any` casts in test helpers and one in `fetchPoolStats()` for parsed mint account data.
- Wallet balance checks cap deposit amounts. A position entry fails if either side of the pair has zero balance.
- One position per pool max. The duplicate pool guard prevents double-entry.
- Only one ENTER per cycle in live mode (conserves capital).
- Minimum 0.03 SOL reserve required for gas before any live ENTER (gas-aware sizing).


