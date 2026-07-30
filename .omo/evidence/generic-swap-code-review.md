# Generic swap confirmation-fix code review

## Verdict

- `codeQualityStatus`: **WATCH**
- `recommendation`: **APPROVE**
- `blockers`: **None for the confirmation fix.**
- Reviewed scope: `engine/adapter-service.ts`, `engine/entry-prep-service.ts`,
  `bench/adapter-swap.test.ts`, and `bench/entry-prep.test.ts`.

## Confirmation-path result

**PASS.** `submitSwap` waits for `confirmTransaction(signature, "confirmed")`,
rejects a confirmation containing an RPC error, and only then invalidates the
native-SOL/token balance caches ([adapter-service.ts:1541](/Users/irfandi/Coding/2026/worktrees/prism-dlmm/humble-kitten/prism-dlmm/engine/adapter-service.ts:1541)). The SOL-funded entry flow cannot reach its post-swap balance reread until `submitSwap` returns ([entry-prep-service.ts:517](/Users/irfandi/Coding/2026/worktrees/prism-dlmm/humble-kitten/prism-dlmm/engine/entry-prep-service.ts:517), [entry-prep-service.ts:546](/Users/irfandi/Coding/2026/worktrees/prism-dlmm/humble-kitten/prism-dlmm/engine/entry-prep-service.ts:546)). Cache invalidation clears both token and native SOL caches ([adapter-service.ts:1132](/Users/irfandi/Coding/2026/worktrees/prism-dlmm/humble-kitten/prism-dlmm/engine/adapter-service.ts:1132)), so the reread is not served from the pre-swap 30-second cache.

The focused behavioral test holds RPC confirmation open and proves the generic
swap promise does not settle early ([adapter-swap.test.ts:486](/Users/irfandi/Coding/2026/worktrees/prism-dlmm/humble-kitten/prism-dlmm/bench/adapter-swap.test.ts:486)). The independent confirmation driver produced `safe: true`, one confirmation call, and `settledBeforeConfirmation: false`.

## Skill-perspective check

**Ran.** I loaded and applied `omo:remove-ai-slops` and `omo:programming`
(including its TypeScript reference) before judging test relevance and
maintainability.

- `remove-ai-slops`: no deletion-only, requested-removal-only, tautological,
  or implementation-constant-mirroring test found in the confirmation fix.
  The test observes the actual adapter's externally visible completion timing.
  The production confirmation and cache invalidation are required lifecycle
  logic, not needless extraction, parsing, or normalization.
- `programming`: no new untyped escape hatch or brittle prompt test found in
  the reviewed confirmation path. The existing adapter's `unknown` effects and
  test casts predate/broaden the fix; this change adds typed validation errors
  rather than weakening the boundary.

## Findings

### CRITICAL

None.

### HIGH

None. The previous HIGH issue (balance reread after RPC acceptance rather than
confirmation) is resolved.

### MEDIUM

None in the reviewed confirmation fix.

### LOW

1. The repository-wide typecheck is currently red due to an unrelated missing
   module import: `bench/candidate-discovery.integration.test.ts:6` imports
   `../engine/candidate-discovery.js`, which is absent. This prevents a CLEAN
   status for the broader dirty branch, but does not invalidate the focused
   confirmation result.

## Verification evidence

All focused checks below passed unless noted:

```text
rtk bun run test -- bench/adapter-swap.test.ts bench/entry-prep.test.ts
# 2 files, 55 tests passed

rtk bun .omo/evidence/generic-swap/confirmation-driver.ts
# safe=true; confirmCalls=1; settledBeforeConfirmation=false

rtk bunx oxlint engine/adapter-service.ts engine/entry-prep-service.ts \
  bench/adapter-swap.test.ts bench/entry-prep.test.ts
# passed (no output)

rtk git diff --check
# passed (no output)

rtk bunx tsc --noEmit
# FAILED only at bench/candidate-discovery.integration.test.ts:6:
# missing ../engine/candidate-discovery.js
```
