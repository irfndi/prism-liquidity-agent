# prismd — Rust host (paper-first stub)

Paper-first runtime host. TS engine stays source of truth until parity green.

## Storage engine: `rusqlite`, not Turso — deliberate, revisit later

Considered [tursodatabase/turso](https://github.com/tursodatabase/turso) (Rust
rewrite of SQLite, async-native/io_uring, MVCC) 2026-09-18. Not adopted now:
it's beta (v0.6.x) and its own maintainers' guidance points production users
at managed libSQL/Turso Cloud, not the embedded engine directly — too soon to
bet a position ledger on it. It also wouldn't move the needle on the actual
box bottleneck this plan targets (3 long-lived Bun runtimes + GC/Effect
overhead, not SQLite I/O — the reads here are tiny and once-per-scan-cycle).
Reconsider once (a) Turso reaches a stable release the maintainers themselves
recommend for embedded production use, and (b) this host actually grows an
async (tokio) scan loop doing concurrent RPC/HTTP/DB work — that's the shape
Turso's async-native design would genuinely fit, unlike today's synchronous,
low-frequency reads.

## Run

```sh
cargo build
# paper shadow, 2 ticks then exit (profile env file optional):
SCAN_INTERVAL_MS=10000 SQLITE_DB_PATH=prism.db ./target/debug/prismd [~/.config/prism-paper-bin20/env] --ticks 2
```

Config: `.env` first, then optional profile env-file path arg (existing env wins).
Keys: `SQLITE_DB_PATH` (legacy `SQLITE_PATH` fallback; default `prism.db`),
`SCAN_INTERVAL_MS` (default 600000, fail-closed outside [10000, 3600000]),
`PAPER_PORTFOLIO_USD` (default 10000, fail-closed below 1),
`JEV_ENABLED`, `BEND_BIN` (default `bend`). `HELIUS_API_KEY`,
`TYPESAFE_API_KEY` (`TYPESAFEAI_API` alias) are passthrough only — startup
reports set/unset, never values. Garbage numbers exit 2, never guess.

## Test

```sh
cargo test
```

42 tests (36 unconditional + 6 Bend-gated): fee-IL clamp bands `[0.3, 3.0]`, EXIT-always-approved,
Jev-fail-open, config defaults, config fail-closed, Jev-stub fail-open, real
SQLite shadow read, drift ring-cap, evolve live-floors-and-lift, loss-cap breach,
CLI flags, `signal_lift` edges (empty/one-sided/non-finite→None), loss-cap
tighter-cap monotone superset, open-count excludes-closed, per-pool groups-open-only, stop-loss veto guards, exposure sums-open-only, halt edges, drawdown guards, rebalance-range guards, gas-justified guards, recovery-hold guards, interval-paper guards, cooldown-free guards, compound-parked guards, vol-exit/stddev guards, entry-shape guards,
range-width guards, il-dominance guards (live $6.65 fire + strict-> + None legs), TA-indicator guards, 4 unconditional bogus-binary fail-open/closed,
`K.clamp_thr` kernel, `evolve_thr` banded leg, `ta_exhausted` 6/6 confluence
combos, `exit_order` 5/5 precedence picks, tick-match shadow surface —
skipped, not failed, when `bend` is absent from `PATH`). Zero new deps (rusqlite only, Bend calls shell the `bend`
CLI via `std::process`); Jev HTTP stays a `JevClient` trait + stub until reqwest
(rustls) is justified.

## Bend kernel wiring (real, as of this wave)
Twenty-four shadows (15 native capacity/decision/risk/sizing/halt/drawdown/band-health/gas/recovery/interval/paper/cooldown/vol-exit/entry-shape/range-width/il-dominance + 8 per-tick Bend (7 proven incl. ta-live + tp-stubbed exit_order dry-run) + startup health-check) + loopback status (`AGENT_HTTP_PORT`, 0=disabled; `GET /health` open, `GET /status` static shape, loopback-only std listener, never blocks ticks) in `src/main.rs` shell the `bend` CLI against
binary needs no on-disk kernels file at runtime). Each mirrors
`bench/bend-parity-harness.ts`: write a temp probe file importing the
kernels, run `bend probe.bend`, parse the result off stdout. Every
subprocess call is bounded by a 30s timeout (thread + channel, no new deps)
and fails OPEN on any error — timeout, missing binary, non-finite input, or
a disagreeing kernel — collapsing to `None` so the caller falls back to the
host's native value. `main()` runs a one-shot startup health check
(`bend_health_check`) confirming the deployed `bend` agrees with the proven
`band_runaway` law (1392n → 300n) before anything trusts it.

