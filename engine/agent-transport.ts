import { Effect } from "effect";
import type { AgentDecision, PoolMetrics, PoolState, MemoryEntry } from "./types.js";
import type { DecisionRecord } from "./services.js";

// ─── Agent Runtime Transport ─────────────────────────────────────────────────
//
// Prism's non-deterministic reasoning layer talks to local agent runtimes
// (Hermes via ACP, OpenClaw via Gateway WebSocket) instead of remote LLM APIs.
// This file defines the common transport interface shared by all runtimes.
// Every transport operation is wrapped in Effect to match the rest of Prism.

export interface AgentRuntimeContext {
  readonly decision: AgentDecision;
  readonly pool: PoolState;
  readonly metrics: PoolMetrics;
  readonly warnings: ReadonlyArray<MemoryEntry>;
  readonly recentDecisions: ReadonlyArray<DecisionRecord>;
  /** Whether the pool currently has an open position; used to restrict proposal actions. */
  readonly hasOpenPosition: boolean;
  /** The targeted open position's state, when the decision acts on one. */
  readonly position?: AgentPositionState;
}

/** Position state shown to the advisor for decisions that target an open
 *  position (EXIT/REBALANCE/HOLD). Undefined for positionless decisions
 *  (ENTER, default HOLD). Mirrors the checkin's per-position vocabulary so
 *  transports need no second schema. */
export interface AgentPositionState {
  readonly positionId: string;
  readonly valueUsd: number;
  readonly depositedUsd: number;
  readonly unrealizedPnlUsd: number;
  readonly feesClaimedUsd: number;
  readonly rewardsClaimedUsd: number;
  readonly outOfRangeSinceMs: number | null;
  readonly oorCycleCount: number;
  /** Hours out of range at context-construction time (null when in range). */
  readonly hoursOutOfRange: number | null;
  readonly hoursHeld: number;
  readonly activeBinId: number;
  readonly lowerBinId: number;
  readonly upperBinId: number;
  readonly entryPriceUsd: number | null;
  readonly highestValueUsd: number | null;
  readonly lastRebalanceAtMs: number;
}

export interface AgentRuntimeResponse {
  readonly override: AgentDecision | null;
  readonly raw: string;
  readonly latencyMs: number;
}

export interface AgentRuntimeCheckin {
  readonly type: "checkin";
  readonly trigger: "periodic" | "enter" | "exit" | "rebalance";
  readonly timestamp: number;
  readonly portfolio: {
    readonly totalValueUsd: number;
    readonly unrealizedPnlUsd: number;
    readonly realizedPnlUsd: number;
    readonly openPositions: number;
    readonly maxPositions: number;
  };
  readonly positions: ReadonlyArray<{
    readonly pool: string;
    readonly tokenX: string;
    readonly tokenY: string;
    readonly valueUsd: number;
    readonly depositedUsd: number;
    readonly pnlUsd: number;
    readonly activeBinId: number;
    readonly lowerBinId: number;
    readonly upperBinId: number;
    readonly hoursHeld: number;
    readonly lastAction: string;
    readonly lastActionAt: number;
  }>;
  readonly recentDecisions: ReadonlyArray<{
    readonly action: string;
    readonly confidence: number;
    readonly pool: string;
    readonly timestamp: number;
    readonly reasoning: string;
  }>;
  readonly warnings: ReadonlyArray<{
    readonly category: string;
    readonly content: string;
  }>;
  readonly market: {
    readonly solPriceUsd: number;
    readonly gasEstimateSol: number;
    readonly scanCount: number;
    readonly uptimeMs: number;
  };
}

export type AgentRuntimeAlertSeverity = "info" | "warning" | "critical";

export interface AgentRuntimeAlert {
  readonly type: "alert";
  readonly timestamp: number;
  readonly severity: AgentRuntimeAlertSeverity;
  readonly category:
    | "stop_loss"
    | "trailing_stop"
    | "high_volatility"
    | "tvl_drop"
    | "risk_rejected"
    | "large_pnl_swing"
    | "oor_extended"
    | "enter"
    | "exit"
    | "rebalance";
  readonly pool: string;
  readonly tokenPair: string;
  readonly message: string;
  readonly metrics?: {
    readonly tvlUsd?: number;
    readonly feeIlRatio?: number;
    readonly volumeAuthenticity?: number;
    readonly binUtilization?: number;
    readonly tvlVelocity?: number;
  };
  readonly position?: {
    readonly depositedUsd?: number;
    readonly currentValueUsd?: number;
    readonly pnlUsd?: number;
    readonly activeBinId?: number;
    readonly lowerBinId?: number;
    readonly upperBinId?: number;
  };
}

export type AgentRuntimeEvent =
  | { readonly type: "connecting"; readonly transport: string }
  | { readonly type: "connected"; readonly transport: string }
  | { readonly type: "prompt_sent"; readonly poolAddress: string }
  | { readonly type: "response_received"; readonly transport: string; readonly latencyMs: number }
  | { readonly type: "error"; readonly transport: string; readonly error: string }
  | { readonly type: "disconnected"; readonly transport: string };

export interface AgentRuntimeTransport {
  readonly name: string;
  readonly isAvailable: () => Effect.Effect<boolean, Error>;
  readonly connect: () => Effect.Effect<void, Error>;
  readonly disconnect: () => Effect.Effect<void, Error>;
  readonly sendPrompt: (
    prompt: string,
    ctx: AgentRuntimeContext,
    timeoutMs?: number,
  ) => Effect.Effect<AgentRuntimeResponse, Error>;
  readonly sendCheckin?: (checkin: AgentRuntimeCheckin) => Effect.Effect<void, Error>;
  readonly sendAlert?: (alert: AgentRuntimeAlert) => Effect.Effect<void, Error>;
  readonly onEvent: (handler: (event: AgentRuntimeEvent) => void) => void;
}

export type AgentRuntimeKind = "hermes" | "openclaw" | "none";

export interface AgentRuntimeDetection {
  readonly hermes: { readonly available: boolean; readonly path: string | null };
  readonly openclaw: {
    readonly available: boolean;
    readonly path: string | null;
    readonly gatewayRunning: boolean;
  };
  readonly recommended: AgentRuntimeKind;
}
