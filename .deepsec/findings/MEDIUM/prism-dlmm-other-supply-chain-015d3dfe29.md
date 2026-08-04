# [MEDIUM] Unpinned third-party GitHub Actions references in release pipeline

**File:** [`.github/workflows/release.yml`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/.github/workflows/release.yml#L24-L151) (lines 24, 45, 50, 85, 90, 104, 119, 143, 151)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-supply-chain`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

actions/checkout@v7, oven-sh/setup-bun@v2, actions/upload-artifact@v7, and actions/download-artifact@v8 are referenced by mutable major tags. The release job executes these on tag pushes with GPG_PRIVATE_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, and GITHUB_TOKEN (contents: write) in step environments. A compromised or force-updated action tag would let an attacker publish unsigned/malicious release artifacts to the R2 distribution channel and create GitHub Releases, compromising the software supply chain for all users of `prism update`. The GPG signing step is also optional (only runs when GPG_PRIVATE_KEY is set), so the supply chain depends entirely on the integrity of these unpinned actions. Note: the Bun runtime is properly pinned to 1.4.0 here, which is good.

## Recommendation

Pin all actions to full commit SHAs and enable Dependabot for workflow updates. Consider making GPG signing of release artifacts mandatory (fail the release if the key is unset) so the distribution channel is not dependent on action-tag integrity alone.

## Recent committers (`git log`)

- irfndi <join.mantap@gmail.com> (2026-08-03)
- dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com> (2026-07-13)
