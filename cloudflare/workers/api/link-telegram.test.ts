import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker, { type Env } from "./index";

// Shared bot secret for bot-authenticated endpoints (X-Bot-Api-Secret header).
const BOT_SECRET = "test-bot-api-secret";
const testEnv = { ...env, BOT_API_SECRET: BOT_SECRET } as unknown as Env;
// Environment without the secret configured — endpoints must fail closed.
const noSecretEnv = env as unknown as Env;

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

function withBotSecret(req: Request, secret: string = BOT_SECRET): Request {
  return new Request(req.url, {
    method: req.method,
    headers: { ...Object.fromEntries(req.headers), "X-Bot-Api-Secret": secret },
    body: req.body,
  });
}

const nowEpoch = () => Math.floor(Date.now() / 1000);

async function insertUser(id: string, telegramId?: string): Promise<void> {
  await env.DB.prepare("INSERT INTO users (id, tier, telegram_id) VALUES (?, ?, ?)")
    .bind(id, "free", telegramId ?? null)
    .run();
}

async function insertCode(
  code: string,
  userId: string,
  expiresAtEpoch: number,
  attempts = 0,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO telegram_link_codes (code, user_id, expires_at, attempts) VALUES (?, ?, ?, ?)",
  )
    .bind(code, userId, expiresAtEpoch, attempts)
    .run();
}

