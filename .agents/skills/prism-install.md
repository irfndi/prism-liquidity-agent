# Prism Install Skill

Use this skill when an agent needs to install, configure, or run the Prism liquidity agent for automated Meteora DLMM rebalancing on Solana.

## When to Activate

- User asks to install a Solana liquidity agent, trading bot, or DLMM rebalancer
- User wants to automate Meteora DLMM pool positions
- User wants to earn fees from concentrated-liquidity pools without manual management
- User mentions `prism`, `prism-liquidity-agent`, or `@irfndi/prism-liquidity-agent`

## Three Layers (CLI boundary plus required account)

Prism is designed in three layers. The CLI is the operating boundary, and a
registered API account is required before setup or agent execution. Telegram is optional.

| Layer | Purpose | Required? |
|---|---|---|
| CLI (local) | Runs the trading engine, reads `.env`, persists positions to SQLite | **Yes** |
| API (cloud) | Account, telemetry, errors, feedback, whoami, subscription | **Yes for agents** |
| Telegram (chat) | Monitor and control the agent from `@prism_agent_bot` | No |

`prism register` must complete before `prism setup` or `prism dev` so usage and
error telemetry have an owner.

## Install

The one-liner installer handles Bun (installs if missing), detects your OS/architecture, downloads a compiled bundle from Cloudflare R2, verifies its SHA-256 checksum, extracts it to `~/.prism`, and writes a `prism` wrapper to `~/.local/bin/`.

```bash
curl -fsSL https://raw.githubusercontent.com/irfndi/prism-liquidity-agent/main/scripts/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
```

## Agent Operating Contract

Use the installed `prism` wrapper as the product boundary. It is the supported global install: the release installer writes a checksum-verified platform bundle under `~/.prism` and the wrapper under `~/.local/bin/prism`.

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

Use `prism update --check-only` and `prism update` for upgrades. Do not edit the Prism checkout, run `bun run dev`, or run `bun install` while operating an installed agent. Those commands are for Prism development only.

`bun add --global prism` is not supported because Prism is not published as an npm package named `prism`. `bun add --global github:irfndi/prism-liquidity-agent#<release-tag>` is a source fallback, not the production install path.

## Configure

Non-interactive (for agents and CI):

```bash
prism setup --non-interactive --rpc-url="$SOLANA_RPC_URL" --rpc-fallback-url="${SOLANA_RPC_FALLBACK_URL:-}"
```

If you don't know which pools to watch, also set `ENABLE_POOL_DISCOVERY=true` in `.env` so the agent can find candidates on its own.

Interactive (for humans):

```bash
prism setup
```

This writes `.env` with the RPC provider settings, an optional watchlist, and paper-trading defaults. The default mode is **paper trading** — no real funds are at risk.

## Start Trading

```bash
prism dev
```

This spawns the engine. Decisions are logged to `logs/audit-trail.jsonl`. To stop, send SIGINT (Ctrl+C).

## Common Commands

| Command | Purpose |
|---|---|
| `prism whoami` | Show cloud account info (requires `prism register`) |
| `prism register` | Create the required cloud account and store an API key |
| `prism doctor [--fix]` | Validate registration, providers, and local state |
| `prism setup` | Interactive `.env` wizard |
| `prism dev` | Start the trading engine |
| `prism backtest` | Run a historical simulation (synthetic or replay from snapshots) |
| `prism update` | Check for and apply updates from R2/GitHub releases |
| `prism wallet {generate,import,show}` | Manage the local Solana keypair (required for live trading) |
| `prism link-telegram` | Link the cloud account to `@prism_agent_bot` |

## Common Mistakes

1. **Running `bun run dev` instead of `prism dev`.** Both start the engine, but `prism dev` goes through the CLI wrapper that resolves the install root and respects config. `bun run dev` bypasses that and may write `.env` to the wrong directory.
2. **Manually editing `.env`.** Use `prism setup` to update config. Hand-edits work but skip validation.
3. **Skipping `prism register`.** Registration is required before setup and dev.
4. **Setting `PAPER_TRADING=false` without a wallet.** Live mode requires `WALLET_PRIVATE_KEY` in `.env`. Generate a keypair with `prism wallet generate` (saves to `~/.config/prism/wallet.json`) and copy the private key into `WALLET_PRIVATE_KEY=` in `.env`.
5. **Forgetting to export `PATH`.** After the one-liner install, `~/.local/bin` must be on `PATH` for the `prism` wrapper to be found.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `prism: command not found` | `~/.local/bin` not on PATH | `export PATH="$HOME/.local/bin:$PATH"` |
| `Bun not found` during install | Bun not installed | Installer auto-installs Bun; check `$HOME/.bun/bin` |
| `sqlite-vec` fails on Linux | Bundled SQLite lacks extensions | Engine falls back to system `libsqlite3.so` automatically (see `engine/db.ts`) |
| `BigInt` serialization error from embeddings | ONNX runtime issue in Node.js | Set `EMBEDDINGS_BACKEND=fallback` in `.env` (default) |
| Helius 401/403 | Invalid API key | Re-run `prism setup` with a valid key or custom RPC URL |
| Engine starts but makes no decisions | Empty watchlist and `ENABLE_POOL_DISCOVERY=false` | Set `ENABLE_POOL_DISCOVERY=true` in `.env` |

## Verify Installation

```bash
prism --version       # should print 0.0.8 or later
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
