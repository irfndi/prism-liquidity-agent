import Base

# Kernels: pure strategy/risk/gate math ported from engine/strategy-service.ts
# (clampThreshold, nudgeThreshold, evolveThresholds, computeFeeIlRatio) and
# engine/program.ts (feeIlHardFloorReason, driftHardFloorReason,
# passesMeasuredCandidateGates, fee/IL EXIT, paper accrual guard).
#
# Fixed-point Nat encoding: every ratio/threshold is an integer in hundredths
# (1.00 = 100n). Division floors. This keeps all kernels computable so LAWS
# can be proved by reflexivity — F32 comparisons are uninterpreted axioms in
# Bend 2.0.21 and closed F32 comparisons do not reduce to Bool (verified by
# probe: a bare F32 literal prints, a `{13.92 == 13.92 : Bool}` law errors
# "expected: Bool, observed: F32"). Version note: `bend --help` reports
# 2.0.21 and the launcher offers 2.0.23; the probe above ran on the 2.0.21
# binary at ~/.bend/bend/bin/bend. Re-verify on any version bump.
# TS mapping: feeIl [0.3,3.0] -> [30n,300n], auth [0.1,0.9] -> [10n,90n],
# util [0.05,0.8] -> [5n,80n], MAX_FEE_IL_RATIO 20 -> 2000n, EXIT 0.5 -> 50n.

# Absolute evolution bands (strategy-service.ts MIN_*_EVOLVED_*).
def fee_il_lo() -> Nat:
  30n

def fee_il_hi() -> Nat:
  300n

def auth_lo() -> Nat:
  10n

def auth_hi() -> Nat:
  90n

def util_lo() -> Nat:
  5n

def util_hi() -> Nat:
  80n

def max_fee_il() -> Nat:
  2000n

# clampThreshold: non-finite -> min has no Nat analogue (no NaN); callers pass
# only measured values. Otherwise Math.min(Math.max(v, min), max).
def clamp_thr(+x: Nat, +lo: Nat, +hi: Nat) -> Nat:
  Nat.min(Nat.max(x, lo), hi)

# nudgeThreshold branch on the computed order must live in a helper matching
# on its parameter (Bend forbids match on computed values).
def nudge_go(+cur: Nat, +tgt: Nat, +cap: Nat, ord: Cmp) -> Nat:
  match ord:
    case LT{}:
      Nat.sub(cur, Nat.min(Nat.sub(cur, tgt), cap))
    case GT{}:
      Nat.add(cur, Nat.min(Nat.sub(tgt, cur), cap))
    case EQ{}:
      cur

# nudgeThreshold(current, target, maxChangePct=num/den).
def nudge_thr(+cur: Nat, +tgt: Nat, +num: Nat, +den: Nat) -> Nat:
  nudge_go(cur, tgt, Nat.div(Nat.mul(cur, num), den), Nat.cmp(tgt, cur))

# Evolution target: current * (1 +/- lift), lift = lnum/lden, saturating down.
def evolve_tgt(+cur: Nat, up: Bool, +lnum: Nat, +lden: Nat) -> Nat:
  match up:
    case True{}:
      Nat.add(cur, Nat.div(Nat.mul(cur, lnum), lden))
    case False{}:
      Nat.sub(cur, Nat.div(Nat.mul(cur, lnum), lden))

# evolveThresholds one leg: nudge toward the lift target, then pin to band.
def evolve_thr(+cur: Nat, up: Bool, +lnum: Nat, +lden: Nat, +nnum: Nat, +nden: Nat, +lo: Nat, +hi: Nat) -> Nat:
  clamp_thr(nudge_thr(cur, evolve_tgt(cur, up, lnum, lden), nnum, nden), lo, hi)

# computeFeeIlRatio: il<=0 -> fees>0 ? MAX : 0, else min(fees/il, MAX).
def fee_ratio_zero(fees: Nat) -> Nat:
  match fees:
    case 0n:
      0n
    case 1n+p:
      2000n

def fee_ratio_nz(+fees: Nat, +il: Nat) -> Nat:
  Nat.min(Nat.div(fees, il), 2000n)

