# Profitability review — 2026-09-05

## Observed deployment and results

Read-only inspection of `217.216.35.77` on September 5, 2026:

- Production: root user service `prism-agent.service`, active, working directory `/root/.prism`; health endpoint reports `0.2.36`. `PAPER_TRADING=false`.
- Production ledger: `/root/.local/share/prism/prism.db`. Snapshot writes were current at inspection; the service is scanning, despite the lack of recent closes.
- Paper verification service `prism-paper-bin20.service`: inactive, with working directory `/root/.prism-paper-verify`. Do not interpret archived paper results as a currently running staging test.
- No server configuration, service, wallet, or database was changed during this review.

| Ledger / sample | Closed positions | Priced closes | Win rate among priced closes | Recorded realized PnL | Profit factor |
| --- | ---: | ---: | ---: | ---: | ---: |
| Production, all history | 393 | 385 | 45.97% | -$189.90 | 0.307 |
| Production, latest 100 closes | 100 | 100 | 41% | +$27.97 | Not calculated |
| Archived `.prism-paper` | 32 | 32 | 50% | -$2.74 | 0.550 |
| Archived `prism-paper-bin20` | 31 | 31 | 70.97% | +$49.98 | 8.295 |

Production's latest recorded close was August 27, 2026, 16:44:58 UTC. Three positions remain recorded as open. Paper histories ended August 10 and August 22 respectively. These are different periods, pools and execution models; the paper win rate is not evidence that its settings would outperform production.

One production SOL/USDC pool accounts for 221 closes and **-$163.33** recorded PnL. Another SOL/USDC pool accounts for 127 closes and -$53.42. Winning pools partially offset these losses. The latest 100 closes have average winner +$1.91 and average loser -$1.258: a lower win rate can still produce better profitability. Optimize net expectancy and drawdown, not the proportion of winning closes alone.

The figures above are ledger PnL, not a reconciled wallet return. Eight production closes have unknown realized value. Gas, funding swaps, settlement costs and external deposits/withdrawals require separate reconciliation before claiming total net profit.

Production already enables the rolling realized-PnL halt, pool-local loss cooldown, two-hour minimum re-entry cooldown, runner lane, rotation and hot-window lane. The latest-100 realized sum was above its configured -$35 halt threshold; the historical total alone does not justify changing that threshold. Logs also show repeated RPC endpoint failures and unpriced wallet tokens; those can reduce trading capacity and need operational follow-up.

## Implemented corrections

### Entry filters no longer suppress position management

`engine/program.ts` previously returned before position valuation and EXIT evaluation when TVL, volume authenticity or bin utilization failed the entry pre-filter. A pool deteriorating below the admission threshold could therefore evade its protective exits.

Held pools now continue through position management. Normal ENTER and idle-redeploy eligibility remain blocked when the pre-filter fails. A paper integration regression reproduces the original failure and verifies an executed protective EXIT after TVL falls below the minimum, without a replacement entry.

### Hot-window decisions reach execution

Hot-window decisions previously returned from `evaluatePool` before the shared decision tail. The caller counted them as decisions but did not execute or audit them. A timed EXIT could therefore report a decided pool with zero executions.

Hot-window decisions now pass through the shared proposal, risk, execution and audit tail. Non-hot positions on a mixed pool retain their generic lifecycle; hot positions retain their specialized lifecycle. New hot entries share wallet-read, balance-refresh, backoff, cooldown, token-block and wash guards. The normal lane cannot also enter a pool owned by the hot lane. Daily hot-trip usage increments after successful execution, not qualification or rejection.

Paper integration coverage checks a timed exit, an executed entry, and a cooldown-blocked entry, including the daily trip count.

### Rotation uses consistent fee units

`runnerNetAprPct` reconstructed daily **pool** fees using **position** size and then applied the position's TVL share. This discounted proportional fee capture twice and artificially favored shallower pools.

The reconstruction now uses pool TVL. Position share applies once, followed by time-in-range and cost estimates. A zero-cost proportional position now has the same modeled APR as its pool regardless of pool depth. For example, a $20 proportional position in a $100,000 pool at 500% fee APR previously scored 0.1% before costs; the corrected model scores 500% before costs. This is dimensional consistency, not a forecast of actual concentrated-liquidity fees.

