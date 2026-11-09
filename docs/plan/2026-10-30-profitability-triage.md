# Profitability triage — 2026-10-30

**Status:** triage plan + first tooling. The live box (`217.216.35.77`) **was read on 2026-10-30**; §0 supersedes the 2026-09-05 review for current state. §1–§5 remain the method and the historical context.

---

## 0. Live inspection — 2026-10-30

Host `vmi2933244`, production `prism-agent.service` under **root's user systemd** (not the system unit), active since 2026-10-21, 813 MB RSS, build `0.2.44-canary.20261020T171447-c9271436`. DB 781 MB (`audit` 121k rows, `pool_snapshots` 18k). Last close **2026-10-29 14:48** — the position-exit path is working; the stale “last close Aug 27” note is obsolete.

| Slice | Closes | Realized | Win rate | PF | Avg hold |
| --- | ---: | ---: | ---: | ---: | ---: |
| All (positions ledger) | 416 | **−$147.32** | 48.6% | 0.47 | — |
| Latest 100 | 100 | **+$70.40** | — | — | — |
| normal | 399 | −$169.80 | — | — | 414 min |
| fallen-angel | 6 | +$22.47 | — | — | 20 min |
| launch | 11 | **$0.00 (bug, see below)** | — | — | 41 min |

Latest-100 is concentrated: `6GmA/SOL` contributes ≈ +$74.61 across 18 closes; `pump/SOL` +$9.09 and `JUP/SOL` +$4.97 also positive. The two historical SOL/USDC pools are unchanged and still account for −$216.75 (221 closes −$163.33; 127 closes −$53.42) — they are old losses, not current bleeding.

### Forensics run — 2026-10-30 (live ledger)

`prism forensics --all` over the exported ledger (419 position rows, 52,210 ENTER/EXIT audit rows):

| Slice | Closes | Priced | Net | Win rate | PF | Avg hold |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| All | 418 | 410 | **−$145.54** | 48.6% | 0.49 | — |
| normal | 401 | 393 | **−$168.01** | — | — | 640 min |
| fallen-angel | 6 | 6 | **+$22.47** | — | — | 20 min |
| launch | 11 | 11 | $0.00 (accounting bug) | — | — | 41 min |

**Lane ranking is provisional.** Only 2 of 418 closes carry a rule tag (the rest predate the lane tags), so per-rule credit is empty and the table above splits by `positions.position_mode` instead. Fallen-angel is the only positive lane but six closes is noise; normal is the bleed and is dominated by the two SOL/USDC pools (348 closes, −$216.75). Re-rank after ~30–50 closes produced under the new `[normal-enter]` / `[launch-enter]` / `[fallen-angel-enter]` tags.

Top ENTER blockers in the same run: `wallet-reserve` 10,169 (now resizes instead of skipping), `fee-il-gate` 7,275, `alloc-gate` 5,622, `cooldown-gate` 4,044, `entry-net-gate` 3,592, `drift-gate` 2,758, `expected-profit` 1,357, `token-block` 1,354.

### Findings that change the plan

