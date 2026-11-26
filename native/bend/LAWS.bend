import Base
import kernels.bend as K

# LAWS: strategy invariants. Human-owned: do not edit without strategy review.
# Units are fixed-point hundredths (1.00 = 100n); see kernels.bend header.

# 1. Evolved min_fee_il_ratio stays in [0.3, 3.0] — band closure at
# representative points incl. the 2026-09 runaway (1.2 -> 13.92).
law band_runaway:
  {K.clamp_thr(1392n, 30n, 300n) == 300n : Nat}

law band_cap_twenty:
  {K.clamp_thr(2000n, 30n, 300n) == 300n : Nat}

law band_floor:
  {K.clamp_thr(5n, 30n, 300n) == 30n : Nat}

law band_passthrough:
  {K.clamp_thr(120n, 30n, 300n) == 120n : Nat}

# Full evolve leg: one round nudges at most +20% (1.20 -> 1.44 toward a
# 13.92 lift target); at the ceiling the same lift pins to 3.00, and a
# downward lift from the floor pins to 0.30.
law evolve_single_nudge:
  {K.evolve_thr(120n, True{}, 1060n, 100n, 20n, 100n, 30n, 300n) == 144n : Nat}

law evolve_ceiling_pins:
  {K.evolve_thr(280n, True{}, 1060n, 100n, 20n, 100n, 30n, 300n) == 300n : Nat}

law evolve_floor_pins:
  {K.evolve_thr(30n, False{}, 50n, 100n, 20n, 100n, 30n, 300n) == 30n : Nat}
# 2. Modeled fee/IL never forces EXIT nor blocks ENTER alone: with a low
# ratio (0.10 < 1.20 floor) the ENTER block equals protection-AND-known, so
# unknown (modeled) input can never block; a high ratio (5.00) never blocks.
law modeled_never_blocks_enter:
  for a: Bool
  for k: Bool
  {K.enter_blocked(a, k, 10n, 120n) == Bool.and(a, k) : Bool}

law high_ratio_never_blocks:
  for a: Bool
  for k: Bool
  {K.enter_blocked(a, k, 500n, 120n) == False{} : Bool}

law modeled_never_forces_exit:
  for k: Bool
  for m: Bool
  {K.fee_exit_fires(k, m, 10n) == Bool.and(k, m) : Bool}

# 3. EXIT capital path needs no confidence: any confidence value exits.
law capital_exit_free:
  for c: Nat
  {K.capital_exit(True{}, c) == True{} : Bool}

law capital_exit_quiet:
  for c: Nat
  {K.capital_exit(False{}, c) == False{} : Bool}

# 4. Paper accrual only when statsSource == datapi: non-datapi never accrues;
# datapi accrues exactly for paper positions without an on-chain pubkey.
law accrual_datapi_only:
  for p: Bool
  for o: Bool
  {K.accrual_allowed(p, o, False{}) == False{} : Bool}

law accrual_paper_no_pubkey:
  for p: Bool
  for o: Bool
  {K.accrual_allowed(p, o, True{}) == Bool.and(p, Bool.not(o)) : Bool}

# Drift floor: strict below-floor only (at-floor passes); runner/launch
# exemption lives at the call site, encoded here as exemption flags that
# always pass. Drift is (negative?, magnitude); floor magnitude 8 bins.
law drift_strict_floor:
  for m: Nat
  {K.drift_rejects(True{}, m, 8n) == Nat.is_lt(8n, m) : Bool}

law drift_uphill_passes:
  for m: Nat
  {K.drift_rejects(False{}, m, 8n) == False{} : Bool}

# 5. TA-exhaustion confluence (strategy review: TA file landed + parity
# green): overbought RSI fires with either confirm; without RSI nothing
# fires; RSI alone (cold start, confirms unavailable) never fires.
law ta_overbought_fires:
  for b: Bool
  for m: Bool
  {K.ta_exhausted(True{}, b, m) == Bool.or(b, m) : Bool}

law ta_single_signal_quiet:
  for b: Bool
  for m: Bool
  {K.ta_exhausted(False{}, b, m) == False{} : Bool}

law ta_cold_start_quiet:
  {K.ta_exhausted(True{}, False{}, False{}) == False{} : Bool}

