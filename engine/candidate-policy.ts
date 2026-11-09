import type { TokenPriceEvidence } from "./services.js";
import type { TokenCandidateRecord } from "./types.js";

export interface CandidatePolicy {
  readonly minHealthyScans: number;
  readonly minObservationMs: number;
}

export interface CandidateIdentity {
  readonly id: string;
  readonly walletAddress: string;
  readonly agentInstanceId: string;
  readonly poolAddress: string;
  readonly tokenMint: string;
  readonly firstSeenAt: number;
}

export type CandidateSafetyResult =
  | { readonly kind: "safe" }
  | { readonly kind: "hard_safety_failure"; readonly reason: string };

export type CandidateHealth =
  | { readonly kind: "healthy" }
  | {
      readonly kind: "transient_failure";
      readonly reason:
        | "market_data_unavailable"
        | "price_evidence_unavailable"
        | "price_evidence_stale"
        | "route_unavailable"
        | "screener_rejected";
    }
  | { readonly kind: "hard_safety_failure"; readonly reason: string };

export interface CandidateHealthInput {
  readonly safety: CandidateSafetyResult;
  readonly priceEvidence: ReadonlyArray<TokenPriceEvidence>;
  readonly requiredMints: ReadonlyArray<string>;
  readonly now: number;
  readonly maxMarketDataAgeMs: number;
  readonly routeAvailable: boolean;
  readonly screenerAccepted: boolean;
  readonly marketDataAvailable: boolean;
}

export type CandidateLifecycleEvent =
  | { readonly kind: "scan"; readonly observedAt: number; readonly health: CandidateHealth }
  | { readonly kind: "entry_confirmed"; readonly occurredAt: number }
  /**
   * The position that made this candidate `entered` is gone (closed via the
   * decision tail, reconcile, an empty reap, or a paper exit). Without this
   * the scan event ignores `entered` forever and the token is never
   * re-admitted for the life of the row.
   */
  | { readonly kind: "entry_closed"; readonly occurredAt: number }
  | {
      readonly kind: "cooldown_started";
      readonly occurredAt: number;
      readonly cooldownUntil: number;
    }
  | { readonly kind: "cooldown_elapsed"; readonly occurredAt: number };

function atOrAfter(previous: number, observed: number): number {
  return Math.max(previous, observed);
}

function updateSeen(
  candidate: TokenCandidateRecord,
  occurredAt: number,
  updates: Omit<Partial<TokenCandidateRecord>, "lastSeenAt" | "updatedAt">,
): TokenCandidateRecord {
  const updatedAt = atOrAfter(candidate.updatedAt, occurredAt);
  return {
    ...candidate,
    ...updates,
    lastSeenAt: atOrAfter(candidate.lastSeenAt, occurredAt),
    updatedAt,
  };
}

function isFreshPriceEvidence(
  evidence: TokenPriceEvidence,
  now: number,
  maxMarketDataAgeMs: number,
): boolean {
  return (
    evidence.fallbackUsed === false &&
    Number.isFinite(evidence.priceUsd) &&
    evidence.priceUsd > 0 &&
    evidence.observedAt <= now &&
    now - evidence.observedAt <= maxMarketDataAgeMs
  );
}

/** Returns true only when every required mint has fresh non-fallback price evidence. */
export function hasFreshPriceEvidence(input: CandidateHealthInput): boolean {
  return (
    input.requiredMints.length > 0 &&
    input.requiredMints.every((mint) =>
      input.priceEvidence.some(
        (evidence) =>
          evidence.mint === mint &&
          isFreshPriceEvidence(evidence, input.now, input.maxMarketDataAgeMs),
      ),
    )
  );
}

/** Classifies a screened candidate as healthy, transiently unavailable, or unsafe. */
export function evaluateCandidateHealth(input: CandidateHealthInput): CandidateHealth {
  switch (input.safety.kind) {
    case "hard_safety_failure":
      return input.safety;
    case "safe":
      break;
  }
  if (!input.marketDataAvailable)
    return { kind: "transient_failure", reason: "market_data_unavailable" };
  if (!hasFreshPriceEvidence(input)) {
    const hasEvidence =
      input.requiredMints.length > 0 &&
      input.requiredMints.every((mint) =>
        input.priceEvidence.some((evidence) => evidence.mint === mint),
      );
    return {
      kind: "transient_failure",
      reason: hasEvidence ? "price_evidence_stale" : "price_evidence_unavailable",
    };
  }
  if (!input.routeAvailable) return { kind: "transient_failure", reason: "route_unavailable" };
  if (!input.screenerAccepted) return { kind: "transient_failure", reason: "screener_rejected" };
  return { kind: "healthy" };
}

/** Creates the persisted initial state for a newly discovered token candidate. */
export function createTokenCandidate(identity: CandidateIdentity): TokenCandidateRecord {
  return {
    id: identity.id,
    walletAddress: identity.walletAddress,
    agentInstanceId: identity.agentInstanceId,
    poolAddress: identity.poolAddress,
    tokenMint: identity.tokenMint,
    state: "discovered",
    healthyScanCount: 0,
    firstSeenAt: identity.firstSeenAt,
    lastSeenAt: identity.firstSeenAt,
    eligibleAt: null,
    enteredAt: null,
    cooldownUntil: null,
    rejectionReason: null,
    createdAt: identity.firstSeenAt,
    updatedAt: identity.firstSeenAt,
  };
}

