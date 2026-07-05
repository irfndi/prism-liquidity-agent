# NousResearch Hermes Agent — Architecture & Integration Research

> Research date: 2026-07-03 | Source: GitHub (NousResearch/hermes-agent, 208k+ ⭐), official docs (hermes-agent.nousresearch.com), agentskills.io spec

---

## 1. Core Architecture

### Overview

Hermes Agent is a Python-based autonomous AI agent with a synchronous core loop (`AIAgent` in `run_agent.py`) and multiple entry points. It's the only agent with a built-in self-improvement loop — creates skills from experience, improves them during use, and builds a deepening user model across sessions.

### Entry Points

```text
┌─────────────────────────────────────────────────────────────────────┐
│                        Entry Points                                  │
│                                                                      │
│  CLI (cli.py)    Gateway (gateway/run.py)    ACP (acp_adapter/)     │
│  Batch Runner    API Server                  Python Library          │
└──────────┬──────────────┬───────────────────────┬───────────────────┘
           │              │                       │
           ▼              ▼                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     AIAgent (run_agent.py)                          │
│                                                                     │
│  Prompt Builder  │  Provider Resolution  │  Tool Dispatch           │
│  (prompt_builder)│  (runtime_provider)   │  (model_tools)           │
│                  │                       │  70+ tools, 28 toolsets  │
│  Compression &   │  3 API Modes          │  Tool Registry           │
│  Caching         │  chat_completions     │  (registry.py)           │
│                  │  codex_responses      │                          │
│                  │  anthropic_messages   │                          │
└─────────┴─────────────────┴─────────────────┴───────────────────────┘
           │                                    │
           ▼                                    ▼
┌───────────────────┐              ┌──────────────────────┐
│ Session Storage   │              │ Tool Backends         │
│ (SQLite + FTS5)   │              │ Terminal (6 backends) │
│ hermes_state.py   │              │ Browser (5 backends)  │
│ gateway/session.py│              │ Web (4 backends)      │
└───────────────────┘              │ MCP (dynamic)         │
                                   │ File, Vision, etc.    │
                                   └──────────────────────┘
```

**Source:** [Architecture docs](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)

### Key Subsystems

| Subsystem | Location | Purpose |
|-----------|----------|---------|
| **Agent Loop** | `run_agent.py` | Core conversation loop — provider selection, prompt construction, tool execution, retries, fallback, compression, persistence |
| **Prompt System** | `agent/prompt_builder.py` | Assembles ordered system-prompt tiers: stable → context → volatile |
| **Provider Resolution** | `hermes_cli/runtime_provider.py` | Maps `(provider, model)` → `(api_mode, api_key, base_url)`. 18+ providers. |
| **Tool System** | `tools/registry.py` + `tools/*.py` | 70+ tools, 28 toolsets. Self-registering at import time. |
| **Session Storage** | `hermes_state.py` | SQLite + FTS5. Sessions have lineage tracking, per-platform isolation. |
| **Messaging Gateway** | `gateway/run.py` | 20+ platform adapters, unified session routing, cron ticking, hooks. |
| **ACP Integration** | `acp_adapter/` | Editor-native agent over stdio/JSON-RPC for VS Code, Zed, JetBrains. |
| **Cron Scheduler** | `cron/scheduler.py` | Job scheduling with cross-platform delivery. Ticks every 60s. |
| **Plugin System** | `hermes_cli/plugins.py` | User plugins (`~/.hermes/plugins/`), project plugins, pip entry points. |
| **Skill System** | `tools/skills_tool.py`, `tools/skill_manager_tool.py` | SKILL.md-based procedural knowledge with progressive disclosure. |

### How External Apps Connect to Hermes

Hermes ships **three protocols** for external integration, all driving the same `AIAgent` core:

| Protocol | Transport | Best for |
|----------|-----------|----------|
| **ACP** | JSON-RPC over stdio | IDE clients (VS Code, Zed, JetBrains) |
| **TUI Gateway** | JSON-RPC over stdio or WebSocket | Custom hosts wanting fine-grained control |
| **API Server** | HTTP + Server-Sent Events | OpenAI-compatible frontends, curl, CI pipelines |

**Source:** [Programmatic Integration docs](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)

Additionally, **Python in-process embedding** is supported by importing `run_agent.AIAgent` directly.

---

## 2. ACP (Agent Client Protocol) Details

### What is ACP?

ACP is an **open standard** (Apache 2.0, by Zed Industries) that standardizes communication between code editors/IDEs and AI agents — analogous to what LSP did for language servers. Hermes implements the **agent-side** of ACP.

