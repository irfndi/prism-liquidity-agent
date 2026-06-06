# Prism Installation Guide

> **For agent harnesses (OpenClaw, Hermes, acpx):** See [`agent-harness.md`](agent-harness.md) for the full agent setup flow with architecture overview and 3-layer quickstarts.

## Prism Architecture

Prism has 3 layers. Only the CLI is required. The API and Telegram are optional add-ons.

1. **CLI (Local)** — The trading agent runs on your machine. All strategy, memory,
   risk management, and position execution lives here. Commands: `prism dev`,
   `prism setup`, `prism wallet`, `prism backtest`, `prism update`.
   **REQUIRED.**

2. **API (Cloud)** — A Cloudflare Worker that handles user accounts, API keys,
   and subscription tiers. Commands that need it: `prism register`, `prism whoami`,
   `prism login`, `prism link-telegram`, `prism subscription`.
   **OPTIONAL.** Skip if you only need local trading.

3. **Telegram (Chat)** — A Telegram bot (`@prism_agent_bot`) for monitoring and
   control from your phone. Requires the API layer for auth.
   **OPTIONAL.** Skip if you don't use Telegram.

### Quickstart by Layer

Pick the option that matches your use case:

**Option A: Minimal (CLI only)** — Local-only trading, no cloud account.

```bash
git clone https://github.com/irfndi/prism-liquidity-agent.git
cd prism-liquidity-agent
bun install
prism setup --non-interactive --helius-key=$HELIUS_KEY   # wizard, no API call
prism dev                                                  # start paper trading
```

**Option B: Standard (CLI + API)** — Most users. Adds cloud account, subscription
management, and multi-device support.

```bash
git clone https://github.com/irfndi/prism-liquidity-agent.git
cd prism-liquidity-agent
bun install
prism register                                              # get API key from cloud
prism setup --non-interactive --helius-key=$HELIUS_KEY
prism dev
```

**Option C: Full (CLI + API + Telegram)** — Power users who want Telegram alerts
and phone-based monitoring.

```bash
# Same as Standard, then:
prism link-telegram   # generates 6-char code
# Send the code to @prism_agent_bot on Telegram
```

### Feature Matrix

| Feature            | CLI | API | Telegram |
| ------------------ | --- | --- | -------- |
| Core trading agent | ✅  | -   | -        |
| Paper trading      | ✅  | -   | -        |
| Live trading       | ✅  | -   | -        |
| Backtesting        | ✅  | -   | -        |
| User registration  | -   | ✅  | -        |
| API key management | -   | ✅  | -        |
| Subscription tiers | -   | ✅  | -        |
| Position alerts    | ✅  | ✅  | ✅       |
| Phone monitoring   | -   | -   | ✅       |
| Multi-device sync  | -   | ✅  | -        |
| Wallet management  | ✅  | -   | -        |
| Auto-updates       | ✅  | -   | -        |

## Prerequisites

