import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker, { type Env } from "./index";

const BOT_SECRET = "test-bot-api-secret";
const BOT_URL = "https://bot.example.com";
const testEnv = {
  ...env,
  BOT_API_SECRET: BOT_SECRET,
  TELEGRAM_BOT_URL: BOT_URL,
} as unknown as Env;

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

function authed(path: string, body: unknown, apiKey: string): Request {
  return buildRequest("POST", path, body, { Authorization: `Bearer ${apiKey}` });
}

function withBotSecret(req: Request, secret: string = BOT_SECRET): Request {
  return new Request(req.url, {
    method: req.method,
    headers: { ...Object.fromEntries(req.headers), "X-Bot-Api-Secret": secret },
    body: req.body,
  });
}

const VALID_ALERT = {
  type: "position_out_of_range",
  severity: "critical",
  message: "Position out of range on SOL/USDC",
  poolAddress: "Pool1111111111111111111111111111111111111",
} as const;

describe("Alerts API", () => {
  let apiKey = "";
  let userId = "";

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
    // Migration 0013 adds the preference flag; existing test tables predate it.
    await env.DB.prepare("ALTER TABLE users ADD COLUMN alerts_enabled INTEGER NOT NULL DEFAULT 1")
      .run()
      .catch(() => {});
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
      `CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        pool_address TEXT,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        data TEXT,
        delivered_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
    ).run();

    await env.DB.prepare("DELETE FROM api_keys").run();
    await env.DB.prepare("DELETE FROM users").run();
    await env.DB.prepare("DELETE FROM rate_limits").run();
    await env.CACHE.delete("rate_limit:register:unknown");
    const response = await worker.fetch(
      buildRequest("POST", "/v1/register", {}),
      testEnv,
      createExecutionContext(),
    );
    const body = (await response.json()) as { api_key: string; user_id: string };
    apiKey = body.api_key;
    userId = body.user_id;
  });

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM alerts").run();
    await env.DB.prepare("DELETE FROM rate_limits").run();
    if (userId) {
      await env.DB.prepare("UPDATE users SET telegram_id = NULL, alerts_enabled = 1 WHERE id = ?")
        .bind(userId)
        .run();
      await env.CACHE.delete(`rate_limit:alerts:${userId}`);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("POST /v1/alerts — auth", () => {
    it("rejects requests without an API key (401)", async () => {
      const response = await worker.fetch(
        buildRequest("POST", "/v1/alerts", VALID_ALERT),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(401);
    });

    it("rejects requests with an invalid API key (401)", async () => {
      const response = await worker.fetch(
        authed("/v1/alerts", VALID_ALERT, "sk-prism-not-a-real-key"),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(401);
    });
  });

  describe("POST /v1/alerts — validation", () => {
    it("rejects an unknown alert type (400)", async () => {
      const response = await worker.fetch(
        authed("/v1/alerts", { ...VALID_ALERT, type: "moon_shot" }, apiKey),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(400);
    });

    it("rejects an unknown severity (400)", async () => {
      const response = await worker.fetch(
        authed("/v1/alerts", { ...VALID_ALERT, severity: "fatal" }, apiKey),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(400);
    });

    it("rejects a missing message (400)", async () => {
      const response = await worker.fetch(
        authed("/v1/alerts", { type: VALID_ALERT.type, severity: VALID_ALERT.severity }, apiKey),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(400);
    });

    it("rejects an over-long message (400)", async () => {
      const response = await worker.fetch(
        authed("/v1/alerts", { ...VALID_ALERT, message: "x".repeat(1001) }, apiKey),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(400);
    });
  });

  describe("POST /v1/alerts — storage", () => {
    // Delivery is the bot's job now (it polls D1 via /internal/flush-alerts,
    // driven by a GHA cron). The API only stores: delivered is always false at
    // POST time and fetch must NEVER be called to the bot URL (error 1042).
    it("stores a valid alert, returns delivered:false, and does not forward", async () => {
      await env.DB.prepare("UPDATE users SET telegram_id = ? WHERE id = ?")
        .bind("555777", userId)
        .run();
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const response = await worker.fetch(
        authed("/v1/alerts", VALID_ALERT, apiKey),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { id: string; delivered: boolean };
      expect(body.id).toBeTruthy();
      expect(body.delivered).toBe(false);

      // Stored in D1 with delivered_at still NULL (the cron marks it later).
      const row = await env.DB.prepare(
        "SELECT type, severity, message, pool_address, delivered_at FROM alerts WHERE id = ?",
      )
        .bind(body.id)
        .first();
      expect(row?.type).toBe("position_out_of_range");
      expect(row?.severity).toBe("critical");
      expect(row?.message).toBe(VALID_ALERT.message);
      expect(row?.pool_address).toBe(VALID_ALERT.poolAddress);
      expect(row?.delivered_at).toBeNull();

      // No worker->worker forward: fetch is never invoked in the store path.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("stores without forwarding when the user has no telegram link", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const response = await worker.fetch(
        authed("/v1/alerts", VALID_ALERT, apiKey),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { id: string; delivered: boolean };
      expect(body.delivered).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();

      const row = await env.DB.prepare("SELECT id, delivered_at FROM alerts WHERE id = ?")
        .bind(body.id)
        .first();
      expect(row).not.toBeNull();
      expect(row?.delivered_at).toBeNull();
    });

    it("stores without forwarding when alerts_enabled = 0", async () => {
      await env.DB.prepare("UPDATE users SET telegram_id = ?, alerts_enabled = 0 WHERE id = ?")
        .bind("555777", userId)
        .run();
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const response = await worker.fetch(
        authed("/v1/alerts", VALID_ALERT, apiKey),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { delivered: boolean };
      expect(body.delivered).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();

      const count = await env.DB.prepare("SELECT COUNT(*) as n FROM alerts").first();
      expect(count?.n).toBe(1);
    });

    it("still stores (200, delivered:false) with no fetch even if a rejecting fetch mock is installed", async () => {
      await env.DB.prepare("UPDATE users SET telegram_id = ? WHERE id = ?")
        .bind("555777", userId)
        .run();
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("connection refused"));

      const response = await worker.fetch(
        authed("/v1/alerts", VALID_ALERT, apiKey),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { id: string; delivered: boolean };
      expect(body.delivered).toBe(false);
      // The store path never reaches fetch, so the rejecting mock is not hit.
      expect(fetchSpy).not.toHaveBeenCalled();

      const row = await env.DB.prepare("SELECT delivered_at FROM alerts WHERE id = ?")
        .bind(body.id)
        .first();
      expect(row?.delivered_at).toBeNull();
    });
  });

  describe("POST /v1/alerts — rate limiting", () => {
    it("allows 60 alerts/hour and rejects the 61st (429)", async () => {
      for (let i = 0; i < 60; i++) {
        const response = await worker.fetch(
          authed("/v1/alerts", { ...VALID_ALERT, message: `alert ${i}` }, apiKey),
          testEnv,
          createExecutionContext(),
        );
        expect(response.status).toBe(200);
      }
      const sixtyFirst = await worker.fetch(
        authed("/v1/alerts", VALID_ALERT, apiKey),
        testEnv,
        createExecutionContext(),
      );
      expect(sixtyFirst.status).toBe(429);
    });

    it("extends the window on accepted requests but not on rejected ones", async () => {
      // Seed a row one below the limit with a fresh window anchor (within the
      // hour) so the next request is accepted and slides the window forward.
      const anchor = Math.floor(Date.now() / 1000) - 3500;
      await env.DB.prepare(
        "INSERT INTO rate_limits (key, count, updated_at) VALUES (?, 59, ?)",
      )
        .bind(`rate_limit:alerts:${userId}`, anchor)
        .run();

      const accepted = await worker.fetch(
        authed("/v1/alerts", VALID_ALERT, apiKey),
        testEnv,
        createExecutionContext(),
      );
      expect(accepted.status).toBe(200);
      const afterAccepted = await env.DB.prepare(
        "SELECT count, updated_at FROM rate_limits WHERE key = ?",
      )
        .bind(`rate_limit:alerts:${userId}`)
        .first();
      expect(afterAccepted?.count).toBe(60);
      expect(Number(afterAccepted?.updated_at)).toBeGreaterThan(anchor);

      // The rejected request must not slide the window forward: updated_at
      // stays at the anchor set by the accepted request.
      const rejected = await worker.fetch(
        authed("/v1/alerts", VALID_ALERT, apiKey),
        testEnv,
        createExecutionContext(),
      );
      expect(rejected.status).toBe(429);
      const afterRejected = await env.DB.prepare(
        "SELECT count, updated_at FROM rate_limits WHERE key = ?",
      )
        .bind(`rate_limit:alerts:${userId}`)
        .first();
      expect(afterRejected?.count).toBe(61);
      expect(afterRejected?.updated_at).toBe(afterAccepted?.updated_at);
    });
  });

  describe("POST /v1/alerts/preferences", () => {
    it("rejects requests without the bot secret (401)", async () => {
      const response = await worker.fetch(
        buildRequest("POST", "/v1/alerts/preferences", { telegram_id: "555777", enabled: false }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(401);
    });

    it("rejects requests with a wrong bot secret (401)", async () => {
      const response = await worker.fetch(
        withBotSecret(
          buildRequest("POST", "/v1/alerts/preferences", {
            telegram_id: "555777",
            enabled: false,
          }),
          "wrong-secret",
        ),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(401);
    });

    it("toggles alerts_enabled for the linked user", async () => {
      await env.DB.prepare("UPDATE users SET telegram_id = ? WHERE id = ?")
        .bind("555777", userId)
        .run();

      const off = await worker.fetch(
        withBotSecret(
          buildRequest("POST", "/v1/alerts/preferences", {
            telegram_id: "555777",
            enabled: false,
          }),
        ),
        testEnv,
        createExecutionContext(),
      );
      expect(off.status).toBe(200);
      let row = await env.DB.prepare("SELECT alerts_enabled FROM users WHERE id = ?")
        .bind(userId)
        .first();
      expect(row?.alerts_enabled).toBe(0);

      const on = await worker.fetch(
        withBotSecret(
          buildRequest("POST", "/v1/alerts/preferences", {
            telegram_id: "555777",
            enabled: true,
          }),
        ),
        testEnv,
        createExecutionContext(),
      );
      expect(on.status).toBe(200);
      row = await env.DB.prepare("SELECT alerts_enabled FROM users WHERE id = ?")
        .bind(userId)
        .first();
      expect(row?.alerts_enabled).toBe(1);
    });

    it("returns 404 for an unknown telegram_id", async () => {
      const response = await worker.fetch(
        withBotSecret(
          buildRequest("POST", "/v1/alerts/preferences", {
            telegram_id: "999999999",
            enabled: false,
          }),
        ),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(404);
    });
  });
});
