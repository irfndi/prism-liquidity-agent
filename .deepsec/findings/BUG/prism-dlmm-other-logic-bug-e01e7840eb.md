# [BUG] PAPER_TRADING boolean parsing inconsistent with engine: doctor reports 'paper trading' when engine runs live

**File:** [`cli/doctor.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/cli/doctor.ts#L108-L238) (lines 108, 238)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-logic-bug`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

doctor.ts gates the wallet check and RPC advice on `process.env.PAPER_TRADING !== "false"` (L108 in checkRpc, L238 in checkWallet), which only treats the literal string "false" as live trading. The engine (engine/config-service.ts) reads PAPER_TRADING via Effect's Config.boolean, whose parser accepts "0", "no", and "off" as false (verified in node_modules/effect/dist/esm/internal/config.js:34-48). For any of these values the engine runs LIVE trading while `prism doctor` reports "Paper trading is enabled; no private key required" and marks the wallet check as PASS. A user who sets PAPER_TRADING=0 (a common way to express 'off') intending live trading — or who expects paper mode from a value like 'no'/'off' — gets a misleading PASS from the exact diagnostic they run to validate their setup. The wallet check skipping can leave a live-trading deployment without WALLET_PRIVATE_KEY/keystore, and a user who believes doctor's 'paper trading' verdict may not realize the engine is placing real on-chain trades. The same `!== "false"` idiom is safe for PRISM_ERROR_REPORTING (error-reporter.ts uses the identical check), so the inconsistency is specific to PAPER_TRADING.

## Recommendation

Parse PAPER_TRADING with the same semantics as the engine (e.g., use Effect's Config.boolean or a shared helper that treats 'true'/'yes'/'on'/'1' as true and 'false'/'no'/'off'/'0' as false). Consider extracting a single shared boolean-env parser used by both the engine and the CLI so diagnostics can never diverge from runtime behavior.

## Recent committers (`git log`)

- irfndi <join.mantap@gmail.com> (2026-08-03)
