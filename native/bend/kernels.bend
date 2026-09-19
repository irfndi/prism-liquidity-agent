import Base

# Kernels: pure strategy/risk/gate math ported from engine/strategy-service.ts
# (clampThreshold, nudgeThreshold, evolveThresholds, computeFeeIlRatio) and
# engine/program.ts (feeIlHardFloorReason, driftHardFloorReason,
# passesMeasuredCandidateGates, fee/IL EXIT, paper accrual guard).
#
# Fixed-point Nat encoding: every ratio/threshold is an integer in hundredths
# (1.00 = 100n). Division floors. This keeps all kernels computable so LAWS
# can be proved by reflexivity — F32 comparisons are uninterpreted axioms in
# Bend 2.0.5 and closed F32 terms do not reduce (verified by probe).
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
def main() -> Nat:
  clamp_thr(1392n, 30n, 300n)
