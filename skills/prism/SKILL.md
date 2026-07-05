---
name: prism
version: "0.0.22"
description: >
  Operate Prism, an autonomous Solana DLMM liquidity agent for Meteora pools.
  Use when the user asks about "prism", "DLMM", "liquidity agent",
  "Meteora pools", "rebalance positions", "paper trade Solana", or
  "start the trading agent".
license: MIT
author: irfndi
homepage: https://github.com/irfndi/prism-liquidity-agent
tags: [solana, defi, liquidity, meteora, dlmm, trading-agent]
compatibility: Requires Bun 1.4+, the `prism` CLI, and a Helius RPC key.
metadata:
  chain: solana
  protocol: meteora-dlmm
  openclaw:
    requires:
      bins: ["prism"]
    os: ["darwin", "linux"]
    capabilities:
      - mcp
      - http
  hermes:
    tags: [solana, defi, liquidity, trading]
    category: defi
    requires_toolsets: [terminal]
    blueprint:
      schedule: "0 * * * *"
      deliver: origin
      prompt: "Check Prism status and alert the user to any important positions, decisions, or risks. Use `prism status --message` and summarize in 3-5 bullets."
      no_agent: false
---

# Prism Liquidity Agent

Prism is an autonomous liquidity agent for Solana Meteora DLMM pools. It runs
locally, makes deterministic rebalancing decisions, and can optionally ask a
local agent runtime (Hermes via ACP or OpenClaw via Gateway) for a second opinion
when running as an agent skill.

## When to use

- User asks about liquidity pool management on Solana.
- User wants to check pool health or position performance.
- User needs to rebalance concentrated liquidity positions.
- User mentions Meteora DLMM, fee-IL ratio, volume authenticity, or bin arrays.
- User wants to start, stop, configure, or monitor the Prism trading agent.

## Quick start

```bash
# Install dependencies
bun install

# Configure (non-interactive)
prism setup --non-interactive --helius-key=$HELIUS_API_KEY

# Start paper trading (default)
prism dev

# Live trading (requires wallet)
export WALLET_PRIVATE_KEY=...
prism dev
```

## Common commands

| Command | Purpose |
|---------|---------|
| `prism status --json` | JSON snapshot for agents/skills |
| `prism status --message` | Markdown summary for messaging apps |
| `prism dev` | Start the trading agent |
| `prism backtest --days 7` | Run historical simulation |
| `prism backtest --source replay --days 7 --pools <addr>` | Replay on-chain snapshots |
| `prism wallet show` | Show wallet balance |
| `prism whoami` | Show account info |

## Decision flow

For each pool on each scan cycle:

1. Fetch pool state and bin array from Meteora via Helius RPC.
2. Compute metrics: fee/IL ratio, volume authenticity, bin utilization, TVL velocity.
3. Apply decision rules in order:
   - EXIT — TVL drop, stop-loss, trailing-stop, high volatility, low volume auth.
   - REBALANCE — drift > 60%, OOR grace expired, net benefit positive.
   - HOLD — existing position with healthy fee/IL ratio.
   - ENTER — new pool, strict thresholds (fee/IL > 1.8, auth > 0.8, util > 0.4).
4. Run risk gates: confidence, max positions, allocation cap, paper validation.
5. Execute in paper or live mode.

## Key metrics

- **feeIlRatio**: Fees earned vs impermanent loss. Target > 1.2 to hold, > 1.8 to enter.
- **volumeAuthenticity**: 0–1 score filtering wash-traded volume. Skip below 0.7.
- **binUtilization**: Active bins / total bins. Skip below 0.3.
- **tvlVelocity**: Recent TVL change. EXIT if drop exceeds 30%.

## Risk gates

- Confidence below `CONFIDENCE_THRESHOLD` (default 0.65) → reject.
- Max open positions reached → reject ENTER.
- Per-pool allocation > `MAX_PER_POOL_ALLOCATION_PCT` (default 40%) → cap.
- Portfolio drawdown > 10% → pause new entries.
- Stop-loss `STOP_LOSS_PCT` (default 15%) triggered → EXIT.
- Trailing stop `TRAILING_STOP_PCT` (default 10%) from peak → EXIT.

## Agent runtime integration

When Prism runs as a skill under an agent runtime, set `AGENTIVE_MODE=true`.
Prism will:

- Ask the agent runtime to review high-confidence decisions.
- Send periodic check-ins with open positions and portfolio summary.
- Call the agent immediately on ENTER, EXIT, or REBALANCE.

Supported runtimes:

- Hermes: `AGENT_RUNTIME=hermes` (ACP over stdio)
- OpenClaw: `AGENT_RUNTIME=openclaw` (Gateway WebSocket)
- Auto-detect: `AGENT_RUNTIME=auto` (default)

### Pull queries (MCP + HTTP)

When `AGENTIVE_MODE=true`, Prism exposes agent pull interfaces:

- **MCP server** (stdio): tools `prism_status`, `prism_positions`, `prism_decisions`, `prism_config`. Enable with `AGENT_MCP_ENABLED=true` (default).
- **HTTP fallback** on `127.0.0.1:AGENT_HTTP_PORT` (default `18790`): `GET /status`, `/positions`, `/decisions`, `/config`, `/health`. Set `AGENT_HTTP_PORT=0` to disable.

Agent runtimes can query these on demand instead of waiting for push check-ins.

### Runtime-specific skill variants

For tighter integration, install a runtime-specific variant:

- `skills/prism-openclaw/` — OpenClaw-compatible frontmatter, single-line JSON metadata, hourly check-in script.
- `skills/prism-hermes/` — Hermes-compatible frontmatter with `metadata.hermes.blueprint` for hourly scheduled checks.

The universal `skills/prism/` skill works for both but may not enable runtime-specific features like the Hermes blueprint scheduler.

### Messaging apps (Telegram, WhatsApp, Discord, Slack)

Prism does not send messages directly. The agent runtime owns the messaging channel and forwards Prism check-ins/alerts. Use `prism status --message` to get a short markdown summary formatted for messaging apps.

## Files

- [references/decision-rules.md](references/decision-rules.md) — Full decision logic.
- [references/meteora-dlmm.md](references/meteora-dlmm.md) — Meteora DLMM concepts.
- [references/env-vars.md](references/env-vars.md) — Environment variable reference.
- [references/agent-runtime.md](references/agent-runtime.md) — Agent runtime setup guide.
- [scripts/prism-status.sh](scripts/prism-status.sh) — Helper to fetch status JSON.
