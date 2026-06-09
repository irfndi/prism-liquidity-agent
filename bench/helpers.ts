import { Effect, Layer } from "effect";
import { vi } from "vitest";
import type { PoolState, BinArray, AgentDecision } from "../engine/types.js";
import type { PositionRecord } from "../engine/db-service.js";

// ─── Pool & Bin ──────────────────────────────────────────────────────────────

export function makePool(overrides: Partial<PoolState> = {}): PoolState {
  return {
    address: "TestPool111111111111111111111111111111111111",
    tokenX: "So11111111111111111111111111111111111111112",
    tokenY: "FakeToken1111111111111111111111111111111111",
    tokenXSymbol: "SOL",
    tokenYSymbol: "USDC",
    tvlUsd: 100_000,
    volume24hUsd: 30_000,
    fees24hUsd: 300,
    apr: 60,
    activeBinId: 5000,
    binStep: 10,
    currentPrice: 150,
    timestamp: Date.now(),
    ...overrides,
  };
}

export function makeBinArray(activeBinId = 5000, halfWidth = 20): BinArray {
  const bins = Array.from({ length: halfWidth * 2 }, (_, i) => ({
    binId: activeBinId - halfWidth + i,
    price: 150 + (i - halfWidth) * 0.1,
    reserveX: BigInt(1_000_000),
    reserveY: BigInt(1_000_000),
    liquiditySupply: BigInt(1_000_000_000),
  }));
  return {
    lowerBinId: activeBinId - halfWidth,
    upperBinId: activeBinId + halfWidth - 1,
    bins,
    activeBinId,
  };
}

// ─── Decision ────────────────────────────────────────────────────────────────

export function makeDecision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return {
    action: "HOLD",
    poolAddress: "TestPool111111111111111111111111111111111111",
    confidence: 0.75,
    reasoning: "Test decision",
    ...overrides,
  };
}

// ─── Position (DB record) ────────────────────────────────────────────────────

export function makePosition(
  overrides: Partial<PositionRecord> = {},
): PositionRecord {
  return {
    poolAddress: overrides.poolAddress ?? "Pool111111111111111111111111111111111111111",
    positionPubKey: overrides.positionPubKey ?? null,
    depositedUsd: overrides.depositedUsd ?? 1000,
    currentValueUsd: overrides.currentValueUsd ?? 1000,
    tokenXSymbol: "SOL",
    tokenYSymbol: "USDC",
    activeBinId: 5000,
    lowerBinId: 4980,
    upperBinId: 5020,
    timestamp: Date.now(),
    outOfRangeSince: null,
    oorCycleCount: 0,
    lastFeeClaimAt: Date.now(),
    trailingStopThreshold: overrides.trailingStopThreshold ?? null,
    highestValueUsd: overrides.highestValueUsd ?? null,
    lastRebalanceAt: overrides.lastRebalanceAt ?? 0,
    paperExitedAt: overrides.paperExitedAt ?? null,
  };
}

// ─── Effect runners ──────────────────────────────────────────────────────────

export function run<T, R>(effect: Effect.Effect<T, unknown, R>, layer: Layer.Layer<R, never, never>): T {
  return Effect.runSync(Effect.provide(effect, layer));
}

export async function runAsync<T>(
  effect: Effect.Effect<T, unknown, never>,
): Promise<T> {
  return Effect.runPromise(effect);
}

// ─── Fetch mock ──────────────────────────────────────────────────────────────

export function mockFetch(impl: typeof fetch): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(impl) as unknown as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}
