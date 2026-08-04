# [MEDIUM] API key required as positional CLI argument exposes it in process list and shell history

**File:** [`cli/login.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/cli/login.ts#L12-L14) (lines 12, 13, 14)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-info-disclosure`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

`prism login <key>` (defined at L12 `.argument("<key>", ...)` and consumed at L13-14) accepts the full API key as a mandatory positional command-line argument with no stdin/env/file alternative. On Unix systems, argv is visible to other local users via `ps`/`/proc/<pid>/cmdline` for the duration of the request (L14 sends it to the API), and the complete secret is durably recorded in the invoking user's shell history (e.g. ~/.zsh_history). The repo's own threat model lists API-key compromise as a primary threat, and this key authenticates all cloud account operations. The scanner-flagged L14 'secret-in-log' is a false positive (the key is passed into prismApiPost's Authorization header, not logged), and the L32 console output is only a benign 12-char prefix of a 160-bit key, but the argv exposure is real. Exploitability requires local/shared-host access, which is why this is MEDIUM rather than HIGH.

## Recommendation

Support lower-exposure input paths: accept the key via an interactive stdin prompt (`prism login` reading secretly), a PRISM_API_KEY environment variable, or a file path argument, and keep the argv form optional with a warning. At minimum, document the shell-history exposure.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-06-03)
