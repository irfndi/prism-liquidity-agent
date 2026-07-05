---
name: prism-openclaw
version: "0.0.22"
description: >
  Operate Prism, an autonomous Solana DLMM liquidity agent for Meteora pools,
  through the OpenClaw Gateway. Use when the user asks about "prism", "DLMM",
  "liquidity agent", "Meteora pools", "rebalance positions", "paper trade Solana",
  or wants the agent to check/trade/manage Prism positions.
license: MIT
author: irfndi
homepage: https://github.com/irfndi/prism-liquidity-agent
tags: [solana, defi, liquidity, meteora, dlmm, trading-agent]
compatibility: Requires Bun 1.4+, the `prism` CLI, and a Helius RPC key.
user-invocable: true
metadata:
  openclaw:
    emoji: "🔺"
    requires:
      bins: ["prism"]
    os: ["darwin", "linux"]
    capabilities:
      - mcp
      - http
---

# Prism Liquidity Agent (OpenClaw)

Prism is an autonomous liquidity agent for Solana Meteora DLMM pools. This skill
lets OpenClaw query Prism, receive alerts, and remind the user to check positions.

## When to use

- User asks about liquidity pool management on Solana.
- User wants to start, stop, configure, or monitor the Prism trading agent.
- User says "check my Prism positions", "any alerts from Prism?", or "should I rebalance?"
- Prism sent an alert via the OpenClaw Gateway and the user replies for context.

## Quick start

```bash
# Configure (non-interactive)
prism setup --non-interactive --helius-key=$HELIUS_API_KEY

# Start with OpenClaw overlay enabled
export AGENTIVE_MODE=true
export AGENT_RUNTIME=openclaw
export AGENT_GATEWAY_URL=ws://127.0.0.1:18789
prism dev
```

## Regular checks

OpenClaw should remind the user every hour while Prism is running:

```bash
# Run from this skill's scripts folder
{baseDir}/scripts/prism-checkin.sh
```

This fetches a short markdown summary suitable for Telegram/Discord/Slack/WhatsApp.

## On-demand queries

| Query | Command |
|-------|---------|
| Full JSON status | `prism status --json` |
| Messaging summary | `{baseDir}/scripts/prism-checkin.sh` |
| Open positions | `curl -s http://127.0.0.1:18790/positions` |
| Recent decisions | `curl -s http://127.0.0.1:18790/decisions` |

## Decision flow

For each pool on each scan cycle:

1. Fetch pool state and bin array from Meteora via Helius RPC.
2. Compute metrics: fee/IL ratio, volume authenticity, bin utilization, TVL velocity.
3. Apply decision rules: EXIT → REBALANCE → HOLD → ENTER.
4. Run risk gates: confidence, max positions, allocation cap.
5. Execute in paper or live mode.

## Alert priorities

When Prism sends an alert through the Gateway, surface it according to priority:

- `critical` — immediate notification (stop-loss, TVL collapse).
- `warning` — batched or quiet notification (EXIT, volume auth drop).
- `info` — included in the next hourly summary (ENTER, REBALANCE).

## Files

- [references/agent-runtime.md](../prism/references/agent-runtime.md) — Full setup guide.
- [references/decision-rules.md](../prism/references/decision-rules.md) — Decision logic.
- [references/env-vars.md](../prism/references/env-vars.md) — Environment variables.
- [scripts/prism-checkin.sh](scripts/prism-checkin.sh) — Messaging-friendly summary.
