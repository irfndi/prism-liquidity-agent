# [MEDIUM] RPC probe fetch follows redirects by default while HELIUS_API_KEY rides in the URL query string

**File:** [`cli/doctor.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/cli/doctor.ts#L140-L228) (lines 140, 194, 228)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** low  •  **Slug:** `ssrf`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

probeRpcEndpoint (L140) calls fetch(url) with the default `redirect: "follow"` and no `redirect: "manual"`. The URL can carry the HELIUS_API_KEY interpolated directly into the query string (L194: `https://mainnet.helius-rpc.com/?api-key=${helius}` and L228: `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`) without URL-encoding. The URLs originate from local env config (SOLANA_RPC_URL / SOLANA_RPC_FALLBACK_URL / HELIUS_API_KEY), so a remote attacker cannot trigger this directly, and per the fetch spec the query string is dropped when a redirect is followed — so the key is not forwarded to a redirect target. However, the key travels in the URL of every probe (visible in any proxy/access logs and in the literal URL used), is not percent-encoded (a key containing '&', '#', or '=' would corrupt the request), and the `getHealth returned unexpected result: ${JSON.stringify(json.result)}` error path (L139) is not passed through maskHeliusUrl, so a malicious or misbehaving RPC endpoint that echoes the request URL back in its JSON result would surface the raw key in doctor output. The masked error paths only cover the `api-key=`/`api_key=` lowercase spellings.

## Recommendation

Set `redirect: "manual"` on the RPC probe fetch and treat any 3xx response as an error; send the Helius key as an `Authorization`/`x-api-key` header instead of a URL query parameter, and URL-encode it if it must remain in the query string. Also route the `getHealth` unexpected-result message through maskHeliusUrl before including it in the check output.

## Recent committers (`git log`)

- irfndi <join.mantap@gmail.com> (2026-08-03)
