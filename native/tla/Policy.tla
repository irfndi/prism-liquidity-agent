---- MODULE Policy ----
\* Formal model of the EXIT / HOLD / ROTATE decision, independent of the
\* ledger. The ledger model proves the books are honest; this one proves the
\* POLICY does not throw away a good position or hold a bad one.
\*
\* The decision is a pure function of an observation, so the model enumerates
\* every observation and checks the invariant on the chosen action — an
\* exhaustive proof over the decision table, not a sampled test.
\*
\* The 2026-11 live failure this encodes: `HOLD_BIAS_ENABLED=false` exited an
\* in-range position that was still earning, on a fee/IL dip, paying a round
\* trip to leave a positive-carry trade. That is `RespectCarry = FALSE` below,
\* and `NoEconomicExitOnPositiveCarry` is the invariant it violates.
\*
\* Run:
\*   java -cp tla2tools.jar tlc2.TLC -config PolicyFixed.cfg Policy.tla
\*   java -cp tla2tools.jar tlc2.TLC -config PolicyBuggy.cfg Policy.tla

EXTENDS Naturals, Integers, TLC

CONSTANTS
  RespectCarry,   \* TRUE = never exit economically while carry >= 0
  RotationMult    \* challenger must beat incumbent by this multiple to rotate

VARIABLES
  carry,          \* net carry in cents/day: negative = the position bleeds
  inRange,
  matured,        \* the economic-exit maturity gate (break-even hold) passed
  safety,         \* a capital-protection trigger is set (trailing stop, IL, TVL)
  challengerNet,  \* best alternative's NET rate, cents/day
  incumbentNet,   \* this position's NET rate, cents/day
  decision        \* "hold" | "economic-exit" | "safety-exit" | "rotate"

vars == <<carry, inRange, matured, safety, challengerNet, incumbentNet, decision>>

\* Capital protection is never gated on economics.
SafetyExit == safety

\* An economic exit needs the position to have had time to pay for its round
\* trip. With RespectCarry it ALSO needs negative carry: a positive-carry
\* position is left alone to keep harvesting.
EconomicExitAllowed ==
  IF RespectCarry
  THEN matured /\ carry < 0
  ELSE matured

\* Rotation is only allowed OUT of a non-earning position, and only into
\* something materially better (a forecast never beats a real incumbent).
RotateAllowed ==
  ~SafetyExit /\ carry <= 0 /\ challengerNet > incumbentNet * RotationMult

Choose ==
  IF SafetyExit THEN "safety-exit"
  ELSE IF EconomicExitAllowed THEN "economic-exit"
  ELSE IF RotateAllowed THEN "rotate"
  ELSE "hold"

Init ==
  /\ carry \in -5..5
  /\ inRange \in BOOLEAN
  /\ matured \in BOOLEAN
  /\ safety \in BOOLEAN
  /\ challengerNet \in 0..10
  /\ incumbentNet \in 0..10
  /\ decision = Choose

\* Single-shot decision: every observation is explored from Init, and Next
\* only applies the policy. (A stutter keeps TLC from reporting a deadlock.)
Next ==
  /\ decision' = Choose
  /\ UNCHANGED <<carry, inRange, matured, safety, challengerNet, incumbentNet>>

Spec == Init /\ [][Next]_vars

TypeInvariant ==
  /\ carry \in Int
  /\ decision \in {"hold", "economic-exit", "safety-exit", "rotate"}

\* 1. Capital protection always wins.
SafetyPrecedence == safety => decision = "safety-exit"

\* 2. Never pay a round trip to leave a position that is still earning.
\*    (The 2026-11 hold-bias defect.)
NoEconomicExitOnPositiveCarry == decision = "economic-exit" => carry < 0

\* 3. An economic exit may not fire before the position has covered its
\*    round trip (dynamic maturity).
EconomicExitNeedsMaturity == decision = "economic-exit" => matured

\* 4. Rotation never abandons a positive-carry position for a forecast.
NeverRotateOutOfPositiveCarry == decision = "rotate" => carry <= 0

\* 5. Rotation needs a material edge, not a marginal one.
RotationOnlyIfMateriallyBetter ==
  decision = "rotate" => challengerNet > incumbentNet * RotationMult

====