def fee_ratio(+fees: Nat, il: Nat) -> Nat:
  match il:
    case 0n:
      fee_ratio_zero(fees)
    case 1n+p:
      fee_ratio_nz(fees, 1n+p)

# feeIlRatioKnown: datapi-only (strategy-service.ts computeMetrics).
def fee_known(datapi: Bool) -> Bool:
  datapi

# [fee-il-gate] ENTER floor: blocks iff protection on AND ratio known AND
# ratio < min. Unknown (modeled) ratios pass through — never vote.
def enter_blocked(il_on: Bool, known: Bool, +ratio: Nat, +floor: Nat) -> Bool:
  Bool.and(il_on, Bool.and(known, Nat.is_lt(ratio, floor)))

# [drift-gate] ENTER predicate: rejects a normal-lane pool whose net drift is
# strictly below the floor magnitude. Sign/magnitude split keeps Nat total:
# (True{}, m) means -m bins. Runner/launch lanes exempt at call site.
def drift_rejects(neg: Bool, +mag: Nat, +floor_mag: Nat) -> Bool:
  Bool.and(neg, Nat.is_lt(floor_mag, mag))

# Fee/IL EXIT: fires iff ratio known AND position mature AND ratio < 0.5.
def fee_exit_fires(known: Bool, mature: Bool, +ratio: Nat) -> Bool:
  Bool.and(known, Bool.and(mature, Nat.is_lt(ratio, 50n)))

# Paper accrual guard: paper mode AND no on-chain pubkey AND datapi source.
def accrual_allowed(paper: Bool, onchain: Bool, datapi: Bool) -> Bool:
  Bool.and(paper, Bool.and(Bool.not(onchain), datapi))

# TA-exhaustion EXIT confluence (thirteenth-wave spec, `engine/ta-exhaustion.ts`
# target): fires iff RSI(2) is overbought AND (close above BB-upper OR first
# MACD-green histogram). The TS side computes RSI/BB/MACD from
# `pool_snapshots.current_price` history and passes three bools here — the
# kernel is the pure AND/OR gate, so F32 indicator math never enters Bend.
# Fail-open cold start lives at the call site (fewer than
# `TA_EXHAUSTION_MIN_POINTS` history rows -> no vote, like drift).
def ta_exhausted(rsi_overbought: Bool, above_bb_upper: Bool, macd_first_green: Bool) -> Bool:
  Bool.and(rsi_overbought, Bool.or(above_bb_upper, macd_first_green))

# Pure-bool exit-order gate (no soak touch, NOT wired into
# `checkDeterministicExits`): TP-ladder hit wins over TA-exhaustion, which
# wins over any loss-side signal. Takes the three branch verdicts
# precomputed — the kernel is the precedence chain, so no exit semantics
# enter Bend beyond bool order. Fail-open cold start lives at the call site.
def exit_order(tp_hit: Bool, ta_hit: Bool, loss_hit: Bool) -> Nat:
  match tp_hit:
    case True{}:
      1n
    case False{}:
      match ta_hit:
        case True{}:
          2n
        case False{}:
          match loss_hit:
            case True{}:
              3n
            case False{}:
              0n

# Capital-protection EXIT: fires on the danger signal alone — the confidence
# argument is accepted and dropped, so no confidence value can block it.
def capital_exit(danger: Bool, +conf: Nat) -> Bool:
  danger

# URANUS-class loss-magnitude floor: mark PnL ≤ -(deposit × pct). All legs are
# fixed-point Nat in hundredths of USD (cents-as-Nat: $30.00 = 3000n). `pnl`
# is a (negative?, magnitude) pair like drift — (True{}, m) means -$m — so
# the at-or-below direction keeps its meaning without signed ints.
# The floor magnitude is PRECOMPUTED by the host (deposited × min(pct,1), in
# cents, native f64) rather than multiplied here: Bend's Nat is unary, so
# `Nat.mul(100000n, 35n)` builds 3.5M successor nodes and a probe takes
# 20-50s (measured). The kernel owns the proven COMPARISON — the at-or-below
# direction is what `loss_cap_danger` and its tighter-cap twin both consult,
# so the law pins one predicate instead of two Rust call sites. Arithmetic
# stays native f64, same as `loss_cap_danger` (position-loss-cap.ts:22-40).
# Exact-boundary parity with loss_cap_danger_guards: deposit 1000.00,
# pnl -35.00 → floor 35000n-cents → fires; pnl -34.99 → holds.
# URANUS-SOL 2026-09-20 legs: deposit $30.00, realized -$8.15 = 27.17% mark
# loss, floor at 35% = $10.50 → 815n < 1050n → HOLDS (the cap never should
# have fired; the trailing-stop 10% breach owns that close).
def loss_magnitude_fires(pnl_neg: Bool, +pnl_mag: Nat, +floor_mag: Nat) -> Bool:
  match pnl_neg:
    case True{}:
      Nat.is_le(floor_mag, pnl_mag)
    case False{}:
      False{}

