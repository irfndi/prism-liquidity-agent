# [BUG] Fork PRs always fail CI: 'Validate required secrets' step requires secrets that GitHub does not provide to fork PRs

**File:** [`.github/workflows/deploy-cloudflare.yml`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/.github/workflows/deploy-cloudflare.yml#L75-L82) (lines 75, 76, 77, 78, 79, 80, 81, 82)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-ci-breakage`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

The workflow is triggered on pull_request, and the comment states PRs should only typecheck (the prod deploy runs on merge to main). However, the 'Validate required secrets' step (lines 75-88) runs unconditionally on every PR and exits 1 when any secret is unset. GitHub does not pass secrets to workflows triggered by pull requests from forks, so every external contributor's PR fails at this step after the typecheck has already passed — the PR CI path is effectively broken for fork contributions. The step should also be skipped for fork PRs since the deploy is main-only anyway.

## Recommendation

Gate the secret validation on `github.event_name == 'push'` (or `github.ref == 'refs/heads/main'`), so fork PRs can run the typecheck-and-build gate without requiring secrets that will never be present.

## Recent committers (`git log`)

- irfndi <join.mantap@gmail.com> (2026-08-03)
