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

describe("Wallet API", () => {
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
      `CREATE TABLE IF NOT EXISTS rate_limits (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
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
  });

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM wallets").run();
    await env.DB.prepare("DELETE FROM api_keys").run();
    await env.DB.prepare("DELETE FROM users").run();
    await env.DB.prepare("DELETE FROM rate_limits").run();
    await env.CACHE.delete("rate_limit:register:unknown");

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

  describe("POST /v1/wallet", () => {
    it("stores a wallet pubkey for authenticated user", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest(
        "POST",
        "/v1/wallet",
        { pubkey: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" },
        { Authorization: `Bearer ${apiKey}` },
      );
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(200);

      const body = (await response.json()) as { success: boolean; pubkey: string };
      expect(body.success).toBe(true);
      expect(body.pubkey).toBe("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");

      // Verify in DB
      const rows = await env.DB.prepare(
        "SELECT pubkey FROM wallets WHERE user_id = ?",
      )
        .bind(userId)
        .all();
      const results = rows.results ?? [];
      expect(results).toHaveLength(1);
      const row = results[0] as Record<string, unknown>;
      expect(row.pubkey).toBe("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
    });

    it("rejects invalid Solana addresses", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest(
        "POST",
        "/v1/wallet",
        { pubkey: "not-a-valid-addr" },
        { Authorization: `Bearer ${apiKey}` },
      );
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(400);
    });

    it("returns 401 without API key", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("POST", "/v1/wallet", {
        pubkey: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      });
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(401);
    });

    it("returns 401 for invalid API key", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest(
        "POST",
        "/v1/wallet",
        { pubkey: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" },
        { Authorization: "Bearer invalid-key" },
      );
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(401);
    });

    it("replaces existing wallet on second store", async () => {
      const ctx1 = createExecutionContext();
      const req1 = buildRequest(
        "POST",
        "/v1/wallet",
        { pubkey: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" },
        { Authorization: `Bearer ${apiKey}` },
      );
      await worker.fetch(req1, testEnv, ctx1);

      const ctx2 = createExecutionContext();
      const req2 = buildRequest(
        "POST",
        "/v1/wallet",
        { pubkey: "9yLZuh4DX98e18UYKTEqcE6kCmfUrB95TZRuJosgBtV" },
        { Authorization: `Bearer ${apiKey}` },
      );
      const res2 = await worker.fetch(req2, testEnv, ctx2);
      expect(res2.status).toBe(200);

      // Should only have one wallet
      const rows = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM wallets WHERE user_id = ?",
      )
        .bind(userId)
        .first();
      expect((rows as { count: number })?.count).toBe(1);
    });
  });

  describe("GET /v1/wallet", () => {
    it("returns the stored wallet pubkey", async () => {
      // Store a wallet first
      const ctx1 = createExecutionContext();
      const req1 = buildRequest(
        "POST",
        "/v1/wallet",
        { pubkey: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" },
        { Authorization: `Bearer ${apiKey}` },
      );
      await worker.fetch(req1, testEnv, ctx1);

      // Get it back
      const ctx2 = createExecutionContext();
      const req2 = buildRequest("GET", "/v1/wallet", undefined, {
        Authorization: `Bearer ${apiKey}`,
      });
      const res2 = await worker.fetch(req2, testEnv, ctx2);
      expect(res2.status).toBe(200);

      const body = (await res2.json()) as { pubkey: string };
      expect(body.pubkey).toBe("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
    });

    it("returns 404 when no wallet exists", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("GET", "/v1/wallet", undefined, {
        Authorization: `Bearer ${apiKey}`,
      });
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(404);
    });

    it("returns 401 without API key", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("GET", "/v1/wallet");
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(401);
    });

    it("returns 401 for invalid API key", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("GET", "/v1/wallet", undefined, {
        Authorization: "Bearer invalid-key",
      });
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(401);
    });
  });
});
