# Prism

![License](https://img.shields.io/badge/license-MIT-blue)
![Runtime](https://img.shields.io/badge/runtime-Bun_1.4-black)
![Chain](https://img.shields.io/badge/chain-Solana-9945FF)

An autonomous liquidity agent that watches liquidity pools on Solana (currently Meteora DLMM), reasons over live on-chain data, and rebalances positions before they bleed.

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

The agent remembers. Every outcome -- fee earned, IL incurred, bad pool flagged -- gets stored in an SQLite vector table (`sqlite-vec`) and retrieved by cosine similarity on the next relevant cycle. Entries expire automatically (90 days for patterns, 60 for warnings, 180 for outcomes).

This is what makes it self-improving: it gets slower to enter pools it has been burned by before, and faster to recognize patterns it has profited from.

## Volume authenticity

Before any decision, the agent scores each pool's volume on a 0-1 scale. Volume/TVL ratio above 10x, fee rate outside the 0.02%-2% band, or low TVL with outsized volume all push the score down. Pools below 0.70 are skipped entirely. This alone filters most of the wash-traded noise on DLMM.

## Quickstart

**One-liner install — latest from default branch** (recommended for most users; installs Bun if needed, clones the repo, writes a default `.env`, and drops a `prism` wrapper on your PATH):

```bash
curl -fsSL https://raw.githubusercontent.com/irfndi/prism-liquidity-agent/main/scripts/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"   # if not already on PATH
prism setup --non-interactive --helius-key=YOUR_HELIUS_KEY
prism dev                               # paper trading by default
```

**One-liner install — pinned release tarball** (faster, no git history, reproducible):

```bash
PRISM_TARBALL_URL=https://github.com/irfndi/prism-liquidity-agent/releases/download/v1.2.3/prism-v1.2.3.tar.gz \
  curl -fsSL https://raw.githubusercontent.com/irfndi/prism-liquidity-agent/main/scripts/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
prism dev
```

Use the tarball form when you need a specific release version (CI, reproducible deploys, air-gapped networks without git). The `prism update` command will still pull newer release tarballs for you.

**Manual install** (only if you're working ON Prism itself — contributors, CI):

```bash
git clone https://github.com/irfndi/prism-liquidity-agent
cd prism-liquidity-agent
bun install
bun run dev          # during development; production users use 'prism dev'
```

All three paths end up with the same `prism` wrapper on PATH. The wrapper is a thin shim that `cd`s to the install root before exec'ing `bun cli/index.ts`, so the working directory always resolves correctly regardless of where you invoke it from.

### For AI Agents (OpenClaw, Hermes, acpx, custom agents)

Prism is agent-friendly by design. The CLI is the only required layer; the cloud API and Telegram bot are optional add-ons that you skip if you don't need them.

```bash
# Pinned release — reproducible, no git, fastest for agents
PRISM_TARBALL_URL=https://github.com/irfndi/prism-liquidity-agent/releases/latest/download/prism-latest.tar.gz \
  curl -fsSL https://raw.githubusercontent.com/irfndi/prism-liquidity-agent/main/scripts/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"

# Or latest from default branch
curl -fsSL https://raw.githubusercontent.com/irfndi/prism-liquidity-agent/main/scripts/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"

prism register                                    # OPTIONAL — get API key from cloud
prism setup --non-interactive --helius-key=$KEY    # required — Helius RPC key
prism dev                                         # start paper trading
```

If `prism` is not on `PATH` after the one-liner install, invoke the CLI directly:

```bash
bun cli/index.ts setup --non-interactive --helius-key=$KEY
bun cli/index.ts dev
```

Common agent commands:

| Command                                                          | Purpose                                                           |
| ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| `prism setup` / `prism setup --non-interactive --helius-key=...` | Write `.env` (Helius key, watchlist, optional API key)            |
| `prism dev`                                                      | Start the trading agent (paper by default)                        |
| `prism backtest --days 7`                                        | Run a historical simulation against synthetic data                |
| `prism backtest --source replay --days 7 --pools <addr>`         | Replay live on-chain snapshots through the strategy               |
| `prism register`                                                 | Create a cloud account, returns an API key (optional)             |
| `prism whoami`                                                   | Show current user / API key info (requires `register`)            |
| `prism link-telegram`                                            | Issue a 6-char code to link `@prism_agent_bot` (optional)         |
| `prism update`                                                   | Self-update from R2/GitHub releases (with smoke tests + rollback) |
| `prism wallet {generate,import,show}`                            | Non-custodial local keypair (required for live trading)           |

Do NOT manually edit `.env` or run `bun run dev` directly — always go through the `prism` wrapper so the working directory and config are resolved consistently. See [docs/agent-harness.md](docs/agent-harness.md) for the full agent guide and common anti-patterns.

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

| Variable                  | Default      | Description                              |
| ------------------------- | ------------ | ---------------------------------------- |
| `WATCHLIST_POOLS`         | --           | Comma-separated pool addresses           |
| `PAPER_TRADING`           | `true`       | Disable to execute on-chain              |
| `MIN_POOL_TVL_USD`        | `50000`      | Skip pools below this TVL                |
| `MIN_FEE_IL_RATIO`        | `1.2`        | Minimum fee/IL ratio to hold             |
| `VOLUME_AUTH_THRESHOLD`   | `0.70`       | Skip pools below this authenticity score |
| `SCAN_INTERVAL_MS`        | `600000`     | Scan frequency (default 10 min)          |
| `CONFIDENCE_THRESHOLD`    | `0.65`       | Minimum agent confidence to act          |
| `TRAILING_STOP_PCT`       | `0.10`       | Drawdown from peak that triggers EXIT    |
| `SQLITE_DB_PATH`          | `./prism.db` | SQLite database file path                |
| `ENABLE_SNAPSHOT_CAPTURE` | `false`      | Dump pool snapshots to DB (paper only)   |

## Risk gates

Decisions pass through checks in order before any on-chain action:

1. Confidence below `CONFIDENCE_THRESHOLD` -> reject
2. Max concurrent positions reached -> reject ENTER
   - **Duplicate pool guard** -> reject ENTER if same pool already held
3. EXIT -> always approved (capital protection)
4. Portfolio drawdown > 10% -> pause new entries
5. Stop-loss triggered (`STOP_LOSS_PCT` exceeded) -> reject HOLD/REBALANCE
6. Position size > 30% of portfolio -> cap and allow
7. Rebalance range > `MAX_REBALANCE_RANGE_BINS` -> reject REBALANCE

## Stack

- **Runtime**: Bun 1.4.0
- **Strategy**: Rule-based engine with DLMM probes
- **Memory**: SQLite + sqlite-vec, 30-day recency decay
- **On-chain**: `@meteora-ag/dlmm` SDK, Helius RPC
- **Config**: Effect-TS Config module with `orElseSucceed` fallbacks; every value has a sensible default and test mode auto-injects dummy API keys

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full component map and agent loop.
