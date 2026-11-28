/**
 * Copy-signal feed: the producing side of the copy-trading contract.
 *
 * Why it lives here (issue #250): the box ran a `prism-copy-signals` unit whose
 * source lived only in a deleted directory, and its logs showed repeated auth
 * failures nobody could diagnose because the server was gone. The feed is now
 * part of the release, with the auth contract made explicit and testable.
 *
 * Contract (mirrors `engine/copy-trading-signals.ts`, the consumer):
 * - `GET /signals` → `{ signals: CopySignalObservation[] }`
 * - `POST /signals` → append one observation
 * - `GET /health`   → `{ ok, signals, ageMs, reason }` when the caller presents
 *                     the feed token, 401 otherwise.
 *
 * Auth is a bearer token compared in constant time. An empty token disables the
 * server at startup rather than serving an open feed — the consumer treats the
 * feed as advisory, but "anyone may write my trading signals" is not a state a
 * deployed process should reach by forgetting one env var.
 */
import { timingSafeEqual } from "node:crypto";
import { Schema } from "effect";

const WALLET_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Wire shape of one observation, validated at the HTTP boundary. */
export const CopySignalObservationSchema = Schema.Struct({
  wallet: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter((wallet: string) => WALLET_PATTERN.test(wallet), {
        message: "wallet must be a base58 public key",
      }),
    ),
  ),
  poolAddress: Schema.NonEmptyString,
  action: Schema.Literals(["ENTER", "HOLD", "REBALANCE"]),
  confidence: Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  /** ms epoch the observation was made on-chain. */
  observedAt: Schema.Number.pipe(Schema.check(Schema.isGreaterThan(0))),
  signature: Schema.optional(Schema.String),
});
export type CopySignalObservation = Schema.Schema.Type<typeof CopySignalObservationSchema>;

const ObservationFromJson = Schema.fromJsonString(CopySignalObservationSchema);

export type ObservationVerdict =
  | { readonly ok: true; readonly value: CopySignalObservation }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate one inbound observation. Anything off-contract is rejected rather
 * than coerced: a fabricated confidence or an empty pool address would enter the
 * consumer's boost path.
 */
export function validateObservation(raw: string): ObservationVerdict {
  try {
    return { ok: true, value: Schema.decodeUnknownSync(ObservationFromJson)(raw) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Constant-time bearer comparison; a length mismatch is never "close enough". */
export function tokenMatches(presented: string | null, expected: string): boolean {
  if (presented === null || expected.length === 0) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function bearerFrom(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/** Drop observations past retention, keep the newest `maxEntries`. */
export function prune(
  observations: readonly CopySignalObservation[],
  now: number,
  retentionMs: number,
  maxEntries: number,
): CopySignalObservation[] {
  const fresh = observations.filter((observation) => now - observation.observedAt <= retentionMs);
  return fresh.length > maxEntries ? fresh.slice(fresh.length - maxEntries) : fresh;
}

export interface HealthVerdict {
  readonly ok: boolean;
  readonly signals: number;
  /** Age of the newest observation, null when the feed is empty. */
  readonly ageMs: number | null;
  readonly reason: string;
}

/**
 * Health is about the FEED being usable, not about the process being alive: an
 * empty feed means the consumer gets no boost in either direction, which the
 * operator must be told explicitly instead of reading "healthy" from a 200.
 */
export function evaluateHealth(
  observations: readonly CopySignalObservation[],
  now: number,
  staleMs: number,
): HealthVerdict {
  if (observations.length === 0) {
    return {
      ok: false,
      signals: 0,
      ageMs: null,
      reason: "feed is empty — no signals being produced",
    };
  }
  const newest = Math.max(...observations.map((observation) => observation.observedAt));
  const ageMs = now - newest;
  if (ageMs > staleMs) {
    return {
      ok: false,
      signals: observations.length,
      ageMs,
      reason: `newest signal is ${Math.round(ageMs / 1000)}s old (stale above ${Math.round(staleMs / 1000)}s)`,
    };
  }
  return { ok: true, signals: observations.length, ageMs, reason: "ok" };
}

export interface FeedOptions {
  readonly token: string;
  readonly retentionMs: number;
  readonly maxEntries: number;
  readonly staleMs: number;
  readonly now: () => number;
}

/** Every body the feed can emit, so callers never handle an `unknown` payload. */
export type FeedBody =
  | { readonly ok: true; readonly signals: number }
  | { readonly ok: false; readonly reason: string }
  | HealthVerdict
  | { readonly signals: readonly CopySignalObservation[] };

export interface FeedReply {
  readonly status: 200 | 202 | 400 | 401 | 404;
  readonly body: FeedBody;
}

/** Mutable feed state owned by the server loop. */
export interface FeedState {
  observations: readonly CopySignalObservation[];
}

export const UNAUTHORIZED: FeedReply = { status: 401, body: { ok: false, reason: "unauthorized" } };

/** Append a validated raw body; the ONLY write path into the feed. */
export function publish(state: FeedState, options: FeedOptions, body: string): FeedReply {
  const verdict = validateObservation(body);
  if (!verdict.ok) return { status: 400, body: { ok: false, reason: verdict.reason } };
  const now = options.now();
  state.observations = prune(
    [...state.observations, verdict.value],
    now,
    options.retentionMs,
    options.maxEntries,
  );
  return { status: 202, body: { ok: true, signals: state.observations.length } };
}

/** Route one authenticated request. Pure over `state` + `options`. */
export function route(
  state: FeedState,
  options: FeedOptions,
  request: { readonly method: string; readonly path: string; readonly body: string },
): FeedReply {
  const now = options.now();
  if (request.path === "/health") {
    state.observations = prune(state.observations, now, options.retentionMs, options.maxEntries);
    return { status: 200, body: evaluateHealth(state.observations, now, options.staleMs) };
  }
  if (request.path === "/signals" && request.method === "GET") {
    state.observations = prune(state.observations, now, options.retentionMs, options.maxEntries);
    return { status: 200, body: { signals: state.observations } };
  }
  if (request.path === "/signals" && request.method === "POST") {
    return publish(state, options, request.body);
  }
  return { status: 404, body: { ok: false, reason: "not found" } };
}
