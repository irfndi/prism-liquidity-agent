# Create GitHub Issues: Prism DLMM Platform Expansion

## TL;DR

> **Quick Summary**: Create 4 GitHub issues in `irfndi/prism-dlmm` that capture the platform expansion vision: agent docs/CLI, registration/auth, Cloudflare Workers infrastructure, and revenue model.
> 
> **Deliverables**:
> - Issue 1: `docs(agents): add CLI/install documentation and agent-harness support`
> - Issue 2: `feat: registration, auth, and agent-harness flow (cli-first, telegram optional)`
> - Issue 3: `infra: cloudflare workers subproject (monorepo cloudflare/ dir)`
> - Issue 4: `feat: soft limits and revenue model (subscription + on-chain split)`
> 
> **Estimated Effort**: Quick (issue drafting, not implementation)
> **Parallel Execution**: YES — 1 wave (all 4 issues can be created in parallel)
> **Critical Path**: Issue 1 → Issue 3 → Issue 2 → Issue 4 (implementation order, not creation order)

---

## Context

### Original Request
User provided a personal dump of ideas covering:
- CLI/installation docs for agent-driven management (acpx, cron, openclaw/hermes)
- Self-hosting with multi-wallet support
- Cloudflare Workers as monorepo subproject
- Revenue model (management fees, performance fees, high-watermark)
- Config sync between .env and Cloudflare bindings

### Interview Summary
**Key Discussions**:
- Registration via Telegram bot + HTTP API (dual channel for humans and agents)
- Wallet model: non-custodial for trading + on-chain split for revenue (C+D hybrid)
- We control ONE wallet: the `fee_wallet` for revenue collection
- 4 onboarding paths: install-first, telegram-first, agent-driven, CLI-only
- CLI is the PRIMARY interface. Telegram is optional. Full command parity.
- Agent + Telegram link via one-time code (6-char, 10min TTL)
- Cloudflare as monorepo subproject under `cloudflare/...`

**Research Findings**:
- Repo is Bun 1.4 + TypeScript strict + Effect-TS strict + SQLite + sqlite-vec
- Current architecture: single-user, paper/live trading, rule-based agent
- Existing services: adapter, strategy, risk, memory, db, audit, blacklist, screener
- Tests in `bench/*.test.ts` (Vitest), coverage excludes main modules
- AGENTS.md has comprehensive architecture docs

### Metis Review
**Identified Gaps** (addressed):
- Auth architecture: decided cloud-first (CLI calls API, Telegram bot calls same API, both use D1)
- Multi-user agent model: per-instance + on-chain split (user runs locally, agent sends fee to wallet)
- Issue sizing: re-assessed (Issue 1=S, Issue 2=L, Issue 3=L, Issue 4=XL)
- DB migration strategy: will follow existing versioned migration pattern in `engine/db.ts`
- Fee wallet security: `FEE_WALLET_ADDRESS` (pubkey) in config, `FEE_WALLET_KEYPAIR_PATH` separate from user wallet

### Oracle Phase 1
**VERDICT: GO** — All 5 checks pass. Draft is internally consistent and aligned with codebase patterns.

---

## Work Objectives

### Core Objective
Create 4 GitHub issues that capture the platform expansion vision for prism-dlmm, with clear scope, dependencies, test strategies, and acceptance criteria.

### Concrete Deliverables
- 4 GitHub issues created in `irfndi/prism-dlmm` via `gh issue create`
- Each issue has: title, body (scope, deliverables, test strategy, acceptance criteria, not-included), labels, milestone
- Issues cross-reference each other via "Depends on #N" links

### Definition of Done
- [x] All 4 issues exist on GitHub with correct labels
- [x] Each issue body includes scope, deliverables, test strategy, acceptance criteria, and "not included" section
- [x] Issues reference each other correctly (dependency links)
- [x] `gh issue list` shows all 4 issues

