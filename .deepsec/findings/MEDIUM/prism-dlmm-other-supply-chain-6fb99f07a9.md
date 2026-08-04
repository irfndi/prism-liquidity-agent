# [MEDIUM] Unpinned third-party GitHub Actions references and canary Bun runtime in CI

**File:** [`.github/workflows/ci.yml`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/.github/workflows/ci.yml#L24-L222) (lines 24, 27, 32, 74, 77, 109, 114, 157, 162, 167, 187, 204, 209, 214, 222)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-supply-chain`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

All third-party actions are referenced by mutable major-version tags (actions/checkout@v7, oven-sh/setup-bun@v2, actions/setup-node@v7, actions/upload-artifact@v7, actions/download-artifact@v8). A major tag is a moving pointer: if an upstream action repository is compromised, the tag is force-updated, or the owner account is taken over, CI would silently execute attacker-controlled code in the build environment. In the canary-prepare/canary-build/canary-publish jobs (gated to main pushes) that code would run with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment (lines 297-298, 309-310, 317-318), enabling R2 bucket compromise (including the published canary manifest pointer). Additionally, `bun-version: canary` (lines 29, 79, 116, 164, 211) installs an unpinned nightly build of the Bun runtime, making the build/test toolchain a moving, unreviewed target. The build/test jobs also run on pull_request events, so a fork PR's `bun install` executes install scripts from untrusted dependency trees (no secrets are exposed to fork PRs, so this is limited to compute/CI resource abuse).

## Recommendation

Pin every action to a full immutable commit SHA (e.g., actions/checkout@<40-char-sha>) and use Dependabot/Renovate to bump them. Replace `bun-version: canary` with a pinned released Bun version. Consider adding a `permissions: contents: read` block to the workflow since the default GITHUB_TOKEN permissions are repo-config dependent.

## Recent committers (`git log`)

- irfndi <join.mantap@gmail.com> (2026-08-03)
- dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com> (2026-07-20)
