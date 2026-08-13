/** Economic harvest gate (Robinhood rule 10): never spend $0.80 to realize
 * $1.00. Pure decision logic + the wiring proof: a below-floor pending claim
 * is skipped and the claim interval is NOT re-armed; a healthy claim runs. */
import { describe, expect, it, vi } from "vitest";
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = { [key: string]: JsonValue };
type ClaimResult = {
  feeX: number;
  feeY: number;
  platformFeeX: number;
  platformFeeY: number;
  netFeeX: bigint;
  netFeeY: bigint;
  txSignature: string;
  netFeesUsd?: number;
};
import { Effect } from "effect";
import { evaluateHarvestGate, program } from "../engine/program.js";
import {
  makePool,
  makePosition,
  makeTestLayer,
  makeAdapter,
  makeDatapiStats,
  asOwner,
} from "./helpers.js";
import { DbService } from "../engine/services.js";
import type { PositionRecord } from "../engine/db-service.js";

const POOL = "HarvestPool1111111111111111111111111111111111111";
const POS_ID = "harvest-pos";

const CONFIG = {
  harvestMinNetUsd: 1,
  harvestMaxCostPct: 0.15,
  harvestTxCostUsdEst: 0.005,
} as const;

function gate(netUsd: number | null, overrides: Partial<Record<keyof typeof CONFIG, number>> = {}) {
  return evaluateHarvestGate(netUsd, { ...CONFIG, ...overrides } as never);
}

describe("evaluateHarvestGate (pure decision)", () => {
  it("approves a healthy pending claim", () => {
    expect(gate(10).approved).toBe(true);
  });

  it("rejects below the USD floor", () => {
    const g = gate(0.9);
    expect(g.approved).toBe(false);
    expect(g.reason).toContain("[harvest-gate]");
    expect(g.reason).toContain("below floor");
  });

  it("rejects when estimated tx cost exceeds the allowed fraction of gross", () => {
    // cost 0.005 > 0.15 × 0.02 = 0.003 (floor lowered so the cost check runs)
    const g = gate(0.02, { harvestMinNetUsd: 0.001 });
    expect(g.approved).toBe(false);
    expect(g.reason).toContain("est cost");
  });

  it("boundary: cost exactly at the fraction is approved", () => {
    // 0.15 × (1/30) = 0.005 exactly -> approved (floor lowered)
    expect(gate(1 / 30, { harvestMinNetUsd: 0 }).approved).toBe(true);
  });

  it("floor exactly at the boundary is approved", () => {
    expect(gate(1).approved).toBe(true);
  });

  it("fail-open: unknown pending amount always claims (fee capture is protective)", () => {
    const g = gate(null);
    expect(g.approved).toBe(true);
    expect(g.reason).toContain("fail open");
  });

  it("a high-cost config can still approve large claims", () => {
    const g = gate(50, { harvestMaxCostPct: 0.5, harvestTxCostUsdEst: 5 });
    expect(g.approved).toBe(true);
  });
});

describe("claim wiring (cadence-block gate)", () => {
  async function runClaimCycle(overrides: {
    pendingUsd: number;
    claimFeesImpl: () => Effect.Effect<ClaimResult, never, never>;
  }): Promise<{ saved: PositionRecord | undefined; claimCalls: number }> {
    const claimSpy = vi.fn(overrides.claimFeesImpl);
    const layer = makeTestLayer({
      adapter: makeAdapter(
        { [POOL]: makePool({ address: POOL, tvlUsd: 100_000, fees24hUsd: 100 }) },
        {
          // The mock wallet owns the seeded position so the startup
          // reconcile does not treat it as externally closed.
          getAllWalletPositions: () =>
            Effect.succeed([
              {
                positionPubKey: POS_ID,
                poolAddress: POOL,
                lowerBinId: 4990,
                upperBinId: 5010,
              },
            ]),
          claimFees: claimSpy as never,
          claimRewards: () =>
            Effect.succeed({
              skipped: true,
              skipReason: null,
              rewards: [],
              txSignatures: [],
            }),
          getClaimableFeesUsd: () => Effect.succeed(overrides.pendingUsd),
        } as never,
      ),
      configOverrides: {
        paperTrading: false,
        scanIntervalMs: 300, // scheduled cycle (with claimAllFees) fires in-window
        // Long interval: the FIRST cycle claims (lastFeeClaimAt=0), then the
        // re-arm gates the rest — exactly one claim call proves the wiring.
        feeClaimIntervalMs: 10_000_000,
        farmRewardsEnabled: false,
        watchlistPools: [POOL], // pool in the scan set so the cycle runs
      },
      datapi: {
        getPoolData: (addr: string) =>
          Effect.succeed(addr === POOL ? makeDatapiStats({ address: POOL }) : null),
      },
    });
    const test = Effect.gen(function* () {
      const db = yield* DbService;
      yield* db.savePosition(
        makePosition({
          poolAddress: POOL,
          positionPubKey: POS_ID,
          lastFeeClaimAt: 0,
          depositedUsd: 1_000,
          currentValueUsd: 1_000,
        }),
      );
      yield* Effect.raceFirst(program, Effect.sleep(2_500));
      const saved = yield* db.getPosition(POS_ID);
      return saved;
    });
    const saved = (await Effect.runPromise(
      asOwner<Effect.Effect<PositionRecord | undefined, Error, never>>(Effect.provide(test, layer)),
    )) as PositionRecord | undefined;
    return { saved, claimCalls: claimSpy.mock.calls.length };
  }

  it("below the USD floor -> claim skipped, interval NOT re-armed", async () => {
    const { saved, claimCalls } = await runClaimCycle({
      pendingUsd: 0.05,
      claimFeesImpl: () =>
        Effect.succeed({
          feeX: 100,
          feeY: 0,
          platformFeeX: 0,
          platformFeeY: 0,
          netFeeX: 100n,
          netFeeY: 0n,
          txSignature: "tx",
        }),
    });
    expect(claimCalls).toBe(0); // the gate exists to skip the on-chain claim
    expect(saved?.lastFeeClaimAt).toBe(0); // skipped claim retries next scan
  });

  it("healthy pending -> claim executes, interval re-armed", async () => {
    const { saved, claimCalls } = await runClaimCycle({
      pendingUsd: 10,
      claimFeesImpl: () =>
        Effect.succeed({
          feeX: 100,
          feeY: 0,
          platformFeeX: 0,
          platformFeeY: 0,
          netFeeX: 100n,
          netFeeY: 0n,
          txSignature: "tx",
          netFeesUsd: 10,
        }),
    });
    expect(claimCalls).toBe(1);
    expect(saved?.lastFeeClaimAt).toBeGreaterThan(0);
  });
});
