# W13 Manual QA

2026-07-19, dedicated `feat/auto-accumulate` worktree.

Command:

```text
bun run test -- bench/fee-destination.test.ts bench/fee-compound.test.ts
```

Observed `2` test files and `9` tests passed. The routing assertions observed `undefined` and `compound` resolving to compound, while `accumulate-quote` and `accumulate-sol` resolved to accumulation without a compound route. Zero, negative, and non-finite fee amounts were rejected. The existing compound gate tests also passed.

Live Jupiter execution remains fail-closed when the adapter has no wallet, when Jupiter returns no validated route, when output is malformed or zero, or when quote/build/confirmation fails. Paper mode emits a simulated accumulation event and never calls Jupiter.

## Full gate receipt

2026-07-19 rerun after the CLI layer correction:

- `bun run lint`: passed (`tsc --noEmit` and `oxlint engine ops bench cli`).
- `bun run build`: passed.
- `bun run test`: 80 files, 965 tests passed.
- `bun run test -- bench/fee-destination.test.ts bench/fee-compound.test.ts`: 2 files, 11 tests passed.
- `bun run format:check`: passed.
- Changed-file `oxlint`: passed.
- Cleanup: no temporary ports, network mocks, temp DBs, or generated files remain in git status.
- LSP: diagnostics requests were unavailable for this isolated worktree because the workspace LSP root is the primary checkout; compiler and lint diagnostics are clean.
