# [MEDIUM] Unpinned GitHub Actions in canary publish pipeline that holds Cloudflare credentials

**File:** [`.github/workflows/ci.yml`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/.github/workflows/ci.yml#L24-L307) (lines 24, 27, 32, 64, 67, 99, 104, 147, 152, 157, 177, 194, 199, 204, 212, 299, 307)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-supply-chain-unpinned-actions`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

All actions are referenced by mutable major tags (actions/checkout@v7, oven-sh/setup-bun@v2, actions/setup-node@v7, actions/upload-artifact@v7, actions/download-artifact@v8) instead of commit SHAs. The canary-publish job runs on push to main and injects CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID into its upload/GC steps (L299-300, L307-308). If any referenced action is compromised or its major tag is force-moved (third-party oven-sh/setup-bun is the most exposed), attacker-controlled code runs on the runner before the secret-bearing steps and can plant a malicious bun/node binary or modify the workspace, then exfiltrate the Cloudflare token when it is materialized. With that token the attacker can overwrite the canary bundles and the releases/channel/canary.json manifest pointer in R2, which users install via `prism update --canary` — a full downstream supply-chain compromise. The canary jobs correctly gate on `push && refs/heads/main` (fork PRs cannot reach the secrets), so the remaining exposure is purely the mutable action refs.

## Recommendation

Pin every action to a full commit SHA with a version comment (e.g. actions/checkout@<sha> # v7), especially in canary-publish/canary-build, and consider StepSecurity harden-runner on the secret-bearing jobs. Dependabot can keep SHA pins updated.

## Recent committers (`git log`)

- irfndi <join.mantap@gmail.com> (2026-08-03)
- dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com> (2026-07-20)
