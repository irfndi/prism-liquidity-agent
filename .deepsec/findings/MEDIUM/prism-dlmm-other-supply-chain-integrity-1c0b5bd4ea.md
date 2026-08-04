# [MEDIUM] Release manifest advertises a .asc signature that no consumer verifies; update integrity reduces to same-origin SHA-256

**File:** [`scripts/generate-release-manifest.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/scripts/generate-release-manifest.ts#L59-L67) (lines 59, 66, 67)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-supply-chain-integrity`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

generate-release-manifest.ts emits signature_url (`${tarballUrl}.asc`, L59/L67) alongside tarball_url and sha256_url, implying detached-signature verification of releases. No consumer ever verifies it: cli/update.ts downloadAndVerify() (L158-179) fetches the .sha256 file from the SAME R2 public bucket as the tarball and compares hashes, and scripts/install.sh (L207-224) does the same; a repo-wide search finds no gpg/signature verification anywhere (signatureUrl is parsed in engine/update-utils.ts L259/L277/L295 but never used cryptographically). A checksum fetched from the same origin as the artifact only protects against transport corruption, not origin compromise: anyone who obtains write access to the R2 bucket (pub-2f55c98709e74d1d900b89ec20f8f1fc.r2.dev) — or control of the Cloudflare account or the manifest-generation env (R2_BASE_URL) — can simultaneously replace manifest.json, the tarballs, and their .sha256 files, achieving code execution on every `prism update` and fresh install, while the published-but-unchecked .asc signature gives false assurance. Note the finding is attributed to this file as the source of the release trust contract; the enforcement gap lives in cli/update.ts and scripts/install.sh.

## Recommendation

Either enforce the detached signature client-side (bundle a pinned release public key; verify the .asc over the tarball in cli/update.ts and install.sh before extraction, and abort when the signature is missing/invalid), or remove signature_url and document that update security is anchored to R2 bucket access control. Pinning an independent verification channel (e.g., signature keys shipped in the binary) breaks the same-origin trust collapse.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-20)
