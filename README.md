# Prism

![License](https://img.shields.io/badge/license-MIT-blue)
![Runtime](https://img.shields.io/badge/runtime-Bun_1.4-black)
![Chain](https://img.shields.io/badge/chain-Solana-9945FF)

An autonomous liquidity agent that watches Meteora DLMM pools, reasons over live on-chain data, and rebalances positions before they bleed.

## What it does

Concentrated liquidity earns fees only when the active price bin sits inside your range. When the market drifts, your position silently collects impermanent loss instead. Most LPs either do not notice or react too late.

Prism fixes this with a rule-based agent that runs every 10 minutes, checks every pool in your watchlist, and either **holds**, **shifts the range**, **pulls liquidity entirely**, or **enters new pools**.

Every cycle follows the same sequence:

```
1. recall     -> query memory for past patterns on this pool
2. observe    -> fetch pool state, bin array, volume authenticity
3. reason     -> compute fee/IL ratio, bin drift, TVL velocity
4. simulate   -> if REBALANCE, estimate IL cost before committing
5. record     -> write new observations back to memory
6. decide     -> HOLD | REBALANCE | EXIT | ENTER
```

The decision is intercepted by a risk gate before anything happens on-chain. Confidence below threshold, drawdown above limit, or a position cap breach -- any of these blocks execution and logs a warning to memory so future cycles are aware.

## Memory

The agent remembers. Every outcome -- fee earned, IL incurred, bad pool flagged -- gets stored in an SQLite vector table (`sqlite-vec`) and retrieved by cosine similarity on the next relevant cycle. Entries expire automatically (90 days for patterns, 60 for warnings, 180 for outcomes). Near-duplicate memories merge instead of pile up.

This is what makes it self-improving: it gets slower to enter pools it has been burned by before, and faster to recognize patterns it has profited from.

## Volume authenticity

Before any decision, the agent scores each pool's volume on a 0-1 scale. Volume/TVL ratio above 10x, fee rate outside the 0.02%-2% band, or low TVL with outsized volume all push the score down. Pools below 0.70 are skipped entirely. This alone filters most of the wash-traded noise on DLMM.

## Quickstart

```bash
git clone https://github.com/irfndi/prism-dlmm
cd prism-dlmm
bun install
bun run setup            # interactive .env wizard
bun run dev              # paper trading by default
```

To run the historical simulation:

```bash
bun run backtest                              # synthetic, 7 days
bun run backtest --days 30 --pools <addr>    # custom range
```

### Replay backtest from live snapshots

Set `ENABLE_SNAPSHOT_CAPTURE=true` while the agent runs in paper mode. Every cycle dumps the full pool state + bin array into `pool_snapshots` in SQLite. Later, replay that real on-chain data through the strategy:

```bash
bun run backtest --source replay --db ./prism.db --days 7 --pools <addr>
```

## Configuration

Key `.env` variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `WATCHLIST_POOLS` | -- | Comma-separated pool addresses |
| `PAPER_TRADING` | `true` | Disable to execute on-chain |
| `MIN_POOL_TVL_USD` | `50000` | Skip pools below this TVL |
| `MIN_FEE_IL_RATIO` | `1.2` | Minimum fee/IL ratio to hold |
| `VOLUME_AUTH_THRESHOLD` | `0.70` | Skip pools below this authenticity score |
| `SCAN_INTERVAL_MS` | `600000` | Scan frequency (default 10 min) |
| `CONFIDENCE_THRESHOLD` | `0.65` | Minimum agent confidence to act |
| `TRAILING_STOP_PCT` | `0.10` | Drawdown from peak that triggers EXIT |
| `SQLITE_DB_PATH` | `./prism.db` | SQLite database file path |
| `ENABLE_SNAPSHOT_CAPTURE` | `false` | Dump pool snapshots to DB (paper only) |

## Risk gates

Decisions pass through checks in order before any on-chain action:

1. Confidence below `CONFIDENCE_THRESHOLD` -> reject
2. Max concurrent positions reached -> reject ENTER
3. **Duplicate pool guard** -> reject ENTER if same pool already held
4. Portfolio drawdown > 10% -> pause new entries
5. Position size > 30% of portfolio -> cap and allow
6. Rebalance range > `MAX_REBALANCE_RANGE_BINS` -> reject REBALANCE
7. EXIT -> always approved (capital protection)

## Stack

- **Runtime**: Bun 1.2
- **Strategy**: Rule-based engine with DLMM probes
- **Memory**: SQLite + sqlite-vec, cosine distance merge threshold 0.08, 30-day recency decay
- **On-chain**: `@meteora-ag/dlmm` SDK, Helius RPC
- **Config**: Effect-TS Config module with `orElseSucceed` fallbacks; every value has a sensible default and test mode auto-injects dummy API keys

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full component map and agent loop.
