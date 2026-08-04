# [MEDIUM] fetch follows redirects by default on Hermes API transport, forwarding the bearer token within the redirect scope

**File:** [`engine/hermes-api-transport.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/hermes-api-transport.ts#L57-L140) (lines 57, 129, 140)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** low  •  **Slug:** `untrusted-redirect-following`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

Both `isAvailable()` (L57) and `chatCompletion()` (L140) call `fetch()` without a `redirect` option, so the default `redirect: "follow"` applies. The transport also attaches `Authorization: Bearer <token>` on every request (L129). The URL comes from operator config (`AGENT_HERMES_API_URL`) and is not user-controlled, so exploitability is limited today — but this transport only ever talks to a fixed API endpoint and must never follow a redirect. If the configured Hermes server is later compromised, misconfigured, or returns a 3xx (e.g. an http->https scheme change or a stale path), the fetch will transparently follow it and the Authorization header is preserved on same-origin redirects (cross-origin redirects strip it per the fetch spec, but the request/response body still reaches the redirect target). A redirect to a host serving an OpenAI-compatible API could receive the secret token and mirror the agent's decision prompts. Recommended hardening: `redirect: "error"` (or `"manual"`) so any redirect is surfaced as a failure instead of silently followed.

## Recommendation

Add `redirect: "error"` to both fetch calls (health check and chat completions). The transport is a fixed API endpoint client; it should never follow redirects.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-21)
