# Prism Install Skill

Use this skill when an agent needs to install, configure, or run the Prism liquidity agent for automated Meteora DLMM rebalancing on Solana.

## When to Activate

- User asks to install a Solana liquidity agent, trading bot, or DLMM rebalancer
- User wants to automate Meteora DLMM pool positions
- User wants to earn fees from concentrated-liquidity pools without manual management
- User mentions `prism`, `prism-liquidity-agent`, or `@irfndi/prism-liquidity-agent`

## Three Layers (CLI is the only required one)

Prism is designed in three independent layers. The CLI is required; the API and Telegram are optional add-ons.

| Layer | Purpose | Required? |
|---|---|---|
| CLI (local) | Runs the trading engine, reads `.env`, persists positions to SQLite | **Yes** |
| API (cloud) | Cloud account, whoami, subscription, issue filing, feedback | No |
| Telegram (chat) | Monitor and control the agent from `@prism_agent_bot` | No |

The CLI is fully functional without the API. Do not assume `prism register` is required — it isn't.

## Install

The one-liner installer handles Bun (installs if missing), clones the repo, installs dependencies, runs postinstall, and writes a `prism` wrapper to `~/.local/bin/`.

```bash
curl -fsSL https://raw.githubusercontent.com/irfndi/prism-liquidity-agent/main/scripts/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
```

For a pinned release tarball (faster, no git history, reproducible):

```bash
curl -fsSL https://raw.githubusercontent.com/irfndi/prism-liquidity-agent/main/scripts/install.sh | PRISM_TARBALL_URL=https://github.com/irfndi/prism-liquidity-agent/releases/download/v0.0.2/prism-v0.0.2.tar.gz bash
export PATH="$HOME/.local/bin:$PATH"
```

## Configure

Non-interactive (for agents and CI):

```bash
prism setup --non-interactive --helius-key=$HELIUS_KEY
```

If you don't know which pools to watch, also set `ENABLE_POOL_DISCOVERY=true` in `.env` so the agent can find candidates on its own.

Interactive (for humans):

```bash
prism setup
```

This writes `.env` with the Helius key, an optional watchlist, and paper-trading defaults. The default mode is **paper trading** — no real funds are at risk.

## Start Trading

```bash
prism dev
```

This spawns the engine. Decisions are logged to `logs/audit-trail.jsonl`. To stop, send SIGINT (Ctrl+C).

## Common Commands

| Command | Purpose |
|---|---|
| `prism whoami` | Show cloud account info (requires `prism register`) |
| `prism register` | Create a cloud account, returns an API key (optional) |
| `prism setup` | Interactive `.env` wizard |
| `prism dev` | Start the trading engine |
| `prism backtest` | Run a historical simulation (synthetic or replay from snapshots) |
| `prism update` | Check for and apply updates from R2/GitHub releases |
| `prism wallet {generate,import,show}` | Manage the local Solana keypair (required for live trading) |
| `prism link-telegram` | Link the cloud account to `@prism_agent_bot` |

## Common Mistakes

1. **Running `bun run dev` instead of `prism dev`.** Both start the engine, but `prism dev` goes through the CLI wrapper that resolves the install root and respects config. `bun run dev` bypasses that and may write `.env` to the wrong directory.
2. **Manually editing `.env`.** Use `prism setup` to update config. Hand-edits work but skip validation.
3. **Assuming `prism register` is required.** It isn't. Skip it for local-only setups.
4. **Setting `PAPER_TRADING=false` without a wallet.** Live mode requires `WALLET_PRIVATE_KEY` in `.env`. Generate a keypair with `prism wallet generate` (saves to `~/.config/prism/wallet.json`) and copy the private key into `WALLET_PRIVATE_KEY=` in `.env`.
5. **Forgetting to export `PATH`.** After the one-liner install, `~/.local/bin` must be on `PATH` for the `prism` wrapper to be found.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `prism: command not found` | `~/.local/bin` not on PATH | `export PATH="$HOME/.local/bin:$PATH"` |
| `Bun not found` during install | Bun not installed | Installer auto-installs Bun; check `$HOME/.bun/bin` |
| `sqlite-vec` fails on Linux | Bundled SQLite lacks extensions | Engine falls back to system `libsqlite3.so` automatically (see `engine/db.ts`) |
| `BigInt` serialization error from embeddings | ONNX runtime issue in Node.js | Set `EMBEDDINGS_BACKEND=fallback` in `.env` (default) |
| Helius 401/403 | Invalid API key | Re-run `prism setup --non-interactive --helius-key=$NEW_KEY` |
| Engine starts but makes no decisions | Empty watchlist and `ENABLE_POOL_DISCOVERY=false` | Set `ENABLE_POOL_DISCOVERY=true` in `.env` |

## Verify Installation

```bash
prism --version       # should print 0.0.2 or later
prism dev &           # start engine in background
sleep 30
tail -n 20 logs/audit-trail.jsonl   # should show scan cycle decisions
```

## When Done

Stop the engine with Ctrl+C (or `pkill -f "bun.*prism"`). The agent's install root is `~/.prism` by default. To uninstall:

```bash
rm -rf ~/.prism ~/.local/bin/prism ~/.config/prism/agent-id ~/.config/prism/install-id ~/.config/prism/credentials.json ~/.config/prism/wallet.json
```

## See Also

- `dlmm-rebalancer` skill — strategy-level reasoning (HOLD/REBALANCE/EXIT/ENTER)
- `prism-rebalance` skill (planned, in `marketplaces/`) — trading operations
- `docs/agent-harness.md` — full agent integration guide
- `AGENTS.md` — repo notes for AI agents
