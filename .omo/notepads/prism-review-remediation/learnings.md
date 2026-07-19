## 2026-07-19 W11

- The W11 notepad directory was absent in the latest `main` checkout; this entry establishes the requested append-only record.
- `engine/risk-service.ts` already exposes a pure `evaluateRisk` function. Reusing it from a replay kernel avoids a second implementation of confidence, allocation, stop-loss, and EXIT precedence.
- Replay remains intentionally side-effect free. Memory retrieval/persistence, proposal overlays, gas/recovery checks, alerts, wallet effects, and live execution are documented as unavailable rather than simulated with fake services.

## 2026-07-19 W11 verification correction

- W10 PR #104 remains open on `feat/multi-position`; W11 was rebased onto that branch and PR #105 is now a stacked dependency instead of silently targeting W9 `main`.
- W10 `RiskConfig.maxPositionsPerPool` is required by the production risk service. Replay now passes that field and represents open positions with `positionPubKey` identity plus aggregate position input.
- The parity regression uses the same recorded snapshot-shaped position/range/value state for replay and production `evaluateRisk`, covering a trailing-stop EXIT; a second case proves the W10 per-pool cap rejects ENTER.
- Probe results: `git status` is clean after the stacked push; `main..HEAD` visibly includes the three W10 commits; CLI output labels stale-TVL/price limitations and live-only gaps instead of claiming full fidelity. No long-running process or generated state remained to probe for interruption cleanup.
