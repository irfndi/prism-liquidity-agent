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

Interactive wizard to configure the trading agent.

```bash
# Interactive mode
prism setup

# Non-interactive (for agents/CI)
prism setup --non-interactive --helius-key=your-key --wallet-key=optional
```

**Options:**
- `--helius-key <key>` — Helius API key (required)
- `--wallet-key <key>` — Solana wallet private key (optional)
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
# Send this code to @prism_dlmm_bot
```

### `prism unlink-telegram`

Remove Telegram binding.

```bash
prism unlink-telegram
# Output: Telegram unlinked
```

## Trading Commands

### `prism dev`

Start the trading agent (paper trading by default).

```bash
# Paper trading (default)
prism dev

# Live trading
PAPER_TRADING=false prism dev

# Custom scan interval
SCAN_INTERVAL_MS=300000 prism dev  # 5 minutes
```

### `prism backtest`

Run historical simulation.

```bash
prism backtest
# or
bun run backtest
```

## Subscription Commands

### `prism subscription status`

Show current tier and expiry.

```bash
prism subscription status
# Output:
# Tier: free
# Max profit: 1 SOL/month
# Usage: 0.3 SOL (30%)
# Expires: never
```

### `prism subscription renew`

Renew or upgrade subscription.

```bash
prism subscription renew --tier pro
# Output: Solana Pay QR code:
# https://solana-pay.com/qr?recipient=...
```

## Utility Commands

### `prism issue <text>`

File an issue to the Prism GitHub repo.

```bash
prism issue "Getting timeout on pool fetch"
# Output: Issue #42 created — https://github.com/irfndi/prism-liquidity-agent/issues/42
```

### `prism support`

Get support contact info.

```bash
prism support
# Output:
# Docs: https://github.com/irfndi/prism-liquidity-agent/tree/main/docs
# Issues: https://github.com/irfndi/prism-liquidity-agent/issues
# Telegram: @prism_dlmm_bot
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
| `HELIUS_API_KEY` | **YES** | — | Helius RPC API key |
| `WALLET_PRIVATE_KEY` | NO | empty | Solana wallet (live trading only) |
| `WATCHLIST_POOLS` | NO | empty | Comma-separated pool addresses |
| `PAPER_TRADING` | NO | `true` | Paper vs live trading |
| `SQLITE_DB_PATH` | NO | `./prism.db` | SQLite database file |

See [`config-service.ts`](../engine/config-service.ts) for the full list.