# Dust-cleanup EXIT arm (program.ts isDustExit): REAL mark STRICTLY below the
# dust threshold, threshold > 0. `mark`/`floor` are Nat cents; `floor_on`
# projects `dustExitUsd > 0` at the call site. Zero-disabled arm lives here
# (not at the call site) so the law can pin it: a disabled floor never fires.
def dust_exit_fires(floor_on: Bool, +mark: Nat, +floor: Nat) -> Bool:
  Bool.and(floor_on, Nat.is_lt(mark, floor))

# ── PnL accounting (position lifecycle) ───────────────────────────────────
# Ported from engine/adapter-service.ts `netWithdrawnUsd` /
# `computeEntryOverheadUsd` and engine/pnl.ts `computeRealizedPnlUsd`.
# Units: whole US cents (Nat). $19.88 is 1988n. Same fixed-point discipline as
# the strategy kernels; the host keeps f64 dollars, the kernel owns the
# PROVEN identity.
#
# Why it exists (live forensics 2026-11-26): entry measured the deposit only,
# exit measured the whole wallet delta (which includes the rent refund for the
# position, its bin arrays and its ATAs). A dead-flat round trip therefore
# booked `rent` as profit — +16% on a $20 position — and the rolling halt
# never armed. These kernels are the fix's contract.

# Deposit-only realized value for an exit: measured gross back minus the cash
# the entry spent beyond its deposit. Saturating Nat.sub IS the max(0, …)
# floor: overhead larger than the withdrawal yields 0, never a negative one.
def net_withdrawn(+gross_c: Nat, +overhead_c: Nat) -> Nat:
  Nat.sub(gross_c, overhead_c)

# Realized PnL as an unsigned magnitude plus a direction, because Bend's Nat
# has no negatives. `realized_gain_c` is what is left after covering the cost
# basis; `realized_loss_c` is the shortfall. Exactly one is non-zero.
def realized_gain_c(
  +gross_c: Nat, +overhead_c: Nat, +prior_fees_c: Nat, +rewards_c: Nat, +deposit_c: Nat,
) -> Nat:
  Nat.sub(
    Nat.add(Nat.add(net_withdrawn(gross_c, overhead_c), prior_fees_c), rewards_c),
    deposit_c,
  )

def realized_loss_c(
  +gross_c: Nat, +overhead_c: Nat, +prior_fees_c: Nat, +rewards_c: Nat, +deposit_c: Nat,
) -> Nat:
  Nat.sub(
    deposit_c,
    Nat.add(Nat.add(net_withdrawn(gross_c, overhead_c), prior_fees_c), rewards_c),
  )

# Rolling realized-PnL halt: arms strictly BELOW the threshold. The bug's
# damage was not this predicate — it was feeding it rent-inflated input.
def halt_armed(+rolling_neg: Bool, +rolling_mag: Nat, +threshold_mag: Nat) -> Bool:
  match rolling_neg:
    case True{}:
      Nat.is_gt(rolling_mag, threshold_mag)
    case False{}:
      False{}

# Break-even hold in whole DAYS from round-trip cost and fee APR, both in
# basis points: days = cost_bps * 365 / apr_bps (floored).
def break_even_days(+cost_bps: Nat, +apr_bps: Nat) -> Nat:
  Nat.div(Nat.mul(cost_bps, 365n), apr_bps)

