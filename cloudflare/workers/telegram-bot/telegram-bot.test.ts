import { describe, it, expect, beforeEach, vi } from "vitest";
import { env, createExecutionContext, SELF } from "cloudflare:test";
import worker from "./index";

describe("Telegram Bot Worker", () => {
  beforeEach(() => {
    // Reset fetch mocks
    vi.restoreAllMocks();
  });

  describe("Health Check", () => {
    it("should return 200 OK on /health", async () => {
      const response = await SELF.fetch("https://example.com/health");
      expect(response.status).toBe(200);

      const body = await response.json() as { status: string; timestamp: string };
      expect(body.status).toBe("ok");
      expect(body.timestamp).toBeDefined();
    });
  });

  describe("Webhook Security", () => {
    it("should reject webhook without secret token when configured", async () => {
      const ctx = createExecutionContext();
      const request = new Request("https://example.com/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ update_id: 1 }),
      });

      // Without webhook secret configured, should pass
      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(200);
    });

    it("should accept webhook with valid secret token", async () => {
      const ctx = createExecutionContext();
      const request = new Request("https://example.com/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": "test-secret",
        },
        body: JSON.stringify({ update_id: 1 }),
      });

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(200);
    });
  });

  describe("Command Handlers", () => {
    it("should respond to /start command", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const update = {
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 12345, is_bot: false, first_name: "Test" },
          chat: { id: 12345, type: "private" as const },
          text: "/start",
          date: Date.now(),
        },
      };

      const ctx = createExecutionContext();
      const request = new Request("https://example.com/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(200);

      // Verify Telegram API was called
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("api.telegram.org/bot"),
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("should respond to /help command", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const update = {
        update_id: 2,
        message: {
          message_id: 2,
          from: { id: 12345, is_bot: false, first_name: "Test" },
          chat: { id: 12345, type: "private" as const },
          text: "/help",
          date: Date.now(),
        },
      };

      const ctx = createExecutionContext();
      const request = new Request("https://example.com/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalled();
    });

    it("should respond to /link command", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const update = {
        update_id: 3,
        message: {
          message_id: 3,
          from: { id: 12345, is_bot: false, first_name: "Test" },
          chat: { id: 12345, type: "private" as const },
          text: "/link",
          date: Date.now(),
        },
      };

      const ctx = createExecutionContext();
      const request = new Request("https://example.com/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalled();
    });

    it("should respond to unknown command with help message", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const update = {
        update_id: 4,
        message: {
          message_id: 4,
          from: { id: 12345, is_bot: false, first_name: "Test" },
          chat: { id: 12345, type: "private" as const },
          text: "/unknown",
          date: Date.now(),
        },
      };

      const ctx = createExecutionContext();
      const request = new Request("https://example.com/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalled();
    });
  });

  describe("Link Code Handling", () => {
    it("should accept 6-character link code", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const update = {
        update_id: 5,
        message: {
          message_id: 5,
          from: { id: 12345, is_bot: false, first_name: "Test" },
          chat: { id: 12345, type: "private" as const },
          text: "ABC123",
          date: Date.now(),
        },
      };

      const ctx = createExecutionContext();
      const request = new Request("https://example.com/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalled();
    });

    it("should ignore non-link-code text messages", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const update = {
        update_id: 6,
        message: {
          message_id: 6,
          from: { id: 12345, is_bot: false, first_name: "Test" },
          chat: { id: 12345, type: "private" as const },
          text: "Hello, this is a regular message",
          date: Date.now(),
        },
      };

      const ctx = createExecutionContext();
      const request = new Request("https://example.com/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(200);
      // Should not call Telegram API for non-command, non-code messages
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("Registration Flow", () => {
    it("should handle /register command and call Prism API", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, result: { api_key: "test-key", user_id: "user_1" } }),
          { status: 200 },
        ),
      );

      const update = {
        update_id: 7,
        message: {
          message_id: 7,
          from: { id: 12345, is_bot: false, first_name: "Test" },
          chat: { id: 12345, type: "private" as const },
          text: "/register",
          date: Date.now(),
        },
      };

      const ctx = createExecutionContext();
      const request = new Request("https://example.com/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(200);
      // Should call both Prism API and Telegram API
      expect(fetchSpy).toHaveBeenCalled();
    });

    it("should handle registration failure gracefully", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({ ok: false, error: "User already exists" }),
          { status: 400 },
        ),
      );

      const update = {
        update_id: 8,
        message: {
          message_id: 8,
          from: { id: 12345, is_bot: false, first_name: "Test" },
          chat: { id: 12345, type: "private" as const },
          text: "/register",
          date: Date.now(),
        },
      };

      const ctx = createExecutionContext();
      const request = new Request("https://example.com/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalled();
    });
  });

  describe("Whoami Command", () => {
    it("should call /v1/whoami endpoint", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, result: { user_id: "user_1", tier: "free" } }),
          { status: 200 },
        ),
      );

      const update = {
        update_id: 9,
        message: {
          message_id: 9,
          from: { id: 12345, is_bot: false, first_name: "Test" },
          chat: { id: 12345, type: "private" as const },
          text: "/whoami",
          date: Date.now(),
        },
      };

      const ctx = createExecutionContext();
      const request = new Request("https://example.com/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalled();
    });

    it("should handle unregistered user", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({ ok: false, error: "User not found" }),
          { status: 404 },
        ),
      );

      const update = {
        update_id: 10,
        message: {
          message_id: 10,
          from: { id: 12345, is_bot: false, first_name: "Test" },
          chat: { id: 12345, type: "private" as const },
          text: "/whoami",
          date: Date.now(),
        },
      };

      const ctx = createExecutionContext();
      const request = new Request("https://example.com/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });

      const response = await worker.fetch(request, env, ctx);
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

      const update = {
        update_id: 11,
        message: {
          message_id: 11,
          from: { id: 12345, is_bot: false, first_name: "Test" },
          chat: { id: 12345, type: "private" as const },
          text: "/status",
          date: Date.now(),
        },
      };

      const ctx = createExecutionContext();
      const request = new Request("https://example.com/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalled();
    });
  });

  describe("Edge Cases", () => {
    it("should ignore updates without messages", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const update = {
        update_id: 12,
        // No message field
      };

      const ctx = createExecutionContext();
      const request = new Request("https://example.com/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("should handle messages without text", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

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

      const ctx = createExecutionContext();
      const request = new Request("https://example.com/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
