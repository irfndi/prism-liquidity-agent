---
name: prism-install
description: Install and configure Prism liquidity agent for Meteora DLMM pools
version: 1.0.0
author: irfndi
license: MIT
metadata:
  hermes:
    tags: [defi, solana, trading, liquidity, meteora, dlmm]
    related_skills: [prism-rebalance, prism-backtest]
    category: software-development
---

# Prism Install

Use this skill when the user wants to install Prism for automated liquidity management on Solana.

## When to Use

- User asks to install a trading bot or liquidity agent
- User wants to automate Meteora DLMM positions
- User wants to earn fees from Solana DeFi pools
- User mentions `prism`, `prism-liquidity-agent`, or `@irfndi/prism-liquidity-agent`

## Prerequisites

- Bun 1.4.0+ (auto-installed if missing)
- Helius API key (get one at https://helius.dev)

## Installation Steps

### 1. Install Prism

The one-liner installer handles Bun (installs if missing), clones the repo, installs dependencies, runs postinstall, and writes a `prism` wrapper to `~/.local/bin/`.

```bash
curl -fsSL https://raw.githubusercontent.com/irfndi/prism-liquidity-agent/main/scripts/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
```

### 2. Configure

```bash
prism setup --non-interactive --helius-key=$HELIUS_KEY
```

This writes `.env` with the Helius key, an optional watchlist, and paper-trading defaults. The default mode is **paper trading** — no real funds are at risk.

If you don't know which pools to watch, also set `ENABLE_POOL_DISCOVERY=true` in `.env` so the agent can find candidates on its own.

### 3. Start

```bash
prism dev
```

Decisions are logged to `logs/audit-trail.jsonl`. To stop, send SIGINT (Ctrl+C).

## Three Layers (CLI is the only required one)

The CLI is fully functional without the cloud API. Do not assume `prism register` is required — it isn't.

| Layer | Purpose | Required? |
|---|---|---|
| CLI (local) | Runs the trading engine, persists positions to SQLite | **Yes** |
| API (cloud) | Cloud account, whoami, subscription, issue filing | No |
| Telegram (chat) | Monitor and control the agent from `@prism_agent_bot` | No |

## Available Commands

| Command | Purpose |
|---|---|
| `prism dev` | Start the trading engine |
| `prism setup` | Interactive `.env` wizard |
| `prism register` | Create a cloud account (optional) |
| `prism whoami` | Show cloud account info (requires `prism register`) |
| `prism backtest` | Run a historical simulation |
| `prism update` | Check for and apply updates |
| `prism issue "<msg>"` | File a GitHub issue (auto-deduped) |
| `prism wallet {generate,import,show}` | Manage the local Solana keypair |
| `prism link-telegram` | Link the cloud account to `@prism_agent_bot` |

## Common Mistakes

1. **Running `bun run dev` instead of `prism dev`.** `prism dev` goes through the CLI wrapper that resolves the install root and respects config. `bun run dev` bypasses that and may write `.env` to the wrong directory.
2. **Manually editing `.env`.** Use `prism setup` to update config. Hand-edits work but skip validation.
3. **Assuming `prism register` is required.** Skip it for local-only setups.
4. **Setting `PAPER_TRADING=false` without a wallet.** Live mode requires `WALLET_PRIVATE_KEY` in `.env`. Use `prism wallet generate` to create one.
5. **Forgetting to export `PATH`.** After the one-liner install, `~/.local/bin` must be on `PATH` for the `prism` wrapper to be found.

## Troubleshooting

- If Bun not found: `curl -fsSL https://bun.sh/install | bash`
- If sqlite-vec fails: Engine uses system SQLite automatically
- If ONNX error: Fallback embeddings enabled (`EMBEDDINGS_BACKEND=fallback` is the default)
- If `prism: command not found`: `export PATH="$HOME/.local/bin:$PATH"`
- If Helius 401/403: Re-run `prism setup --non-interactive --helius-key=$NEW_KEY`
- If engine starts but makes no decisions: Set `ENABLE_POOL_DISCOVERY=true` in `.env`

## Verify Installation

```bash
prism --version       # should print 0.0.3 or later
prism dev &           # start engine in background
sleep 30
tail -n 20 logs/audit-trail.jsonl   # should show scan cycle decisions
```

## Uninstall

```bash
rm -rf ~/.prism ~/.local/bin/prism ~/.config/prism/agent-id ~/.config/prism/install-id ~/.config/prism/credentials.json ~/.config/prism/wallet.json
```
