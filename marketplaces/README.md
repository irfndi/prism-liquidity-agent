# Agent Marketplace Skills

This directory contains Prism installation skills for various agent harness marketplaces. Issue #33 tracked the full plan; this file documents the current status.

## Status by Marketplace

| # | Marketplace | Status | Skill file | Local install path |
|---|---|---|---|---|
| 1 | **OpenCode** | ✅ Ready | [`opencode/SKILL.md`](opencode/SKILL.md) | `~/.opencode/skills/prism-install/SKILL.md` |
| 1b | **OpenClaw** | ✅ Ready | [`openclaw/SKILL.md`](openclaw/SKILL.md) | `~/.openclaw/skills/prism-install/SKILL.md` |
| 1c | **Hermes** | ✅ Ready | [`hermes/SKILL.md`](hermes/SKILL.md) | `~/.hermes/skills/software-development/prism-install/SKILL.md` |
| 1d | **acpx / custom** | ✅ Ready | [`.agents/skills/prism-install.md`](../.agents/skills/prism-install.md) | `~/.agents/skills/prism-install.md` |
| 2 | Claude Desktop (MCP) | ❌ Not started | — | Requires `prism-mcp-server` npm package |
| 3 | OpenAI GPTs | ❌ Not started | — | Requires OpenAI GPT Store submission (UI-only) |
| 4 | AutoGPT | ❌ Not started | — | Requires `autogpt-prism` PyPI package |
| 5 | LangChain | ❌ Not started | — | Requires `langchain-prism` PyPI package |
| 6 | CrewAI | ❌ Not started | — | Requires `crewai-prism` PyPI package |
| 7 | Dify | ❌ Not started | — | Requires Dify marketplace submission |
| 8 | Flowise | ❌ Not started | — | Requires Flowise custom-node npm package |
| 9 | ChatGPT Plugins (legacy) | ❌ Not started | — | Deprecated; OpenAI GPTs is the successor |
| 10 | Custom agent harnesses | ✅ Ready | Same as 1d (acpx) | See [docs/agent-harness.md](../docs/agent-harness.md) |

## What's Done (4/10)

The four Markdown-based harnesses have copy-paste-ready skill files:

- **OpenCode** uses YAML frontmatter (`name`, `description`)
- **OpenClaw** uses plain Markdown with no frontmatter
- **Hermes** uses a richer frontmatter with `metadata.hermes.{tags, related_skills, category}`
- **acpx / custom** uses the project's own `.agents/skills/` format (plain Markdown, no frontmatter)

## What's Not Done (6/10)

The remaining six harnesses require code packages or platform submissions that are each multi-day projects:

- **MCP server** (Claude Desktop) — needs a new `prism-mcp-server` npm package exposing `prism_status`, `prism_positions`, `prism_start`, `prism_stop`, `prism_backtest` as MCP tools
- **OpenAI GPTs** — UI-only submission to the GPT Store; can't be automated from this repo
- **AutoGPT / LangChain / CrewAI** — each needs a separate PyPI package with a Python class wrapping the CLI
- **Dify / Flowise** — each needs a platform-specific plugin format and submission

These are tracked in the issue #33 phased plan. None of them block the core install path (the 4 ready harnesses cover all major agent ecosystems that use Markdown skills).

## How to Use

### Install via the ready skill files

For each ready marketplace, copy the SKILL.md to the local path shown in the table above:

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

### Verify the skill was discovered

The exact command depends on the harness:

- **OpenCode**: `skill()` then ask for `prism-install`
- **OpenClaw**: restart the harness; skills in `~/.openclaw/skills/` are loaded automatically
- **Hermes**: restart the harness; skills in `~/.hermes/skills/` are loaded automatically
- **acpx**: the skill is in the standard `.agents/skills/` location; acpx discovers it on next run

## Adding a New Marketplace

If you want to add a marketplace that isn't listed:

1. Create a new subdirectory under `marketplaces/<harness-name>/`
2. Write a `SKILL.md` matching that harness's discovery format
3. Add a row to the status table above with the local install path
4. Open a PR

The content can be adapted from the existing four skill files — the install/configure/start/troubleshooting sections are universal.

## See Also

- [Issue #33](https://github.com/irfndi/prism-liqudity-agent/issues/33) — original phased plan
- [`docs/agent-harness.md`](../docs/agent-harness.md) — full agent integration guide
- [`.agents/skills/`](../.agents/skills/) — the project's own skill directory (acpx format)
- [`dlmm-rebalancer`](../.agents/skills/dlmm-rebalancer.md) — strategy-level reasoning skill
