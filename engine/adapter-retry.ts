import { Effect } from "effect";
import { createLogger } from "./logger.js";

const logger = createLogger("adapter-retry");

function isObject(err: unknown): err is Record<string, unknown> {
  return typeof err === "object" && err !== null;
}

function hasCode(err: unknown): err is { readonly code: number } {
  return isObject(err) && "code" in err && typeof err.code === "number";
}

function hasMessage(err: unknown): err is { readonly message: string } {
  return isObject(err) && "message" in err && typeof err.message === "string";
}

const RETRY_AFTER_MAX_MS = 300_000;

export function retryAfterMs(err: unknown): number | undefined {
  if (!isObject(err)) return undefined;
  const headers = err["headers"];
  const response = err["response"];
  const responseHeaders = isObject(response) ? response["headers"] : undefined;
  const getHeader = (value: unknown): string | null => {
    if (!isObject(value)) return null;
    if (typeof value["get"] === "function") {
      const result = (value["get"] as (name: string) => unknown)("retry-after");
      if (typeof result === "string") return result;
    }
    const direct = value["retry-after"] ?? value["Retry-After"];
    if (typeof direct === "string") return direct;
    if (typeof direct === "number") return String(direct);
    return null;
  };
  const header = getHeader(headers) ?? getHeader(responseHeaders);
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, RETRY_AFTER_MAX_MS);
  }
  const retryAt = Date.parse(header);
  if (Number.isFinite(retryAt)) {
    return Math.min(Math.max(0, retryAt - Date.now()), RETRY_AFTER_MAX_MS);
  }
  return undefined;
}

const retryLogState = new Map<string, { lastLoggedAt: number; suppressed: number }>();
const RETRY_LOG_INTERVAL_MS = 10_000;
const RETRY_LOG_MAX_ENTRIES = 512;

function safeErrorMessage(err: unknown): string {
  return String(err)
    .replace(/([?&](?:api[-_]?key|token|authorization)=)[^&\s]+/gi, "$1***")
    .replace(/(Bearer\s+)[^\s]+/gi, "$1***");
}

function logRetry(err: unknown, message: string): void {
  const now = Date.now();
  const key = safeErrorMessage(err);
  const previous = retryLogState.get(key);
  if (previous && now - previous.lastLoggedAt < RETRY_LOG_INTERVAL_MS) {
    previous.suppressed++;
    return;
  }
  const suppressed = previous?.suppressed ?? 0;
  if (!previous && retryLogState.size >= RETRY_LOG_MAX_ENTRIES) {
    const oldest = retryLogState.keys().next().value;
    if (oldest !== undefined) retryLogState.delete(oldest);
  }
  retryLogState.set(key, { lastLoggedAt: now, suppressed: 0 });
  logger.warn(message, {
    error: key,
    ...(suppressed > 0 ? { suppressedRetries: suppressed } : {}),
  });
}

export function isRetriableError(err: unknown): boolean {
  if (hasCode(err) && (err.code === 429 || err.code === -32005)) return true;
  if (hasMessage(err)) {
    const msg = err.message.toLowerCase();
    if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests")) {
      return true;
    }
    if (msg.includes("rpc request timeout")) return true;
  }
  return false;
}

function isRateLimitError(err: unknown): boolean {
  if (hasCode(err) && (err.code === 429 || err.code === -32005)) return true;
  if (hasMessage(err)) {
    const msg = err.message.toLowerCase();
    return msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests");
  }
  return false;
}

// ─── RPC / network error classifier ──────────────────────────────────────────
// Returns true for errors that indicate transient RPC or network unavailability.
// These should trip the circuit breaker; business-logic / validation errors should not.

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ENETUNREACH",
  "EPIPE",
  "EAI_AGAIN",
]);

export function isRpcNetworkError(err: unknown): boolean {
  if (
    isObject(err) &&
    (err["tag"] === "CircuitBreakerOpenError" || err["name"] === "CircuitBreakerOpenError")
  ) {
    return true;
  }

  // Node.js system errors with a code like ECONNREFUSED, ETIMEDOUT, etc.
  if (isObject(err) && typeof err.code === "string" && NETWORK_ERROR_CODES.has(err.code)) {
    return true;
  }

  // HTTP-level: 429 (rate limit) and 5xx (server errors)
  if (
    hasCode(err) &&
    (err.code === 429 || err.code === -32005 || (err.code >= 500 && err.code < 600))
  ) {
    return true;
  }
  if (hasMessage(err)) {
    const msg = err.message.toLowerCase();
    if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests")) {
      return true;
    }
    if (msg.includes("rpc request timeout")) return true;
    if (/HTTP\s+5\d{2}/.test(err.message)) return true;
  }

  // TypeError from fetch when the network request itself fails (no connection)
  if (err instanceof TypeError) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("fetch failed") ||
      msg.includes("network") ||
      msg.includes("econnrefused") ||
      msg.includes("enotfound")
    ) {
      return true;
    }
  }

  return false;
}

