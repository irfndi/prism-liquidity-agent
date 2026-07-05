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

export function isRetriableError(err: unknown): boolean {
  if (hasCode(err) && err.code === 429) return true;
  if (hasMessage(err) && err.message.includes("429")) return true;
  return false;
}

export interface RetryOptions {
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

export async function retryWithBackoff<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs } = { ...DEFAULT_RETRY_OPTIONS, ...opts };
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries || !isRetriableError(err)) {
        throw lastError;
      }
      const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const jitter = Math.random() * exponentialDelay * 0.5;
      const delay = Math.floor(exponentialDelay + jitter);
      logger.warn(
        `Retriable RPC error (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms`,
        {
          error: String(err),
        },
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
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

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const current = this.getState();
    if (current === "OPEN") {
      throw new CircuitBreakerOpenError({
        message: `Circuit breaker is OPEN — ${this.consecutiveFailures} consecutive failures. Reset in ${Math.max(0, this.resetTimeoutMs - (Date.now() - this.openedAt))}ms`,
      });
    }
    if (current === "HALF_OPEN" && this.halfOpenTrialInFlight) {
      throw new CircuitBreakerOpenError({
        message: `Circuit breaker is HALF_OPEN — a trial is already in flight`,
      });
    }
    if (current === "HALF_OPEN") {
      this.halfOpenTrialInFlight = true;
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    } finally {
      this.halfOpenTrialInFlight = false;
    }
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
