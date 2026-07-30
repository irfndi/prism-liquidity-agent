# Generic Jupiter swap DoneClaim evidence

## Focused integration scenarios

- Invocation: `bun run test -- bench/adapter-swap.test.ts bench/entry-prep.test.ts`
- Binary observable: exit 0; 2 files passed; 54 tests passed.
- Scenarios: generic SOL-to-token route, legacy and versioned transaction decoding, stale quote, excessive price impact, mint mismatch, malformed transaction, no-fallback price evidence, typed signature status, SOL-funded entry, quote/prepare/simulate preflight, and mid-operation partial submission.
- Artifact: `verification-passed.log`

## Static and formatting gates

- Invocations: `bunx tsc --noEmit --pretty false`; focused `bunx oxlint`; focused `bunx oxfmt --check`; `git diff --check`.
- Binary observable: the captured `set -e` verification session exited 0. TypeScript and oxlint emitted no diagnostics; oxfmt reported all matched files correctly formatted.
- Artifact: `verification-passed.log`

## Isolated mocked-Jupiter manual QA

- Invocation: `bun .omo/evidence/generic-swap/manual-driver.ts`
- Binary observable: `safe: true`.
- Mint mismatch: rejected; 0 swap-build calls; 0 transaction sends.
- Stale quote (>30s): rejected; 0 swap-build calls; 0 transaction sends.
- Excessive impact (>100bps): rejected; 0 swap-build calls; 0 transaction sends.
- Malformed external transaction payload: rejected after one build response; 0 transaction sends.
- Artifacts: `manual-driver-final.log`, `manual-driver-output.json`.

## Adversarial partial-operation and logging probe

- Invocation: focused Vitest command above, scenario `reports the exact partial submission count when a SOL-funded route fails mid-operation`.
- Binary observable: first of two submissions changes only the first mocked token balance; second fails; error reports `1 of 2`; completion log predicate remains false.
- Artifact: `verification-passed.log`.

## Delayed-confirmation regression

- Red invocation: `bun run test -- bench/adapter-swap.test.ts -t "does not resolve a submitted swap until RPC confirmation propagates"`.
- Red observable: confirmation expected once but called zero times; 1 test failed.
- Fix: generic `submitSwap` now awaits `confirmTransaction`, rejects a non-null confirmation error, and only then invalidates balance caches and returns.
- Green invocation: focused adapter + entry-prep suite.
- Green observable: exit 0; 2 files passed; 55 tests passed; TypeScript, oxlint, oxfmt, and diff checks passed with `VERIFICATION_EXIT_0`.
- Manual QA: `bun .omo/evidence/generic-swap/confirmation-driver.ts`.
- Manual observable: `safe: true`, one confirmation call, unsettled before confirmation, settled after confirmation.
- Artifacts: `confirmation-fix-verification.log`, `confirmation-driver-output.json`.