# 5. PnL accounting: realized PnL must be a difference of LIKE-MEASURED cash.
# The exit measures the whole wallet delta (deposit + rent refund + fees); the
# entry must therefore subtract everything it spent beyond the deposit, or
# refunded rent is booked as revenue. Representative point is the live
# 2026-11-20 shape: $19.88 deposit, $3.00 rent+wrap gap, $22.88 measured back.

# A dead-flat round trip books ZERO once the entry overhead is subtracted.
law flat_round_trip_no_gain:
  {K.realized_gain_c(2288n, 300n, 0n, 0n, 1988n) == 0n : Nat}

law flat_round_trip_no_loss:
  {K.realized_loss_c(2288n, 300n, 0n, 0n, 1988n) == 0n : Nat}

# The regression, pinned: WITHOUT the subtraction the same flat round trip
# books the rent as profit (+$3.00 on $19.88 = +15.1%).
law rent_booked_as_profit_without_overhead:
  {K.realized_gain_c(2288n, 0n, 0n, 0n, 1988n) == 300n : Nat}

# Overhead is never a credit: subtracting it can only lower the value.
law overhead_never_credits:
  {K.net_withdrawn(2288n, 300n) == 1988n : Nat}

law overhead_above_withdrawal_floors:
  {K.net_withdrawn(200n, 300n) == 0n : Nat}

# Genuine outcomes survive the correction.
law real_loss_still_loss:
  {K.realized_loss_c(1800n, 300n, 0n, 0n, 1988n) == 488n : Nat}

law real_loss_not_a_gain:
  {K.realized_gain_c(1800n, 300n, 0n, 0n, 1988n) == 0n : Nat}

law real_gain_survives:
  {K.realized_gain_c(2500n, 300n, 0n, 0n, 1988n) == 212n : Nat}

law prior_fees_credit:
  {K.realized_gain_c(2288n, 300n, 500n, 0n, 1988n) == 500n : Nat}

# 6. Halt arming: strict-below only, and never on a non-loss.
law halt_arms_on_real_loss:
  {K.halt_armed(True{}, 488n, 350n) == True{} : Bool}

law halt_quiet_at_threshold:
  {K.halt_armed(True{}, 350n, 350n) == False{} : Bool}

law halt_quiet_on_profit:
  for m: Nat
  {K.halt_armed(False{}, m, 350n) == False{} : Bool}

# 7. Break-even hold: the arithmetic that decides whether a size/hold pair can
# pay for its own round trip at all.
law break_even_30bps_at_71pct:
  {K.break_even_days(30n, 7100n) == 1n : Nat}

law break_even_60bps_at_71pct:
  {K.break_even_days(60n, 7100n) == 3n : Nat}

law break_even_60bps_at_450pct:
  {K.break_even_days(60n, 45000n) == 0n : Nat}

law break_even_hotter_pool_not_longer:
  {Nat.is_le(K.break_even_days(60n, 45000n), K.break_even_days(60n, 7100n)) == True{} : Bool}

# 8. Entry overhead is the cash gap, saturating at zero.
law entry_overhead_is_the_gap:
  {K.entry_overhead_c(3171n, 2749n) == 422n : Nat}

law entry_overhead_never_negative:
  {K.entry_overhead_c(2000n, 2749n) == 0n : Nat}

# 9. TA-exhaustion projected P&L (#237): the reasoning label and the opt-in
# P&L gate must agree with the settlement-identical projection. Units are US
# cents; a projected net is a (gain, loss) pair, exactly one non-zero.
#
# Inclusion: prior paper rebalance costs and live pending fees/rewards move the
# sign.
law ta_rebalance_absent_is_gain:
  {K.ta_gain_c(1011n, 0n, 0n, 0n, 0n, 1000n, 0n, 10n) == 1n : Nat}

law ta_rebalance_cost_flips_to_loss:
  {K.ta_loss_c(1011n, 0n, 0n, 0n, 0n, 1000n, 2n, 10n) == 1n : Nat}

law ta_pending_fees_flip_to_gain:
  {K.ta_gain_c(980n, 0n, 0n, 30n, 0n, 1000n, 0n, 5n) == 5n : Nat}

