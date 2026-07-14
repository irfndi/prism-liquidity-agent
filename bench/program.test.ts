import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { buildLayer, estimatePositionValue } from "../engine/program.js";
import { ConfigService } from "../engine/config-service.js";
import {
  AdapterService,
  StrategyService,
  MemoryService,
  RiskService,
  BlacklistService,
  AuditService,
  ScreenerService,
  DbService,
  EntryPrepService,
} from "../engine/services.js";

function run<T>(effect: Effect.Effect<T, unknown, unknown>, layer: unknown): T {
  return Effect.runSync((Effect.provide as any)(effect, layer));
}

describe("Program integration", () => {
  it("buildLayer provides all services", () => {
    const layer = buildLayer();
    const result = run(
      Effect.gen(function* () {
        yield* ConfigService;
        yield* AdapterService;
        yield* StrategyService;
        yield* MemoryService;
        yield* RiskService;
        yield* BlacklistService;
        yield* AuditService;
        yield* ScreenerService;
        yield* DbService;
        yield* EntryPrepService;
        return "ok";
      }),
      layer,
    );
    expect(result).toBe("ok");
  });
});

describe("estimatePositionValue", () => {
  function makePos(lowerBinId: number, upperBinId: number, depositedUsd: number) {
    return {
      poolAddress: "pool1",
      positionPubKey: null,
      depositedUsd,
      currentValueUsd: depositedUsd,
      tokenXSymbol: "SOL",
      tokenYSymbol: "USDC",
      activeBinId: 5000,
      lowerBinId,
      upperBinId,
      timestamp: Date.now(),
      outOfRangeSince: null,
      oorCycleCount: 0,
      lastFeeClaimAt: Date.now(),
      trailingStopThreshold: null,
      highestValueUsd: null,
      lastRebalanceAt: 0,
      paperExitedAt: null,
      entrySignalTimestamp: null,
      entrySignalSnapshotId: null,
    };
  }

  function makePool(activeBinId: number) {
    return {
      address: "pool1",
      tokenX: "SOL",
      tokenY: "USDC",
      tokenXSymbol: "SOL",
      tokenYSymbol: "USDC",
      tvlUsd: 100_000,
      volume24hUsd: 30_000,
      fees24hUsd: 300,
      apr: 60,
      activeBinId,
      binStep: 10,
      currentPrice: 150,
      timestamp: Date.now(),
    };
  }

  it("returns deposited value when active bin is at center", () => {
    const pos = makePos(4980, 5020, 1000);
    const pool = makePool(5000);
    expect(estimatePositionValue(pos, pool)).toBe(1000);
  });

  it("decreases value as active bin drifts toward edge", () => {
    const pos = makePos(4980, 5020, 1000);
    const poolCenter = makePool(5000);
    const poolEdge = makePool(5020);
    const centerValue = estimatePositionValue(pos, poolCenter);
    const edgeValue = estimatePositionValue(pos, poolEdge);
    expect(edgeValue).toBeLessThan(centerValue);
  });

  it("reaches minimum value at far edge", () => {
    const pos = makePos(4980, 5020, 1000);
    const pool = makePool(5040);
    expect(estimatePositionValue(pos, pool)).toBe(500);
  });

  it("handles narrow ranges", () => {
    const pos = makePos(4995, 5005, 1000);
    const pool = makePool(5005);
    expect(estimatePositionValue(pos, pool)).toBe(500);
  });
});
