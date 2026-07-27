import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker, { type Env } from "./index";

const testEnv = env as unknown as Env;
let apiKey = "";
let userId = "";

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

describe("Auth routes (login / whoami)", () => {
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
    await env.DB.prepare("DELETE FROM subscriptions").run();
    await env.DB.prepare("DELETE FROM api_keys").run();
    await env.DB.prepare("DELETE FROM users").run();
    await env.CACHE.delete("rate_limit:register:unknown");

    const response = await worker.fetch(
      buildRequest("POST", "/v1/register", {}),
      testEnv,
      createExecutionContext(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { user_id: string; api_key: string };
    userId = body.user_id;
    apiKey = body.api_key;
  });

  beforeEach(async () => {
    // Reset the key usage stamp so each test can observe the login side effect.
    await env.DB.prepare("UPDATE api_keys SET last_used_at = NULL").run();
  });

  describe("POST /v1/login", () => {
    it("returns the user record for a valid API key", async () => {
      const response = await worker.fetch(
        buildRequest("POST", "/v1/login", {}, { Authorization: `Bearer ${apiKey}` }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        id: string;
        tier: string;
        telegram_id: string | null;
        created_at: string;
      };
      expect(body.id).toBe(userId);
      expect(body.tier).toBe("free");
      expect(body.telegram_id).toBeNull();
      expect(body.created_at).toBeTruthy();
    });

    it("returns 401 when no API key is provided", async () => {
      const response = await worker.fetch(
        buildRequest("POST", "/v1/login", {}),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("API key required");
    });

    it("returns 401 for an unknown API key", async () => {
      const response = await worker.fetch(
        buildRequest(
          "POST",
          "/v1/login",
          {},
          { Authorization: "Bearer sk-prism-unknown-key" },
        ),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("Invalid API key");
    });

    it("stamps last_used_at on the key row after a successful login", async () => {
      const before = await env.DB.prepare("SELECT last_used_at FROM api_keys WHERE user_id = ?")
        .bind(userId)
        .first();
      expect(before?.last_used_at).toBeFalsy();

      const response = await worker.fetch(
        buildRequest("POST", "/v1/login", {}, { Authorization: `Bearer ${apiKey}` }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);

      const after = await env.DB.prepare("SELECT last_used_at FROM api_keys WHERE user_id = ?")
        .bind(userId)
        .first();
      expect(after?.last_used_at).toBeTruthy();
    });
  });

  describe("GET /v1/whoami", () => {
    it("returns the authenticated user's record", async () => {
      const response = await worker.fetch(
        buildRequest("GET", "/v1/whoami", undefined, { Authorization: `Bearer ${apiKey}` }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        id: string;
        tier: string;
        telegram_id: string | null;
        created_at: string;
      };
      expect(body.id).toBe(userId);
      expect(body.tier).toBe("free");
      expect(body.telegram_id).toBeNull();
      expect(body.created_at).toBeTruthy();
    });

    it("returns 401 when no API key is provided", async () => {
      const response = await worker.fetch(
        buildRequest("GET", "/v1/whoami"),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("API key required");
    });

    it("returns 401 for an unknown API key", async () => {
      const response = await worker.fetch(
        buildRequest("GET", "/v1/whoami", undefined, {
          Authorization: "Bearer sk-prism-unknown-key",
        }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("Unauthorized");
    });
  });
});
