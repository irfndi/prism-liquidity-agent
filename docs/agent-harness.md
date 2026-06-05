# Agent Harness Integration

Prism is designed to be operated by AI agent harnesses (OpenClaw, Hermes, acpx, custom agents) as well as humans. The Cloudflare infrastructure is already deployed — agents only need to clone, register, and start the agent.

## Supported Agent Platforms

| Platform      | Status       | Integration         |
| ------------- | ------------ | ------------------- |
| OpenClaw      | ✅ Supported | Native CLI commands |
| Hermes        | ✅ Supported | Native CLI commands |
| acpx          | ✅ Supported | CLI wrapper         |
| Custom agents | ✅ Supported | HTTP API + CLI      |

## Skills (auto-discovered by agent harnesses)

Agent harnesses discover installation guides automatically when a skill file is placed in their skills directory. Prism ships copy-paste-ready skills for all four Markdown-based harnesses:

| Harness | Local install path | Skill file |
|---|---|---|
| OpenCode | `~/.config/opencode/skills/prism-install/SKILL.md` | [`../marketplaces/opencode/SKILL.md`](../marketplaces/opencode/SKILL.md) |
| OpenClaw | `~/.openclaw/skills/prism-install/SKILL.md` | [`../marketplaces/openclaw/SKILL.md`](../marketplaces/openclaw/SKILL.md) |
| Hermes | `~/.hermes/skills/software-development/prism-install/SKILL.md` | [`../marketplaces/hermes/SKILL.md`](../marketplaces/hermes/SKILL.md) |
| acpx / custom | `~/.agents/skills/prism-install.md` | [`../.agents/skills/prism-install.md`](../.agents/skills/prism-install.md) |

The project's own strategy skill ([`../.agents/skills/dlmm-rebalancer.md`](../.agents/skills/dlmm-rebalancer.md)) covers HOLD/REBALANCE/EXIT/ENTER reasoning and is usable from any harness.

For the full status of all 10 target marketplaces (including the 6 that still need code packages — MCP server, AutoGPT, LangChain, CrewAI, Dify, Flowise), see [`../marketplaces/README.md`](../marketplaces/README.md).

## Live Infrastructure (Already Deployed)

Agents do **not** need to deploy Cloudflare workers. They are already running:

| Resource     | URL / ID                                        |
| ------------ | ----------------------------------------------- |
| API Worker   | `https://prism-api.irfndi.workers.dev`          |
| Telegram Bot | `https://prism-telegram-bot.irfndi.workers.dev` |
| Bot username | `@prism_agent_bot`                              |

## Quick Start for Agents (3-layer approach)

Prism has 3 layers. Only the CLI is required. The API (cloud) and Telegram are
optional. See [`install.md`](install.md) for the full architecture explanation.

### Layer 1: CLI (Local) — Required

```bash
# Clone and install
git clone https://github.com/irfndi/prism-liquidity-agent.git
cd prism-liquidity-agent
bun install

# Setup (writes .env, no API call)
prism setup --non-interactive --helius-key=$HELIUS_KEY

# Start trading
prism dev
```

Validate: the agent starts scanning. Check `logs/audit-trail.jsonl` for decisions.

### Layer 2: API (Cloud) — Optional

Adds cloud account features (whoami, subscription, Telegram linking):

```bash
# Register with the cloud API
prism register

# Validate
prism whoami   # should show your user ID and tier
```

Skip this layer for local-only setups. The trading engine works fine without it.

### Layer 3: Telegram (Chat) — Optional

Adds Telegram-based monitoring. Requires the API layer first:

```bash
prism link-telegram   # generates a 6-char code
# User sends the code to @prism_agent_bot
```

### Common Mistakes

1. **Manually editing .env instead of using `prism setup`.** Postinstall writes a
   default `.env` and `prism setup` is the supported way to update it. Editing
   `.env` by hand works but skips validation.

2. **Running `bun run dev` instead of `prism dev`.** Both start the engine, but
   `prism dev` goes through the CLI layer and respects credentials, config paths,
   and update checks. `bun run dev` bypasses all of that. Always use `prism dev`.

3. **Assuming `prism register` is required.** It's not. The CLI works without a
   cloud account. Skip it for local-only setups.

4. **Expecting `LOG_LEVEL` to silence output.** The env var is loaded but never
   checked. All log levels write to the audit trail regardless.

## Agent-Driven Onboarding Paths

### Path A: Install first, link Telegram later

```bash
# Agent runs:
prism register
prism setup --non-interactive --helius-key=$HELIUS_KEY
prism link-telegram
# Returns: 6-char code (e.g., ABC123)

# Agent tells user:
# "Send code ABC123 to @prism_agent_bot on Telegram to link your account"
```

### Path B: Telegram first, install later

