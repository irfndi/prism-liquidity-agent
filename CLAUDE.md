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
   - **EXIT** if TVL dropped > `TVL_DROP_EXIT_PCT`, auth < threshold, or fee/IL < 0.5
   - **REBALANCE** if drift > 60% of range edge AND `timeSinceRebal >= MIN_REBALANCE_INTERVAL_MS` AND simulated net benefit > `MIN_REBALANCE_NET_BENEFIT_USD`
   - **HOLD** for existing positions with strong fee/IL and no recent warnings
   - **ENTER** for new pools with fee/IL > threshold*1.5, auth > 0.8, util > 0.4, TVL > `MIN_POOL_TVL_USD * 2`
6. `risk.evaluate()` — confidence, concurrent positions, duplicate pool, drawdown, size cap, bin range validation
7. Execute (paper or live) + `memory.recordOutcome()`

Positions and rebalance timestamps are tracked in-memory via `trackedPositions` (Map) and `lastRebalanceTime` (Map). There is no persistent position state across restarts.

### Live Trading (`engine/adapters/meteora.ts`)

`MeteoraAdapter` wraps the `@meteora-ag/dlmm` SDK:

- Wallet is optional. If `WALLET_PRIVATE_KEY` is set, it loads a `Keypair`; otherwise all execution paths are no-ops.
- `enterPosition()` deposits a 50/50 split by value (Spot strategy), capping each side to the wallet's actual token balance. Checks native SOL balance for wrapped SOL pairs.
- `exitPosition()` removes 100% liquidity, claims fees, and closes the position.
- `rebalancePosition()` is a sequential exit-then-enter, not an atomic operation.
- `swapViaJupiter()` is available for token swaps via Jupiter v6 API but is not used by the main loop.

### Pool Data Sources

`getPoolState()` and `fetchPoolStats()` do not call a Meteora REST API. They compute TVL, volume, fees, and APR from:

1. On-chain vault token account balances
2. Token prices from Jupiter Price API (fallback: CoinGecko, then hardcoded map)
3. Token metadata from Helius DAS `getAsset`

`getBinArray()` builds **synthetic bins** (prices only, zero reserves) because the DLMM SDK's `getBinsBetweenLowerAndUpperBound` crashes on many mainnet pools with sparse bin arrays. The bin step is read from `lbPair.binStep`.

### Fee/IL Math (`engine/probes/dlmm.ts`)

`computeFeeIlRatio()` uses the actual DLMM bin step to convert drift distance into a price ratio, then applies the standard CPMM IL formula:

```
priceRatio r = (1 + binStep/10_000)^binsDrifted
IL fraction  = 2√r / (1 + r) − 1
```

This replaced a prior flat 0.2% per-bin coefficient that misestimated IL on high-step pools.

`recommendBinRange()` returns asymmetric half-widths based on bin step: ±25 for ≤10bps, ±20 for 11–25bps, ±15 for >25bps.

### Memory (`engine/memory/store.ts`)

ChromaDB-backed with three TTL tiers:

| Category | TTL |
|----------|-----|
| `pattern` | 90 days |
| `warning` | 60 days |
| `outcome` | 180 days |

Collection name: `prism_memory`. Merge guard uses cosine **distance** < 0.08 (i.e. similarity > 0.92). `getRelevantContext()` reranks by blending similarity (70%) with recency decay (30%, 30-day half-life).

### Risk Gates (`engine/risk/gate.ts`)

Checks execute in order with early return:

1. Confidence < `CONFIDENCE_THRESHOLD` → reject
2. Max concurrent positions reached → reject ENTER
3. **Duplicate pool guard** → reject ENTER if same pool already held (use REBALANCE instead)
4. Portfolio drawdown > 10% → pause ENTER
5. Position size > 30% portfolio → cap to 30% and approve
6. Rebalance range inverted or > `MAX_REBALANCE_RANGE_BINS` → reject
7. EXIT → always approved (capital protection)

### Config (`engine/config.ts`)

Zod schema with `safeParse`. On validation failure, prints all issues and exits with code 1. Test environment (`VITEST=true` or `NODE_ENV=test`) auto-injects dummy API keys so tests run without real credentials.

### MCP Tools (`engine/tools/index.ts`)

Seven tool definitions exist for a potential future LLM agent mode, but the current engine does not use them. `meteora_decision` is intercepted in `engine/index.ts` and never reaches `executeTool()`.

### Backtest (`ops/backtest.ts`)

Generates synthetic 30-day price history via random walk with regime-switching volatility and occasional jump shocks. Runs a grid search over 4 parameter combinations (conservative → aggressive) and reports net PnL, win rate, and Sharpe ratio per config.

## Dev commands

```bash
bun run dev              # run with hot reload
bun run backtest         # historical simulation with grid search
bun run test             # vitest suite (bench/**/*.test.ts)
bun run test:watch       # vitest in watch mode
bun run lint             # TypeScript type check (tsc --noEmit)
bun run setup            # interactive .env wizard
```

Run a single test:

```bash
bun run test -- --reporter=verbose bench/strategy.test.ts
bun run test -- --reporter=verbose -t "rejects inverted bin range"
```

## Key constraints

- Never use `console.log` — use `createLogger(component)` from `engine/logger.ts`. It writes to stdout + `logs/audit-trail.jsonl`.
- Paper trading is the default — `PAPER_TRADING=true` in `.env`
- No `any` types — use `unknown` and narrow. The codebase has one intentional `as any` in `fetchPoolStats()` for parsed mint account data.
- Wallet balance checks cap deposit amounts. A position entry fails if either side of the pair has zero balance.
- One position per pool max. The duplicate pool guard prevents double-entry.
- Only one ENTER per cycle in live mode (conserves capital).
- Minimum 0.05 SOL reserve required for gas + position rent before any live ENTER.
