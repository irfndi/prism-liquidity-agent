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

# 9. Selection: an admission floor is inclusive at the boundary and strict
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

# 10. Capacity: the active scan set is bounded by TOP_K and MAX_POOLS no
# matter how many pools rank. A rising universe must not silently widen the
# cycle into an RPC bill.
law capacity_bounded_by_top_k:
  {K.active_count(500n, 40n, 80n) == 40n : Nat}

law capacity_bounded_by_max_pools:
  {K.active_count(500n, 100n, 80n) == 80n : Nat}

law capacity_never_exceeds_universe:
  {K.active_count(7n, 40n, 80n) == 7n : Nat}

# 11. Evolution: a hard safety floor survives any evolved threshold.
law hard_floor_survives_low_evolution:
  {K.with_hard_floor(10n, 120n) == 120n : Nat}

law hard_floor_survives_high_evolution:
  {K.with_hard_floor(500n, 120n) == 500n : Nat}

law hard_floor_at_exact_boundary:
  {K.with_hard_floor(120n, 120n) == 120n : Nat}