### Must Have
- All 4 issues created with complete body content
- Correct labels applied to each issue
- Dependency links between issues (Issue 2 depends on Issue 3, Issue 4 depends on Issues 2 and 3)
- Test strategy per issue (TDD / tests-after / agent QA)
- Scope OUT per issue (explicit "not included" bullets)

### Must NOT Have (Guardrails)
- No implementation code — this plan is issue creation only
- No web dashboard or admin UI issues
- No EVM chain support
- No Slack/Discord bots (Telegram only)
- No custodial wallet mode
- No smart contract deployment
- No yield aggregation across protocols
- No social/copy trading
- No partner referral program

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (Vitest in `bench/*.test.ts`)
- **Automated tests**: N/A (issue creation, not code implementation)
- **Framework**: N/A

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.omo/evidence/task-{N}-{scenario-slug}.{ext}`.

- **GitHub Issues**: Use Bash (`gh issue view`) — Verify issue exists, body content, labels
- **Cross-references**: Use Bash (`gh issue view`) — Verify dependency links in body

---

## Execution Strategy

### Parallel Execution Waves

> This is a simple 1-wave plan — all 4 issues can be created in parallel since they're independent creation tasks.

```
Wave 1 (Start Immediately — all 4 issues in parallel):
├── Task 1: Create Issue 1 (docs/CLI) [quick]
├── Task 2: Create Issue 2 (registration/auth) [quick]
├── Task 3: Create Issue 3 (Cloudflare infra) [quick]
└── Task 4: Create Issue 4 (revenue model) [quick]