```bash
# User starts Telegram bot first:
# 1. User messages @prism_agent_bot
# 2. Bot replies: /register → returns API key

# Then agent runs:
prism setup --non-interactive --helius-key=$HELIUS_KEY
prism login $API_KEY_FROM_BOT
```

### Path C: Agent-driven full setup (most common)

```bash
# Agent runs (all non-interactive):
prism register
prism setup --non-interactive --helius-key=$HELIUS_KEY

# User then uses the CLI directly:
prism whoami  # see their account info
```

### Path D: CLI-only (no Telegram)

```bash
prism register
prism setup --non-interactive --helius-key=$HELIUS_KEY
prism wallet generate
prism dev
```

## HTTP API (for agents that prefer HTTP over CLI)

The Cloudflare API is the same one the CLI calls internally. Agents can call it directly:

```bash
# Register a new user
curl -X POST https://prism-api.irfndi.workers.dev/v1/register \
  -H "Content-Type: application/json" \
  -d '{"telegram_id": "123456", "first_name": "Test"}'
# Returns: { "user_id": "...", "api_key": "sk-prism-..." }

# Login (validate API key)
curl -X POST https://prism-api.irfndi.workers.dev/v1/login \
  -H "Authorization: Bearer sk-prism-xxx" \
  -H "Content-Type: application/json" \
  -d '{}'
# Returns: { "user_id": "...", "tier": "free" }

# Whoami
curl https://prism-api.irfndi.workers.dev/v1/whoami \
  -H "Authorization: Bearer sk-prism-xxx"
# Returns: { "user_id": "...", "telegram_id": "...", "tier": "free" }

# Link Telegram (generate 6-char code)
curl -X POST https://prism-api.irfndi.workers.dev/v1/link-telegram/start \
  -H "Authorization: Bearer sk-prism-xxx" \
  -H "Content-Type: application/json" \
  -d '{}'
# Returns: { "code": "ABC123", "expires_at": "..." }
```

## Environment for Agents

Agents should set these env vars before running prism commands:

```bash
export HELIUS_API_KEY="your-helius-key"          # REQUIRED
export WALLET_PRIVATE_KEY="..."                    # OPTIONAL (for live trading only)
```

The `prism register` command returns an API key that's stored locally in `~/.config/prism/credentials.json`. Subsequent commands (`prism whoami`, `prism wallet`, etc.) read it automatically.

## Skills Matrix

Prism works with the following OpenCode skills (for OpenCode-based agents):

| Skill               | Relevance | Use Case                             |
| ------------------- | --------- | ------------------------------------ |
| `git-master`        | 🔴 High   | Git operations on the repo           |
| `web-perf`          | 🟢 Low    | Performance analysis (rarely needed) |
| `security-research` | 🟢 Low    | Security audits (rarely needed)      |

Most Prism operations don't need special skills — the CLI is self-contained.

## acpx Integration

acpx (Agent Command Protocol eXtended) can wrap Prism CLI commands:

```yaml
# acpx.yaml
commands:
  prism-register:
    cmd: prism register
    description: Register with Prism and get an API key

  prism-setup:
    cmd: prism setup --non-interactive --helius-key={{helius_key}}
    description: Configure Prism with Helius API key
    args:
      helius_key:
        required: true

  prism-dev:
    cmd: prism dev
    description: Start paper trading agent

  prism-whoami:
    cmd: prism whoami
    description: Get current user account info

  prism-update:
    cmd: prism update
    description: Check for and apply updates
```

## Operator Runbook (for human operators, not agents)

### Daily Checks

```bash
# Check agent status
prism whoami

# View recent decisions
tail -f logs/audit-trail.jsonl
```

### Weekly Tasks

```bash
# Update watchlist
prism setup --watchlist "new-pool-1,new-pool-2"

# Run backtest to verify strategy
bun run backtest --days 7
```

### Monthly Tasks

```bash
# Renew subscription if needed
prism subscription renew --tier pro

# Update to latest version
prism update
```

## Troubleshooting

| Symptom                             | Cause               | Fix                                                     |
| ----------------------------------- | ------------------- | ------------------------------------------------------- |
| "Helius key invalid"                | Wrong API key       | Re-run `prism setup` with correct key                   |
| "No wallet configured"              | Missing private key | Add `WALLET_PRIVATE_KEY` to `.env` or use paper trading |
| "API key expired"                   | Session expired     | Re-run `prism register`                                 |
| "Pool not found"                    | Invalid watchlist   | Check pool addresses with `prism setup`                 |
| "401 Unauthorized" on Telegram link | User not registered | User runs `prism register` first                        |

## Reference

- Main README: [`../README.md`](../README.md)
- Install guide: [`install.md`](install.md)
- CLI reference: [`cli.md`](cli.md)
- Cron examples: [`cron-examples.md`](cron-examples.md)
- Cloudflare deploy (operators only): [`../cloudflare/README.md`](../cloudflare/README.md)
- AGENTS.md: [`../AGENTS.md`](../AGENTS.md)
