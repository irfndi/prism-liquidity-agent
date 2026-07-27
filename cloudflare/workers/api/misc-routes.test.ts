import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker, { type Env } from "./index";
import { buildRequest, clearRegisterRateLimit, setupCommonSchema } from "./test-utils";

const testEnv = env as unknown as Env;
let apiKey = "";
let userId = "";

describe("Misc routes (issue / config)", () => {
  beforeAll(async () => {
    await setupCommonSchema(env.DB);
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY,
        user_id TEXT,
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
    await env.DB.prepare("DELETE FROM feedback").run();
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
    await env.DB.prepare("DELETE FROM feedback").run();
    await env.CACHE.delete("rate_limit:feedback:unknown");
    await env.CACHE.delete("fee_wallet_address");
  });

  describe("POST /v1/issue", () => {
    it("stores a valid issue as high-severity friction feedback", async () => {
      const response = await worker.fetch(
        buildRequest(
          "POST",
          "/v1/issue",
          { title: "Setup wizard crashes", body: "Steps to reproduce..." },
          { Authorization: `Bearer ${apiKey}` },
        ),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { id: string; duplicate: boolean };
      expect(body.duplicate).toBe(false);

      const row = await env.DB.prepare(
        "SELECT summary, details, category, severity, agent_id, user_id FROM feedback WHERE id = ?",
      )
        .bind(body.id)
        .first();
      expect(row?.summary).toBe("Setup wizard crashes");
      expect(row?.details).toBe("Steps to reproduce...");
      expect(row?.category).toBe("friction");
      expect(row?.severity).toBe("high");
      expect(row?.agent_id).toBe("cli");
      expect(row?.user_id).toBe(userId);
    });

    it("returns 401 when no API key is provided", async () => {
      const response = await worker.fetch(
        buildRequest("POST", "/v1/issue", { title: "No auth" }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("API key required");
    });

    it("returns 401 for an unknown API key", async () => {
      const response = await worker.fetch(
        buildRequest("POST", "/v1/issue", { title: "Bad auth" }, {
          Authorization: "Bearer sk-prism-unknown-key",
        }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(401);
    });

    it("returns 400 when title is missing", async () => {
      const response = await worker.fetch(
        buildRequest("POST", "/v1/issue", { body: "No title here" }, {
          Authorization: `Bearer ${apiKey}`,
        }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("Title required");
    });

    it("returns 400 when title is not a string", async () => {
      const response = await worker.fetch(
        buildRequest("POST", "/v1/issue", { title: 12345 }, {
          Authorization: `Bearer ${apiKey}`,
        }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("Title required");
    });

    it("deduplicates identical title+body submissions", async () => {
      const payload = { title: "Duplicate issue", body: "Same content twice" };
      const first = await worker.fetch(
        buildRequest("POST", "/v1/issue", payload, { Authorization: `Bearer ${apiKey}` }),
        testEnv,
        createExecutionContext(),
      );
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as { id: string; duplicate: boolean };
      expect(firstBody.duplicate).toBe(false);

      const second = await worker.fetch(
        buildRequest("POST", "/v1/issue", payload, { Authorization: `Bearer ${apiKey}` }),
        testEnv,
        createExecutionContext(),
      );
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as { id: string; duplicate: boolean };
      expect(secondBody.duplicate).toBe(true);
      expect(secondBody.id).toBe(firstBody.id);
    });
  });

  describe("GET /v1/config", () => {
    it("returns 401 when no API key is provided", async () => {
      const response = await worker.fetch(
        buildRequest("GET", "/v1/config"),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("API key required");
    });

    it("returns 401 for an unknown API key", async () => {
      const response = await worker.fetch(
        buildRequest("GET", "/v1/config", undefined, {
          Authorization: "Bearer sk-prism-unknown-key",
        }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("Unauthorized");
    });

    it("returns free-tier defaults when no fee wallet is configured", async () => {
      const response = await worker.fetch(
        buildRequest("GET", "/v1/config", undefined, { Authorization: `Bearer ${apiKey}` }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        tier: string;
        platformFeeRate: number;
        revenueShareEnabled: boolean;
        revenueShareOperatorPct: number;
        feeWalletAddress: string | null;
        configVersion: number;
      };
      expect(body.tier).toBe("free");
      expect(body.platformFeeRate).toBe(0);
      expect(body.revenueShareEnabled).toBe(true);
      expect(body.revenueShareOperatorPct).toBe(0);
      expect(body.feeWalletAddress).toBeNull();
      expect(body.configVersion).toBe(1);
    });

    it("prefers the KV fee wallet address over the secret", async () => {
      await env.CACHE.put("fee_wallet_address", "KVConfiguredWalletAddress");
      const secretEnv = { ...testEnv, FEE_WALLET_ADDRESS: "SecretConfiguredWallet" } as Env;

      const response = await worker.fetch(
        buildRequest("GET", "/v1/config", undefined, { Authorization: `Bearer ${apiKey}` }),
        secretEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { feeWalletAddress: string | null };
      expect(body.feeWalletAddress).toBe("KVConfiguredWalletAddress");
    });

    it("falls back to the FEE_WALLET_ADDRESS secret when KV is empty", async () => {
      const secretEnv = { ...testEnv, FEE_WALLET_ADDRESS: "SecretConfiguredWallet" } as Env;

      const response = await worker.fetch(
        buildRequest("GET", "/v1/config", undefined, { Authorization: `Bearer ${apiKey}` }),
        secretEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { feeWalletAddress: string | null };
      expect(body.feeWalletAddress).toBe("SecretConfiguredWallet");
    });
  });
});
