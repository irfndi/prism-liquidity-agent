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
/** Clamp the x-ratelimit-reset backoff target so a malformed or far-future
 *  stamp can never wedge the breaker (no self-heal) for hours or days. */
function clampedResetMs(resetHeader: string | null): number {
  if (resetHeader === null) return 0;
  const resetAtMs = Number(resetHeader) * 1000;
  if (!Number.isFinite(resetAtMs) || resetAtMs <= 0) return 0;
  return Math.min(resetAtMs, Date.now() + BREAKER_MAX_COOLDOWN_MS);
}

/** Escalate the cooldown on 429 (x-ratelimit-reset is the documented backoff
 *  target); a success after the cooldown clears the breaker (half-open). */
function recordJupiterResponse(response: Response): void {
  if (response.status === 429) {
    breakerFailures += 1;
    const cooldownMs = Math.min(
      baseCooldownMs() * 2 ** (breakerFailures - 1),
      BREAKER_MAX_COOLDOWN_MS,
    );
    breakerCooldownUntil = Math.max(
      Date.now() + cooldownMs,
      clampedResetMs(response.headers.get("x-ratelimit-reset")),
    );
    return;
  }
  if (response.ok && breakerFailures > 0) {
    breakerFailures = 0;
    breakerCooldownUntil = 0;
  }
}

/**
 * Pace to the sustained keyless rate. Slots are claimed SYNCHRONOUSLY at
 * call time (single-threaded: the sync prefix runs atomically), so
 * concurrent callers fan out to distinct slots instead of bursting. An
 * aborted tail waiter releases its slot, so no abandoned reservation queues
 * later callers behind dead air. Returns the synthetic 429 when the breaker
 * opened mid-wait, null once the caller owns the slot and may send.
 */
function claimJupiterSlot() {
  const now = Date.now();
  const slotAt = Math.max(now, nextJupiterSlotAt);
  // A slot more than 5 minutes out is a clock anomaly (NTP jump back, or
  // stale state across test isolation) — never sleep that long for pacing;
  // a queue that deep is pathological and the 429 breaker should have
  // opened long before it forms.
  if (slotAt - now > MAX_JUPITER_SLOT_WAIT_MS) {
    nextJupiterSlotAt = now + intervalMs();
    return { slotAt: now, waitMs: 0 };
  }
  nextJupiterSlotAt = slotAt + intervalMs();
  return { slotAt, waitMs: slotAt - now };
}

/** Release a tail reservation (aborted waiters must not strand later callers). */
function releaseJupiterSlot(slotAt: number): void {
  if (nextJupiterSlotAt === slotAt + intervalMs()) {
    nextJupiterSlotAt = slotAt;
  }
}

async function waitJupiterSlot(
  slotAt: number,
  waitMs: number,
  signal: AbortSignal | undefined,
): Promise<Response | null> {
  if (waitMs <= 0) return null;
  // Re-check after every wake: an EARLIER request may have received a 429
  // and opened the breaker mid-wait (the waiting request must fail fast
  // instead of refreshing the ban), or the caller's signal may have fired.
  await sleepWithAbort(Math.min(waitMs, intervalMs()), signal);
  if (Date.now() < breakerCooldownUntil) {
    return syntheticRateLimitedResponse();
  }
  if (signal !== undefined && signal.aborted) {
    releaseJupiterSlot(slotAt);
    throw signal.reason ?? new Error("The operation was aborted");
  }
  return waitJupiterSlot(slotAt, slotAt - Date.now(), signal);
}

/**
 * The single choke point for every api.jup.ag request in the process.
 * (see the traffic-gate note at the top of this file)
 */
export async function jupiterFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  // Fail fast while the 429 cooldown is open — no network traffic, so a ban
  // cannot be refreshed by retry loops.
  if (Date.now() < breakerCooldownUntil) {
    return syntheticRateLimitedResponse();
  }
  const claimed = claimJupiterSlot();
  const waiting = await waitJupiterSlot(claimed.slotAt, claimed.waitMs, init?.signal ?? undefined);
  if (waiting !== null) return waiting;
  const response = await fetch(input, init);
  recordJupiterResponse(response);
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
