import { describe, expect, it } from "vitest";
import {
  createTokenCandidate,
  evaluateCandidateHealth,
  isCandidateEligible,
  transitionCandidate,
} from "../engine/candidate-policy.js";
import type { TokenPriceEvidence } from "../engine/services.js";

const policy = {
  minHealthyScans: 6,
  minObservationMs: 3_600_000,
} as const;

const candidateIdentity = {
  id: "candidate-1",
  walletAddress: "wallet-1",
  agentInstanceId: "primary",
  poolAddress: "pool-1",
  tokenMint: "mint-1",
} as const;

function strictPriceEvidence(observedAt: number): readonly TokenPriceEvidence[] {
  return [{ mint: "mint-1", priceUsd: 2.5, observedAt, fallbackUsed: false }];
}

function healthyScan(observedAt: number) {
  return {
    kind: "scan" as const,
    observedAt,
    health: evaluateCandidateHealth({
      safety: { kind: "safe" },
      priceEvidence: strictPriceEvidence(observedAt),
      requiredMints: ["mint-1"],
      now: observedAt,
      maxMarketDataAgeMs: 300_000,
      routeAvailable: true,
      screenerAccepted: true,
      marketDataAvailable: true,
    }),
  };
}

function eligibleCandidate() {
  let candidate = createTokenCandidate({ ...candidateIdentity, firstSeenAt: 0 });
  for (const observedAt of [1, 2, 3, 4, 5, 3_600_000]) {
    candidate = transitionCandidate(candidate, healthyScan(observedAt), policy);
  }
  return candidate;
}

