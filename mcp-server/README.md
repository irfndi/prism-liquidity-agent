# prism-mcp-server

Model Context Protocol (MCP) server that exposes Prism liquidity agent commands as tools for Claude Desktop and other MCP clients.

## What it does

Exposes 4 tools to any MCP-compatible client (Claude Desktop, Claude Code, Cursor, etc.):

| Tool | What it does |
|---|---|
| `prism_status` | Reads the SQLite DB to return position count, total deposited/current value (USD), and the last 3 audit entries |
| `prism_positions` | Lists all active positions (excludes paper-exited ones) with tokens, range, deposited/current value, and out-of-range cycle count |
| `prism_whoami` | Shows cloud account info (requires `prism register` first) |
| `prism_backtest` | Runs a backtest — `synthetic` (default, deterministic mock) or `replay` (reads from prism.db snapshots) |

## Install

### From npm (once published)

```bash
npm install -g prism-mcp-server
```

### From the repo (current state)

```bash
cd mcp-server
npm install
npm run build
```

This produces `mcp-server/dist/index.js` — the stdio MCP server entry point.

## Configure Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "prism": {
      "command": "node",
      "args": ["/absolute/path/to/prism-liquidity-agent/mcp-server/dist/index.js"],
      "env": {
        "PRISM_BIN": "/absolute/path/to/prism",
        "SQLITE_DB_PATH": "/absolute/path/to/prism.db"
      }
    }
  }
}
```

Notes:
- `PRISM_BIN` is the absolute path to the `prism` wrapper. If you used the one-liner installer, this is `~/.local/bin/prism`.
- `SQLITE_DB_PATH` is the absolute path to `prism.db`. If omitted, the server tries `./prism.db` relative to its CWD.
- If `prism` is on your `PATH` and `prism.db` is in the server's CWD, you can omit both `env` entries.

Restart Claude Desktop. The `prism` server will appear in the MCP tools list with the 4 tools above.

## Verify the server starts

```bash
# Should hang waiting for stdio input (Ctrl+C to exit)
node /absolute/path/to/mcp-server/dist/index.js
```

If it crashes immediately, check:
1. `PRISM_BIN` points to a working `prism` binary — test with `$PRISM_BIN --version`
2. `SQLITE_DB_PATH` points to a readable SQLite file (or omit to use `./prism.db`)
3. `better-sqlite3` native binding is built — run `npm rebuild better-sqlite3` in the mcp-server directory

## Tool details

### `prism_status`

No parameters. Returns:

```json
{
  "running": true,
  "dbPath": "./prism.db",
  "positionCount": 2,
  "totalDepositedUsd": 1500.00,
  "totalCurrentValueUsd": 1620.50,
  "lastAudit": [
    {
      "timestamp": "2026-06-03T15:00:00.000Z",
      "action": "ENTER",
      "pool": "Pool...",
      "reasoning": "Fee/IL ratio 1.8 above threshold",
      "paperTrading": true
    }
  ]
}
```

If the SQLite DB doesn't exist (agent hasn't run yet), returns `{ running: false, message: "..." }`.

### `prism_positions`

No parameters. Returns an array of active positions:

```json
[
  {
    "pool": "Pool...",
    "tokens": "SOL/USDC",
    "depositedUsd": 1000.00,
    "currentValueUsd": 1080.20,
    "range": { "lower": 4980, "upper": 5020, "active": 5005 },
    "outOfRangeCycleCount": 0,
    "lastRebalanceAt": null
  }
]
```

### `prism_whoami`

No parameters. Shells out to `prism whoami`. Returns the CLI's stdout on success, or a structured `{ registered: false, message: "..." }` if not registered.

### `prism_backtest`

Parameters:
- `source` (enum, default `synthetic`): `synthetic` for deterministic mock data, `replay` for on-chain snapshots from `prism.db`
- `days` (int 1-365, default 7): number of days to backtest
- `pools` (array of strings, optional, replay only): pool addresses to backtest

Returns the CLI's stdout. Errors include the exit code and stderr.

## How it finds the Prism binary

Resolution order:
1. `PRISM_BIN` env var (absolute path)
2. `~/.local/bin/prism` (default one-liner install location)
3. `~/.bun/bin/prism` (Bun global install location)
4. `prism` on `PATH`

If none of these resolve, the tool calls will fail with a clear error message.

## Security

The MCP server runs locally and only exposes read-only operations (SQLite is opened in readonly mode). The `prism_whoami` and `prism_backtest` tools spawn the Prism CLI as a subprocess with a 30-120 second timeout.

No data is sent to external services. The server is a stdio-only process that only responds to the local MCP client.

## Development

```bash
cd mcp-server
npm install                    # installs deps + builds better-sqlite3 native binding
npm run dev                    # tsc --watch
npm run build                  # tsc
npm test                       # node --import tsx --test test/*.test.ts
```

### Build requirement: better-sqlite3 native binding

`better-sqlite3` is a native module that needs to be compiled for the target Node.js version. The `npm install` step should automatically download a prebuilt binary, but on very new Node.js versions (e.g., v26) or systems without build tools, the build may fall back to compiling from source, which requires:
- macOS: Xcode Command Line Tools (`xcode-select --install`)
- Linux: Python 3, make, g++
- Windows: windows-build-tools

If `npm test` fails with `node-gyp` errors, run `npm rebuild better-sqlite3` to force a rebuild, or use a Node.js version with available prebuilds (v18-v22 are well-supported).

## Future work (not in this package)

- **Resource providers** for pool metadata, audit log history, etc.
- **Sampling support** for tool-driven LLM completions
- **HTTP transport** (currently stdio only) for remote MCP clients
- **Prompts** for common Prism workflows (install, diagnose, backtest)
- **OAuth** for multi-user setups

## License

MIT — same as the main Prism project.
