# [MEDIUM] Unpinned actions in the production deploy job holding infra token and all worker secrets

**File:** [`.github/workflows/deploy-cloudflare.yml`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/.github/workflows/deploy-cloudflare.yml#L57-L127) (lines 57, 60, 120, 121, 123, 124, 125, 126, 127)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-supply-chain-unpinned-actions`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

The single deploy job references actions/checkout@v7 (L57) and oven-sh/setup-bun@v2 (L60) by mutable major tags. The same job's deploy step injects CLOUDFLARE_API_TOKEN (the Alchemy provider credential used to adopt/reconcile the entire production stack), CLOUDFLARE_ACCOUNT_ID, TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, BOT_API_SECRET, ADMIN_API_KEY and FEE_WALLET_ADDRESS (L120-127). A compromise or tag-move of either action (setup-bun is third-party and installs a bun binary used by every later step) yields code execution on the runner ahead of the secret-bearing steps, enabling theft of the infra token and all worker secrets — effectively full takeover of the Cloudflare production stack, Telegram bot impersonation, and admin-API access. The deploy step itself is correctly gated to refs/heads/main and secrets are not exposed to fork PRs (GitHub withholds secrets from fork-triggered pull_request runs), so the mutable action refs are the exploitable surface.

## Recommendation

Pin actions/checkout and oven-sh/setup-bun to full commit SHAs with version comments, and add StepSecurity harden-runner (egress policy) to the deploy job.

## Recent committers (`git log`)

- irfndi <join.mantap@gmail.com> (2026-08-03)
