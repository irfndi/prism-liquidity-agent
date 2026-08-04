# [MEDIUM] Predictable /tmp extraction path + symlink-following writes allow local code execution via sqlite-vec extension loading

**File:** [`scripts/generate-vec-embed.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/scripts/generate-vec-embed.ts#L56-L62) (lines 56, 57, 58, 60, 61, 62)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-insecure-tempfile`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

The template emitted by generate-vec-embed.ts (lines 52-65, compiled into engine/sqlite-vec-embedded.ts and executed at runtime) extracts the embedded native sqlite-vec library to a world-visible, fully predictable path: tmpDir = os.tmpdir()/prism-vec0-<prefix> where prefix is sha256(base64).slice(0,16) of the library bytes (L56-57), then `fs.mkdirSync(tmpDir, {recursive:true})` (L58), `if (!fs.existsSync(tmpPath)) fs.writeFileSync(tmpPath, ...)` + chmod 0o755 (L60-62), and returns the path, which engine/db.ts passes straight to db.loadExtension() (engine/db.ts:128 and :244) — i.e., dlopen of native code. The embedded data comes from the public sqlite-vec npm package at the pinned version, so any local user can precompute the exact path. On a multi-user Linux host (shared /tmp), an attacker pre-creates /tmp/prism-vec0-<prefix>/ and plants vec0.so as a malicious library or a symlink to one; existsSync then returns true, the write is skipped, and the victim's next prism run loads the attacker's native code as the victim — deterministically, no race required. Secondary primitives: mkdirSync follows a pre-planted directory symlink, and writeFileSync follows file symlinks (plus an existsSync→writeFileSync TOCTOU), enabling arbitrary-file overwrite with the library bytes. Impact is elevated because the victim is a trading agent whose env may hold WALLET_PRIVATE_KEY (live funds) and ~/.config/prism API credentials. (macOS os.tmpdir() is per-user, so exposure is primarily Linux shared hosts/CI runners.) The scanner's crypto flags on this file are false positives (createHash sha256 for integrity only).

## Recommendation

Extract to a private, randomized location: use fs.mkdtempSync(path.join(os.tmpdir(), 'prism-vec0-')) (0o700, unpredictable), or better a user-only cache dir like ~/.cache/prism/vec0-<full-hash> created with mode 0o700. Before reuse, lstat the path and refuse to load if the directory or file is a symlink or not owned by the current user; write with O_EXCL (fs.writeFileSync with flag 'wx') and verify the extracted file's sha256 before returning it to loadExtension.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-10)
