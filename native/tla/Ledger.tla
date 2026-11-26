---- MODULE Ledger ----
\* Formal model of the position ledger + rolling-realized-PnL halt.
\*
\* Purpose: prove the accounting property the live system violated on
\* 2026-11-26, and show the halt gate is only sound when the ledger is.
\*
\* The bug: a close returns `Deposit - RealLoss + Rent` (the rent refund is
\* inside the measured wallet delta), but the ledger's cost basis was the
\* deposit alone. SubtractOverhead = FALSE models that build: every close
\* books `Rent - RealLoss`. With Rent > RealLoss the "realized" ledger grows
\* without bound while the wallet drains, so `halt` can never arm.
\* SubtractOverhead = TRUE models the fix.
\*
\* Run: java -cp tla2tools.jar tlc2.TLC -config LedgerFixed.cfg Ledger.tla
\*      java -cp tla2tools.jar tlc2.TLC -config LedgerBuggy.cfg Ledger.tla

EXTENDS Naturals, Integers

CONSTANTS
  Deposit,          \* cost basis recorded at entry, cents
  Rent,             \* cash spent beyond the deposit (rent+wrap+fee), cents
  RealLoss,         \* TRUE trading loss per close, cents (> 0)
  MaxCloses,        \* positions in the run
  HaltLoss,         \* halt arms once the ledger is below -HaltLoss cents
  SubtractOverhead  \* TRUE = fixed build, FALSE = the 2026-11 regression

VARIABLES
  closes,           \* completed closes
  realized,         \* the ledger's realized PnL, cents
  halt              \* rolling halt armed

CashBack == Deposit - RealLoss + Rent

\* Per-close contribution to the ledger.
PerClose ==
  IF SubtractOverhead
  THEN (CashBack - Rent) - Deposit     \* = -RealLoss
  ELSE CashBack - Deposit              \* = Rent - RealLoss

vars == <<closes, realized, halt>>

Init ==
  /\ closes = 0
  /\ realized = 0
  /\ halt = FALSE

\* One close: the cash is what it is; only the ledger's basis differs.
Close ==
  /\ closes < MaxCloses
  /\ LET next == realized + PerClose
     IN /\ realized' = next
        /\ closes' = closes + 1
        /\ halt' = (halt \/ (next < -HaltLoss))

Next == Close \/ UNCHANGED vars

\* Weak fairness: every eligible close eventually happens.
Spec == Init /\ [][Next]_vars /\ WF_vars(Close)

TypeInvariant ==
  /\ closes \in 0..MaxCloses
  /\ realized \in Int
  /\ halt \in BOOLEAN

\* The property the halt gate depends on.
HaltImpliesLoss == halt => realized < -HaltLoss

\* The wallet loses RealLoss on every close, so an honest ledger must report
\* exactly that. Violated by the buggy build (it books Rent - RealLoss), which
\* is the whole point of this model.
TruePnl == closes * (-RealLoss)
LedgerMatchesTruePnl == realized = TruePnl

\* The invariant the fixed build must keep: never report profit while every
\* close loses money.
NoPhantomProfit == realized <= 0

\* Liveness: with honest books the halt eventually arms.
EventuallyHalt == <>(halt = TRUE)

====
