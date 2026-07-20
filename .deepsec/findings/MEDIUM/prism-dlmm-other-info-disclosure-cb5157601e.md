# [MEDIUM] Heuristic secret redaction before exfiltrating error reports to a remote endpoint

**File:** [`engine/error-reporter.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/error-reporter.ts#L66-L262) (lines 66, 89, 92, 96, 190, 218, 262)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** low  •  **Slug:** `other-info-disclosure`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

Error reports are sent to a remote third-party endpoint (DEFAULT_ERROR_ENDPOINT = https://prism-api.irfndi.workers.dev/v1/errors/batch) and reporting is implicitly ENABLED by default whenever a credentials file exists (constructor: implicitReporting = reportingEnv !== 'false' && (reportingEnv === 'true' || hasCredentials)). The only safeguard preventing the top threat (WALLET_PRIVATE_KEY theft) from leaking off-host is the regex-based sanitizeMessage()/sanitizeStack(). This redaction is purely heuristic: BASE58_LONG_PATTERN only matches base58 runs >= 64 chars, HEX patterns require >= 64 hex chars, and SECRET_PATTERN/PASSWORD_PATTERN require an explicit 'private_key/secret/mnemonic/password =' keyword prefix. A secret that reaches an Error message/stack in a non-standard form — e.g. a key serialized as a JSON byte array, a mnemonic phrase without the keyword prefix, a key fragmented across tokens/lines, or a shorter derived secret — would not be redacted and would be POSTed to the remote endpoint with the user's Bearer API key. Because the destination is remote and enabled by default, any redaction gap turns into off-host secret disclosure.

## Recommendation

Treat redaction as defense-in-depth, not the sole control: (1) never place raw key material in Error messages/stacks at the source; (2) strengthen sanitization to also scrub JSON byte-array key forms and mnemonic word-lists, and consider redacting any high-entropy token regardless of length/keyword; (3) make remote error reporting opt-IN rather than default-on when credentials exist, or strip/avoid transmitting stack frames that originate near wallet-handling code.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-13)
