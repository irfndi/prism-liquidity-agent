import { Effect } from "effect";
import { createLogger } from "./logger.js";
import type {
  AgentRuntimeContext,
  AgentRuntimeResponse,
  AgentRuntimeTransport,
  AgentRuntimeEvent,
  AgentRuntimeCheckin,
} from "./agent-transport.js";

const logger = createLogger("GatewayTransport");

export interface GatewayTransportOptions {
  readonly url: string;
  readonly token: string;
  readonly timeoutMs: number;
}

interface GatewayAuthMessage {
  readonly type: "auth";
  readonly token: string;
}

interface GatewayMessage {
  readonly type: "prompt" | "checkin";
  readonly payload: string;
  readonly id: string;
}

export class GatewayTransport implements AgentRuntimeTransport {
  readonly name = "gateway";

  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private eventHandler?: (event: AgentRuntimeEvent) => void;
  private pending = new Map<
    string,
    {
      readonly resolve: (text: string) => void;
      readonly reject: (reason: Error) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();

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
        ws = new WebSocket(this.options.url);

        ws.addEventListener("open", () => {
          clearTimeout(timer);
          try {
            ws?.close();
          } catch {
            // ignore close errors during probe success cleanup
          }
          settle(true);
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
      if (this.ws?.readyState === WebSocket.OPEN) return;
      if (this.connectPromise) return this.connectPromise;

      this.connectPromise = new Promise<void>((resolve, reject) => {
        this.emit({ type: "connecting", transport: this.name });

        let settled = false;
        const settleOk = () => {
          if (settled) return;
          settled = true;
          this.emit({ type: "connected", transport: this.name });
          this.connectPromise = null;
          resolve();
        };
        const settleErr = (err: Error) => {
          if (settled) return;
          settled = true;
          this.emit({ type: "error", transport: this.name, error: err.message });
          this.connectPromise = null;
          this.ws = null;
          reject(err);
        };

        const timer = setTimeout(() => {
          settleErr(new Error("Gateway connection timeout"));
        }, 5_000);

        try {
          this.ws = new WebSocket(this.options.url);

          this.ws.addEventListener("open", () => {
            clearTimeout(timer);
            if (this.options.token && this.ws) {
              try {
                const auth: GatewayAuthMessage = { type: "auth", token: this.options.token };
                this.ws.send(JSON.stringify(auth));
              } catch (err) {
                logger.warn("Failed to send gateway auth token", {
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
            settleOk();
          });

          this.ws.addEventListener("message", (event) => {
            this.handleMessage(String(event.data));
          });

          this.ws.addEventListener("error", () => {
            clearTimeout(timer);
            if (!settled) {
              settleErr(new Error("Gateway WebSocket error"));
            }
          });

          this.ws.addEventListener("close", () => {
            clearTimeout(timer);
            this.emit({ type: "disconnected", transport: this.name });
            if (!settled) {
              settleErr(new Error("Gateway connection closed"));
            }
            this.ws = null;
          });
        } catch (err) {
          clearTimeout(timer);
          settleErr(err instanceof Error ? err : new Error(String(err)));
        }
      });

      return this.connectPromise;
    });
  }

  disconnect(): Effect.Effect<void, unknown> {
    return Effect.sync(() => {
      this.pending.forEach((p) => {
        p.reject(new Error("Gateway disconnected"));
      });
      this.pending.clear();
      if (!this.ws) return;
      this.ws.close();
      this.ws = null;
    });
  }

  sendPrompt(
    prompt: string,
    ctx: AgentRuntimeContext,
  ): Effect.Effect<AgentRuntimeResponse, unknown> {
    return Effect.gen(this, function* () {
      const startedAt = Date.now();
      yield* this.connect();

      this.emit({ type: "prompt_sent", poolAddress: ctx.decision.poolAddress });

      const id = `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const text = yield* this.sendAndWait(id, { type: "prompt", payload: prompt, id });

      const latencyMs = Date.now() - startedAt;
      this.emit({ type: "response_received", transport: this.name, latencyMs });

      return { override: null, raw: text, latencyMs };
    });
  }

  sendCheckin(checkin: AgentRuntimeCheckin): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      yield* this.connect();
      const id = `checkin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      yield* this.sendAndWait(id, {
        type: "checkin",
        payload: JSON.stringify(checkin, null, 2),
        id,
      });
    });
  }

  private sendAndWait(id: string, message: GatewayMessage): Effect.Effect<string, unknown> {
    return Effect.async((resume) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        resume(Effect.fail(new Error("Gateway not connected")));
        return;
      }

      const timer = setTimeout(() => {
        this.pending.delete(id);
        resume(Effect.fail(new Error(`Gateway prompt timeout: ${message.type}`)));
      }, this.options.timeoutMs);

      this.pending.set(id, {
        resolve: (text) => {
          clearTimeout(timer);
          resume(Effect.succeed(text));
        },
        reject: (reason) => {
          clearTimeout(timer);
          resume(Effect.fail(reason));
        },
        timer,
      });

      try {
        this.ws.send(JSON.stringify(message));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        resume(Effect.fail(err));
      }

      return Effect.sync(() => {
        this.pending.delete(id);
        clearTimeout(timer);
      });
    });
  }

  private handleMessage(data: string): void {
    let parsed: { id?: string; text?: string; error?: string } | undefined;
    try {
      parsed = JSON.parse(data) as { id?: string; text?: string; error?: string };
    } catch {
      // Non-JSON messages (binary frames, server broadcasts, partial frames)
      // cannot be correlated with a pending request; drop them safely.
      logger.warn("Gateway received non-JSON message; ignoring", { data: data.slice(0, 200) });
      return;
    }

    if (!parsed || typeof parsed.id !== "string") return;

    const p = this.pending.get(parsed.id);
    if (!p) return;

    this.pending.delete(parsed.id);
    clearTimeout(p.timer);

    if (parsed.error) {
      p.reject(new Error(parsed.error));
    } else {
      p.resolve(parsed.text ?? "");
    }
  }
}
