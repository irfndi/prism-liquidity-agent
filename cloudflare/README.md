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
│       └── telegram-bot.test.ts     # Bot tests (vitest-pool-workers)
├── migrations/
│   └── NNNN_*.sql                   # D1 schema migrations (users, api_keys, telegram_link_codes, …)
├── alchemy.run.ts                   # Alchemy composition root: both workers + D1/KV/R2/Vectorize
├── wrangler.telegram.test.toml      # Test-only config (vitest-pool-workers), never deployed
├── vitest.config.ts                 # Vitest config with @cloudflare/vitest-pool-workers
├── tsconfig.json                    # TypeScript strict config
└── package.json                     # Dependencies: hono, effect; dev: alchemy (pinned), wrangler
```

## Live Deployment (Production)

| Resource              | Value                                         | Status    |
| --------------------- | --------------------------------------------- | --------- |
| API Worker            | https://prism-api.irfndi.workers.dev          | ✅ Live   |
| Telegram Bot          | https://prism-telegram-bot.irfndi.workers.dev | ✅ Live   |
| Telegram Bot Username | @prism_agent_bot                              | ✅ Active |
| Cloudflare Account ID | `a37da71c38a2f7ab732057d87d5d0f6e`            | Active    |

## Deploying via Alchemy

Infrastructure is declared in TypeScript in `cloudflare/alchemy.run.ts` (Alchemy v2, "Infrastructure-as-Effects"). One typed program declares both Workers plus the D1 / KV / R2 / Vectorize resources they bind, replacing the old `wrangler.toml` / `wrangler.telegram.toml` pipeline (both files are deleted). `wrangler` stays a devDependency only for the vitest-pool-workers test suite and the out-of-band release R2 writes; the Alchemy CLI is the exact-pinned devDependency `alchemy@2.0.0-beta.64`.

`cloudflare/alchemy.run.ts` is the source of truth when this document and the code disagree. The docs it is grounded on:

- Workers: https://alchemy.run/cloudflare/compute/workers
- D1: https://alchemy.run/cloudflare/data/d1
- KV: https://alchemy.run/cloudflare/data/kv
- R2: https://alchemy.run/cloudflare/data/r2
- Vectorize: https://alchemy.run/cloudflare/ai/vectorize
- Secrets & env: https://alchemy.run/cloudflare/security/secrets-env

### Resources (pre-existing, adopted by name)

The stack does NOT create new resources. On a first deploy (empty Alchemy state), every provider finds the live resource in the account by the exact physical name in `alchemy.run.ts` and adopts it. No data migration, no new IDs.

| Binding   | Resource | Physical name  | ID / config                                 |
| --------- | -------- | -------------- | ------------------------------------------- |
| `DB`      | D1       | `prism-db`     | `0657c2b3-fdea-4b33-b11b-8d0a7b27cbc8`      |
| `CACHE`   | KV       | `prism-cache`  | `78d7fb5d3fab494dbc8f2940e524f22d`          |
| `BACKUPS` | R2       | `prism-backups`|                                             |
| `MEMORY`  | Vectorize| `prism-memory` | 384 dimensions, cosine                      |

Physical identity comes from these names, so the `prod` stage never renames anything; the stage only scopes the Alchemy state keyspace.

### Guardrails

> **Never change a resource `name` / `title` in `alchemy.run.ts`.** The same goes for the D1 `jurisdiction` / location hint and the Vectorize `dimensions` / `metric`. All of them are creation-immutable, and editing any one breaks adoption and plans a **destructive REPLACE** (drop + recreate) of a production resource.
>
> The `prism-backups` R2 bucket is also written out-of-band by `release.yml` / `ci.yml` (`wrangler r2 object put`). It is declared here only so the `BACKUPS` binding exists. **Never run `alchemy destroy` against it.**

### One-time bootstrap (before the first CI deploy)

The Alchemy remote state store (a worker + Durable Object backed by the account's Secrets Store) must exist before a CI deploy can succeed. Run this once, locally, with an authenticated admin profile:

```bash
cd cloudflare
bun alchemy cloudflare bootstrap
```

Afterwards CI (`CI=true`, set automatically by GitHub Actions) resolves state-store credentials from the Cloudflare Secrets Store on every run; runners hold no local state.

### Worker secrets (no longer `wrangler secret put`)

Worker secrets are declared as `Config.redacted("<NAME>")` in `alchemy.run.ts`. They resolve from environment variables **at deploy time** and are uploaded to the workers as `secret_text`. There is no separate secret-setting step. In CI they come from GitHub repo secrets (checklist under CI/CD below); for a manual local deploy, export the env vars in your shell first.

The bot↔API contract is unchanged:

- `BOT_API_SECRET` must be identical on both workers. The bot sends it as the `X-Bot-Api-Secret` header; the API rejects telegram_id-keyed endpoints without it.
- `TELEGRAM_WEBHOOK_SECRET` gates the webhook: the bot worker rejects all webhook POSTs without it (fail closed).
- Both workers fail closed when their required secrets are unset.

### D1 migrations

Alchemy applies `cloudflare/migrations/*.sql` on every deploy, using the wrangler-compatible `d1_migrations` tracking table. The 13 wrangler-applied migrations are already recorded there, so they are recognized and skipped. Adding a migration means dropping a new `NNNN_name.sql` file into `cloudflare/migrations/`; it applies on the next deploy. The stack deploys the data resources before the workers, so pending migrations apply before the workers that bind them.

### Manual local deploy

```bash
git clone https://github.com/irfndi/prism-liquidity-agent.git
cd prism-liquidity-agent/cloudflare
bun install

# Secrets resolve from env at deploy time (see above):
export TELEGRAM_BOT_TOKEN=...
export TELEGRAM_WEBHOOK_SECRET=...
export BOT_API_SECRET=...
export ADMIN_API_KEY=...
export FEE_WALLET_ADDRESS=...

bun run plan     # dry-run: review the planned diff without applying
bun run deploy   # alchemy deploy --stage prod --yes
```

Cloudflare credentials resolve from the standard `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` env vars (or an authenticated Alchemy profile, e.g. `bun alchemy login --profile admin`).

### Telegram webhook (out-of-band manual step)

Telegram webhook registration is NOT managed by Alchemy. It is the same manual step under either pipeline:

```bash
# Replace YOUR_BOT_TOKEN with the @BotFather token.
# secret_token MUST match TELEGRAM_WEBHOOK_SECRET; the worker fails closed without it.
curl "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook?url=https://prism-telegram-bot.irfndi.workers.dev/webhook&secret_token=YOUR_WEBHOOK_SECRET"

# Verify
curl "https://api.telegram.org/botYOUR_BOT_TOKEN/getWebhookInfo"
```

## API Endpoints

| Endpoint                    | Method | Auth        | Description                           |
| --------------------------- | ------ | ----------- | ------------------------------------- |
| `/health`                   | GET    | None        | Health check                          |
| `/v1/register`              | POST   | None¹       | Register new user, returns API key    |
| `/v1/login`                 | POST   | Bearer      | Validate API key, returns user info   |
| `/v1/whoami`                | GET    | Bearer      | Get current user info                 |
| `/v1/whoami-telegram`       | POST   | Bot secret  | Look up user by telegram_id (for bot) |
| `/v1/link-telegram/start`   | POST   | Bearer      | Generate `LINK-<16 hex>` code         |
| `/v1/link-telegram/confirm` | POST   | Rate-limited² | Confirm Telegram link with code     |
| `/v1/register-telegram`     | POST   | Bot secret  | Register via Telegram (for bot)       |
| `/v1/agent-status`          | POST   | Bot secret  | Get agent status (for Telegram bot)   |
| `/v1/issue`                 | POST   | Bearer      | Store an issue in D1                  |
| `/v1/feedback`              | POST   | Bearer      | Store deduplicated agent feedback     |
| `/v1/errors/report`         | POST   | Bearer      | Store one authenticated error report  |
| `/v1/errors/batch`          | POST   | Bearer      | Store authenticated error reports     |
| `/v1/installs/ping`         | POST   | Mixed       | Anonymous install; auth for lifecycle|
| `/v1/alerts`                | POST   | Bearer      | Store an engine alert + push to Telegram |
| `/v1/alerts/preferences`    | POST   | Bot secret  | Set `alerts_enabled` for a telegram_id |
| `/v1/audit`                 | GET    | Admin       | Query deduplicated audit summaries   |

¹ `/v1/register` is open for normal CLI registration, but binding a `telegram_id`
in the same call requires the `X-Bot-Api-Secret` header.
² `/v1/link-telegram/confirm` is limited to 10 attempts/hour/IP, and each code is
burned after 5 attempts. Link codes expire 10 minutes after issue (unixepoch
comparison) and requesting a new code invalidates the user's outstanding ones.

### Proactive alerts (engine → Telegram push)

The engine emits alert events (`position_out_of_range`, `range_warning`,
`exit_executed`, `risk_rejection`, `fee_milestone`) to `POST /v1/alerts` with
its API key. The API worker stores every alert in the `alerts` D1 table
(60/hour per user cap) and, when the user has a linked `telegram_id` and
`alerts_enabled = 1`, forwards it to the bot worker's internal
`POST /internal/deliver-alert` endpoint (authenticated with the same
`BOT_API_SECRET` shared secret) which formats and pushes the Telegram message.
Delivery is best-effort: undelivered alerts stay in D1 with `delivered_at`
NULL. Users toggle delivery with `/alerts on|off` in the bot.

## Telegram Bot Commands

| Command     | Description                                |
| ----------- | ------------------------------------------ |
| `/start`    | Welcome message                            |
| `/register` | Create new Prism account (returns API key) |
| `/link`     | Instructions to link existing account      |
| `/whoami`   | Show account info (user ID, tier)          |
| `/status`   | Show agent status (positions, P&L)         |
| `/alerts on\|off` | Toggle proactive alert delivery        |
| `/help`     | List all commands                          |

Send the `LINK-<16 hex>` code to link your Telegram to an existing account.

**Private chats only:** `/register`, `/whoami`, `/status`, `/link`, `/alerts`
and link-code confirmation are refused in group chats — credentials and
account-scoped preferences must never be posted where other members can see
them. User-controlled text (e.g. first names) and engine-controlled alert
content are HTML-escaped before being interpolated into `parse_mode: HTML`
replies.

## Bindings

- **DB** (D1): `prism-db` — accounts, feedback, errors, installs, audit summaries, and trading metadata
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

The vitest-pool-workers suite uses `wrangler.telegram.test.toml` internally (the only wrangler config left in this directory; it is not used for deployment).

### Run all tests

```bash
cd cloudflare
bunx vitest run
```

### Run specific test file

```bash
bunx vitest run workers/telegram-bot/telegram-bot.test.ts
```

### Test coverage: 30 tests for Telegram bot

- Health check (1)
- Webhook security (4, incl. fail-closed when the secret is unset)
- Command handlers (6, incl. HTML-escaping of user-controlled names)
- Group chat restrictions (5)
- Link code handling (6, incl. bot-secret header and 16-hex codes)
- Registration flow (2)
- Whoami command (2)
- Status command (1)
- Edge cases (3)

## Development

### Local dev mode

```bash
cd cloudflare

# Run both workers locally (Alchemy dev server)
bun run dev

# Type check
bun run typecheck
```

### Adding a new migration

Drop a new file into `cloudflare/migrations/` following the existing numbering:

```bash
touch cloudflare/migrations/0014_add_field.sql
```

Write the SQL; it applies to the production D1 on the next `bun run deploy` (manual or CI). The `d1_migrations` tracking table keeps already-applied migrations from re-running.

## CI/CD

The GitHub Actions workflow at `.github/workflows/deploy-cloudflare.yml` runs on pushes and PRs to `main` that touch `cloudflare/**`:

1. Installs dependencies with Bun
2. Runs the type check (`bun run typecheck`)
3. **On PRs, stops there.** The deploy runs only on merge to `main`: `bun run deploy`, i.e. `alchemy deploy --stage prod --yes`

**There are no PR preview deploys, by design.** Every stage would share the single production D1 / KV / R2 / Vectorize, so a per-PR stage destroyed on PR close could drop production data. One production stack, stage `prod`.

**Required GitHub secrets:**

| Secret                      | Status       | Purpose                                                                   |
| --------------------------- | ------------ | ------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`      | Existing     | Cloudflare API token (Workers, D1, KV, R2, Vectorize write); also Alchemy auth + remote state store |
| `CLOUDFLARE_ACCOUNT_ID`     | Existing     | `a37da71c38a2f7ab732057d87d5d0f6e`                                        |
| `TELEGRAM_BOT_TOKEN`        | **NEW**      | @BotFather token (both workers)                                           |
| `TELEGRAM_WEBHOOK_SECRET`   | **NEW**      | Telegram `setWebhook` secret_token (bot worker)                           |
| `BOT_API_SECRET`            | **NEW**      | Shared bot↔API secret; one value, set on both workers                     |
| `ADMIN_API_KEY`             | **NEW**      | Admin endpoints, e.g. `/v1/audit` (API worker)                            |
| `FEE_WALLET_ADDRESS`        | **NEW**      | Fee collection wallet, Solana address (API worker)                        |

The five marked **NEW** must be added by the operator: their values cannot be extracted from the old wrangler secrets, so re-supply them. CI passes each one into the deploy environment, where `Config.redacted` resolves and uploads it as `secret_text`.

## Troubleshooting

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

Bindings resolve by the physical title declared in `alchemy.run.ts` (`prism-cache`), not by an ID in a config file. Verify the namespace still exists in the account:

```bash
wrangler kv namespace list
```

## Environment Variables (non-secret)

Declared as literal strings in each worker's `env: {}` block in `alchemy.run.ts` (there is no toml `[vars]` section anymore):

| Variable               | Default                                                 | Description                    |
| ---------------------- | ------------------------------------------------------- | ------------------------------ |
| `ENVIRONMENT`          | `production`                                            | Environment name               |
| `TELEGRAM_WEBHOOK_URL` | `https://prism-telegram-bot.irfndi.workers.dev/webhook` | Webhook URL                    |
| `TELEGRAM_BOT_URL`     | `https://prism-telegram-bot.irfndi.workers.dev`         | Bot worker base URL (alert push) |
| `API_BASE_URL`         | `https://prism-api.irfndi.workers.dev`                  | API URL (used by Telegram bot) |

## Related Documentation

- [Main README](../README.md) — Overview of the entire platform
- [CLI Docs](../docs/cli.md) — CLI command reference
- [Install Guide](../docs/install.md) — Local development setup
- [Agent Harness](../docs/agent-harness.md) — Agent-driven management
- [Cron Examples](../docs/cron-examples.md) — Scheduled task examples

## Support

- Feedback and issues: `prism feedback "..."` or `prism issue "..."` (stored in D1)
- Telegram Bot: @prism_agent_bot
- Docs: https://github.com/irfndi/prism-liquidity-agent/tree/main/docs
