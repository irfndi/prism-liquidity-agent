# Agent Harness Integration

Prism is designed to be operated by AI agents (OpenClaw, Hermes, etc.) as well as humans.

## Supported Agent Platforms

| Platform | Status | Integration |
|----------|--------|-------------|
| OpenClaw | ✅ Supported | Native CLI commands |
| Hermes | ✅ Supported | Native CLI commands |
| acpx | ✅ Supported | CLI wrapper |
| Custom agents | ✅ Supported | HTTP API + CLI |

## Quick Start for Agents

```bash
# 1. Install Prism
bun install

# 2. Register (non-interactive)
prism register

# 3. Setup (non-interactive)
prism setup --non-interactive --helius-key=$HELIUS_API_KEY

# 4. Start trading
prism dev
```

## Skills Matrix

Prism works with the following OpenCode skills:

| Skill | Relevance | Use Case |
|-------|-----------|----------|
| `cloudflare` | 🔴 High | Cloudflare Workers deployment |
| `workers-best-practices` | 🔴 High | Workers code review |
| `wrangler` | 🔴 High | Wrangler CLI operations |
| `durable-objects` | 🟡 Medium | Stateful coordination (future) |
| `agents-sdk` | 🟡 Medium | Agent SDK integration (future) |
| `security-research` | 🟢 Low | Security audits |
| `web-perf` | 🟢 Low | Performance optimization |

## Agent-Driven Onboarding

Agents can set up Prism for users via the CLI:

```bash
# Agent runs:
prism register
prism setup --non-interactive --helius-key=$HELIUS_API_KEY
prism link-telegram

# Agent tells user:
# "Send code LINK-AB12CD to @prism_dlmm_bot to link Telegram"
```

## HTTP API

For programmatic access, use the Cloudflare Worker API:

```bash
# Register
curl -X POST https://prism-worker.your-account.workers.dev/v1/register \
  -H "Content-Type: application/json" \
  -d '{"telegram_id": "123456"}'

# Login
curl -X POST https://prism-worker.your-account.workers.dev/v1/login \
  -H "Authorization: Bearer $API_KEY"

# Whoami
curl https://prism-worker.your-account.workers.dev/v1/whoami \
  -H "Authorization: Bearer $API_KEY"
```

## Environment for Agents

Agents should set these env vars:

```bash
export HELIUS_API_KEY="your-helius-key"
export PRISM_API_KEY="your-prism-api-key"
```

## Operator Runbook

### Daily Checks

```bash
# Check agent status
prism whoami

# Check subscription
prism subscription status

# View recent decisions
tail -f logs/audit-trail.jsonl
```

### Weekly Tasks

```bash
# Review performance
prism subscription status

# Check for fee claims
# (automated in Issue #4)

# Update watchlist if needed
prism setup --watchlist "new-pool-1,new-pool-2"
```

### Monthly Tasks

```bash
# Renew subscription if needed
prism subscription renew --tier pro

# Review and rotate API keys
prism register  # generates new key
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Helius key invalid" | Wrong API key | Re-run `prism setup` |
| "No wallet configured" | Missing private key | Add wallet or use paper trading |
| "API key expired" | Session expired | Re-run `prism register` |
| "Pool not found" | Invalid watchlist | Check pool addresses |

## acpx Integration

acpx (Agent Command Protocol eXtended) can wrap Prism CLI commands:

```yaml
# acpx.yaml
commands:
  prism-register:
    cmd: prism register
    description: Register with Prism
  
  prism-setup:
    cmd: prism setup --non-interactive --helius-key={{helius_key}}
    description: Configure Prism
    args:
      helius_key:
        required: true
  
  prism-dev:
    cmd: prism dev
    description: Start trading agent
```
