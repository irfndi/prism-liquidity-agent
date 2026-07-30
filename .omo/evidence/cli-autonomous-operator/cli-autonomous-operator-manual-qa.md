# Manual QA: cli-autonomous-operator

## surfaceEvidence

| Scenario | Criterion | Surface | Exact invocation | Verdict | Artifact refs |
|---|---|---|---|---|---|
| S1 | Autonomous operator visibility in paper/shadow mode | Bun CLI JSON status against isolated SQLite DB seeded with candidate, operation, settlement, and active pause | Exported `PAPER_TRADING=true AUTONOMOUS_TOKEN_MODE=shadow AGENT_INSTANCE_ID=qa-operator SQLITE_DB_PATH=<temp>/prism.db WALLET_PRIVATE_KEY=<ephemeral>`, then `bun cli/index.ts status --json` | PASS | A1, A2 |
| S2 | Pause/resume operator lifecycle | Bun CLI resume then status JSON against the same exported environment and isolated DB | `bun cli/index.ts resume`; then `bun cli/index.ts status --json` | PASS | A3, A4 |
| S3 | Candidate observation persistence across restart | Candidate driver in two separate Bun processes sharing one SQLite file; phase 1 persists observing count 1, phase 2 reloads and advances to eligible count 2 | `PHASE=seed bun .omo/evidence/cli-autonomous-operator/candidate-restart.ts`; new process `PHASE=resume bun .omo/evidence/cli-autonomous-operator/candidate-restart.ts` | PASS | A5, A6, A7 |
| S4 | Shadow mode does not submit settlement swaps | Runtime settlement processor with mode `shadow` and adapter methods that fail if called | `bun .omo/evidence/cli-autonomous-operator/shadow-no-send.ts` | PASS | A8 |
| S5 | Candidate/config/DB lifecycle regression coverage | Bun Vitest targeted autonomous suites | `bun run test -- bench/autonomous-token-foundation.test.ts bench/candidate-lifecycle.test.ts bench/candidate-discovery.integration.test.ts bench/program-autonomous-token.test.ts bench/cli-autonomous-status.test.ts` | PASS | A9 |
| S6 | Repository build and static checks | Engine build, TypeScript/lint, and format check | `bun run build`; `bun run lint`; `bun run format:check` | PASS | A10, A11, A12 |
| S7 | Full regression suite | Full Bun Vitest suite | `bun run test` | PASS | A13 |

## adversarialCases

| Scenario | Criterion | Adversarial class | Expected behavior | Verdict | Artifact refs |
|---|---|---|---|---|---|
| ADV1 | No live sends in shadow | execution side-effect suppression | Settlement processing returns the job unchanged and invokes zero adapter send/quote methods | PASS | A8 |
| ADV2 | Candidate evidence failure handling | transient price/route/market-data failure | Healthy streak resets to observing with count 0; it does not become eligible | PASS | A9 |
| ADV3 | Candidate safety rejection | hard safety failure | Candidate enters durable rejected state with rejection reason | PASS | A9 |
| ADV4 | Safety pause action policy | paused-risk action | ENTER and REBALANCE are denied while EXIT and HOLD remain allowed | PASS | A9 |
| ADV5 | Restart/idempotent storage | process restart / schema durability | Existing candidate survives a second process and reaches eligibility exactly once; migration tables remain idempotent | PASS | A6, A9 |

## artifactRefs

| ID | Kind | Description | Path |
|---|---|---|---|
| A1 | cli-json | Shadow status before resume, showing candidate, operation, settlement, and active pause | `.omo/evidence/cli-autonomous-operator/cli-status-before.json` |
| A2 | invocation-log | Temp DB, wallet identity, and isolated scenario details | `.omo/evidence/cli-autonomous-operator/cli-process-scenario.txt` |
| A3 | cli-text | Resume command confirmation | `.omo/evidence/cli-autonomous-operator/cli-resume.txt` |
| A4 | cli-json | Shadow status after resume, showing safetyPause.active=false | `.omo/evidence/cli-autonomous-operator/cli-status-after.json` |
| A5 | process-json | First process persisted candidate in observing state | `.omo/evidence/cli-autonomous-operator/candidate-restart-seed.json` |
| A6 | process-json | Second process reloaded candidate and advanced it to eligible | `.omo/evidence/cli-autonomous-operator/candidate-restart-resume.json` |
| A7 | invocation-log | Shared SQLite path and two-process invocation | `.omo/evidence/cli-autonomous-operator/candidate-restart-invocation.txt` |
| A8 | runtime-json | Shadow settlement result with sends: 0 and unchanged: true | `.omo/evidence/cli-autonomous-operator/shadow-no-send.json` |
| A9 | test-log | 5 autonomous suites, 28 tests passed | `.omo/evidence/cli-autonomous-operator/targeted-autonomous-tests.log` |
| A10 | build-log | bun run build exit 0 | `.omo/evidence/cli-autonomous-operator/build.log` |
| A11 | lint-log | bun run lint (tsc + oxlint) exit 0 | `.omo/evidence/cli-autonomous-operator/lint.log` |
| A12 | format-log | bun run format:check exit 0 | `.omo/evidence/cli-autonomous-operator/format-check.log` |
| A13 | test-log | Full suite: 108 files, 1349 tests passed, exit 0 | `.omo/evidence/cli-autonomous-operator/full-test.log` |
