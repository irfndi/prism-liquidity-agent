import { Effect } from "effect";
import { createLogger } from "./logger.js";
import { stringifySafe } from "./bigint-json.js";
import { getCurrentVersion } from "./version.js";
import type {
  AgentRuntimeContext,
  AgentRuntimeResponse,
  AgentRuntimeTransport,
  AgentRuntimeEvent,
  AgentRuntimeCheckin,
} from "./agent-transport.js";

const logger = createLogger("GatewayTransport");

// OpenClaw Gateway protocol constants, source-verified against
// openclaw/openclaw@2d2ddc4 (v2026.7.1). Operator clients must speak protocol >= 4
// and connect as client.id "cli" + client.mode "cli": on a direct-loopback,
// shared-token connection that is the only combination that keeps the self-declared
// scopes (shouldPreserveLocalCliSharedAuthScopes), which chat.send (operator.write)
// and system-event (operator.admin) require.
const GATEWAY_PROTOCOL_VERSION = 4;
const GATEWAY_CLIENT_ID = "cli";
const GATEWAY_CLIENT_MODE = "cli";
const GATEWAY_ROLE = "operator";
const GATEWAY_SCOPES = ["operator.read", "operator.write", "operator.admin"];
const HELLO_OK_TYPE = "hello-ok";
const CONNECT_CHALLENGE_EVENT = "connect.challenge";
const CHAT_EVENT = "chat";
const FALLBACK_SESSION_KEY = "main";
const CONNECT_TIMEOUT_MS = 5_000;
// The challenge normally arrives immediately after upgrade; this is only the fallback
// wait for a gateway that omits it. Keep it shorter than the connect step so a slow or
// omitted challenge still leaves the connect request its full CONNECT_TIMEOUT_MS budget.
const CHALLENGE_TIMEOUT_MS = 3_000;
// Outer backstop for the whole handshake (challenge wait + connect + hello-ok) with
// slack, so the per-phase timeouts below never race this overall deadline.
const HANDSHAKE_TIMEOUT_MS = CHALLENGE_TIMEOUT_MS + CONNECT_TIMEOUT_MS + 2_000;

export interface GatewayTransportOptions {
  readonly url: string;
  readonly token: string;
  readonly timeoutMs: number;
}

interface GatewayErrorShape {
  readonly code?: unknown;
  readonly message?: unknown;
}

interface GatewayResFrame {
  readonly type: "res";
  readonly id: string;
  readonly ok: boolean;
  readonly payload?: unknown;
  readonly error?: GatewayErrorShape;
}

interface GatewayEventFrame {
  readonly type: "event";
  readonly event: string;
  readonly payload?: unknown;
}

interface HelloOkPayload {
  readonly type?: unknown;
  readonly protocol?: unknown;
  readonly snapshot?: { readonly sessionDefaults?: { readonly mainSessionKey?: unknown } };
}

interface PendingRequest {
  readonly resolve: (payload: unknown) => void;
  readonly reject: (reason: Error) => void;
}

interface PendingChatRun {
  readonly resolve: (text: string) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  text: string;
}

interface ChallengeSettle {
  readonly resolve: (nonce: string) => void;
  readonly reject: (reason: Error) => void;
}

export class GatewayTransport implements AgentRuntimeTransport {
  readonly name = "gateway";

  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private eventHandler?: (event: AgentRuntimeEvent) => void;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly chatRuns = new Map<string, PendingChatRun>();
  private challengeSettle: ChallengeSettle | null = null;
  private sessionKey: string = FALLBACK_SESSION_KEY;

  constructor(private readonly options: GatewayTransportOptions) {}

  onEvent(handler: (event: AgentRuntimeEvent) => void): void {
    this.eventHandler = handler;
  }

  private emit(event: AgentRuntimeEvent): void {
    this.eventHandler?.(event);
  }

