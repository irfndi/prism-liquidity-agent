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

# Observable: the runaway pins to the ceiling.
def main() -> Nat:
  K.clamp_thr(1392n, 30n, 300n)
