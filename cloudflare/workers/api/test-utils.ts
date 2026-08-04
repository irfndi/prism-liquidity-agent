// Shared scaffolding for the API worker test suites.
//
// Every route suite needs the same JSON request builder and the same core D1
// tables (users, api_keys, subscriptions), and the registration bootstrap can
// trip a shared rate-limit key. Keeping those in one place stops the suites'
// schemas from drifting apart as the real migrations evolve. Suite-specific
// tables (feedback, referral, audit) stay with the suite that uses them; each
// suite still owns its own beforeAll bootstrap call, so pool-workers' per-file
// isolation is preserved.

/** Build a JSON request against a placeholder host for `worker.fetch`. */
export function buildRequest(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Request {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", ...headers },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return new Request(`https://example.com${path}`, init);
}

/**
 * Idempotently create then empty the D1 tables shared by every
 * account/auth-dependent route (users, api_keys, subscriptions), leaving the
 * suite with a clean slate.
 */
export async function setupCommonSchema(db: D1Database): Promise<void> {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      telegram_id TEXT UNIQUE,
      tier TEXT NOT NULL DEFAULT 'free',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS api_keys (
      key_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME
    )`,
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      tier TEXT NOT NULL,
      period_start DATETIME NOT NULL,
      period_end DATETIME NOT NULL,
      payment_method TEXT,
      payment_tx_signature TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`,
  ).run();
  await db.prepare("DELETE FROM subscriptions").run();
  await db.prepare("DELETE FROM api_keys").run();
  await db.prepare("DELETE FROM users").run();
  await db.prepare("DELETE FROM rate_limits").run();
}

/**
 * Clear the unauthenticated CLI registration rate-limit key so a suite's
 * /v1/register bootstrap is not throttled by keys left behind in the shared
 * KV namespace.
 */
export async function clearRegisterRateLimit(cache: KVNamespace): Promise<void> {
  await cache.delete("rate_limit:register:unknown");
}