**Source:** [ACP Editor Integration](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp), [Issue #569](https://github.com/NousResearch/hermes-agent/issues/569)

### Protocol Flow

ACP uses **JSON-RPC 2.0 over stdio** (newline-delimited JSON). The editor spawns the agent as a subprocess:

```text
1. initialize      — Negotiate protocol version & capabilities
2. session/new     — Create a new conversation (receives CWD, MCP configs)
3. session/prompt  — Client sends user message as ContentBlock[] (text, image, audio)
4. Agent streams   — session/update notifications (message chunks, tool calls, plans)
5. Agent callbacks — Client for file ops (fs/read_text_file, fs/write_text_file),
                     terminal access (terminal/create), permission requests
6. Turn ends       — session/prompt response + stop reason
                    (end_turn, max_tokens, refusal, cancelled)
```

### ACP Capabilities Exposed by Hermes

- Session creation, prompt submission, streaming agent message chunks
- Tool-call events, permission requests
- Session fork (deep-copy history into new session), cancel, authentication
- Tool output rendered into ACP `Diff`/`ToolCall` content blocks
- Editor CWD binding (file/terminal tools operate relative to editor workspace)

### ACP Toolset (`hermes-acp`)

ACP mode uses a curated toolset:
- **File tools:** `read_file`, `write_file`, `patch`, `search_files`
- **Terminal tools:** `terminal`, `process`
- **Web/browser tools**
- **Memory, todo, session search**
- **Skills** (full skill system available)
- **`execute_code`** and **`delegate_task`**
- **Vision**

### ACP Permission Model

| Permission | Behavior | Persisted? |
|------------|----------|------------|
| `allow_once` | This one tool call | No |
| `allow_session` | All matching calls in current ACP session | No — cleared when session ends |
| `allow_always` | All future sessions | Yes — written to permanent allowlist |
| `deny` | This one tool call | No |

### ACP Adapter File Structure

```text
acp_adapter/
├── entry.py        # Entry point for `hermes acp`
├── server.py       # HermesACPAgent — JSON-RPC handler
├── session.py      # Live ACP session tracking
├── events.py       # AIAgent callbacks → ACP session_update events
├── permissions.py  # Terminal approval → ACP permission requests
├── tools.py        # Hermes tools → ACP tool kinds mapping
└── auth.py         # Reuses Hermes' runtime provider auth
```

### Session Lifecycle

```text
new_session(cwd)
  → create SessionState
  → create AIAgent(platform="acp", enabled_toolsets=["hermes-acp"])
  → bind task_id/session_id to cwd override

prompt(..., session_id)
  → extract text from ACP content blocks
  → reset cancel event
  → install callbacks + approval bridge
  → run AIAgent in ThreadPoolExecutor
  → update session history
  → emit final agent message chunk
```

**Source:** [ACP Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/acp-internals)

---

## 3. Skill Format Specification

### agentskills.io Standard

Hermes aligns with the **[agentskills.io](https://agentskills.io/specification)** open standard for skill format. Skills are portable across compatible agents.

### Directory Structure

```text
~/.hermes/skills/                  # Single source of truth
├── mlops/                         # Category directory
│   ├── axolotl/
│   │   ├── SKILL.md               # Main instructions (REQUIRED)
│   │   ├── references/            # Additional docs
│   │   ├── templates/             # Output formats
│   │   ├── scripts/               # Helper scripts callable from the skill
│   │   └── assets/                # Supplementary files
│   └── vllm/
│       └── SKILL.md
├── devops/
│   └── deploy-k8s/                # Agent-created skill
│       ├── SKILL.md
│       └── references/
├── .hub/                          # Skills Hub state
│   ├── lock.json
│   ├── quarantine/
│   └── audit.log
└── .bundled_manifest              # Tracks seeded bundled skills
```

### SKILL.md Frontmatter

```yaml
---
name: my-skill                        # REQUIRED · lowercase, hyphens, ≤64 chars
description: One clear sentence on     # REQUIRED · ≤1024 chars · "Use when..."
  what this does and when to use it.
version: 1.0.0                        # Optional · semver
author: Your Name                     # Optional
license: MIT                          # Optional
platforms: [macos, linux, windows]    # Optional · restrict to OS
required_environment_variables:       # Optional · env vars needed
  - name: MY_API_KEY
    prompt: "Enter your API key"
    help: "Get one at https://example.com"
    required_for: "API access"
required_credential_files:            # Optional · OAuth tokens, service accounts
  - path: google_token.json
    description: "Google OAuth2 token"
metadata:
  hermes:
    tags: [Category, Keyword]         # Helps discovery
    related_skills: [other-skill]     # Pairs well with
    requires_toolsets: [web]          # Only show when toolset active
    requires_tools: [web_search]      # Only show when tool available
    fallback_for_toolsets: [browser]  # Hide when toolset available
    fallback_for_tools: [navigate]    # Hide when tool available
    config:                           # Non-secret preferences
      - key: my.setting
        description: "What this controls"
        default: "value"
        prompt: "Prompt for setup"
    blueprint:                        # Marks skill as runnable automation
      schedule: "0 9 * * *"          # Cron expr / "every 2h" / ISO
      deliver: origin                 # Delivery target
      prompt: "Task instruction"      # Instruction for each run
      no_agent: false                 # Skip LLM if true
---
```

### SKILL.md Body Structure (Recommended)

```markdown
# Skill Title

## Overview
What and why.

## When to Use
- Bulleted triggers
- "Don't use for:" counter-triggers

## Quick Reference
Tables of common commands or API calls.

## Procedure
Step-by-step instructions the agent follows.

## Common Pitfalls
Known failure modes and fixes.

## Verification Checklist
- [ ] Checkbox list of post-action verifications
```

### Constraints

| Constraint | Value |
|------------|-------|
| Name format | `[a-z0-9][a-z0-9._-]*`, max 64 chars |
| Description length | ≤1024 chars |
| Max file size | ~100,000 chars (aim for 8-15k) |
| Max body lines | ~500 lines (split to `references/` if longer) |
| Required files | Only `SKILL.md` |
| Allowed subdirs | `references/`, `templates/`, `scripts/`, `assets/` |

### Progressive Disclosure (Token Efficiency)

```text
Level 0: skills_list()           → [{name, description, category}]   (~3k tokens)
Level 1: skill_view(name)        → Full SKILL.md content + metadata  (varies)
Level 2: skill_view(name, path)  → Specific reference file            (varies)
```

Skills don't cost tokens until actually used. The index is injected into the system prompt once per session.

### Template Variables

Hermes expands these in SKILL.md body at load time:
- `${HERMES_SKILL_DIR}` — absolute path to the skill's directory

---

## 4. Messaging & Event Integration

### Gateway Architecture

The gateway is a **single long-running background process** that connects to 20+ platforms simultaneously:

```text
Platform Adapters → Session Store (per-chat) → AIAgent → Response
                         ↑
                    Cron Scheduler (ticks every 60s)
```

**Supported platforms:** Telegram, Discord, Slack, WhatsApp, Signal, SMS, Email, Home Assistant, Mattermost, Matrix, DingTalk, Feishu/Lark, WeCom, Weixin, BlueBubbles (iMessage), QQ, Yuanbao, Microsoft Teams, LINE, ntfy, Webhooks, OpenAI-compatible API server.

**Source:** [Messaging Gateway docs](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/)

### Message Flow

```text
Platform event → Adapter.on_message() → MessageEvent
  → GatewayRunner._handle_message()
    → authorize user
    → resolve session key
    → create AIAgent with session history
    → AIAgent.run_conversation()
    → deliver response back through adapter
```

### Cron System

The cron scheduler provides scheduled task execution with cross-platform delivery:

| Feature | Details |
|---------|---------|
| **Schedule formats** | Cron expressions, "every Nh/Nm", ISO timestamps, one-shot delays |
| **Delivery targets** | Any platform: `telegram`, `discord`, `slack`, `telegram:<chat_id>`, `slack:#channel`, `local` |
| **Script-only mode** | `no_agent=True` — runs script without LLM, pipes stdout to delivery target |
| **Skill attachment** | Cron jobs can inject skills as context |
| **Fresh sessions** | Each cron run gets a fresh agent session with no prior history |

**Source:** [Cron Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/cron-internals), [Automate with Cron](https://hermes-agent.nousresearch.com/docs/guides/automate-with-cron)

### Cron Delivery Examples

```bash
# Telegram topic
--deliver telegram:-1001234567890:17585

# Discord channel
--deliver discord:#engineering

# Slack channel
--deliver slack:#builds

# Script-only (no LLM)
hermes cronjob create --schedule "every 5m" --script watchdog.sh --no-agent --deliver telegram
```

### `hermes send` — Pipe Notifications Anywhere

```bash
hermes send --to telegram "deploy finished"
echo "RAM 92%" | hermes send --to telegram:-1001234567890
hermes send --to discord:#ops --file /tmp/report.md
make | hermes send --to slack:#builds
```

No running gateway required for bot-token platforms — `hermes send` calls REST endpoints directly using stored credentials.

### Gateway Hooks

The gateway has a hook system (`gateway/hooks.py`) for lifecycle events:
- Hook discovery and loading from `gateway/builtin_hooks/`
- Lifecycle event dispatch
- Extension point for custom behavior

---

## 5. Skill Discovery & Invocation

### Discovery Pipeline

```text
On disk:
  ~/.hermes/skills/**/SKILL.md     (local)
  skills.external_dirs              (config-defined external dirs)
  ~/.hermes/skill-bundles/*.yaml    (bundles)

Discovery:
  scan_skill_commands()             → slash command registration
  build_skills_system_prompt()      → system prompt catalog
  _find_all_skills()                → tool-accessible index

Exposure to agent:
  System prompt: name + description index  (~3k tokens)
  skills_list / skill_view / skill_manage  (tools)
  /skill-name slash commands               (user-facing)

Activation:
  User: /skill-name slash command or bundle preload
  Agent: reads index, calls skill_view(name)
  CLI: --skill flag → system prompt chunk

Execution:
  Agent loop follows SKILL.md instructions
  Uses terminal / other tools per skill prose
```

### Activation Methods

| Method | How it works |
|--------|-------------|
| **Model-driven** | Agent reads `<available_skills>` index in system prompt, calls `skill_view(name)` when relevant |
| **Slash command** | User types `/skill-name` → injected as user message |
| **Bundle preload** | Skill bundle YAML pre-loads specific skills at session start |
| **CLI flag** | `hermes --skill name` → injected into system prompt |
| **Natural language** | User asks Hermes to use a skill → agent loads via `skill_view` |

### Conditional Skill Activation

Skills can declare dependencies to control visibility:

```yaml
metadata:
  hermes:
    requires_toolsets: [web]           # Hidden if web toolset NOT active
    requires_tools: [web_search]       # Hidden if web_search NOT available
    fallback_for_toolsets: [browser]   # Hidden if browser toolset IS active
    fallback_for_tools: [navigate]     # Hidden if browser_navigate IS available
```

### Agent-Managed Skills (`skill_manage` tool)

The agent can create, update, and delete skills autonomously:

| Action | Use for |
|--------|---------|
| `create` | New skill from scratch |
| `patch` | Targeted text replacement (preferred for updates) |
| `edit` | Major structural rewrites (full SKILL.md replacement) |
| `delete` | Remove a skill |
| `write_file` | Add/update supporting files (references/, scripts/, etc.) |
| `remove_file` | Remove a supporting file |

**Write approval gating:** When `skills.write_approval: true`, all skill writes are staged under `~/.hermes/pending/skills/` and require human approval before committing.

### External Skill Directories

Config option `skills.external_dirs` lets Hermes scan additional directories:

```yaml
skills:
  external_dirs:
    - /path/to/shared/skills
    - ${MY_SKILLS_PATH}
```

- Read-only: external dirs are scanned for discovery only; `skill_manage` always writes to `~/.hermes/skills/`
- Local precedence: same skill name in local and external dirs → local wins
- Security: configured external dirs are trusted; unknown paths trigger warnings

### Skills Hub

- **agentskills.io** — open standard and community hub for sharing skills
- Hermes ships bundled skills (always available) and optional skills (install explicitly)
- `.hub/` directory tracks installed skills with lock files and audit logs

---

## 6. Examples of Skills/Apps Sending Check-ins or Receiving Events

### Cron Job as Check-in (Skill Example)

Hermes' blueprint metadata enables skills to be scheduled automations:

```yaml
---
name: daily-market-check
description: "Check Meteora DLMM pool health and report anomalies."
metadata:
  hermes:
    tags: [defi, monitoring, meteora]
    blueprint:
      schedule: "0 9 * * *"
      deliver: telegram
      prompt: "Scan watchlist pools, compare TVL/volume to yesterday, alert on anomalies."
      no_agent: false
---
```

### Script-Only Monitoring (No LLM)

```bash
#!/usr/bin/env bash
# watchdog.sh — runs every 5m, silent if OK
result=$(curl -s https://prism-api.irfndi.workers.dev/health)
if echo "$result" | jq -e '.status != "ok"' > /dev/null 2>&1; then
  echo "⚠️ Prism API health check failed: $result"
fi
```

Scheduled via:
```bash
hermes cronjob create --schedule "every 5m" \
  --script watchdog.sh --no-agent --deliver telegram
```

### External Event → Hermes (Webhook)

The gateway supports a **webhook adapter** (`gateway/platforms/webhook.py`). External systems can POST events to the gateway, which routes them through the session store to the agent.

### `hermes send` for One-shot Notifications

From any script (CI, deploy, monitoring):
```bash
echo "Deploy v2.1.3 complete" | hermes send --to slack:#deployments
hermes send --to telegram "Pool SOL/USDC entered out-of-range"
```

---

## 7. Recommended Prism Integration Approach

### Option A: Hermes Skill for Prism (Recommended)

Create a Hermes skill that wraps Prism's trading agent functionality:

```text
~/.hermes/skills/defi/prism-dlmm/
├── SKILL.md
├── references/
│   ├── architecture.md       # Prism architecture overview
│   └── env-vars.md           # Configuration reference
└── scripts/
    └── prism-status.sh       # Quick status check script
```

**SKILL.md sketch:**

```yaml
---
name: prism-dlmm
description: "Manage Prism liquidity agent — scan pools, check positions, trigger rebalances, review audit logs. Use when the user mentions DLMM, Meteora, liquidity positions, or Prism trading."
version: 1.0.0
author: Prism Team
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [defi, meteora, dlmm, liquidity, trading]
    related_skills: [hermes-agent]
    requires_tools: [terminal]
required_environment_variables:
  - name: HELIUS_API_KEY
    prompt: "Helius API key for Solana RPC"
    help: "Get one at https://helius.dev"
    required_for: "Pool state fetching"
  - name: WALLET_PRIVATE_KEY
    prompt: "Solana wallet private key (optional, paper trading works without it)"
    help: "Only needed for live trading"
    required_for: "Live execution"
---
```

**Why this works:**
- Hermes agents can invoke Prism via terminal tools (CLI commands)
- Cron jobs can run periodic health checks with cross-platform delivery
- Skills are self-documenting and discoverable
- No protocol changes needed — Hermes calls Prism's CLI

### Option B: Hermes Gateway + Prism Telegram Bot

If Prism already has a Telegram bot (`@prism_agent_bot`), run both Hermes and Prism gateways:

1. Hermes gateway → user interactions, cron scheduling, skill management
2. Prism Telegram bot → trading-specific commands
3. Hermes cron jobs call `hermes send --to telegram` for check-in delivery

### Option C: ACP Integration for IDE-Based Monitoring

For developers who want to monitor Prism from their editor:

1. Run `hermes acp` in the Prism project directory
2. IDE (VS Code/Zed) connects via ACP
3. Agent has access to Prism codebase, logs, and terminal
4. Ask questions like "check pool health", "why did this rebalance fail"

### Option D: API Server for Dashboards

Run Hermes' OpenAI-compatible API server:

```bash
hermes gateway start --platform api_server
```

Then build a web dashboard that sends prompts to Hermes, which has Prism context via skills.

### Integration Matrix

| Approach | Effort | Real-time | Cron | Multi-platform | Code Context |
|----------|--------|-----------|------|----------------|--------------|
| **A: Hermes Skill** | Low | Via terminal | ✅ | ✅ (via cron delivery) | ✅ |
| **B: Dual Gateway** | Medium | ✅ | ✅ | ✅ | Limited |
| **C: ACP** | Low | ✅ | ❌ | ❌ (editor only) | ✅ |
| **D: API Server** | Medium | ✅ | ❌ | Via frontend | ✅ |

### Recommended Path

**Start with Option A** (Hermes Skill) because:
1. Zero protocol changes — Hermes calls Prism CLI via terminal tools
2. Cron jobs enable automated monitoring with delivery to any platform
3. Skills are portable (agentskills.io standard) and discoverable
4. Agent can create/update skills autonomously based on experience
5. Progressive disclosure keeps token costs low
6. External skill directories let Prism ship skills alongside the engine

The skill can later evolve to Option B (dual gateway) if real-time bidirectional communication is needed.

---

## References

- [Hermes Architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)
- [Programmatic Integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)
- [ACP Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/acp-internals)
- [ACP Editor Integration](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp)
- [Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
- [Creating Skills](https://hermes-agent.nousresearch.com/docs/developer-guide/creating-skills)
- [Messaging Gateway](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/)
- [Cron Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/cron-internals)
- [Automate with Cron](https://hermes-agent.nousresearch.com/docs/guides/automate-with-cron)
- [agentskills.io Specification](https://agentskills.io/specification)
- [GitHub Repository](https://github.com/NousResearch/hermes-agent)
