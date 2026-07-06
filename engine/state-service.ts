import { Effect, Layer } from "effect";
import { createLogger } from "./logger.js";
import { AgentStateService } from "./services.js";

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
}

const initialSnapshot: PrismStateSnapshot = {
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
};

export function AgentStateLive(): Layer.Layer<AgentStateService, never, never> {
  return Layer.succeed(AgentStateService, {
    getSnapshot: () => Effect.succeed(initialSnapshot),
    updateSnapshot: () => Effect.void,
  });
}

export function AgentStateMutable(): {
  readonly layer: Layer.Layer<AgentStateService, never, never>;
  readonly update: (patch: Partial<PrismStateSnapshot>) => void;
} {
  let snapshot: PrismStateSnapshot = initialSnapshot;

  const update = (patch: Partial<PrismStateSnapshot>): void => {
    const next: PrismStateSnapshot = {
      ...snapshot,
      ...patch,
      portfolio: patch.portfolio
        ? { ...snapshot.portfolio, ...patch.portfolio }
        : snapshot.portfolio,
    };
    snapshot = next;
  };

  const layer = Layer.succeed(AgentStateService, {
    getSnapshot: () => Effect.succeed(snapshot),
    updateSnapshot: (patch) =>
      Effect.sync(() => {
        update(patch);
        logger.debug("Agent state updated");
      }),
  });

  return { layer, update };
}
