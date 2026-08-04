# [MEDIUM] Base image uses mutable rolling tag `oven/bun:canary-slim` without digest pinning

**File:** [`Dockerfile`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/Dockerfile#L2-L18) (lines 2, 18)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-supply-chain`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

Both stages use `FROM oven/bun:canary-slim` (lines 2 and 18) with no `@sha256:...` digest. 'canary' is a rolling prerelease channel, so every rebuild silently pulls an unpinned, potentially unstable or (if the registry account were ever compromised) replaced image. This is a supply-chain / reproducibility risk: the production runtime image content is not under reviewable control, and `bun install --frozen-lockfile` only pins JS dependencies, not the base image.

## Recommendation

Pin the base image to an immutable digest (e.g. `FROM oven/bun:canary-slim@sha256:...`) and prefer a stable channel (e.g. `oven/bun:1-slim` or a pinned `1.x` tag) for production, with a digest-update workflow for deliberate upgrades.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-11)
