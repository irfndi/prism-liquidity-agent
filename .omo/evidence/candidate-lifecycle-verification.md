# Candidate lifecycle verification

| Scenario | Invocation | Binary observable | Captured artifact |
| --- | --- | --- | --- |
| Existing adapter discovery contract | `bun run test -- bench/adapter-discover.test.ts -t "AdapterService.discoverPools"` | exit 0; 16 adapter-contract tests passed | `candidate-lifecycle-baseline-adapter-discover.log` |
| Reducer and discovery helper red phase | `bun run test -- bench/candidate-lifecycle.test.ts bench/adapter-discover.test.ts` | exit 1 because the new module was absent | `candidate-lifecycle-red.log` |
| Empty required-mints hardening red phase | `bun run test -- bench/candidate-lifecycle.test.ts` | exit 1; an empty required-mint list incorrectly produced `healthy` | `candidate-lifecycle-empty-mints-red.log` |
| Lifecycle, price-health, malformed-page, and rotation tests | `bun run test -- bench/candidate-lifecycle.test.ts bench/adapter-discover.test.ts` | exit 0; 27 tests passed | `candidate-lifecycle-targeted.log` |
| TypeScript compilation | `bunx tsc --noEmit` | exit 0 | `candidate-lifecycle-tsc.log` |
| Changed-file lint | `bunx oxlint engine/candidate-policy.ts engine/discovery-policy.ts bench/candidate-lifecycle.test.ts bench/adapter-discover.test.ts` | exit 0 | `candidate-lifecycle-oxlint.log` |
| Changed-file formatting | `bunx oxfmt --check engine/candidate-policy.ts engine/discovery-policy.ts bench/candidate-lifecycle.test.ts bench/adapter-discover.test.ts` | exit 0; all files formatted | `candidate-lifecycle-oxfmt.log` |
| Manual pure-policy driver | `bun -e <candidate lifecycle driver>` | JSON records eligibility at 6 scans/1h, streak reset, hard rejection, restart promotion, page rotation, and malformed page rejection | `candidate-lifecycle-driver.json` |

The candidate and discovery policy modules have no logging dependency; callers receive typed state and health results, so logs cannot be treated as lifecycle evidence.
