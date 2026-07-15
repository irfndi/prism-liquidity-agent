import { Effect } from "effect";
import { spawn, type ChildProcess } from "child_process";
import { createLogger } from "./logger.js";
import type {
  AgentRuntimeContext,
  AgentRuntimeResponse,
  AgentRuntimeTransport,
  AgentRuntimeEvent,
  AgentRuntimeCheckin,
} from "./agent-transport.js";

const logger = createLogger("AcpTransport");

interface AcpRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

interface AcpResponse {
  readonly jsonrpc?: "2.0";
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly message: string };
}

interface AcpNotification {
  readonly jsonrpc?: "2.0";
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

export interface AcpTransportOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly timeoutMs: number;
}

export class AcpTransport implements AgentRuntimeTransport {
  readonly name = "acp";

  private process: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (reason: Error) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();
  private sessionId: string | null = null;
  private eventHandler?: (event: AgentRuntimeEvent) => void;
  private buffer = "";
  private sessionText = "";
  private sessionTextResolve: ((text: string) => void) | undefined;

  constructor(private readonly options: AcpTransportOptions) {}

  onEvent(handler: (event: AgentRuntimeEvent) => void): void {
    this.eventHandler = handler;
  }

  private emit(event: AgentRuntimeEvent): void {
    this.eventHandler?.(event);
  }

  isAvailable(): Effect.Effect<boolean, unknown> {
    return Effect.async((resume) => {
      let probe: ChildProcess | null = null;
      let settled = false;

      const settle = (value: boolean) => {
        if (settled) return;
        settled = true;
        resume(Effect.succeed(value));
      };

      const timer = setTimeout(() => {
        probe?.kill("SIGKILL");
        settle(false);
      }, 3_000);

      try {
        probe = spawn(this.options.command, ["--version"], {
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        clearTimeout(timer);
        settle(false);
        return;
      }

      probe.on("close", (code) => {
        clearTimeout(timer);
        settle(code === 0);
      });
      probe.on("error", () => {
        clearTimeout(timer);
        settle(false);
      });

      return Effect.sync(() => {
        clearTimeout(timer);
        probe?.kill("SIGKILL");
      });
    });
  }

  connect(): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      if (this.process) return;

      this.emit({ type: "connecting", transport: this.name });

      this.process = spawn(this.options.command, this.options.args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.process.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
      this.process.stderr?.on("data", (chunk: Buffer) => {
        logger.debug("ACP stderr", { message: chunk.toString("utf-8").trim() });
      });
      this.process.on("error", (err) => {
        logger.error("ACP process error", { error: String(err) });
        this.emit({ type: "error", transport: this.name, error: String(err) });
      });
      this.process.on("close", () => {
        this.emit({ type: "disconnected", transport: this.name });
        this.pending.forEach((p) => p.reject(new Error("ACP process closed")));
        this.pending.clear();
        this.process = null;
        this.sessionId = null;
      });

      try {
        yield* this.request("agent/initialize", {
          protocolVersion: "2025-06-30",
          clientCapabilities: {},
        });

        const session = yield* this.request("agent/session/new", {
          cwd: process.cwd(),
        });
        this.sessionId = (session as { sessionId?: string })?.sessionId ?? null;

        this.emit({ type: "connected", transport: this.name });
      } catch (err) {
        logger.error("ACP handshake failed; tearing down process", { error: String(err) });
        this.process?.kill("SIGTERM");
        this.process = null;
        this.sessionId = null;
        throw err;
      }
    });
  }

  disconnect(): Effect.Effect<void, unknown> {
    return Effect.sync(() => {
      if (!this.process) return;
      this.pending.forEach((p) => {
        p.reject(new Error("Transport disconnected"));
      });
      this.pending.clear();
      this.process.kill("SIGTERM");
      this.process = null;
      this.sessionId = null;
    });
  }

