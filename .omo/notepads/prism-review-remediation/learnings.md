## 2026-07-19 W11

- The W11 notepad directory was absent in the latest `main` checkout; this entry establishes the requested append-only record.
- `engine/risk-service.ts` already exposes a pure `evaluateRisk` function. Reusing it from a replay kernel avoids a second implementation of confidence, allocation, stop-loss, and EXIT precedence.
- Replay remains intentionally side-effect free. Memory retrieval/persistence, proposal overlays, gas/recovery checks, alerts, wallet effects, and live execution are documented as unavailable rather than simulated with fake services.

## 2026-07-19 W11 verification correction

- W10 PR #104 remains open on `feat/multi-position`; W11 was rebased onto that branch and PR #105 is now a stacked dependency instead of silently targeting W9 `main`.
- W10 `RiskConfig.maxPositionsPerPool` is required by the production risk service. Replay now passes that field and represents open positions with `positionPubKey` identity plus aggregate position input.
- The parity regression uses the same recorded snapshot-shaped position/range/value state for replay and production `evaluateRisk`, covering a trailing-stop EXIT; a second case proves the W10 per-pool cap rejects ENTER.
- Probe results: `git status` is clean after the stacked push; `main..HEAD` visibly includes the three W10 commits; CLI output labels stale-TVL/price limitations and live-only gaps instead of claiming full fidelity. No long-running process or generated state remained to probe for interruption cleanup.

## 2026-07-19 W12 housekeeping

- Added fail-safe `WATCHLIST_POOLS` public-key validation with actionable config failure coverage.
- Numeric configuration now clamps values below minimums and emits structured warnings; non-finite values retain their documented fallback.
- MCP and HTTP status versions now use `getCurrentVersion()` rather than stale `0.0.20` literals.
- Audit IDs already include a UUID suffix in this W11 base, so no duplicate-ID change was required.
- A first `Layer.scoped` DbLive finalizer attempt was reverted after the full suite proved existing layer consumers outlive the scope. Scope-aware DB lifecycle wiring remains required.

## 2026-07-19 W12 resume

- The reward-accounting coverage failure was caused by two independent `Date.now()` reads in one equality assertion. Injecting one `now` value made the test deterministic; targeted tests pass.
- Two repeated coverage runs now both execute 79 files / 959 tests successfully, but the configured global gate remains red at statements 67.76%, functions 62.96%, lines 67.96% versus 75%. This is a pre-existing policy/configuration blocker, not a flaky test; thresholds were not weakened.
- Revenue/Referral consumer scan found no production use of `RevenueService` or `ReferralService` in `program.ts`; only `RevenueConfigService` is consumed by the engine. Runtime wiring was removed while standalone APIs and tests remain.
- DbLive finalizer remains intentionally unwired: current test and service-layer consumers provide `DbLive` as a reusable layer across multiple effects, and `Layer.scoped` closed the database between those effects. A safe finalizer requires a coordinated scope-lifetime migration.
