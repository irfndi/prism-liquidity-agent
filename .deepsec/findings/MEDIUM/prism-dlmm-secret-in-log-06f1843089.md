# [MEDIUM] Incomplete credential redaction in retry error logging persists secrets to the audit trail

**File:** [`engine/adapter-retry.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/adapter-retry.ts#L53-L104) (lines 53, 54, 55, 56, 57, 104)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** low  •  **Slug:** `secret-in-log`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

safeErrorMessage() (L53-57) only redacts query-string params matching `[?&](api[-_]?key|token|authorization)=` and `Bearer <token>` values before the error string is written to the persistent audit trail (audit-trail.jsonl via logger.ts emit()). It does NOT redact: `X-API-Key` header format, camelCase `apiKey`/`api_key` JSON keys, `secret`/`password`/`key` query params, basic-auth userinfo in URLs (https://user:pass@host), or `x-api-key` style params. The Helius RPC key (appended as `?api-key=` by normalizeHeliusUrl in config-service.ts) is covered, but any other credential that appears in an RPC/HTTP error message in a non-covered format (e.g., a gateway token, Hermes API token, or webhook URL token in an error from the transports) is logged verbatim to the audit file. The log entry is also used as the dedup key in retryLogState, so redaction gaps are not a one-time event.

## Recommendation

Expand the redaction to cover common credential forms (X-API-Key headers, apiKey/api_key/secret/password/token keys in JSON bodies, URL userinfo) and normalize the error to a safe string form (e.g., extract err.message via a helper that handles non-Error objects) before logging. Consider scrubbing the entire error object with a recursive redactor before it reaches the audit stream.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-14)
