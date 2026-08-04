# [MEDIUM] Update pipeline never verifies the release GPG signature; integrity is anchored to the same untrusted source as the bundle

**File:** [`cli/update.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/cli/update.ts#L122-L540) (lines 122, 141, 158, 176, 480, 540)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-supply-chain-integrity`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

The update flow in `downloadAndVerify` (L158-178) verifies the downloaded tarball only against a SHA-256 checksum fetched from `sha256Url` — which is served from the same trust domain as the tarball itself (the R2 public bucket `pub-2f55c98709e74d1d900b89ec20f8f1fc.r2.dev` or the GitHub release). The `ReleaseInfo.signatureUrl` field (an `.asc` detached GPG signature) is populated by `engine/update-utils.ts` (githubReleaseToInfo L259-277, r2ManifestToInfo L280-296) and referenced by `scripts/generate-release-manifest.ts`, but cli/update.ts never fetches or verifies it. The `fetch` calls at L122 (bundle) and L141 (checksum) follow redirects by default, so a hijacked manifest URL can redirect to an attacker-controlled host and the client will happily follow. Attack scenario: an attacker who compromises the R2 bucket, the GitHub release account, or the R2 hostname (DNS/redirect) replaces the manifest with a malicious tarball_url + a matching sha256_url — the SHA-256 'integrity check' passes because it is same-source — and the malicious tarball is then extracted and executed: for source updates, `updateFromSource` runs `bun install` (which executes package postinstall scripts) and `bun run build` (L495-498) in the extracted tree; for bundle updates, the extracted bundle replaces the installed CLI. This yields arbitrary code execution on the user's machine with access to `WALLET_PRIVATE_KEY` (.env / keystore / env). This is acknowledged in AGENTS.md ('GPG signatures are generated but not yet verified client-side') as a known limitation, but it is a genuine, unmitigated supply-chain integrity weakness: the checksum provides no authenticity anchor separate from the hosting infrastructure.

## Recommendation

Verify the detached `.asc` signature against a pinned public key bundled with the CLI before installing (fail closed on mismatch). Additionally, pin the expected host for the R2/github URLs and reject cross-origin redirects (e.g., set `redirect: 'error'` or validate the final response URL origin), and consider fetching the SHA-256 checksum from a separate trust domain so a single compromised source cannot supply both the payload and its checksum.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-20)
- irfandi marsya <irfandi@users.noreply.github.com> (2026-07-20)
