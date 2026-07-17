import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker, { type Env } from "./index";

const ADMIN_KEY = "test-admin-key-123";

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

function withAdmin(req: Request): Request {
  return new Request(req.url, {
    method: req.method,
    headers: { ...Object.fromEntries(req.headers), Authorization: `Bearer ${ADMIN_KEY}` },
    body: req.body,
  });
}

describe("Revenue Tracking API", () => {
  const testEnv = { ...env, ADMIN_API_KEY: ADMIN_KEY } as unknown as Env;
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
      `CREATE TABLE IF NOT EXISTS revenue_events (
        id TEXT PRIMARY KEY,
        pool_address TEXT NOT NULL,
        position_pubkey TEXT,
        fee_x REAL NOT NULL DEFAULT 0,
        fee_y REAL NOT NULL DEFAULT 0,
        platform_fee_x REAL NOT NULL DEFAULT 0,
        platform_fee_y REAL NOT NULL DEFAULT 0,
        tier TEXT NOT NULL DEFAULT 'free',
        user_id TEXT,
        install_id TEXT,
        tx_signature TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
    ).run();
    await env.DB.prepare(
      `ALTER TABLE revenue_events ADD COLUMN fee_transfer_tx_signature TEXT`,
    ).run().catch(() => {});
    await env.DB.prepare(
      `ALTER TABLE revenue_events ADD COLUMN operator_fee_x REAL NOT NULL DEFAULT 0`,
    ).run().catch(() => {});
    await env.DB.prepare(
      `ALTER TABLE revenue_events ADD COLUMN operator_fee_y REAL NOT NULL DEFAULT 0`,
    ).run().catch(() => {});
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        details TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
    ).run();

    const ctx = createExecutionContext();
    const registerReq = buildRequest("POST", "/v1/register", {});
    const registerRes = await worker.fetch(registerReq, testEnv, ctx);
    expect(registerRes.status).toBe(200);
    const regBody = (await registerRes.json()) as { user_id: string; api_key: string };
    apiKey = regBody.api_key;
    userId = regBody.user_id;
  });

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM revenue_events").run();
  });

  // ── POST /v1/revenue/log ────────────────────────────────────────────────

  describe("POST /v1/revenue/log", () => {
    it("stores a revenue event in D1", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest(
        "POST",
        "/v1/revenue/log",
        {
          poolAddress: "5JvD1TW5nqSz6gJtHfVnZKq3fZmBnL5xY7u9dR2wT4k",
          platformFeeX: 1.5,
          platformFeeY: 2.3,
          feeX: 10.0,
          feeY: 15.0,
          positionPubkey: "PosK11111111111111111111111111111111111111",
          installId: "inst-001",
          txSignature: "sig123abc",
        },
        { Authorization: `Bearer ${apiKey}` },
      );
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(200);

      const body = (await response.json()) as { id: string };
      expect(body.id).toBeTruthy();

      const rows = await env.DB.prepare(
        "SELECT pool_address, platform_fee_x, platform_fee_y, tier, user_id FROM revenue_events WHERE id = ?",
      )
        .bind(body.id)
        .all();
      const results = rows.results ?? [];
      expect(results).toHaveLength(1);
      const row = results[0] as Record<string, unknown>;
      expect(row.pool_address).toBe("5JvD1TW5nqSz6gJtHfVnZKq3fZmBnL5xY7u9dR2wT4k");
      expect(row.platform_fee_x).toBe(1.5);
      expect(row.platform_fee_y).toBe(2.3);
      expect(row.tier).toBe("free");
      expect(row.user_id).toBe(userId);
    });

    it("returns 401 without API key", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("POST", "/v1/revenue/log", {
        poolAddress: "5JvD1TW5nqSz6gJtHfVnZKq3fZmBnL5xY7u9dR2wT4k",
        platformFeeX: 1.0,
        platformFeeY: 2.0,
      });
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(401);
    });

    it("rejects negative or non-finite numeric fields", async () => {
      const base = {
        poolAddress: "5JvD1TW5nqSz6gJtHfVnZKq3fZmBnL5xY7u9dR2wT4k",
        platformFeeX: 1.0,
        platformFeeY: 2.0,
      };
      const invalidPayloads: Array<Record<string, unknown>> = [
        { ...base, platformFeeX: -1 },
        { ...base, platformFeeY: -0.001 },
        { ...base, feeX: -5 },
        { ...base, feeY: -5 },
        { ...base, operatorFeeX: -1 },
        { ...base, operatorFeeY: -1 },
        { ...base, platformFeeX: "1.0" },
        { ...base, feeX: "lots" },
      ];
      for (const payload of invalidPayloads) {
        const ctx = createExecutionContext();
        const request = buildRequest("POST", "/v1/revenue/log", payload, {
          Authorization: `Bearer ${apiKey}`,
        });
        const response = await worker.fetch(request, testEnv, ctx);
        expect(response.status).toBe(400);
      }
    });

    it("returns 400 on missing required fields", async () => {
      const ctx = createExecutionContext();
      const request1 = buildRequest(
        "POST",
        "/v1/revenue/log",
        { platformFeeX: 1.0, platformFeeY: 2.0 },
        { Authorization: `Bearer ${apiKey}` },
      );
      const response1 = await worker.fetch(request1, testEnv, ctx);
      expect(response1.status).toBe(400);

      const request2 = buildRequest(
        "POST",
        "/v1/revenue/log",
        { poolAddress: "5JvD1TW5nqSz6gJtHfVnZKq3fZmBnL5xY7u9dR2wT4k", platformFeeY: 2.0 },
        { Authorization: `Bearer ${apiKey}` },
      );
      const response2 = await worker.fetch(request2, testEnv, ctx);
      expect(response2.status).toBe(400);

      const request3 = buildRequest("POST", "/v1/revenue/log", {}, { Authorization: `Bearer ${apiKey}` });
      const response3 = await worker.fetch(request3, testEnv, ctx);
      expect(response3.status).toBe(400);
    });

    it("defaults optional fields when not provided", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest(
        "POST",
        "/v1/revenue/log",
        {
          poolAddress: "5JvD1TW5nqSz6gJtHfVnZKq3fZmBnL5xY7u9dR2wT4k",
          platformFeeX: 0.5,
          platformFeeY: 0.8,
        },
        { Authorization: `Bearer ${apiKey}` },
      );
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(200);

      const body = (await response.json()) as { id: string };
      const rows = await env.DB.prepare(
        "SELECT fee_x, fee_y, tier, user_id FROM revenue_events WHERE id = ?",
      )
        .bind(body.id)
        .all();
      const results = rows.results ?? [];
      expect(results).toHaveLength(1);
      const row = results[0] as Record<string, unknown>;
      expect(row.fee_x).toBe(0);
      expect(row.fee_y).toBe(0);
      expect(row.tier).toBe("free");
      expect(row.user_id).toBe(userId);
    });
  });

  // ── GET /v1/revenue ─────────────────────────────────────────────────────

  describe("GET /v1/revenue", () => {
    it("returns 401 without admin key", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("GET", "/v1/revenue");
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(401);
    });

    it("returns revenue stats for admin", async () => {
      // Seed test data
      await env.DB.prepare(
        `INSERT INTO revenue_events (id, pool_address, platform_fee_x, platform_fee_y, tier, user_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind("rev-1", "PoolA", 1.0, 2.0, "free", "user-1")
        .run();
      await env.DB.prepare(
        `INSERT INTO revenue_events (id, pool_address, platform_fee_x, platform_fee_y, tier, user_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind("rev-2", "PoolA", 3.0, 4.0, "pro", "user-2")
        .run();
      await env.DB.prepare(
        `INSERT INTO revenue_events (id, pool_address, platform_fee_x, platform_fee_y, tier, user_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind("rev-3", "PoolB", 5.0, 6.0, "pro", "user-3")
        .run();

      const ctx = createExecutionContext();
      const request = withAdmin(buildRequest("GET", "/v1/revenue"));
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        total: number;
        byTier: Array<{ tier: string; count: number; totalFee: number }>;
        recent: Array<{ id: string; pool_address: string }>;
      };
      expect(body.total).toBe(3);
      expect(body.byTier).toHaveLength(2);
      expect(body.recent.length).toBe(3);
    });
  });
});
