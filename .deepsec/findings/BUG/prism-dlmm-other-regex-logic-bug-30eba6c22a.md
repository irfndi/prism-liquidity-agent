# [BUG] Version regex only escapes dots — semver build metadata (`+`) or other metacharacters break bundle matching and abort releases

**File:** [`scripts/generate-release-manifest.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/scripts/generate-release-manifest.ts#L33-L34) (lines 33, 34)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** medium  •  **Slug:** `other-regex-logic-bug`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

Line 33 escapes only `.` in the version (`version.replace(/\./g, "\\\.")`) before building the bundle-matching regex `^prism-v${escaped}-(.+)\.tar\.gz$` (line 34). A valid semver with build metadata such as `1.2.3+build.5` — which the release workflow's tag pattern `v*.*.*-*` (release.yml) permits — produces `1\.2\.3+build\.5` where `+` is a regex quantifier, so the real filename `prism-v1.2.3+build.5-linux-x64.tar.gz` no longer matches and every platform bundle is silently skipped. With REQUIRE_ALL_BUNDLES=true (the default and the value used by both workflows) the release aborts with 'Missing bundles'; with REQUIRE_ALL_BUNDLES=false the published manifest would silently omit platforms, breaking `prism update` for users on those platforms. Other regex metacharacters in the version (e.g. `[`, `(`, `?`) have the same effect.

## Recommendation

Escape the full regex metacharacter set (e.g. `version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`) or avoid regex entirely: match the literal `prism-v${version}-` prefix and parse the platform suffix with string operations.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-20)
