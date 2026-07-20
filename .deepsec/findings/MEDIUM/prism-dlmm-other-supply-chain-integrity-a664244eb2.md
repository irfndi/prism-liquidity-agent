# [MEDIUM] Update mechanism lacks GPG signature verification despite populating signatureUrl

**File:** [`cli/update.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/cli/update.ts#L159-L176) (lines 159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-supply-chain-integrity`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

The update flow in downloadAndVerify() only verifies SHA-256 checksums fetched from the same untrusted source (R2 bucket or GitHub releases) as the bundle itself. The ReleaseInfo interface includes a signatureUrl field that is correctly populated from .asc GPG signature assets (engine/update-utils.ts L250, L268, L285), but cli/update.ts never fetches or verifies these signatures. If the R2 bucket (pub-2f55c98709e74d1d900b89ec20f8f1fc.r2.dev) or GitHub release is compromised, an attacker can serve a malicious bundle with a matching SHA-256 checksum, achieving arbitrary code execution on all users who run 'prism update'. The SHA-256 check only protects against transit corruption, not source compromise, since both the bundle and its hash originate from the same trust boundary.

## Recommendation

Implement GPG signature verification using the already-populated signatureUrl field. Fetch the .asc signature, verify it against a pinned public key bundled with the CLI, and refuse to install if verification fails. This creates a separate trust boundary from the hosting infrastructure.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-18)
