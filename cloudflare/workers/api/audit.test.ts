import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker, { type Env } from "./index";

const testEnv = env as unknown as Env;

function buildRequest(
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

describe("Audit Logging API", () => {
  let apiKey: string;
  let userId: string;

  beforeAll(async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        telegram_id TEXT UNIQUE,
        tier TEXT NOT NULL DEFAULT 'free',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS api_keys (
        key_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used_at DATETIME
      )`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS telegram_link_codes (
        code TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at DATETIME,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS wallets (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        pubkey TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
    ).run();
    await env.DB.prepare(
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
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        details TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS audit_event_summary (
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        event_key TEXT NOT NULL,
        details TEXT,
        first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (user_id, action, event_key)
      )`,
    ).run();
  });

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM audit_log").run();
    await env.DB.prepare("DELETE FROM audit_event_summary").run();
    await env.DB.prepare("DELETE FROM wallets").run();
    await env.DB.prepare("DELETE FROM subscriptions").run();
    await env.DB.prepare("DELETE FROM telegram_link_codes").run();
    await env.DB.prepare("DELETE FROM api_keys").run();
    await env.DB.prepare("DELETE FROM users").run();
    await env.CACHE.delete("rate_limit:register:unknown");
    await env.CACHE.delete("rate_limit:link_confirm:unknown");

    // Register a user to get an API key
    const ctx = createExecutionContext();
    const request = buildRequest("POST", "/v1/register", {});
    const response = await worker.fetch(request, testEnv, ctx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user_id: string;
      api_key: string;
    };
    apiKey = body.api_key;
    userId = body.user_id;
  });

  it("logs register event", async () => {
    const rows = await env.DB.prepare(
      "SELECT * FROM audit_event_summary WHERE user_id = ? AND action = ?",
    )
      .bind(userId, "register")
      .all();
    const results = rows.results ?? [];
    expect(results).toHaveLength(1);
    const row = results[0] as Record<string, unknown>;
    expect(row.action).toBe("register");
    const details = JSON.parse(row.details as string);
    expect(details).toMatchObject({ tier: "free" });
  });

  it("does not log login noise", async () => {
    const ctx = createExecutionContext();
    const request = buildRequest(
      "POST",
      "/v1/login",
      {},
      {
        Authorization: `Bearer ${apiKey}`,
      },
    );
    const response = await worker.fetch(request, testEnv, ctx);
    expect(response.status).toBe(200);

    const rows = await env.DB.prepare(
      "SELECT * FROM audit_event_summary WHERE user_id = ? AND action = ?",
    )
      .bind(userId, "login")
      .all();
    const results = rows.results ?? [];
    expect(results).toHaveLength(0);
  });

  it("logs wallet_sync event", async () => {
    const ctx = createExecutionContext();
    const request = buildRequest(
      "POST",
      "/v1/wallet",
      { pubkey: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" },
      { Authorization: `Bearer ${apiKey}` },
    );
    const response = await worker.fetch(request, testEnv, ctx);
    expect(response.status).toBe(200);

    await worker.fetch(
      buildRequest(
        "POST",
        "/v1/wallet",
        { pubkey: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" },
        { Authorization: `Bearer ${apiKey}` },
      ),
      testEnv,
      createExecutionContext(),
    );

    const rows = await env.DB.prepare(
      "SELECT * FROM audit_event_summary WHERE user_id = ? AND action = ?",
    )
      .bind(userId, "wallet_sync")
      .all();
    const results = rows.results ?? [];
    expect(results).toHaveLength(1);
    const row = results[0] as Record<string, unknown>;
    expect(row.action).toBe("wallet_sync");
    const details = JSON.parse(row.details as string);
    expect(details).toMatchObject({ pubkey: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" });
    expect(row.occurrence_count).toBe(2);
  });

  it("logs telegram_link event", async () => {
    await env.DB.prepare(
      "INSERT INTO telegram_link_codes (code, user_id, expires_at) VALUES (?, ?, ?)",
    )
      .bind("LINK-TEST", userId, Math.floor(Date.now() / 1000) + 600)
      .run();

    const ctx = createExecutionContext();
    const request = buildRequest("POST", "/v1/link-telegram/confirm", {
      code: "LINK-TEST",
      telegram_id: "123456789",
    });
    const response = await worker.fetch(request, testEnv, ctx);
    expect(response.status).toBe(200);

    const rows = await env.DB.prepare(
      "SELECT * FROM audit_event_summary WHERE user_id = ? AND action = ?",
    )
      .bind(userId, "telegram_link")
      .all();
    const results = rows.results ?? [];
    expect(results).toHaveLength(1);
    const row = results[0] as Record<string, unknown>;
    expect(row.action).toBe("telegram_link");
    const details = JSON.parse(row.details as string);
    expect(details).toMatchObject({ telegram_id: "123456789" });
  });
});
