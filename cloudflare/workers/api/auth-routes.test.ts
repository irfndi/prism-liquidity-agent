import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker, { type Env } from "./index";
import { buildRequest, clearRegisterRateLimit, setupCommonSchema } from "./test-utils";

const testEnv = env as unknown as Env;
let apiKey = "";
let userId = "";

describe("Auth routes (login / whoami)", () => {
  beforeAll(async () => {
    await setupCommonSchema(env.DB);
    await clearRegisterRateLimit(env.CACHE);

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
