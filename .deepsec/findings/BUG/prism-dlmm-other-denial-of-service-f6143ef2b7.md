# [BUG] Fork PRs share the prod deploy concurrency group and can stall production deploys

**File:** [`.github/workflows/deploy-cloudflare.yml`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/.github/workflows/deploy-cloudflare.yml#L45-L105) (lines 45, 46, 47, 50, 52, 105)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** medium  •  **Slug:** `other-denial-of-service`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

The workflow-level concurrency group `deploy-cloudflare-prod` with cancel-in-progress: false (L45-47) applies to every run of the workflow, but the `deploy` job has no branch/event gate — only the inner 'Deploy via Alchemy' step does (L105). A pull_request from a fork therefore runs the full job (checkout, bun install, typecheck, secret validation) while holding the group for up to timeout-minutes: 30. Because cancel-in-progress is false, a main-branch production deploy triggered while a fork PR run is in progress must queue behind it. An attacker can spam trivial PRs touching cloudflare/** to keep the group perpetually occupied, indefinitely delaying production deploys (and burning runner minutes), with no write access required.

## Recommendation

Split the workflow: a PR job (typecheck only, no concurrency group or a per-PR group like deploy-typecheck-${{ github.event.pull_request.number }}) and a main-only deploy job gated with `if: github.event_name == 'push'`, keeping the serialized prod group exclusively for main runs.

## Recent committers (`git log`)

- irfndi <join.mantap@gmail.com> (2026-08-03)
