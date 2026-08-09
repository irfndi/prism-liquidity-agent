// ─── Jupiter API traffic gate (issue #196 follow-up) ─────────────────────────
// Keyless api.jup.ag enforces ONE rate-limit bucket shared across every
// endpoint (swap/v1/quote, swap/v1/swap, price/v3, tokens/v2): 0.5 RPS
// sustained with an empirically observed ~5-request burst cap (librarian
// verification, 2026-08-09). The agent's startup fan-out (route probes,
// settlement/entry-prep quotes) blew through the burst cap and retry loops
// kept every subsequent request failing — a self-inflicted >13h ban that
// capital-locked the wallet. This gate:
//   1. paces ALL Jupiter traffic to a safe sustained rate (slot
//      reservation, same pattern as the GeckoTerminal 2.1s pacing), and
//   2. opens a process-wide escalating cooldown on 429, honoring the
//      documented x-ratelimit-reset backoff target (no Retry-After header
//      exists). While the cooldown is open every Jupiter request fails fast
//      with a synthetic 429 — zero network traffic, so a ban can never be
//      refreshed by retry loops.

// 0.4 RPS sustained — comfortably under the 0.5 RPS keyless refill rate.
const MIN_JUPITER_REQUEST_INTERVAL_MS = 2_500;
// Ceiling on any single pacing wait: beyond this the slot is treated as
// stale (clock anomaly / cross-isolation state) and reset.
const MAX_JUPITER_SLOT_WAIT_MS = 5 * 60_000;
// Escalating 429 cooldown: 1 min, 2, 4, ... up to 60 min.
const BREAKER_BASE_COOLDOWN_MS = 60_000;
const BREAKER_MAX_COOLDOWN_MS = 60 * 60_000;

let nextJupiterSlotAt = 0;
let breakerCooldownUntil = 0;
let breakerFailures = 0;
// Test knobs (mirror the GeckoTerminal service's setGeckoRequestIntervalMsForTest).
// Under the test environment (NODE_ENV=test / VITEST=true — repo precedent in
// config-service) the interval defaults to 0: the suite mocks global fetch
// and must not pay the pacing wait per call. The jupiter-client tests raise
// it explicitly via setJupiterGateForTest.
const TEST_ENV = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
const DEFAULT_TEST_INTERVAL_MS = TEST_ENV ? 0 : undefined;
let testIntervalMs: number | undefined = DEFAULT_TEST_INTERVAL_MS;
let testBaseCooldownMs: number | undefined;

export interface JupiterGateTestOptions {
  readonly intervalMs?: number;
  readonly baseCooldownMs?: number;
}

/** Test hooks: zero the interval so unit tests are not serialized, and
 *  shrink/expand the breaker cooldown. */
export function setJupiterGateForTest(options: JupiterGateTestOptions): void {
  if (options.intervalMs !== undefined) testIntervalMs = options.intervalMs;
  if (options.baseCooldownMs !== undefined) testBaseCooldownMs = options.baseCooldownMs;
}

export function resetJupiterGateForTest(): void {
  nextJupiterSlotAt = 0;
  breakerCooldownUntil = 0;
  breakerFailures = 0;
  // Restore the environment-derived default (0 under the test env), not the
  // production interval — a reset between tests must not re-serialize the
  // mocked-fetch suite.
  testIntervalMs = DEFAULT_TEST_INTERVAL_MS;
  testBaseCooldownMs = undefined;
}

function intervalMs(): number {
  return testIntervalMs !== undefined ? testIntervalMs : MIN_JUPITER_REQUEST_INTERVAL_MS;
}

function baseCooldownMs(): number {
  return testBaseCooldownMs !== undefined ? testBaseCooldownMs : BREAKER_BASE_COOLDOWN_MS;
}

function syntheticRateLimitedResponse(): Response {
  return new Response(JSON.stringify({ code: 429, message: "[API Gateway] Too many requests" }), {
    status: 429,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The single choke point for every api.jup.ag request in the process.
 * Replace `fetch(url, init)` with `jupiterFetch(url, init)` at Jupiter call
 * sites so pacing and the 429 breaker apply process-wide (the bucket is
 * shared across endpoints — per-site throttles would not protect it).
 */
export async function jupiterFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const signal = init?.signal ?? undefined;
  // Fail fast while the 429 cooldown is open — no network traffic, so a ban
  // cannot be refreshed by retry loops.
  if (Date.now() < breakerCooldownUntil) {
    return syntheticRateLimitedResponse();
  }
  // Pace to the sustained keyless rate. Waiting callers hold NO reservation:
  // the loop sleeps in ≤interval chunks until the slot is free, then claims
  // and sends atomically (single-threaded). Concurrent callers still end up
  // interval-spaced — the first to wake claims and sends, the rest see the
  // advanced counter and wait again — but an aborted waiter leaves nothing
  // behind, so no abandoned slot can queue later callers behind dead
  // reservations.
  while (true) {
    const now = Date.now();
    let waitMs = nextJupiterSlotAt - now;
    // A slot more than 5 minutes out is a clock anomaly (NTP jump back, or
    // stale state across test isolation) — never sleep that long for pacing;
    // a queue that deep is pathological and the 429 breaker should have
    // opened long before it forms.
    if (waitMs > MAX_JUPITER_SLOT_WAIT_MS) {
      nextJupiterSlotAt = now + intervalMs();
      waitMs = 0;
    }
    if (waitMs <= 0) break;
    await sleepWithAbort(Math.min(waitMs, intervalMs()), signal);
    // Re-check after every wake: an EARLIER request may have received a 429
    // and opened the breaker mid-wait (the waiting request must fail fast
    // instead of refreshing the ban), or the caller's signal may have fired.
    if (Date.now() < breakerCooldownUntil) {
      return syntheticRateLimitedResponse();
    }
    if (signal !== undefined && signal.aborted) {
      throw signal.reason ?? new Error("The operation was aborted");
    }
  }
  const slotStart = Date.now();
  nextJupiterSlotAt = slotStart + intervalMs();
  const response = await fetch(input, init);
  if (response.status === 429) {
    // Escalate the cooldown; x-ratelimit-reset (Unix seconds) is the
    // documented backoff target when the oldest in-window request ages out.
    // Clamped: the escalated cooldown is bounded at 60 min, and the header
    // override must be too — a malformed or far-future stamp would otherwise
    // wedge the breaker (no self-heal) for hours or days.
    breakerFailures += 1;
    const cooldownMs = Math.min(
      baseCooldownMs() * 2 ** (breakerFailures - 1),
      BREAKER_MAX_COOLDOWN_MS,
    );
    const resetHeader = response.headers.get("x-ratelimit-reset");
    const resetAtMs = resetHeader === null ? 0 : Number(resetHeader) * 1000;
    const clampedResetAtMs =
      Number.isFinite(resetAtMs) && resetAtMs > 0
        ? Math.min(resetAtMs, Date.now() + BREAKER_MAX_COOLDOWN_MS)
        : 0;
    breakerCooldownUntil = Math.max(Date.now() + cooldownMs, clampedResetAtMs);
  } else if (response.ok && breakerFailures > 0) {
    // Half-open recovery: a success after the cooldown clears the breaker.
    breakerFailures = 0;
    breakerCooldownUntil = 0;
  }
  return response;
}

/** Sleeps for `ms` but resolves early (and re-checks) when `signal` aborts. */
function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const onAbort = (): void => {
    clearTimeout(timer);
    resolve();
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  if (signal !== undefined) {
    if (signal.aborted) {
      clearTimeout(timer);
      return Promise.resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return promise.finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  });
}
