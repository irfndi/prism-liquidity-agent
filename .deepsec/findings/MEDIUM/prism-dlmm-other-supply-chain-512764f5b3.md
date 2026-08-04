# [MEDIUM] Unpinned third-party GitHub Actions and canary Bun runtime in deploy pipeline

**File:** [`.github/workflows/deploy-cloudflare.yml`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/.github/workflows/deploy-cloudflare.yml#L57-L60) (lines 57, 60)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-supply-chain`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

actions/checkout@v7 and oven-sh/setup-bun@v2 are referenced by mutable major tags. The deploy job runs with all 7 production secrets (TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, BOT_API_SECRET, ADMIN_API_KEY, FEE_WALLET_ADDRESS, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID) in the environment of the Deploy step. A compromised or force-updated action tag would execute attacker-controlled code with access to these secrets and the ability to push arbitrary worker code to production Cloudflare Workers. `bun-version: canary` (line 62) additionally installs a moving nightly Bun build.

## Recommendation

Pin actions to full commit SHAs, use a released Bun version, and enable Dependabot for workflow updates.

## Recent committers (`git log`)

- irfndi <join.mantap@gmail.com> (2026-08-03)