Wave FINAL (After ALL tasks — 1 review, then user okay):
└── Task F1: Verify all 4 issues exist and are correct [quick]
-> Present results -> Get explicit user okay
```

### Dependency Matrix

| Task | Depends On | Blocks |
|------|------------|--------|
| 1 | — | — |
| 2 | — | — |
| 3 | — | — |
| 4 | — | — |
| F1 | 1, 2, 3, 4 | — |

> All 4 issues are independent creation tasks. No blocking dependencies for creation order.

### Agent Dispatch Summary

- **Wave 1**: **4 tasks** — T1 → `quick`, T2 → `quick`, T3 → `quick`, T4 → `quick`
- **FINAL**: **1 task** — F1 → `quick`

---

## TODOs

- [x] 1. Create Issue 1: `docs(agents): add CLI/install documentation and agent-harness support`

  **What to do**:
  - Run `gh issue create` with the following content:
    - **Title**: `docs(agents): add CLI/install documentation and agent-harness support`
    - **Body**: See below
    - **Labels**: `documentation`, `agent-harness`, `good first issue`
  - Issue body:
    ```
    ## Scope
    Add docs and tooling for agent-driven management.

    ## Deliverables
    - `docs/install.md` — full install/setup walkthrough:
      - Prerequisites (Bun 1.2+, Solana wallet optional)
      - `git clone` + `bun install`
      - `prism register` (get API key from our Worker)
      - `prism setup` (configure Helius key — REQUIRED; wallet + watchlist — OPTIONAL)
      - `prism dev` (start paper trading)
      - What's preconfigured (all strategy params, paper mode, RPC auto-derived from Helius)
      - What's dead/unused (Anthropic API key, Claude model, Chroma — ignore these)
    - `docs/cli.md` — command reference (dev, backtest, test, format, lint, build, register, setup, whoami, wallet, etc.)
    - Cron / launchd / systemd examples for unattended scan loops
    - acpx integration notes
    - OpenClaw + Hermes harness compatibility (which skills load from `.opencode/skills/*`)
    - Skills installation matrix
    - Operator runbook for the agent-driven management model

    ## Test Strategy
    Agent QA only — verify docs render correctly, links work, cron example runs. No unit tests (docs-only issue).

    ## Acceptance Criteria
    - [ ] `docs/install.md` exists and covers env setup, RPC keys, wallet, API key
    - [ ] `docs/cli.md` exists and covers all CLI commands
    - [ ] Cron example works: `echo "@hourly cd /path && bun run dev" >> crontab`
    - [ ] Agent harness section documents openclaw/hermes compatibility

    ## Not Included / Deferred
    - No CLI code changes (Issue #2)
    - No agent harness implementation (docs only describe what exists)
    - No Cloudflare setup (Issue #3)
    ```

  **Must NOT do**:
  - Do not create any code files — this is a docs-only issue
  - Do not add CLI framework or subcommands (that's Issue #2)
  - Do not set up Cloudflare (that's Issue #3)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Simple `gh issue create` command with pre-drafted body
  - **Skills**: []
    - No skills needed — just `gh` CLI

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3, 4)
  - **Blocks**: F1
  - **Blocked By**: None

  **References**:
  - `.omo/drafts/github-issues-from-dump.md` — full issue draft with all content
  - `AGENTS.md` — existing architecture docs to reference for install.md content

  **Acceptance Criteria**:
  - [ ] Issue exists on GitHub: `gh issue view <N>` returns issue with correct title
  - [ ] Body contains all 4 sections: Scope, Deliverables, Test Strategy, Acceptance Criteria, Not Included
  - [ ] Labels include `documentation`, `agent-harness`, `good first issue`

  **QA Scenarios**:
  ```
  Scenario: Issue 1 created successfully
    Tool: Bash (gh)
    Preconditions: GitHub CLI authenticated, repo is irfndi/prism-dlmm
    Steps:
      1. Run `gh issue list --label "documentation" --json number,title,state`
      2. Verify issue with title "docs(agents): add CLI/install documentation and agent-harness support" exists
      3. Run `gh issue view <N>` and verify body contains "## Scope"
      4. Run `gh issue view <N>` and verify body contains "## Deliverables"
      5. Run `gh issue view <N>` and verify body contains "## Test Strategy"
      6. Run `gh issue view <N>` and verify body contains "## Not Included / Deferred"
    Expected Result: Issue exists with all required sections
    Failure Indicators: Issue not found, missing sections, wrong labels
    Evidence: .omo/evidence/task-1-issue-1-created.txt

  Scenario: Issue 1 has correct labels
    Tool: Bash (gh)
    Preconditions: Issue 1 created
    Steps:
      1. Run `gh issue view <N> --json labels`
      2. Verify labels array contains "documentation", "agent-harness", "good first issue"
    Expected Result: All 3 labels present
    Failure Indicators: Missing labels, wrong labels
    Evidence: .omo/evidence/task-1-issue-1-labels.txt
  ```

  **Commit**: NO (no code changes)

- [x] 2. Create Issue 2: `feat: registration, auth, and agent-harness flow (cli-first, telegram optional)`

  **What to do**:
  - Run `gh issue create` with the following content:
    - **Title**: `feat: registration, auth, and agent-harness flow (cli-first, telegram optional)`
    - **Body**: See below
    - **Labels**: `enhancement`, `multi-tenant`, `auth`, `breaking-change`, `cli`
  - Issue body:
    ```
    ## Scope
    CLI is the primary interface. Telegram is optional. Four onboarding paths converge on one identity model.

    ## Deliverables
    - New `cli/` directory: `cli/index.ts` (commander/yargs), subcommands in `cli/{register,login,whoami,wallet,link-telegram,subscription,issue,support,setup}.ts`
    - Local credential store: `~/.config/prism/credentials.json` (0600 perms)
    - `prism register` — calls Worker `/v1/register`, stores returned API key
    - `prism login <key>` — validates existing API key with Worker
    - `prism setup` — interactive wizard (replaces `ops/setup.ts`) that collects:
      - Helius API key (REQUIRED — no default, validates key format)
      - Wallet private key (OPTIONAL — skip for paper trading, warn if live mode)
      - Watchlist pools (OPTIONAL — comma-separated, or leave blank to use pool discovery)
      - Writes to `.env` with all other params preconfigured:
        ```
        HELIUS_API_KEY=<user-provided>
        SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=<helius-key>  # auto-derived
        WALLET_PRIVATE_KEY=<user-provided or empty>
        PAPER_TRADING=true  # default
        WATCHLIST_POOLS=<user-provided or empty>
        # All strategy params preconfigured with defaults from config-service.ts
        ```
    - `prism setup --non-interactive --helius-key=<key>` — for agent-driven setup (all other params default)
    - `prism whoami` — returns account, tier, wallet_address, telegram link status
    - `prism wallet {generate,import,show,register}` — non-custodial
    - `prism link-telegram` — generates 6-char one-time code via Worker
    - `prism unlink-telegram` — revokes binding
    - `prism subscription {status,renew}` — shows tier, expiry; renew returns Solana Pay QR
    - `prism issue <text>` — files issue to our GitHub repo via Worker
    - `prism support` — returns support contact
    - Per-user position isolation in SQLite (add `user_id` column)
    - Audit trail per user
    - Effect-TS `AuthService` + `IdentityService` wired into `buildLayer()`

    ## Two-Phase Onboarding
    Phase 1 (auth): `prism register` → get our API key from Cloudflare Worker
    Phase 2 (setup): `prism setup` → configure trading agent (Helius, RPC, wallet, pools)
    Both phases are required before `prism dev` can run. `prism setup` can run offline.

    ## Onboarding Paths
    All 4 paths converge on one identity model (D1 users table):
    - **Path A**: install first, link Telegram later
      1. `prism register` → get our API key from Worker
      2. `prism setup` → Helius key (REQUIRED), wallet + watchlist (OPTIONAL)
      3. `prism link-telegram` → generate code → send to bot
    - **Path B**: Telegram first, install later
      1. Bot `/register` → bot DMs API key
      2. `prism setup` → Helius key (REQUIRED), wallet + watchlist (OPTIONAL)
      3. `prism login <key>` → validate
    - **Path C**: agent-driven + Telegram link
      1. Agent runs `prism register` → get API key
      2. Agent runs `prism setup --non-interactive --helius-key=<key>` → configure
      3. Agent runs `prism link-telegram` → generate code → user sends to bot
    - **Path D**: CLI-only, no Telegram
      1. `prism register` → get API key
      2. `prism setup` → Helius key (REQUIRED), wallet + watchlist (OPTIONAL)
      3. `prism wallet generate` → create local keypair
      4. `prism dev` → start trading

    ## CLI ↔ Bot Command Parity
    Every bot command has a CLI equivalent. Every CLI command has a Worker endpoint. No silent asymmetry.

    ## Test Strategy
    Tests-after. Add `bench/auth.test.ts` and `bench/cli.test.ts` following existing Vitest + Effect Layer pattern (`:memory:` SQLite). CLI commands tested via subprocess assertions.

    ## Acceptance Criteria
    - [ ] `prism register` creates local identity and returns success within 2s
    - [ ] `prism setup` writes `.env` with Helius key, auto-derived RPC URL, and all strategy defaults
    - [ ] `prism setup --non-interactive --helius-key=<key>` works for agent-driven setup
    - [ ] `prism whoami` returns user info after registration
    - [ ] `prism link-telegram` generates a 6-char code that expires in 10min
    - [ ] `prism wallet generate` creates local Solana keypair
    - [ ] Positions in SQLite have user_id; queries filter by user
    - [ ] Old `prism.db` (no user_id) auto-migrated on first run

    ## Not Included / Deferred
    - No Cloudflare Workers code (Issue #3)
    - No payment/subscription logic (Issue #4)
    - No revenue model / fee splitting (Issue #4)
    - No web dashboard or mobile app
    - No custodial wallet mode

    Depends on: Issue #3 (the Worker must exist for `register` to call)
    ```

  **Must NOT do**:
  - Do not implement Cloudflare Workers (that's Issue #3)
  - Do not implement payment/subscription logic (that's Issue #4)
  - Do not implement revenue model or fee splitting (that's Issue #4)
  - Do not add custodial wallet mode (explicitly excluded)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Simple `gh issue create` command with pre-drafted body
  - **Skills**: []
    - No skills needed — just `gh` CLI

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3, 4)
  - **Blocks**: F1
  - **Blocked By**: None

  **References**:
  - `.omo/drafts/github-issues-from-dump.md` — full issue draft with all content
  - `engine/services.ts` — existing Effect-TS service pattern for AuthService/IdentityService
  - `engine/db.ts` — existing migration pattern for adding user_id column

  **Acceptance Criteria**:
  - [ ] Issue exists on GitHub: `gh issue view <N>` returns issue with correct title
  - [ ] Body contains all required sections: Scope, Deliverables, Onboarding Paths, CLI ↔ Bot Parity, Test Strategy, Acceptance Criteria, Not Included
  - [ ] Labels include `enhancement`, `multi-tenant`, `auth`, `breaking-change`, `cli`
  - [ ] Body mentions "Depends on: Issue #3"

  **QA Scenarios**:
  ```
  Scenario: Issue 2 created successfully
    Tool: Bash (gh)
    Preconditions: GitHub CLI authenticated, repo is irfndi/prism-dlmm
    Steps:
      1. Run `gh issue list --label "multi-tenant" --json number,title,state`
      2. Verify issue with title "feat: registration, auth, and agent-harness flow (cli-first, telegram optional)" exists
      3. Run `gh issue view <N>` and verify body contains "## Scope"
      4. Run `gh issue view <N>` and verify body contains "## Onboarding Paths"
      5. Run `gh issue view <N>` and verify body contains "## CLI ↔ Bot Command Parity"
      6. Run `gh issue view <N>` and verify body contains "Depends on: Issue #3"
    Expected Result: Issue exists with all required sections and dependency link
    Failure Indicators: Issue not found, missing sections, missing dependency link
    Evidence: .omo/evidence/task-2-issue-2-created.txt

  Scenario: Issue 2 has correct labels
    Tool: Bash (gh)
    Preconditions: Issue 2 created
    Steps:
      1. Run `gh issue view <N> --json labels`
      2. Verify labels array contains "enhancement", "multi-tenant", "auth", "breaking-change", "cli"
    Expected Result: All 5 labels present
    Failure Indicators: Missing labels, wrong labels
    Evidence: .omo/evidence/task-2-issue-2-labels.txt
  ```

  **Commit**: NO (no code changes)

- [x] 3. Create Issue 3: `infra: cloudflare workers subproject (monorepo cloudflare/ dir)`

  **What to do**:
  - Run `gh issue create` with the following content:
    - **Title**: `infra: cloudflare workers subproject (monorepo cloudflare/ dir)`
    - **Body**: See below
    - **Labels**: `infrastructure`, `cloudflare`, `monorepo`, `effect-ts`
  - Issue body:
    ```
    ## Scope
    The `cloudflare/` subproject hosts the registration/auth backend. Workers use Effect-TS (same pattern as main engine).

    ## Deliverables
    - `cloudflare/` monorepo layout:
      - `cloudflare/workers/api/` — Effect-TS Worker: `/v1/register`, `/v1/login`, `/v1/link-telegram`, `/v1/whoami`, `/v1/issue`, `/v1/webhook/telegram`
      - `cloudflare/workers/telegram-bot/` — Telegram webhook handler (Effect-TS, shares D1)
      - `cloudflare/migrations/` — D1 schema (users, api_keys, telegram_links, subscriptions, audit)
      - `cloudflare/wrangler.toml` — D1 + KV + Vectorize + R2 bindings
      - `cloudflare/.github/workflows/deploy.yml` — wrangler deploy on push to `cloudflare/**`
    - Read from `README.md`, `AGENTS.md`, `ARCHITECTURE.md` for context
    - Bindings: D1 (prism-db), KV (prism-cache), R2 (prism-backups), Vectorize (prism-memories)
    - Issue tracker integration: `/v1/issue` proxies to GitHub Issues API
    - Config sync: `bun run cloudflare:sync` — .env ↔ wrangler secrets
    - README: which parts of the engine stay on Bun/Node (the trader loop), which move to Workers (the registration/auth surface)

    ## Effect-TS Pattern
    Workers follow the same DI pattern as the main engine:
    - Services defined as `Context.Tag` in `cloudflare/workers/api/services.ts`
    - Implementations in `cloudflare/workers/api/*-service.ts` returning `Layer`
    - Wiring in `buildLayer()` function
    - `Effect.gen` block for the main handler logic
    - No direct imports of service classes — all via `yield* ServiceName`

    ## Test Strategy
    Tests-after. Worker tests via `vitest` with `@cloudflare/vitest-pool-workers`. D1 schema tested via migration dry-runs. CI: `wrangler deploy --dry-run` in PR checks.

    ## Acceptance Criteria
    - [ ] `cloudflare/` directory exists with separate `package.json`
    - [ ] `wrangler deploy` succeeds for both api and telegram-bot Workers
    - [ ] API Worker `GET /health` returns 200
    - [ ] API Worker `POST /auth/register` creates user in D1
    - [ ] Telegram bot webhook responds with 200 within 5s
    - [ ] CI deploys Workers on push to main without breaking existing CI
    - [ ] Workers use Effect-TS (Context.Tag + Layer pattern)

    ## Not Included / Deferred
    - No CLI commands (Issue #2)
    - No revenue/fee logic (Issue #4)
    - No web dashboard or admin UI
    - No EVM chain support
    - No Slack/Discord bots (Telegram only)
    - No mobile app

    Foundation for Issue #2 (the CLI calls the Worker API).
    ```

  **Must NOT do**:
  - Do not implement CLI commands (that's Issue #2)
  - Do not implement revenue/fee logic (that's Issue #4)
  - Do not use Hono or itty-router — use Effect-TS for the Worker
  - Do not create web dashboard or admin UI
  - Do not add Slack/Discord bots

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Simple `gh issue create` command with pre-drafted body
  - **Skills**: []
    - No skills needed — just `gh` CLI

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 4)
  - **Blocks**: F1
  - **Blocked By**: None

  **References**:
  - `.omo/drafts/github-issues-from-dump.md` — full issue draft with all content
  - `engine/services.ts` — existing Effect-TS service pattern to replicate in Workers
  - `engine/program.ts` — existing `buildLayer()` pattern for DI wiring
  - `README.md` — project overview for context
  - `AGENTS.md` — architecture docs for context

  **Acceptance Criteria**:
  - [ ] Issue exists on GitHub: `gh issue view <N>` returns issue with correct title
  - [ ] Body contains all required sections: Scope, Deliverables, Effect-TS Pattern, Test Strategy, Acceptance Criteria, Not Included
  - [ ] Labels include `infrastructure`, `cloudflare`, `monorepo`, `effect-ts`
  - [ ] Body mentions Effect-TS pattern and Context.Tag + Layer

  **QA Scenarios**:
  ```
  Scenario: Issue 3 created successfully
    Tool: Bash (gh)
    Preconditions: GitHub CLI authenticated, repo is irfndi/prism-dlmm
    Steps:
      1. Run `gh issue list --label "cloudflare" --json number,title,state`
      2. Verify issue with title "infra: cloudflare workers subproject (monorepo cloudflare/ dir)" exists
      3. Run `gh issue view <N>` and verify body contains "## Scope"
      4. Run `gh issue view <N>` and verify body contains "## Effect-TS Pattern"
      5. Run `gh issue view <N>` and verify body contains "Context.Tag"
      6. Run `gh issue view <N>` and verify body contains "Foundation for Issue #2"
    Expected Result: Issue exists with all required sections and Effect-TS reference
    Failure Indicators: Issue not found, missing sections, no Effect-TS mention
    Evidence: .omo/evidence/task-3-issue-3-created.txt

  Scenario: Issue 3 has correct labels
    Tool: Bash (gh)
    Preconditions: Issue 3 created
    Steps:
      1. Run `gh issue view <N> --json labels`
      2. Verify labels array contains "infrastructure", "cloudflare", "monorepo", "effect-ts"
    Expected Result: All 4 labels present
    Failure Indicators: Missing labels, wrong labels
    Evidence: .omo/evidence/task-3-issue-3-labels.txt
  ```

  **Commit**: NO (no code changes)

- [x] 4. Create Issue 4: `feat: soft limits and revenue model (subscription + on-chain split)`

  **What to do**:
  - Run `gh issue create` with the following content:
    - **Title**: `feat: soft limits and revenue model (subscription + on-chain split)`
    - **Body**: See below
    - **Labels**: `enhancement`, `monetization`, `fund-management`
  - Issue body:
    ```
    ## Scope
    Fund-management style monetization, enforced on-chain.

    ## Deliverables
    - Tiers (defined in D1, configurable):
      - `free` — max 1 SOL realized profit/month, 0% split
      - `pro` — monthly subscription (prepaid to fee_wallet), 10% of profit above threshold
      - `fund` — lockup + monthly management fee + 20% performance fee (high-watermark) + early-redemption fee
    - Enforcement (in prism-dlmm engine):
      - Track realized PnL per user per period
      - On each profitable EXIT: if pnl > tier.maxFreeSol → execute on-chain transfer to fee_wallet
      - Pre-trade: check subscription status (cached locally, refresh from Worker)
    - Payment: Solana Pay primary (QR code), Stripe later as fallback
    - Fee wallet: ONE Solana address we control, configured as `FEE_WALLET_ADDRESS`
    - High-watermark: per-user, per-fund — track highest NAV; performance fee only on gains above it
    - Reports: monthly statement per user, exportable from CLI
    - Config (D1): tier definitions, fee percentages, lockup periods

    ## Test Strategy
    TDD. Add `bench/revenue.test.ts` covering: high-watermark math, fee calculation, tier limit enforcement, early redemption penalty. Tests use `:memory:` SQLite + mock Solana RPC.

    ## Acceptance Criteria
    - [ ] `prism subscription status` shows current tier and expiry
    - [ ] `prism subscription upgrade pro` returns Solana Pay transaction URL
    - [ ] Management fee calculation: `fee = position_value * (fee_rate / 365) * days_held`
    - [ ] High-watermark tracking: fee charged only on new profits above previous peak
    - [ ] Fee goes to fee_wallet address (env var: `FEE_WALLET_ADDRESS`)
    - [ ] Early redemption: >10% fee if position closed before lock period

    ## Not Included / Deferred
    - No Stripe integration (Solana Pay first; Stripe is future fallback)
    - No custodial wallet management (non-custodial only)
    - No smart contract deployment (fees via agent-constructed transactions)
    - No yield aggregation across protocols (Meteora DLMM only)
    - No social/copy trading
    - No partner referral program
    - No EVM chain support

    Depends on: Issue #2 (needs user identity), Issue #3 (needs subscription state in D1)
    ```

  **Must NOT do**:
  - Do not implement Stripe integration (Solana Pay first)
  - Do not implement custodial wallet management (non-custodial only)
  - Do not deploy smart contracts (fees via agent-constructed transactions)
  - Do not add yield aggregation, social trading, or referral programs
  - Do not add EVM chain support

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Simple `gh issue create` command with pre-drafted body
  - **Skills**: []
    - No skills needed — just `gh` CLI

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 3)
  - **Blocks**: F1
  - **Blocked By**: None

  **References**:
  - `.omo/drafts/github-issues-from-dump.md` — full issue draft with all content
  - `engine/audit-service.ts` — existing audit trail for PnL tracking
  - `engine/db-service.ts` — existing DB pattern for adding fee tracking tables
  - `engine/config-service.ts` — existing config pattern for FEE_WALLET_ADDRESS

  **Acceptance Criteria**:
  - [ ] Issue exists on GitHub: `gh issue view <N>` returns issue with correct title
  - [ ] Body contains all required sections: Scope, Deliverables, Test Strategy, Acceptance Criteria, Not Included
  - [ ] Labels include `enhancement`, `monetization`, `fund-management`
  - [ ] Body mentions "Depends on: Issue #2" and "Depends on: Issue #3"
  - [ ] Body mentions high-watermark, Solana Pay, and non-custodial

  **QA Scenarios**:
  ```
  Scenario: Issue 4 created successfully
    Tool: Bash (gh)
    Preconditions: GitHub CLI authenticated, repo is irfndi/prism-dlmm
    Steps:
      1. Run `gh issue list --label "monetization" --json number,title,state`
      2. Verify issue with title "feat: soft limits and revenue model (subscription + on-chain split)" exists
      3. Run `gh issue view <N>` and verify body contains "## Scope"
      4. Run `gh issue view <N>` and verify body contains "## Deliverables"
      5. Run `gh issue view <N>` and verify body contains "high-watermark"
      6. Run `gh issue view <N>` and verify body contains "Depends on: Issue #2"
      7. Run `gh issue view <N>` and verify body contains "Depends on: Issue #3"
    Expected Result: Issue exists with all required sections and dependency links
    Failure Indicators: Issue not found, missing sections, missing dependency links
    Evidence: .omo/evidence/task-4-issue-4-created.txt

  Scenario: Issue 4 has correct labels
    Tool: Bash (gh)
    Preconditions: Issue 4 created
    Steps:
      1. Run `gh issue view <N> --json labels`
      2. Verify labels array contains "enhancement", "monetization", "fund-management"
    Expected Result: All 3 labels present
    Failure Indicators: Missing labels, wrong labels
    Evidence: .omo/evidence/task-4-issue-4-labels.txt
  ```

  **Commit**: NO (no code changes)

---

## Final Verification Wave

> 1 review agent runs after ALL issue creation tasks. Verifies all 4 issues exist and are correct.

- [x] F1. **Verify All Issues Created** — `quick`
  Run `gh issue list --limit 10` to find the 4 newly created issues by title. For each issue: run `gh issue view N` and verify title, body contains scope/deliverables/test-strategy/acceptance-criteria/not-included, and correct labels. Check cross-references: Issue 2 body mentions "Depends on #N" pointing to Issue 3; Issue 4 body mentions dependencies on Issues 2 and 3. If dependency numbers are placeholders (e.g., "Issue #3"), update the body with real issue numbers via `gh issue edit N --body "..."`.
  Output: `Issues [4/4 exist] | Labels [4/4 correct] | Cross-refs [2/2 valid] | VERDICT: APPROVE/REJECT`

---

## Commit Strategy

- **1**: No commits — this plan creates GitHub issues, not code changes

---

## Success Criteria

### Verification Commands
```bash
gh issue list --limit 10  # Expected: 4 issues listed (match by title)
gh issue view 1  # Expected: Issue 1 with correct body
gh issue view 2  # Expected: Issue 2 with correct body
gh issue view 3  # Expected: Issue 3 with correct body
gh issue view 4  # Expected: Issue 4 with correct body
```

### Final Checklist
- [x] All 4 issues created with complete body content
- [x] Correct labels applied
- [x] Dependency links in body text
- [x] Test strategy per issue
- [x] Scope OUT per issue
- [x] No implementation code created (issues only)
