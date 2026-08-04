# [MEDIUM] Release integrity relies on same-source SHA-256; PGP signature is collected but never verified

**File:** [`engine/update-utils.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/update-utils.ts#L259-L295) (lines 259, 277, 295)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** low  •  **Slug:** `other-supply-chain`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

githubReleaseToInfo (L259-277) and r2ManifestToInfo (L293-295) resolve the release's .asc PGP signature (signatureUrl) but the installer (cli/update.ts downloadAndVerify) only verifies the tarball against a SHA-256 checksum fetched from the SAME manifest/release that supplies the tarball URL. An attacker who compromises the R2 bucket or the GitHub release can publish a malicious tarball plus a matching checksum, and the extracted bundle is then executed (smoke test runs the new binary, and the install replaces the wrapper). The signature is the only independent integrity anchor and it is never checked. The checksum being same-source as the artifact makes the SHA-256 check a transport-integrity guard only, not a provenance guard.

## Recommendation

Verify the tarball's PGP signature against a pinned public key (e.g. the release .asc with a hardcoded/operator-distributed key) before extraction, or require the checksum to be published in a channel independent of the artifact (e.g. a signed manifest). Treat absence of a signature as a hard failure for non-dev channels.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-20)
- irfandi marsya <irfandi@users.noreply.github.com> (2026-07-20)