# Entry cost basis gap: cash that left the wallet beyond the deposit.
def entry_overhead_c(+spent_c: Nat, +deposit_c: Nat) -> Nat:
  Nat.sub(spent_c, deposit_c)

# ── Selection + evolution ────────────────────────────────────────────────
# The market gate is the door to every lane: a floor that rejects everything
# silently turns the agent off, and a floor relaxed during tuning must never
# un-admit a pool that already qualified. These kernels pin both directions.

# One admission floor (TVL, fees24h, volume24h, holders all reduce to this).
def pool_admitted(+value: Nat, +floor: Nat) -> Bool:
  Nat.is_ge(value, floor)

# How many pools actually get scanned: ranked ∩ TOP_K ∩ MAX_POOLS.
def active_count(+ranked: Nat, +top_k: Nat, +max_pools: Nat) -> Nat:
  Nat.min(Nat.min(ranked, top_k), max_pools)

# ── Dynamic hold ─────────────────────────────────────────────────────────
# How long a position must live before an ECONOMIC exit may fire, from its
# own realized fee rate. A fixed age gate is wrong for both a 30,000% pool
# (round trip covered in minutes) and a 40% pool (needs days).
#
# Units: cost and fees in whole cents, time in whole HOURS. Bend's Nat is
# unary, so a seconds encoding (500 x 864000) would build 4.3e8 successor
# nodes and never finish; hours keep the same identity computable.
#   hold_h = roundTripCost_c * age_h / accruedFees_c
def break_even_hold_h(+cost_c: Nat, +age_h: Nat, +fees_c: Nat) -> Nat:
  Nat.div(Nat.mul(cost_c, age_h), fees_c)

# The gate actually used: the measured hold when it is known (non-zero),
# else the configured fallback. `nonzero` carries the comparison (Bend cannot
# match on a computed value). No cap: capping re-imposes the fixed gate.
def maturity_gate_s(+measured_s: Nat, +fallback_s: Nat, nonzero: Bool) -> Nat:
  match nonzero:
    case True{}:
      measured_s
    case False{}:
      fallback_s

# An OPTIONAL ceiling for callers that want one (min is the only added rule).
def maturity_gate_capped_s(+measured_s: Nat, +cap_s: Nat) -> Nat:
  Nat.min(measured_s, cap_s)

# ── Entry momentum (normal / market lane) ────────────────────────────────
# Ported from engine/strategy-service.ts `entryMomentumBoost` and
# `normalEntryConfidence`. Confidence and weight are hundredths (0.05 = 5n);
# fee/IL is hundredths (2.00 = 200n); drift and its reference are whole bins.
#
# Why it exists: the drift gate rejects a falling pool, but a rising one used
# to enter on the SAME static confidence as a flat one, so momentum never
# reached the score or the confidence floor. The boost is deliberately bounded
# — unbounded momentum credit would let a single spike clear the ENTER floor.
#
# `neg` carries the drift sign (Bend's Nat cannot hold it). A negative drift
# contributes ZERO: there is no credit for falling prices. `ref = 0` is the
# unknown-reference case, which contributes zero rather than dividing.
def momentum_scaled(neg: Bool, +drift: Nat, +ref: Nat, +weight_h: Nat) -> Nat:
  match neg:
    case True{}:
      0n
    case False{}:
      match ref:
        case 0n:
          0n
        case 1n+p:
          Nat.div(Nat.mul(Nat.min(drift, 1n+p), weight_h), 1n+p)

# normalEntryConfidence: min(0.50 + feeIlRatio x 0.05 + momentum, 0.85).
def normal_conf_h(+fee_il_100: Nat, neg: Bool, +drift: Nat, +ref: Nat, +weight_h: Nat) -> Nat:
  Nat.min(
    Nat.add(Nat.add(50n, Nat.div(fee_il_100, 20n)), momentum_scaled(neg, drift, ref, weight_h)),
    85n,
  )

# Evolution may move a threshold, but a hard safety floor still bounds it:
# `evolveThresholds` clamps to the band, then the safety floor applies.
def with_hard_floor(+evolved: Nat, +hard_floor: Nat) -> Nat:
  Nat.max(evolved, hard_floor)

def main() -> Nat:
  clamp_thr(1392n, 30n, 300n)
