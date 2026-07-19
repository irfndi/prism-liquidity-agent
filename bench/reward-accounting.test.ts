import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { DbLive } from "../engine/db-service.js";
import { DbService } from "../engine/services.js";
import { computePositionAnalytics, computeRealizedPnlUsd } from "../engine/pnl.js";
import {
  summarizeRewardClaim,
  buildRewardClaimMetadata,
  type ClaimedReward,
} from "../engine/rewards.js";

// ─── Wave 8: reward accounting ───────────────────────────────────────────────
// Rewards are tracked SEPARATELY from swap fees: cumulativeRewardsClaimedUsd
// accumulates USD-valued reward claims while cumulativeFeesClaimedUsd stays
// fee-pure (fee APR must never include farm rewards). Total PnL includes both.

function run<T>(effect: Effect.Effect<T, unknown, unknown>, layer: unknown): T {
  return Effect.runSync((Effect.provide as any)(effect, layer));
}

function makeDbPosition(overrides: Record<string, unknown> = {}) {
  return {
    positionId: "PosRewards11111111111111111111111111111111",
    poolAddress: "PoolRewards1111111111111111111111111111111",
    positionPubKey: "PosRewards11111111111111111111111111111111",
    depositedUsd: 1000,
    currentValueUsd: 1000,
    tokenXSymbol: "SOL",
    tokenYSymbol: "USDC",
    activeBinId: 5000,
    lowerBinId: 4980,
    upperBinId: 5020,
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
    entryPriceUsd: null,
    entryAmountXUsd: null,
    entryAmountYUsd: null,
    cumulativeFeesClaimedUsd: 0,
    cumulativeRewardsClaimedUsd: 0,
    closedAt: null,
    realizedPnlUsd: null,
    ...overrides,
  };
}

describe("pnl — rewards are additive to total PnL but not to fee APR", () => {
  const base = {
    depositedUsd: 1000,
    currentValueUsd: 1100,
    cumulativeFeesClaimedUsd: 25,
    entryPriceUsd: null,
    entryAmountXUsd: null,
    entryAmountYUsd: null,
    openedAtMs: Date.now() - 10 * 24 * 60 * 60 * 1000,
    outOfRangeSinceMs: null,
  };

  it("(v) unrealized PnL includes claimed rewards", () => {
    const without = computePositionAnalytics(base, null, Date.now());
    const withRewards = computePositionAnalytics(
      { ...base, cumulativeRewardsClaimedUsd: 40 },
      null,
      Date.now(),
    );
    expect(without.unrealizedPnlUsd).toBeCloseTo(125, 8); // 1100 + 25 − 1000
    expect(withRewards.unrealizedPnlUsd).toBeCloseTo(165, 8); // + 40 rewards
    expect(withRewards.rewardsClaimedUsd).toBeCloseTo(40, 8);
  });

  it("(v) fee APR stays fee-pure (rewards excluded)", () => {
    const now = Date.now();
    const withRewards = computePositionAnalytics(
      { ...base, cumulativeRewardsClaimedUsd: 400 },
      null,
      now,
    );
    const without = computePositionAnalytics(base, null, now);
    expect(withRewards.feeAprPct).toBeCloseTo(without.feeAprPct ?? 0, 8);
  });

  it("(v) omitted rewards default to zero (W4 math unchanged)", () => {
    const analytics = computePositionAnalytics(base, null, Date.now());
    expect(analytics.rewardsClaimedUsd).toBe(0);
    expect(analytics.unrealizedPnlUsd).toBeCloseTo(125, 8);
  });

  it("(v) realized PnL at close includes rewards via the explicit parameter", () => {
    expect(computeRealizedPnlUsd(1100, 25, 1000)).toBeCloseTo(125, 8);
    expect(computeRealizedPnlUsd(1100, 25, 1000, 40)).toBeCloseTo(165, 8);
  });
});

