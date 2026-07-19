## 2026-07-19 W11

- The W11 notepad directory was absent in the latest `main` checkout; this entry establishes the requested append-only record.
- `engine/risk-service.ts` already exposes a pure `evaluateRisk` function. Reusing it from a replay kernel avoids a second implementation of confidence, allocation, stop-loss, and EXIT precedence.
- Replay remains intentionally side-effect free. Memory retrieval/persistence, proposal overlays, gas/recovery checks, alerts, wallet effects, and live execution are documented as unavailable rather than simulated with fake services.
