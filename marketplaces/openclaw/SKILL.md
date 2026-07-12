---
name: prism-install
description: Install and run Prism for automated Meteora DLMM rebalancing on Solana
---

# Prism Liquidity Agent

Install and run Prism for automated Meteora DLMM rebalancing on Solana.

## When This Skill Activates

- User wants to install a Solana liquidity trading agent
- User wants to automate Meteora DLMM pool rebalancing
- User wants to earn fees from concentrated-liquidity pools on Solana
- User mentions `prism`, `prism-liquidity-agent`, or `@irfndi/prism-liquidity-agent`

## Installation

The one-liner installer handles Bun (installs if missing), detects your OS/architecture, downloads a compiled bundle from Cloudflare R2, verifies its SHA-256 checksum, extracts it to `~/.prism`, and writes a `prism` wrapper to `~/.local/bin/`.

```bash
curl -fsSL https://raw.githubusercontent.com/irfndi/prism-liquidity-agent/main/scripts/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
```

## Agent Operating Contract

Use the installed `prism` wrapper as the product boundary. The release installer provides the checksum-verified platform bundle under `~/.prism` and the global command under `~/.local/bin/prism`.

```bash
curl -fsSL https://raw.githubusercontent.com/irfndi/prism-liquidity-agent/main/scripts/install.sh \
  | PRISM_SKIP_SETUP=1 bash
export PATH="$HOME/.local/bin:$PATH"
prism register
prism version
prism doctor
prism setup --non-interactive --rpc-url="$SOLANA_RPC_URL"
prism dev
```

Upgrade with `prism update --check-only` and `prism update`. Do not edit the Prism checkout, run `bun run dev`, or run `bun install` during agent operations; those commands are for Prism development. `bun add --global prism` is unsupported because no npm package with that name is published.

## Configuration

```bash
prism setup --non-interactive --rpc-url="$SOLANA_RPC_URL" --rpc-fallback-url="${SOLANA_RPC_FALLBACK_URL:-}"
```

This writes `.env` with the RPC provider settings, an optional watchlist, and paper-trading defaults. The default mode is **paper trading** — no real funds are at risk.

## Start Trading

```bash
prism dev
```

Decisions are logged to `logs/audit-trail.jsonl`. To stop, send SIGINT (Ctrl+C).

## Available Commands

- `prism whoami` — Show current account
- `prism backtest` — Run backtest
- `prism update` — Check for updates
- `prism issue "<msg>"` — Store an issue in Prism Cloud D1
- `prism register` — Create the required cloud account
- `prism doctor [--fix]` — Validate registration, providers, and local state
- `prism wallet {generate,import,show}` — Manage the local Solana keypair
- `prism link-telegram` — Link to `@prism_agent_bot`

## Three Layers (CLI boundary plus required account)

The API account is required before `prism setup` and `prism dev` so telemetry,
errors, feedback, and usage have an owner. Telegram remains optional.

| Layer | Purpose | Required? |
|---|---|---|
| CLI (local) | Runs the trading engine | **Yes** |
| API (cloud) | Account, telemetry, errors, feedback, whoami, subscription | **Yes for agents** |
| Telegram (chat) | Monitor from `@prism_agent_bot` | No |

## Common Mistakes

1. Running `bun run dev` instead of `prism dev` — `prism dev` respects the install root.
2. Manually editing `.env` — use `prism setup`.
3. Skipping `prism register` — registration is required before setup and dev.
4. Setting `PAPER_TRADING=false` without a wallet — use `prism wallet generate` first.
5. Forgetting to export `PATH` after install.

## Troubleshooting

- `prism: command not found` → `export PATH="$HOME/.local/bin:$PATH"`
- `Bun not found` → installer auto-installs; check `$HOME/.bun/bin`
- `sqlite-vec` fails on Linux → engine falls back to system `libsqlite3.so` automatically
- `BigInt` serialization error → set `EMBEDDINGS_BACKEND=fallback` in `.env` (default)
- Helius 401/403 → re-run `prism setup` with a valid key
- Engine starts but makes no decisions → set `ENABLE_POOL_DISCOVERY=true` in `.env`

## Verify Installation

```bash
prism --version       # should print 0.0.8 or later
prism dev &           # start engine in background
sleep 30
tail -n 20 logs/audit-trail.jsonl
```

## Uninstall

```bash
rm -rf ~/.prism ~/.local/bin/prism ~/.config/prism/agent-id ~/.config/prism/install-id ~/.config/prism/credentials.json ~/.config/prism/wallet.json
```
