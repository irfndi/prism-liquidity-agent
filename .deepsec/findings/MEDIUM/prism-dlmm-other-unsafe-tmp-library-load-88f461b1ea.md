# [MEDIUM] Predictable temp path + unverified native library load allows dylib planting for local code execution in the wallet process

**File:** [`engine/sqlite-vec-embedded.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/sqlite-vec-embedded.ts#L23-L28) (lines 23, 24, 26, 27, 28)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-unsafe-tmp-library-load`

## Finding

`getEmbeddedVec0Path()` (L18-31) writes the embedded sqlite-vec dylib to a fully deterministic path: `os.tmpdir()/prism-vec0-<sha256(EMBEDDED_VEC0.data).slice(0,16)>/vec0.dylib`. The hash is computed from a compile-time constant, so any local attacker can compute the path in advance. The method then does `mkdirSync(tmpDir, {recursive: true})`, and if `existsSync(tmpPath)` is true it SKIPS writing and trusts the pre-existing file. The path is later fed to `db.loadExtension(embeddedPath)` (db.ts L131/L247), which dlopens it as native code inside the engine process — the process that holds `WALLET_PRIVATE_KEY` and signs live transactions. An unprivileged local user can pre-create `/tmp/prism-vec0-<hash>/vec0.dylib` (world-writable /tmp before the bot's first run, or after a `rm -rf` of the app's tmp dir) with a malicious dylib, and the engine will load it as the bot user (or root), yielding arbitrary code execution and wallet-key theft. There is no O_EXCL on the write, no integrity check on an existing file, and no verification that the existing file is a regular file (symlink not rejected). Local access is required, so this is a local privilege-escalation vector rather than a remote one, but the impact — full control of the signing process — is high.

## Recommendation

Write the dylib with an exclusive create (`O_EXCL`/`wx` flag), verify the file's hash after writing and before loading, reject symlinks (use `lstat`), and/or use a per-process random subdirectory instead of a deterministic name. Fail closed if the path is not exactly what the app wrote.