1. **The dominant constraint is capital, not strategy.** `[wallet-reserve]` is the top ENTER blocker: **10,145 skips**. Samples: `free SOL 0.3591 < needed 0.4194` and `0.2847 < 0.3817` for `MAX_ENTRY_SIZE_USD=20`. Two of three slots are filled; the third cannot be funded. A ~0.2 SOL top-up (or a size cut to ~$15) would unlock entries immediately. This is a sizing/wallet decision, not a rule change. **Addressed in code (2026-10-30):** the gate now resizes a qualifying entry down to the largest whole-dollar size the free SOL funds (floor $10) instead of skipping, so the third slot trades smaller without an operator top-up.
2. **Launch-mode PnL is not recorded.** **Fixed in code (2026-10-30):** (a) entry now reads the confirmed position once and fails (reaping the account) when both legs hold zero liquidity — the exact shape behind these 11 rows — so a phantom position cannot be booked again; (b) both EXIT paths now record an empty reap as `realized_pnl_usd = NULL` with `pricing: "unresolved"` + `emptyReap: true` instead of `0`, so it can never read as a break-even trade. **Historical rows still need a one-off reconciliation** — they keep their old `0.0` until re-derived from the settlement ledger. All 11 launch closes have `realized_pnl_usd = 0.0` and `cumulative_fees_claimed_usd = 0.0`, with ENTER values of $24–44 (≈$303 deployed), and are invisible to the rolling PnL halt, the pool kill switch and `prism portfolio history`.
3. **Two ledgers, not one.** `settlement_jobs` holds 204 distinct positions, only **59 overlap** the `positions` table; 145 are settlement-only. Of 197 confirmed jobs, only 52 are priced (net **+$77.36**, 32 wins / 20 losses); 145 have NULL realized. The true book is the union of both, and neither alone is complete. Reconcile before declaring the strategy profitable or not.
4. **Entry attribution is absent.** 414 of 416 closes are **untagged** — successful ENTER reasoning is free text (`Strong pool: Fee/IL …, auth …, TVL …`), so the existing `[tag]` vocabulary only appears on rejections. `prism forensics` correctly reports this; first-class `ruleIds` on every decision (Phase 0) is required before per-rule pruning can work. **Partial fix (2026-10-30):** successful ENTERs now carry a lane tag — `[normal-enter]`, `[launch-enter]`, `[fallen-angel-enter]` — so `prism forensics` can compare lanes on new closes (the historical 414 stay untagged).
5. **Log noise with a cause.** `[safety] leg Pren charges a transfer fee` produced **48,723** HOLD rows because a transfer-fee pool stays in the market set and is re-screened every cycle. It is not a capital issue, but it dilutes the audit and costs cycles. **Fixed (2026-10-30):** the Token-2022 transfer-fee extension is immutable, so a pool rejected by that screen is quarantined for the process lifetime and skipped by `rebuildPoolsToScan` (held positions are still scanned). One screening pass per pool per process instead of one per cycle.
6. **The box is oversubscribed.** Load average ~10 on 8 GB: four `autoresearch/loop.ts` workers at ~55% CPU each (running 3.5 days) plus `celld`. Cycles scan only **7 pools and take 109 s**. RPC latency under this load is an execution-quality risk independent of strategy.
7. `[engine-status] Engine status report failed` recurs; the cloud status endpoint rejects the report, but it is non-fatal.

### Immediate actions (ordered)

| # | Action | Owner | Why |
| --- | --- | --- | --- |
| 1 | Top up ≈0.2 SOL **or** set `MAX_ENTRY_SIZE_USD=15` | operator | 10,145 ENTERs blocked by ~0.06 SOL |
| 2 | ~~Fix launch EXIT to write NULL + `pricing:"unresolved"` (never 0)~~ **done**; reconcile `positions` with `settlement_jobs` | code | 11 live closes / ~$303 have no PnL |
| 3 | Move `autoresearch` off the trading box (or cap to 1–2 workers) | operator | 109 s cycles, load ~10 |
| 4 | Record `ruleIds` on every decision (Phase 0) | code | 414/416 untagged |
| 5 | ~~Drop the transfer-fee pool from the active set~~ **done** (process-lifetime quarantine) | code | 48k wasted audit rows |

---

## 1. What the ledger already says

From `docs/profitability-review-2026-09-05.md` (production, `prism-agent.service`):

| Slice | Closes | Priced | Win rate | Realized PnL | Profit factor |
| --- | ---: | ---: | ---: | ---: | ---: |
| All history | 393 | 385 | 45.97% | **−$189.90** | **0.307** |
| Latest 100 | 100 | 100 | 41% | **+$27.97** | n/a |
| SOL/USDC pool A | 221 | — | — | **−$163.33** | — |
| SOL/USDC pool B | 127 | — | — | **−$53.42** | — |

Plain reading:

- **Two SOL/USDC pools are 348 of 393 closes and −$216.75.** Everything else nets roughly +$27. The loss is concentrated, not diffuse.
- The latest 100 closes are slightly positive (+$27.97) with a **lower** win rate (41%). Average winner +$1.91, average loser −$1.258 → per-close expectancy **+$0.04**. That is noise-level: one bad tail event erases it.
- Eight closes have unknown realized value; gas/funding/settlement are not reconciled. The true net is at least as bad as the ledger.
- Last recorded close **2026-08-27** while the service was still scanning (3 rows open). That pattern — decisions without closes — needs checking before any tuning.

## 2. Mechanisms (from the code, not the review)

