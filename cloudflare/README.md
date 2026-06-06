# Prism Cloudflare Workers

Cloudflare Workers subproject for the Prism Liquidity Agent platform. Hosts the API backend and Telegram bot for multi-tenant registration, authentication, wallet management, and notifications.

> **For agent harnesses (OpenClaw, Hermes, acpx):** These workers are **already deployed** in production. You do NOT need to set up or deploy them. Just use the live API at `https://prism-api.irfndi.workers.dev`. This README is for human operators and developers who need to redeploy.

## Architecture

```
cloudflare/
├── workers/
│   ├── api/                         # Main API Worker (Hono + Effect-TS)
│   │   ├── index.ts                 # Routes: /health, /v1/register, /v1/login, etc.
│   │   └── api.test.ts              # API tests (vitest-pool-workers)
│   └── telegram-bot/                # Telegram webhook handler
│       ├── index.ts                 # Bot commands: /start, /register, /link, /whoami, /status
│       └── telegram-bot.test.ts     # Bot tests (16 tests, all passing)
├── migrations/
│   └── 0001_initial.sql             # D1 schema: users, api_keys, telegram_link_codes, wallets, subscriptions, audit_log
├── wrangler.toml                    # API worker config
├── wrangler.telegram.toml           # Telegram bot worker config
├── wrangler.telegram.test.toml      # Telegram bot test config (no service bindings)
├── vitest.config.ts                 # Vitest config with @cloudflare/vitest-pool-workers
├── tsconfig.json                    # TypeScript strict config
└── package.json                     # Dependencies: hono, effect, @cloudflare/workers-types
```

## Live Deployment (Production)

| Resource              | Value                                         | Status    |
| --------------------- | --------------------------------------------- | --------- |
| API Worker            | https://prism-api.irfndi.workers.dev          | ✅ Live   |
| Telegram Bot          | https://prism-telegram-bot.irfndi.workers.dev | ✅ Live   |
| Telegram Bot Username | @prism_agent_bot                              | ✅ Active |
| Cloudflare Account ID | `a37da71c38a2f7ab732057d87d5d0f6e`            | Active    |

## Quick Setup (for an AI agent to execute)

### Prerequisites

```bash
# Required: Bun 1.4.0+
curl -fsSL https://bun.sh/install | bash

# Required: wrangler CLI v4+
bun add -g wrangler

# Required: authenticated with Cloudflare
wrangler login
```

### 1. Clone and install

```bash
git clone https://github.com/irfndi/prism-liquidity-agent.git
cd prism-liquidity-agent
bun install
cd cloudflare && bun install
```

### 2. Create Cloudflare resources (one-time)

```bash
# Set account ID for all subsequent commands
export CLOUDFLARE_ACCOUNT_ID=a37da71c38a2f7ab732057d87d5d0f6e

# D1 database
wrangler d1 create prism-db
# Note the database_id from output, update wrangler.toml

# KV namespace
wrangler kv namespace create "prism-cache"
# Note the id from output, update wrangler.toml

# R2 bucket
wrangler r2 bucket create prism-backups

# Vectorize index (384 dimensions, cosine similarity)
wrangler vectorize create prism-memory --dimensions=384 --metric=cosine
```

### 3. Configure `wrangler.toml`

Replace the IDs in `wrangler.toml` and `wrangler.telegram.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "prism-db"
database_id = "YOUR_D1_DATABASE_ID"  # from step 2

[[kv_namespaces]]
binding = "CACHE"
id = "YOUR_KV_NAMESPACE_ID"  # from step 2
```

### 4. Run database migrations

```bash
# Apply migrations to remote (production) D1
wrangler d1 migrations apply prism-db --remote

# Or to local D1 for development
wrangler d1 migrations apply prism-db --local
```

### 5. Set secrets

