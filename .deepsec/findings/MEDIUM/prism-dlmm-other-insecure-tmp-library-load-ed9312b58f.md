# [MEDIUM] Predictable tmp-path shared-library load — local attacker can pre-plant a malicious vec0.so and achieve code execution in the prism process

**File:** [`scripts/generate-vec-embed.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/scripts/generate-vec-embed.ts#L56-L64) (lines 56, 57, 58, 59, 60, 61, 62, 63, 64)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-insecure-tmp-library-load`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

The generated getEmbeddedVec0Path() (template lines 56-64) writes the native sqlite-vec extension to a deterministic path `os.tmpdir()/prism-vec0-<sha256prefix>/vec0.so` and, if the file already exists, skips writing and returns the existing path. engine/db.ts then loads it via `db.loadExtension(embeddedPath)` (dlopen). The directory name is the sha256 of the embedded base64, which is public (it ships inside the distributed bundle), so on a shared Linux host or container (os.tmpdir() = /tmp, world-readable) any local user can pre-compute the path and pre-create the directory with a malicious `vec0.so` before the victim's first run. The victim's `fs.existsSync(tmpPath)` check then sees the planted file, skips the write, and dlopens the attacker's library — arbitrary code execution in the prism process, which holds WALLET_PRIVATE_KEY in memory (the top asset in this project's threat model). The file is also chmod'ed 0o755 and the directory is created with default (umask-dependent, typically 0o755) permissions, so the planted library is readable by the victim. On macOS the per-user TMPDIR mostly limits this, but Linux and Docker deployments are affected.

## Recommendation

Create the directory with restrictive ownership: use `fs.mkdirSync(tmpDir, { mode: 0o700 })` and verify the directory is owned by the current user (reject/remove pre-existing dirs not owned by euid) before writing; verify the loaded file's integrity by recomputing and comparing its SHA-256 against the embedded data before dlopen, and use `writeFileSync` with `flag: 'wx'` so a pre-existing file cannot be silently reused.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-10)