describe("rewards helpers", () => {
  it("(v) summarizeRewardClaim totals only USD-priced amounts and counts unpriced", () => {
    const rewards: ClaimedReward[] = [
      { mint: "MintA", amountAtomic: 250_000_000, amountUsd: 100 },
      { mint: "MintB", amountAtomic: 50_000, amountUsd: null },
    ];
    const summary = summarizeRewardClaim(rewards);
    expect(summary.totalUsd).toBeCloseTo(100, 8);
    expect(summary.unpricedCount).toBe(1);
    expect(summary.totalCount).toBe(2);
  });

  it("(v) buildRewardClaimMetadata records raw amounts + mints + tx signatures", () => {
    const metadata = buildRewardClaimMetadata({
      txSignatures: ["sig1", "sig2"],
      rewards: [
        { mint: "MintA", amountAtomic: 250_000_000, amountUsd: 100 },
        { mint: "MintB", amountAtomic: 50_000, amountUsd: null },
      ],
    });
    expect(metadata.kind).toBe("lm_reward");
    expect(metadata.txSignatures).toEqual(["sig1", "sig2"]);
    const rewards = metadata.rewards as Array<Record<string, unknown>>;
    expect(rewards).toHaveLength(2);
    expect(rewards[0]).toMatchObject({ mint: "MintA", amountAtomic: 250_000_000, amountUsd: 100 });
    expect(rewards[1]).toMatchObject({ mint: "MintB", amountAtomic: 50_000, amountUsd: null });
  });
});

describe("DbService — cumulativeRewardsClaimedUsd", () => {
  function makeLayer() {
    return DbLive(":memory:");
  }

  it("(v) migration v17 adds the column and round-trips reward totals", () => {
    const layer = makeLayer();
    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        const pos = makeDbPosition({ cumulativeRewardsClaimedUsd: 42.5 });
        yield* db.savePosition(pos);
        const retrieved = yield* db.getPosition(pos.positionId);
        expect(retrieved).not.toBeNull();
        expect(retrieved!.cumulativeRewardsClaimedUsd).toBeCloseTo(42.5, 8);
        // Fees remain fee-pure.
        expect(retrieved!.cumulativeFeesClaimedUsd).toBe(0);
      }),
      layer,
    );
  });

  it("(v) defaults to 0 for positions that never claimed rewards", () => {
    const layer = makeLayer();
    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        const pos = makeDbPosition();
        yield* db.savePosition(pos);
        const retrieved = yield* db.getPosition(pos.positionId);
        expect(retrieved!.cumulativeRewardsClaimedUsd).toBe(0);
      }),
      layer,
    );
  });

  it("(v) reward CLAIM events persist with raw reward metadata", () => {
    const layer = makeLayer();
    run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(makeDbPosition());
        yield* db.savePositionEvent({
          id: "evt-reward-1",
          poolAddress: "PoolRewards1111111111111111111111111111111",
          positionPubKey: "PosRewards11111111111111111111111111111111",
          positionId: "PosRewards11111111111111111111111111111111",
          event: "CLAIM",
          valueUsd: 100,
          feesUsd: null,
          price: null,
          metadata: buildRewardClaimMetadata({
            txSignatures: ["sig1"],
            rewards: [{ mint: "MintA", amountAtomic: 250_000_000, amountUsd: 100 }],
          }),
          createdAt: Date.now(),
        });
        const events = yield* db.getPositionEvents("PoolRewards1111111111111111111111111111111");
        expect(events).toHaveLength(1);
        const event = events[0]!;
        expect(event.event).toBe("CLAIM");
        // fees_usd stays NULL on reward claims — fee queries stay fee-pure.
        expect(event.feesUsd).toBeNull();
        const metadata = JSON.parse(event.metadata ?? "{}") as Record<string, unknown>;
        expect(metadata.kind).toBe("lm_reward");
      }),
      layer,
    );
  });
});
