# Contributing

## Prerequisites

- [Bun](https://bun.sh) >= 1.2
- Node 22+ (runtime)

## Setup

```bash
git clone https://github.com/irfndi/prism-liquidity-agent
cd prism-liquidity-agent
bun install
bun run setup          # interactive .env wizard
```

## Dev Commands

| Command | Description |
|---------|-------------|
| `bun run dev` | Run agent with hot reload |
| `bun run backtest` | Run historical simulation |
| `bun run test` | Run vitest suite |
| `bun run lint` | tsc --noEmit + oxlint (engine ops bench cli) |
| `bun run format` | oxfmt --write (engine ops bench cli) |
| `bun run build` | tsdown -> dist/index.mjs |

## Project Constraints

- **No `any` types** — use `unknown` and narrow properly
- **console.log vs createLogger** — prefer `createLogger(component)` from `engine/logger.ts`, but `console.info/warn/error` is used extensively in `program.ts` and `index.ts`. Match the file you're editing.
- **Paper trading first** — all new execution paths must work in paper mode before live

## Adding a New Service

Engine services follow the Effect-TS `Context.Tag` pattern:

1. Define the service API in `engine/services.ts` with a `Context.Tag` class
2. Implement `YourServiceLive` in a new `engine/your-service.ts` returning a `Layer`
3. Add it to the `Layer.provide(...)` chain in `engine/program.ts` `buildLayer()` and to the `AllServices` union
4. `yield* YourService` inside the `Effect.gen` block in `program.ts` to consume it

## Adding a New Risk Check

Add a new numbered block in `engine/risk-service.ts` `evaluateRisk()`.
Always return early on rejection — do not accumulate risk flags.

## Memory Categories

- `pattern` — recurring market behaviour observed across multiple cycles
- `warning` — red flag that should influence future decisions for this pool
- `outcome` — result of a past action (PnL recorded automatically)

## Tests

Engine tests live in `bench/*.test.ts`. Build layers with `Layer.merge(AuditLive, DbLive(":memory:"))` for isolated service tests.

## License

MIT
