# [BUG] --days flag accepts Infinity/overflow values causing unbounded loop and process hang

**File:** [`cli/backtest.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/cli/backtest.ts#L45-L86) (lines 45, 46, 78, 86)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-logic-bug`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

The --days validation in parseArgs only rejects NaN and non-positive values: `if (Number.isNaN(parsed) || parsed <= 0)`. `Number("Infinity")` returns Infinity, which passes both checks (Number.isNaN(Infinity) is false, Infinity <= 0 is false). Additionally, any large finite value such as --days 1e308 overflows when multiplied: `ticks = (days * 24 * 60 * 60 * 1000) / intervalMs` (line 78) computes Infinity once days * 86,400,000 exceeds Number.MAX_VALUE (~1.8e308). In synthetic source mode, generateMockHistory then executes `for (let i = 0; i < ticks; i++)` (line 86) with ticks = Infinity, which never terminates, hanging the process indefinitely with no user-visible error. The replay source path is less affected (startMs becomes -Infinity and the SQL query returns nothing, producing a benign 'no snapshots' message), but synthetic mode hangs. Impact is limited to the local operator (CLI-only, no remote attacker), so this is a robustness/logic bug rather than a security vulnerability, but it defeats the validation's stated purpose ('Must be a positive number').

## Recommendation

Reject non-finite values explicitly and clamp days to a sane upper bound, e.g. `if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 3650) throw new Error(...)`, so both Infinity and overflow-to-Infinity inputs fail validation before the tick loop is constructed.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-13)
