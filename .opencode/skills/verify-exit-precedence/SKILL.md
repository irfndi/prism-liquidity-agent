---
name: verify-exit-precedence
description: Check that an EXIT decision is still approved under every risk gate (capital protection can never be blocked). Use when touching engine/risk-service.ts, its gate helpers, RiskConfig, RiskContext, or anything that reorders gates in evaluateRisk.
---

# Verify EXIT precedence

## The promise

An `EXIT` decision is **always approved**, whatever the confidence, halt,
allocation, drawdown, stop-loss, size or range state says. Capital protection
is never gated. If that breaks, the agent cannot cut a losing position and the
wallet bleeds with no way out.

## The harm if it breaks

A refactor that moves any gate above the EXIT branch (or adds a new gate before
it) silently blocks every loss-cut. Nothing crashes. The agent keeps holding
through drawdowns, `[rolling-pnl-halt]` and `POOL_PNL_KILL_SWITCH` never see the
exit, and the position rides to zero. This is the failure that already cost the
project 67% of its capital, so it is checked on every change that touches the
gate chain.

## Where the property lives

- `engine/risk-service.ts` `evaluateRisk` — the EXIT branch is the first
  statement, before gates 2 through 7 (line numbers move; search for
  `EXIT approved: capital protection`).
- Each gate helper below it: `checkConfidenceGate`,
  `checkRollingPnlHaltGate`, `checkPerPoolPositionCapGate`, `checkDrawdownGate`,
  `checkStopLossGate`, `checkPositionSizeGate`, `checkRebalanceRangeGate`.
- `engine/services.ts` `RiskContext` and `engine/risk-service.ts` `RiskConfig`
  are the input contract.

## Run the check

```bash
bun run test -- bench/risk-exit-precedence.test.ts
```

Pass: 10 tests, ~0.2s. Any failure names the gate that no longer gets bypassed.

The test is constructive, not a list of lucky cases. For each gate it first
asserts a non-EXIT action **is rejected** in that context (a precondition, so
the second assertion cannot pass for the wrong reason), then flips the action to
`EXIT` and asserts approval. A final grid crosses confidence x position size x
drawdown with every gate tripped at once.

## If it fails

1. **Read the failing gate name.** It tells you which check now runs before the
   EXIT branch.
2. **Confirm against the code**, not the test. Open `evaluateRisk` and find the
   offending check above `if (decision.action === "EXIT")`.
3. **A real break = restore precedence.** Move the gate below the EXIT branch.
   Do not weaken the test and do not add an EXIT exemption to the gate: the
   ordering is the invariant.
4. **An intended change** (for example, a genuinely new capital-protection
   action) means the property itself is changing. Update `HOSTILE` in the test,
   state the new promise in this skill's "The promise" section, and re-run.

## Prove the check still works

Before trusting a green run after editing the test, break the real code on
purpose:

1. Move `checkConfidenceGate` above the EXIT branch in `evaluateRisk`.
2. Run the command above. Four tests must fail, including the grid.
3. Revert the edit and confirm 10 pass.

A check you have never seen fail proves nothing.

## Scope and limits

- Covers the seven gates inside `evaluateRisk` at the hostile points in
  `HOSTILE`, plus a 72-point grid over confidence, size and drawdown.
- Does **not** cover `evaluateAgentProposal` (a separate path), the engine's own
  pre-filter that runs before risk evaluation, or execution failures after
  approval.
- The model is the real function. There is no hand-written model to drift from
  the code, which is why this check is a property test rather than TLA+.

## Coverage record

| Covered files | Covered symbols |
| --- | --- |
| `engine/risk-service.ts` | `evaluateRisk`, the seven `check*Gate` helpers |
| `engine/services.ts` | `RiskContext` |
| `engine/types.ts` | `AgentDecision`, `Position` |

Last confirmed in sync at commit: `b704096`.

Move that commit forward only after re-running the check **and** reading
`evaluateRisk` to confirm the EXIT branch still precedes every gate. If the gate
list changed, update `HOSTILE` first.

For bringing this back in line after changes that did not recheck it, use the
`/maintain-formal-verification-skill` skill.