1. **The admission gate is a ratio, not an expected value.** `[fee-il-gate]` requires `feeIlRatio ≥ 1.2`. The IL half is `estimateDailyIlUsd()` — full-range IL extrapolated from the *last cycle's* drift, described in its own comment as a "conservative upper-bound **ranking signal**" (`strategy-service.ts:64`). The fee half is a modeled concentration share. So a pool with real fees but a range that gets run over can still clear 1.2.
2. **The cost-aware model already exists but is barely used.** `expectedNetProfitUsd()` (`fee-capture.ts:494`) charges concentration, time-in-range, conversion, harvest and round-trip swap/tx costs. It is called once in the engine (`program.ts:4673`). Normal ENTER never sees it.
3. **Fine-bin majors are the natural churn trap.** SOL/USDC at binStep 4 has a base fee near 0.04%; a 25-bin baseline range covers ~±1%. Fees are thin and the price leaves the range routinely. This is exactly the pool class that produced 348 closes and −$216.75. `MIN_RANGE_HALF_WIDTH_PCT` (default 5%) exists to widen these, but a wider range dilutes capture — the width must be chosen by **net** EV, not by one static percentage.
4. **Re-entry throttles are already on** (2h `MIN_REENTRY_COOLDOWN_MS`, churn guard, rolling halt, pool kill switch). The remaining leak is admitting a marginal pool at all, then exiting and re-admitting it every few hours. The fix is at admission, not another cooldown.
5. **I re-checked the review's active-share note.** The current `activeShareEstimate()` (`fee-capture.ts:103`) *decreases* concentration as the range widens (`concentration = max(referenceSpan / span, 1)`). The review's "increases with width" claim does not match this code; do not spend time on it.

## 3. Actions, in order

| # | Action | Where | Expected effect | Verification |
| --- | --- | --- | --- | --- |
| 1 | Export the current DB (consistent snapshot) and run `prism forensics` | box → workstation | Replaces the 7-week-old picture with current per-rule/per-pool net | `closes`, `netUsd` match the ledger total |
| 2 | Confirm closes are still happening | `prism status`, engine log | Rules out a stalled exit path (last close Aug 27) | closes in the last 24h > 0 |
| 3 | Require positive net EV at admission | Phase 4 of the kernel plan | Fewer, better entries; churn falls | pre/post closes/day and net expectancy on disjoint windows |
| 4 | Treat fine-bin majors as a separate regime | `RegimeKey` policy | No 25-bin churn on a ±1% range | SOL/USDC closes/day drops; net ≥ 0 over ≥30 closes |
| 5 | Disable any entry rule whose credited net is negative over ≥30 closes | `prism forensics` → policy | Removes the actual bleed instead of tuning globally | credited net per rule ≥ 0 on the next window |
| 6 | Do **not** lower TVL / fee-quality / cooldown / halt thresholds to manufacture trades | — | The review's own conclusion: churn loses even at ~46% wins | — |

Actions 3–5 are policy changes; 1–2 are measurement. Do measurement first — otherwise you cannot tell a fix from a lucky window.

## 4. Running the triage

On the box (read-only snapshot; `sqlite3 .backup` is safe while the service writes):

```bash
sqlite3 /root/.local/share/prism/prism.db ".backup '/tmp/prism-snapshot.db'"
```

Copy it over, then locally:

```bash
bun cli/index.ts forensics --db /tmp/prism-snapshot.db --all
bun cli/index.ts forensics --db /tmp/prism-snapshot.db --window 14 --json > /tmp/forensics.json
```

Repair the two known accounting defects on the copy (dry run first, then `--apply`; idempotent):

```bash
bun scripts/reconcile-ledger.ts --db /tmp/prism-snapshot.db          # plan only
bun scripts/reconcile-ledger.ts --db /tmp/prism-snapshot.db --apply  # write in one transaction
```

The reconcile sets the empty-reap closes (positive basis, EXIT `value_usd = 0`) to `realized_pnl_usd = NULL` with `pricing:"unresolved"` + `emptyReap` metadata, completes a settlement job only from a position row that already carries a realized value, and reports settlement-only jobs (no cost basis) separately. On the 2026-10-30 ledger it planned 10 repairs + 1 zero-basis launcher row and left 219 settlement-only jobs unpriced (correctly — a job settles one mint, so its output is not a position cost basis).

The report shows, per rule tag: closes where it co-fired, credited net PnL (fractional when several entry rules co-fire), sole-rule net, win rate; per pool: closes, net, average hold; and the top rejection tags so you can see which gate is doing the blocking.

**Attribution caveat:** audit rows do not yet carry `position_id`, so a close is attributed to the latest ENTER decision on the same pool within a lookback window (default 6h). Multi-entry pools can mis-attribute; sole-rule stats and per-pool stats are provided to cross-check. Phase 0 of the kernel plan adds first-class `ruleIds`.

## 5. Promotion criteria

A change ships only when, on a **disjoint** evaluation window:

- net expectancy after conservative costs is positive and better than the fixed baseline;
- drawdown is bounded (no new max-drawdown excursion);
- exits still fire (executed/decided ratio for EXIT ≥ baseline);
- no rule with negative credited net is still enabled at the end of the window.

Paper fills and pool-level fee allocation remain estimates; treat a paper win as a hypothesis, not proof.
