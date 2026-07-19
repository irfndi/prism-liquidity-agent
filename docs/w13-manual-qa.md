# W13 Manual QA

2026-07-19, dedicated `feat/auto-accumulate` worktree.

Command:

```text
bun run test -- bench/fee-destination.test.ts bench/fee-compound.test.ts
```

Observed `2` test files and `9` tests passed. The routing assertions observed `undefined` and `compound` resolving to compound, while `accumulate-quote` and `accumulate-sol` resolved to accumulation without a compound route. Zero, negative, and non-finite fee amounts were rejected. The existing compound gate tests also passed.

Live Jupiter execution remains fail-closed when the adapter has no wallet, when Jupiter returns no validated route, when output is malformed or zero, or when quote/build/confirmation fails. Paper mode emits a simulated accumulation event and never calls Jupiter.
