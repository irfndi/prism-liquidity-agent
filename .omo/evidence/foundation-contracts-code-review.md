# Code quality review — autonomous-token shared foundation

## Scope and evidence inspected

- Goal: autonomous-token config/domain-type foundation and migration v20 durability.
- Changed files inspected: `engine/config-service.ts`, `engine/types.ts`, `engine/errors.ts`, `engine/db.ts`, `engine/services.ts`, `engine/db-service.ts`, `bench/autonomous-token-foundation.test.ts`, plus required fixture updates in `bench/helpers.ts` and `bench/program.test.ts`.
- Prior evidence inspected as untrusted input: `.omo/evidence/foundation-contracts-final-audit-20260730/judgment.json` and the underlying static/test logs. It includes concrete artifact paths and its reported targeted checks are reproducible; it is not misleading success output.
- ULW status was queried. No ULW plan exists, so this report uses the mandated fallback path.

## Verification performed

- `bun run test -- bench/autonomous-token-foundation.test.ts` — PASS (1 file, 10 tests).
- `bunx tsc --noEmit` — PASS.
- `bun run lint` (`tsc --noEmit && oxlint engine ops bench cli`) — PASS.
- `git diff --check` — PASS.
- `bun run format:check` — FAILS only for pre-existing, unmodified `engine/program.ts`; touched foundation files were independently reported formatted in the prior evidence. This is not attributable to this diff.
- Migration/restart test was inspected and executed. It opens one database twice and verifies all four v20 tables plus exactly one migration marker (`bench/autonomous-token-foundation.test.ts:109-143`).
- Invalid enum/status probes were inspected and executed. SQLite checks reject an invalid candidate state plus invalid execution/settlement statuses (`bench/autonomous-token-foundation.test.ts:145-195`).
- Dirty-worktree probe: at the time of the review snapshot, exactly the eight expected foundation files were modified/new and no unrelated diff was observed. A concurrent worker subsequently modified `bench/adapter-swap.test.ts`; it was not reviewed or reverted. The existing `engine/program.ts` formatting drift predates and is outside this scope.

## Skill-perspective check

Ran: yes. Consulted `omo:remove-ai-slops` and `omo:programming` (including its TypeScript reference) before judging tests and maintainability.

- `remove-ai-slops`: no deletion-only, prompt-text, tautological, or implementation-constant-mirroring tests found. The temporary-file DB tests exercise observable persistence behavior. The added row enum parsers are justified at the untyped SQLite boundary; they are not needless production normalization.
- `programming`: the diff does violate the strict-type/size perspective in the two MEDIUM findings below. It has no new `any`, non-null assertion, prompt test, or untyped production escape hatch.

## Findings

### CRITICAL

None.

### HIGH

None.

### MEDIUM

1. `AppConfig` makes every new autonomous-token control optional even though `ConfigLive` always produces all of them. `engine/config-service.ts:95-108` advertises absence as a valid production state, defeating the type system for controls such as autonomous mode, settlement asset, and safety limits. The comments used for older optional fields do not apply here, because this change already updates the shared test fixture (`bench/helpers.ts:101-114`). Make these fields required and update any remaining fixtures rather than carrying optionality into future production consumers.

2. `AGENT_INSTANCE_ID` accepts empty or whitespace-only values. `engine/config-service.ts:552-554` reads the raw string without a non-empty/trimmed validation, while every v20 isolation key persists it as `NOT NULL` only (`engine/db.ts:814`, `engine/db.ts:844`, `engine/db.ts:862`, `engine/db.ts:887`). Consequently a malformed explicit value can silently collapse autonomous state from multiple processes into the same `(wallet_address, "", ...)` namespace. Reject blank/whitespace values at the config boundary and add an adversarial config test.

3. The new 379-line persistence block is appended to the already oversized `engine/db-service.ts` (`engine/db-service.ts:1047-1419`), and 92 domain lines are appended to the already oversized `engine/types.ts` (`engine/types.ts:1-91`). This violates both consulted skills' 250-pure-LOC maintainability rule and makes the DB service harder to evolve. Extract the autonomous-token record types and repository/row-mapping implementation into concept-named modules while retaining the `DbService` interface seam.

4. Regression coverage does not prove a pre-v20 upgrade path or malformed agent identity handling. The restart test begins with a brand-new database (`bench/autonomous-token-foundation.test.ts:109-117`), so it would not detect an error that occurs only when the database has migrations 1–19 recorded. Add a v19-marker fixture upgraded through `createDatabase`, and add blank `AGENT_INSTANCE_ID` rejection coverage. This is missing behavioral coverage, not a request to test a requested removal.

### LOW

None.

## Verdict

- `codeQualityStatus`: WATCH
- `recommendation`: APPROVE
- `blockers`: none (there are no CRITICAL or HIGH findings).

The implementation's core foundation claim is confirmed: config mode handling, v20 schema creation/restart idempotence, SQLite status constraints, and the DbService round trip all pass. Approval is conditional only in the ordinary sense that the MEDIUM items should be scheduled before autonomous execution consumers are introduced.
