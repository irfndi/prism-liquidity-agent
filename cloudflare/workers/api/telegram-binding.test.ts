import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker, { type Env } from "./index";
import { buildRequest, setupCommonSchema } from "./test-utils";

// Shared bot secret for bot-authenticated endpoints (X-Bot-Api-Secret header).
const BOT_SECRET = "test-bot-api-secret";
const testEnv = { ...env, BOT_API_SECRET: BOT_SECRET } as unknown as Env;
// Environment without the secret configured — endpoints must fail closed.
const noSecretEnv = env as unknown as Env;

function withBotSecret(req: Request, secret: string = BOT_SECRET): Request {
  return new Request(req.url, {
    method: req.method,
    headers: { ...Object.fromEntries(req.headers), "X-Bot-Api-Secret": secret },
    body: req.body,
  });
}

async function insertUser(id: string, telegramId?: string): Promise<void> {
  await env.DB.prepare("INSERT INTO users (id, tier, telegram_id) VALUES (?, ?, ?)")
    .bind(id, "free", telegramId ?? null)
    .run();
}

describe("Telegram binding routes", () => {
  beforeAll(async () => {
    await setupCommonSchema(env.DB);
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
    await env.DB.prepare("DELETE FROM subscriptions").run();
    await env.DB.prepare("DELETE FROM audit_log").run();
    await env.DB.prepare("DELETE FROM audit_event_summary").run();
    await env.DB.prepare("DELETE FROM api_keys").run();
    await env.DB.prepare("DELETE FROM users").run();
    await env.DB.prepare("DELETE FROM rate_limits").run();
    await env.CACHE.delete("rate_limit:register_telegram:unknown");
  });

  describe("POST /v1/register-telegram", () => {
    it("registers a new telegram user with the bot secret", async () => {
      const res = await worker.fetch(
        withBotSecret(
          buildRequest("POST", "/v1/register-telegram", {
            telegram_id: "900001",
            first_name: "Test",
          }),
        ),
        testEnv,
        createExecutionContext(),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { user_id: string; api_key: string; tier: string };
      expect(body.api_key).toMatch(/^sk-prism-/);
      expect(body.tier).toBe("free");

      const user = await env.DB.prepare("SELECT telegram_id, tier FROM users WHERE id = ?")
        .bind(body.user_id)
        .first();
      expect(user?.telegram_id).toBe("900001");
      expect(user?.tier).toBe("free");

      const key = await env.DB.prepare("SELECT user_id FROM api_keys WHERE user_id = ?")
        .bind(body.user_id)
        .first();
      expect(key?.user_id).toBe(body.user_id);

      const sub = await env.DB.prepare("SELECT tier FROM subscriptions WHERE user_id = ?")
        .bind(body.user_id)
        .first();
      expect(sub?.tier).toBe("free");
    });

    it("rejects the request without the bot secret header", async () => {
      const res = await worker.fetch(
        buildRequest("POST", "/v1/register-telegram", { telegram_id: "900002" }),
        testEnv,
        createExecutionContext(),
      );
      expect([401, 403]).toContain(res.status);
    });

    it("rejects a wrong bot secret", async () => {
      const res = await worker.fetch(
        withBotSecret(
          buildRequest("POST", "/v1/register-telegram", { telegram_id: "900003" }),
          "wrong-secret",
        ),
        testEnv,
        createExecutionContext(),
      );
      expect([401, 403]).toContain(res.status);
    });

    it("fails closed when the server has no BOT_API_SECRET configured", async () => {
      const res = await worker.fetch(
        withBotSecret(buildRequest("POST", "/v1/register-telegram", { telegram_id: "900004" })),
        noSecretEnv,
        createExecutionContext(),
      );
      expect([401, 403]).toContain(res.status);
    });

    it("returns 400 when telegram_id is missing", async () => {
      const res = await worker.fetch(
        withBotSecret(buildRequest("POST", "/v1/register-telegram", {})),
        testEnv,
        createExecutionContext(),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("telegram_id required");
    });

    it("returns 400 for a non-numeric telegram_id", async () => {
      const res = await worker.fetch(
        withBotSecret(buildRequest("POST", "/v1/register-telegram", { telegram_id: "not-123" })),
        testEnv,
        createExecutionContext(),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/invalid telegram_id/i);
    });

    it("returns 409 when the telegram account is already registered", async () => {
      const first = await worker.fetch(
        withBotSecret(buildRequest("POST", "/v1/register-telegram", { telegram_id: "900005" })),
        testEnv,
        createExecutionContext(),
      );
      expect(first.status).toBe(200);

      const second = await worker.fetch(
        withBotSecret(buildRequest("POST", "/v1/register-telegram", { telegram_id: "900005" })),
        testEnv,
        createExecutionContext(),
      );
      expect(second.status).toBe(409);
      const body = (await second.json()) as { error: string };
      expect(body.error).toMatch(/already registered/i);
    });

    it("rate-limits registrations per IP (5/hour)", async () => {
      for (let i = 1; i <= 5; i++) {
        const res = await worker.fetch(
          withBotSecret(
            buildRequest("POST", "/v1/register-telegram", { telegram_id: `91000${i}` }),
          ),
          testEnv,
          createExecutionContext(),
        );
        expect(res.status).toBe(200);
      }

      const sixth = await worker.fetch(
        withBotSecret(buildRequest("POST", "/v1/register-telegram", { telegram_id: "910006" })),
        testEnv,
        createExecutionContext(),
      );
      expect(sixth.status).toBe(429);
      const body = (await sixth.json()) as { error: string };
      expect(body.error).toMatch(/rate limit/i);
    });
  });

  describe("POST /v1/whoami-telegram", () => {
    it("rejects the request without the bot secret header", async () => {
      const res = await worker.fetch(
        buildRequest("POST", "/v1/whoami-telegram", { telegram_id: "900100" }),
        testEnv,
        createExecutionContext(),
      );
      expect([401, 403]).toContain(res.status);
    });

    it("fails closed when the server has no BOT_API_SECRET configured", async () => {
      const res = await worker.fetch(
        withBotSecret(buildRequest("POST", "/v1/whoami-telegram", { telegram_id: "900100" })),
        noSecretEnv,
        createExecutionContext(),
      );
      expect([401, 403]).toContain(res.status);
    });

    it("returns 400 when telegram_id is missing", async () => {
      const res = await worker.fetch(
        withBotSecret(buildRequest("POST", "/v1/whoami-telegram", {})),
        testEnv,
        createExecutionContext(),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("telegram_id required");
    });

    it("returns 400 for a non-numeric telegram_id", async () => {
      const res = await worker.fetch(
        withBotSecret(buildRequest("POST", "/v1/whoami-telegram", { telegram_id: "abc" })),
        testEnv,
        createExecutionContext(),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/invalid telegram_id/i);
    });

    it("returns 404 for an unknown telegram_id", async () => {
      const res = await worker.fetch(
        withBotSecret(buildRequest("POST", "/v1/whoami-telegram", { telegram_id: "999999" })),
        testEnv,
        createExecutionContext(),
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("User not found");
    });

    it("returns the user record for a linked telegram_id", async () => {
      await insertUser("wt-user", "900100");
      const res = await worker.fetch(
        withBotSecret(buildRequest("POST", "/v1/whoami-telegram", { telegram_id: "900100" })),
        testEnv,
        createExecutionContext(),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        user_id: string;
        tier: string;
        telegram_id: string;
        created_at: string;
      };
      expect(body.user_id).toBe("wt-user");
      expect(body.tier).toBe("free");
      expect(body.telegram_id).toBe("900100");
      expect(body.created_at).toBeTruthy();
    });
  });

  describe("POST /v1/agent-status", () => {
    it("rejects the request without the bot secret header", async () => {
      const res = await worker.fetch(
        buildRequest("POST", "/v1/agent-status", { telegram_id: "900200" }),
        testEnv,
        createExecutionContext(),
      );
      expect([401, 403]).toContain(res.status);
    });

    it("fails closed when the server has no BOT_API_SECRET configured", async () => {
      const res = await worker.fetch(
        withBotSecret(buildRequest("POST", "/v1/agent-status", { telegram_id: "900200" })),
        noSecretEnv,
        createExecutionContext(),
      );
      expect([401, 403]).toContain(res.status);
    });

    it("returns 400 when telegram_id is missing", async () => {
      const res = await worker.fetch(
        withBotSecret(buildRequest("POST", "/v1/agent-status", {})),
        testEnv,
        createExecutionContext(),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("telegram_id required");
    });

    it("returns 404 for an unknown telegram user", async () => {
      const res = await worker.fetch(
        withBotSecret(buildRequest("POST", "/v1/agent-status", { telegram_id: "999999" })),
        testEnv,
        createExecutionContext(),
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("User not found");
    });

    it("returns the placeholder running status for a linked user", async () => {
      await insertUser("as-user", "900200");
      const res = await worker.fetch(
        withBotSecret(buildRequest("POST", "/v1/agent-status", { telegram_id: "900200" })),
        testEnv,
        createExecutionContext(),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; positions: number; pnl: number };
      expect(body.status).toBe("not_running");
      expect(body.positions).toBe(0);
      expect(body.pnl).toBe(0);
    });
  });
});
