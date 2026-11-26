interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

/** Bounded in-memory TTL cache with single-flight deduplication. */
export class BoundedTtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();

  constructor(private readonly maxEntries: number) {}

  get(key: string, nowMs: number = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= nowMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number, nowMs: number = Date.now()): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: nowMs + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  getOrFetch(
    key: string,
    ttlMs: number,
    fetchValue: () => Promise<T>,
    nowMs: number = Date.now(),
  ): Promise<T> {
    const cached = this.get(key, nowMs);
    if (cached !== undefined) return Promise.resolve(cached);
    const existing = this.inFlight.get(key);
    if (existing !== undefined) return existing;
    const pending = fetchValue()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, pending);
    return pending;
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }
}

/** Process-wide request pacer. Slot reservation is synchronous before await. */
export class RequestPacer {
  private nextAt = 0;

  constructor(public intervalMs: number) {}

  async wait(): Promise<void> {
    const now = Date.now();
    const delayMs = Math.max(0, this.nextAt - now);
    this.nextAt = Math.max(now, this.nextAt) + this.intervalMs;
    if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }

  reset(): void {
    this.nextAt = 0;
  }
}

/** Fail-fast provider breaker; one trial is allowed after the cooldown. */
export class PublicProviderBreaker {
  private consecutiveFailures = 0;
  private openUntil = 0;

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number,
  ) {}

  canTry(nowMs: number = Date.now()): boolean {
    return this.openUntil === 0 || nowMs >= this.openUntil;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openUntil = 0;
  }

  recordFailure(nowMs: number = Date.now()): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.openUntil = nowMs + this.cooldownMs;
    }
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.openUntil = 0;
  }
}
