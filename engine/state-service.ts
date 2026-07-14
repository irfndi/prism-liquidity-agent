import { Effect, Layer } from "effect";
import { createLogger } from "./logger.js";
import { AgentStateService } from "./services.js";
import type { AgentPolicySnapshot, AgentProposal } from "./types.js";

const logger = createLogger("AgentStateService");

export interface PositionSnapshot {
  readonly poolAddress: string;
  readonly tokenXSymbol: string;
  readonly tokenYSymbol: string;
  readonly depositedUsd: number;
  readonly currentValueUsd: number;
  readonly activeBinId: number;
  readonly lowerBinId: number;
  readonly upperBinId: number;
  readonly lastAction: "ENTER" | "EXIT" | "REBALANCE" | "HOLD";
  readonly lastActionAt: number;
  readonly hoursHeld: number;
}

export interface DecisionSnapshot {
  readonly timestamp: number;
  readonly cycleId: string;
  readonly poolAddress: string;
  readonly action: string;
  readonly confidence: number;
  readonly reasoning: string;
  readonly executed: boolean;
}

export interface PortfolioSnapshot {
  readonly totalValueUsd: number;
  readonly unrealizedPnlUsd: number;
  readonly realizedPnlUsd: number;
  readonly openPositions: number;
  readonly maxPositions: number;
  readonly walletBalanceUsd: number;
}

export interface PrismStateSnapshot {
  readonly programStartTime: number;
  readonly scanCount: number;
  readonly lastCycleAt: number | null;
  readonly portfolio: PortfolioSnapshot;
  readonly positions: ReadonlyArray<PositionSnapshot>;
  readonly recentDecisions: ReadonlyArray<DecisionSnapshot>;
  readonly agentPolicy: AgentPolicySnapshot;
  readonly pendingProposals: ReadonlyArray<AgentProposal>;
}

export const initialSnapshot: PrismStateSnapshot = {
  programStartTime: Date.now(),
  scanCount: 0,
  lastCycleAt: null,
  portfolio: {
    totalValueUsd: 0,
    unrealizedPnlUsd: 0,
    realizedPnlUsd: 0,
    openPositions: 0,
    maxPositions: 0,
    walletBalanceUsd: 0,
  },
  positions: [],
  recentDecisions: [],
  agentPolicy: {
    mode: "veto",
    proposalsQueued: 0,
    lastProposalAt: null,
    badProposalBackoffUntil: null,
    circuitBreakerOpen: false,
    hardCaps: {
      maxPositionSizePct: 0.4,
      maxRebalanceRangeBins: 50,
      minProposalConfidence: 0.65,
      proposalStaleMs: 300_000,
    },
  },
  pendingProposals: [],
};

export function AgentStateLive(): Layer.Layer<AgentStateService, never, never> {
  return Layer.succeed(AgentStateService, {
    getSnapshot: () => Effect.succeed(initialSnapshot),
    updateSnapshot: () => Effect.void,
    setAgentPolicy: () => Effect.void,
    enqueueProposal: () => Effect.void,
    dequeueProposals: () => Effect.void,
    approveProposal: () => Effect.void,
    rejectProposal: () => Effect.void,
  });
}

export function AgentStateMutable(): {
  readonly layer: Layer.Layer<AgentStateService, never, never>;
  readonly update: (patch: Partial<PrismStateSnapshot>) => void;
  readonly setAgentPolicy: (patch: Partial<AgentPolicySnapshot>) => void;
  readonly setPendingProposals: (proposals: ReadonlyArray<AgentProposal>) => void;
  readonly enqueueProposal: (proposal: AgentProposal) => void;
  readonly dequeueProposals: (ids: ReadonlyArray<string>) => void;
  readonly approveProposal: (id: string) => void;
  readonly rejectProposal: (id: string) => void;
} {
  let snapshot: PrismStateSnapshot = initialSnapshot;

  const update = (patch: Partial<PrismStateSnapshot>): void => {
    const next: PrismStateSnapshot = {
      ...snapshot,
      ...patch,
      portfolio: patch.portfolio
        ? { ...snapshot.portfolio, ...patch.portfolio }
        : snapshot.portfolio,
      agentPolicy: patch.agentPolicy
        ? { ...snapshot.agentPolicy, ...patch.agentPolicy }
        : snapshot.agentPolicy,
      pendingProposals: patch.pendingProposals ?? snapshot.pendingProposals,
    };
    snapshot = next;
  };

  const setAgentPolicy = (patch: Partial<AgentPolicySnapshot>): void => {
    update({ agentPolicy: { ...snapshot.agentPolicy, ...patch } });
  };

  const prunePendingProposals = (now: number): ReadonlyArray<AgentProposal> => {
    return snapshot.pendingProposals.filter(
      (proposal) =>
        proposal.expiresAt >= now && proposal.status !== "rejected" && proposal.status !== "executed",
    );
  };

  const prune = (now: number): void => {
    const pruned = prunePendingProposals(now);
    if (pruned.length !== snapshot.pendingProposals.length) {
      update({ pendingProposals: pruned });
    }
  };

  const setPendingProposals = (proposals: ReadonlyArray<AgentProposal>): void => {
    update({ pendingProposals: [...proposals] });
  };

  const enqueueProposal = (proposal: AgentProposal): void => {
    update({ pendingProposals: [...snapshot.pendingProposals, proposal] });
  };

  const dequeueProposals = (proposalIds: ReadonlyArray<string>): void => {
    const idSet = new Set(proposalIds);
    update({
      pendingProposals: snapshot.pendingProposals.filter(
        (proposal) => !idSet.has(proposal.proposalId),
      ),
    });
  };

  const updateProposalStatus = (proposalId: string, status: AgentProposal["status"]): void => {
    update({
      pendingProposals: snapshot.pendingProposals.map((proposal) =>
        proposal.proposalId === proposalId ? { ...proposal, status } : proposal,
      ),
    });
  };

  const approveProposal = (id: string): void => updateProposalStatus(id, "approved");
  const rejectProposal = (id: string): void => updateProposalStatus(id, "rejected");

  const layer = Layer.succeed(AgentStateService, {
    getSnapshot: () =>
      Effect.sync(() => {
        prune(Date.now());
        return snapshot;
      }),
    updateSnapshot: (patch) =>
      Effect.sync(() => {
        update(patch);
        prune(Date.now());
        logger.debug("Agent state updated");
      }),
    setAgentPolicy: (patch) =>
      Effect.sync(() => {
        setAgentPolicy(patch);
      }),
    enqueueProposal: (proposal) =>
      Effect.sync(() => {
        enqueueProposal(proposal);
        prune(Date.now());
      }),
    dequeueProposals: (proposalIds) =>
      Effect.sync(() => {
        dequeueProposals(proposalIds);
        prune(Date.now());
      }),
    approveProposal: (proposalId) =>
      Effect.sync(() => {
        approveProposal(proposalId);
        prune(Date.now());
      }),
    rejectProposal: (proposalId) =>
      Effect.sync(() => {
        rejectProposal(proposalId);
        prune(Date.now());
      }),
  });

  return {
    layer,
    update,
    setAgentPolicy,
    setPendingProposals,
    enqueueProposal,
    dequeueProposals,
    approveProposal,
    rejectProposal,
  };
}
