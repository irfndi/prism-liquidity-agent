import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker, { type Env } from "./index";
import { applyMigration } from "./migration-helper";

const testEnv = env as unknown as Env;
let apiKey = "";
let userId = "";

function buildRequest(method: string, path: string, body?: unknown, token?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token ?? apiKey) {
    headers["Authorization"] = `Bearer ${token ?? apiKey}`;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return new Request(`https://example.com${path}`, init);
}

describe("Error Reporting API", () => {
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
      `CREATE TABLE IF NOT EXISTS error_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        agent_id TEXT,
        error_type TEXT NOT NULL,
        message TEXT NOT NULL,
        stack_trace TEXT,
        prism_version TEXT NOT NULL,
        platform TEXT,
        severity TEXT DEFAULT 'error',
        is_recoverable INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
    ).run();
    await applyMigration(env.DB, "0015_telemetry_summaries.sql");
    await env.DB.prepare(
      `CREATE INDEX IF NOT EXISTS idx_error_logs_agent_created ON error_logs(agent_id, created_at)`,
    ).run();
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

  describe("POST /v1/errors/report", () => {
    beforeEach(async () => {
      await env.DB.prepare("DELETE FROM error_logs").run();
      await env.DB.prepare("DELETE FROM error_report_receipts").run();
    });
    it("should return 200 with id on valid report", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("POST", "/v1/errors/report", {
        id: "test-uuid-1",
        agentId: "hashed-wallet-abc",
        errorType: "ONNX_BigInt",
        message: "BigInt serialization failed",
        stackTrace: "Error: BigInt...\n    at serialize (...)",
        prismVersion: "1.2.3",
        platform: "darwin",
        severity: "error",
        isRecoverable: 1,
      });
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { id: string };
      expect(body.id).toBe("test-uuid-1");
    });

    it("should return 400 when id is missing", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("POST", "/v1/errors/report", {
        agentId: "hashed-wallet-abc",
        errorType: "ONNX_BigInt",
        message: "BigInt serialization failed",
        prismVersion: "1.2.3",
      });
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(400);
    });

    it("should return 400 when agentId is missing", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("POST", "/v1/errors/report", {
        id: "test-uuid-2",
        errorType: "ONNX_BigInt",
        message: "BigInt serialization failed",
        prismVersion: "1.2.3",
      });
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(400);
    });

    it("should return 400 when errorType is missing", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("POST", "/v1/errors/report", {
        id: "test-uuid-3",
        agentId: "hashed-wallet-abc",
        message: "BigInt serialization failed",
        prismVersion: "1.2.3",
      });
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(400);
    });

    it("should return 400 when message is missing", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("POST", "/v1/errors/report", {
        id: "test-uuid-4",
        agentId: "hashed-wallet-abc",
        errorType: "ONNX_BigInt",
        prismVersion: "1.2.3",
      });
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(400);
    });

    it("should return 400 when prismVersion is missing", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("POST", "/v1/errors/report", {
        id: "test-uuid-5",
        agentId: "hashed-wallet-abc",
        errorType: "ONNX_BigInt",
        message: "BigInt serialization failed",
      });
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(400);
    });

    it("should return 200 on duplicate id (idempotency)", async () => {
      const ctx = createExecutionContext();
      const report = {
        id: "dup-uuid",
        agentId: "hashed-wallet-abc",
        errorType: "SQLite_Vec",
        message: "Vector dimension mismatch",
        prismVersion: "1.2.3",
      };
      // Insert once
      const req1 = buildRequest("POST", "/v1/errors/report", report);
      const res1 = await worker.fetch(req1, testEnv, ctx);
      expect(res1.status).toBe(200);

      // Insert duplicate — should still return 200
      const req2 = buildRequest("POST", "/v1/errors/report", report);
      const res2 = await worker.fetch(req2, testEnv, ctx);
      expect(res2.status).toBe(200);
      const body = (await res2.json()) as { id: string; archived: boolean };
      expect(body.id).toBe("dup-uuid");
      expect(body.archived).toBe(false); // duplicate — nothing newly archived
    });

    it("increments one signature without counting the same report id twice", async () => {
      const report = {
        id: "same-signature-1",
        agentId: "hashed-wallet-abc",
        errorType: "SQLite_Vec",
        message: "Vector dimension mismatch",
        prismVersion: "1.2.3",
      };
      await worker.fetch(
        buildRequest("POST", "/v1/errors/report", report),
        testEnv,
        createExecutionContext(),
      );
      await worker.fetch(
        buildRequest("POST", "/v1/errors/report", report),
        testEnv,
        createExecutionContext(),
      );
      await worker.fetch(
        buildRequest("POST", "/v1/errors/report", { ...report, id: "same-signature-2" }),
        testEnv,
        createExecutionContext(),
      );
      const row = await env.DB.prepare(
        "SELECT occurrence_count FROM error_logs WHERE user_id = ? AND fingerprint IS NOT NULL",
      )
        .bind(userId)
        .first<{ occurrence_count: number }>();
      expect(row?.occurrence_count).toBe(2);
    });

    it("does not count an older report retry after a newer report", async () => {
      const first = {
        id: "ordered-signature-1",
        agentId: "hashed-wallet-abc",
        errorType: "SQLite_Vec",
        message: "Vector dimension mismatch",
        prismVersion: "1.2.3",
      };
      await worker.fetch(
        buildRequest("POST", "/v1/errors/report", first),
        testEnv,
        createExecutionContext(),
      );
      await worker.fetch(
        buildRequest("POST", "/v1/errors/report", { ...first, id: "ordered-signature-2" }),
        testEnv,
        createExecutionContext(),
      );
      await worker.fetch(
        buildRequest("POST", "/v1/errors/report", first),
        testEnv,
        createExecutionContext(),
      );
      const row = await env.DB.prepare(
        "SELECT occurrence_count FROM error_logs WHERE user_id = ? AND fingerprint IS NOT NULL",
      )
        .bind(userId)
        .first<{ occurrence_count: number }>();
      expect(row?.occurrence_count).toBe(2);
    });
  });

  describe("POST /v1/errors/batch", () => {
    beforeEach(async () => {
      await env.DB.prepare("DELETE FROM error_logs").run();
    });

    it("should return 200 with inserted count on valid batch", async () => {
      const ctx = createExecutionContext();
      const reports = Array.from({ length: 3 }, (_, i) => ({
        id: `batch-uuid-${i}`,
        agentId: "hashed-wallet-xyz",
        errorType: i % 2 === 0 ? "ONNX_BigInt" : "SQLite_Vec",
        message: `Error ${i}`,
        prismVersion: "1.2.3",
      }));
      const request = buildRequest("POST", "/v1/errors/batch", { reports });
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { inserted: number };
      expect(body.inserted).toBe(3);
    });

    it("reports duplicate receipt counts without leaking internal errors", async () => {
      const report = {
        id: "batch-duplicate-1",
        agentId: "hashed-wallet-xyz",
        errorType: "SQLite_Vec",
        message: "Vector dimension mismatch",
        prismVersion: "1.2.3",
      };
      await worker.fetch(
        buildRequest("POST", "/v1/errors/batch", { reports: [report] }),
        testEnv,
        createExecutionContext(),
      );
      const response = await worker.fetch(
        buildRequest("POST", "/v1/errors/batch", { reports: [report] }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        inserted: 0,
        duplicates: 1,
        archived: 0,
        rejected: [],
      });
    });

    it("should return 400 when no reports provided", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("POST", "/v1/errors/batch", { reports: [] });
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(400);
    });

    it("should return 400 when batch exceeds 50", async () => {
      const ctx = createExecutionContext();
      const reports = Array.from({ length: 51 }, (_, i) => ({
        id: `batch-uuid-${i}`,
        agentId: "hashed-wallet-xyz",
        errorType: "ONNX_BigInt",
        message: `Error ${i}`,
        prismVersion: "1.2.3",
      }));
      const request = buildRequest("POST", "/v1/errors/batch", { reports });
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(400);
    });

    it("accepts valid reports and rejects invalid ones in a mixed batch", async () => {
      const ctx = createExecutionContext();
      const reports = [
        {
          id: "mixed-valid-1",
          agentId: "hash",
          errorType: "TypeA",
          message: "ok",
          prismVersion: "1.0",
        },
        { id: "mixed-invalid-1", agentId: "hash", errorType: "TypeB", prismVersion: "1.0" }, // missing message
      ];
      const request = buildRequest("POST", "/v1/errors/batch", { reports });
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        inserted: number;
        rejected: Array<{ id: string; error: string }>;
      };
      expect(body.inserted).toBe(1);
      expect(body.rejected).toHaveLength(1);
      expect(body.rejected[0]?.id).toBe("mixed-invalid-1");
    });

    it("should return 400 when a report in batch is missing required fields", async () => {
      const ctx = createExecutionContext();
      const reports = [
        { id: "invalid-only-1", agentId: "hash", errorType: "TypeB", prismVersion: "1.0" }, // missing message
      ];
      const request = buildRequest("POST", "/v1/errors/batch", { reports });
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(400);
    });
  });

  describe("GET /v1/errors/stats", () => {
    const adminKey = "test-admin-key-value";

    beforeAll(async () => {
      // Seed some error data for stats
      const stmt = env.DB.prepare(
        `INSERT INTO error_logs (user_id, id, agent_id, error_type, message, stack_trace, prism_version, platform, severity, is_recoverable, fingerprint, first_seen_at, last_seen_at, occurrence_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const now = new Date();
      const seeds = [
        {
          id: "stat-1",
          errorType: "ONNX_BigInt",
          message: "err1",
          createdAt: now.toISOString(),
        },
        {
          id: "stat-2",
          errorType: "ONNX_BigInt",
          message: "err2",
          createdAt: now.toISOString(),
        },
        {
          id: "stat-3",
          errorType: "SQLite_Vec",
          message: "err3",
          createdAt: now.toISOString(),
        },
        {
          id: "stat-4",
          errorType: "RPC_Timeout",
          message: "err4",
          createdAt: now.toISOString(),
        },
      ];
      for (const s of seeds) {
        await stmt
          .bind(
            "stats-user",
            s.id,
            "stats-agent",
            s.errorType,
            s.message,
            null,
            "1.2.3",
            "linux",
            "error",
            0,
            `legacy:${s.id}`,
            s.createdAt,
            s.createdAt,
            1,
            s.createdAt,
          )
          .run();
      }
    });

    it("should return 401 without bearer token", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("GET", "/v1/errors/stats");
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(401);
    });

    it("should return 401 with invalid bearer token", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("GET", "/v1/errors/stats", undefined, "wrong-key");
      const adminEnv = { ...testEnv, ADMIN_API_KEY: adminKey } as Env;
      const response = await worker.fetch(request, adminEnv, ctx);
      expect(response.status).toBe(401);
    });

    it("should return aggregate stats with valid admin token", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("GET", "/v1/errors/stats", undefined, adminKey);
      const adminEnv = { ...testEnv, ADMIN_API_KEY: adminKey } as Env;
      const response = await worker.fetch(request, adminEnv, ctx);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        stats: Array<{ error_type: string; count: number }>;
      };
      expect(body.stats).toBeDefined();
      expect(body.stats.length).toBeGreaterThanOrEqual(3);

      // Verify ONNX_BigInt has count 2
      const onnxStats = body.stats.find((s) => s.error_type === "ONNX_BigInt");
      expect(onnxStats).toBeDefined();
      expect(onnxStats!.count).toBe(2);
    });
  });
});