- **Bun 1.4.0+** — [Install Bun](https://bun.sh/docs/installation) (the one-liner installer can do this for you)
- **Git** — for cloning the repository
- **Solana wallet** (optional) — only needed for live trading; paper trading works without one
- **Helius API key** (REQUIRED) — [Get one free at Helius](https://helius.xyz/)

## One-liner Install (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/irfndi/prism-liquidity-agent/main/scripts/install.sh | bash
```

What the installer does:

1. Installs Bun if it's not already on `PATH`
2. Clones (or updates) the repo to `~/.prism`
3. Runs `bun install` (no `--frozen-lockfile` so older Bun versions work)
4. Writes a default `.env` (idempotent — leaves existing `.env` untouched)
5. Writes a wrapper script at `~/.local/bin/prism` that runs the CLI from the install directory

Then:

```bash
export PATH="$HOME/.local/bin:$PATH"   # if not already on PATH

# For cloud features (optional):
prism register                          # get an API key from the Cloudflare API

# Required:
prism setup --non-interactive --helius-key=your-helius-key
prism dev                               # start paper trading
```

## Quick Start (Manual)

Choose your path based on the architecture above:

**CLI only (no cloud account):**

```bash
git clone https://github.com/irfndi/prism-liquidity-agent.git
cd prism-liquidity-agent
bun install
prism setup     # interactive .env wizard (local, no API call)
prism dev       # start paper trading
```

**With cloud account (for whoami, Telegram, subscriptions):**

```bash
git clone https://github.com/irfndi/prism-liquidity-agent.git
cd prism-liquidity-agent
bun install
prism register  # get API key from Cloudflare API
prism setup     # configure Helius key + watchlist
prism dev       # start paper trading
```

## Step-by-Step Setup

### 1. Clone and Install

```bash
git clone https://github.com/irfndi/prism-liquidity-agent.git
cd prism-liquidity-agent
bun install  # postinstall writes a default .env next to package.json
```

If the postinstall hook is disabled (`bun install --ignore-scripts`), run
`bun run setup:env` manually to write the default `.env`.

### 2. Register (Get API Key) — OPTIONAL

```bash
prism register
```

Creates your identity with Prism's Cloudflare Worker and returns an API key. Store it
securely in `~/.config/prism/credentials.json`.

**Skip this step if you only need local trading.** The CLI works without an API key.
You lose access to `prism whoami`, `prism link-telegram`, `prism subscription`,
and `prism issue` — but all trading commands (`prism dev`, `prism setup`,
`prism wallet`, `prism backtest`, `prism update`) work fine.

### 3. Configure (Helius Key Required)

```bash
prism setup
```

Interactive wizard that asks for:

| Prompt             | Required | Default                    |
| ------------------ | -------- | -------------------------- |
| Helius API key     | **YES**  | —                          |
| Wallet private key | NO       | empty (paper trading)      |
| Watchlist pools    | NO       | empty (use pool discovery) |

Everything else is **preconfigured** with sensible defaults:

- `PAPER_TRADING=true`
- `SOLANA_RPC_URL` auto-derived from your Helius key
- All strategy params (min TVL, fee/IL ratio, etc.) from `config-service.ts`

#### Agent-driven setup (non-interactive)

```bash
prism setup --non-interactive --helius-key=your-helius-key
```

### 4. Start Trading

```bash
# Paper trading (default, no wallet needed)
prism dev

# Live trading (requires wallet private key in .env)
PAPER_TRADING=false prism dev
```

## What's Preconfigured

You don't need to set these — they have sensible defaults (auto-written by the postinstall hook if missing):

All env vars below are for the **CLI layer** (the local trading engine). The API and
Telegram layers have their own configuration via the Cloudflare Dashboard and are
not set through `.env`.

- `PAPER_TRADING=true` — start with simulated trades
- `SCAN_INTERVAL_MS=600000` — scan every 10 minutes
- `MIN_POOL_TVL_USD=50000` — skip low-TVL pools
- `MIN_FEE_IL_RATIO=1.2` — minimum fee/IL ratio to hold
- `VOLUME_AUTH_THRESHOLD=0.70` — skip wash-traded pools
- `CONFIDENCE_THRESHOLD=0.65` — minimum confidence to act
- `TRAILING_STOP_PCT=0.10` — 10% drawdown triggers exit
- `SQLITE_DB_PATH=./prism.db` — agent's local DB
- `EMBEDDINGS_BACKEND=fallback` — pure-JS embeddings (no ONNX download)
- All other strategy parameters

### About `EMBEDDINGS_BACKEND`

Default is `fallback` — a deterministic 384-dim hash-based embedding that
ships zero additional dependencies. Memory similarity clusters identical
inputs (so the agent can still recall what it just wrote) but is **not
semantically meaningful** (so cross-input recall is degraded).

To opt into the real model (downloads ~80MB ONNX weights on first use),
set `EMBEDDINGS_BACKEND=onnx` in your `.env`. Note: the ONNX runtime
can crash in Node.js with `BigInt` serialization errors; if that
happens the agent falls back to hash embeddings and logs a warning.

## Next Steps

- Read [`docs/cli.md`](cli.md) for the full command reference
- Read [`docs/cron-examples.md`](cron-examples.md) to run unattended
- Read [`docs/agent-harness.md`](agent-harness.md) for OpenClaw/Hermes integration
