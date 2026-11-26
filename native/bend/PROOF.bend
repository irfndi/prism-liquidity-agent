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

# ── TA-exhaustion projected P&L + policy (#237) ───────────────────────────

def L.ta_rebalance_absent_is_gain():
  {==}

def L.ta_rebalance_cost_flips_to_loss():
  {==}

def L.ta_pending_fees_flip_to_gain():
  {==}

def L.ta_pending_rewards_flip_to_gain():
  {==}

def L.ta_without_pending_is_loss():
  {==}

def L.ta_claimed_fees_and_rewards_credit():
  {==}

def L.ta_flat_net_is_no_loss():
  {==}

def L.ta_loss_label_never_profit(k):
  match k:
    case False{}:
      {==}
    case True{}:
      {==}

def L.ta_label_loss_is_losing():
  {==}

def L.ta_label_zero_loss_is_profit():
  {==}

def L.ta_label_unknown_is_unknown():
  {==}

def L.ta_known_requires_mark():
  {==}

def L.ta_known_requires_pending():
  {==}

def L.ta_known_requires_overhead():
  {==}

def L.ta_known_requires_net_amounts():
  {==}

def L.ta_known_when_all_present():
  {==}

def L.ta_nonnegative_zero_loss():
  {==}

def L.ta_loss_is_never_nonnegative(k):
  match k:
    case False{}:
      {==}
    case True{}:
      {==}

def L.ta_gate_off_never_blocks(r):
  match r:
    case False{}:
      {==}
    case True{}:
      {==}

def L.ta_gate_nonnegative_passes_without_ratio():
  {==}

def L.ta_gate_loss_ratio_at_floor_passes():
  {==}

def L.ta_gate_loss_ratio_below_floor_fails():
  {==}

def L.ta_gate_unknown_ratio_equals_nonnegative(n):
  match n:
    case False{}:
      {==}
    case True{}:
      {==}

def L.ta_hold_disabled_passes():
  {==}

def L.ta_hold_at_floor_passes():
  {==}

def L.ta_hold_below_floor_blocks():
  {==}

def L.ta_rsi_strictly_above_trips():
  {==}

def L.ta_rsi_at_threshold_holds():
  {==}

def L.ta_rsi_threshold_100_never_trips():
  {==}

def L.ta_vote_all_gates_fire():
  {==}

def L.ta_vote_disabled_quiet():
  {==}

def L.ta_vote_hold_gate_quiet():
  {==}

def L.ta_vote_confluence_quiet():
  {==}

def L.ta_vote_pnl_gate_quiet():
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

# Observable: the runaway pins to the ceiling.
def main() -> Nat:
  K.clamp_thr(1392n, 30n, 300n)