describe("candidate lifecycle", () => {
  it("becomes eligible only after six healthy scans spanning one hour", () => {
    // Given
    let candidate = createTokenCandidate({ ...candidateIdentity, firstSeenAt: 0 });

    // When
    for (const observedAt of [1, 2, 3, 4, 5, 3_600_000]) {
      candidate = transitionCandidate(candidate, healthyScan(observedAt), policy);
    }

    // Then
    expect(candidate).toMatchObject({
      state: "eligible",
      healthyScanCount: 6,
      eligibleAt: 3_600_000,
      rejectionReason: null,
    });
    expect(isCandidateEligible(candidate, policy)).toBe(true);
  });

  it("resets a healthy streak on transient price, route, or market-data failures", () => {
    // Given
    let candidate = createTokenCandidate({ ...candidateIdentity, firstSeenAt: 0 });
    candidate = transitionCandidate(candidate, healthyScan(1), policy);
    candidate = transitionCandidate(candidate, healthyScan(2), policy);

    // When
    const failedHealth = evaluateCandidateHealth({
      safety: { kind: "safe" },
      priceEvidence: [],
      requiredMints: ["mint-1"],
      now: 3,
      maxMarketDataAgeMs: 300_000,
      routeAvailable: false,
      screenerAccepted: true,
      marketDataAvailable: false,
    });
    candidate = transitionCandidate(
      candidate,
      { kind: "scan", observedAt: 3, health: failedHealth },
      policy,
    );

    // Then
    expect(failedHealth).toEqual({ kind: "transient_failure", reason: "market_data_unavailable" });
    expect(candidate).toMatchObject({
      state: "observing",
      healthyScanCount: 0,
      eligibleAt: null,
      rejectionReason: null,
    });
  });

  it.each([
    [
      "stale price evidence",
      {
        priceEvidence: [
          { mint: "mint-1", priceUsd: 2.5, observedAt: 0, fallbackUsed: false as const },
        ],
        routeAvailable: true,
        screenerAccepted: true,
        marketDataAvailable: true,
        now: 300_001,
      },
      { kind: "transient_failure", reason: "price_evidence_stale" },
    ],
    [
      "unavailable price evidence",
      {
        priceEvidence: [],
        routeAvailable: true,
        screenerAccepted: true,
        marketDataAvailable: true,
      },
      { kind: "transient_failure", reason: "price_evidence_unavailable" },
    ],
    [
      "unavailable route",
      {
        priceEvidence: strictPriceEvidence(1),
        routeAvailable: false,
        screenerAccepted: true,
        marketDataAvailable: true,
      },
      { kind: "transient_failure", reason: "route_unavailable" },
    ],
    [
      "rejected screener result",
      {
        priceEvidence: strictPriceEvidence(1),
        routeAvailable: true,
        screenerAccepted: false,
        marketDataAvailable: true,
      },
      { kind: "transient_failure", reason: "screener_rejected" },
    ],
    [
      "unavailable market data",
      {
        priceEvidence: strictPriceEvidence(1),
        routeAvailable: true,
        screenerAccepted: true,
        marketDataAvailable: false,
      },
      { kind: "transient_failure", reason: "market_data_unavailable" },
    ],
  ])("classifies %s as a transient candidate failure", (_name, overrides, expected) => {
    // Given
    const input = {
      safety: { kind: "safe" as const },
      requiredMints: ["mint-1"],
      now: 1,
      maxMarketDataAgeMs: 300_000,
      ...overrides,
    };

    // When
    const health = evaluateCandidateHealth(input);

    // Then
    expect(health).toEqual(expected);
  });

  it("rejects a candidate permanently when safety reports a hard failure", () => {
    // Given
    const candidate = createTokenCandidate({ ...candidateIdentity, firstSeenAt: 0 });
    const health = evaluateCandidateHealth({
      safety: { kind: "hard_safety_failure", reason: "token is blacklisted" },
      priceEvidence: strictPriceEvidence(1),
      requiredMints: ["mint-1"],
      now: 1,
      maxMarketDataAgeMs: 300_000,
      routeAvailable: true,
      screenerAccepted: true,
      marketDataAvailable: true,
    });

    // When
    const rejected = transitionCandidate(
      candidate,
      { kind: "scan", observedAt: 1, health },
      policy,
    );

    // Then
    expect(rejected).toMatchObject({
      state: "rejected",
      healthyScanCount: 0,
      rejectionReason: "token is blacklisted",
    });
  });

  it("continues a persisted healthy streak after restart without hidden process state", () => {
    // Given
    const persisted = {
      ...createTokenCandidate({ ...candidateIdentity, firstSeenAt: 0 }),
      state: "observing" as const,
      healthyScanCount: 5,
      lastSeenAt: 5,
      updatedAt: 5,
    };

    // When
    const resumed = transitionCandidate(persisted, healthyScan(3_600_000), policy);

    // Then
    expect(resumed).toMatchObject({
      state: "eligible",
      healthyScanCount: 6,
      eligibleAt: 3_600_000,
    });
  });

  it("moves an eligible candidate through entered and cooling-down states", () => {
    // Given
    const eligible = eligibleCandidate();

    // When
    const entered = transitionCandidate(
      eligible,
      { kind: "entry_confirmed", occurredAt: 3_600_001 },
      policy,
    );
    const cooling = transitionCandidate(
      entered,
      { kind: "cooldown_started", occurredAt: 3_600_002, cooldownUntil: 3_600_100 },
      policy,
    );

    // Then
    expect(entered).toMatchObject({ state: "entered", enteredAt: 3_600_001 });
    expect(cooling).toMatchObject({ state: "cooling_down", cooldownUntil: 3_600_100 });
  });

  it("returns a cooled-down candidate to discovery with a fresh healthy streak", () => {
    // Given
    const entered = transitionCandidate(
      eligibleCandidate(),
      { kind: "entry_confirmed", occurredAt: 3_600_001 },
      policy,
    );
    const cooling = transitionCandidate(
      entered,
      { kind: "cooldown_started", occurredAt: 3_600_002, cooldownUntil: 3_600_100 },
      policy,
    );

    // When
    const rediscovered = transitionCandidate(
      cooling,
      { kind: "cooldown_elapsed", occurredAt: 3_600_100 },
      policy,
    );

    // Then
    expect(rediscovered).toMatchObject({
      state: "discovered",
      healthyScanCount: 0,
      eligibleAt: null,
      cooldownUntil: null,
    });
  });

  it("requires non-fallback fresh price evidence for every required mint", () => {
    // Given
    const staleEvidence: readonly TokenPriceEvidence[] = [
      { mint: "mint-1", priceUsd: 2.5, observedAt: 0, fallbackUsed: false },
    ];

    // When
    const health = evaluateCandidateHealth({
      safety: { kind: "safe" },
      priceEvidence: staleEvidence,
      requiredMints: ["mint-1", "mint-2"],
      now: 300_001,
      maxMarketDataAgeMs: 300_000,
      routeAvailable: true,
      screenerAccepted: true,
      marketDataAvailable: true,
    });

    // Then
    expect(health).toEqual({ kind: "transient_failure", reason: "price_evidence_unavailable" });
  });

  it("fails closed when a caller supplies no required mints", () => {
    // Given
    const evidence = strictPriceEvidence(1);

    // When
    const health = evaluateCandidateHealth({
      safety: { kind: "safe" },
      priceEvidence: evidence,
      requiredMints: [],
      now: 1,
      maxMarketDataAgeMs: 300_000,
      routeAvailable: true,
      screenerAccepted: true,
      marketDataAvailable: true,
    });

    // Then
    expect(health).toEqual({ kind: "transient_failure", reason: "price_evidence_unavailable" });
  });
});
