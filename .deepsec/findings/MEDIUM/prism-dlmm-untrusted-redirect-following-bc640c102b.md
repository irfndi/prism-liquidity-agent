# [MEDIUM] Meteora Data API fetch follows redirects by default

**File:** [`engine/meteora-datapi-service.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/meteora-datapi-service.ts#L117-L119) (lines 117, 119)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** low  •  **Slug:** `untrusted-redirect-following`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

The `getPoolData` fetch (L119) uses `fetch(url, { signal: AbortSignal.timeout(...) })` with no `redirect` option, so a 3xx response from the Data API is silently followed. The URL is built as `${baseUrl}/pools/${poolAddress}` (L117) where `baseUrl` is operator config (`METEORA_DATA_API_URL`, default `https://dlmm.datapi.meteora.ag`) and `poolAddress` is a base58 Solana address (watchlist, on-chain discovery, or local DB) — so no direct SSRF/path injection is possible through the address. However, the response body is trusted and parsed into safety-critical signals (`isBlacklisted`, `tokenXFreezeAuthorityDisabled`, `is_verified`) that gate pool entry decisions. If the Data API ever returns a redirect to an attacker-controlled host, the attacker's JSON payload is parsed as if it were Meteora's data, letting them feed arbitrary pool stats and safety flags into the decision engine. No credentials are sent on this request, so the exposure is data-integrity rather than secret disclosure. Hardening: `redirect: "error"` and, ideally, verify the response's `address` matches the requested pool (see companion finding).

## Recommendation

Add `redirect: "error"` to the fetch and cross-check that the parsed response's `address` equals the requested `poolAddress` before applying the stats.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-22)
