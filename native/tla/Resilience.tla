---- MODULE Resilience ----
\* Formal model of the RPC resilience POLICY in `engine/adapter-retry.ts`:
\* bounded retry plus a circuit breaker.
\*
\* Two rules keep a flaky provider from costing money:
\*   1. The breaker exists to stop spending requests on a dead ENDPOINT, so only
\*      errors that say something about endpoint health may strike it.
\*   2. The retry loop exists to absorb a transient 429 or timeout, so only
\*      those may be retried; a provider rejecting the REQUEST (400 "chain is
\*      not available on free plan", a bad parameter, a validation failure) says
\*      nothing about health and must fail immediately.
\*
\* Mixing the two is the defect this model pins down: a breaker that strikes on
\* business errors opens on a caller's typo and then rejects every legitimate
\* call, including the EXIT that protects capital.
\*
\* The observation is enumerated exhaustively, like Policy.tla: every
\* (breaker, trial, attempt, kind, strikes) input is explored from Init and the
\* invariants constrain the policy's chosen action. TLC therefore checks the
\* whole decision table, not samples of it.
\*
\* Run:
\*   java -cp tla2tools.jar tlc2.TLC -config ResilienceFixed.cfg Resilience.tla
\*   java -cp tla2tools.jar tlc2.TLC -config ResilienceBuggy.cfg Resilience.tla

EXTENDS Naturals, TLC

CONSTANTS
  StrikeBusinessErrors,  \* the defect: let a business error strike the breaker
  Threshold,             \* consecutive strikes that open the breaker
  MaxRetries             \* retries allowed for one request

VARIABLES
  breaker,   \* "closed" | "open" | "half"
  trial,     \* a HALF_OPEN probe is already in flight
  attempt,   \* retries already spent on this request
  kind,      \* error carried by this observation: "none" | "transient" | "business"
  strikes,   \* strikes recorded BEFORE this observation
  decision,  \* "call" | "retry" | "fail" | "reject-open" | "reject-trial"
  opens      \* this observation opens the breaker

vars == <<breaker, trial, attempt, kind, strikes, decision, opens>>

\* Retry is for transient transport failures only.
Retriable == kind = "transient"

\* A strike is for endpoint health only. The defect widens this to business
\* errors, which is `CircuitBreaker.execute(effect)` called without its
\* `isRetriable` predicate.
Strikable ==
  kind = "transient" \/ (StrikeBusinessErrors /\ kind = "business")

StrikesAfter == IF Strikable THEN strikes + 1 ELSE strikes

OpenRejects == breaker = "open"

TrialRejects == breaker = "half" /\ trial

Decide ==
  IF OpenRejects THEN "reject-open"
  ELSE IF TrialRejects THEN "reject-trial"
  ELSE IF kind = "none" THEN "call"
  ELSE IF Retriable /\ attempt < MaxRetries THEN "retry"
  ELSE "fail"

OpensNow == Strikable /\ StrikesAfter >= Threshold

Init ==
  /\ breaker \in {"closed", "open", "half"}
  /\ trial \in BOOLEAN
  /\ attempt \in 0..MaxRetries
  /\ kind \in {"none", "transient", "business"}
  /\ strikes \in 0..Threshold
  /\ decision = Decide
  /\ opens = OpensNow

\* Single-shot decision: every observation is explored from Init, and Next only
\* applies the policy. (A stutter keeps TLC from reporting a deadlock.)
Next ==
  /\ decision' = Decide
  /\ opens' = OpensNow
  /\ UNCHANGED <<breaker, trial, attempt, kind, strikes>>

Spec == Init /\ [][Next]_vars

TypeInvariant ==
  /\ breaker \in {"closed", "open", "half"}
  /\ decision \in {"call", "retry", "fail", "reject-open", "reject-trial"}
  /\ attempt \in 0..MaxRetries

\* 1. An open breaker never calls the endpoint.
OpenRejectsWithoutCall == OpenRejects => decision = "reject-open"

\* 2. A half-open probe admits exactly one caller.
HalfOpenSingleProbe == TrialRejects => decision = "reject-trial"

\* 3. Only transient transport errors are retried.
RetryOnlyTransient == decision = "retry" => kind = "transient"

\* 4. Retries are bounded: the loop cannot run past its budget.
RetryBounded == decision = "retry" => attempt < MaxRetries

\* 5. A business error never strikes the breaker. (The buggy config violates
\*    this and only this, so the negative control's counterexample is stable.)
BusinessErrorDoesNotOpen == kind = "business" => ~opens

====
