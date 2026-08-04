# [MEDIUM] Copy-signal feed signature never verified — wallet allowlist is forgeable

**File:** [`engine/copy-trading-signals.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/copy-trading-signals.ts#L18-L132) (lines 18, 77, 101, 130, 132)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** low  •  **Slug:** `other-unverified-signature`

## Owners

**Suggested assignee:** `irfandi@users.noreply.github.com` _(via last-committer)_

## Finding

The copy-signal relay payload carries a `signature` field (L18, L77) that is accepted string-typed and used only as part of a dedupe key (L130) — it is never cryptographically verified against the claiming wallet's public key. The allowlist gate (L132 `allowed.has(signal.wallet)`) matches a self-declared string in the response body, so anyone who can influence the endpoint response (MITM on a plain-HTTP deployment, compromised or rogue relay, or a public relay that mixes trusted and untrusted sources) can emit a signal claiming any allowlisted wallet and have it accepted. The fetch (L101) carries no auth headers or response signature checks. Accepted signals boost ENTER/redeploy decision confidence by up to 0.05 (applied at program.ts L5962-5978 before risk evaluation), which can push a marginal pool over the confidence threshold. Impact is bounded (max 0.05 boost, pool must already be scanned, other risk gates still apply) and the endpoint is operator-configured, so severity is limited — but the wallet-allowlist trust boundary is effectively cosmetic. The scanner's 'timing-unsafe signature comparison' flag at L77 is a false positive (no comparison exists); the underlying unverified-signature design is the real issue.

## Recommendation

Verify `signature` as a Solana ed25519 signature over (wallet, poolAddress, action, observedAt) against the claimed wallet pubkey before accepting the signal, or require the endpoint to be served over authenticated TLS with a pinned cert and document the relay as the trust anchor.

## Recent committers (`git log`)

- irfandi marsya <irfandi@users.noreply.github.com> (2026-07-20)
- irfandi marsya <join.mantap@gmail.com> (2026-07-19)
