# Prism Environment Variables

All environment variables are optional; Prism uses conservative defaults for any
value not set in `.env`.

## Required

| Variable | Default | Description |
|----------|---------|-------------|
| `HELIUS_API_KEY` | — | Helius RPC/API key. Required for on-chain data. |
| `SOLANA_RPC_URL` | `https://mainnet.helius-rpc.com/?api-key=...` | Solana RPC endpoint. |

## Strategy

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPER_TRADING` | `true` | Simulated positions (`true`) or live on-chain (`false`). |
| `SCAN_INTERVAL_MS` | `600000` | Scan frequency in milliseconds (10 min). |
| `MIN_POOL_TVL_USD` | `50000` | Skip pools below this TVL. |
| `MIN_FEE_IL_RATIO` | `1.2` | Minimum fee/IL ratio to hold. |
| `TVL_DROP_EXIT_PCT` | `0.30` | TVL drop fraction that triggers EXIT. |
| `VOLUME_AUTH_THRESHOLD` | `0.70` | Minimum volume authenticity score. |
| `CONFIDENCE_THRESHOLD` | `0.65` | Minimum confidence to act. |
| `PAPER_PORTFOLIO_USD` | `10000` | Paper trading starting balance. |
| `MIN_BIN_UTILIZATION` | `0.30` | Minimum bin utilization. |
| `MAX_REBALANCE_RANGE_BINS` | `50` | Max rebalance range width. |
| `WATCHLIST_POOLS` | — | Comma-separated pool addresses. |
| `STOP_LOSS_PCT` | `0.15` | Stop-loss drawdown. |
| `TRAILING_STOP_PCT` | `0.10` | Trailing stop drawdown. |
| `OOR_GRACE_PERIOD_CYCLES` | `3` | Cycles before acting on OOR position. |
| `FEE_CLAIM_INTERVAL_MS` | `86400000` | Min interval between fee claims. |

## Agent runtime overlay

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTIC_MODE` | `false` | Enable agent runtime overlay. |
| `AGENT_RUNTIME` | `auto` | `auto`, `hermes`, `openclaw`, or `none`. |
| `AGENT_ACP_COMMAND` | `hermes` | Hermes binary for ACP. |
| `AGENT_ACP_ARGS` | `acp` | Arguments passed to ACP command. |
| `AGENT_GATEWAY_URL` | `ws://127.0.0.1:18789` | OpenClaw Gateway WebSocket URL. |
| `AGENT_GATEWAY_TOKEN` | — | Optional Gateway auth token. |
| `AGENT_PROMPT_TIMEOUT_MS` | `15000` | Prompt/check-in timeout. |
| `AGENT_CHECKIN_INTERVAL_MS` | `3600000` | Periodic check-in interval. |
| `AGENT_CHECKIN_ON_EVENTS` | `true` | Check-in on ENTER/EXIT/REBALANCE. |
| `AGENT_CHECKIN_INCLUDE_HISTORY` | `true` | Include recent decisions/warnings. |
| `AGENT_CHECKIN_MAX_POSITIONS` | `10` | Max positions in check-in summary. |
| `AGENT_OPENCLAW_WEBHOOK_URL` | — | OpenClaw webhook URL for alerts. |
| `AGENT_HERMES_API_URL` | — | Hermes HTTP API URL for alerts. |
| `AGENT_HTTP_PORT` | `18790` | Local HTTP status API port (`0` disables). |
| `AGENT_MCP_ENABLED` | `true` | Expose MCP tools over stdio. |

## Optional features

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_POOL_DISCOVERY` | `false` | Auto-discover pools when watchlist empty. |
| `ENABLE_SNAPSHOT_CAPTURE` | `false` | Dump pool snapshots to DB (paper only). |
| `AUTO_COMPOUND_FEES` | `false` | Reinvest accrued fees. |
| `AUTO_UPDATE` | `true` | Check for updates automatically. |
| `GITHUB_TOKEN` | — | For filing feedback issues. |

See `.env.example` in the repo for the full list.
