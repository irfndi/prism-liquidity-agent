// ─── Jev API traffic gate ────────────────────────────────────────────────────
// Numeric quota is UNKNOWN per docs (429/529 = backoff-retryable, SDK auto).
// One systemOne per pool per cycle × TopK pools fans out fast, so ALL Jev
// traffic routes through this single choke point: sustained pacing plus a
// process-wide escalating 429 breaker. While the breaker is open every
// request fails fast with a synthetic 429 — zero network traffic, so a ban
// can never be refreshed by retry loops. Same pattern as jupiter-client.ts.

// Conservative: quota unpublished, so stay modest. No new env knob.
const MIN_JEV_REQUEST_INTERVAL_MS = 2_000;
// Ceiling on any single pacing wait: beyond this the slot is treated as
// stale (clock anomaly / cross-isolation state) and reset.
const MAX_JEV_SLOT_WAIT_MS = 5 * 60_000;
// Escalating 429 cooldown: 1 min, 2, 4, ... up to 60 min.
const BREAKER_BASE_COOLDOWN_MS = 60_000;
const BREAKER_MAX_COOLDOWN_MS = 60 * 60_000;

let nextJevSlotAt = 0;
let breakerCooldownUntil = 0;
let breakerFailures = 0;
// Under the test environment (NODE_ENV=test / VITEST=true — repo precedent in
// config-service) the interval defaults to 0: the suite injects fetchImpl
// and must not pay the pacing wait per call.
const TEST_ENV = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
const DEFAULT_TEST_INTERVAL_MS = TEST_ENV ? 0 : undefined;
let testIntervalMs: number | undefined = DEFAULT_TEST_INTERVAL_MS;
let testBaseCooldownMs: number | undefined;

export interface JevGateTestOptions {
  readonly intervalMs?: number;
  readonly baseCooldownMs?: number;
}

/** Test hooks: zero the interval so unit tests are not serialized, and
 *  shrink/expand the breaker cooldown. */
export function setJevGateForTest(options: JevGateTestOptions): void {
  if (options.intervalMs !== undefined) testIntervalMs = options.intervalMs;
  if (options.baseCooldownMs !== undefined) testBaseCooldownMs = options.baseCooldownMs;
}

export function resetJevGateForTest(): void {
  nextJevSlotAt = 0;
  breakerCooldownUntil = 0;
  breakerFailures = 0;
  // Restore the environment-derived default (0 under the test env), not the
  // production interval — a reset between tests must not re-serialize the
  // mocked-fetch suite.
  testIntervalMs = DEFAULT_TEST_INTERVAL_MS;
  testBaseCooldownMs = undefined;
}

function intervalMs(): number {
  if (testIntervalMs !== undefined) return testIntervalMs;
  return MIN_JEV_REQUEST_INTERVAL_MS;
}

function baseCooldownMs(): number {
  return testBaseCooldownMs !== undefined ? testBaseCooldownMs : BREAKER_BASE_COOLDOWN_MS;
}

function syntheticRateLimitedResponse(): Response {
  return new Response(JSON.stringify({ code: 429, message: "Jev rate limited (breaker open)" }), {
    status: 429,
    headers: { "Content-Type": "application/json" },
  });
}

/** Escalate the cooldown on 429; a success after the cooldown clears the breaker (half-open). */
function recordJevResponse(response: Response): void {
  if (response.status === 429) {
    breakerFailures += 1;
    const cooldownMs = Math.min(
      baseCooldownMs() * 2 ** (breakerFailures - 1),
      BREAKER_MAX_COOLDOWN_MS,
    );
    breakerCooldownUntil = Date.now() + cooldownMs;
    return;
  }
  if (response.ok && breakerFailures > 0) {
    breakerFailures = 0;
    breakerCooldownUntil = 0;
  }
}

/**
 * Pace to the sustained safe rate. Slots are claimed SYNCHRONOUSLY at
 * call time (single-threaded: the sync prefix runs atomically), so
 * concurrent callers fan out to distinct slots instead of bursting.
 */
function claimJevSlot() {
  const now = Date.now();
  const slotAt = Math.max(now, nextJevSlotAt);
  // A slot more than 5 minutes out is a clock anomaly — never sleep that
  // long for pacing; a queue that deep is pathological and the 429 breaker
  // should have opened long before it forms.
  if (slotAt - now > MAX_JEV_SLOT_WAIT_MS) {
    nextJevSlotAt = now + intervalMs();
    return { slotAt: now, waitMs: 0 };
  }
  nextJevSlotAt = slotAt + intervalMs();
  return { slotAt, waitMs: slotAt - now };
}

/** The single choke point for every api.typesafe.ai request in the process.
 *  Injected fakes (tests, offline replay) bypass the gate. */
export async function jevFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  // Fail fast while the 429 cooldown is open — no network traffic, so a ban
  // cannot be refreshed by retry loops.
  if (Date.now() < breakerCooldownUntil) {
    return syntheticRateLimitedResponse();
  }
  const claimed = claimJevSlot();
  if (claimed.waitMs > 0) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, claimed.waitMs);
      init?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    if (Date.now() < breakerCooldownUntil) {
      return syntheticRateLimitedResponse();
    }
  }
  const response = await fetch(input, init);
  recordJevResponse(response);
  return response;
}
