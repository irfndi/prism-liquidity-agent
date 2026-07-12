# Prism Installation Guide

> **For agent harnesses (OpenClaw, Hermes, acpx):** See [`agent-harness.md`](agent-harness.md) for the full agent setup flow with architecture overview and 3-layer quickstarts.

## Prism Architecture

Prism has 3 layers. The CLI is the operating boundary, and the API account is required before an agent can configure or run so telemetry, errors, and feedback have an owner. Telegram is optional.

1. **CLI (Local)** — The trading agent runs on your machine. All strategy, memory,
   risk management, and position execution lives here. Commands: `prism dev`,
   `prism setup`, `prism wallet`, `prism backtest`, `prism update`.
   **REQUIRED.**

2. **API (Cloud)** — A Cloudflare Worker that handles user accounts, API keys,
   and subscription tiers. Commands that need it: `prism register`, `prism whoami`,
   `prism login`, `prism link-telegram`, `prism subscription`.
   **REQUIRED for setup and agent operation.** `prism register` stores the account key locally.

3. **Telegram (Chat)** — A Telegram bot (`@prism_agent_bot`) for monitoring and
   control from your phone. Requires the API layer for auth.
   **OPTIONAL.** Skip if you don't use Telegram.

### Quickstart by Layer

Pick the option that matches your use case:

**Option A: Standard (CLI + API)** — The supported agent and user flow.

```bash
curl -fsSL https://raw.githubusercontent.com/irfndi/prism-liquidity-agent/main/scripts/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
prism register
prism setup --non-interactive --rpc-url="$SOLANA_RPC_URL"
prism doctor
prism dev                                                  # start paper trading
```

**Option B: Full (CLI + API + Telegram)** — Adds subscription management, multi-device
support, and Telegram monitoring.

```bash
curl -fsSL https://raw.githubusercontent.com/irfndi/prism-liquidity-agent/main/scripts/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
prism register                                              # get API key from cloud
prism setup --non-interactive --rpc-url="$SOLANA_RPC_URL"
prism dev
```

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
- **Git** — only for contributor source installs
- **Solana wallet** (optional) — only needed for live trading; paper trading works without one
- **Private Solana RPC URL** — required for reliable live trading; Helius is optional

## One-liner Install (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/irfndi/prism-liquidity-agent/main/scripts/install.sh | bash
```

What the installer does:

1. Installs Bun if it's not already on `PATH`
2. Detects your OS and architecture (`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`)
3. Downloads the matching compiled bundle (`dist/` engine + CLI, `lib/` native sqlite-vec extension) from Cloudflare R2
4. Verifies the bundle's SHA-256 checksum
5. Extracts it to `~/.prism` (override with `PRISM_INSTALL_DIR`)
6. Writes a `prism` wrapper at `~/.local/bin/prism` that sets `PRISM_INSTALL_DIR` and `PRISM_VEC0_PATH`, then runs the bundle with Bun
7. Preserves existing `.env`, `prism.db`, and logs; setup is deferred until registration

Then:

```bash
export PATH="$HOME/.local/bin:$PATH"   # if not already on PATH

prism register                          # required before setup/dev

# Required for reliable live trading:
prism setup --non-interactive --rpc-url=https://your-paid-rpc.example.com
prism doctor
prism dev                               # start paper trading
```

## Quick Start (Manual)

Choose your path based on the architecture above. The recommended path is the one-liner installer; the manual source path is for contributors.

**Registered CLI agent:**

```bash
# One-liner installer (recommended)
curl -fsSL https://raw.githubusercontent.com/irfndi/prism-liquidity-agent/main/scripts/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
prism register
prism setup     # interactive RPC/.env wizard
prism doctor
prism dev       # start paper trading
```

**With cloud account (same required flow):**

```bash
# One-liner installer (recommended)
curl -fsSL https://raw.githubusercontent.com/irfndi/prism-liquidity-agent/main/scripts/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
prism register  # get API key from Cloudflare API
prism setup     # configure RPC providers + watchlist
prism dev       # start paper trading
```

**Manual source install** (for contributors or CI — not needed for users):

```bash
git clone https://github.com/irfndi/prism-liquidity-agent.git
cd prism-liquidity-agent
bun install
bun run dev     # during development only; use `prism dev` for production
```

## Step-by-Step Setup

### 1. Install Prism

**Recommended — one-liner:**

```bash
curl -fsSL https://raw.githubusercontent.com/irfndi/prism-liquidity-agent/main/scripts/install.sh | bash
```

This downloads a compiled bundle for your platform, verifies its checksum, and writes the `prism` wrapper to `~/.local/bin/prism`.

**Manual source install (contributors only):**

```bash
git clone https://github.com/irfndi/prism-liquidity-agent.git
cd prism-liquidity-agent
bun install  # postinstall writes a default .env next to package.json
```

If the postinstall hook is disabled (`bun install --ignore-scripts`), run
`bun run setup:env` manually to write the default `.env`.

### 2. Register (Get API Key) — REQUIRED

```bash
prism register
```

Creates your identity with Prism's Cloudflare Worker and returns an API key. Store it
securely in `~/.config/prism/credentials.json`.

Setup, dev, feedback, issue, error reporting, and registered telemetry require the
stored account key. Telegram remains optional.

### 3. Configure RPC providers

```bash
prism setup
```

`prism setup` preserves the existing environment by writing a timestamped backup and
never asks an already configured install to repeat setup during upgrade.

Interactive wizard that asks for:

| Prompt             | Required | Default                    |
| ------------------ | -------- | -------------------------- |
| Helius API key     | NO       | empty when using custom RPC |
| Primary RPC URL    | NO       | derived from Helius key    |
| Fallback RPC URL   | NO       | empty                      |
| Wallet private key | NO       | empty (paper trading)      |
| Watchlist pools    | NO       | empty (use pool discovery) |

Everything else is **preconfigured** with sensible defaults:

- `PAPER_TRADING=true`
- `SOLANA_RPC_URL` defaults to Helius when a key is present; set it to a paid RPC URL for live trading
- `SOLANA_RPC_FALLBACK_URL` optionally points to a separate provider
- `JUPITER_API_KEY` optionally raises Jupiter Price API limits
- All strategy params (min TVL, fee/IL ratio, etc.) from `config-service.ts`

#### Agent-driven setup (non-interactive)

```bash
prism setup --non-interactive --rpc-url=https://your-paid-rpc.example.com \
  --rpc-fallback-url=https://your-second-rpc.example.com

# Or use a non-Helius primary provider:
prism setup --non-interactive --rpc-url=https://your-paid-rpc.example.com
```

### 4. Start Trading

```bash
# Paper trading (default, no wallet needed)
prism dev

# Live trading (requires wallet private key in .env)
PAPER_TRADING=false prism dev
```

Use `prism doctor` before starting, or `prism doctor --fix` to create missing local
directories and repair their permissions without changing secrets.

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