law ta_pending_rewards_flip_to_gain:
  {K.ta_gain_c(980n, 0n, 0n, 0n, 30n, 1000n, 0n, 5n) == 5n : Nat}

law ta_without_pending_is_loss:
  {K.ta_loss_c(980n, 0n, 0n, 0n, 0n, 1000n, 0n, 5n) == 25n : Nat}

law ta_claimed_fees_and_rewards_credit:
  {K.ta_gain_c(1000n, 10n, 2n, 0n, 0n, 1000n, 0n, 0n) == 12n : Nat}

law ta_flat_net_is_no_loss:
  {K.ta_loss_c(1000n, 0n, 0n, 0n, 0n, 1000n, 0n, 0n) == 0n : Nat}

# Label honesty: a loss is never labeled profit (known or unknown); break-even
# is profit (net >= 0); unknown provenance is unknown, never a sign.
law ta_loss_label_never_profit:
  for k: Bool
  {Nat.is_lt(K.ta_label(25n, k), 2n) == True{} : Bool}

law ta_label_loss_is_losing:
  {K.ta_label(25n, True{}) == 1n : Nat}

law ta_label_zero_loss_is_profit:
  {K.ta_label(0n, True{}) == 2n : Nat}

law ta_label_unknown_is_unknown:
  {K.ta_label(25n, False{}) == 0n : Nat}

# Provenance: either unknown input makes the projection unknown.
law ta_known_requires_mark:
  {K.ta_known(False{}, True{}, True{}, True{}) == False{} : Bool}

law ta_known_requires_pending:
  {K.ta_known(True{}, False{}, True{}, True{}) == False{} : Bool}

law ta_known_requires_overhead:
  {K.ta_known(True{}, True{}, False{}, True{}) == False{} : Bool}

law ta_known_requires_net_amounts:
  {K.ta_known(True{}, True{}, True{}, False{}) == False{} : Bool}

law ta_known_when_all_present:
  {K.ta_known(True{}, True{}, True{}, True{}) == True{} : Bool}

# Non-negative requires known AND zero loss.
law ta_nonnegative_zero_loss:
  {K.ta_nonnegative(True{}, 0n) == True{} : Bool}

law ta_loss_is_never_nonnegative:
  for k: Bool
  {K.ta_nonnegative(k, 25n) == False{} : Bool}

# P&L gate: off is unconditional; on passes nonnegative OR a measured
# ratio at/above the floor. Unknown ratios can never satisfy the OR.
law ta_gate_off_never_blocks:
  for r: Bool
  {K.ta_pnl_gate(False{}, False{}, r, 2000n, 120n) == True{} : Bool}

law ta_gate_nonnegative_passes_without_ratio:
  {K.ta_pnl_gate(True{}, True{}, False{}, 0n, 120n) == True{} : Bool}

law ta_gate_loss_ratio_at_floor_passes:
  {K.ta_pnl_gate(True{}, False{}, True{}, 120n, 120n) == True{} : Bool}

law ta_gate_loss_ratio_below_floor_fails:
  {K.ta_pnl_gate(True{}, False{}, True{}, 119n, 120n) == False{} : Bool}

law ta_gate_unknown_ratio_equals_nonnegative:
  for n: Bool
  {K.ta_pnl_gate(True{}, n, False{}, 2000n, 120n) == n : Bool}

# Hold floor: at-floor passes, below-floor blocks, disabled passes.
law ta_hold_disabled_passes:
  {K.ta_hold_ok(0n, 0n) == True{} : Bool}

law ta_hold_at_floor_passes:
  {K.ta_hold_ok(3500n, 3500n) == True{} : Bool}

law ta_hold_below_floor_blocks:
  {K.ta_hold_ok(3499n, 3500n) == False{} : Bool}

# Configurable RSI trip line: strict >, and threshold 100 never trips.
law ta_rsi_strictly_above_trips:
  {K.ta_rsi_trips(91n, 90n) == True{} : Bool}

law ta_rsi_at_threshold_holds:
  {K.ta_rsi_trips(90n, 90n) == False{} : Bool}

