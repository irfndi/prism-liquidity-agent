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
