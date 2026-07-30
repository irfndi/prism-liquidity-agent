# Code quality review — candidate lifecycle and discovery policy

## Scope and evidence inspected

- Goal reviewed: make the candidate lifecycle durable and eligible only after six healthy scans over at least one hour; reset on transient failures; permanently reject hard-safety failures; retain state over restart; rotate discovery pages fairly and fail closed on malformed discovery metadata.
- Files inspected: `engine/candidate-policy.ts`, `engine/discovery-policy.ts`, `bench/candidate-lifecycle.test.ts`, `bench/adapter-discover.test.ts`, `engine/adapter-service.ts`, `engine/screener-service.ts`, `engine/program.ts`, and the foundation persistence/config files and tests.
- Untrusted evidence inspected: `.omo/evidence/candidate-lifecycle-verification.md`, its driver JSON, and its referenced logs. The artifact paths exist and the focused commands were reproducible, but the evidence only proves pure helper behavior; it does not establish production wiring.
- ULW status was queried. There is no ULW plan, so this report is at the required fallback path.

## Verification performed

- `bun run test -- bench/candidate-lifecycle.test.ts bench/autonomous-token-foundation.test.ts bench/adapter-discover.test.ts` — PASS: 3 files, 40 tests.
- `bun run test -- bench/candidate-lifecycle.test.ts --reporter=verbose` — PASS: 8 tests.
- `bun run lint` (`tsc --noEmit && oxlint engine ops bench cli`) — PASS.
- `bunx oxfmt --check engine/candidate-policy.ts engine/discovery-policy.ts bench/candidate-lifecycle.test.ts bench/adapter-discover.test.ts` — PASS.
- `bun run format:check` — FAILS solely on unmodified, out-of-scope `engine/program.ts`; the four lifecycle/discovery files above are formatted.
- `git diff --check` — PASS.
- Manual reducer driver — PASS: after scans at `1,2,3,4,5,3600000`, it produced `eligible`, count 6, and `eligibleAt: 3600000`; a route transient reset it to observing/count 0; a subsequent hard failure remained rejected after a healthy scan.
- Repository-wide consumer search — FAIL: `candidate-policy.ts` is imported only by `bench/candidate-lifecycle.test.ts`; `discovery-policy.ts` is imported only by `bench/adapter-discover.test.ts`. `AdapterLive.discoverPools` still constructs and fetches the fixed configured URL directly.

## Skill-perspective check

Ran: yes. Consulted `omo:remove-ai-slops` and `omo:programming`, including the TypeScript reference, before judging test relevance and maintainability.

- `remove-ai-slops`: the tests are not deletion-only or prompt-text tests, and persistence/config extraction is not gratuitous. However, the pagination tests and their production helper are dead with respect to the runtime, and the lifecycle tests give false confidence about an uninvoked feature.
- `programming`: violated by a catch-all boundary in `engine/discovery-policy.ts:33-40` that neither narrows `URL`'s expected error nor rethrows unexpected errors. More importantly, the new typed policy is not connected to its required production boundary. No `any`, non-null assertion, or production type assertion was introduced in the two policy modules.

## Findings

### CRITICAL

None.

### HIGH

1. The candidate lifecycle never runs in production. `engine/candidate-policy.ts` has no engine consumer; only its unit test imports it. No scan creates or loads a candidate, evaluates health, calls `transitionCandidate`, or saves the returned record through `DbService`. Therefore the claimed six-scan/hour gate, transient reset, permanent rejection, and restart continuity have no effect on a running agent. Wire the policy through the scan/discovery flow and persist/load by the candidate identity, then add an integration test that invokes that flow across a database reopen.

2. Discovery rotation and malformed-page handling are dead code. `engine/discovery-policy.ts:12-40` is called only by `bench/adapter-discover.test.ts:521-548`; `engine/adapter-service.ts:3028-3034` still fetches the configured URL verbatim and never reads page metadata, increments a scan ordinal, or calls either helper. Thus recurring scans always request the same page and malformed pagination cannot fail closed in production. Integrate the page-selection/URL-building policy at the adapter discovery boundary and test two real consecutive discovery calls.

### MEDIUM

1. The test named “resets a healthy streak on transient price, route, or market-data failures” only constructs `market_data_unavailable`; its false market-data flag wins before the route and price conditions are evaluated. `bench/candidate-lifecycle.test.ts:72-102`. It does not pin route failure, stale price evidence, fallback price evidence, or screener rejection. Split these into independent observable health/reducer cases; this is false-confidence coverage rather than a test of the described alternatives.

2. The “only after six healthy scans” test has no pre-threshold assertion. `bench/candidate-lifecycle.test.ts:53-70` observes eligibility after six scans, but would remain green if the threshold regressed to five or fewer. Assert that the candidate remains `observing` after the fifth healthy scan (and separately before the one-hour observation boundary).

3. `engine/discovery-policy.ts:33-40` swallows every exception from URL construction. Per the programming perspective, the catch must narrow the known `TypeError` at this untrusted-input boundary or rethrow unknown errors. This is a maintainability/safety issue, not a reason to remove malformed-URL handling.

### LOW

1. `engine/candidate-policy.ts` is 240 pure LOC, inside the programming skill’s 200–250 warning band. It currently has one responsibility (candidate state reduction), so a split is not justified now; avoid adding more responsibilities to this module.

## Verdict

- `codeQualityStatus`: BLOCK
- `recommendation`: REQUEST_CHANGES
- `blockers`:
  1. Wire candidate lifecycle state evaluation and durable persistence into the production scan path, with a restart integration test.
  2. Wire recurring discovery page rotation and malformed metadata handling into `AdapterLive.discoverPools`, with consecutive-call integration coverage.

The pure reducer behavior is confirmed, and targeted tests/typecheck/lint pass. The delivered candidate and rotation behaviors are nevertheless not executable by the agent, so they cannot be approved as completed lifecycle functionality.
