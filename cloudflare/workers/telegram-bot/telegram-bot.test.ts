import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker from "./index";

// The webhook and bot->API secrets are configured in the test environment so
// the fail-closed paths can be exercised.
const WEBHOOK_SECRET = "test-secret";
const BOT_API_SECRET = "test-bot-api-secret";
const testEnv = {
  ...env,
  TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
  BOT_API_SECRET,
} as unknown as typeof env;

interface TestMessage {
  message_id: number;
  from: { id: number; is_bot: boolean; first_name: string };
  chat: { id: number; type: "private" | "group" | "supergroup" | "channel" };
  text?: string;
  date: number;
}

function postWebhook(
  update: { update_id: number; message?: TestMessage },
  options: { secret?: string; omitSecretHeader?: boolean } = {},
): RequestInit & { url: string } {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!options.omitSecretHeader) {
    headers["X-Telegram-Bot-Api-Secret-Token"] = options.secret ?? WEBHOOK_SECRET;
  }
  return {
    url: "https://example.com/webhook",
    method: "POST",
    headers,
    body: JSON.stringify(update),
  };
}

function privateMessage(updateId: number, text: string, firstName = "Test") {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: 12345, is_bot: false, first_name: firstName },
      chat: { id: 12345, type: "private" as const },
      text,
      date: Date.now(),
    },
  };
}

function groupMessage(updateId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: 12345, is_bot: false, first_name: "Test" },
      chat: { id: -100999, type: "supergroup" as const },
      text,
      date: Date.now(),
    },
  };
}

/** Extracts the JSON body of the nth mocked fetch call. */
function sentJson(
  fetchSpy: ReturnType<typeof vi.spyOn>,
  callIndex: number,
): Record<string, unknown> {
  const init = fetchSpy.mock.calls[callIndex]?.[1] as { body?: string } | undefined;
  return JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
}

