# W12 Manual QA Artifact

Date: 2026-07-19
Branch: `chore/housekeeping`
Base: W11 commit `c80491b`

## Checks

- `bun run test`: 79 files, 959 tests passed.
- `bun run lint`: passed (`tsc --noEmit` and `oxlint`).
- `bun run build`: passed; engine bundle generated successfully.
- `bun run format:check`: passed after removing generated test fixtures.
- `bun run coverage` repeated twice: 79 files, 959 tests passed both times and the gate passed. The policy retains 75% statements, 60% branches, 75% functions, and 75% lines. Measured coverage was 80.34% statements, 74.98% branches, 76.22% functions, and 80.80% lines.

## Exercised behavior

- Invalid `WATCHLIST_POOLS` fails with the variable name and offending value.
- Numeric values below configured minima clamp and emit structured warnings.
- Two same-cycle audit decisions in the same millisecond both persist.
- Revenue fee calculation returns unchanged fees for zero token prices.
- MCP and HTTP status version consumers resolve through `getCurrentVersion()`.

## Cleanup

- Removed generated `bench/tmp-audit` and `bench/tmp-wave2-screening` fixtures after verification.
- No long-running process or listening QA port was started.

## Coverage policy

The gate excludes only runtime boundaries that require external child processes,
WebSockets, live HTTP endpoints, or application startup side effects:
`acp-transport`, `agent-detection`, `agent-transport`, `gateway-transport`,
`hermes-api-transport`, `openclaw-webhook-transport`, `run-engine`, and
`load-env`. Core configuration, strategy, risk, database, audit, execution,
and service logic remain included. The thresholds were not lowered.
