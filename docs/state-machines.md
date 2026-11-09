# State machines

Every explicit and implicit state machine in the engine, its invariants, its
transition table, and the invalid states/transitions the code can actually
reach. Findings are ordered by impact; each is either **FIXED** (with the
regression test) or **OPEN** (with the reachable condition). Where a finding
is a false/inert state rather than a transition, it says so.

Scope: `engine/` (TS engine, still source of truth), `cloudflare/` alert and
link pipelines. The Rust host mirrors subsets — not covered here.

Legend for evidence: `file:line` refers to the tree at the time of writing.

---

## 0. False states (state that is written but not driven) — [NEW, high]

Three lifecycle fields are stamped **once at ENTER** and never advanced by any
code path. They are the strongest real bugs in this audit because each one
silently disables a policy the operator believes is active.

### 0.1 Fallen-angel TP ladder never advances past the first rung

`engine/program.ts:10538` evaluates the persisted ladder with
`evaluateTpLadder(pool.currentPrice, ladder, stop)` and returns a **full
EXIT** on any `tp` status, including `ladderComplete: false`
(`engine/tp-ladder.ts:118`). The scale-out fraction is used only to build the
reasoning string (`:10554`) — no code reads it to size the close, and no code
persists a rung index. `tp_ladder_json` is written only at ENTER (`:13390`,
`:12451`) and in the FA discovery envelope (`:7079`).

Reachable: price touches rung 1 (fraction 0.4) → the whole position exits at
confidence 1 → the operator's ladder `[0.4, 0.3, 0.3]` behaved as `[1.0]`.
The module's own header (`engine/tp-ladder.ts:16`) documents the intended
close-and-reopen remainder; nothing implements it.

### 0.2 `tp_ladder_json` is stamped on every normal ENTER, enabled or not

The normal ENTER tail builds the ladder through `resolveNormalEnterTpLadder`
(`engine/program.ts:4637`), which **does** check `takeProfitEnabled` and
returns `null` when off — so the stamp is correctly conditional. The
inconsistency is on the read side: `evaluateTpTargetExit` (`:10565`) re-checks
`config.takeProfitEnabled` *and* the row's `positionMode !== "fallen-angel"`,
so a ladder persisted while the flag was on goes inert the moment the flag is
set to `false`, with no warning, while `invalidation_stop_price` (stamped at
the same moment) is still consumed by `prism portfolio` as if it were live.

### 0.3 Runner scale-in step counter advances on a rebalance the adapter may not have funded

`buildRebalancedRecord` (`engine/program.ts:5226`) and
`buildPaperRebalancedPosition` (`:2365`) advance `launchRunnerSteps` /
`launchRunnerAnchorPrice` **only when `topUp !== undefined`**, and
`maybeScaleInRunner` emits such a decision only when funding succeeded
(`:10808`). The live executor then calls the adapter, whose
`simulateRebalancePosition` is the gate: a simulation failure returns an
`AdapterError` (`engine/adapter-service.ts:5316`), and the decision fails —
correct direction.

The invalid transition is on the **success** side: `rebalancePosition`
broadcasts the init-bin-array txs and then the rebalance tx in sequence
(`:5296-5304`) and returns `{positionPubKey, txSignatures}` only after all
landed, so "non-error return" does imply the top-up landed. The invariant
(`steps advance only when the capital moved`) therefore holds, but it holds by
accident of adapter ordering and has **no regression test** — any future
partial-batch success path silently grants a free scale-in step and moves the
anchor below the market.

---

## 1. Position (`positions` table, one row per position identity)

**States.** Three independent NULL-able markers, not one enum:
`paper_exited_at`, `closed_at`, and the settlement group's `finalized_at`
(on `settlement_jobs`, mirrored onto the row by
`finalizeSettlementGroup`, `engine/db-service.ts:407`).

| State | Predicate | Read by |
| --- | --- | --- |
| active | `paper_exited_at IS NULL AND closed_at IS NULL` | `getAllPositions` (`engine/db-service.ts:352`) |
| paper-exited (ledger tombstone) | `paper_exited_at IS NOT NULL` | `getPaperExitedPositions` (`:361`), `cleanupLegacyPaperPositions` (`engine/program.ts:5699`) |
| closed | `closed_at IS NOT NULL` | `getClosedPositions` (`:370`) |
| deleted | row gone | `deletePosition` |

`getClosedPositions` returns `closed_at IS NOT NULL OR paper_exited_at IS NOT
NULL`, so "closed" and "paper-exited" overlap by query, and exactly one
predicate owns "active".

**Invariants (intended).**

1. A position that is not active is never scanned
   (`getAllPositions` is the only cycle input).
2. A closed/paper-exited row keeps its history (soft close); only true
   cleanup deletes.
3. `realized_pnl_usd` is either a measured number or NULL (never 0-as-unknown)
   for an on-chain close (`engine/program.ts:3660`).
4. A row with `position_pubkey = NULL` never executes on-chain
   (`runExitOrMarkExited`, `engine/program.ts:5396`).

**Transition table.**

| From | Event | To | Evidence |
| --- | --- | --- | --- |
| — | ENTER (paper) | active, `positionPubKey=null` | `engine/program.ts:1927` |
| — | ENTER (live) | active, pubkey set | `engine/program.ts:3189` |
| active | REBALANCE | active (basis/mark/anchor re-stamped) | `buildRebalancedRecord` `:5228`, `buildPaperRebalancedPosition` `:2365` |
| active | fee claim / accrual | active (+cumulative) | `claimAllFees` |
| active | EXIT confirmed (live) | closed + `realized_pnl_usd` | `settleLiveExitAttribution` `:3572`, `finalizeLiveExitLedger` `:3955` |
| active | EXIT (paper) | paper-exited | `engine/program.ts:2343` |
| active | reconcile: pubkey gone on chain | deleted | `:1346`, `:10372` |
| active | settlement group all confirmed | closed (PnL only if NULL) | `finalizeSettlementGroups` (`engine/autonomous-runtime.ts:842`) |
| any | cleanup of pubkey-less rows | deleted | `engine/program.ts:5729` |