  isAvailable(): Effect.Effect<boolean, unknown> {
    return Effect.async((resume) => {
      let ws: WebSocket | null = null;
      let settled = false;

      const settle = (value: boolean) => {
        if (settled) return;
        settled = true;
        resume(Effect.succeed(value));
      };
      const timer = setTimeout(() => {
        try {
          ws?.close();
        } catch {
          // ignore close errors during probe timeout cleanup
        }
        settle(false);
      }, 3_000);

      try {
        // Bun's WebSocket takes an options object as the 2nd arg; pass the token on
        // the upgrade so gateways that reject unauthenticated upgrades answer. The WS
        // upgrade succeeds before any app-level handshake, so settle on "open".
        ws = this.options.token
          ? new WebSocket(this.options.url, {
              headers: { Authorization: `Bearer ${this.options.token}` },
            })
          : new WebSocket(this.options.url);

        ws.addEventListener("open", () => {
          clearTimeout(timer);
          // Settle BEFORE closing: Bun dispatches the close listener synchronously
          // during ws.close(), so settle(false) from the close handler would win
          // if close() ran first.
          settle(true);
          try {
            ws?.close();
          } catch {
            // ignore close errors during probe success cleanup
          }
        });
        ws.addEventListener("error", () => {
          clearTimeout(timer);
          settle(false);
        });
        ws.addEventListener("close", () => {
          clearTimeout(timer);
          settle(false);
        });
      } catch {
        clearTimeout(timer);
        settle(false);
      }

      return Effect.sync(() => {
        clearTimeout(timer);
        try {
          ws?.close();
        } catch {
          // ignore close errors during Effect cancellation cleanup
        }
      });
    });
  }

