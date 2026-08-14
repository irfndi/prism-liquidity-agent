import { Effect } from "effect";
import { createLogger } from "./logger.js";
import type { JsonValue } from "./services.js";

const logger = createLogger("adapter-retry");

interface UnknownRecord {
  readonly [key: string]: JsonValue;
}

function isObject<T>(err: T): err is UnknownRecord & T {
  return err !== null && err instanceof Object && !(err instanceof Function);
}

function hasCode<T>(err: T): err is { readonly code: number } & T {
  return isObject(err) && "code" in err && isNumberLike(err.code);
}

function hasMessage<T>(err: T): err is { readonly message: string } & T {
  return isObject(err) && "message" in err && isStringLike(err.message);
}

function isStringLike<T>(value: T): value is string & T {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isNumberLike<T>(value: T): value is number & T {
  return Object.prototype.toString.call(value) === "[object Number]";
}

/** A `Headers#get`-style accessor, after the value's function-ness is verified. */
type HeaderGetter = (name: string) => string;

function isGetter(value: JsonValue | undefined): value is JsonValue & HeaderGetter {
  return Object.prototype.toString.call(value) === "[object Function]";
}

const RETRY_AFTER_MAX_MS = 300_000;

export function retryAfterMs<T>(err: T): number | undefined {
  if (!isObject(err)) return undefined;
  const headers = err["headers"];
  const response = err["response"];
  const responseHeaders = isObject(response) ? response["headers"] : undefined;
  const getHeader = <T>(value: T): string | null => {
    if (!isObject(value)) return null;
    const getter = value["get"];
    if (isGetter(getter)) {
      try {
        // Native `Headers.get` throws "Can only call Headers.get on instances
        // of Headers" when invoked detached (`getter("retry-after")`), so bind
        // `this` back to the headers object. Method-call form is also covered.
        const result = getter.call(value, "retry-after");
        if (isStringLike(result)) return result;
      } catch {
        // Fall through to the direct property lookup on malformed header shapes.
      }
    }
    const direct = value["retry-after"] ?? value["Retry-After"];
    if (isStringLike(direct)) return direct;
    if (isNumberLike(direct)) return String(direct);
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

/** Structured warn payload for a suppressed-retry log line. */
type RetryLogLine = {
  error: string;
  suppressedRetries?: number;
};

function errorMessage<T>(err: T): string {
  if (hasMessage(err)) return err.message;
  if (isObject(err)) {
    try {
      return JSON.stringify(err);
    } catch {
      return String(err as unknown);
    }
  }
  return String(err);
}

export function safeErrorMessage<T>(err: T): string {
  return errorMessage(err)
    .replace(/([?&](?:api[-_]?key|token|authorization)=)[^&\s]+/gi, "$1***")
    .replace(/((?:bearer|basic|digest|token)\s+)[^\s]+/gi, "$1***")
    .replace(/\b(x-api-(?:key|token|secret)|x-auth-token)\s*[:=]\s*[^\s,;]+/gi, "$1: ***")
    .replace(/\b(authorization)\s*[:=]\s*[^\r\n]+/gi, "$1: ***")
    .replace(
      /(?<![?&])(["']?(?:api[-_]?key|secret|password|token|authorization)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
      "$1***",
    )
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1***@");
}

function logRetry<T>(err: T, message: string): void {
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
  const entry: RetryLogLine = { error: key };
  if (suppressed > 0) entry.suppressedRetries = suppressed;
  logger.warn(message, entry);
}

export function isRetriableError<T>(err: T): boolean {
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

function isRateLimitError<T>(err: T): boolean {
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

export function isRpcNetworkError<T>(err: T): boolean {
  if (
    isObject(err) &&
    (err["tag"] === "CircuitBreakerOpenError" || err["name"] === "CircuitBreakerOpenError")
  ) {
    return true;
  }

  // Node.js system errors with a code like ECONNREFUSED, ETIMEDOUT, etc.
  if (isObject(err) && isStringLike(err.code) && NETWORK_ERROR_CODES.has(err.code)) {
    return true;
  }

  // HTTP-level: 429 (rate limit), any other 4xx client error (a provider
  // rejecting the request — e.g. DRPC's "chain is not available on free plan"
  // 400), and 5xx server errors. All of these mean the ENDPOINT cannot serve
  // the request, so the pool should rotate to the next endpoint rather than
  // fail the call on the first dead endpoint.
  if (
    hasCode(err) &&
    (err.code === 429 || err.code === -32005 || (err.code >= 400 && err.code < 600))
  ) {
    return true;
  }
  if (hasMessage(err)) {
    const msg = err.message.toLowerCase();
    if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests")) {
      return true;
    }
    if (msg.includes("rpc request timeout")) return true;
    // web3.js surfaces a non-OK fetch as either "400 Bad Request: ..." (bare
    // status) or "HTTP 502 Bad Gateway"; both are endpoint-level failures.
    if (/(?:^|\s)(?:HTTP\s+)?[45]\d{2}\b/.test(err.message)) return true;
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
): Effect.Effect<T, Error> {
  return retryEffectWithBackoff(
    Effect.tryPromise({
      try: () => fn(),
      // The channel promises Error — normalize non-Error rejections (plain
      // rate-limit objects, primitives) into a real Error, preserving the
      // original value as `cause` so retry metadata stays reachable.
      catch: (cause) => {
        if (cause instanceof Error) return cause;
        const message =
          isObject(cause) &&
          "message" in cause &&
          isStringLike((cause as { message?: unknown }).message)
            ? (cause as { message: string }).message
            : String(cause);
        const normalized = new Error(message, { cause });
        // The retry loop reads rate-limit metadata (headers/response/status)
        // off the rejected value — carry plain-object fields onto the Error.
        if (isObject(cause)) {
          Object.assign(normalized, cause);
        }
        return normalized;
      },
    }),
    opts,
  );
}

export function retryEffectWithBackoff<T, E>(
  effect: Effect.Effect<T, E>,
  opts?: RetryOptions,
): Effect.Effect<T, E> {
  const { maxRetries, baseDelayMs, maxDelayMs, rateLimitBaseDelayMs } = {
    ...DEFAULT_RETRY_OPTIONS,
    ...opts,
  };

  const attempt = (attemptNumber: number): Effect.Effect<T, E> =>
    effect.pipe(
      Effect.catch((err) => {
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
          Effect.andThen(Effect.sleep(delay)),
          Effect.andThen(Effect.suspend(() => attempt(attemptNumber + 1))),
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

  execute<T, E>(
    effect: Effect.Effect<T, E>,
    isRetriable?: (err: E) => boolean,
  ): Effect.Effect<T, CircuitBreakerOpenError | E> {
    return Effect.gen({ self: this }, function* () {
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
