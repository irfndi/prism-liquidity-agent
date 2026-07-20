import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { GatewayTransport } from "../engine/gateway-transport.js";
import type { AgentRuntimeContext, AgentRuntimeCheckin } from "../engine/agent-transport.js";
import type { AgentDecision } from "../engine/types.js";

function makeContext(): AgentRuntimeContext {
  return {
    decision: {
      action: "ENTER",
      poolAddress: "Pool111111111111111111111111111111111111111",
      confidence: 0.8,
      reasoning: "test decision",
    } satisfies AgentDecision,
  } as unknown as AgentRuntimeContext;
}

// hello-ok payload matching the gateway's HelloOkSchema (v2026.7.1, protocol 4).
const HELLO_OK = {
  type: "hello-ok",
  protocol: 4,
  server: { version: "2026.7.1", connId: "conn-test" },
  features: { methods: ["chat.send", "system-event"], events: ["chat", "tick"] },
  snapshot: {
    sessionDefaults: { defaultAgentId: "hermes-agent", mainKey: "main", mainSessionKey: "main" },
  },
  auth: { role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"] },
  policy: { maxPayload: 26214400, maxBufferedBytes: 52428800, tickIntervalMs: 30000 },
} as const;

interface Frame {
  type: string;
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
}

function sendFrame(ws: { send: (data: string) => void }, frame: unknown): void {
  ws.send(JSON.stringify(frame));
}

function challenge(nonce: string): unknown {
  return { type: "event", event: "connect.challenge", payload: { nonce, ts: Date.now() } };
}

describe("GatewayTransport (OpenClaw protocol v4)", () => {
  it("handshakes challenge -> connect -> hello-ok and round-trips a prompt via chat.send", async () => {
    const received: {
      connect?: Record<string, unknown> | undefined;
      chat?: Record<string, unknown> | undefined;
    } = {};

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, s) {
        if (s.upgrade(req)) return;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          sendFrame(ws, challenge("nonce-1"));
        },
        message(ws, data) {
          const frame = JSON.parse(String(data)) as Frame;
          if (frame.type !== "req") return;
          if (frame.method === "connect") {
            received.connect = frame.params;
            sendFrame(ws, { type: "res", id: frame.id, ok: true, payload: HELLO_OK });
          } else if (frame.method === "chat.send") {
            received.chat = frame.params;
            const runId = String(frame.params?.idempotencyKey);
            sendFrame(ws, {
              type: "res",
              id: frame.id,
              ok: true,
              payload: { runId, status: "started" },
            });
            sendFrame(ws, {
              type: "event",
              event: "chat",
              payload: { runId, state: "delta", deltaText: "Overridden " },
            });
            sendFrame(ws, {
              type: "event",
              event: "chat",
              payload: { runId, state: "delta", deltaText: "to HOLD" },
            });
            sendFrame(ws, {
              type: "event",
              event: "chat",
              payload: {
                runId,
                state: "final",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "Overridden to HOLD" }],
                },
              },
            });
          }
        },
      },
    });

    try {
      const transport = new GatewayTransport({
        url: `ws://127.0.0.1:${server.port}`,
        token: "test-token",
        timeoutMs: 5000,
      });
      const response = await Effect.runPromise(
        transport.sendPrompt("review this pool", makeContext()),
      );

      // The reply is the final chat message, not the deltas or the ack.
      expect(response.raw).toBe("Overridden to HOLD");

      // The connect frame speaks protocol v4 as a cli/cli operator with the shared
      // token — the exact combination that preserves scopes on loopback.
      const connect = received.connect as Record<string, unknown>;
      expect(connect?.minProtocol).toBe(4);
      expect(connect?.maxProtocol).toBe(4);
      expect(connect?.role).toBe("operator");
      expect(connect?.client).toMatchObject({ id: "cli", mode: "cli" });
      expect(connect?.auth).toEqual({ token: "test-token" });
      expect(connect?.scopes).toContain("operator.write");

      // chat.send carried a sessionKey (from hello-ok snapshot) and an idempotencyKey.
      expect(received.chat?.sessionKey).toBe("main");
      expect(typeof received.chat?.idempotencyKey).toBe("string");

      await Effect.runPromise(transport.disconnect());
    } finally {
      server.stop(true);
    }
  });

  it("delivers a check-in as a system-event request", async () => {
    const received: { systemEvent?: Record<string, unknown> | undefined } = {};

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, s) {
        if (s.upgrade(req)) return;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          sendFrame(ws, challenge("nonce-2"));
        },
        message(ws, data) {
          const frame = JSON.parse(String(data)) as Frame;
          if (frame.type !== "req") return;
          if (frame.method === "connect") {
            sendFrame(ws, { type: "res", id: frame.id, ok: true, payload: HELLO_OK });
          } else if (frame.method === "system-event") {
            received.systemEvent = frame.params;
            sendFrame(ws, { type: "res", id: frame.id, ok: true, payload: {} });
          }
        },
      },
    });

    try {
      const transport = new GatewayTransport({
        url: `ws://127.0.0.1:${server.port}`,
        token: "test-token",
        timeoutMs: 5000,
      });
      const checkin: AgentRuntimeCheckin = {
        type: "checkin",
        trigger: "periodic",
        timestamp: Date.now(),
        portfolio: {
          totalValueUsd: 1000,
          unrealizedPnlUsd: 5,
          realizedPnlUsd: 0,
          openPositions: 1,
          maxPositions: 3,
        },
        positions: [],
        recentDecisions: [],
        warnings: [],
        market: { solPriceUsd: 150, gasEstimateSol: 0.01, scanCount: 1, uptimeMs: 1000 },
      };
      await Effect.runPromise(transport.sendCheckin(checkin));

      expect(typeof received.systemEvent?.text).toBe("string");
      expect(String(received.systemEvent?.text)).toContain("Prism check-in (periodic)");

      await Effect.runPromise(transport.disconnect());
    } finally {
      server.stop(true);
    }
  });

  it("surfaces an actionable error when the gateway closes for a missing device identity", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, s) {
        if (s.upgrade(req)) return;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          sendFrame(ws, challenge("nonce-3"));
        },
        message(ws, data) {
          const frame = JSON.parse(String(data)) as Frame;
          if (frame.type === "req" && frame.method === "connect") {
            ws.close(1008, "device identity required");
          }
        },
      },
    });

    try {
      const transport = new GatewayTransport({
        url: `ws://127.0.0.1:${server.port}`,
        token: "",
        timeoutMs: 5000,
      });
      let error: unknown = null;
      try {
        await Effect.runPromise(transport.sendPrompt("review", makeContext()));
      } catch (err) {
        error = err;
      }
      // connect() rejects with the close reason — no reconnect storm, just a clear error.
      expect(error).not.toBeNull();
      expect(String(error)).toContain("1008");
    } finally {
      server.stop(true);
    }
  });

  it("isAvailable returns true when the WebSocket upgrade succeeds", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, s) {
        if (s.upgrade(req)) return;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open() {
          // the probe only needs the upgrade to succeed
        },
        message() {
          // no app frames during the probe
        },
      },
    });

    try {
      const transport = new GatewayTransport({
        url: `ws://127.0.0.1:${server.port}`,
        token: "",
        timeoutMs: 3000,
      });
      const available = await Effect.runPromise(transport.isAvailable());
      expect(available).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  it("connects via the fallback when the gateway omits connect.challenge", async () => {
    // A gateway may omit connect.challenge. The fallback wait is shorter than the
    // connect step's own budget, all inside the overall handshake backstop, so the
    // connect still completes with time for hello-ok (regression: with equal 5s timers
    // the outer deadline raced the challenge wait and aborted the handshake).
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, s) {
        if (s.upgrade(req)) return;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        // Deliberately no connect.challenge on open.
        message(ws, data) {
          const frame = JSON.parse(String(data)) as Frame;
          if (frame.type === "req" && frame.method === "connect") {
            sendFrame(ws, { type: "res", id: frame.id, ok: true, payload: HELLO_OK });
          }
        },
      },
    });

    try {
      const transport = new GatewayTransport({
        url: `ws://127.0.0.1:${server.port}`,
        token: "",
        timeoutMs: 5000,
      });
      await Effect.runPromise(transport.connect());
      await Effect.runPromise(transport.disconnect());
    } finally {
      server.stop(true);
    }
  });
});