**Invalid states the code can reach.**

### 1.1 [OPEN, high] A close that throws after the remove-liquidity tx confirmed leaves the row active forever

`exitPosition` wraps its whole body in one `Effect.catch` that converts any
failure into `AdapterError` (`engine/adapter-service.ts:5130`). Between
`broadcastCloseTransactions` (`:3913`, which loops `sendRawTransaction` +
`confirmTransaction` per tx) and the return value there are four failing
steps: `readPostCloseSnapshot` (`:3900`), `settleMeasuredWithdrawals`,
`priceExitAccounting` (`:3965`) and reward pricing. Each has an internal catch
*except* a defect (a sync throw, a timeout that escapes `Effect.timeout`'s
interrupt) — and any RPC confirmation failure inside the broadcast loop for
the **second** transaction of a multi-tx close throws after the first already
landed.

`runLiveExitPosition` then returns `{exited: false, error}` and adds the pool
to `reconcileRequestedPools` (`engine/program.ts:3358`). That flag does not
skip reconcile — `reconcilePositions` is called with the full pool list and
the set is only logged then cleared (`engine/program.ts:15740`) — so the
chain-delete loop (`pruneExternallyClosedPositions`, `:1341`) would remove the
row on the next successful reconcile.

**The reachable bad state:** the next reconcile's chain read returns
`null` (all positions unreadable → `succeeded: false`, `:1530`) or the
Data-API source is used, which **skips the delete loop entirely**
(`if (source === "chain")`, `:1548`). The position is gone on chain, the row
stays active, `trackedPositions` still counts it, so `portfolioValueUsd`
overstates, the pool is pinned at `MAX_POSITIONS_PER_POOL`, and the slot is
consumed until a reconcile with a healthy chain read runs.

Severity is bounded by that recovery, which is why this is documented rather
than patched: a delete needs positive chain evidence (the file's own
invariant, `:1329`), so the fix is a *pending-verification* state, not a
guess.

### 1.2 [OPEN, medium] A failed close leaves `realized_pnl_usd` untouched, so a partly-withdrawn position reads as open

`executeLiveExit` returns `{executed: false, error}` when
`runExitOrMarkExited` reports a failure (`engine/program.ts:5456`) and no
ledger write happens. If the close batch partially broadcast (first tx
confirmed, second failed — `broadcastCloseTransactions` loops
`sendRawTransaction` + `confirmTransaction` per tx,
`engine/adapter-service.ts:3913-3929`), the on-chain reality is "partly
withdrawn" while the row is byte-identical to "never attempted". Nothing
marks the attempt.

Reachable: any two-transaction close (a position large enough to need split
removes, or a close whose batch includes a fee-claim tx). The next EXIT
re-runs `removeLiquidity` against the same pubkey; the SDK raises for the
already-emptied bins and the loop repeats until one attempt happens to
succeed or reconcile drops the row (1.1).

---

## 2. Pool re-entry cooldown (`pool_cooldowns` table)

**States.** `absent` → `armed(cooldown_until, reason, consecutive_oor_exits)`
→ (clock passes) → still a row, but expired. There is no explicit `expired`
state: expiry is `Date.now() >= cooldown_until`, computed at read time.

**Invariants (intended).**

1. A cooldown is armed only after a *confirmed* close
   (`resolveDecisionExitCooldown` runs only when `executed` and no error,
   `engine/program.ts:14706`).
2. Arming never shortens an existing cooldown (`Math.max`, `:4143`).
3. `consecutive_oor_exits` escalates OOR cooldowns
   (`engine/cooldown.ts:84`).
4. ENTER is blocked while `Date.now() < cooldown_until`
   (`checkEnterCooldownGate`, `engine/program.ts:12167`).

**Transition table.**

| Trigger | Writes | Evidence |
| --- | --- | --- |
| OOR exit | `consecutive_oor_exits = existing + 1`, duration = `oor` or `repeat` | `:11437-11475` |
| low-yield exit (fee/IL, volume auth) | `consecutive_oor_exits = 0`, duration fee-density scaled | `:11476-11508` |
| any other exit (churn throttle) | `consecutive_oor_exits = existing`, duration = `MIN_REENTRY_COOLDOWN_MS` | `:11510-11529` |
| pool PnL kill switch | `Math.max(existing, desired)`, marker-prefixed reason | `:8397-8415`, `:4122-4150` |
| expiry | no write — row stays | `checkEnterCooldownGate` |
| clear | `clearPoolCooldown` | `engine/db-service.ts:1267` — **no production caller** |

**Invalid states the code can reach.**

### 2.1 [FIXED, medium] A low-yield exit reset the OOR escalation counter

Every write goes through `setPoolCooldown`, an `INSERT OR REPLACE`
(`engine/db-service.ts:1256`), so the low-yield branch's
`consecutiveOorExits: 0` (`engine/program.ts:11504`) wiped a pool's OOR
history. Sequence that defeats `REPEAT_OOR_COOLDOWN_MS`: OOR exit → OOR exit
→ OOR exit (count 3, escalated) → one fee/IL exhaustion exit (count 0) → OOR
exit restarts at the base cooldown instead of the escalated one. The churn
throttle branch already preserves the count; the low-yield branch did not.

Fix: the low-yield branch preserves `existingOorCount`. The decision lives in
one pure function, `nextOorExitCount(trigger, existing)` (`engine/cooldown.ts`),
so "only an OOR exit advances the counter" is stated once and unit-tested
rather than re-implemented at each call site.

