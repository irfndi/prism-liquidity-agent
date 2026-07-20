import { Effect } from "effect";
import { createLogger } from "./logger.js";
import { stringifySafe } from "./bigint-json.js";
import type {
  AgentRuntimeCheckin,
  AgentRuntimeContext,
  AgentRuntimeResponse,
  AgentRuntimeTransport,
  AgentRuntimeEvent,
  AgentRuntimeAlert,
} from "./agent-transport.js";

const logger = createLogger("HermesApiTransport");

// Hermes Agent exposes an OpenAI-compatible HTTP API (see Hermes' API server docs).
// The agent model is registered under this name.
const HERMES_MODEL = "hermes-agent";

export interface HermesApiTransportOptions {
  /** Base URL of the Hermes API server, e.g. `http://localhost:8642` (no trailing path). */
  readonly url: string;
  readonly token: string;
  readonly timeoutMs: number;
}

/**
 * HTTP API transport for the Hermes agent.
 *
 * Speaks Hermes' OpenAI-compatible API: requests go to `POST /v1/chat/completions`
 * as `{model: "hermes-agent", messages: [{role: "user", content}], stream: false}`
 * and the reply is read from `choices[0].message.content`. `options.url` is the API
 * server base (e.g. `http://localhost:8642`); the auth token is sent as a Bearer
 * header (`API_SERVER_KEY` on the Hermes side). Check-ins and alerts are delivered
 * as one-shot user messages (best-effort; the API is a chat surface, not an event sink).
 */
export class HermesApiTransport implements AgentRuntimeTransport {
  readonly name = "hermes-api";

  private eventHandler?: (event: AgentRuntimeEvent) => void;

  constructor(private readonly options: HermesApiTransportOptions) {}

  onEvent(handler: (event: AgentRuntimeEvent) => void): void {
    this.eventHandler = handler;
  }

  private emit(event: AgentRuntimeEvent): void {
    this.eventHandler?.(event);
  }

  isAvailable(): Effect.Effect<boolean, unknown> {
    return Effect.gen(this, function* () {
      const response = yield* Effect.tryPromise(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
        try {
          return await fetch(this.apiUrl("health"), {
            method: "GET",
            headers: this.authHeaders(),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      }).pipe(Effect.catchAll(() => Effect.succeed(null)));

      return response != null && response.status < 500;
    });
  }

  connect(): Effect.Effect<void, unknown> {
    this.emit({ type: "connected", transport: this.name });
    return Effect.void;
  }

  disconnect(): Effect.Effect<void, unknown> {
    this.emit({ type: "disconnected", transport: this.name });
    return Effect.void;
  }

  sendPrompt(
    prompt: string,
    ctx: AgentRuntimeContext,
    timeoutMs?: number,
  ): Effect.Effect<AgentRuntimeResponse, unknown> {
    return Effect.gen(this, function* () {
      this.emit({ type: "prompt_sent", poolAddress: ctx.decision.poolAddress });
      const startedAt = Date.now();

      const text = yield* this.chatCompletion(prompt, timeoutMs);
      const latencyMs = Date.now() - startedAt;
      this.emit({ type: "response_received", transport: this.name, latencyMs });

      return { override: null, raw: text, latencyMs };
    });
  }

  sendCheckin(checkin: AgentRuntimeCheckin): Effect.Effect<void, unknown> {
    const content = `Prism check-in (${checkin.trigger}):\n\n${stringifySafe(checkin, 2)}`;
    return this.chatCompletion(content).pipe(
      Effect.tap(() => logger.debug("Check-in delivered")),
      Effect.catchAll((err) => {
        logger.warn("Failed to deliver check-in", { error: String(err) });
        return Effect.void;
      }),
    );
  }

  sendAlert(alert: AgentRuntimeAlert): Effect.Effect<void, unknown> {
    const content = `Prism alert [${alert.severity}/${alert.category}] ${alert.tokenPair} (${alert.pool}): ${alert.message}`;
    return this.chatCompletion(content).pipe(
      Effect.tap(() => logger.debug("Alert delivered")),
      Effect.catchAll((err) => {
        logger.warn("Failed to deliver alert", { error: String(err) });
        return Effect.void;
      }),
    );
  }

  private apiUrl(segment: string): string {
    return `${this.options.url.replace(/\/+$/, "")}/${segment}`;
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.options.token) {
      headers.Authorization = `Bearer ${this.options.token}`;
    }
    return headers;
  }

  private chatCompletion(content: string, timeoutMs?: number): Effect.Effect<string, unknown> {
    return Effect.tryPromise(async () => {
      const controller = new AbortController();
      const effectiveTimeout = timeoutMs ?? this.options.timeoutMs;
      const timer = setTimeout(() => controller.abort(), effectiveTimeout);
      try {
        const response = await fetch(this.apiUrl("v1/chat/completions"), {
          method: "POST",
          headers: this.authHeaders(),
          body: stringifySafe({
            model: HERMES_MODEL,
            messages: [{ role: "user", content }],
            stream: false,
          }),
          signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
          throw new Error(`Hermes API returned ${response.status}: ${text}`);
        }
        return parseChatContent(text);
      } finally {
        clearTimeout(timer);
      }
    });
  }
}

function parseChatContent(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      choices?: ReadonlyArray<{ message?: { content?: string } }>;
    };
    return parsed.choices?.[0]?.message?.content ?? body;
  } catch {
    return body;
  }
}