  connect(): Effect.Effect<void, unknown> {
    return Effect.tryPromise(async () => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
      if (this.connectPromise) return this.connectPromise;
      this.connectPromise = this.openAndHandshake();
      try {
        await this.connectPromise;
      } finally {
        this.connectPromise = null;
      }
    });
  }

  disconnect(): Effect.Effect<void, unknown> {
    return Effect.sync(() => {
      this.rejectAll(new Error("Gateway disconnected"));
      if (!this.ws) return;
      try {
        this.ws.close();
      } catch {
        // ignore close errors during teardown
      }
      this.ws = null;
    });
  }

  sendPrompt(
    prompt: string,
    ctx: AgentRuntimeContext,
    timeoutMs?: number,
  ): Effect.Effect<AgentRuntimeResponse, unknown> {
    return Effect.gen(this, function* () {
      yield* this.connect();
      this.emit({ type: "prompt_sent", poolAddress: ctx.decision.poolAddress });

      const startedAt = Date.now();
      const effectiveTimeout = timeoutMs ?? this.options.timeoutMs;
      const text = yield* Effect.tryPromise(() => this.sendChat(prompt, effectiveTimeout));

      const latencyMs = Date.now() - startedAt;
      this.emit({ type: "response_received", transport: this.name, latencyMs });
      return { override: null, raw: text, latencyMs };
    });
  }

  sendCheckin(checkin: AgentRuntimeCheckin): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      yield* this.connect();
      const text = `Prism check-in (${checkin.trigger}) @ ${new Date(checkin.timestamp).toISOString()}\n${stringifySafe(checkin, 2)}`;
      yield* Effect.tryPromise(() => this.request("system-event", { text }));
    });
  }

  // ─── Handshake ───────────────────────────────────────────────────────────────

  private openAndHandshake(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.emit({ type: "connecting", transport: this.name });

      let ws: WebSocket;
      try {
        ws = this.options.token
          ? new WebSocket(this.options.url, {
              headers: { Authorization: `Bearer ${this.options.token}` },
            })
          : new WebSocket(this.options.url);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.emit({ type: "error", transport: this.name, error: message });
        reject(err instanceof Error ? err : new Error(message));
        return;
      }
      this.ws = ws;

      let settled = false;
      let connectTimer: ReturnType<typeof setTimeout>;
      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        this.emit({ type: "connected", transport: this.name });
        resolve();
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        this.emit({ type: "error", transport: this.name, error: err.message });
        // Tear down the half-open socket; the close handler clears client state.
        try {
          ws.close();
        } catch {
          // ignore close errors during handshake failure teardown
        }
        reject(err);
      };
      connectTimer = setTimeout(
        () => fail(new Error("Gateway connect timeout")),
        HANDSHAKE_TIMEOUT_MS,
      );

      ws.addEventListener("open", () => {
        // Wait for the server's connect.challenge (token auth does not need the
        // nonce, but match the reference client's ordering; fall back to connecting
        // if no challenge arrives so token-only gateways still work).
        this.awaitChallenge(CHALLENGE_TIMEOUT_MS)
          .then(() => this.request("connect", this.buildConnectParams(), CONNECT_TIMEOUT_MS))
          .then((payload) => {
            const hello = (payload ?? {}) as HelloOkPayload;
            if (hello.type !== HELLO_OK_TYPE) {
              throw new Error("Gateway rejected connect: expected hello-ok");
            }
            if (typeof hello.protocol === "number" && hello.protocol < GATEWAY_PROTOCOL_VERSION) {
              throw new Error(
                `Gateway protocol ${hello.protocol} is below required ${GATEWAY_PROTOCOL_VERSION}; update the gateway to >= 2026.7.1`,
              );
            }
            const mainSessionKey = hello.snapshot?.sessionDefaults?.mainSessionKey;
            this.sessionKey =
              typeof mainSessionKey === "string" ? mainSessionKey : FALLBACK_SESSION_KEY;
            succeed();
          })
          .catch((err) => fail(err instanceof Error ? err : new Error(String(err))));
      });

      ws.addEventListener("message", (event) => {
        const data = (event as MessageEvent).data;
        try {
          this.onMessage(String(data));
        } catch (err) {
          logger.warn("Gateway message handling error", { error: String(err) });
        }
      });

      ws.addEventListener("error", () => fail(new Error("Gateway WebSocket error")));

      ws.addEventListener("close", (event) => {
        const closeEvent = event as CloseEvent;
        this.emit({ type: "disconnected", transport: this.name });
        this.ws = null;
        const message = this.describeClose(closeEvent);
        this.rejectAll(new Error(message));
        fail(new Error(message));
      });
    });
  }

  private buildConnectParams(): Record<string, unknown> {
    return {
      minProtocol: GATEWAY_PROTOCOL_VERSION,
      maxProtocol: GATEWAY_PROTOCOL_VERSION,
      client: {
        id: GATEWAY_CLIENT_ID,
        version: getCurrentVersion(),
        platform: process.platform,
        mode: GATEWAY_CLIENT_MODE,
        instanceId: "prism-dlmm",
      },
      role: GATEWAY_ROLE,
      scopes: GATEWAY_SCOPES,
      auth: this.options.token ? { token: this.options.token } : {},
    };
  }

  private awaitChallenge(timeoutMs: number): Promise<string | null> {
    return new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.challengeSettle = null;
        resolve(null);
      }, timeoutMs);
      this.challengeSettle = {
        resolve: (nonce) => {
          clearTimeout(timer);
          this.challengeSettle = null;
          resolve(nonce);
        },
        reject: (err) => {
          clearTimeout(timer);
          this.challengeSettle = null;
          reject(err);
        },
      };
    });
  }

  private describeClose(event: CloseEvent): string {
    const reason = event.reason?.trim();
    if (reason) return `Gateway closed (${event.code}): ${reason}`;
    if (event.code === 1008) {
      return "Gateway closed (1008): policy violation — set AGENT_GATEWAY_TOKEN or pair a device";
    }
    return `Gateway closed (${event.code})`;
  }

  // ─── App layer ───────────────────────────────────────────────────────────────

  private async sendChat(message: string, timeoutMs: number): Promise<string> {
    const id = crypto.randomUUID();
    const runPromise = this.registerChatRun(id, timeoutMs);
    try {
      // chat.send returns an ack res (status "started"); the reply streams back as
      // "chat" events keyed by runId (== our idempotencyKey), terminating on final.
      await this.request(
        "chat.send",
        { sessionKey: this.sessionKey, message, idempotencyKey: id },
        timeoutMs,
        id,
      );
      return await runPromise;
    } finally {
      this.cleanupChatRun(id);
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
    id: string = crypto.randomUUID(),
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        reject(new Error("Gateway not connected"));
        return;
      }
      const effectiveTimeout = timeoutMs ?? this.options.timeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gateway request timeout: ${method}`));
      }, effectiveTimeout);
      this.pending.set(id, {
        resolve: (payload) => {
          clearTimeout(timer);
          this.pending.delete(id);
          resolve(payload);
        },
        reject: (err) => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        },
      });
      try {
        this.ws.send(JSON.stringify({ type: "req", id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private registerChatRun(id: string, timeoutMs: number): Promise<string> {
    let resolveRun: (text: string) => void = () => {};
    let rejectRun: (err: Error) => void = () => {};
    const promise = new Promise<string>((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });
    const timer = setTimeout(() => {
      this.chatRuns.delete(id);
      rejectRun(new Error("Gateway chat run timeout"));
    }, timeoutMs);
    this.chatRuns.set(id, { resolve: resolveRun, reject: rejectRun, timer, text: "" });
    return promise;
  }

  private settleChatRun(id: string, text: string): void {
    const run = this.chatRuns.get(id);
    if (!run) return;
    clearTimeout(run.timer);
    this.chatRuns.delete(id);
    run.resolve(text);
  }

  private failChatRun(id: string, err: Error): void {
    const run = this.chatRuns.get(id);
    if (!run) return;
    clearTimeout(run.timer);
    this.chatRuns.delete(id);
    run.reject(err);
  }

  private cleanupChatRun(id: string): void {
    const run = this.chatRuns.get(id);
    if (!run) return;
    clearTimeout(run.timer);
    this.chatRuns.delete(id);
  }

  // ─── Inbound frame dispatch ──────────────────────────────────────────────────

  private onMessage(data: string): void {
    let frame: { type?: unknown };
    try {
      frame = JSON.parse(data) as { type?: unknown };
    } catch {
      logger.warn("Gateway received non-JSON frame; ignoring", { data: data.slice(0, 160) });
      return;
    }

    if (frame.type === "res") {
      this.handleRes(frame as unknown as GatewayResFrame);
    } else if (frame.type === "event") {
      this.handleEvent(frame as unknown as GatewayEventFrame);
    }
  }

  private handleRes(frame: GatewayResFrame): void {
    const pendingRequest = this.pending.get(frame.id);
    if (!pendingRequest) return;
    this.pending.delete(frame.id);
    if (frame.ok) {
      pendingRequest.resolve(frame.payload);
      return;
    }
    const code = typeof frame.error?.code === "string" ? frame.error.code : "ERROR";
    const message =
      typeof frame.error?.message === "string" ? frame.error.message : "request failed";
    pendingRequest.reject(new Error(`Gateway ${code}: ${message}`));
  }

  private handleEvent(frame: GatewayEventFrame): void {
    if (frame.event === CONNECT_CHALLENGE_EVENT) {
      const payload = (frame.payload ?? {}) as { nonce?: unknown };
      this.challengeSettle?.resolve(typeof payload.nonce === "string" ? payload.nonce : "");
      return;
    }
    if (frame.event === CHAT_EVENT) {
      this.handleChatEvent(frame.payload);
      return;
    }
    // "tick" heartbeats and other events need no action; Bun answers WS-level pings
    // so the socket stays alive without a client-side keepalive loop.
  }

  private handleChatEvent(payload: unknown): void {
    const p = (payload ?? {}) as {
      runId?: unknown;
      state?: unknown;
      deltaText?: unknown;
      message?: unknown;
      error?: unknown;
    };
    const runId = typeof p.runId === "string" ? p.runId : null;
    if (!runId || !this.chatRuns.has(runId)) return;

    if (p.state === "delta") {
      const run = this.chatRuns.get(runId);
      if (run && typeof p.deltaText === "string") run.text += p.deltaText;
      return;
    }
    if (p.state === "final") {
      const message = (p.message ?? {}) as { content?: unknown };
      const content = Array.isArray(message.content) ? message.content : [];
      const first = content[0] as { text?: unknown } | undefined;
      const finalText =
        first && typeof first.text === "string"
          ? first.text
          : (this.chatRuns.get(runId)?.text ?? "");
      this.settleChatRun(runId, finalText);
      return;
    }
    if (p.state === "error") {
      const err = (p.error ?? {}) as { message?: unknown };
      this.failChatRun(
        runId,
        new Error(typeof err.message === "string" ? err.message : "agent run error"),
      );
      return;
    }
    if (p.state === "aborted") {
      this.failChatRun(runId, new Error("agent run aborted"));
    }
  }

  private rejectAll(err: Error): void {
    for (const pendingRequest of this.pending.values()) pendingRequest.reject(err);
    this.pending.clear();
    for (const run of this.chatRuns.values()) {
      clearTimeout(run.timer);
      run.reject(err);
    }
    this.chatRuns.clear();
    if (this.challengeSettle) {
      const settle = this.challengeSettle;
      this.challengeSettle = null;
      settle.reject(err);
    }
  }
}