describe("Telegram Bot Worker", () => {
  beforeEach(() => {
    // Reset fetch mocks
    vi.restoreAllMocks();
  });

  describe("Health Check", () => {
    it("should return 200 OK on /health", async () => {
      const response = await worker.fetch(
        new Request("https://example.com/health"),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);

      const body = (await response.json()) as { status: string; timestamp: string };
      expect(body.status).toBe("ok");
      expect(body.timestamp).toBeDefined();
    });
  });

  describe("Webhook Security", () => {
    it("should reject webhook without secret token when configured", async () => {
      const { url, ...init } = postWebhook({ update_id: 1 }, { omitSecretHeader: true });
      const response = await worker.fetch(
        new Request(url, init),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(401);
    });

    it("should reject webhook with a wrong secret token", async () => {
      const { url, ...init } = postWebhook({ update_id: 1 }, { secret: "not-the-secret" });
      const response = await worker.fetch(
        new Request(url, init),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(401);
    });

    it("should accept webhook with valid secret token", async () => {
      const { url, ...init } = postWebhook({ update_id: 1 });
      const response = await worker.fetch(
        new Request(url, init),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
    });

    it("should fail closed when TELEGRAM_WEBHOOK_SECRET is not configured", async () => {
      // env (without the secret) must reject every webhook POST, even ones
      // presenting a token — an unset secret must never mean "open".
      const { url, ...init } = postWebhook({ update_id: 1 });
      const response = await worker.fetch(new Request(url, init), env, createExecutionContext());
      expect(response.status).toBe(401);
    });
  });

  describe("Command Handlers", () => {
    it("should respond to /start command", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const { url, ...init } = postWebhook(privateMessage(1, "/start"));
      const response = await worker.fetch(
        new Request(url, init),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);

      // Verify Telegram API was called
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("api.telegram.org/bot"),
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("should respond to /help command", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const { url, ...init } = postWebhook(privateMessage(2, "/help"));
      const response = await worker.fetch(
        new Request(url, init),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalled();
    });

    it("should respond to /link command", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const { url, ...init } = postWebhook(privateMessage(3, "/link"));
      const response = await worker.fetch(
        new Request(url, init),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalled();
    });

    it("should respond to unknown command with help message", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const { url, ...init } = postWebhook(privateMessage(4, "/unknown"));
      const response = await worker.fetch(
        new Request(url, init),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalled();
    });

    it("should strip @botusername suffix from commands in group chats", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const { url, ...init } = postWebhook(groupMessage(100, "/start@prism_agent_bot"));
      const response = await worker.fetch(
        new Request(url, init),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      const sentBody = fetchSpy.mock.calls[0]?.[1] as { body?: string } | undefined;
      expect(sentBody?.body).toContain("Welcome to Prism");
    });

    it("should HTML-escape user-controlled first names in replies", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const { url, ...init } = postWebhook(privateMessage(5, "/start", "<b>Evil</b>"));
      const response = await worker.fetch(
        new Request(url, init),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      const sent = sentJson(fetchSpy, 0);
      expect(sent.text).toContain("&lt;b&gt;Evil&lt;/b&gt;");
      expect(sent.text).not.toContain("<b>Evil</b>");
    });
  });

  describe("Group Chat Restrictions", () => {
    async function expectGroupRefusal(
      updateId: number,
      text: string,
    ): Promise<ReturnType<typeof vi.spyOn>> {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const { url, ...init } = postWebhook(groupMessage(updateId, text));
      const response = await worker.fetch(
        new Request(url, init),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);

      // Exactly one call: the refusal message to Telegram. No Prism API call.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const callUrl = String(fetchSpy.mock.calls[0]?.[0]);
      expect(callUrl).toContain("api.telegram.org");
      const sent = sentJson(fetchSpy, 0);
      expect(String(sent.text)).toMatch(/private chat/i);
      return fetchSpy;
    }

    it("should refuse /register in a group chat without leaking an API key", async () => {
      const fetchSpy = await expectGroupRefusal(300, "/register");
      const sent = sentJson(fetchSpy, 0);
      expect(String(sent.text)).not.toContain("sk-prism-");
      expect(String(sent.text)).not.toContain("API Key");
    });

    it("should refuse /whoami in a group chat", async () => {
      await expectGroupRefusal(301, "/whoami");
    });

    it("should refuse /status in a group chat", async () => {
      await expectGroupRefusal(302, "/status");
    });

    it("should refuse /link in a group chat", async () => {
      await expectGroupRefusal(303, "/link");
    });

    it("should refuse link-code confirmation in a group chat", async () => {
      await expectGroupRefusal(304, "LINK-ABC123");
    });
  });

  describe("Link Code Handling", () => {
    it("should accept LINK-XXXXXX link code with prefix", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const { url, ...init } = postWebhook(privateMessage(200, "LINK-ABC123"));
      const response = await worker.fetch(
        new Request(url, init),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalled();
      const parsed = sentJson(fetchSpy, 0) as { code?: string };
      expect(parsed.code).toBe("LINK-ABC123");
    });

    it("should prepend LINK- to a bare 6-character code before confirming", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const { url, ...init } = postWebhook(privateMessage(201, "abc123"));
      const response = await worker.fetch(
        new Request(url, init),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      const parsed = sentJson(fetchSpy, 0) as { code?: string };
      // The server stores codes with LINK- prefix; a bare 6-char must be
      // normalized before forwarding or the lookup will fail.
      expect(parsed.code).toBe("LINK-ABC123");
    });

    it("should accept the new 16-hex-character link code format", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const { url, ...init } = postWebhook(privateMessage(202, "LINK-A1B2C3D4E5F60718"));
      const response = await worker.fetch(
        new Request(url, init),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      const parsed = sentJson(fetchSpy, 0) as { code?: string };
      expect(parsed.code).toBe("LINK-A1B2C3D4E5F60718");
    });

    it("should accept 6-character link code", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const { url, ...init } = postWebhook(privateMessage(203, "ABC123"));
      const response = await worker.fetch(
        new Request(url, init),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalled();
    });

    it("should send the bot API secret header when confirming a code", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const { url, ...init } = postWebhook(privateMessage(204, "LINK-ABC123"));
      const response = await worker.fetch(
        new Request(url, init),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);

      // First fetch call goes to the Prism API and must carry the shared secret.
      const [apiUrl, apiInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(String(apiUrl)).toContain("/v1/link-telegram/confirm");
      const headers = new Headers(apiInit.headers);
      expect(headers.get("X-Bot-Api-Secret")).toBe(BOT_API_SECRET);
    });

    it("surfaces the API error message to the user on confirm failure", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "Code expired" }), { status: 400 }),
        );

      const { url, ...init } = postWebhook(privateMessage(205, "LINK-EXPIRED1"));
      const response = await worker.fetch(
        new Request(url, init),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);

      // The bot's reply (last fetch call = Telegram sendMessage) must carry the
      // API's own error, not a bare "400 Bad Request" status line.
      const lastCall = fetchSpy.mock.calls.at(-1) as [string, RequestInit];
      expect(String(lastCall[1].body)).toContain("Link failed: Prism API error: Code expired");
    });

    it("routes the confirm call over the API_SERVICE binding when present", async () => {
      // Cloudflare rejects same-zone workers.dev worker->worker fetches
      // (error 1042); the service binding is the sanctioned transport. When
      // API_SERVICE is present, callPrismApi must call fetcher.fetch() and
      // never the global fetch for the API call. A partial mock stands in for
      // the binding (the full Fetcher interface is not needed at runtime).
      const bindingFetch = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      const boundEnv = {
        ...testEnv,
        API_SERVICE: { fetch: bindingFetch } as unknown as Fetcher,
      } as unknown as typeof env;

      const globalFetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const { url, ...init } = postWebhook(privateMessage(300, "LINK-ABC123"));
      const response = await worker.fetch(
        new Request(url, init),
        boundEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);

      // The API call went through the binding, carrying the prefixed code.
      expect(bindingFetch).toHaveBeenCalledTimes(1);
      const boundRequest = bindingFetch.mock.calls[0]?.[0] as Request;
      expect(boundRequest.url).toContain("/v1/link-telegram/confirm");

      // Global fetch is used ONLY for the Telegram reply, never the API call.
      expect(globalFetchSpy).toHaveBeenCalled();
      for (const call of globalFetchSpy.mock.calls) {
        expect(String(call[0])).toContain("api.telegram.org");
      }
    });

    it("should ignore non-link-code text messages", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const { url, ...init } = postWebhook(privateMessage(6, "Hello, this is a regular message"));
      const response = await worker.fetch(
        new Request(url, init),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      // Should not call Telegram API for non-command, non-code messages
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("Registration Flow", () => {
    it("should handle /register command and call Prism API", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(
            JSON.stringify({ ok: true, result: { api_key: "test-key", user_id: "user_1" } }),
            { status: 200 },
          ),
        );

      const { url, ...init } = postWebhook(privateMessage(7, "/register"));
      const response = await worker.fetch(
        new Request(url, init),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      // Should call both Prism API and Telegram API
      expect(fetchSpy).toHaveBeenCalled();
    });

    it("should handle registration failure gracefully", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: "User already exists" }), {
          status: 400,
        }),
      );

      const { url, ...init } = postWebhook(privateMessage(8, "/register"));
      const response = await worker.fetch(
        new Request(url, init),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalled();
    });
  });

  describe("Whoami Command", () => {
    it("should call /v1/whoami endpoint", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ok: true, result: { user_id: "user_1", tier: "free" } }), {
          status: 200,
        }),
      );

      const { url, ...init } = postWebhook(privateMessage(9, "/whoami"));
      const response = await worker.fetch(
        new Request(url, init),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalled();
    });

    it("should handle unregistered user", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: false, error: "User not found" }), { status: 404 }),
        );

      const { url, ...init } = postWebhook(privateMessage(10, "/whoami"));
      const response = await worker.fetch(
        new Request(url, init),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalled();
    });
  });

  describe("Status Command", () => {
    it("should call /v1/agent-status endpoint", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            result: { status: "running", positions: 2, pnl: 123.45 },
          }),
          { status: 200 },
        ),
      );

      const { url, ...init } = postWebhook(privateMessage(11, "/status"));
      const response = await worker.fetch(
        new Request(url, init),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalled();
    });
  });

  describe("Edge Cases", () => {
    it("should ignore updates without messages", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const { url, ...init } = postWebhook({ update_id: 12 });
      const response = await worker.fetch(
        new Request(url, init),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("should handle messages without text", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const update = {
        update_id: 13,
        message: {
          message_id: 13,
          from: { id: 12345, is_bot: false, first_name: "Test" },
          chat: { id: 12345, type: "private" as const },
          // No text field (e.g., photo, sticker)
          date: Date.now(),
        },
      };

      const { url, ...init } = postWebhook(update);
      const response = await worker.fetch(
        new Request(url, init),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("should return 200 OK even when downstream processing throws (no retry storm)", async () => {
      // Simulate downstream failure (e.g., Telegram sendMessage network error)
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
        new Error("downstream service unavailable"),
      );

      const { url, ...init } = postWebhook(privateMessage(14, "/start"));
      // Webhook MUST return 200; Telegram retries on >=400 which would cause a retry storm
      const response = await worker.fetch(
        new Request(url, init),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
    });
  });
});

describe("/internal/flush-alerts (D1 alert poll)", () => {
  // Base `env` (from wrangler.telegram.test.toml) has no BOT_API_SECRET, so it
  // exercises the fail-closed path; testEnv (defined above) sets it.
  function postFlush(options: { secret?: string; omitSecretHeader?: boolean } = {}): Request {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (!options.omitSecretHeader) {
      headers["X-Bot-Api-Secret"] = options.secret ?? BOT_API_SECRET;
    }
    return new Request("https://example.com/internal/flush-alerts", {
      method: "POST",
      headers,
      body: "{}",
    });
  }

  async function seedUser(
    id = "user-1",
    telegramId: string | null = "12345",
    alertsEnabled = 1,
  ): Promise<void> {
    await env.DB.prepare("INSERT INTO users (id, telegram_id, alerts_enabled) VALUES (?, ?, ?)")
      .bind(id, telegramId, alertsEnabled)
      .run();
  }

  async function seedAlert(
    opts: {
      id?: string;
      userId?: string;
      type?: string;
      severity?: string;
      message?: string;
      poolAddress?: string | null;
      deliveryAttempts?: number;
    } = {},
  ): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO alerts
         (id, user_id, type, pool_address, severity, message, delivery_attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        opts.id ?? "alert-1",
        opts.userId ?? "user-1",
        opts.type ?? "position_out_of_range",
        opts.poolAddress ?? "Pool1111111111111111111111111111111111111",
        opts.severity ?? "critical",
        opts.message ?? "Position out of range on SOL/USDC",
        opts.deliveryAttempts ?? 0,
      )
      .run();
  }

  beforeAll(async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS users (
         id TEXT PRIMARY KEY,
         telegram_id TEXT,
         tier TEXT NOT NULL DEFAULT 'free',
         alerts_enabled INTEGER NOT NULL DEFAULT 1,
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
         delivery_attempts INTEGER NOT NULL DEFAULT 0,
         created_at DATETIME DEFAULT CURRENT_TIMESTAMP
       )`,
    ).run();
    // Defensive: a shared D1 may predate these columns from an earlier file run.
    await env.DB.prepare(
      "ALTER TABLE alerts ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0",
    )
      .run()
      .catch(() => {});
    await env.DB.prepare("ALTER TABLE users ADD COLUMN alerts_enabled INTEGER NOT NULL DEFAULT 1")
      .run()
      .catch(() => {});
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await env.DB.prepare("DELETE FROM alerts").run();
    await env.DB.prepare("DELETE FROM users").run();
  });

  describe("auth", () => {
    it("rejects requests without the bot secret (401)", async () => {
      const response = await worker.fetch(
        postFlush({ omitSecretHeader: true }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(401);
    });

    it("rejects requests with a wrong bot secret (401)", async () => {
      const response = await worker.fetch(
        postFlush({ secret: "wrong-secret" }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(401);
    });

    it("fails closed when BOT_API_SECRET is unset on the worker", async () => {
      const response = await worker.fetch(postFlush(), env, createExecutionContext());
      expect(response.status).toBe(401);
    });
  });

  describe("delivery", () => {
    it("delivers a pending alert to Telegram and marks delivered_at", async () => {
      await seedUser();
      await seedAlert({ id: "alert-a", message: "First alert" });
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const response = await worker.fetch(postFlush(), testEnv, createExecutionContext());
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        ok: boolean;
        checked: number;
        delivered: number;
        failed: number;
      };
      expect(body).toMatchObject({ ok: true, checked: 1, delivered: 1, failed: 0 });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(String(url)).toContain("api.telegram.org/bot");
      const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(sent.chat_id).toBe(12345);
      const text = String(sent.text);
      expect(text).toContain("🚨");
      expect(text).toContain("Position out of range");

      const row = await env.DB.prepare(
        "SELECT delivered_at, delivery_attempts FROM alerts WHERE id = ?",
      )
        .bind("alert-a")
        .first();
      expect(row?.delivered_at).not.toBeNull();
    });

    it("reclaims a stale claim left by an interrupted flush and delivers it", async () => {
      await seedUser();
      await seedAlert({ id: "alert-stale", message: "Stale claim" });
      // Simulate a flush that claimed the row then crashed: delivered_at holds
      // a claim token timestamped well outside the reclaim window.
      const staleClaim = `claim:${Date.now() - 10 * 60 * 1000}:${crypto.randomUUID()}`;
      await env.DB.prepare("UPDATE alerts SET delivered_at = ? WHERE id = ?")
        .bind(staleClaim, "alert-stale")
        .run();
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const response = await worker.fetch(postFlush(), testEnv, createExecutionContext());
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        ok: boolean;
        checked: number;
        delivered: number;
        failed: number;
      };
      expect(body).toMatchObject({ ok: true, checked: 1, delivered: 1, failed: 0 });

      const row = await env.DB.prepare(
        "SELECT delivered_at, delivery_attempts FROM alerts WHERE id = ?",
      )
        .bind("alert-stale")
        .first();
      // The reclaimed row was delivered (delivered_at is a real timestamp, not
      // the stale claim token).
      expect(String(row?.delivered_at)).not.toMatch(/^claim:/);
      expect(row?.delivered_at).not.toBeNull();
    });

    it("does not reclaim a fresh in-flight claim from another flush", async () => {
      await seedUser();
      await seedAlert({ id: "alert-fresh", message: "Fresh claim" });
      // A concurrent flush claimed this row seconds ago; it must NOT be
      // reclaimed by this flush.
      const freshClaim = `claim:${Date.now()}:${crypto.randomUUID()}`;
      await env.DB.prepare("UPDATE alerts SET delivered_at = ? WHERE id = ?")
        .bind(freshClaim, "alert-fresh")
        .run();
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const response = await worker.fetch(postFlush(), testEnv, createExecutionContext());
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        ok: boolean;
        checked: number;
        delivered: number;
        failed: number;
      };
      // The fresh-claim row is invisible to this flush (claimed by another).
      expect(body).toMatchObject({ ok: true, checked: 0, delivered: 0, failed: 0 });
      expect(fetchSpy).not.toHaveBeenCalled();

      const row = await env.DB.prepare(
        "SELECT delivered_at FROM alerts WHERE id = ?",
      )
        .bind("alert-fresh")
        .first();
      expect(String(row?.delivered_at)).toBe(freshClaim);
    });

    it("increments delivery_attempts and leaves delivered_at NULL on failure", async () => {
      await seedUser();
      await seedAlert({ id: "alert-b" });
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ok: false }), { status: 400 }),
      );

      const response = await worker.fetch(postFlush(), testEnv, createExecutionContext());
      const body = (await response.json()) as { delivered: number; failed: number };
      expect(body.delivered).toBe(0);
      expect(body.failed).toBe(1);

      const row = await env.DB.prepare(
        "SELECT delivered_at, delivery_attempts FROM alerts WHERE id = ?",
      )
        .bind("alert-b")
        .first();
      expect(row?.delivered_at).toBeNull();
      expect(row?.delivery_attempts).toBe(1);
    });

    it("skips rows whose user has disabled alerts or no telegram link", async () => {
      await seedUser("user-off", "222", 0);
      await seedUser("user-nolink", null, 1);
      await seedAlert({ id: "alert-off", userId: "user-off" });
      await seedAlert({ id: "alert-nolink", userId: "user-nolink" });
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const response = await worker.fetch(postFlush(), testEnv, createExecutionContext());
      const body = (await response.json()) as { checked: number; delivered: number };
      expect(body.checked).toBe(0);
      expect(body.delivered).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("abandons a row at 5 attempts and never retries it", async () => {
      await seedUser();
      await seedAlert({ id: "alert-c", deliveryAttempts: 4 });

      // First flush: send fails -> attempts 4 -> 5.
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ok: false }), { status: 400 }),
      );
      await worker.fetch(postFlush(), testEnv, createExecutionContext());
      let row = await env.DB.prepare("SELECT delivery_attempts FROM alerts WHERE id = ?")
        .bind("alert-c")
        .first();
      expect(row?.delivery_attempts).toBe(5);

      // Second flush: filtered out (attempts >= 5) -> not retried. Restore the
      // shared fetch spy first so its call history is clean for this assertion.
      vi.restoreAllMocks();
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      const response = await worker.fetch(postFlush(), testEnv, createExecutionContext());
      const body = (await response.json()) as {
        checked: number;
        delivered: number;
        abandoned: number;
      };
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(body.checked).toBe(0);
      expect(body.abandoned).toBe(1);
    });
  });
});
