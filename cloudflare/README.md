# Prism Cloudflare Workers

Cloudflare Workers subproject for Prism DLMM platform.

## Architecture

```
cloudflare/
├── workers/
│   ├── api/           # Main API Worker (registration, auth, issue tracker)
│   └── telegram-bot/  # Telegram webhook handler
├── migrations/        # D1 database migrations
├── wrangler.toml      # Worker configuration
└── package.json       # Dependencies
```

## Setup

### 1. Install dependencies

```bash
cd cloudflare
bun install
```

### 2. Create D1 database

```bash
wrangler d1 create prism-db
```

### 3. Create KV namespace

```bash
wrangler kv namespace create "prism-cache"
```

### 4. Create R2 bucket

```bash
wrangler r2 bucket create prism-backups
```

### 5. Create Vectorize index

```bash
wrangler vectorize create prism-memory --dimensions=384 --metric=cosine
```

### 6. Update wrangler.toml

Copy the IDs from the commands above into `wrangler.toml`.

### 7. Set secrets

```bash
wrangler secret put FEE_WALLET_ADDRESS
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put GITHUB_TOKEN
```

### 8. Run migrations

```bash
wrangler d1 migrations apply prism-db
```

### 9. Deploy

```bash
wrangler deploy
```

## Development

```bash
# Local development
wrangler dev

# Type check
bun run typecheck

# Deploy to staging
wrangler deploy --env staging
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/v1/register` | POST | Register new user |
| `/v1/login` | POST | Login with API key |
| `/v1/whoami` | GET | Get user info |
| `/v1/link-telegram/start` | POST | Generate link code |
| `/v1/link-telegram/confirm` | POST | Confirm Telegram link |
| `/v1/issue` | POST | File GitHub issue |

## Bindings

- **DB**: D1 database (users, api_keys, subscriptions, audit_log)
- **CACHE**: KV namespace (rate limits, sessions)
- **BACKUPS**: R2 bucket (database backups)
- **MEMORY**: Vectorize index (embeddings)