**Consequence, and why 2.2 now matters more:** before this fix the low-yield
branch was the only code path that ever reset the counter, so the escalation
was self-limiting (and effectively unreachable, which is what made it a bug).
With the reset removed there is **no decay path at all**: a pool that
accumulates `MAX_OOR_COOLDOWN_EXITS` OOR exits pays `REPEAT_OOR_COOLDOWN_MS`
for the rest of the database's life. That is the correct direction for the
churn pathology this gate exists to punish, but it is a policy consequence
worth stating — see 2.2 for the missing decay.

### 2.2 [OPEN, medium] `consecutive_oor_exits` never decays — now the only missing piece after 2.1

The counter mutates only when a cooldown row is written, and after 2.1 no path
resets it: not a successful trade, not time, not `clearPoolCooldown` (which
has no production caller — only `bench/pool-cooldown.test.ts`). So once a pool
reaches `MAX_OOR_COOLDOWN_EXITS` every later OOR exit pays
`REPEAT_OOR_COOLDOWN_MS`, permanently.

The escalation is meant to decay with **time**, not events (a pool that has
behaved for a week should not carry last month's count), so the fix is a
stored timestamp, not an event hook: persist `last_oor_exit_at` on the
cooldown row and drop the counter to 0 when it is older than
`REPEAT_OOR_COOLDOWN_MS`, or halve it on each expired cooldown. Reset on a
successful ENTER would be wrong — churn *is* enter→exit→enter, which is the
exact pattern the escalation targets.

### 2.3 [OPEN, low] An expired row is indistinguishable from an active one at the CLI

`getPoolCooldown` returns the row regardless of expiry
(`engine/db-service.ts:1238`); any consumer other than `checkEnterCooldownGate`
must re-check the clock. `prism status` prints the row as-is.

---

## 3. `token_candidates` lifecycle (SQL CHECK: discovered|observing|eligible|entered|cooling_down|rejected)

The pure machine lives in `engine/candidate-policy.ts:transitionCandidate`;
the SQL CHECK is in `engine/db.ts:877`.

**Transition table (what the persisted path can actually produce).**

| From | Event | To | Emitted by |
| --- | --- | --- | --- |
| — | `createTokenCandidate` | discovered | `engine/candidate-discovery.ts:63` |
| discovered/observing | scan healthy, gates unmet | observing | `advanceScreenedCandidates` (`candidate-discovery.ts:61`) |
| discovered/observing | scan healthy, gates met | eligible | same |
| eligible | scan healthy | eligible | same |
| discovered/observing/eligible | scan transient failure | observing, count reset | same |
| any | `entry_confirmed` (from eligible) | entered | `engine/program.ts:14800` (post-execution), `:7954` (audit) |
| entered | `cooldown_started` | cooling_down | `engine/program.ts:14890` |
| cooling_down | `cooldown_elapsed` (after TTL) | discovered | `engine/program.ts:6567` |
| any | scan hard safety failure | rejected | unreachable from the runtime |

**Invalid states the code can reach.**

### 3.1 [FIXED, high] `entered` now leaves when the position behind it is gone

`advanceScreenedCandidates` (`engine/candidate-discovery.ts:61`) sends **only**
`kind: "scan"`, and `transitionCandidate` ignores scans for `entered` /
`cooling_down` / `rejected`. The only `entry_confirmed` writers are the
normal-ENTER post-execution hook and the idle-redeploy hook; the only
`cooldown_started` writer was the EXIT tail inside
`updatePostExecutionBookkeeping`. That tail does not run for closes that
happen elsewhere — `pruneExternallyClosedPositions` (reconcile),
`discoverExternalPosition`, a reconcile-driven `deletePosition`, or a paper
close in a session where `autonomousExecution` was null. A candidate stuck in
`entered` is excluded from `eligiblePoolAddresses` forever while
`findEligibleAutonomousCandidateId` still reports it, so the pool is scanned
as an "eligible" candidate that never re-enters.

Fix: a new `entry_closed` event (`engine/candidate-policy.ts`) takes `entered`
→ `cooling_down`, carrying the same re-entry cooldown the decision tail arms
on a normal exit (`MIN_REENTRY_COOLDOWN_MS`), so an externally-closed position
cannot re-qualify immediately. `settleCandidateStates` (`engine/program.ts`)
emits it once per cycle for any `entered` candidate whose pool holds no
tracked position — the one place that has both the candidate and the position
facts. `cooldown_elapsed` then returns the row to `discovered` with a fresh
streak, as designed.

Tests: `bench/candidate-lifecycle.test.ts` (event semantics),
`bench/program-autonomous-token.test.ts`.

### 3.2 [FIXED, medium] `rejected` now has a real producer

`recordScan` can set `rejected` only for `hard_safety_failure`, but the only
runtime caller built `evaluateCandidateHealth({ safety: { kind: "safe" } })`,
so `rejected` was unreachable from the engine while a real safety rejection
was handled by the per-pool `HOLD` and never recorded on the candidate — a
blacklisted candidate stayed `eligible` in SQL and was counted every cycle.

Fix: `rejectCandidatesForPool` (`engine/program.ts`) writes the hard-failure
verdict onto the pool's candidate — **only** for the third-party Meteora Data
API `is_blacklisted` verdict, because `rejected` has no outgoing edge and no
configuration can rehabilitate that one.

Everything else stays re-evaluable and deliberately does **not** quarantine:

- transfer-fee legs are gated by `ALLOW_TRANSFER_FEE_TOKENS`, so an operator
  opting in must be able to recover the candidate;
- the token/deployer blacklist is operator-maintained, so a later correction
  must be able to recover it;
- freeze-authority and verification gaps are holds that clear next cycle.

---

## 4. Settlement job (`settlement_jobs`, SQL CHECK pending|prepared|submitted|confirmed|retryable|terminal)

Engine: `engine/autonomous-runtime.ts` (`processSettlementJobs`).

**Transition table.**

| From | Event | To | Evidence |
| --- | --- | --- | --- |
| — | orphan sweep / EXIT attribution / rollback | pending | `engine/autonomous-runtime.ts:761`, `engine/program.ts:3412` |
| pending | quote+simulate ok, pre-broadcast persist | prepared | `:725` |
| prepared | broadcast callback | submitted (+signature) | `:741` |
| submitted | `getSwapStatus` confirmed/finalized | confirmed | `:482`, `:447` |
| submitted | `getSwapStatus` processed | submitted (retry later) | `:486` |
| submitted | `getSwapStatus` not_found | submitted (retained) or terminal at expiry | `:494` |
| submitted | `getSwapStatus` failed | (null) → fresh submit | `:500` |
| any non-final | error | retryable (+`nextRetryAt`) | `retryableJob` `:373` |
| retryable / prepared | retry past `nextRetryAt` | re-attempt | `isSkippableSettlementJob` `:585` |
| prepared (no signature) | any | terminal/failed retryable | `:812` |
| any | non-transient + past `expiresAt` | terminal | `:378` |
| confirmed (all group jobs) | finalize | `finalized_at` + position close | `finalizeSettlementGroups` `:842` |
| terminal (no signature) | next orphan sweep | pending (revived in place) | `:678` |

**Invalid states the code can reach.**

### 4.1 [FIXED, medium] A settlement row that failed to persist was still processed and sold the tokens

`sweepOrphanSettlements` returns jobs, and the caller saved each one with the
error swallowed and then **pushed it into `settlementJobs` regardless**:

```ts
for (const job of orphanJobs) {
  yield* db.saveSettlementJob(job).pipe(Effect.catch(() => Effect.void));
}
settlementJobs.push(...orphanJobs);
```

`processSettlementJobs` then drove the in-memory job to `confirmed` and sold
the tokens. The impact is narrower than "closes the position with no record":
sweep jobs carry synthetic group ids (`orphan:<id>`, `rollback:<opId>`) and
`finalizeSettlementGroups` needs a `positions` row under that id
(`engine/autonomous-runtime.ts:868`), so those groups never finalize — the
loss is the **durable record of a completed sale**, not a false position close.
On restart the tokens are gone from the wallet, so the sweep cannot re-enqueue
them: the sale exists only in the chain history.

Reachable: any transient SQLite write failure (`SQLITE_BUSY` under the audit
write path, a disk-full container) during the orphan sweep.

Fix: a job is only added to the processed set when its write succeeded; a
rejected write leaves the tokens in the wallet for a clean retry next cycle.

### 4.2 [FIXED, medium] A retry-forever job past its own window now reaches the overdue signal

`retryableJob` deliberately never terminalizes a transient error, and
`oldestActiveSettlementAgeMs` excluded any job with a **future** `nextRetryAt`.
The backoff caps at 30 minutes, so a permanently-429'ing Jupiter keeps every
job "progressing per policy" forever: the position stays closed with
`realized_pnl_usd` NULL, no settlement completes, and the `settlement_overdue`
breaker never fires — the operator gets no signal at all.

Fix: `isStuckSettlementJob` keeps the #196 guarantee (a job inside its
max-pending window with a scheduled retry stays excused) but counts a job as
stuck once it is past that window, whether or not it rescheduled. The
unlimited-retry policy is unchanged — only the observability is restored.
`oldestActiveSettlementAgeMs` now takes the window explicitly so the caller's
config, not the row's `expires_at`, defines it.

