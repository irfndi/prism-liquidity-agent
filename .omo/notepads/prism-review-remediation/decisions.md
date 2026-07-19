## 2026-07-19 W11

- Keep the first extraction narrow: `engine/cycle/evaluate-pool.ts` is a pure replay decision seam, while `ops/backtest.ts` remains the Effect-free simulator driver.
- Replay starts flat and applies shared ENTER/EXIT outcomes. ENTER sizes are taken from `evaluateRisk`'s adjusted allocation result; trailing exits retain EXIT's capital-protection override.
