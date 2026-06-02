# Contributing

## Prerequisites

- [Bun](https://bun.sh) >= 1.2
- [Docker](https://docker.com) (for Chroma)
- Node 22+ (runtime)

## Setup

```bash
git clone https://github.com/irfndi/prism-liquidity-agent
cd prism-liquidity-agent
bun install
bun run setup          # interactive .env wizard
docker-compose up chromadb -d
```

## Dev Commands

| Command | Description |
|---------|-------------|
| `bun run dev` | Run agent with hot reload |
| `bun run backtest` | Run historical simulation |
| `bun run test` | Run vitest suite |
| `bun run lint` | TypeScript type check |
| `bun run build` | Compile to dist/ |

## Project Constraints

- **No `any` types** — use `unknown` and narrow properly
- **No console.log** — use `createLogger(component)` everywhere
- **Paper trading first** — all new execution paths must work in paper mode before live
- **Tool call intercept pattern** — the `meteora_decision` tool is never executed by MCP; it is intercepted in `main.ts` and passed through the risk engine

## Adding a New MCP Tool

1. Add the `Tool` definition to `src/mcp/server.ts` `METEORA_TOOLS` array
2. Add the `case` handler in `createMCPServer().executeTool()`
3. Update `ARCHITECTURE.md` MCP Tools table
4. Add a test in `tests/`

## Adding a New Risk Check

Add a new numbered block in `src/risk/engine.ts` `evaluate()`.
Always return early on rejection — do not accumulate risk flags.

## Memory Categories

- `pattern` — recurring market behaviour observed across multiple cycles
- `warning` — red flag that should influence future decisions for this pool
- `outcome` — result of a past action (PnL recorded automatically)

## License

AGPL-3.0 — all derivative works must be open source.