```bash
# Telegram bot token (get from @BotFather)
echo "YOUR_TELEGRAM_BOT_TOKEN" | wrangler secret put TELEGRAM_BOT_TOKEN

# Optional: webhook secret for additional security
echo "RANDOM_SECRET" | wrangler secret put TELEGRAM_WEBHOOK_SECRET

# Optional: GitHub token for issue filing via /v1/issue
echo "ghp_xxxxxxxx" | wrangler secret put GITHUB_TOKEN
echo "owner/repo" | wrangler secret put GITHUB_REPO

# Optional: fee collection wallet (Solana address)
echo "YOUR_SOLANA_ADDRESS" | wrangler secret put FEE_WALLET_ADDRESS
```

### 6. Deploy both workers

```bash
# Deploy API worker
wrangler deploy

# Deploy Telegram bot worker
wrangler deploy --config wrangler.telegram.toml
```

### 7. Setup Telegram webhook

```bash
# Replace YOUR_BOT_TOKEN with the token from step 5
curl "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook?url=https://prism-telegram-bot.YOUR_SUBDOMAIN.workers.dev/webhook"

# Verify
curl "https://api.telegram.org/botYOUR_BOT_TOKEN/getWebhookInfo"
```

## API Endpoints

| Endpoint                    | Method | Auth   | Description                           |
| --------------------------- | ------ | ------ | ------------------------------------- |
| `/health`                   | GET    | None   | Health check                          |
| `/v1/register`              | POST   | None   | Register new user, returns API key    |
| `/v1/login`                 | POST   | Bearer | Validate API key, returns user info   |
| `/v1/whoami`                | GET    | Bearer | Get current user info                 |
| `/v1/whoami-telegram`       | POST   | None   | Look up user by telegram_id (for bot) |
| `/v1/link-telegram/start`   | POST   | Bearer | Generate `LINK-XXXXXX` code           |
| `/v1/link-telegram/confirm` | POST   | None   | Confirm Telegram link with code       |
| `/v1/register-telegram`     | POST   | None   | Register via Telegram (for bot)       |
| `/v1/agent-status`          | POST   | None   | Get agent status (for Telegram bot)   |
| `/v1/issue`                 | POST   | Bearer | File GitHub issue                     |

## Telegram Bot Commands

| Command     | Description                                |
| ----------- | ------------------------------------------ |
| `/start`    | Welcome message                            |
| `/register` | Create new Prism account (returns API key) |
| `/link`     | Instructions to link existing account      |
| `/whoami`   | Show account info (user ID, tier)          |
| `/status`   | Show agent status (positions, P&L)         |
| `/help`     | List all commands                          |

Send a 6-character code to link your Telegram to an existing account.

## Bindings

- **DB** (D1): `prism-db` — users, api_keys, telegram_link_codes, wallets, subscriptions, audit_log
- **CACHE** (KV): `prism-cache` — rate limits, session cache
- **BACKUPS** (R2): `prism-backups` — database backups
- **MEMORY** (Vectorize): `prism-memory` — embeddings (384d, cosine)

## Observability

Both workers have logs enabled (`invocation_logs: true`, `persist: true`). View logs with:

```bash
# Live tail
wrangler tail prism-api
wrangler tail prism-telegram-bot

# Historical (Cloudflare dashboard)
# https://dash.cloudflare.com → Workers & Pages → prism-api → Logs
```

## Testing

### Run all tests

```bash
cd cloudflare
bunx vitest run
```

### Run specific test file

```bash
bunx vitest run workers/telegram-bot/telegram-bot.test.ts
```

### Test coverage: 16 tests for Telegram bot

- Health check (1)
- Webhook security (2)
- Command handlers (4)
- Link code handling (2)
- Registration flow (2)
- Whoami command (2)
- Status command (1)
- Edge cases (2)

## Development

### Local dev mode

```bash
cd cloudflare

# Run API worker locally
wrangler dev

# Run Telegram bot locally (separate terminal)
wrangler dev --config wrangler.telegram.toml

# Type check
bun run typecheck
```

### Local D1 database

