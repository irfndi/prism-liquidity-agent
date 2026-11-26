---- MODULE Resilience ----
\* Formal model of the RPC resilience POLICY in `engine/adapter-retry.ts` and
\* its wiring in `engine/adapter-service.ts` (`rpcCall`): bounded retry plus a
\* circuit breaker.
\*
\* The runtime classifies an error twice, and the two sets are NOT the same:
\*
\*   - `isRpcNetworkError` decides a STRIKE. It covers HTTP 400-599, 429,
\*     -32005, ECONN*/ETIMEDOUT, fetch failures and provider rejection messages.
\*     A provider answering 400 "chain is not available on free plan" is an
\*     endpoint failure by design: the caller rotates to the next endpoint.
\*   - `isRetriableError` decides a RETRY. It is narrower: 429, -32005, rate
\*     limit phrasing, and RPC timeouts. A 500 strikes the breaker but is not
\*     retried on the same endpoint.
\*
\* Anything else (an argument validation error, a programming defect) is the
\* caller's fault, not the endpoint's: it must not strike and must not retry.
\* `CircuitBreaker.execute(effect)` called WITHOUT its `isRetriable` predicate
\* would strike on exactly those, opening the breaker on a caller's typo and
\* then rejecting the capital-protecting EXIT.
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
  StrikeLocalErrors,  \* the defect: let a caller-side error strike the breaker
  Threshold,          \* consecutive strikes that open the breaker
  MaxRetries          \* retries allowed for one request

VARIABLES
  breaker,   \* "closed" | "open" | "half"
  trial,     \* a HALF_OPEN probe is already in flight
  attempt,   \* retries already spent on this request
  kind,      \* "none" | "rate-limit" | "endpoint" | "local"
  strikes,   \* strikes recorded BEFORE this observation
  decision,  \* "call" | "retry" | "fail" | "reject-open" | "reject-trial"
  opens      \* this observation opens the breaker

vars == <<breaker, trial, attempt, kind, strikes, decision, opens>>

\* Retry is for the rate-limited / timed-out class only (`isRetriableError`).
Retriable == kind = "rate-limit"

\* A strike is for endpoint health (`isRpcNetworkError`): rate limits, HTTP
\* 4xx/5xx and transport failures. `local` is deliberately absent; the buggy
\* configuration adds it.
Strikable ==
  kind \in {"rate-limit", "endpoint"} \/ (StrikeLocalErrors /\ kind = "local")

StrikesAfter == IF Strikable THEN strikes + 1 ELSE strikes

OpenRejects == breaker = "open"

TrialRejects == breaker = "half" /\ trial

Decide ==
  IF OpenRejects THEN "reject-open"
  ELSE IF TrialRejects THEN "reject-trial"
  ELSE IF kind = "none" THEN "call"
  ELSE IF Retriable /\ attempt < MaxRetries THEN "retry"
  ELSE "fail"

\* A rejected observation never reaches the effect, so it can never record a
\* failure. `CircuitBreaker.execute` returns before `onFailure` in both reject
\* branches; opening the breaker from a call it refused to make would let the
\* breaker feed itself.
Admitted == Decide \notin {"reject-open", "reject-trial"}

\* Only a TERMINAL failure strikes. `rpcCall` runs `retryEffectWithBackoff`
\* INSIDE `breaker.execute`, so the breaker observes the retry loop's outcome,
\* not each attempt: an intermediate 429 that the next attempt survives calls
\* `onSuccess` and resets the count. Opening on `retry` would model a breaker
\* the runtime cannot produce.
TerminalFailure == Decide = "fail"

OpensNow == Admitted /\ TerminalFailure /\ Strikable /\ StrikesAfter >= Threshold

Init ==
  /\ breaker \in {"closed", "open", "half"}
  /\ trial \in BOOLEAN
  /\ attempt \in 0..MaxRetries
  /\ kind \in {"none", "rate-limit", "endpoint", "local"}
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

\* 3. A call the breaker refused cannot open it.
RejectedNeverOpens ==
  (decision = "reject-open" \/ decision = "reject-trial") => ~opens

\* 4. An intermediate retry cannot open it either: the breaker wraps the whole
\*    retry loop, so a survived retry resets the count on success.
RetryNeverOpens == decision = "retry" => ~opens

\* 5. Only the rate-limited class is retried. A 500 strikes but is not retried,
\*    and a caller-side error is retried never.
RetryOnlyRetriable == decision = "retry" => kind = "rate-limit"

\* 6. Retries are bounded: the loop cannot run past its budget.
RetryBounded == decision = "retry" => attempt < MaxRetries

\* 7. A caller-side error never strikes the breaker. (The buggy configuration
\*    violates this and only this, so the negative control is stable.)
LocalErrorDoesNotStrike == kind = "local" => ~opens

====
