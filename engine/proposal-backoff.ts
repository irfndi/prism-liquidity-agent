export interface ProposalBackoff {
  readonly failures: number;
  readonly nextProposalAt: number;
}

export interface ProposalBackoffOptions {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly jitter?: number;
}

export function nextProposalBackoff(
  previous: ProposalBackoff | undefined,
  now: number,
  opts: ProposalBackoffOptions,
): ProposalBackoff {
  const failures = (previous?.failures ?? 0) + 1;
  const exponential = Math.min(opts.maxMs, opts.baseMs * 2 ** (failures - 1));
  const jitter = opts.jitter ?? 0.5;
  const jittered = Math.floor(exponential * (1 + Math.random() * jitter));
  return { failures, nextProposalAt: now + Math.min(jittered, opts.maxMs) };
}

export function isProposalBackoffActive(
  backoff: ProposalBackoff | undefined,
  now: number,
): boolean {
  return backoff !== undefined && backoff.nextProposalAt > now;
}

export interface ProposalCircuitBreakerOptions {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
}

export class ProposalCircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  constructor(opts: ProposalCircuitBreakerOptions) {
    this.failureThreshold = opts.failureThreshold;
    this.cooldownMs = opts.cooldownMs;
  }

  recordFailure(now: number): void {
    this.failures++;
    if (this.failures >= this.failureThreshold && this.openedAt === null) {
      this.openedAt = now;
    }
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  isOpen(now: number): boolean {
    if (this.openedAt === null) return false;
    if (now - this.openedAt >= this.cooldownMs) {
      this.openedAt = null;
      this.failures = 0;
      return false;
    }
    return true;
  }

  canTry(now: number): boolean {
    return !this.isOpen(now);
  }

  getState(): { readonly failures: number; readonly open: boolean } {
    return { failures: this.failures, open: this.openedAt !== null };
  }
}
