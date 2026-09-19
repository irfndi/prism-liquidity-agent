# Bend decision kernels

Pure port of the strategy/risk/gate math in `engine/strategy-service.ts`
(`clampThreshold`, `nudgeThreshold`, `evolveThresholds`, `computeFeeIlRatio`)
and `engine/program.ts` (`feeIlHardFloorReason`, `driftHardFloorReason`,
`passesMeasuredCandidateGates`, fee/IL EXIT, paper accrual guard).

## Encoding

Fixed-point `Nat` in hundredths (`1.00 = 100n`; division floors). Bands:
feeIl `[30n, 300n]`, auth `[10n, 90n]`, util `[5n, 80n]`, ratio cap `2000n`
(= 20.0), EXIT trip `50n` (= 0.5). Drift is a `(negative?, magnitude)` pair,
so strict-below-floor keeps its meaning without signed ints.

Floats were avoided deliberately: in Bend 2.0.5 `F32` comparisons are
uninterpreted axioms, so closed `F32` terms (e.g. `clamp(13.92)`) do not reduce
and no `{==}` proof over them checks (verified by probe). Every `Nat` kernel
here computes, so every law below is proved by reflexivity/case analysis.

## Files

- `kernels.bend` — kernels + `main` demo (prints `300n`: 13.92 pins to 3.0) + fee_known/ta_exhausted gates (latter LAWS-pending) + exit_order precedence gate (1n/2n/3n/0n, truth-table-probed, NOT wired into `checkDeterministicExits`).
- `LAWS.bend` — 16 laws, human-owned: band closure (incl. runaway 1392→300),
  single-nudge ≤20 % (120→144), ceiling/floor pins, modeled fee/IL never
  blocks ENTER / never forces EXIT, capital EXIT confidence-free, paper
  accrual datapi-only, strict drift floor; fee-known passthrough; ta_exhausted LAWS-pending; exit_order kernel-only (unproven).
- `PROOF.bend` — machine-checked proofs, one `def L.<name>` per law.

## Checks (bend 2.0.5; CLI is `bend <file>`, there is no `bend check`)

- `bend kernels.bend` → `300n` (green; observable runaway clamp).
- `bend LAWS.bend` → `Error: 16 TODOs found. The code is incomplete, and not
  a valid proof yet.` (by design — open laws; PROOF.bend discharges them).
- `bend PROOF.bend` → `300n`, no errors (green — all 16 laws proved).

## Scope notes

- `clamp_thr` has no NaN arm (no `Nat` analogue); callers pass measured values.
- `∀F32` band theorems are represented by regression points (1392/2000/5/120),
  not a universal float quantifier — see encoding note above.
- Signed drift, lift signs, and on-chain/calendar state stay in the host;
  kernels take their already-resolved `Bool`/`Nat` projections.

## Consumers

- `bench/bend-parity.test.ts` (+ `bend-parity-harness.ts`): TS-vs-Bend golden
  vectors for every kernel above, skipped (not failed) when `bend` is absent.
- `native/rust/src/main.rs` (`mod bend`): real subprocess wiring for
  all 8 proven tick kernels plus `bend::evolve_thr` (evolve shadow) and the
  unproven `bend::ta_exhausted` + `bend::exit_order` gates (wrappers present,
  unwired-from-tick), embedding this file at compile time
  via `include_str!`. Fail-open on any error; see `native/rust/README.md`
  for the wiring contract (both LAWS pending strategy review).