/** Checks whether a candidate has met both its scan-count and observation-age gates. */
export function isCandidateEligible(
  candidate: TokenCandidateRecord,
  policy: CandidatePolicy,
): boolean {
  return (
    candidate.healthyScanCount >= policy.minHealthyScans &&
    candidate.lastSeenAt - candidate.firstSeenAt >= policy.minObservationMs
  );
}

function recordHealthyScan(
  candidate: TokenCandidateRecord,
  observedAt: number,
  policy: CandidatePolicy,
): TokenCandidateRecord {
  const healthyScanCount = candidate.healthyScanCount + 1;
  const observed = updateSeen(candidate, observedAt, { healthyScanCount });
  if (!isCandidateEligible(observed, policy)) {
    return { ...observed, state: "observing", eligibleAt: null, rejectionReason: null };
  }
  return { ...observed, state: "eligible", eligibleAt: observed.lastSeenAt, rejectionReason: null };
}

function recordTransientFailure(
  candidate: TokenCandidateRecord,
  observedAt: number,
): TokenCandidateRecord {
  switch (candidate.state) {
    case "discovered":
    case "observing":
    case "eligible":
      return updateSeen(candidate, observedAt, {
        state: "observing",
        healthyScanCount: 0,
        eligibleAt: null,
        rejectionReason: null,
      });
    case "entered":
    case "cooling_down":
    case "rejected":
      return updateSeen(candidate, observedAt, {});
  }
}

function recordScan(
  candidate: TokenCandidateRecord,
  observedAt: number,
  health: CandidateHealth,
  policy: CandidatePolicy,
): TokenCandidateRecord {
  switch (health.kind) {
    case "hard_safety_failure":
      return updateSeen(candidate, observedAt, {
        state: "rejected",
        healthyScanCount: 0,
        eligibleAt: null,
        cooldownUntil: null,
        rejectionReason: health.reason,
      });
    case "transient_failure":
      return recordTransientFailure(candidate, observedAt);
    case "healthy":
      switch (candidate.state) {
        case "discovered":
        case "observing":
        case "eligible":
          return recordHealthyScan(candidate, observedAt, policy);
        case "entered":
        case "cooling_down":
        case "rejected":
          return updateSeen(candidate, observedAt, {});
      }
  }
}

/** `eligible` → `entered` on a confirmed ENTER; any other state is untouched. */
function applyEntryConfirmed(
  candidate: TokenCandidateRecord,
  occurredAt: number,
): TokenCandidateRecord {
  if (candidate.state !== "eligible") return candidate;
  return updateSeen(candidate, occurredAt, {
    state: "entered",
    enteredAt: occurredAt,
    cooldownUntil: null,
  });
}

/**
 * `entered` → `discovered` when the position it represented is gone.
 *
 * Back to discovery with a fresh streak: the token has to re-qualify on fresh
 * evidence (the pool-level cooldown, not this row, owns how soon re-entry is
 * allowed). Only `entered` rows are affected.
 */
function applyEntryClosed(
  candidate: TokenCandidateRecord,
  occurredAt: number,
): TokenCandidateRecord {
  if (candidate.state !== "entered") return candidate;
  return updateSeen(candidate, occurredAt, {
    state: "discovered",
    healthyScanCount: 0,
    eligibleAt: null,
    enteredAt: null,
    cooldownUntil: null,
    rejectionReason: null,
  });
}

/** `entered` → `cooling_down` with the pool's exit cooldown. */
function applyCooldownStarted(
  candidate: TokenCandidateRecord,
  occurredAt: number,
  cooldownUntil: number,
): TokenCandidateRecord {
  if (candidate.state !== "entered") return candidate;
  return updateSeen(candidate, occurredAt, { state: "cooling_down", cooldownUntil });
}

/** `cooling_down` → `discovered` once the cooldown has elapsed. */
function applyCooldownElapsed(
  candidate: TokenCandidateRecord,
  occurredAt: number,
): TokenCandidateRecord {
  if (candidate.state !== "cooling_down") return candidate;
  if (candidate.cooldownUntil === null) return candidate;
  if (occurredAt < candidate.cooldownUntil) return candidate;
  return updateSeen(candidate, occurredAt, {
    state: "discovered",
    healthyScanCount: 0,
    eligibleAt: null,
    cooldownUntil: null,
    rejectionReason: null,
  });
}

/** Applies one persisted lifecycle event while preserving monotonic timestamps. */
export function transitionCandidate(
  candidate: TokenCandidateRecord,
  event: CandidateLifecycleEvent,
  policy: CandidatePolicy,
): TokenCandidateRecord {
  switch (event.kind) {
    case "scan":
      return recordScan(candidate, event.observedAt, event.health, policy);
    case "entry_confirmed":
      return applyEntryConfirmed(candidate, event.occurredAt);
    case "entry_closed":
      return applyEntryClosed(candidate, event.occurredAt);
    case "cooldown_started":
      return applyCooldownStarted(candidate, event.occurredAt, event.cooldownUntil);
    case "cooldown_elapsed":
      return applyCooldownElapsed(candidate, event.occurredAt);
  }
}
