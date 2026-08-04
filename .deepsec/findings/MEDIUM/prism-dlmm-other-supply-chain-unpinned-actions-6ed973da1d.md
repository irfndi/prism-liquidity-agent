# [MEDIUM] Unpinned actions in the release pipeline holding GPG signing key, Cloudflare token and contents:write

**File:** [`.github/workflows/release.yml`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/.github/workflows/release.yml#L24-L309) (lines 24, 45, 50, 85, 90, 104, 119, 143, 151, 232, 242, 309)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-supply-chain-unpinned-actions`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

The tag-triggered release pipeline references all actions by mutable major tags: actions/checkout@v7 (L24, 45, 85, 119), oven-sh/setup-bun@v2 (L50, 90, 143), actions/upload-artifact@v7 (L104), actions/download-artifact@v8 (L151). The release job handles GPG_PRIVATE_KEY (L232), CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID on every R2 upload step (L242-288), and the workflow grants `permissions: contents: write` with GITHUB_TOKEN (L309) to publish GitHub Releases. A tag-move or compromise of any referenced action (third-party setup-bun installs the bun binary consumed by later build/sign/upload steps) gives attacker code execution ahead of those steps: they could steal the GPG signing key, replace the uploaded tarballs/SHA-256s/GPG signatures and the releases/latest.json manifest pointer in R2, and tamper with GitHub Release assets — silently serving malicious bundles to every user running `prism update`. Tag triggers require write access so arbitrary attackers cannot start the pipeline, but the mutable refs turn any upstream action incident into a full release-channel compromise. Injection review was clean: all tag-derived values (GITHUB_REF_NAME → version output) reach run scripts only via env vars with quoted shell expansion.

## Recommendation

Pin every action reference to a full commit SHA with a version comment, prioritizing the release job; add harden-runner with an egress allowlist to the secret-bearing jobs.

## Recent committers (`git log`)

- irfndi <join.mantap@gmail.com> (2026-08-03)
- dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com> (2026-07-13)