```bash
# Apply migrations to local D1
wrangler d1 migrations apply prism-db --local

# Query local D1
wrangler d1 execute prism-db --local --command "SELECT * FROM users;"
```

### Adding a new migration

```bash
# Create new migration file
touch cloudflare/migrations/0002_add_field.sql

# Add SQL (use CREATE TABLE IF NOT EXISTS, etc.)
# Apply locally
wrangler d1 migrations apply prism-db --local

# Apply to production
wrangler d1 migrations apply prism-db --remote
```

## CI/CD

GitHub Actions workflow at `.github/workflows/deploy-cloudflare.yml` automatically:

1. Runs on push to `main` (when `cloudflare/**` changes)
2. Installs dependencies with Bun
3. Runs type check
4. Applies D1 migrations to remote
5. Deploys API worker
6. Deploys Telegram bot worker

**Required GitHub Secrets:**

- `CLOUDFLARE_API_TOKEN` — Cloudflare API token with Workers, D1, KV, R2, Vectorize write access
- `CLOUDFLARE_ACCOUNT_ID` — `a37da71c38a2f7ab732057d87d5d0f6e`

## Troubleshooting

### "No workers bound to this worker"

This means the worker has no cron triggers. To add one:

```toml
# In wrangler.toml
[triggers]
crons = ["0 */6 * * *"]  # every 6 hours
```

### "ReferenceError: handle is not defined"

The Hono `handle` import from `hono/cloudflare-workers` was removed in Hono 4.x. Use `app.fetch` directly:

```typescript
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
};
```

### "error code: 1101" (HTTP 500)

This is a worker runtime error. Check logs:

```bash
wrangler tail prism-api
```

Then trigger a request. The error will appear in the tail output.

### API key not accepted

The login endpoint requires a Bearer token in the `Authorization` header:

```bash
curl -X POST https://prism-api.example.workers.dev/v1/login \
  -H "Authorization: Bearer sk-prism-xxx" \
  -H "Content-Type: application/json"
```

### Telegram webhook not receiving updates

1. Check webhook info:
   ```bash
   curl "https://api.telegram.org/botYOUR_TOKEN/getWebhookInfo"
   ```
2. Verify the URL is accessible (no auth, returns 200)
3. Check worker logs: `wrangler tail prism-telegram-bot`

### KV namespace not found

Make sure the KV namespace ID in `wrangler.toml` matches the actual namespace. List namespaces:

```bash
wrangler kv namespace list
```

## Environment Variables (non-secret)

In `[vars]` section of `wrangler.toml`:

| Variable               | Default                                                 | Description                    |
| ---------------------- | ------------------------------------------------------- | ------------------------------ |
| `ENVIRONMENT`          | `production`                                            | Environment name               |
| `TELEGRAM_WEBHOOK_URL` | `https://prism-telegram-bot.irfndi.workers.dev/webhook` | Webhook URL                    |
| `API_BASE_URL`         | `https://prism-api.irfndi.workers.dev`                  | API URL (used by Telegram bot) |

## Staging Environment

To deploy a staging environment:

1. Create separate resources:

   ```bash
   wrangler d1 create prism-db-staging
   wrangler kv namespace create "prism-cache-staging"
   ```

2. Update `[env.staging]` section in `wrangler.toml` with staging IDs

3. Deploy:
   ```bash
   wrangler deploy --env staging
   wrangler deploy --config wrangler.telegram.toml --env staging
   ```

## Related Documentation

- [Main README](../README.md) — Overview of the entire platform
- [CLI Docs](../docs/cli.md) — CLI command reference
- [Install Guide](../docs/install.md) — Local development setup
- [Agent Harness](../docs/agent-harness.md) — Agent-driven management
- [Cron Examples](../docs/cron-examples.md) — Scheduled task examples

## Support

- GitHub Issues: https://github.com/irfndi/prism-liquidity-agent/issues
- Telegram Bot: @prism_agent_bot
- Docs: https://github.com/irfndi/prism-liquidity-agent/tree/main/docs
