# [MEDIUM] PAPER_MODE_EXIT_LIVE env var silently enables live on-chain EXITs in paper mode, bypassing the explicit --exit-live opt-in

**File:** [`cli/dev.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/cli/dev.ts#L43-L51) (lines 43, 49, 51)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-paper-live-boundary-bypass`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

The `--exit-live` flag is the documented, explicitly-warned opt-in for executing live EXIT transactions during paper trading. However, the engine reads `PAPER_MODE_EXIT_LIVE` directly from the environment: `cli/index.ts` and `engine/run-engine.ts` import `engine/load-env.ts` first, which runs `dotenv.config()` and loads the project `.env` into `process.env` BEFORE the flag handler executes. Since `PAPER_TRADING` defaults to `true` (config-service.ts:511) and `PAPER_MODE_EXIT_LIVE` defaults to false (config-service.ts:1160), a stale `PAPER_MODE_EXIT_LIVE=true` in `.env` (or a shell-exported var) means `prism dev` runs in paper mode and silently executes real on-chain EXIT transactions for any tracked live position — the warning at dev.ts:47-48 only fires when the flag is passed. In program.ts:6202, `paperExitShouldGoLive = config.paperTrading && decision.action === "EXIT" && pos?.positionPubKey && config.paperModeExitLive` routes to `executeLive`, which sends a real on-chain transaction (executeLive requires a configured wallet via `adapter.hasWallet()`, and WALLET_PRIVATE_KEY lives in the same `.env`). The safe path (executePaper, program.ts:967) explicitly skips EXITs for live positions with a warning. Net effect: a user who once set the var for an experiment, then runs `prism dev` expecting pure paper trading, will have real funds moved on-chain with no acknowledgment — the paper/live trust boundary fails open.

## Recommendation

Make live execution strictly opt-in per invocation: remove the engine's direct read of `PAPER_MODE_EXIT_LIVE` from the environment (or namespace it, e.g. `PRISM_PAPER_MODE_EXIT_LIVE`) and instead pass the flag via an explicit mechanism the CLI controls (e.g., a process-argument or a dedicated in-memory override that cannot be set via `.env`). At minimum, when the engine starts with `PAPER_MODE_EXIT_LIVE=true` and it was not set by the `--exit-live` flag, print the same warning and require an interactive confirmation (fail-closed) before enabling hybrid live execution.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-29)