  sendPrompt(
    prompt: string,
    ctx: AgentRuntimeContext,
    timeoutMs?: number,
  ): Effect.Effect<AgentRuntimeResponse, unknown> {
    return Effect.gen(this, function* () {
      const startedAt = Date.now();
      yield* this.ensureSession();

      this.emit({ type: "prompt_sent", poolAddress: ctx.decision.poolAddress });

      const effectiveTimeout = timeoutMs ?? this.options.timeoutMs;
      yield* this.request(
        "agent/session/prompt",
        {
          sessionId: this.sessionId,
          prompt: [{ type: "text", text: prompt }],
        },
        effectiveTimeout,
      );

      const text = yield* this.collectSessionText(ctx.decision.poolAddress, effectiveTimeout);
      const latencyMs = Date.now() - startedAt;
      this.emit({ type: "response_received", transport: this.name, latencyMs });

      return { override: null, raw: text, latencyMs };
    });
  }

  sendCheckin(checkin: AgentRuntimeCheckin): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      yield* this.ensureSession();
      const prompt = `Prism check-in (${checkin.trigger}):\n\n${JSON.stringify(checkin, null, 2)}`;
      yield* this.request("agent/session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: prompt }],
      });
      yield* this.collectSessionText("checkin");
    });
  }

  private ensureSession(): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      if (!this.process) {
        yield* this.connect();
      }
      if (!this.sessionId) {
        const session = yield* this.request("agent/session/new", {
          cwd: process.cwd(),
        });
        this.sessionId = (session as { sessionId?: string })?.sessionId ?? null;
      }
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf-8");
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as AcpResponse | AcpNotification;
        this.handleMessage(msg);
      } catch (err) {
        logger.warn("Failed to parse ACP line", {
          line: line.slice(0, 200),
          error: String(err),
        });
      }
    }
  }

  private handleMessage(msg: AcpResponse | AcpNotification): void {
    if ("id" in msg && typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if ("error" in msg && msg.error) {
        p.reject(new Error(msg.error.message));
      } else {
        p.resolve(msg.result ?? null);
      }
      return;
    }

    if ("method" in msg && msg.method === "client/session.update") {
      const params = msg.params ?? {};
      const updates = (params.updates ?? []) as ReadonlyArray<{
        readonly type?: string;
        readonly content?: { readonly text?: string };
      }>;
      for (const update of updates) {
        if (update.type === "text" && update.content?.text) {
          this.sessionText += update.content.text;
        }
      }
      if (params.stop) {
        this.sessionTextResolve?.(this.sessionText);
      }
    }
  }

  private collectSessionText(
    poolAddress: string,
    timeoutMs?: number,
  ): Effect.Effect<string, unknown> {
    return Effect.async((resume) => {
      this.sessionText = "";
      let timer: ReturnType<typeof setTimeout>;
      this.sessionTextResolve = (text: string) => {
        this.sessionTextResolve = undefined;
        clearTimeout(timer);
        resume(Effect.succeed(text));
      };

      const effectiveTimeout = timeoutMs ?? this.options.timeoutMs;
      timer = setTimeout(() => {
        this.sessionTextResolve = undefined;
        resume(Effect.fail(new Error(`ACP prompt timeout for ${poolAddress}`)));
      }, effectiveTimeout);

      return Effect.sync(() => {
        clearTimeout(timer);
        this.sessionTextResolve = undefined;
      });
    });
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Effect.Effect<unknown, unknown> {
    return Effect.async((resume) => {
      if (!this.process?.stdin) {
        resume(Effect.fail(new Error("ACP transport not connected")));
        return;
      }

      this.requestId += 1;
      const id = this.requestId;
      const req: AcpRequest = { jsonrpc: "2.0", id, method, params };

      const effectiveTimeout = timeoutMs ?? this.options.timeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resume(Effect.fail(new Error(`ACP request timeout: ${method}`)));
      }, effectiveTimeout);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resume(Effect.succeed(value));
        },
        reject: (reason) => {
          clearTimeout(timer);
          resume(Effect.fail(reason));
        },
        timer,
      });

      try {
        this.process.stdin.write(JSON.stringify(req) + "\n");
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
}
