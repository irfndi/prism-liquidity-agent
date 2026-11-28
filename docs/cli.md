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

## Operations Commands

### `prism backup`

Archive the live SQLite databases with a verifiable manifest. Uses `VACUUM INTO`,
so it is safe against a running engine and never loads the database into memory.

```bash
prism backup                                   # active DB + every ~/.config/prism-* profile
prism backup --db /path/to/prism.db            # one explicit database
prism backup --profile ~/.config/prism-paper-bin20
prism backup --out /root/prism-archive-20261128
```

The archive holds `manifest.json` (source paths, byte sizes, SHA-256, schema
versions, per-table row counts, `PRAGMA quick_check`) and `SHA256SUMS`.

### `prism restore <archive>`

Verify and restore an archive.

```bash
prism restore ./prism-archive-20261128 --verify-only   # pre-cutover drill, writes nothing
prism restore ./prism-archive-20261128 --force         # restore to the recorded paths
prism restore ./prism-archive-20261128 --target-dir /new/root
```

Restore refuses a file whose hash, size, integrity or row counts do not match the
manifest. Existing databases are moved aside, not deleted. See
[`migration-2gb-host.md`](migration-2gb-host.md).

### `prism forensics`

Read-only per-rule and per-pool PnL attribution from the local ledger. Only
executed ENTERs are attributed, and the audit window is widened by the ENTER
lookback so a position closed just inside the window keeps the entry that
created it.

```bash
prism forensics                     # trailing 30 days
prism forensics --all --top 30
prism forensics --json
```

### `prism audit-pnl`

Re-derive every closed position's realized PnL from its stored legs and flag
drift or rent-unaccounted rows. Exits 1 on drift.

```bash
prism audit-pnl
prism audit-pnl --apply-rent-backfill   # void phantom rows to NULL, never to 0
```

### `prism copy-feed`

Serve the copy-trading signal feed consumed by `COPY_SIGNALS_ENDPOINT`.

```bash
export COPY_SIGNALS_TOKEN=<long random>
prism copy-feed --port 8787 --host 127.0.0.1
curl -H "Authorization: Bearer $COPY_SIGNALS_TOKEN" http://127.0.0.1:8787/health
```

`/health` reports feed health, not process liveness: `ok: false` with
`reason: "feed is empty …"` means the process is fine and nobody is publishing.

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
| `SOLANA_RPC_FALLBACK_URL` | NO | keyless Solana Labs + PublicNode + Pocket Network | Comma-separated independent RPC providers; health-aware routing, per-provider pacing, immediate failover |
| `RPC_MIN_INTERVAL_MS` | NO | `250` | Minimum interval per RPC provider; independent providers multiply aggregate capacity |
| `DEXSCREENER_ENABLED` | NO | `true` | Keyless DexScreener pool stats and batch token prices |
| `GECKO_TERMINAL_ENABLED` | NO | `true` | Keyless GeckoTerminal fallback pool stats |
| `DEFILLAMA_ENABLED` | NO | `true` | Keyless DefiLlama batch coin prices and token metadata |
| `JUPITER_API_KEY` | NO | empty | Jupiter Price API v3 key |
| `COINGECKO_API_KEY` | NO | empty | CoinGecko Pro API key |
| `WALLET_PRIVATE_KEY` | NO | empty | Solana wallet (live trading only) |
| `WATCHLIST_POOLS` | NO | empty | Comma-separated pool addresses |
| `PAPER_TRADING` | NO | `true` | Paper vs live trading |
| `SQLITE_DB_PATH` | NO | `./prism.db` | SQLite database file |

`prism setup`, `prism dev`, `prism feedback`, and `prism issue` require a valid
registered account. Feedback and issues are stored in the Prism Cloud D1 store;
local storage is only an outage fallback.

## Free public-data path

Prism is local-first and does not require a paid RPC or data plan:

- **Pool stats:** Meteora Data API → DexScreener → GeckoTerminal → heuristic.
- **Token prices:** Jupiter → DefiLlama → DexScreener → CoinGecko → Helius (if configured) → CoinGecko spot.
- **Token metadata:** known majors → DefiLlama → keyless Solana RPC → Helius (if configured).
- **RPC reads:** independent providers use health-aware earliest-slot routing, per-provider pacing, and immediate failover. The two Solana Labs hostnames share one quota and count as one leg. Pocket Network is a free fair-use leg; if its SPL enumeration is incomplete, wallet valuation fails closed by under-reporting rather than inventing balances.

Public responses are normalized into bounded in-memory TTL caches; identical concurrent reads are coalesced, and provider circuit breakers skip a rate-limited source instead of retrying it in a loop. Raw public responses are not stored. Only useful token metadata is persisted through the existing SQLite metadata cache.

See [`config-service.ts`](../engine/config-service.ts) for the full list.
