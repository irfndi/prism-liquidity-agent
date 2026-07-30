# CLI autonomous operator surface validation

## Candidate, operation, settlement, and pause visibility

- Scenario: a configured effective wallet with one durable candidate, prepared operation,
  retryable settlement, and active safety pause.
- Invocation: `prism status --json` and `prism status` from
  `manual-cli-smoke.ts`, with `PAPER_TRADING=true`.
- Binary observable: both commands exited `0`; JSON includes the four seeded records;
  human output reports shadow mode, one candidate, one operation, one settlement, and an
  active pause.
- Artifact: `manual-cli-smoke.json`.

## Manual pause resume

- Scenario: the active pause for that same effective wallet and `manual-smoke` instance.
- Invocation: `prism resume`, followed by `prism status --json` in `manual-cli-smoke.ts`.
- Binary observable: `resume` exited `0`; no transaction is invoked; the follow-up JSON
  reports `safetyPause.active: false` with a populated `resolvedAt`.
- Artifact: `manual-cli-smoke.json`.

## Regression and static validation

- Scenario: isolated temporary SQLite database covering JSON visibility and resume.
- Invocation: `bun run test -- bench/cli-autonomous-status.test.ts`.
- Binary observable: exit `0`, one test file and two tests passed.
- Artifact: `targeted-test.log`.

- Scenario: workspace TypeScript and lint validation.
- Invocation: `bun run lint`.
- Binary observable: exit `0` (`tsc --noEmit && oxlint engine ops bench cli`).
- Artifact: `lint.log`.

- Scenario: formatting for owned CLI/test files.
- Invocation: `bunx oxfmt --check cli/index.ts cli/resume.ts cli/status.ts cli/wallet.ts bench/cli-autonomous-status.test.ts`.
- Binary observable: exit `0`.
- Artifact: `owned-format-check.log`.

## Shared-worktree caveat

`bun run format:check` exits `1` only because concurrent changes leave
`engine/autonomous-runtime.ts` and `engine/db-service.ts` unformatted. The complete output
is preserved in `format-check.log`; neither is owned by this task.

The LSP daemon was unavailable at its configured socket on two direct diagnostics attempts.
The clean `bun run lint` TypeScript check is the available diagnostic evidence.
