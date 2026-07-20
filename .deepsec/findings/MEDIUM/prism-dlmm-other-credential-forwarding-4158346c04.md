# [MEDIUM] GitHub Bearer token forwarded to unvalidated pagination URL taken from response Link header

**File:** [`engine/update-utils.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/update-utils.ts#L188-L216) (lines 188, 190, 194, 214, 216)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** low  •  **Slug:** `other-credential-forwarding`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

fetchGitHubRelease (L119-231) paginates by reading the `Link` response header (`nextLink.match(/<([^>]+)>;\s*rel="next"/)`, L214-216) and then issues `fetch(pageUrl!, { headers: pageHeaders })` where pageHeaders again carries `Authorization: Bearer ${token}` (L188-194). The pageUrl host is never validated against api.github.com before the credential is attached. If the GitHub API response were ever tampered with (compromised CDN/proxy, a future change that makes the base URL configurable, or a TLS MITM with a trusted cert), an attacker-controlled Link header would cause the configured GITHUB_TOKEN (config.githubToken, passed from update-check.ts) to be sent to an attacker domain, leaking a credential that may grant repo access. The same token is also attached on the default `redirect: follow` behavior. Exploitability is low today because the initial request is pinned to https://api.github.com, but the credential-forwarding sink itself is unguarded.

## Recommendation

Before attaching the Authorization header to a pagination request, parse pageUrl and assert its origin is exactly https://api.github.com; otherwise stop pagination. Consider setting `redirect: "error"` (or "manual") on these fetches so a redirect cannot silently carry the token to another host.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-13)
