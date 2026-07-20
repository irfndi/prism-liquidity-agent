# [BUG] DB write errors after position execution are silently swallowed

**File:** [`engine/program.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/program.ts#L714-L1216) (lines 714, 775, 777, 790, 976, 1060, 1216)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** low  •  **Slug:** `other-silent-persistence-failure`

## Owners

**Suggested assignee:** `irfandi@users.noreply.github.com` _(via last-committer)_

## Finding

Throughout program.ts, position persistence calls are wrapped as `db.savePosition(pos).pipe(Effect.catchAll(() => Effect.void))` (and similarly for closePosition/markPaperExited/deletePosition/savePositionEvent), e.g. L714, L775-777, L790, L976, L1060-1061, L1213-1216. The in-memory `trackedPositions` Map is updated BEFORE the save (L713-714), so if the SQLite write fails after a live on-chain ENTER/EXIT/REBALANCE, the error is discarded with no log and no retry. Within the running process the position stays tracked, but on restart the row is missing. For live positions this is largely mitigated because `reconcilePositions` rediscovers on-chain positions by pubkey on watched pools; however a live position that opened but whose row never persisted could miss fee-claim/trailing-stop/OOR history continuity, and paper positions (no on-chain footprint) would be lost entirely from tracking/history. This is a pervasive, apparently intentional best-effort design (AGENTS.md documents swallowed audit/memory errors and a reconcile backstop), so impact is limited, but silent failure of a capital-state write with no logging is a reliability gap.

## Recommendation

At minimum log persistence failures (logger.warn with the positionId and error) instead of discarding them, so a desync between in-memory state and SQLite is observable. Consider retrying or surfacing DB write failures on live-execution paths rather than unconditional catchAll-to-void.

## Recent committers (`git log`)

- irfandi marsya <irfandi@users.noreply.github.com> (2026-07-20)
- irfandi marsya <join.mantap@gmail.com> (2026-07-19)
