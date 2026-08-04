# [BUG] String(err) on non-Error objects yields '[object Object]', collapsing retry log dedup keys and losing error detail

**File:** [`engine/adapter-retry.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/adapter-retry.ts#L53-L104) (lines 53, 54, 95, 96, 97, 104)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-log-error-collapse`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

safeErrorMessage() uses String(err) to build the dedup key for retryLogState. For plain objects (e.g., raw JSON-RPC error objects with {code, message} that are not Error instances, or fetch Response-like objects), String(err) returns '[object Object]'. This has two consequences: (1) the actual error detail is never logged — the audit entry shows only '[object Object]', and (2) all distinct non-Error errors collapse to a single dedup key, so retries of different failures are suppressed as if they were the same error (RETRY_LOG_INTERVAL_MS window). This makes the retry log effectively useless for diagnosing non-Error failures.

## Recommendation

Use a dedicated error-normalizer that reads err.message (and err.code) for any object, falling back to JSON.stringify for objects without a message, before applying the redaction regexes.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-14)
