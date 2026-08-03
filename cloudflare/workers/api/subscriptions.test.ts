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

describe("Subscriptions API", () => {
  beforeAll(async () => {
    // Create tables if not exists
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
      `CREATE TABLE IF NOT EXISTS referrals (
        id TEXT PRIMARY KEY,
        referrer_user_id TEXT NOT NULL,
        referee_user_id TEXT NOT NULL UNIQUE,
        referral_code TEXT NOT NULL,
        credited_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS user_credits (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        amount REAL NOT NULL,
        reason TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME
      )`,
    ).run();
  });

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM subscriptions").run();
    await env.DB.prepare("DELETE FROM api_keys").run();
    await env.DB.prepare("DELETE FROM users").run();
    await env.DB.prepare("DELETE FROM rate_limits").run();
    await env.CACHE.delete("rate_limit:register:unknown");
  });

  describe("POST /v1/register", () => {
    it("creates a free subscription on registration", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("POST", "/v1/register", {});
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        user_id: string;
        api_key: string;
        tier: string;
      };
      expect(body.tier).toBe("free");

      // Verify subscription was created
      const subs = await env.DB.prepare(
        "SELECT * FROM subscriptions WHERE user_id = ?",
      )
        .bind(body.user_id)
        .all();
      const results = subs.results ?? [];
      expect(results).toHaveLength(1);
      const sub = results[0] as Record<string, unknown>;
      expect(sub.tier).toBe("free");
      expect(sub.period_start).toBeTruthy();
      expect(sub.period_end).toBeTruthy();
    });
  });

  describe("GET /v1/subscription/status", () => {
    it("backfills missing subscription for existing users", async () => {
      const ctx1 = createExecutionContext();
      const regRequest = buildRequest("POST", "/v1/register", {});
      const regResponse = await worker.fetch(regRequest, testEnv, ctx1);
      expect(regResponse.status).toBe(200);
      const regBody = (await regResponse.json()) as {
        user_id: string;
        api_key: string;
      };

      await env.DB.prepare("DELETE FROM subscriptions WHERE user_id = ?")
        .bind(regBody.user_id)
        .run();

      const before = await env.DB.prepare(
        "SELECT * FROM subscriptions WHERE user_id = ?",
      )
        .bind(regBody.user_id)
        .all();
      expect((before.results ?? []).length).toBe(0);

      const ctx2 = createExecutionContext();
      const request = buildRequest("GET", "/v1/subscription/status", undefined, {
        Authorization: `Bearer ${regBody.api_key}`,
      });
      const response = await worker.fetch(request, testEnv, ctx2);
      expect(response.status).toBe(200);

      // Subscription should be backfilled
      const after = await env.DB.prepare(
        "SELECT * FROM subscriptions WHERE user_id = ?",
      )
        .bind(regBody.user_id)
        .all();
      const results = after.results ?? [];
      expect(results).toHaveLength(1);
      const sub = results[0] as Record<string, unknown>;
      expect(sub.tier).toBe("free");
    });

    it("returns subscription data for registered users", async () => {
      // Register a user
      const ctx1 = createExecutionContext();
      const regRequest = buildRequest("POST", "/v1/register", {});
      const regResponse = await worker.fetch(regRequest, testEnv, ctx1);
      expect(regResponse.status).toBe(200);
      const regBody = (await regResponse.json()) as {
        user_id: string;
        api_key: string;
        tier: string;
      };

      // Check status
      const ctx2 = createExecutionContext();
      const request = buildRequest("GET", "/v1/subscription/status", undefined, {
        Authorization: `Bearer ${regBody.api_key}`,
      });
      const response = await worker.fetch(request, testEnv, ctx2);
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        tier: string;
        walletSol: number;
        referralCount: number;
        credits: number;
        platformFeeRate: number;
      };
      expect(body.tier).toBe("free");
      expect(body.platformFeeRate).toBe(0);
    });
  });
});