The input interpretation follows the measured pool statistics exposed by the [Meteora pool API](https://docs.meteora.ag/api-reference/dlmm/pools/pool). Actual fee capture still depends on liquidity in the traded bins, position distribution, fills and time in range.

### Rotation requires positive superiority

`shouldRotate(0, zeroNetIncumbent, 5)` previously returned true because `0 >= 0`. Rotation now requires a finite, positive challenger return, valid nonnegative incumbent return, a finite multiplier of at least one, and strict improvement as well as the multiplier threshold. A genuinely positive challenger can still replace a zero-net incumbent.

## Remaining limits and rollout criteria

Verification of the final implementation: `bun run test` passed **146 files / 2,071 tests**; `bun run lint`, `bun run build`, `bun run format:check`, and `git diff --check` passed. New regression scenarios were observed failing before the corresponding fixes. Tests exercise paper execution; no live transactions were submitted for validation.

- These fixes establish correct decisions and execution plumbing. They do not establish an improved future win rate or profit.
- The active-share/range model in `fee-capture.ts` still increases estimated fee share as the range widens, despite comments describing the opposite effect. Calibrate it against per-bin liquidity and actual claims before relying on its absolute return estimates or tuning range width from it.
- Rotation still selects an incumbent by pool-level gross APR, then evaluates net APR; it does not search all held positions for the worst net return. Position identity also needs explicit handling when multiple incumbents share a pool.
- Safety screening still precedes position management; a positive safety rejection can stop an existing position's lifecycle. This review preserves the configured blacklist/freeze policy. Separating admission rejection from a controlled emergency-exit policy needs dedicated tests and execution review.
- Hot-window timebox/OOR decisions currently use the tracked record before the cycle's position refresh. A newly out-of-range position can take an additional cycle to trigger the specialized exit.
- Do not lower TVL, fee-quality, cooldown or loss-halt thresholds to manufacture more trades. The history shows that churn can lose money even with roughly half of closes winning.

Validate in isolated paper staging first, recording the exact build, configuration, fee source, entry/exit reasons, position age, measured fee income and modeled costs. Compare a fixed baseline and candidate over the same snapshots and use a later period for evaluation rather than selecting settings on all available history. Require profitable net expectancy after conservative costs, controlled drawdown and functioning exits before production promotion. Paper fills and pool-level fee allocation remain estimates.

For production promotion, preserve the prior bundle/configuration, verify which open positions will immediately qualify for EXIT under the repaired management path, and monitor executed versus decided counts, RPC failures, wallet reconciliation and PnL. The corrected hot lane may begin executing trades that the old code merely counted, so promotion changes real behavior even without changing environment settings.

## Paper deployment — September 5, 2026, 02:55:26 UTC

Following user authorization, deployed the Linux x64 build to `/root/.prism-paper-verify/dist/` and started `prism-paper-bin20.service`. Bundle SHA-256: `d376a8613488f7162df04ba763d869fdc818f07c7f1aa7d07bdc127537267733`. The build embeds Linux sqlite-vec 0.1.9. The reported application version remains 0.2.36; identify this candidate by its bundle hash.

The previous bundle, service definition, staging environment and SQLite backup are preserved at `/root/.prism-paper-verify/backup-20260905-review/`. Existing staging history was retained.

Service override `prism-paper-bin20.service.d/90-paper-review.conf` enforces paper mode, clears the wallet key, pins the build by disabling auto-update, disables alerts/feedback, and retains the separate staging config/data/database and HTTP port 18791. Runtime environment verification confirmed these settings.

Health returned `ok: true`; PID 1878159 had zero restarts. First completed cycle scanned 9 pools, decided 6, executed 0 entries/exits, and failed 0 in 35.7 seconds. New audit records are marked paper trading. No profitability conclusion can be drawn from this startup check.

Production service remained active under its original PID 856 and was not restarted or reconfigured.

Follow-up at 12:15:06 UTC: the retained staging ledger contained three live-position rows, producing repeated refused EXITs under paper mode. Preserved that ledger and restarted staging against a new, isolated `/root/.local/share/prism-paper-bin20/prism-review-20260905.db`. This removes mixed-mode history from the candidate evaluation without deleting it. The service is now enabled for boot. Its discontinued Lava RPC fallback (HTTP 410) is overridden with the existing public Solana endpoint. Production remains untouched.

Fresh-ledger verification: cycle `7a5ad4fa-11c0-434b-bb4f-388714d47e19` completed in 50.2 seconds, scanning 8 pools with 2 paper entries, 0 exits and 0 failures. Health remained OK. The new ledger has no live-position rows.