law ta_rsi_threshold_100_never_trips:
  {K.ta_rsi_trips(100n, 100n) == False{} : Bool}

# The full vote requires every gate.
law ta_vote_all_gates_fire:
  {K.ta_vote(True{}, True{}, True{}, True{}) == True{} : Bool}

law ta_vote_disabled_quiet:
  {K.ta_vote(False{}, True{}, True{}, True{}) == False{} : Bool}

law ta_vote_hold_gate_quiet:
  {K.ta_vote(True{}, False{}, True{}, True{}) == False{} : Bool}

law ta_vote_confluence_quiet:
  {K.ta_vote(True{}, True{}, False{}, True{}) == False{} : Bool}

law ta_vote_pnl_gate_quiet:
  {K.ta_vote(True{}, True{}, True{}, False{}) == False{} : Bool}
# 10. Selection: an admission floor is inclusive at the boundary and strict
# below it, and RELAXING a floor can never un-admit a pool that qualified.
# (2026-11-26: absolute fees/volume floors of $3,000/$1M admitted 2 of 3,000
# pools; the same gate at $300/$250k admits 43. The door, not the engine.)
law floor_inclusive_at_boundary:
  {K.pool_admitted(5000n, 5000n) == True{} : Bool}

law floor_rejects_below:
  {K.pool_admitted(4999n, 5000n) == False{} : Bool}

law relaxed_floor_keeps_admitted_pool:
  {K.pool_admitted(6000n, 300n) == True{} : Bool}

law tightened_floor_drops_pool:
  {K.pool_admitted(6000n, 7000n) == False{} : Bool}

# 11. Capacity: the active scan set is bounded by TOP_K and MAX_POOLS no
# matter how many pools rank. A rising universe must not silently widen the
# cycle into an RPC bill.
law capacity_bounded_by_top_k:
  {K.active_count(500n, 40n, 80n) == 40n : Nat}

law capacity_bounded_by_max_pools:
  {K.active_count(500n, 100n, 80n) == 80n : Nat}

law capacity_never_exceeds_universe:
  {K.active_count(7n, 40n, 80n) == 7n : Nat}

# 11b. Dynamic hold: break-even time is cost x age / fees, so a faster fee
# rate can only shorten it and a bigger round trip can only lengthen it.
law hold_break_even_exact:
  {K.break_even_hold_h(500n, 4n, 25n) == 80n : Nat}

law hold_zero_cost_is_immediate:
  {K.break_even_hold_h(0n, 4n, 25n) == 0n : Nat}

law hold_faster_fees_shorter:
  {Nat.is_le(K.break_even_hold_h(500n, 4n, 50n), K.break_even_hold_h(500n, 4n, 25n)) == True{} : Bool}

law hold_bigger_cost_longer:
  {Nat.is_le(K.break_even_hold_h(2500n, 4n, 100n), K.break_even_hold_h(500n, 4n, 100n)) == False{} : Bool}

# The measured hold is used as-is when known — a cap would re-impose the fixed
# gate this policy removes (a 40% APR pool needs ~11 days; capping at 24h was
# the original bug moved from 12h to 24h).
law maturity_uses_measured_hold:
  {K.maturity_gate_s(1n, 12n, True{}) == 1n : Nat}

law maturity_uses_measured_hold_even_when_long:
  {K.maturity_gate_s(264n, 12n, True{}) == 264n : Nat}

law maturity_falls_back_when_unknown:
  {K.maturity_gate_s(0n, 12n, False{}) == 12n : Nat}

law maturity_explicit_cap_applies_only_when_asked:
  {K.maturity_gate_capped_s(264n, 24n) == 24n : Nat}

law maturity_explicit_cap_is_a_floor_when_under:
  {K.maturity_gate_capped_s(1n, 24n) == 1n : Nat}

# 12. Evolution: a hard safety floor survives any evolved threshold.
law hard_floor_survives_low_evolution:
  {K.with_hard_floor(10n, 120n) == 120n : Nat}

law hard_floor_survives_high_evolution:
  {K.with_hard_floor(500n, 120n) == 500n : Nat}

law hard_floor_at_exact_boundary:
  {K.with_hard_floor(120n, 120n) == 120n : Nat}
