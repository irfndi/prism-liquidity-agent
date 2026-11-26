---- MODULE TaExhaustion ----
\* Formal model of the TA-exhaustion EXIT gate over repeated scan cycles (#237).
\*
\* Purpose: prove the TEMPORAL contract the pure kernels cannot state:
\*   - a losing (or unknown) projected P&L can never be closed by the TA path
\*     while the P&L gate is enabled, unless a measured fee/IL clears the floor;
\*   - the minimum-hold floor is never bypassed;
\*   - an honest gate does not block a legitimate exit (a nonnegative projection,
\*     or a loss whose measured fee/IL clears the floor, eventually closes under
\*     weak fairness).
\*
\* The 2026-11 regression (#237) was the OLD behavior: the TA path fired on the
\* price confluence alone, ignoring position P&L, so a losing position could be
\* closed almost immediately. HonestGate = FALSE models that build; the buggy
\* config must violate NoLossTaClose, which is the whole point of this model.
\*
\* Run:
\*   java -cp tla2tools.jar tlc2.TLC -config TaExhaustionFixed.cfg TaExhaustion.tla
\*   java -cp tla2tools.jar tlc2.TLC -config TaExhaustionWin.cfg TaExhaustion.tla
\*   java -cp tla2tools.jar tlc2.TLC -config TaExhaustionToxic.cfg TaExhaustion.tla
\*   java -cp tla2tools.jar tlc2.TLC -config TaExhaustionBuggy.cfg TaExhaustion.tla

EXTENDS Naturals

CONSTANTS
  MaxAge,           \* aging bound for this finite model (scan cycles)
  HoldFloor,        \* TA_EXHAUSTION_MIN_HOLD_MS, in cycles
  TaPresent,        \* the RSI/BB/MACD confluence is present this run
  Nonnegative,      \* the projected realized P&L (net of modeled costs) >= 0
  FeeIlRatioKnown,  \* a MEASURED (datapi) fee/IL ratio is available
  FeeIlRatio,       \* the measured ratio, hundredths
  MinFeeIlRatio,    \* TA_EXHAUSTION_MIN_FEE_IL_RATIO, hundredths
  HonestGate,       \* TRUE = the #237 P&L gate; FALSE = the old always-fire path
  HonestHold,       \* TRUE = the minimum-hold floor; FALSE = the old no-floor path
  OtherExits        \* loss-side stops can also close the position

VARIABLES
  age,              \* cycles the position has been open
  closed,           \* the position is closed
  closedByTa        \* the close was produced by the TA path

vars == <<age, closed, closedByTa>>

\* The opt-in gate's pass condition: nonnegative P&L OR a measured ratio at or
\* above the floor. An unknown ratio can never satisfy the alternative leg.
PnlOk == Nonnegative \/ (FeeIlRatioKnown /\ FeeIlRatio >= MinFeeIlRatio)

\* The confluence votes only when enabled + mature + the P&L gate passes. The
\* two Honest* switches select the fixed build or the old regression.
TaFires ==
  /\ TaPresent
  /\ (IF HonestHold THEN age >= HoldFloor ELSE TRUE)
  /\ (IF HonestGate THEN PnlOk ELSE TRUE)

Init ==
  /\ age = 0
  /\ closed = FALSE
  /\ closedByTa = FALSE

\* Aging is bounded so the state space stays finite; once the bound is reached
\* a legitimate TaExit stays enabled forever (WF_vars forces it below).
Tick ==
  /\ ~closed
  /\ age < MaxAge
  /\ age' = age + 1
  /\ closed' = closed
  /\ closedByTa' = closedByTa

TaExit ==
  /\ ~closed
  /\ TaFires
  /\ closed' = TRUE
  /\ closedByTa' = TRUE
  /\ age' = age

OtherExit ==
  /\ OtherExits
  /\ ~closed
  /\ closed' = TRUE
  /\ closedByTa' = FALSE
  /\ age' = age

Next == Tick \/ TaExit \/ OtherExit \/ UNCHANGED vars

\* Aging must progress (Tick), and a continuously-enabled TA exit must fire.
Spec == Init /\ [][Next]_vars /\ WF_vars(Tick) /\ WF_vars(TaExit)

TypeInvariant ==
  /\ age \in 0..MaxAge
  /\ closed \in BOOLEAN
  /\ closedByTa \in BOOLEAN

\* The #237 safety property: a TA close is only permitted when the projection
\* was nonnegative or a measured fee/IL cleared the floor. The buggy build
\* (HonestGate = FALSE) closes a losing position and violates this.
NoLossTaClose == closedByTa => PnlOk

\* The minimum-hold floor is part of the close transition, not a later check.
NoImmatureTaClose == closedByTa => age >= HoldFloor

\* Liveness: with no other exits, a position the honest gate admits eventually
\* closes through the TA path (the gate must not block a legitimate exit).
EventuallyTaClose == <>closedByTa

====