describe("Telegram linking security", () => {
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
    // New schema: unixepoch expiry + per-code attempt counter (migration 0012).
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS telegram_link_codes (
        code TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at DATETIME,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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
    await env.DB.prepare("DELETE FROM telegram_link_codes").run();
    await env.DB.prepare("DELETE FROM subscriptions").run();
    await env.DB.prepare("DELETE FROM audit_log").run();
    await env.DB.prepare("DELETE FROM audit_event_summary").run();
    await env.DB.prepare("DELETE FROM api_keys").run();
    await env.DB.prepare("DELETE FROM users").run();
    await env.CACHE.delete("rate_limit:link_confirm:unknown");
    await env.CACHE.delete("rate_limit:register:unknown");
    await env.CACHE.delete("rate_limit:register_telegram:unknown");
  });

  describe("POST /v1/link-telegram/confirm", () => {
    it("confirms a valid unexpired code and binds the telegram_id", async () => {
      await insertUser("user-1");
      await insertCode("LINK-VALID1", "user-1", nowEpoch() + 600);

      const response = await worker.fetch(
        buildRequest("POST", "/v1/link-telegram/confirm", {
          code: "LINK-VALID1",
          telegram_id: "123456789",
        }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { success: boolean; user_id: string };
      expect(body.success).toBe(true);
      expect(body.user_id).toBe("user-1");

      const user = await env.DB.prepare("SELECT telegram_id FROM users WHERE id = ?")
        .bind("user-1")
        .first();
      expect(user?.telegram_id).toBe("123456789");
    });

    it("rejects an expired code (unixepoch comparison)", async () => {
      await insertUser("user-1");
      // Expired 10 minutes ago — must be rejected even though SQLite text
      // comparison would previously keep ISO strings valid for ~24h.
      await insertCode("LINK-EXPIRED", "user-1", nowEpoch() - 600);

      const response = await worker.fetch(
        buildRequest("POST", "/v1/link-telegram/confirm", {
          code: "LINK-EXPIRED",
          telegram_id: "123456789",
        }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/expired/i);
    });

    it("rejects an unknown code", async () => {
      const response = await worker.fetch(
        buildRequest("POST", "/v1/link-telegram/confirm", {
          code: "LINK-NOSUCHCODE",
          telegram_id: "123456789",
        }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/invalid code/i);
    });

    it("burns a code after 5 attempts (6th attempt rejected)", async () => {
      await insertUser("user-1");
      await insertCode("LINK-BURN01", "user-1", nowEpoch() + 600);

      // Attempt 1 succeeds and marks the code used; attempts 2-5 hit
      // "already used" but still count toward the strike limit.
      for (let i = 0; i < 5; i++) {
        const res = await worker.fetch(
          buildRequest("POST", "/v1/link-telegram/confirm", {
            code: "LINK-BURN01",
            telegram_id: "123456789",
          }),
          testEnv,
          createExecutionContext(),
        );
        expect([200, 400]).toContain(res.status);
      }

      const sixth = await worker.fetch(
        buildRequest("POST", "/v1/link-telegram/confirm", {
          code: "LINK-BURN01",
          telegram_id: "123456789",
        }),
        testEnv,
        createExecutionContext(),
      );
      expect(sixth.status).toBe(429);
    });

    it("rate-limits confirm attempts per IP (10/hour)", async () => {
      // 10 attempts with distinct unknown codes are all counted.
      for (let i = 0; i < 10; i++) {
        const res = await worker.fetch(
          buildRequest("POST", "/v1/link-telegram/confirm", {
            code: `LINK-GUESS${String(i).padStart(2, "0")}`,
            telegram_id: "123456789",
          }),
          testEnv,
          createExecutionContext(),
        );
        expect(res.status).toBe(400);
      }

      const eleventh = await worker.fetch(
        buildRequest("POST", "/v1/link-telegram/confirm", {
          code: "LINK-GUESS11",
          telegram_id: "123456789",
        }),
        testEnv,
        createExecutionContext(),
      );
      expect(eleventh.status).toBe(429);
    });
  });

  describe("POST /v1/link-telegram/start", () => {
    async function registerCliUser(): Promise<{ apiKey: string; userId: string }> {
      const res = await worker.fetch(
        buildRequest("POST", "/v1/register", {}),
        testEnv,
        createExecutionContext(),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { user_id: string; api_key: string };
      return { apiKey: body.api_key, userId: body.user_id };
    }

    it("issues a high-entropy code (LINK- + 16 hex chars) with ISO expiresAt", async () => {
      const { apiKey } = await registerCliUser();
      const res = await worker.fetch(
        buildRequest("POST", "/v1/link-telegram/start", {}, {
          Authorization: `Bearer ${apiKey}`,
        }),
        testEnv,
        createExecutionContext(),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { code: string; expiresAt: string };
      expect(body.code).toMatch(/^LINK-[0-9A-F]{16}$/);
      // CLI parses expiresAt with new Date() — keep it an ISO string.
      expect(Number.isNaN(new Date(body.expiresAt).getTime())).toBe(false);
    });

    it("invalidates outstanding codes when a new code is requested", async () => {
      const { apiKey } = await registerCliUser();

      const first = await worker.fetch(
        buildRequest("POST", "/v1/link-telegram/start", {}, {
          Authorization: `Bearer ${apiKey}`,
        }),
        testEnv,
        createExecutionContext(),
      );
      const firstBody = (await first.json()) as { code: string };

      const second = await worker.fetch(
        buildRequest("POST", "/v1/link-telegram/start", {}, {
          Authorization: `Bearer ${apiKey}`,
        }),
        testEnv,
        createExecutionContext(),
      );
      const secondBody = (await second.json()) as { code: string };
      expect(secondBody.code).not.toBe(firstBody.code);

      // The first code must no longer be linkable.
      const confirmFirst = await worker.fetch(
        buildRequest("POST", "/v1/link-telegram/confirm", {
          code: firstBody.code,
          telegram_id: "123456789",
        }),
        testEnv,
        createExecutionContext(),
      );
      expect(confirmFirst.status).toBe(400);

      // The second code still works.
      const confirmSecond = await worker.fetch(
        buildRequest("POST", "/v1/link-telegram/confirm", {
          code: secondBody.code,
          telegram_id: "123456789",
        }),
        testEnv,
        createExecutionContext(),
      );
      expect(confirmSecond.status).toBe(200);
    });
  });

  describe("bot-secret authentication (X-Bot-Api-Secret)", () => {
    it("rejects /v1/register-telegram without the bot secret", async () => {
      const res = await worker.fetch(
        buildRequest("POST", "/v1/register-telegram", { telegram_id: "111" }),
        testEnv,
        createExecutionContext(),
      );
      expect([401, 403]).toContain(res.status);
    });

    it("rejects /v1/register-telegram with a wrong bot secret", async () => {
      const res = await worker.fetch(
        withBotSecret(
          buildRequest("POST", "/v1/register-telegram", { telegram_id: "111" }),
          "wrong-secret",
        ),
        testEnv,
        createExecutionContext(),
      );
      expect([401, 403]).toContain(res.status);
    });

    it("accepts /v1/register-telegram with the bot secret", async () => {
      const res = await worker.fetch(
        withBotSecret(buildRequest("POST", "/v1/register-telegram", {
          telegram_id: "111",
          first_name: "Test",
        })),
        testEnv,
        createExecutionContext(),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { user_id: string; api_key: string };
      expect(body.api_key).toMatch(/^sk-prism-/);
    });

    it("fails closed when the server has no BOT_API_SECRET configured", async () => {
      const res = await worker.fetch(
        withBotSecret(buildRequest("POST", "/v1/register-telegram", { telegram_id: "111" })),
        noSecretEnv,
        createExecutionContext(),
      );
      expect([401, 403]).toContain(res.status);
    });

    it("rejects /v1/whoami-telegram without the bot secret", async () => {
      await insertUser("user-1", "222");
      const res = await worker.fetch(
        buildRequest("POST", "/v1/whoami-telegram", { telegram_id: "222" }),
        testEnv,
        createExecutionContext(),
      );
      expect([401, 403]).toContain(res.status);
    });

    it("serves /v1/whoami-telegram with the bot secret", async () => {
      await insertUser("user-1", "222");
      const res = await worker.fetch(
        withBotSecret(buildRequest("POST", "/v1/whoami-telegram", { telegram_id: "222" })),
        testEnv,
        createExecutionContext(),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { user_id: string };
      expect(body.user_id).toBe("user-1");
    });

    it("rejects /v1/agent-status without the bot secret", async () => {
      await insertUser("user-1", "333");
      const res = await worker.fetch(
        buildRequest("POST", "/v1/agent-status", { telegram_id: "333" }),
        testEnv,
        createExecutionContext(),
      );
      expect([401, 403]).toContain(res.status);
    });

    it("serves /v1/agent-status with the bot secret", async () => {
      await insertUser("user-1", "333");
      const res = await worker.fetch(
        withBotSecret(buildRequest("POST", "/v1/agent-status", { telegram_id: "333" })),
        testEnv,
        createExecutionContext(),
      );
      expect(res.status).toBe(200);
    });

    it("rejects /v1/register telegram binding without the bot secret", async () => {
      const res = await worker.fetch(
        buildRequest("POST", "/v1/register", { telegram_id: "444" }),
        testEnv,
        createExecutionContext(),
      );
      expect([401, 403]).toContain(res.status);
    });

    it("binds telegram_id on /v1/register with the bot secret", async () => {
      const res = await worker.fetch(
        withBotSecret(buildRequest("POST", "/v1/register", { telegram_id: "444" })),
        testEnv,
        createExecutionContext(),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { user_id: string };
      const user = await env.DB.prepare("SELECT telegram_id FROM users WHERE id = ?")
        .bind(body.user_id)
        .first();
      expect(user?.telegram_id).toBe("444");
    });

    it("keeps plain CLI /v1/register working without the bot secret", async () => {
      const res = await worker.fetch(
        buildRequest("POST", "/v1/register", {}),
        testEnv,
        createExecutionContext(),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { api_key: string };
      expect(body.api_key).toMatch(/^sk-prism-/);
    });
  });

  describe("API key entropy", () => {
    it("generates API keys with at least 128 bits of CSPRNG entropy", async () => {
      const res = await worker.fetch(
        buildRequest("POST", "/v1/register", {}),
        testEnv,
        createExecutionContext(),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { api_key: string };
      // sk-prism- + 40 base36 chars from 20 random bytes (~160 bits).
      expect(body.api_key.length).toBeGreaterThanOrEqual(9 + 32);
      expect(body.api_key).toMatch(/^sk-prism-[a-z0-9]+$/);
    });
  });
});
