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

export interface HermesApiTransportOptions {
  readonly url: string;
  readonly token: string;
  readonly timeoutMs: number;
}

/**
 * HTTP API transport for Hermes agent.
 *
 * POSTs check-ins and alerts to a Hermes HTTP API endpoint. The prompt path is
 * emulated as a single-turn agent request and the response body is returned as
 * raw text for parsing.
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
          return await fetch(this.options.url, {
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

      const payload = {
        message: prompt,
        context: {
          decision: ctx.decision,
          pool: ctx.pool,
          metrics: ctx.metrics,
        },
      };

      const text = yield* this.post(payload, timeoutMs);
      const latencyMs = Date.now() - startedAt;
      this.emit({ type: "response_received", transport: this.name, latencyMs });

      return { override: null, raw: text, latencyMs };
    });
  }

  sendCheckin(checkin: AgentRuntimeCheckin): Effect.Effect<void, unknown> {
    return this.post({ ...checkin, source: "prism" }).pipe(
      Effect.tap(() => logger.debug("Check-in delivered")),
      Effect.catchAll((err) => {
        logger.warn("Failed to deliver check-in", { error: String(err) });
        return Effect.void;
      }),
    );
  }

  sendAlert(alert: AgentRuntimeAlert): Effect.Effect<void, unknown> {
    return this.post({ ...alert, source: "prism" }).pipe(
      Effect.tap(() => logger.debug("Alert delivered")),
      Effect.catchAll((err) => {
        logger.warn("Failed to deliver alert", { error: String(err) });
        return Effect.void;
      }),
    );
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

  private post(body: unknown, timeoutMs?: number): Effect.Effect<string, unknown> {
    return Effect.tryPromise(async () => {
      const controller = new AbortController();
      const effectiveTimeout = timeoutMs ?? this.options.timeoutMs;
      const timer = setTimeout(() => controller.abort(), effectiveTimeout);
      try {
        const response = await fetch(this.options.url, {
          method: "POST",
          headers: this.authHeaders(),
          body: stringifySafe(body),
          signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
          throw new Error(`Hermes API returned ${response.status}: ${text}`);
        }
        return text;
      } finally {
        clearTimeout(timer);
      }
    });
  }
}
