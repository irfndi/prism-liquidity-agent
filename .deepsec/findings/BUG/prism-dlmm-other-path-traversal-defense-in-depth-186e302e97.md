# [BUG] Tarball extraction without explicit path traversal hardening flags

**File:** [`cli/update.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/cli/update.ts#L181) (lines 181)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** low  •  **Slug:** `other-path-traversal-defense-in-depth`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

extractTarball() at line 181 invokes 'tar -xzf' without --no-absolute-paths (GNU tar) or equivalent flags. While modern tar implementations (bsdtar on macOS, GNU tar >= 1.32) refuse to extract entries containing '..' or absolute paths by default, this behavior is implementation-dependent and not guaranteed across all platforms. A malicious tarball from a compromised release source could potentially write files outside the intended extraction directory on platforms with older or non-standard tar implementations.

## Recommendation

Add explicit path traversal protection flags: use 'tar --no-absolute-paths -xzf' on GNU tar or 'tar -xzf --no-absolute-paths' and validate the tar implementation, or extract to a directory and verify no files were written outside it before proceeding with installation.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-18)
