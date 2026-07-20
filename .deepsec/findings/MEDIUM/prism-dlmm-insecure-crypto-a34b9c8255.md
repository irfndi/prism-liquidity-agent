# [MEDIUM] Predictable Math.random used for request/response correlation IDs

**File:** [`engine/gateway-transport.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/gateway-transport.ts#L209-L222) (lines 209, 222)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** low  •  **Slug:** `insecure-crypto`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

sendPrompt (L209) and sendCheckin (L222) build correlation IDs as `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`. These IDs key the `pending` map that handleMessage (L275-299) uses to resolve a pending promise with the gateway's `text` payload, which becomes the advisor `raw` response that can influence ENTER/EXIT/REBALANCE/HOLD decisions. Math.random is a non-cryptographic, predictable PRNG. In isolation this is not directly exploitable: the WebSocket is a point-to-point connection to an operator-configured gateway, authenticated once at open with a bearer token, so the real security boundary is the WS channel rather than the ID. Exploitation would require an attacker able to inject frames into that channel (e.g. a compromised/shared gateway or a plaintext ws:// MITM — the transport does not enforce wss://), after which predictable IDs would make response hijacking/injection easier. Flagged as defense-in-depth given the IDs gate decision-influencing messages.

## Recommendation

Generate correlation IDs with a CSPRNG (e.g. crypto.randomUUID() or crypto.randomBytes) instead of Math.random, and consider enforcing/validating a wss:// URL so the auth token and advisor responses are not exposed to plaintext MITM.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-17)
