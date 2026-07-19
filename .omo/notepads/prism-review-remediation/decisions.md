## 2026-07-19 W11

- Keep the first extraction narrow: `engine/cycle/evaluate-pool.ts` is a pure replay decision seam, while `ops/backtest.ts` remains the Effect-free simulator driver.
- Replay starts flat and applies shared ENTER/EXIT outcomes. ENTER sizes are taken from `evaluateRisk`'s adjusted allocation result; trailing exits retain EXIT's capital-protection override.

## 2026-07-19 W11 verification correction

- Stack W11 on `feat/multi-position` while PR #104 is open; set PR #105 base to `feat/multi-position` so reviewers see only W11 changes and the dependency remains explicit.
- Keep live-only limitations unchanged. Do not simulate memory, proposals, gas/recovery, alerts, or on-chain effects merely to manufacture parity.
