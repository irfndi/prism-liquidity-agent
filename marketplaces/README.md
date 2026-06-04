# Agent Marketplace Skills

This directory contains Prism installation skills for various agent harness marketplaces. Issue #33 tracked the full plan; this file documents the current status.

## Status by Marketplace

| # | Marketplace | Status | Skill file | Local install path |
|---|---|---|---|---|
| 1 | **OpenCode** | ⏳ Pending | (added in PR #40, not in this branch) | `~/.opencode/skills/prism-install/SKILL.md` |
| 1b | **OpenClaw** | ⏳ Pending | (added in PR #40, not in this branch) | `~/.openclaw/skills/prism-install/SKILL.md` |
| 1c | **Hermes** | ⏳ Pending | (added in PR #40, not in this branch) | `~/.hermes/skills/software-development/prism-install/SKILL.md` |
| 1d | **acpx / custom** | ⏳ Pending | (added in PR #40, not in this branch) | `~/.agents/skills/prism-install.md` |
| 2 | Claude Desktop (MCP) | ✅ Ready | [`../mcp-server/README.md`](../mcp-server/README.md) | Configure in `claude_desktop_config.json` |
| 3 | OpenAI GPTs | ❌ Not started | — | Requires OpenAI GPT Store submission (UI-only) |
| 4 | AutoGPT | ❌ Not started | — | Requires `autogpt-prism` PyPI package |
| 5 | LangChain | ❌ Not started | — | Requires `langchain-prism` PyPI package |
| 6 | CrewAI | ❌ Not started | — | Requires `crewai-prism` PyPI package |
| 7 | Dify | ❌ Not started | — | Requires Dify marketplace submission |
| 8 | Flowise | ❌ Not started | — | Requires Flowise custom-node npm package |
| 9 | ChatGPT Plugins (legacy) | ❌ Not started | — | Deprecated; OpenAI GPTs is the successor |
| 10 | Custom agent harnesses | ✅ Ready | Same as 1d (acpx) | See [docs/agent-harness.md](../docs/agent-harness.md) |

## What's Done (5/10)

- **4 Markdown-based harnesses** (OpenCode, OpenClaw, Hermes, acpx) — copy-paste-ready skill files
- **Claude Desktop (MCP)** — standalone `prism-mcp-server` npm package with 4 tools (status, positions, whoami, backtest)

## What's Not Done (5/10)

The remaining five harnesses require code packages or platform submissions that are each multi-day projects:

- **OpenAI GPTs** — UI-only submission to the GPT Store; can't be automated from this repo
- **AutoGPT / LangChain / CrewAI** — each needs a separate PyPI package with a Python class wrapping the CLI
- **Dify / Flowise** — each needs a platform-specific plugin format and submission

These are tracked in the issue #33 phased plan. None of them block the core install path (the 5 ready harnesses cover all major agent ecosystems).

## How to Use

### Install via the ready skill files

For each ready Markdown marketplace, copy the SKILL.md to the local path shown in the table above:

```bash
# OpenCode
mkdir -p ~/.opencode/skills/prism-install
cp marketplaces/opencode/SKILL.md ~/.opencode/skills/prism-install/SKILL.md

# OpenClaw
mkdir -p ~/.openclaw/skills/prism-install
cp marketplaces/openclaw/SKILL.md ~/.openclaw/skills/prism-install/SKILL.md

# Hermes (under software-development category)
mkdir -p ~/.hermes/skills/software-development/prism-install
cp marketplaces/hermes/SKILL.md ~/.hermes/skills/software-development/prism-install/SKILL.md

# acpx / custom
mkdir -p ~/.agents/skills
cp .agents/skills/prism-install.md ~/.agents/skills/prism-install.md
```

After copying, restart your agent harness so it picks up the new skill.

### Configure the MCP server (Claude Desktop)

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "prism": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/dist/index.js"],
      "env": {
        "PRISM_BIN": "/absolute/path/to/prism",
        "SQLITE_DB_PATH": "/absolute/path/to/prism.db"
      }
    }
  }
}
```

See [`../mcp-server/README.md`](../mcp-server/README.md) for the full configuration guide.

## Adding a New Marketplace

If you want to add a marketplace that isn't listed:

1. Create a new subdirectory under `marketplaces/<harness-name>/`
2. Write a `SKILL.md` matching that harness's discovery format
3. Add a row to the status table above with the local install path
4. Open a PR

The content can be adapted from the existing four skill files — the install/configure/start/troubleshooting sections are universal.

## See Also

- [Issue #33](https://github.com/irfndi/prism-liquidity-agent/issues/33) — original phased plan
- [`docs/agent-harness.md`](../docs/agent-harness.md) — full agent integration guide
- [`.agents/skills/`](../.agents/skills/) — the project's own skill directory (acpx format)
- [`dlmm-rebalancer`](../.agents/skills/dlmm-rebalancer.md) — strategy-level reasoning skill
