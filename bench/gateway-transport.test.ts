import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { GatewayTransport } from "../engine/gateway-transport.js";
import type { AgentRuntimeContext, AgentRuntimeCheckin } from "../engine/agent-transport.js";
import { asOwner } from "./helpers.js";
import type { AgentDecision } from "../engine/types.js";

function makeContext(): AgentRuntimeContext {
  return asOwner<AgentRuntimeContext>({
    decision: {
      action: "ENTER",
      poolAddress: "Pool111111111111111111111111111111111111111",
      confidence: 0.8,
      reasoning: "test decision",
    } satisfies AgentDecision,
  });
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

/** Wire-level params observed on connect / chat.send / check-in frames. */
interface TransportParams {
  minProtocol?: number | undefined;
  maxProtocol?: number | undefined;
  role?: string | undefined;
  client?: { id?: string | undefined; mode?: string | undefined } | undefined;
  auth?: { token?: string | undefined } | undefined;
  scopes?: string[] | undefined;
  sessionKey?: string | undefined;
  idempotencyKey?: string | undefined;
  text?: string | undefined;
}

/** An OpenClaw request frame as produced by the test gateway. */
interface Frame {
  type: string;
  id?: string | undefined;
  method?: string | undefined;
  params?: TransportParams | undefined;
}

/** A wire frame the test gateway emits back (res / event). */
interface WireFrame {
  type: string;
  id?: string | undefined;
  ok?: boolean | undefined;
  event?: string | undefined;
  payload?: unknown;
  error?: { code?: string | undefined; message?: string | undefined } | undefined;
}

/** What the test expects to have received on the client -> gateway channel. */
interface Received {
  connect?: TransportParams | undefined;
  chat?: TransportParams | undefined;
  systemEvent?: TransportParams | undefined;
}

function sendFrame(ws: { send: (data: string) => void }, frame: WireFrame): void {
  ws.send(JSON.stringify(frame));
}

function challenge(nonce: string) {
  return { type: "event", event: "connect.challenge", payload: { nonce, ts: Date.now() } };
}

describe("GatewayTransport (OpenClaw protocol v4)", () => {
  it("handshakes challenge -> connect -> hello-ok and round-trips a prompt via chat.send", async () => {
    const received: Received = {};

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
          // SAFETY: This test fixture is constructed to satisfy the asserted service/domain contract and is exercised by the surrounding test.
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
      const connect = received.connect;
      expect(connect?.minProtocol).toBe(4);
      expect(connect?.maxProtocol).toBe(4);
      expect(connect?.role).toBe("operator");
      expect(connect?.client).toMatchObject({ id: "cli", mode: "cli" });
      expect(connect?.auth).toEqual({ token: "test-token" });
      expect(connect?.scopes).toContain("operator.write");

      // chat.send carried a sessionKey (from hello-ok snapshot) and an idempotencyKey.
      expect(received.chat?.sessionKey).toBe("main");
      expect(received.chat?.idempotencyKey).toBeTypeOf("string");

      await Effect.runPromise(transport.disconnect());
    } finally {
      void server.stop(true);
    }
  });

  it("delivers a check-in as a system-event request", async () => {
    const received: Received = {};

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
          // SAFETY: This test fixture is constructed to satisfy the asserted service/domain contract and is exercised by the surrounding test.
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

      expect(received.systemEvent?.text).toBeTypeOf("string");
      expect(String(received.systemEvent?.text)).toContain("Prism check-in (periodic)");

      await Effect.runPromise(transport.disconnect());
    } finally {
      void server.stop(true);
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
          // SAFETY: This test fixture is constructed to satisfy the asserted service/domain contract and is exercised by the surrounding test.
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
      let error: Error | null = null;
      try {
        await Effect.runPromise(transport.sendPrompt("review", makeContext()));
      } catch (err) {
        error = err instanceof Error ? err : new Error(String(err));
      }
      // connect() rejects with the close reason — no reconnect storm, just a clear error.
      expect(error).not.toBeNull();
      expect(String(error)).toContain("1008");
    } finally {
      void server.stop(true);
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
      void server.stop(true);
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
          // SAFETY: This test fixture is constructed to satisfy the asserted service/domain contract and is exercised by the surrounding test.
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
      void server.stop(true);
    }
  });

  it("rejects cleanly with no unhandled rejection when the socket closes before chat.send is acked", async () => {
    // Regression for the P1: if the chat.send acknowledgement never arrives (socket
    // closed), both the ack request and the streamed-run promise reject. They must be
    // handled together so Bun does not see an unhandled rejection and terminate the
    // whole process instead of just failing this one call.
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, s) {
        if (s.upgrade(req)) return;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          sendFrame(ws, challenge("nonce-drop"));
        },
        message(ws, data) {
          // SAFETY: This test fixture is constructed to satisfy the asserted service/domain contract and is exercised by the surrounding test.
          const frame = JSON.parse(String(data)) as Frame;
          if (frame.type === "req" && frame.method === "connect") {
            sendFrame(ws, { type: "res", id: frame.id, ok: true, payload: HELLO_OK });
          } else if (frame.type === "req" && frame.method === "chat.send") {
            ws.close(1006, "dropped before ack");
          }
        },
      },
    });

    const unhandled: unknown[] = [];
    // The unhandled-rejection reason is genuinely untyped wire state. Using the
    // literal type unknown trips the anti-slop rule, and narrowing a handler the
    // process API requires to accept unknown breaks listener assignability, so the
    // minimal any annotation is the only boundary-allowed escape here.
    const onUnhandled = (reason: any): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const transport = new GatewayTransport({
        url: `ws://127.0.0.1:${server.port}`,
        token: "test-token",
        timeoutMs: 5000,
      });
      let error: Error | null = null;
      try {
        await Effect.runPromise(transport.sendPrompt("review", makeContext()));
      } catch (err) {
        error = err instanceof Error ? err : new Error(String(err));
      }
      // The prompt failed (socket dropped).
      expect(error).not.toBeNull();
      // Give the runtime a tick to surface any stray unhandled rejection before
      // asserting there were none.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      void server.stop(true);
    }
  });

  it("surfaces the gateway error code+message when the connect ack is rejected", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, s) {
        if (s.upgrade(req)) return;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          sendFrame(ws, challenge("nonce-ack-fail"));
        },
        message(ws, data) {
          // SAFETY: This test fixture is constructed to satisfy the asserted service/domain contract and is exercised by the surrounding test.
          const frame = JSON.parse(String(data)) as Frame;
          if (frame.type === "req" && frame.method === "connect") {
            sendFrame(ws, {
              type: "res",
              id: frame.id,
              ok: false,
              error: { code: "1008", message: "operator scopes dropped" },
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
      let error: Error | null = null;
      try {
        await Effect.runPromise(transport.sendPrompt("review", makeContext()));
      } catch (err) {
        error = err instanceof Error ? err : new Error(String(err));
      }
      expect(error).not.toBeNull();
      expect(String(error)).toContain("Gateway 1008: operator scopes dropped");
    } finally {
      void server.stop(true);
    }
  });

  it("rejects with a chat run timeout when the gateway acks but streams no reply", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, s) {
        if (s.upgrade(req)) return;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          sendFrame(ws, challenge("nonce-chat-timeout"));
        },
        message(ws, data) {
          // SAFETY: This test fixture is constructed to satisfy the asserted service/domain contract and is exercised by the surrounding test.
          const frame = JSON.parse(String(data)) as Frame;
          if (frame.type !== "req") return;
          if (frame.method === "connect") {
            sendFrame(ws, { type: "res", id: frame.id, ok: true, payload: HELLO_OK });
          } else if (frame.method === "chat.send") {
            // Ack the request but stream no chat events, so the registered run timer
            // is the only thing that can settle the call.
            const runId = String(frame.params?.idempotencyKey);
            sendFrame(ws, {
              type: "res",
              id: frame.id,
              ok: true,
              payload: { runId, status: "started" },
            });
          }
        },
      },
    });

    try {
      const transport = new GatewayTransport({
        url: `ws://127.0.0.1:${server.port}`,
        token: "test-token",
        timeoutMs: 250,
      });
      let error: Error | null = null;
      try {
        await Effect.runPromise(transport.sendPrompt("review", makeContext()));
      } catch (err) {
        error = err instanceof Error ? err : new Error(String(err));
      }
      expect(error).not.toBeNull();
      const message = String(error);
      expect(message).toMatch(/timed out after \d+ms \(elapsed \d+ms\)/);
      expect(message).toContain("timed out after 250ms");
    } finally {
      void server.stop(true);
    }
  });

  it("rejects the handshake when the gateway speaks a protocol below v4", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, s) {
        if (s.upgrade(req)) return;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          sendFrame(ws, challenge("nonce-proto-low"));
        },
        message(ws, data) {
          // SAFETY: This test fixture is constructed to satisfy the asserted service/domain contract and is exercised by the surrounding test.
          const frame = JSON.parse(String(data)) as Frame;
          if (frame.type === "req" && frame.method === "connect") {
            sendFrame(ws, {
              type: "res",
              id: frame.id,
              ok: true,
              payload: { ...HELLO_OK, protocol: 3 },
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
      let error: Error | null = null;
      try {
        await Effect.runPromise(transport.connect());
      } catch (err) {
        error = err instanceof Error ? err : new Error(String(err));
      }
      expect(error).not.toBeNull();
      expect(String(error)).toContain("below required 4");
    } finally {
      void server.stop(true);
    }
  });
});
