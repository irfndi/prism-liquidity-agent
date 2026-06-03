// Augments Cloudflare.Env with project bindings so `import { env } from "cloudflare:test"`
// exposes DB, CACHE, BACKUPS, MEMORY and the configured vars/secrets.
// This is the same effect as `wrangler types` generating a worker-configuration.d.ts.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    CACHE: KVNamespace;
    BACKUPS: R2Bucket;
    MEMORY: VectorizeIndex;
    ENVIRONMENT: string;
    TELEGRAM_WEBHOOK_URL: string;
    API_BASE_URL: string;
    FEE_WALLET_ADDRESS?: string;
    TELEGRAM_BOT_TOKEN?: string;
    TELEGRAM_WEBHOOK_SECRET?: string;
    GITHUB_TOKEN?: string;
    GITHUB_REPO?: string;
    ADMIN_API_KEY?: string;
  }
}
