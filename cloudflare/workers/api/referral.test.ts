import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker, { type Env } from "./index";
import { buildRequest, clearRegisterRateLimit, setupCommonSchema } from "./test-utils";

const testEnv = env as unknown as Env;
let referrerKey = "";
let refereeKey = "";
let referrerId = "";
let refereeId = "";

// Codes are 8 chars from the unambiguous alphabet ABCDEFGHJKLMNPQRSTUVWXYZ23456789
// (no I, O, 0, 1) — see generateReferralCode() in the worker.
const REFERRAL_CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;

async function registerCliUser(): Promise<{ apiKey: string; userId: string }> {
  const response = await worker.fetch(
    buildRequest("POST", "/v1/register", {}),
    testEnv,
    createExecutionContext(),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { user_id: string; api_key: string };
  return { apiKey: body.api_key, userId: body.user_id };
}

// Issues (or fetches the existing) referral code for an API key.
async function issueCode(key: string): Promise<string> {
  const response = await worker.fetch(
    buildRequest("GET", "/v1/referral/code", undefined, { Authorization: `Bearer ${key}` }),
    testEnv,
    createExecutionContext(),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { code: string };
  return body.code;
}

describe("Referral API", () => {
  beforeAll(async () => {
    await setupCommonSchema(env.DB);
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS referral_codes (
        code TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS referrals (
        id TEXT PRIMARY KEY,
        referrer_user_id TEXT NOT NULL,
        referee_user_id TEXT NOT NULL UNIQUE,
        referral_code TEXT NOT NULL,
        credited_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS user_credits (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        amount REAL NOT NULL,
        reason TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME
      )`,
    ).run();
    await env.DB.prepare("DELETE FROM user_credits").run();
    await env.DB.prepare("DELETE FROM referrals").run();
    await env.DB.prepare("DELETE FROM referral_codes").run();
    await clearRegisterRateLimit(env.CACHE);

    const referrer = await registerCliUser();
    referrerKey = referrer.apiKey;
    referrerId = referrer.userId;
    const referee = await registerCliUser();
    refereeKey = referee.apiKey;
    refereeId = referee.userId;
  });

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM user_credits").run();
    await env.DB.prepare("DELETE FROM referrals").run();
    await env.DB.prepare("DELETE FROM referral_codes").run();
  });

  describe("GET /v1/referral/code", () => {
    it("returns 401 when no API key is provided", async () => {
      const response = await worker.fetch(
        buildRequest("GET", "/v1/referral/code"),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("API key required");
    });

    it("issues a code from the unambiguous alphabet and persists it", async () => {
      const response = await worker.fetch(
        buildRequest("GET", "/v1/referral/code", undefined, {
          Authorization: `Bearer ${referrerKey}`,
        }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { code: string; referralCount: number };
      expect(body.code).toMatch(REFERRAL_CODE_RE);
      expect(body.referralCount).toBe(0);

      const rows = await env.DB.prepare("SELECT code FROM referral_codes WHERE user_id = ?")
        .bind(referrerId)
        .all();
      expect(rows.results).toHaveLength(1);
    });

    it("returns the same code on subsequent calls (idempotent issue)", async () => {
      const first = await issueCode(referrerKey);
      const second = await issueCode(referrerKey);
      expect(second).toBe(first);

      const rows = await env.DB.prepare("SELECT code FROM referral_codes WHERE user_id = ?")
        .bind(referrerId)
        .all();
      expect(rows.results).toHaveLength(1);
    });

    it("returns 500 for an unknown API key", async () => {
      // Handler behavior: the loginHandler failure leaks into the generic
      // catch, so an invalid key yields 500 here while /v1/login, /v1/whoami
      // and /v1/config return 401. Asserting the REAL behavior; see the test
      // report — this should be a 401.
      const response = await worker.fetch(
        buildRequest("GET", "/v1/referral/code", undefined, {
          Authorization: "Bearer sk-prism-unknown-key",
        }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("Failed to get referral code");
    });
  });

  describe("POST /v1/referral/apply", () => {
    it("returns 401 when no API key is provided", async () => {
      const response = await worker.fetch(
        buildRequest("POST", "/v1/referral/apply", { code: "WHATEVER" }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("API key required");
    });

    it("returns 400 when the code is missing", async () => {
      const response = await worker.fetch(
        buildRequest("POST", "/v1/referral/apply", {}, {
          Authorization: `Bearer ${refereeKey}`,
        }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("Code required");
    });

    it("returns 400 for an unknown code", async () => {
      const response = await worker.fetch(
        buildRequest("POST", "/v1/referral/apply", { code: "NOSUCHCOD" }, {
          Authorization: `Bearer ${refereeKey}`,
        }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("Invalid referral code");
    });

    it("rejects self-referral", async () => {
      const code = await issueCode(referrerKey);
      const response = await worker.fetch(
        buildRequest("POST", "/v1/referral/apply", { code }, {
          Authorization: `Bearer ${referrerKey}`,
        }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("Cannot refer yourself");
    });

    it("applies a valid code and credits both sides", async () => {
      const code = await issueCode(referrerKey);
      const response = await worker.fetch(
        buildRequest("POST", "/v1/referral/apply", { code }, {
          Authorization: `Bearer ${refereeKey}`,
        }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { success: boolean; credits: number };
      expect(body.success).toBe(true);
      expect(body.credits).toBe(10);

      const referral = await env.DB.prepare(
        "SELECT referrer_user_id, referee_user_id FROM referrals WHERE referral_code = ?",
      )
        .bind(code)
        .first();
      expect(referral?.referrer_user_id).toBe(referrerId);
      expect(referral?.referee_user_id).toBe(refereeId);

      const bonus = await env.DB.prepare(
        "SELECT amount FROM user_credits WHERE user_id = ? AND reason = ?",
      )
        .bind(referrerId, "referral_bonus")
        .first();
      expect(bonus?.amount).toBe(5);

      const refereeBonus = await env.DB.prepare(
        "SELECT amount FROM user_credits WHERE user_id = ? AND reason = ?",
      )
        .bind(refereeId, "referee_bonus")
        .first();
      expect(refereeBonus?.amount).toBe(10);
    });

    it("rejects a second application by the same referee", async () => {
      const code = await issueCode(referrerKey);
      const first = await worker.fetch(
        buildRequest("POST", "/v1/referral/apply", { code }, {
          Authorization: `Bearer ${refereeKey}`,
        }),
        testEnv,
        createExecutionContext(),
      );
      expect(first.status).toBe(200);

      const second = await worker.fetch(
        buildRequest("POST", "/v1/referral/apply", { code }, {
          Authorization: `Bearer ${refereeKey}`,
        }),
        testEnv,
        createExecutionContext(),
      );
      expect(second.status).toBe(400);
      const body = (await second.json()) as { error: string };
      expect(body.error).toContain("Already referred");
    });
  });

  describe("GET /v1/referral/stats", () => {
    it("returns 401 when no API key is provided", async () => {
      const response = await worker.fetch(
        buildRequest("GET", "/v1/referral/stats"),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("API key required");
    });

    it("returns zeroed stats for a user with no referrals", async () => {
      const response = await worker.fetch(
        buildRequest("GET", "/v1/referral/stats", undefined, {
          Authorization: `Bearer ${referrerKey}`,
        }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        referralCount: number;
        credits: number;
        milestone: string | null;
      };
      expect(body.referralCount).toBe(0);
      expect(body.credits).toBe(0);
      expect(body.milestone).toBeNull();
    });

    it("reflects the referrer credit after a successful application", async () => {
      const code = await issueCode(referrerKey);
      const apply = await worker.fetch(
        buildRequest("POST", "/v1/referral/apply", { code }, {
          Authorization: `Bearer ${refereeKey}`,
        }),
        testEnv,
        createExecutionContext(),
      );
      expect(apply.status).toBe(200);

      const response = await worker.fetch(
        buildRequest("GET", "/v1/referral/stats", undefined, {
          Authorization: `Bearer ${referrerKey}`,
        }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        referralCount: number;
        credits: number;
        milestone: string | null;
      };
      expect(body.referralCount).toBe(1);
      expect(body.credits).toBe(5);
      expect(body.milestone).toBeNull();
    });

    it("reports the 5-referral milestone once the threshold is reached", async () => {
      await env.DB.prepare("INSERT INTO referral_codes (code, user_id) VALUES (?, ?)")
        .bind("MILESTN1", referrerId)
        .run();
      for (let i = 1; i <= 5; i++) {
        await env.DB.prepare("INSERT INTO users (id, tier) VALUES (?, ?)")
          .bind(`milestone-referee-${i}`, "free")
          .run();
        await env.DB.prepare(
          "INSERT INTO referrals (id, referrer_user_id, referee_user_id, referral_code) VALUES (?, ?, ?, ?)",
        )
          .bind(`milestone-ref-${i}`, referrerId, `milestone-referee-${i}`, "MILESTN1")
          .run();
      }
      await env.DB.prepare(
        "INSERT INTO user_credits (id, user_id, amount, reason) VALUES (?, ?, ?, ?)",
      )
        .bind("milestone-credit", referrerId, 5, "referral_bonus")
        .run();

      const response = await worker.fetch(
        buildRequest("GET", "/v1/referral/stats", undefined, {
          Authorization: `Bearer ${referrerKey}`,
        }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        referralCount: number;
        credits: number;
        milestone: string | null;
      };
      expect(body.referralCount).toBe(5);
      expect(body.credits).toBe(5);
      expect(body.milestone).toBe("5 referrals - $25 bonus!");
    });
  });
});
