# [MEDIUM] Attacker-controlled on-chain token symbols printed unsanitized to the terminal

**File:** [`cli/portfolio.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/cli/portfolio.ts#L97-L213) (lines 97, 111, 213)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-terminal-escape-injection`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

formatPosition() builds `poolName` from `pos.tokenXSymbol`/`pos.tokenYSymbol` (line 97) and prints it directly to stdout (line 111), and formatHistoryList() does the same at line 213. These symbols originate from on-chain token metadata fetched via Helius DAS in engine/adapter-service.ts:736 (`symbol: json?.result?.content?.metadata?.symbol ?? mint.slice(0, 4)`) with zero sanitization, are stored verbatim into SQLite by engine/db-service.ts (token_x_symbol upserts at lines 153/167/194, read back via `String(row.token_x_symbol ?? "")` at 1501/1564), and are rendered raw in the CLI. Any Solana user can mint a token whose metadata symbol contains ANSI escape sequences or control characters (e.g. \x1b[2J screen clear, \x1b]0;...\x07 title set, carriage returns, or terminal query/response sequences). Since the project's own threat model anticipates the agent entering hostile/rug pools, a scam pool on the watchlist with a crafted symbol injects escape sequences into the operator's terminal whenever they run `prism portfolio` or `prism portfolio history`. Impact: terminal state manipulation and UI spoofing (hiding positions, forging output/prompts), and on terminals honoring response escape sequences, potential keystroke/command injection. The NO_COLOR guard only disables the color wrapper; symbol text is always printed. The --json paths are incidentally safe because JSON.stringify escapes control chars.

## Recommendation

Sanitize untrusted display strings before printing: strip or escape C0/C1 control characters and ESC (e.g. replace /[\x00-\x1f\x7f\x80-\x9f]/g with a placeholder) on tokenXSymbol/tokenYSymbol at the display sink in cli/portfolio.ts, or ideally at ingestion in engine/adapter-service.ts so all consumers (CLI, Telegram alerts, logs) are protected.

## Recent committers (`git log`)

- irfandi marsya <join.mantap@gmail.com> (2026-07-19)
