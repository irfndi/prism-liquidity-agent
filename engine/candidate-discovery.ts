import {
  createTokenCandidate,
  evaluateCandidateHealth,
  transitionCandidate,
  type CandidatePolicy,
} from "./candidate-policy.js";
import { SOL_MINT } from "./constants.js";
import type { ScreenedPool, TokenPriceEvidence } from "./services.js";
import type { TokenCandidateRecord } from "./types.js";

export interface AdvanceScreenedCandidatesInput {
  readonly walletAddress: string;
  readonly agentInstanceId: string;
  readonly screenedPools: ReadonlyArray<ScreenedPool>;
  readonly existingCandidates: ReadonlyArray<TokenCandidateRecord>;
  readonly priceEvidence: ReadonlyArray<TokenPriceEvidence>;
  readonly routeAvailableMints: ReadonlySet<string>;
  readonly now: number;
  readonly policy: CandidatePolicy;
  readonly maxMarketDataAgeMs: number;
}

export interface ScreenedCandidateAdvance {
  readonly updatedCandidates: ReadonlyArray<TokenCandidateRecord>;
  readonly eligiblePoolAddresses: ReadonlyArray<string>;
}

function candidateMint(pool: ScreenedPool): string {
  return pool.tokenX === SOL_MINT ? pool.tokenY : pool.tokenX;
}

function candidateId(
  walletAddress: string,
  agentInstanceId: string,
  poolAddress: string,
  tokenMint: string,
): string {
  return `${walletAddress}:${agentInstanceId}:${poolAddress}:${tokenMint}`;
}

/** Advances screened pools through candidate health and returns newly eligible pools. */
export function advanceScreenedCandidates(
  input: AdvanceScreenedCandidatesInput,
): ScreenedCandidateAdvance {
  const existingById = new Map(
    input.existingCandidates.map((candidate) => [candidate.id, candidate]),
  );
  const updatedCandidates = input.screenedPools.map((pool) => {
    const tokenMint = candidateMint(pool);
    const id = candidateId(input.walletAddress, input.agentInstanceId, pool.address, tokenMint);
    const candidate =
      existingById.get(id) ??
      createTokenCandidate({
        id,
        walletAddress: input.walletAddress,
        agentInstanceId: input.agentInstanceId,
        poolAddress: pool.address,
        tokenMint,
        firstSeenAt: input.now,
      });
    return transitionCandidate(
      candidate,
      {
        kind: "scan",
        observedAt: input.now,
        health: evaluateCandidateHealth({
          safety: { kind: "safe" },
          priceEvidence: input.priceEvidence,
          requiredMints: [pool.tokenX, pool.tokenY],
          now: input.now,
          maxMarketDataAgeMs: input.maxMarketDataAgeMs,
          routeAvailable: [pool.tokenX, pool.tokenY].every(
            (mint) => mint === SOL_MINT || input.routeAvailableMints.has(mint),
          ),
          screenerAccepted: true,
          marketDataAvailable:
            Number.isFinite(pool.tvlUsd) &&
            pool.tvlUsd > 0 &&
            Number.isFinite(pool.volume24hUsd) &&
            pool.volume24hUsd >= 0,
        }),
      },
      input.policy,
    );
  });
  return {
    updatedCandidates,
    eligiblePoolAddresses: [
      ...new Set(
        updatedCandidates
          .filter((candidate) => candidate.state === "eligible")
          .map((candidate) => candidate.poolAddress),
      ),
    ],
  };
}