Wired today (all shadow-only, observational, never acted on):

- `open_positions_count` + `MAX_OPEN_POSITIONS` (default 3, fail-closed) → per-tick `capacity open/max/at_capacity` shadow (open = `closed_at IS NULL` only; never blocks ENTER).
- `open_positions_per_pool` + `MAX_POSITIONS_PER_POOL` (default 2, fail-closed) → per-tick `pool-capacity pools/capped/pool/open/max/at_capacity` shadow on the fullest pool (`pools` = distinct pools with opens, `capped` = pools at cap; open per pool, `closed_at IS NULL` only; never blocks ENTER).
- `stop_loss_veto` + `STOP_LOSS_PCT` (default 0.15, fail-closed; exact TS `lossPct < -pct`, no disabled arm — pct 0 vetoes any loss) → per-position `stop_loss_veto` + `decision … stop_loss_shadow …` tally (breach predicate exact; TS also gates on HOLD/REBALANCE action, host counts breaches regardless — documented in fn doc; never vetoes).
- `open_exposure_per_pool` + `MAX_PER_POOL_ALLOCATION_PCT` (default 0.4, fail-closed) + `MAX_ENTRY_SIZE_USD` (default 500, fail-closed) → per-tick `allocation pool/exposure_usd/share/cap_pct/cap_usd/headroom_usd/max_entry_usd` on the fullest pool (gate-6 `maxSize` mirror; never blocks).
- `decision` summary → per-tick `decision open/exit_shadow/enter_blocked_shadow/danger_shadow/drift_rejects_shadow/capital_exits_shadow/stop_loss_shadow/band_health_shadow/gas_hold_shadow/recovery_hold_shadow/interval_hold_shadow/vol_exit_shadow/exit_order_loss_shadow/paper_days/paper_pass/cooldown_holds/drawdown_veto/at_capacity` counts over open positions + book-level halt/drawdown/paper/cooldown verdicts (option legs count Some(true), gas/interval/cooldown count Some(false)-holds, paper logs pass verdict; never blocks). `capital_exits_shadow` tallies the proven `K.capital_exit` kernel verdict — by LAWS it equals `danger_shadow` whenever Bend answers (kernel returns danger; `capital==danger` agreement is the check), and stays 0 with Bend absent while `danger_shadow` still counts natively.
- Startup health-check → proven `K.clamp_thr` via `bend::clamp_fee_il` (band_runaway 13.92→3.0, once at boot; per-tick ENTER floor uses the native `clamp_fee_il`, not a kernel consult).
- `bend::ta_exhausted` → `K.ta_exhausted` (thirteenth-wave confluence gate:
  RSI-overbought AND (BB-upper OR MACD-green); pure bool AND/OR over the native RSI2/BB/MACD triple
  (host-side, newest-first closes); exercised by native `ta_exhausted_truth_table` + bend-parity
  TA-exhaustion `it`, LAWS triple now proven (ta_overbought_fires /
  single_signal_quiet / cold_start_quiet); tick shadow live with native triple.
- `bend::exit_order` → `K.exit_order` (precedence gate: TP→TA→loss→none as 1n/2n/3n/0n;
  pure bool order, `decidePositionExit` shape WITHOUT wiring into `checkDeterministicExits`;
  exercised by native `exit_order_precedence` + bend-parity exit-order `it`,
  LAWS pending; DRY-RUN wired per-tick with tp stubbed false + REAL TA vote (native triple) + stored loss legs
  (`loss_hit = danger==Some(true) || stop_loss==Some(true)` → per-position `loss_hit/exit_order`
  + `decision … exit_order_loss_shadow` tally counting Some(3); tp leg still stubbed false, TA vote live; never acts).
- `bend::fee_known` → proven `K.fee_known`, per position per tick (pure bool
  passthrough of the host's own datapi comparison; mismatch-logged host-wins
  fail-open via `is_some_and`, silent when Bend is absent, never votes).
- `bend::fee_exit_fires` → proven `K.fee_exit_fires`, per open position per
  tick against real SQLite (`positions` + latest `signal_snapshots` /
  `pool_snapshots`; mirrors `checkFeeIlExit`'s core predicate, not its
  hold-bias override).
- `bend::accrual_allowed` → proven `K.accrual_allowed`, per position per
  tick (mirrors `accruePaperPositionFees`'s paper/no-pubkey/datapi guard).
- `bend::enter_blocked` → proven `K.enter_blocked`, per position's latest
  snapshot per tick (mirrors `feeIlHardFloorReason`'s il-on/known/ratio-floor
  predicate against the host-clamped floor).
- `bend::drift_rejects` → proven `K.drift_rejects`, per position's pool per
  tick (mirrors `driftGateRejected`'s strict `<` + `driftHardFloorReason`'s
  normal-lane-only semantics; drift = last − first `active_bin_id` over
  persisted `pool_snapshots` capped to `binHistoryCap`, cold start → 0).
- `bend::capital_exit` → proven `K.capital_exit`, per open position per tick
  (danger computed natively from the ledger via `loss_cap_danger`, mirroring
  `position-loss-cap.ts`; confidence 1.0 matches TS `conf1PositionExit` —
  kernel drops it either way, LAWS `capital_exit_free`/`capital_exit_quiet`).
- `evolve_shadow` → proven `K.evolve_thr` via `bend::evolve_thr`, one
  `tryEvolveThresholds` round per tick against live state (banded floors from
  `metadata` or config fallback × native `signal_lift` per leg; skips below
  `EVOLUTION_INTERVAL` outcomes like TS).

Still native-only (no Bend twin yet): none — all 7 per-tick Bend consults (6 per-position fee_exit/accrual/enter/drift/capital/fee_known + per-tick evolve_thr; `clamp_fee_il` at tick is the native ENTER-floor clamp, not a kernel consult) have a proven
Twin; `K.ta_exhausted` + `K.exit_order` are truth-table-probed, LAWS pending strategy review (not proven);
`K.fee_ratio` stays kernel-only (host lacks the IL estimator context,
so no host wrapper — `computeFeeIlRatio` needs in-memory bin-array + drift).

- `halt` circuit-breaker → per-tick `halt enabled/window/threshold_usd/closed/halted` (gate-2a mirror: trailing realized PnL over last-N closed positions below threshold pauses ENTERs; disabled → false, cold start → false; never blocks).

- `drawdown_veto` (gate-4 mirror: spot book-PnL vs `paper_portfolio_usd`, 10% hardcoded; book-level `drawdown_veto` verdict in `decision`; never blocks).

- `rebalance_range_invalid` + `MAX_REBALANCE_RANGE_BINS` (default = max = 200, fail-closed) → per-position `band_width_invalid/band_contains_active/band_width` + `decision … band_health_shadow` tally (gate-7 shape without a proposal: live-band width audit — upper<=lower or width>max flags unhealthy; containment logged separately since runner scale-ins anchor below active by design; never vetoes).
- `gas_rebalance_justified` + `REBALANCE_GAS_COST_SOL` (0.01) + `SOL_PRICE_USD` (150, [0,10000]) + `GAS_AWARE_MIN_DAYS_OF_FEES_PAID_AHEAD` (3) → per-position `gas_cost_usd/daily_fees_usd/gas_justified` + `decision … gas_hold_shadow` tally (F1 mirror: gas <= N-days position fees, share-capped daily fees from latest pool snapshot × current/tvl; unknown → None, never flags; never holds).
- `recovery_hold`/`recovery_probability` + `OOR_RECOVERY_HOLD_THRESHOLD` (0.6) + `OOR_RECOVERY_FORCE_REBALANCE_THRESHOLD` (0.2, logged-only) + `OOR_RECOVERY_LOOKBACK_CYCLES` window → per-position `rec_prob/rec_hold/rec_force` + `decision … recovery_hold_shadow` tally (F4 mirror: mean|Δ|/(mean|Δ|+drift) over persisted snapshot bins sliced to max(2, lookback), drift = |active−center|; cold start → 0.5, never holds alone; never holds).
- `rebalance_interval_cooled` + `MIN_REBALANCE_INTERVAL_MS` (86400000) + `OOR_GRACE_PERIOD_CYCLES` (3) → per-position `interval_cooled/oor_grace/last_rebal_ms` + `decision … interval_hold_shadow` tally (capital-gate first arm: now-last >= min OR grace count>=cycles; cold last=0 → cooled; never blocks). `paper_validation_pass` + `PAPER_VALIDATION_MIN_DAYS` (7) + `PAPER_VALIDATION_ENFORCE` (false) → book-level `paper_days/paper_pass` in `decision` (F6 mirror over `metadata.paperTradingDaysAccumulated`; paper → pass; !enforce → warn-pass; never blocks).
- `pool_cooldown_free` + `read_pool_cooldowns` → per-pool `cooldown pool/until/reason/free` + `decision … cooldown_holds` tally (F7 mirror: no row or now>=until → free; active cooldown → hold; missing table → empty, never blocks).
- `compound_approved` PARKED (unit-tested only, no tick call): exact F3 twin (net clears min+buffer+gas, fail-closed refuse arms, fail-open None) — needs the per-claim `netFeesUsd` leg (live claim result, program.ts:15218); `positions` cumulative is the wrong leg (false-approves), `fee_claims`/CLAIM events empty live. Wire only when a claim-time leg lands.
- `vol_exit_fires` + `bin_volatility_stddev` + `VOLATILITY_EXIT_STDDEV` (5.0, [0,∞)) over a persisted `pool_snapshots` vol window sliced to max(2, `VOLATILITY_LOOKBACK_SNAPSHOTS`) + driftPct = |active−center|/halfWidth from stored band legs + reused interval `cooled`/grace → per-position `vol_stddev/vol_drift_pct/vol_thr/vol_fires` and `decision … vol_exit_shadow` tally (native twin of `decidePhase2Exit` vol arm: high-vol AND drifted AND cooled; runner exempt in the twin but unreachable — host has no runner flag yet, so all rows report as normal-lane; never exits).
- `resolve_range_half_width` over stored `bin_step` + vol σ (tier 25/20/15 + coverage floor + σ-clamp(σ/2,0.5,2) + half-cap min(maxFull/2,34) + floor 5) → per-position `range_half_width/pool_bin_step/pool_current_price` (price provenance-only; never acts).
- `recommend_entry_strategy` over the stored vol/drift legs (σ, `VOLATILITY_EXIT_STDDEV`, `net_drift_bins` cold→0) → per-position `entry_shape/shape_drift` (`|drift|>=max(3,2σ)`→bidask, `σ>=thr`→spot, else curve; non-finite→curve; `auto` arm only, non-auto stays TS-owned; never acts).
- `hodl_value_usd` + `il_dominant` + `IL_DOMINANCE_EXIT_FACTOR` (2, min 1) + `IL_DOMINANCE_MIN_USD` (5, min 0) → per-position `shadow il_dominance gated/hodl_usd/il_usd/fees_usd/factor/min_usd/fires` + `decision … il_dominance_shadow` tally (computeIlDominance mirror: protection-on AND OOR AND HODL-priced AND il > fees × factor + floor; host-native floats, no Bend F32 kernel; missing legs → None, never fires; never exits).
## Parity plan vs Bun shadow

1. Run `prismd --ticks N` alongside the TS paper loop for N cycles (loop proven: `--ticks 3` emits 3 `tick=` + 3 `decision` lines); compare
   per-tick `positions` counts and kernel decisions.
   Grep-able per-tick lines (all `(observational)`, never acted on):
   `tick=` (total rows) → `capacity open/max/at_capacity` (portfolio ENTER
   headroom) → `pool-capacity pools/capped/pool/open/max/at_capacity` (fullest pool + aggregates) →
   per-position `shadow fee_il_exit …` → `decision open/exit_shadow/enter_blocked_shadow/danger_shadow/drift_rejects_shadow/capital_exits_shadow/stop_loss_shadow/band_health_shadow/gas_hold_shadow/recovery_hold_shadow/interval_hold_shadow/vol_exit_shadow/exit_order_loss_shadow/paper_days/paper_pass/cooldown_holds/drawdown_veto/at_capacity` (one-line
   verdict to diff against the TS `decided/executed/failed` cycle log).
2. Pass bar for the N-cycle compare: `decision open` == TS open count;
   `exit_shadow` ⊆ TS exits (shadow never fires alone); `capacity` /
   `pool-capacity` lines match the TS cap verdicts.
3. Wire the Jev client keeping fail-open soft semantics; promote gates only
   after verify-unit soak shows expectancy lift vs growth control.
4. Cut over verify unit, then growth; live only after both prove parity.
