import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker, { type Env } from "./index";
import { applyMigration } from "./migration-helper";

const testEnv = env as unknown as Env;
let apiKey = "";
let userId = "";

function buildRequest(method: string, path: string, body?: unknown, token?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token ?? apiKey) headers.Authorization = `Bearer ${token ?? apiKey}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return new Request(`https://example.com${path}`, init);
}

describe("Install Telemetry API", () => {
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
      `CREATE TABLE IF NOT EXISTS installs (
        id TEXT PRIMARY KEY,
        install_id TEXT NOT NULL,
        event TEXT NOT NULL,
        version TEXT,
        channel TEXT,
        platform TEXT,
        user_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
    ).run();
    await applyMigration(env.DB, "0015_telemetry_summaries.sql");
    await env.DB.prepare("DELETE FROM api_keys").run();
    await env.DB.prepare("DELETE FROM users").run();
    await env.DB.prepare("DELETE FROM rate_limits").run();
    await env.CACHE.delete("rate_limit:register:unknown");
    const response = await worker.fetch(
      buildRequest("POST", "/v1/register", {}, ""),
      testEnv,
      createExecutionContext(),
    );
    const body = (await response.json()) as { api_key: string; user_id: string };
    apiKey = body.api_key;
    userId = body.user_id;
  });

  describe("POST /v1/installs/ping", () => {
    beforeEach(async () => {
      await env.DB.prepare("DELETE FROM installs").run();
      await env.DB.prepare("DELETE FROM install_event_summary").run();
    });

    it("returns 200 with id on valid install ping", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("POST", "/v1/installs/ping", {
        installId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        event: "install",
        version: "0.0.3",
        channel: "stable",
        platform: "darwin",
      });
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { id: string };
      expect(body.id).toBeTruthy();
    });

    it("returns 200 when userId is provided (registered agent)", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("POST", "/v1/installs/ping", {
        installId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        event: "register",
        version: "0.0.3",
        userId: "user-abc-123",
      });
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(200);
    });

    it("stores user_id when provided", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("POST", "/v1/installs/ping", {
        installId: "user-id-test-install-aaaa",
        event: "setup",
        userId: "user-xyz-456",
      });
      await worker.fetch(request, testEnv, ctx);

      const rows = await env.DB.prepare(
        "SELECT user_id FROM install_event_summary WHERE install_id = ?",
      )
        .bind("user-id-test-install-aaaa")
        .all();
      const results = rows.results ?? [];
      expect(results).toHaveLength(1);
      const row = results[0] as Record<string, unknown>;
      expect(row.user_id).toBe(userId);
    });

    it("accepts all four valid events", async () => {
      const events = ["install", "setup", "dev_start", "register"];
      for (const event of events) {
        const ctx = createExecutionContext();
        const request = buildRequest("POST", "/v1/installs/ping", {
          installId: `install-${event}-unique-aaaa`,
          event,
        });
        const response = await worker.fetch(request, testEnv, ctx);
        expect(response.status).toBe(200);
      }
    });

    it("returns 400 when installId is missing", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("POST", "/v1/installs/ping", {
        event: "install",
      });
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(400);
    });

    it("returns 400 when installId is too short", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("POST", "/v1/installs/ping", {
        installId: "short",
        event: "install",
      });
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(400);
    });

    it("returns 400 when event is missing", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("POST", "/v1/installs/ping", {
        installId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      });
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(400);
    });

    it("returns 400 when event is not in the allowed enum", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("POST", "/v1/installs/ping", {
        installId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        event: "unknown_event",
      });
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(400);
    });

    it("stores the ping so it can be queried back", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("POST", "/v1/installs/ping", {
        installId: "persist-test-install-id-aaaaaaaa",
        event: "setup",
        version: "0.0.3",
        channel: "stable",
        platform: "linux",
      });
      await worker.fetch(request, testEnv, ctx);

      const rows = await env.DB.prepare(
        "SELECT install_id, event, version, channel, platform FROM install_event_summary WHERE install_id = ?",
      )
        .bind("persist-test-install-id-aaaaaaaa")
        .all();
      const results = rows.results ?? [];
      expect(results).toHaveLength(1);
      const row = results[0] as Record<string, unknown>;
      expect(row.event).toBe("setup");
      expect(row.version).toBe("0.0.3");
      expect(row.channel).toBe("stable");
      expect(row.platform).toBe("linux");
    });

    it("summarizes repeated pings instead of inserting duplicate rows", async () => {
      const payload = {
        installId: "summary-test-install-aaaa",
        event: "dev_start",
        version: "0.0.3",
        channel: "stable",
        platform: "linux",
      };
      await worker.fetch(
        buildRequest("POST", "/v1/installs/ping", payload),
        testEnv,
        createExecutionContext(),
      );
      await worker.fetch(
        buildRequest("POST", "/v1/installs/ping", payload),
        testEnv,
        createExecutionContext(),
      );
      const row = await env.DB.prepare(
        "SELECT occurrence_count, COUNT(*) as rows FROM install_event_summary WHERE install_id = ? AND event = ?",
      )
        .bind(payload.installId, payload.event)
        .first<{ occurrence_count: number; rows: number }>();
      expect(row?.occurrence_count).toBe(2);
      expect(row?.rows).toBe(1);
    });

    it("keeps known metadata when a later ping omits it", async () => {
      const installId = "summary-partial-install-aaaa";
      const full = {
        installId,
        event: "dev_start",
        version: "0.0.3",
        channel: "stable",
        platform: "linux",
      };
      await worker.fetch(
        buildRequest("POST", "/v1/installs/ping", full),
        testEnv,
        createExecutionContext(),
      );
      await worker.fetch(
        buildRequest("POST", "/v1/installs/ping", { installId, event: "dev_start" }),
        testEnv,
        createExecutionContext(),
      );
      const row = await env.DB.prepare(
        "SELECT version, channel, platform FROM install_event_summary WHERE install_id = ? AND event = ?",
      )
        .bind(installId, "dev_start")
        .first<{ version: string | null; channel: string | null; platform: string | null }>();
      expect(row?.version).toBe("0.0.3");
      expect(row?.channel).toBe("stable");
      expect(row?.platform).toBe("linux");
    });
  });
});
