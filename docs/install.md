# Prism Installation Guide

> **For agent harnesses (OpenClaw, Hermes, acpx):** The Cloudflare infrastructure is already deployed. Just clone, `bun install`, then `prism register` and `prism setup`. See [`agent-harness.md`](agent-harness.md) for the full agent setup flow.

## Prerequisites

- **Bun 1.2+** — [Install Bun](https://bun.sh/docs/installation)
- **Git** — for cloning the repository
- **Solana wallet** (optional) — only needed for live trading; paper trading works without one
- **Helius API key** (REQUIRED) — [Get one free at Helius](https://helius.xyz/)

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/irfndi/prism-liquidity-agent.git
cd prism-liquidity-agent

# 2. Install dependencies
bun install

# 3. Register with Prism (get your API key from deployed Cloudflare API)
prism register

# 4. Configure your trading agent
prism setup

# 5. Start paper trading
prism dev
```

## Step-by-Step Setup

### 1. Clone and Install

```bash
git clone https://github.com/irfndi/prism-liquidity-agent.git
cd prism-liquidity-agent
bun install
```

### 2. Register (Get API Key)

```bash
prism register
```

This creates your identity with Prism's Cloudflare Worker and returns an API key. Store it securely in `~/.config/prism/credentials.json`.

### 3. Configure (Helius Key Required)

```bash
prism setup
```

Interactive wizard that asks for:

| Prompt | Required | Default |
|--------|----------|---------|
| Helius API key | **YES** | — |
| Wallet private key | NO | empty (paper trading) |
| Watchlist pools | NO | empty (use pool discovery) |

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

You don't need to set these — they have sensible defaults:

- `PAPER_TRADING=true` — start with simulated trades
- `SCAN_INTERVAL_MS=600000` — scan every 10 minutes
- `MIN_POOL_TVL_USD=50000` — skip low-TVL pools
- `MIN_FEE_IL_RATIO=1.2` — minimum fee/IL ratio to hold
- `VOLUME_AUTH_THRESHOLD=0.70` — skip wash-traded pools
- `CONFIDENCE_THRESHOLD=0.65` — minimum confidence to act
- `TRAILING_STOP_PCT=0.10` — 10% drawdown triggers exit
- All other strategy parameters

## What's Dead/Unused (Ignore These)

The following env vars exist in the codebase but are **not used at runtime**:

- `ANTHROPIC_API_KEY` — dead dependency, no Claude integration
- `CLAUDE_MODEL` — dead dependency, no AI model calls
- `CHROMA_URL` — dead dependency, replaced with sqlite-vec

Do not set these. They are loaded for backward compatibility but never consumed.

## Next Steps

- Read [`docs/cli.md`](cli.md) for the full command reference
- Read [`docs/cron-examples.md`](cron-examples.md) to run unattended
- Read [`docs/agent-harness.md`](agent-harness.md) for OpenClaw/Hermes integration