Revival also had to be fixed for this to be sound: `nextOrphanSweepJob`
re-enqueues a terminal job in place, and it used to keep the ORIGINAL
`createdAt`. The overdue check is `now - createdAt`, so a job revived one
second ago would have reported as hours stale and armed `settlement_overdue`
for work that had just started. A revival now stamps a fresh `createdAt`
(a new attempt generation with a fresh window) while still carrying `attempts`
forward, so backoff keeps escalating across generations.

Test: `bench/program-autonomous-token.test.ts` ("counts a retry-forever job
past its own window as stuck"), which also pins that a job still inside its
window stays excused.

### 4.3 [OPEN, low] `execution_operations` `planned` rows leak

`planLiveEntryOperation` writes `planned` (`engine/program.ts:2718`), the exit
path writes `prepared` and then `confirmed`/`failed`, but a process that dies
between `planned` and `prepared` leaves a row `planned` forever — there is no
sweeper and `cli/status.ts:342` is the only reader. The SQL CHECK also admits
`retryable`/`failed` states the entry path never writes for an operation row.

Left OPEN deliberately: a sweeper needs a staleness bound, and a bound chosen
wrong marks a genuinely in-flight operation `failed` while its transaction is
still landing. The leak is cosmetic (no capital), so the bound is an operator
decision, not something to guess here.

### 4.4 [OPEN, low] A settled-elsewhere job can sell a *smaller* balance of the same mint

`resolveBroadcastSettlement` returns `null` for `status.state === "failed"`,
which the caller treats as "definitively failed on chain — submit a fresh
swap". The fresh-submit path clamps the amount to the live wallet balance
(`clampSettlementToWalletBalance`), and that clamp is
`balance >= amountAtomic ? amountAtomic : balance` — i.e.
`min(jobAmount, balance)`, so a job **never sells more than its own recorded
amount**. (An earlier draft of this entry claimed it could sell an arbitrary
balance; that was wrong — the cap was read too quickly.)

The residual, real risk is narrower: when the job's own tokens were consumed
elsewhere, the wallet may still hold a *smaller* balance of the same mint
belonging to another position or an airdrop, and the job will sell up to its
own amount of it, crediting those proceeds to this position's PnL group. The
mint identity is all the settlement path knows; token provenance is not
observable on-chain, so there is no local guard that distinguishes them.

Left OPEN: a real fix needs a per-job "these exact atomics came from this
withdrawal" proof (instruction-level delta attribution), which is a
settlement-contract change rather than a clamp tweak.

---

## 5. Wallet safety pause (`wallet_safety_pauses`, PK wallet+instance)

**States.** `none` → `armed` (`resolved_at IS NULL`) → `resolved`
(`resolved_at` set). The PK means only the newest pause survives; history is
dropped on every re-arm (`saveSafetyPause` is upsert, `engine/db-service.ts:1486`).

**Transition table.**

| Reason | Arm | Resolve |
| --- | --- | --- |
| `daily_drawdown` | `armDailyDrawdownPause` `:15137` | `resolveDailyDrawdownPause` `:15118` (mode-aware) |
| `core_data_unavailable` | `shouldTriggerSafetyPause` `:8763` | **none** |
| `execution_failures` | same | `resolveCycleExecutionFailuresPause` `:8512` |
| `settlement_overdue` | `settlementOverduePauseAction` `:8484` | same (`:8495`) |
| `settlement_persistence_failed` | `flagSettlementPersistenceFailure` `:3455`, `:2872` | **none** — and it is not in `SafetyPauseReason` (`engine/autonomous-runtime.ts:65`) |

**Invalid states the code can reach.**

### 5.1 [FIXED, low] The arm guard's name inverted its meaning, not its behavior

`isSafetyPauseArmed` (`engine/program.ts:4100`) returned
`activeSafetyPause?.resolvedAt !== null`, i.e. **true when the pause was
resolved or absent** — the opposite of its name. The call site read
`if (isSafetyPauseArmed(...))` before arming, so the *behavior* was correct
(arm only while nothing is latched) while every reader was told the reverse.

This is a readability bug with real cost during audit: the three auto-resolvers
(`resolveCycleExecutionFailuresPause` `:8512`,
`settlementOverduePauseAction` `:8495`, `resolveDailyDrawdownPause` `:15118`)
all test `resolvedAt === null` for "latched", so the file used both meanings of
the same field. Fix: the predicate is now
`isSafetyPauseArmed(pause) = pause !== null && pause.resolvedAt === null`, and
the call site says `!isSafetyPauseArmed(activeSafetyPause)`. Behavior is
unchanged (verified case-by-case for absent / latched / resolved); the test
pins the predicate, not the call site.

### 5.2 [FIXED, high] `core_data_unavailable` latched forever (`settlement_persistence_failed` still does)

This is the finding the misleading name above concealed. Only
`daily_drawdown`, `execution_failures` and `settlement_overdue` had
auto-resolvers. `shouldTriggerSafetyPause` can also return
`core_data_unavailable` (`engine/autonomous-runtime.ts:62`), which had none, so
one all-pools-failed cycle blocked ENTER/REBALANCE until an operator ran
`prism resume` — exactly the failure mode issue #182 fixed for
`execution_failures`.

Fix: `shouldAutoResolveCoreDataPause` mirrors the execution-failures contract
(`engine/autonomous-runtime.ts`), and `resolveCycleCoreDataPause`
(`engine/program.ts`) runs it at the cycle tail, immediately after
`updateCoreDataFailureCounter` and **before** the arm block, so a genuine
breach re-arms in the same pass instead of toggling.

Two design points, both forced by the machine:

- **Evidence gate.** The resolver requires `poolsScannedThisCycle > 0`. A
  zero-pool cycle resets the counter to 0 (`updateCoreDataFailureCounter`
  returns 0 when `poolsScanned === 0`), so without the gate a discovery outage
  — nothing scanned, nothing failed — would clear the latch and un-pause the
  agent mid-outage. This is the practical half of 5.3 below.
- **Tail placement, not top.** The execution-failures resolver runs at cycle
  top from the previous cycle's counter; the core-data resolver cannot, because
  its two inputs (fresh counter, pools actually scanned) exist only after the
  scan loop. One extra blocked cycle is the accepted cost — the pause leaves
  EXIT free, and clearing without evidence is the worse error.

`settlement_persistence_failed` remains OPEN: it is not a member of
`SafetyPauseReason` (`engine/autonomous-runtime.ts:44`), so no mode-aware
resolver can be written against the type yet, and its correct resolution
condition is "a later settlement write succeeded" — a signal the cycle does
not carry today.

### 5.3 [FIXED, medium] A total outage that scans nothing now reaches the breaker

`updateCoreDataFailureCounter` incremented only when
`poolsScanned > 0 && failuresThisCycle >= poolsScanned`, and the arm needs two
consecutive such cycles. A dead RPC that makes discovery return zero pools
scans nothing, so the counter reset to 0 and the breaker read the outage as
healthy — exactly the state `core_data_unavailable` exists to catch.

Fix: the counter takes `expectedPools` and counts an expected-but-empty cycle.
The second half is the part a counter change alone could not do: `runScanCycle`
returns early when `poolsToScan` is empty, **before** `finalizeScanCycle`, so
`finalizeScanCycle` was never the right owner for this case.
`accountCoreDataAvailability` now runs on both paths — from `finalizeScanCycle`
with the real counts, and from the empty-cycle early return with
`expectedPools = expectsPoolsToScan() ? 1 : 0` (watchlist, market scan,
discovery or autonomous mode configured). It advances the counter, resolves the
pause, and arms it directly when the threshold is met and nothing is latched.

The pause leaves EXIT free, so arming it costs no capital protection.

**Declined review note.** A reviewer suggested distinguishing a *failed*
discovery fetch from a *successful* empty result before counting the cycle as
an outage. Not adopted: an engine configured with pools that finds none has no
route to capital either way, the pause leaves EXIT free, and it auto-resolves
on the first fully clean cycle (`shouldAutoResolveCoreDataPause` now requires
the counter to be exactly 0, not merely below the threshold). Tracking fetch
success per source would add a flag threaded through four discovery paths to
change only the *wording* of an already-harmless pause.

---

## 6. Agent proposal queue (in-memory, `AgentStateMutable`)

**States.** `pending` → `approved` → (consumed | expired) ; `pending` →
`rejected`; `pending` → replaced (same pool). `executed` exists in
`engine/types.ts:355` but nothing writes it.

**Transition table.**

| From | Event | To | Evidence |
| --- | --- | --- | --- |
| — | `/propose` | pending | `engine/state-service.ts:190` |
| — | `/propose`, approved exists for pool | rejected (`approved_exists`) | `:180` |
| pending | `/propose` same pool | replaced | `:196` |
| pending | `/approve` | approved | `:216` |
| pending | validation failure | rejected | `engine/program.ts:13976` |
| pending/approved | applied + executed | removed (`dequeueProposals`) | `engine/program.ts:754` |
| approved/pending | `expiresAt` passed | pruned | `engine/state-service.ts:135` |

**Invalid states the code can reach.**

### 6.1 [FIXED, medium] `/approve` now refuses stale proposals at the boundary

`/approve` accepted any id present in the snapshot. `findPendingProposal` does
re-check staleness before applying, so an expired approval was inert rather
than dangerous — but the operator got a `200 {approved: 1}` for evidence they
could no longer see, and the proposal kept inflating `proposalsQueued`.

Fix: `approveScopeError` (`engine/http-status-server.ts`) rejects the whole
batch with `409 {error: "Proposals are stale", stale: [...]}` when any id is
past its TTL or `AGENT_PROPOSAL_STALE_MS`, so a stale entry cannot ride along
with a fresh one. `isProposalStale` moved to `engine/proposal-schema.ts` so the
HTTP boundary and the decision loop share one predicate without importing the
engine program (which imports the HTTP server).

**Deliberately not pool-scoped.** Re-checking pool membership at approve time
looks attractive and is wrong: the enqueue side already restricts proposals to
the watchlist + held pools, and market-scan pools rotate out of the active set
every refresh, so a membership check would reject legitimate approvals for a
pool that merely stopped qualifying between propose and approve.

Test: `bench/http-status-server.test.ts` ("refuses to approve a stale proposal
at the HTTP boundary").

### 6.2 [NOT A DEFECT, low] `approved_exists` does not strand the approved proposal

The earlier reading was that a supervised proposal failing validation is
`rejected` rather than dequeued, so it waits for the staleness prune. It does
not: `rejectProposal` sets the status and the same layer callback calls
`prune(Date.now())` (`engine/state-service.ts`), and `prunePendingProposals`
drops anything whose status is `rejected` or `executed`. A rejected proposal is
removed in the same call, so it cannot block the next enqueue.

---

## 7. Alert delivery (`alerts.delivered_at`, Telegram bot worker)

**States.** `pending` (`claim_token IS NULL AND delivered_at IS NULL`) →
`claimed` (`claim_token` set, `claimed_at` = ms epoch) → `delivered`
(`delivered_at` set, claim cleared). A claim is released back to `pending` on a
real delivery failure, or by the stale-claim sweep when `claimed_at` is older
than `CLAIM_RECLAIM_MS`. `abandoned` once
`delivery_attempts >= FLUSH_ABANDON_ATTEMPTS` (the row stays `pending`, skipped
by the claim query's `delivery_attempts < ?` filter).

**Transition table.** `cloudflare/workers/telegram-bot/index.ts` — reclaim →
claim → resolve → deliver or release. Every mutating statement is guarded by
`AND claim_token = <this flush's token>`, so a flush that lost its claim to the
reclaim sweep can neither deliver nor charge the row.

### 7.1 [FIXED, low] The claim now has its own columns

`delivered_at` carried three states in one column (NULL / `claim:<ms>:<uuid>` /
a seconds-resolution timestamp), so the stale-claim sweep compared a
millisecond epoch against a timestamp column that otherwise holds seconds.
Migration `cloudflare/migrations/0017_alert_claim_state.sql` adds
`claim_token TEXT` and `claimed_at INTEGER` (ms), backfills legacy
`'claim:...'` values into them, and clears `delivered_at` so a pre-existing
claim reads as claimed rather than delivered. `delivered_at` is now only the
delivery timestamp.

### 7.2 [FIXED, low] A lost claim no longer charges a delivery attempt

The reclaim sweep incremented `delivery_attempts` for a claim it never
delivered, so three worker restarts retired an alert nobody had tried to send.
A reclaim now only releases the claim; `delivery_attempts` counts failed
deliveries only, and the abandoned count excludes claimed rows.

Tests (four, in `cloudflare/workers/telegram-bot/telegram-alerts.test.ts`):
reclaim charges no attempt, a real failure does, two concurrent flushes deliver
once, and a delivered row is never re-claimed.

---

The text above audits the **code as written**. This section is the plan that
was acted on; entries marked DONE have a landed fix and test, entries marked
DECLINED record why the code was left alone.

Eleven changes landed across three passes: cooldown escalation (2.1), the
settlement persistence gate (4.1), the `core_data_unavailable` resolver (5.2),
a behavior-preserving rename (5.1), the candidate lifecycles (3.1, 3.2), the
settlement overdue signal (4.2), the zero-pool outage (5.3), the `/approve`
staleness gate (6.1), and the two alert-delivery state defects (7.1, 7.2).
What is left needs a recovery-policy or schema decision, so it is written down
with its reachable condition instead of patched blind — a wrong fix in the
exit ledger or the settlement path is worse than the leak it closes.

| Finding | Status | Fix | Regression test |
| --- | --- | --- | --- |
| 2.1 a low-yield exit reset the OOR counter | **DONE** | the low-yield branch preserves `existingOorCount` instead of writing 0 (consequence recorded in 2.2) | `bench/cooldown-density.test.ts` |
| #232 held-position OOR/marks froze when the gate phase threw | **DONE (merged #233)** | on gate failure, refresh held positions from `getPoolState(..., { skipStats: true })`, then re-raise so failure accounting is unchanged | `bench/issue-232-paper-mark-refresh.test.ts` |
| 3.1 an `entered` candidate never leaves | **DONE** | new `entry_closed` event + `settleCandidateStates` emits it when the pool holds no tracked position | `bench/candidate-lifecycle.test.ts` |
| 3.2 `rejected` was unreachable | **DONE** | `rejectCandidatesForPool` writes the hard-failure verdict for permanent safety rejections | `bench/candidate-lifecycle.test.ts` |
| 4.1 an unpersisted settlement job was still processed | **DONE** | `persistSweptSettlementJobs` returns only accepted rows; a rejected write leaves the tokens for the next sweep | `bench/program-autonomous-token.test.ts` |
| 4.2 retry-forever jobs never reached the overdue signal | **DONE** | `isStuckSettlementJob` counts a job past its window even with a scheduled retry; the #196 in-window case stays excused | `bench/program-autonomous-token.test.ts` |
| 5.1 the arm guard's name inverted its meaning | **DONE** | predicate is now `pause !== null && pause.resolvedAt === null`; behavior unchanged | `bench/safety-pause-arm.test.ts` |
| 5.2 `core_data_unavailable` latched forever | **DONE** | `shouldAutoResolveCoreDataPause` + `resolveCycleCoreDataPause`, at the tail after the counter update and before the arm block, gated on `poolsScannedThisCycle > 0` | `bench/program-autonomous-token.test.ts` |
| 5.3 a zero-pool outage read as healthy | **DONE** | `updateCoreDataFailureCounter` takes `expectedPools`; an expected-but-empty cycle now advances the counter | `bench/safety-pause-arm.test.ts` |
| 6.1 `/approve` took stale proposals | **DONE** | `approveScopeError` returns 409 for the whole batch when any id is stale | `bench/http-status-server.test.ts` |
| 7.1 `delivered_at` held the claim token | **DONE** | migration `0017_alert_claim_state.sql` adds `claim_token` + `claimed_at` (ms) | `cloudflare/.../telegram-alerts.test.ts` |
| 7.2 a lost claim charged a delivery attempt | **DONE** | reclaim only releases; `delivery_attempts` counts real failures | `cloudflare/.../telegram-alerts.test.ts` |
| 0.1 the FA TP ladder fires one rung as a full close | DECLINED | needs persisted per-rung progress **and** a partial-withdraw path; the adapter is full-close-only, so a "fix" would re-enter the whole position and pay the round trip twice | — |
| 0.2 `tp_ladder_json` goes inert when `TAKE_PROFIT_ENABLED` is flipped off | DECLINED | the exit re-reads the flag; the only defect is a stale column, and clearing it would erase the entry-time record forensics reads | — |
| 0.3 runner `launchRunnerSteps` could advance without the top-up landing | DECLINED | the adapter returns only after the rebalance tx confirms, so the invariant holds today; a guard would be dead code | — |
| 1.1 a close that throws after the tx landed leaves the row active | OPEN | needs a pending-verification position state; a delete requires positive chain evidence, so the fix is a new state, not a guess | — |
| 1.2 a failed close leaves `realized_pnl_usd` untouched | OPEN | same state as 1.1: nothing marks the partially-withdrawn attempt | — |
| 2.2 `consecutive_oor_exits` never decays | OPEN | needs a stored `last_oor_exit_at` and a time-based decay; resetting on ENTER would neutralize the gate (churn *is* enter→exit→enter) | — |
| 2.3 an expired cooldown row looks active at the CLI | OPEN | needs a reader-side expiry check or a status column | — |
| 4.3 `execution_operations` `planned` rows leak | OPEN | a sweeper needs a staleness bound; a wrong bound marks an in-flight operation `failed` while its tx lands | — |
| 4.4 the balance clamp can sell another position's tokens | OPEN | needs a per-job amount ceiling (never exceed the recorded withdrawal), which changes the settlement contract | — |
| 5.4 `settlement_persistence_failed` latches | OPEN | not a `SafetyPauseReason`; its resolution condition ("a later write succeeded") is not carried by the cycle | — |
| 6.2 `approved_exists` stranding | **NOT A DEFECT** | `rejectProposal` prunes in the same call | — |

## Adversarial review dispositions

A second-pass review raised five claims. Two were disproved by reading the
code at the cited lines and are recorded here so the next reader does not
re-raise them:

| Claim | Verdict | Evidence |
| --- | --- | --- |
| The pause resolvers run at the cycle **tail**, so the first blocked cycle cannot recover | **False** | `resolveCycleExecutionFailuresPause()` and the new `resolveCycleCoreDataPause()` are called at `engine/program.ts:8897-8898`, inside `runScanCycle` (starts `:8865`) and before the `poolsToScan.length === 0` check and the pool loop. The *core-data* resolver does live at the tail, by design (5.2), but the execution-failures one does not. |
| `finalizeAppliedProposal(agentState, None, …)` treats a missing id as approved and dequeues | **False** | `engine/program.ts:754` guards `appliedQueuedProposalId !== undefined && (executed \|\| action === "HOLD")`; a `undefined` id is a no-op. |
| The core-data resolver clears a latch on a counter it cannot distinguish from "no pools" | **True, fixed** | `shouldAutoResolveCoreDataPause` now also requires `poolsScannedThisCycle > 0`; both branches are pinned in the test. |
| The cooldown fix reads the counter from `classifyExitCooldownTrigger` | **False** | the branch reads `existingOorCount` from the persisted row (`db.getPoolCooldown`), the same value the OOR branch uses. The *consequence* it pointed at — no decay path remains — is real and is recorded in 2.2. |
| The pause is "resolved" before the treasury action it gates | Overstated | `saveSafetyPause` is a row upsert keyed on `(wallet, instance)`; `resolvedAt` is a column on that one row, not a separate ledger entry, so a re-arm overwrites rather than appending a contradictory grant. Not introduced by this work. |

## Reading the Syra LP post against this audit

The post (`x.com/Ikhwanhsn/status/2118939962141704352`, "Automated LP by Grok
Bot") describes a Solana Meteora LP product where a chat agent bootstraps a
wallet and opens positions, but a **server-side watcher** — not the chat —
enforces take-profit and stop-loss. Its stated product promise is "set the
rules once, then the host keeps watch"; the chat is a remote control, not the
24/7 engine.

Most of it **confirms** Prism's existing shape rather than suggesting changes:

| Syra's rule | Prism's equivalent | Verdict |
| --- | --- | --- |
| the chat may die; the host owns exits | `AGENT_PROPOSAL_MODE` overlay is advisory and fails open; deterministic EXITs never depend on the agent transport | already correct |
| agent params can never redirect a payout | `FEE_DESTINATION` / payout are operator config, never proposal-carried | already correct |
| minimum hold + confirmation streak before closing | `MIN_YIELD_EXIT_AGE_MS` (12h maturity), `TRAILING_STOP_CONFIRM_CYCLES` | already correct |
| the watcher polls, it is not per-second | `SCAN_INTERVAL_MS` bounds every decision | already correct |
| a preview→confirm token is short-lived and single-use | `/propose` → `/approve` was **not** time-bounded at the boundary | **took it** → 6.1 |

Two things it prompted that were worth acting on, and one it did not:

1. **6.1 (took it).** The post's `confirmToken` expires in ~3 minutes and is
   single-use. Prism's `/approve` accepted an id from an arbitrarily old
   snapshot and answered `200`. The staleness gate now refuses the batch with
   409. Prism's equivalent of "single-use" already existed: an approved
   proposal is removed by `dequeueProposals` on the decision that consumes it.
2. **0.1 (did not take).** The post assumes a *fractional* scale-out ("set
   takeProfitPct ... optional stopLossPct" and an armed position that closes
   at a target). Prism's fallen-angel ladder has the same intent and the same
   field, but the adapter is full-close-only, so rung 1 closes 100% — that is
   finding 0.1, and the post is evidence the fractional path is a real product
   requirement rather than an optional nicety. It is still DECLINED here
   because a correct fix needs a partial-withdraw path (`removeLiquidity` bps)
   plus per-rung ledger accounting; a close-and-reopen substitute would pay
   the round trip twice.
3. **Not applicable.** Custodial wallets, payout allowlists, Telegram binding
   and `lpMcpToken` session keys are product-boundary decisions for a hosted
   service. Prism is local-first with the operator's own wallet, so there is no
   equivalent surface to harden.

## Profitability: what the ledger actually says

Recorded so the next change is argued from numbers, not from the state machine
looking tidy. Sources: `docs/profitability-review-2026-09-05.md` (production
ledger, read-only inspection) and the local `prism.db` (paper).

| Ledger | Closed | Priced | Win rate (priced) | Realized | Profit factor |
| --- | ---: | ---: | ---: | ---: | ---: |
| Production, all history | 393 | 385 | 45.97% | **−$189.90** | 0.307 |
| Production, latest 100 | 100 | 100 | 41% | +$27.97 | not computed |
| Local `prism.db` (paper) | 2 | 2 | 0% | **−$27.96** | — |

Local paper detail: two closes, −$24.34 and −$3.62, on $500 deposits each,
with $1.28 of cumulative fees — fees did not cover IL plus close cost. Two
positions are still open (marks $484.46 and $500.96).

**Verdict: not profitable.** The two profitable-looking slices are not evidence
to the contrary: the latest-100 sum is +$27.97 but unreconciled, and the
archived paper runs (+$49.98 at a 71% win rate) cover a different period, pools
and execution model.

Reconciliation is incomplete, and that matters before any "net return" claim:
eight production closes have unknown realized value, and gas, funding swaps,
settlement costs, and external deposits/withdrawals are not in the ledger PnL.

The loss is **concentrated, not diffuse**: one SOL/USDC pool accounts for 221
closes and −$163.33, another 127 closes and −$53.42. Trade count on a single
pool is the damage mechanism, which is why the churn instrumentation below
matters more than any single-entry filter.

Breakers, with their **actual** defaults (verified in
`engine/config-service.ts` — several review-era notes assume these are off):

| Breaker | Default | Effect |
| --- | --- | --- |
| `CHURN_MAX_ENTRIES_PER_POOL_PER_DAY` | **4** (active) | caps same-pool re-entries per UTC day |
| `MIN_REENTRY_COOLDOWN_MS` | **2h** (active) | every exit arms a re-entry cooldown |
| `FEE_DENSITY_COOLDOWNS` | true | high-fee-density pools re-enter sooner |
| `REALIZED_PNL_HALT_ENABLED` | **false** | rolling realized-PnL halt is opt-in |
| `POOL_PNL_KILL_SWITCH_ENABLED` | **false** | per-pool trailing-loss cooldown is opt-in |
| `HOLD_BIAS_ENABLED` | **false** | fee-trend exits still recycle in-range positions |

Two review-era claims do **not** hold against the current tree, verified
directly rather than assumed:

1. "The active-share model increases fee share as the range widens" — it does
   not. `activeShareEstimate` computes `concentration = max(2 / spanPct, 1)`,
   so a narrower range yields a larger share, and
   `bench/fee-capture.test.ts` pins `narrow > wide`. That defect is already
   fixed; the model's remaining limit is the documented uniform-liquidity
   ceiling (no per-bin liquidity at rank time), not an inverted sign.
2. Finding 4.4's first draft ("can sell an arbitrary balance") was wrong — the
   clamp is `min(jobAmount, balance)`. The residual is the narrower
   provenance case recorded in 4.4.

What would move expectancy, in order, none of which is a silent code change:

1. Enable `REALIZED_PNL_HALT_ENABLED` (and/or the pool kill switch). Both ship
   off; the review's latest-100 sum was above the −$35 threshold, so this is a
   safety net rather than a profit lever.
2. Fix the operational capacity limits the review names: repeated RPC endpoint
   failures and unpriced wallet tokens suppress trading and skew marks.
3. Calibrate `activeShareEstimate` against per-bin liquidity and actual claims
   before tuning range width from its absolute estimates.
