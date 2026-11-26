import Base
import kernels.bend as K
import LAWS.bend as L

# PROOF: proves every law in LAWS.bend. `bend PROOF.bend` is the gate: it
# fails while any law is open or false. AI-owned: regenerate with the code.

def L.band_runaway():
  {==}

def L.band_cap_twenty():
  {==}

def L.band_floor():
  {==}

def L.band_passthrough():
  {==}

def L.evolve_single_nudge():
  {==}

def L.evolve_ceiling_pins():
  {==}

def L.evolve_floor_pins():
  {==}

def L.modeled_never_blocks_enter(a, k):
  match a k:
    case False{} False{}:
      {==}
    case False{} True{}:
      {==}
    case True{} False{}:
      {==}
    case True{} True{}:
      {==}

def L.high_ratio_never_blocks(a, k):
  match a k:
    case False{} False{}:
      {==}
    case False{} True{}:
      {==}
    case True{} False{}:
      {==}
    case True{} True{}:
      {==}

def L.modeled_never_forces_exit(k, m):
  match k m:
    case False{} False{}:
      {==}
    case False{} True{}:
      {==}
    case True{} False{}:
      {==}
    case True{} True{}:
      {==}

def L.capital_exit_free(c):
  {==}

def L.capital_exit_quiet(c):
  {==}

def L.accrual_datapi_only(p, o):
  match p o:
    case False{} False{}:
      {==}
    case False{} True{}:
      {==}
    case True{} False{}:
      {==}
    case True{} True{}:
      {==}

def L.accrual_paper_no_pubkey(p, o):
  match p o:
    case False{} False{}:
      {==}
    case False{} True{}:
      {==}
    case True{} False{}:
      {==}
    case True{} True{}:
      {==}

def L.drift_strict_floor(m):
  {==}

def L.drift_uphill_passes(m):
  {==}

def L.ta_overbought_fires(b, m):
  match b m:
    case False{} False{}:
      {==}
    case False{} True{}:
      {==}
    case True{} False{}:
      {==}
    case True{} True{}:
      {==}

def L.ta_single_signal_quiet(b, m):
  match b m:
    case False{} False{}:
      {==}
    case False{} True{}:
      {==}
    case True{} False{}:
      {==}
    case True{} True{}:
      {==}

def L.ta_cold_start_quiet():
  {==}

# ── PnL accounting (kernels appended 2026-11-26) ──────────────────────────

def L.flat_round_trip_no_gain():
  {==}

def L.flat_round_trip_no_loss():
  {==}

def L.rent_booked_as_profit_without_overhead():
  {==}

def L.overhead_never_credits():
  {==}

def L.overhead_above_withdrawal_floors():
  {==}

def L.real_loss_still_loss():
  {==}

def L.real_loss_not_a_gain():
  {==}

def L.real_gain_survives():
  {==}

def L.prior_fees_credit():
  {==}

def L.halt_arms_on_real_loss():
  {==}

def L.halt_quiet_at_threshold():
  {==}

def L.halt_quiet_on_profit(m):
  match m:
    case 0n:
      {==}
    case 1n+p:
      L.halt_quiet_on_profit(p)

def L.break_even_30bps_at_71pct():
  {==}

def L.break_even_60bps_at_71pct():
  {==}

def L.break_even_60bps_at_450pct():
  {==}

def L.break_even_hotter_pool_not_longer():
  {==}

def L.entry_overhead_is_the_gap():
  {==}

def L.entry_overhead_never_negative():
  {==}

# ── Dynamic hold (kernels appended 2026-11-26) ────────────────────────────

def L.hold_break_even_exact():
  {==}

def L.hold_zero_cost_is_immediate():
  {==}

def L.hold_faster_fees_shorter():
  {==}

def L.hold_bigger_cost_longer():
  {==}

def L.maturity_uses_measured_hold():
  {==}

def L.maturity_uses_measured_hold_even_when_long():
  {==}

def L.maturity_falls_back_when_unknown():
  {==}

def L.maturity_explicit_cap_applies_only_when_asked():
  {==}

def L.maturity_explicit_cap_is_a_floor_when_under():
  {==}

# ── Selection + evolution (kernels appended 2026-11-26) ───────────────────

def L.floor_inclusive_at_boundary():
  {==}

def L.floor_rejects_below():
  {==}

def L.relaxed_floor_keeps_admitted_pool():
  {==}

def L.tightened_floor_drops_pool():
  {==}

def L.capacity_bounded_by_top_k():
  {==}

def L.capacity_bounded_by_max_pools():
  {==}

def L.capacity_never_exceeds_universe():
  {==}

def L.hard_floor_survives_low_evolution():
  {==}

def L.hard_floor_survives_high_evolution():
  {==}

def L.hard_floor_at_exact_boundary():
  {==}

# ── Entry momentum (kernels appended 2026-11-26) ──────────────────────────

def L.momentum_negative_never_credits(m):
  {==}

def L.momentum_zero_drift_quiet():
  {==}

def L.momentum_unknown_reference_quiet():
  {==}

def L.momentum_quarter_reference():
  {==}

def L.momentum_saturates_at_reference():
  {==}

def L.momentum_past_reference_saturates():
  {==}

def L.confidence_static_floor():
  {==}

def L.confidence_momentum_reaches_floor():
  {==}

def L.confidence_falling_no_lift():
  {==}

def L.confidence_ceiling_pin():
  {==}

def L.confidence_ceiling_holds_with_momentum():
  {==}

def L.confidence_monotone_in_fee_il():
  {==}

# Observable: the runaway pins to the ceiling.
def main() -> Nat:
  K.clamp_thr(1392n, 30n, 300n)
