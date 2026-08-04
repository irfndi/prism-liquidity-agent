# [MEDIUM] Production worker secrets exposed to pull_request-triggered runs via PR-controlled workflow

**File:** [`.github/workflows/deploy-cloudflare.yml`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/.github/workflows/deploy-cloudflare.yml#L35-L88) (lines 35, 75, 84, 85, 86, 87, 88)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-secret-exposure`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

The workflow triggers on `pull_request` (line 35), and the 'Validate required secrets' step (lines 75-88) runs on every PR with TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, BOT_API_SECRET, ADMIN_API_KEY, and FEE_WALLET_ADDRESS in its env. For pull_request events, GitHub executes the workflow definition from the PR's merge commit, so any collaborator with branch-push access can edit this file (it is in the paths filter) to rewrite the Validate step to exfiltrate the secrets (e.g., curl them to an attacker server). Same-repo PRs pass secrets to the runner, so this is a real privilege-escalation path: a repo collaborator with write (but not admin) access can read all worker secrets that are normally admin-only. The Deploy step itself is correctly gated to main (line 105), but the Validate step's env block defeats that gate for secret exposure.

## Recommendation

Do not pass secrets to any step that executes on pull_request events. Gate the Validate step with `if: github.ref == 'refs/heads/main'` (or move secret validation into a separate main-only job), and consider using `pull_request_target` only with explicit, minimized secret scoping per the official GitHub guidance.

## Recent committers (`git log`)

- irfndi <join.mantap@gmail.com> (2026-08-03)
