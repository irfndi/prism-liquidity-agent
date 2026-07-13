# Prism CLI Reference

## Global Commands

### `prism register`

Register with Prism's Cloudflare Worker and get an API key.

```bash
prism register
# Output: API key saved to ~/.config/prism/credentials.json
```

### `prism login <key>`

Validate an existing API key.

```bash
prism login sk-prism-xxxxxxxx
# Output: Login successful — user_id: abc123
```

### `prism setup`

Interactive wizard to configure the trading agent. Run `prism register` first;
setup validates the stored account and writes a timestamped `.env` backup.

```bash
# Interactive mode
prism setup

# Non-interactive (for agents/CI)
prism setup --non-interactive --helius-key=your-key --rpc-fallback-url=https://second-rpc.example.com
```

### `prism doctor`

Validate runtime, registration, local paths, RPC providers, wallet mode, and error
telemetry. `--fix` creates missing directories and repairs permissions without
changing provider keys or wallet data.

```bash
prism doctor
prism doctor --fix
prism doctor --json
```

**Options:**
- `--helius-key <key>` — Helius API key (optional when `--rpc-url` is provided)
- `--rpc-url <url>` — primary Solana RPC URL
- `--rpc-fallback-url <url>` — optional fallback Solana RPC URL
- `--jupiter-api-key <key>` — optional Jupiter Price API v3 key
- `--wallet-key-file <path>` — Solana wallet keypair file (optional)
- `--watchlist <pools>` — Comma-separated pool addresses (optional)
- `--paper-trading` — Enable paper trading (default: true)

### `prism whoami`

Show current user info.

```bash
prism whoami
# Output:
# User ID: abc123
# Tier: free
# Wallet: 7xKx...3f2a (pubkey)
# Telegram: linked (@username)
# API Key: sk-prism-xxxxxxxx (last 4)
```

## Wallet Commands

### `prism wallet generate`

Generate a new Solana keypair.

```bash
prism wallet generate
# Output: New wallet created — pubkey: 7xKx...3f2a
# Saved to: ~/.config/prism/wallet.json (0600 permissions)
```

### `prism wallet import <keypair>`

Import an existing Solana keypair.

```bash
prism wallet import "[12,34,56,...]"
# or
prism wallet import --file ~/.config/solana/id.json
```

### `prism wallet show`

Display wallet pubkey (never shows private key).

```bash
prism wallet show
# Output: 7xKx...3f2a
```

### `prism wallet register`

Register wallet pubkey with Prism Worker.

```bash
prism wallet register
# Output: Wallet 7xKx...3f2a registered
```

## Telegram Commands

### `prism link-telegram`

Generate a one-time code to link your Telegram account.

```bash
prism link-telegram
# Output: Link code: LINK-AB12CD (expires in 10 minutes)
# Send this code to @prism_agent_bot
```

## Development Commands

These are used when developing Prism itself:

```bash
bun run dev        # Start agent with hot reload
bun run test       # Run Vitest suite
bun run lint       # Run oxlint + tsc --noEmit
bun run format     # Run oxfmt
bun run build      # Build with tsdown
bun run backtest   # Historical simulation
```

## Environment Variables

Key env vars (set via `prism setup` or `.env`):

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HELIUS_API_KEY` | NO | empty | Helius DAS/RPC API key |
| `SOLANA_RPC_URL` | YES | Helius or public fallback | Primary Solana RPC URL |
| `SOLANA_RPC_FALLBACK_URL` | NO | empty | Separate RPC endpoint used after primary rate-limit/network failures |
| `JUPITER_API_KEY` | NO | empty | Jupiter Price API v3 key |
| `COINGECKO_API_KEY` | NO | empty | CoinGecko Pro API key |
| `WALLET_PRIVATE_KEY` | NO | empty | Solana wallet (live trading only) |
| `WATCHLIST_POOLS` | NO | empty | Comma-separated pool addresses |
| `PAPER_TRADING` | NO | `true` | Paper vs live trading |
| `SQLITE_DB_PATH` | NO | `./prism.db` | SQLite database file |

`prism setup`, `prism dev`, `prism feedback`, and `prism issue` require a valid
registered account. Feedback and issues are stored in the Prism Cloud D1 store;
local storage is only an outage fallback.

See [`config-service.ts`](../engine/config-service.ts) for the full list.
