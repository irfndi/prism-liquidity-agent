import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker, { type Env } from "./index";

const testEnv = env as unknown as Env;

function buildRequest(method: string, path: string, body?: unknown, token?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return new Request(`https://example.com${path}`, init);
}

describe("Feedback API", () => {
  beforeAll(async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        category TEXT NOT NULL,
        severity TEXT NOT NULL,
        summary TEXT NOT NULL,
        details TEXT,
        related_files TEXT,
        context_json TEXT,
        prism_version TEXT,
        platform TEXT,
        install_method TEXT,
        runtime TEXT,
        hash TEXT NOT NULL,
        github_issue_number INTEGER,
        github_issue_url TEXT,
        reported_at INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
    ).run();
    await env.DB.prepare(
      `CREATE INDEX IF NOT EXISTS idx_feedback_agent_reported ON feedback(agent_id, reported_at)`,
    ).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_feedback_hash ON feedback(hash)`).run();
  });

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM feedback").run();
  });

  describe("POST /v1/feedback", () => {
    it("stores valid feedback and returns id", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("POST", "/v1/feedback", {
        id: "fb-uuid-1",
        agentId: "agent-abc",
        category: "suggestion",
        severity: "medium",
        summary: "Add dark mode",
        details: "It would be easier on the eyes.",
        relatedFiles: ["cli/index.ts"],
        context: {
          prismVersion: "0.0.20",
          platform: "darwin",
          installMethod: "curl",
          runtime: "bun 1.4.0",
        },
        hash: "deadbeef",
        reportedAt: Date.now(),
      });
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { id: string };
      expect(body.id).toBe("fb-uuid-1");

      const rows = await env.DB.prepare("SELECT summary FROM feedback WHERE id = ?")
        .bind("fb-uuid-1")
        .all();
      expect(rows.results).toHaveLength(1);
    });

    it("returns 400 when category is invalid", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("POST", "/v1/feedback", {
        id: "fb-uuid-2",
        agentId: "agent-abc",
        category: "complaint",
        severity: "low",
        summary: "Bad UX",
      });
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(400);
    });

    it("returns 400 when severity is invalid", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("POST", "/v1/feedback", {
        id: "fb-uuid-3",
        agentId: "agent-abc",
        category: "praise",
        severity: "critical",
        summary: "Great work",
      });
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(400);
    });

    it("returns 400 when summary is missing", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("POST", "/v1/feedback", {
        id: "fb-uuid-4",
        agentId: "agent-abc",
        category: "observation",
        severity: "low",
      });
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(400);
    });

    it("returns 400 when hash is missing", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("POST", "/v1/feedback", {
        id: "fb-uuid-5",
        agentId: "agent-abc",
        category: "observation",
        severity: "low",
        summary: "Missing hash field",
      });
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("hash");
    });

    it("returns 400 when hash is not a string", async () => {
      const ctx = createExecutionContext();
      const request = buildRequest("POST", "/v1/feedback", {
        id: "fb-uuid-6",
        agentId: "agent-abc",
        category: "observation",
        severity: "low",
        summary: "Non-string hash",
        hash: 12345,
      });
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(400);
    });

    it("returns 200 on duplicate id (idempotency)", async () => {
      const ctx = createExecutionContext();
      const payload = {
        id: "fb-dup",
        agentId: "agent-abc",
        category: "friction",
        severity: "high",
        summary: "Setup is slow",
        hash: "aabbccdd",
      };
      const first = await worker.fetch(buildRequest("POST", "/v1/feedback", payload), testEnv, ctx);
      expect(first.status).toBe(200);

      const second = await worker.fetch(
        buildRequest("POST", "/v1/feedback", payload),
        testEnv,
        ctx,
      );
      expect(second.status).toBe(200);
      const body = (await second.json()) as { id: string };
      expect(body.id).toBe("fb-dup");
    });
  });

  describe("GET /v1/feedback", () => {
    const adminKey = "test-admin-feedback-key";

    beforeEach(async () => {
      await env.DB.prepare("DELETE FROM feedback").run();
      await env.DB.prepare(
        `INSERT INTO feedback (id, agent_id, category, severity, summary, hash, reported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind("fb-admin-1", "agent-x", "suggestion", "low", "More docs", "hash1", Date.now())
        .run();
    });

    it("returns 401 without admin token", async () => {
      const ctx = createExecutionContext();
      const response = await worker.fetch(buildRequest("GET", "/v1/feedback"), testEnv, ctx);
      expect(response.status).toBe(401);
    });

    it("returns feedback list with admin token", async () => {
      const ctx = createExecutionContext();
      const adminEnv = { ...testEnv, ADMIN_API_KEY: adminKey } as Env;
      const response = await worker.fetch(
        buildRequest("GET", "/v1/feedback", undefined, adminKey),
        adminEnv,
        ctx,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { feedback: unknown[] };
      expect(body.feedback.length).toBeGreaterThanOrEqual(1);
    });
  });
});
