# W12 Manual QA Artifact

Date: 2026-07-19
Branch: `chore/housekeeping`
Base: W11 commit `c80491b`

## Checks

- `bun run test`: 79 files, 959 tests passed.
- `bun run lint`: passed (`tsc --noEmit` and `oxlint`).
- `bun run build`: passed; engine bundle generated successfully.
- `bun run format:check`: passed after removing generated test fixtures.
- `bun run coverage` repeated twice: 79 files, 959 tests passed both times; policy gate remains red at 67.76% statements, 62.96% functions, and 67.96% lines against 75% thresholds.

## Exercised behavior

- Invalid `WATCHLIST_POOLS` fails with the variable name and offending value.
- Numeric values below configured minima clamp and emit structured warnings.
- Two same-cycle audit decisions in the same millisecond both persist.
- Revenue fee calculation returns unchanged fees for zero token prices.
- MCP and HTTP status version consumers resolve through `getCurrentVersion()`.

## Cleanup

- Removed generated `bench/tmp-audit` and `bench/tmp-wave2-screening` fixtures after verification.
- No long-running process or listening QA port was started.