export interface RetryOptions {
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly rateLimitBaseDelayMs?: number;
}

const DEFAULT_RETRY_OPTIONS: Required<Omit<RetryOptions, "rateLimitBaseDelayMs">> & {
  readonly rateLimitBaseDelayMs: number;
} = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  rateLimitBaseDelayMs: 5_000,
};

export function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Effect.Effect<T, unknown> {
  return retryEffectWithBackoff(
    Effect.tryPromise({
      try: () => fn(),
      catch: (cause) => cause,
    }),
    opts,
  );
}

export function retryEffectWithBackoff<T>(
  effect: Effect.Effect<T, unknown>,
  opts?: RetryOptions,
): Effect.Effect<T, unknown> {
  const { maxRetries, baseDelayMs, maxDelayMs, rateLimitBaseDelayMs } = {
    ...DEFAULT_RETRY_OPTIONS,
    ...opts,
  };

  const attempt = (attemptNumber: number): Effect.Effect<T, unknown> =>
    effect.pipe(
      Effect.catchAll((err) => {
        if (attemptNumber >= maxRetries || !isRetriableError(err)) {
          return Effect.fail(err);
        }
        const effectiveBase = isRateLimitError(err) ? rateLimitBaseDelayMs : baseDelayMs;
        const exponentialDelay = Math.min(maxDelayMs, effectiveBase * 2 ** attemptNumber);
        const jitter = Math.random() * exponentialDelay * 0.5;
        const delay = Math.max(Math.floor(exponentialDelay + jitter), retryAfterMs(err) ?? 0);
        return Effect.sync(() =>
          logRetry(
            err,
            `Retriable RPC error (attempt ${attemptNumber + 1}/${maxRetries}), retrying in ${delay}ms`,
          ),
        ).pipe(
          Effect.zipRight(Effect.sleep(delay)),
          Effect.zipRight(Effect.suspend(() => attempt(attemptNumber + 1))),
        );
      }),
    );

  return Effect.suspend(() => attempt(0));
}

export class CircuitBreakerOpenError extends Error {
  readonly tag = "CircuitBreakerOpenError";
  constructor(opts: { readonly message: string; readonly cause?: unknown }) {
    super(opts.message);
    this.name = "CircuitBreakerOpenError";
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  readonly failureThreshold?: number;
  readonly resetTimeoutMs?: number;
}

export class CircuitBreaker {
  private state: CircuitBreakerState = "CLOSED";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private halfOpenTrialInFlight = false;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;

  constructor(opts?: CircuitBreakerOptions) {
    this.failureThreshold = opts?.failureThreshold ?? 5;
    this.resetTimeoutMs = opts?.resetTimeoutMs ?? 30000;
  }

  getState(): CircuitBreakerState {
    if (this.state === "OPEN") {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.resetTimeoutMs) {
        this.state = "HALF_OPEN";
      }
    }
    return this.state;
  }

  execute<T>(
    effect: Effect.Effect<T, unknown>,
    isRetriable?: (err: unknown) => boolean,
  ): Effect.Effect<T, unknown> {
    return Effect.gen(this, function* () {
      const current = this.getState();
      if (current === "OPEN") {
        return yield* Effect.fail(
          new CircuitBreakerOpenError({
            message: `Circuit breaker is OPEN — ${this.consecutiveFailures} consecutive failures. Reset in ${Math.max(0, this.resetTimeoutMs - (Date.now() - this.openedAt))}ms`,
          }),
        );
      }
      if (current === "HALF_OPEN" && this.halfOpenTrialInFlight) {
        return yield* Effect.fail(
          new CircuitBreakerOpenError({
            message: "Circuit breaker is HALF_OPEN — a trial is already in flight",
          }),
        );
      }
      if (current === "HALF_OPEN") {
        this.halfOpenTrialInFlight = true;
      }
      return yield* effect.pipe(
        Effect.tap(() => Effect.sync(() => this.onSuccess())),
        Effect.tapError((err) =>
          Effect.sync(() => {
            if (!isRetriable || isRetriable(err)) {
              this.onFailure();
            }
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            this.halfOpenTrialInFlight = false;
          }),
        ),
      );
    });
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "CLOSED";
  }

  private onFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = "OPEN";
      this.openedAt = Date.now();
      logger.warn("Circuit breaker opened", {
        failures: this.consecutiveFailures,
        threshold: this.failureThreshold,
      });
    }
  }

  reset(): void {
    this.state = "CLOSED";
    this.consecutiveFailures = 0;
    this.halfOpenTrialInFlight = false;
  }
}
