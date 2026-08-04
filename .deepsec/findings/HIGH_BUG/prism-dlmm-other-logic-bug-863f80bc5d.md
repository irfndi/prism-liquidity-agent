# [HIGH_BUG] Fee accrual ignores deployed position size — ENTER sizing has no effect on simulated PnL

**File:** [`ops/backtest.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/ops/backtest.ts#L221-L336) (lines 221, 224, 225, 280, 288, 336)
**Project:** prism-dlmm
**Severity:** HIGH_BUG  •  **Confidence:** high  •  **Slug:** `other-logic-bug`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

feesForTick() (lines 221-226) computes the position's share of pool fees using `Math.min(portfolioValue / tvl, 1)` — the FULL portfolio value — instead of the actually deployed `positionSizeUsd`. The ENTER branch sets `positionSizeUsd = replay.adjustedSizeUsd` (line 288), sized at `Math.min(portfolioValue * 0.2, 2000)` (line 280), but that value is never used in fee computation. The comment on line 220 explicitly states the intent is to scale by 'position share of pool TVL', yet the code scales by the entire portfolio's share. Impact: simulated fee income is inflated by roughly 5x (100% deployment assumed instead of ~20% sizing), and the core risk control the backtest is meant to evaluate — position sizing / allocation — is silently inert in the results. The netPnlUsd, winRate, and best-config selection (lines 510-522) are all systematically wrong. Also, the auto-reentry branch at lines 336-340 flips `hasPosition = true` without ever setting `positionSizeUsd`, leaving the position at $0 value while still accruing fees on the full portfolio — confirming the simulation is disconnected from position accounting.

## Recommendation

Scale fee accrual by the deployed position size: use `positionSizeUsd` (falling back to portfolioValue when the position hasn't been sized) instead of `portfolioValue` in `positionShare`, e.g. `Math.min(positionSizeUsd / tvl, 1)`. Also initialize `positionSizeUsd` in the auto-reentry branch (line 336) so position value and fee accrual stay consistent with the ENTER sizing path.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-27)
