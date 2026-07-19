# W15 Manual QA

Date: 2026-07-19
Branch: `feat/depeg-liquidity-alerts`
Base: W13/W12 corrected base, commit `7b7d818`

## Synthetic detector run

The detector was exercised through its real TypeScript module boundary with an allowlisted `USDC` mint, a 3% stablecoin deviation, and two historical snapshots. The output was:

```json
{"depeg":{"tokenMint":"USDC","deviationUsd":0.030000000000000027},"liquidityDrain":{"tvlPct":-0.6,"volumePct":-0.6}}
```

This proves both W15 signals are emitted from snapshot history. The run left no process, port, database, or generated repository artifact running; raw output was also captured at `/tmp/w15-manual-qa.txt`.

## Safety checks

- Only configured mint allowlist entries can produce depeg signals; arbitrary symbols are ignored.
- Missing or insufficient snapshot history produces no liquidity-drain signal.
- Fast EXIT decisions are created only inside the tracked-position loop, preserving W10 position identity isolation.
- Alerts use the existing persisted cooldown key and fail-open `AlertService`; POST failures are swallowed and cannot block a cycle.

## Verification

- `bun run lint`: passed
- `bun run build`: passed
- `bun run test`: 81 files, 968 tests passed
- `bun run format:check`: passed
- `bun run test -- bench/depeg-liquidity-detector.test.ts bench/alert-service.test.ts`: 14 tests passed
