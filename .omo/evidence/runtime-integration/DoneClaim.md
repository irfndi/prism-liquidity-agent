# Runtime integration DoneClaim

## Implemented outcomes

- Recurring candidate discovery invokes lifecycle policy and persists candidate transitions before the empty-watchlist return.
- Autonomous live entry and EXIT persist execution operations before on-chain mutation.
- Entry preparation returns attributable swap receipts; partial preparation and post-funding ENTER failure create exact-amount rollback settlement jobs.
- Autonomous EXIT closes first, persists withdrawal and reward settlement jobs, closes the position with NULL realized PnL, and defers final net PnL until every position settlement confirms.
- Settlement jobs persist quote output/cost evidence, retry with capped backoff, recover submitted signatures through status checks, and finalize position PnL after execution costs.
- Wallet-scoped safety pauses persist for 5% drawdown, two core-data failure cycles, configured consecutive execution failures, and overdue settlement; ENTER/REBALANCE are blocked while EXIT/HOLD and settlement remain allowed.
- Shadow mode records decisions and leaves settlement jobs unchanged without adapter sends.

## Binary evidence

| Scenario | Invocation | Observable | Artifact |
| --- | --- | --- | --- |
| Baseline program/foundation | `bun run test -- bench/candidate-lifecycle.test.ts bench/autonomous-token-foundation.test.ts bench/program.test.ts` | 68 tests passed | `baseline-targeted.txt` |
| Runtime policy red phase | `bun run test -- bench/program-autonomous-token.test.ts` | Four named policy failures before implementation | `red-policy-behavior.txt` |
| Candidate, rollback contracts, DB migration, program regression | `bun run test -- bench/program-autonomous-token.test.ts bench/autonomous-token-foundation.test.ts bench/candidate-lifecycle.test.ts bench/entry-prep.test.ts bench/program.test.ts` | 109 tests passed | `targeted-final.txt` |
| Malformed/stale discovery and Jupiter data | `bun run test -- bench/adapter-swap.test.ts bench/adapter-discover.test.ts bench/candidate-lifecycle.test.ts` | 46 tests passed | `adversarial-final.txt` |
| Shadow zero-send and repeated retry | `bun .omo/evidence/runtime-integration/manual-driver.mjs` | `sends=0`; failed live settlement persisted `retryable`, attempts `1` | `manual-driver.txt` |
| Pause action allowlist | same manual driver | `enterAllowed=false`, `exitAllowed=true` | `manual-driver.txt` |
| Full TypeScript contract | `bunx tsc --noEmit` | exit 0, empty diagnostic log | `typecheck-final.txt` |
| Changed-file lint | `bunx oxlint ...` | exit 0, empty diagnostic log | `lint-final.txt` |
| Changed-file format | `bunx oxfmt --check ...` | all matched files formatted | `format-final.txt` |
| Dirty shared worktree preservation | `git status --short` | concurrent files recorded, no reset/revert performed | `dirty-worktree.txt` |
| Cleanup receipt | `git diff --check` | exit 0, no whitespace errors | `cleanup-receipt.txt` |

## Adversarial receipts

- Stale state: candidate lifecycle restart/cooldown fixtures and settlement signature-status recovery paths.
- Interrupted operation: durable planned operations plus retryable settlement state; the manual driver verifies failure persistence.
- Malformed external data: adapter discovery and swap suites reject malformed/stale/mismatched payloads.
- Repeated retry: deterministic exponential retry with a 300-second cap is covered by runtime policy tests.
- Misleading logs: assertions use persisted state and adapter send counts, not log text.
- Cleanup: no external resources or deployments were created; the manual driver uses in-memory fakes only.
