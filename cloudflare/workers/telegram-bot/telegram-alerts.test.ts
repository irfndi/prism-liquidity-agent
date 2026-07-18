import { describe, it, expect, beforeEach, vi } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker from "./index";

const WEBHOOK_SECRET = "test-secret";
const BOT_API_SECRET = "test-bot-api-secret";
const testEnv = {
  ...env,
  TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
  BOT_API_SECRET,
} as unknown as typeof env;

// Environment without BOT_API_SECRET — internal endpoint must fail closed.
const noSecretEnv = {
  ...env,
  TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
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
  options: { secret?: string } = {},
): Request {
  return new Request("https://example.com/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": options.secret ?? WEBHOOK_SECRET,
    },
    body: JSON.stringify(update),
  });
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

function postDeliverAlert(
  body: unknown,
  options: { secret?: string; omitSecretHeader?: boolean } = {},
): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!options.omitSecretHeader) {
    headers["X-Bot-Api-Secret"] = options.secret ?? BOT_API_SECRET;
  }
  return new Request("https://example.com/internal/deliver-alert", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const VALID_DELIVERY = {
  alert_id: "alert-1",
  telegram_id: "12345",
  type: "position_out_of_range",
  severity: "critical",
  message: "Position out of range on SOL/USDC — fees stopped accruing",
  pool_address: "Pool1111111111111111111111111111111111111",
} as const;

/** Extracts the JSON body of the nth mocked fetch call. */
function sentJson(
  fetchSpy: ReturnType<typeof vi.spyOn>,
  callIndex: number,
): Record<string, unknown> {
  const init = fetchSpy.mock.calls[callIndex]?.[1] as { body?: string } | undefined;
  return JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
}

describe("Telegram alert delivery", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("POST /internal/deliver-alert — auth", () => {
    it("rejects requests without the bot secret (401)", async () => {
      const response = await worker.fetch(
        postDeliverAlert(VALID_DELIVERY, { omitSecretHeader: true }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(401);
    });

    it("rejects requests with a wrong bot secret (401)", async () => {
      const response = await worker.fetch(
        postDeliverAlert(VALID_DELIVERY, { secret: "wrong-secret" }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(401);
    });

    it("fails closed when BOT_API_SECRET is unset on the worker", async () => {
      const response = await worker.fetch(
        postDeliverAlert(VALID_DELIVERY),
        noSecretEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(401);
    });
  });

  describe("POST /internal/deliver-alert — validation", () => {
    it("rejects a missing telegram_id (400)", async () => {
      const response = await worker.fetch(
        postDeliverAlert({ ...VALID_DELIVERY, telegram_id: undefined }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(400);
    });

    it("rejects a non-numeric telegram_id (400)", async () => {
      const response = await worker.fetch(
        postDeliverAlert({ ...VALID_DELIVERY, telegram_id: "not-a-number" }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(400);
    });

    it("rejects an unknown severity (400)", async () => {
      const response = await worker.fetch(
        postDeliverAlert({ ...VALID_DELIVERY, severity: "fatal" }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(400);
    });

    it("rejects a missing message (400)", async () => {
      const response = await worker.fetch(
        postDeliverAlert({ ...VALID_DELIVERY, message: undefined }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(400);
    });
  });

  describe("POST /internal/deliver-alert — delivery", () => {
    it("sends a formatted Telegram message with severity emoji and shortened pool address", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const response = await worker.fetch(
        postDeliverAlert(VALID_DELIVERY),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(String(url)).toContain("api.telegram.org/bot");
      const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(sent.chat_id).toBe(12345);
      expect(sent.parse_mode).toBe("HTML");
      const text = String(sent.text);
      expect(text).toContain("🚨");
      expect(text).toContain("Position out of range");
      expect(text).toContain("Pool…1111");
      expect(text).not.toContain(VALID_DELIVERY.pool_address);
      expect(text).toContain(VALID_DELIVERY.message);
    });

    it("uses the warning emoji for warning alerts", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const response = await worker.fetch(
        postDeliverAlert({ ...VALID_DELIVERY, severity: "warning", type: "range_warning" }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      const sent = sentJson(fetchSpy, 0);
      expect(String(sent.text)).toContain("⚠️");
      expect(String(sent.text)).toContain("Range warning");
    });

    it("HTML-escapes injection attempts in message and pool address", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const response = await worker.fetch(
        postDeliverAlert({
          ...VALID_DELIVERY,
          severity: "info",
          message: '<b>click</b> <a href="https://evil.example">here</a> &amp; more',
          // Injection chars must survive address shortening to prove escaping.
          pool_address: "<scr ipt>111111111111111111</scr>",
        }),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      const sent = sentJson(fetchSpy, 0);
      const text = String(sent.text);
      expect(text).not.toContain("<b>click</b>");
      expect(text).not.toContain("<scr");
      expect(text).toContain("&lt;b&gt;click&lt;/b&gt;");
      expect(text).toContain("&lt;scr");
    });

    it("returns 502 when the Telegram API call fails", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ok: false, description: "chat not found" }), {
          status: 400,
        }),
      );

      const response = await worker.fetch(
        postDeliverAlert(VALID_DELIVERY),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(502);
    });
  });

  describe("/alerts command", () => {
    it("turns alerts on via the API and confirms", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: true, success: true }), { status: 200 }),
        );

      const response = await worker.fetch(
        postWebhook(privateMessage(500, "/alerts on")),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);

      // First call: preferences update to the API with the shared secret.
      const [apiUrl, apiInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(String(apiUrl)).toContain("/v1/alerts/preferences");
      const headers = new Headers(apiInit.headers);
      expect(headers.get("X-Bot-Api-Secret")).toBe(BOT_API_SECRET);
      const prefBody = JSON.parse(String(apiInit.body)) as Record<string, unknown>;
      expect(prefBody.telegram_id).toBe("12345");
      expect(prefBody.enabled).toBe(true);

      // Second call: confirmation message to Telegram.
      const sent = sentJson(fetchSpy, 1);
      expect(String(sent.text)).toMatch(/alerts enabled/i);
    });

    it("turns alerts off via the API and confirms", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: true, success: true }), { status: 200 }),
        );

      const response = await worker.fetch(
        postWebhook(privateMessage(501, "/alerts off")),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);

      const prefBody = sentJson(fetchSpy, 0);
      expect(prefBody.enabled).toBe(false);
      const sent = sentJson(fetchSpy, 1);
      expect(String(sent.text)).toMatch(/alerts disabled/i);
    });

    it("replies with usage when the argument is missing or invalid", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const response = await worker.fetch(
        postWebhook(privateMessage(502, "/alerts")),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);

      // Only one call: the usage reply. No API preferences call.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const sent = sentJson(fetchSpy, 0);
      expect(String(sent.text)).toMatch(/usage/i);
    });

    it("refuses /alerts in a group chat", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const response = await worker.fetch(
        postWebhook(groupMessage(503, "/alerts off")),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);

      // Exactly one call: the private-chat refusal. No preferences update.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const sent = sentJson(fetchSpy, 0);
      expect(String(sent.text)).toMatch(/private chat/i);
    });

    it("reports an error when the API rejects the preference update", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
        if (String(url).includes("/v1/alerts/preferences")) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: "User not found" }), { status: 404 }),
          );
        }
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      });

      const response = await worker.fetch(
        postWebhook(privateMessage(504, "/alerts on")),
        testEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      const sent = sentJson(fetchSpy, 1);
      expect(String(sent.text)).toMatch(/could not update/i);
    });
  });
});
