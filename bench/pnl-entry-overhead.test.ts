import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { computeEntryOverheadUsd, netWithdrawnUsd } from "../engine/adapter-service.js";
import { computeRealizedPnlUsd } from "../engine/pnl.js";
import { DbLive } from "../engine/db-service.js";
import { DbService } from "../engine/services.js";
import { SOL_MINT } from "../engine/constants.js";

const SOL_PRICE = 71;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEME = "98sMhvDwT5Yx3EYqcxNHKPUqF6NRqSFhT7p4Q8RDw9uh";
// A mint that is neither leg of the case below, so its delta always measures
// zero while the SOL leg carries the whole spend (the single-sided-Y shape).
const OTHER = "So11111111111111111111111111111111111111113";

type Held = ReadonlyMap<string, { readonly amountAtomic: bigint; readonly decimals: number }>;

function heldOf(entries: ReadonlyArray<[string, bigint, number]>): Held {
  return new Map(
    entries.map(([mint, amountAtomic, decimals]) => [mint, { amountAtomic, decimals }]),
  );
}

function solLegCase(depositAtomic: bigint, spentAtomic: bigint) {
  return {
    beforeHeld: heldOf([]),
    afterHeld: heldOf([]),
    beforeNativeSol: spentAtomic,
    afterNativeSol: 0n,
    tokenXMint: OTHER,
    tokenYMint: SOL_MINT,
    decimalsX: 6,
    decimalsY: 9,
    priceX: 1,
    priceY: SOL_PRICE,
    depositXAtomic: "0",
    depositYAtomic: depositAtomic.toString(),
  };
}

describe("computeEntryOverheadUsd", () => {
  it("books the measured rent + fee gap of a single-sided SOL entry", () => {
    // Live 2026-11-20 shape: 0.31708922 SOL left the wallet, 0.27488922 was
    // the deposit. The 0.0422 gap is position/bin-array/ATA rent + the fee,
    // which the close returns inside the measured withdrawal delta.
    const depositAtomic = 274_889_220n;
    const spentAtomic = 317_089_220n;
    expect(computeEntryOverheadUsd(solLegCase(depositAtomic, spentAtomic))).toBeCloseTo(
      0.0422 * SOL_PRICE,
      6,
    );
  });

  it("returns exactly 0 when the entry spent the deposit and nothing else", () => {
    const depositAtomic = 274_889_220n;
    expect(computeEntryOverheadUsd(solLegCase(depositAtomic, depositAtomic))).toBe(0);
  });

  it("never reports a credit when the wallet somehow spent less than the deposit", () => {
    const depositAtomic = 274_889_220n;
    const spentAtomic = 200_000_000n;
    expect(computeEntryOverheadUsd(solLegCase(depositAtomic, spentAtomic))).toBe(0);
  });

  it("returns null when the wallet snapshot is missing (unmeasurable, never 0)", () => {
    const input = solLegCase(274_889_220n, 317_089_220n);
    expect(computeEntryOverheadUsd({ ...input, beforeNativeSol: null })).toBeNull();
    expect(computeEntryOverheadUsd({ ...input, afterNativeSol: null })).toBeNull();
  });

  it("returns null when a price is unusable", () => {
    const input = solLegCase(274_889_220n, 317_089_220n);
    expect(computeEntryOverheadUsd({ ...input, priceY: undefined })).toBeNull();
    expect(computeEntryOverheadUsd({ ...input, priceX: 0 })).toBeNull();
  });

  it("ignores a leg the wallet GAINED instead of charging it as spend", () => {
    // before 100 USDC -> after 130 USDC: a receipt, not a cost.
    const input = {
      ...solLegCase(274_889_220n, 317_089_220n),
      beforeHeld: heldOf([[USDC, 100_000_000n, 6]]),
      afterHeld: heldOf([[USDC, 130_000_000n, 6]]),
      tokenXMint: USDC,
      priceX: 1,
      depositXAtomic: "0",
    };
    expect(computeEntryOverheadUsd(input)).toBeCloseTo(0.0422 * SOL_PRICE, 6);
  });

  it("caps a mis-decoded token delta at 3x the deposit instead of booking the treasury", () => {
    const before = heldOf([[MEME, 0n, 6]]);
    const after = heldOf([[MEME, 0n, 6]]);
    const input = {
      beforeHeld: before,
      afterHeld: after,
      beforeNativeSol: 1_000_000n,
      afterNativeSol: 1_000_000n,
      tokenXMint: MEME,
      tokenYMint: USDC,
      decimalsX: 6,
      decimalsY: 6,
      priceX: 0.001,
      priceY: 1,
      depositXAtomic: "1000000", // 1.0 token = $0.001
      depositYAtomic: "0",
    };
    // Both legs measured zero -> spent 0 -> deposit 0.001 -> overhead clamps to 0.
    expect(computeEntryOverheadUsd(input)).toBe(0);
  });
});

describe("netWithdrawnUsd", () => {
  it("removes the entry overhead so a flat round trip realizes exactly zero", () => {
    const deposit = 19.8757;
    const overhead = 0.0422 * SOL_PRICE; // what the close hands back as rent
    const gross = deposit + overhead;
    const net = netWithdrawnUsd(gross, overhead) ?? Number.NaN;
    expect(net).toBeCloseTo(deposit, 10);
    // ... and the ledger identity then books 0, not +rent.
    expect(computeRealizedPnlUsd(net, 0, deposit, 0)).toBeCloseTo(0, 10);
  });

  it("keeps a genuine loss and a genuine gain intact", () => {
    expect(netWithdrawnUsd(18, 3)).toBe(15);
    expect(netWithdrawnUsd(25, 3)).toBe(22);
  });

  it("floors at 0 rather than reporting a negative withdrawal", () => {
    expect(netWithdrawnUsd(2, 3)).toBe(0);
  });

  it("passes null through — an unpriced exit never becomes 0", () => {
    expect(netWithdrawnUsd(null, 3)).toBeNull();
  });

  it("ignores a non-finite or negative overhead", () => {
    expect(netWithdrawnUsd(20, Number.NaN)).toBe(20);
    expect(netWithdrawnUsd(20, -5)).toBe(20);
  });

  it("is the identity the old code violated, for a grid of deposits and rents", () => {
    // Property: for every deposit d and every overhead o, a round trip that
    // returns exactly d + o must realize 0. Pre-fix this returned +o.
    for (const d of [5, 19.19, 19.8757, 20, 44.4]) {
      for (const o of [0.5, 1.5, 3, 3.0024]) {
        const net = netWithdrawnUsd(d + o, o) ?? Number.NaN;
        expect(computeRealizedPnlUsd(net, 0, d, 0)).toBeCloseTo(0, 9);
      }
    }
  });
});

describe("entry overhead persistence", () => {
  function positionRecord(entryOverheadUsd: number | null) {
    return {
      positionId: "pos-overhead-1",
      poolAddress: "PoolOverhead1111111111111111111111111111111",
      positionPubKey: "PubkeyOverhead1111",
      depositedUsd: 19.88,
      currentValueUsd: 19.88,
      tokenXSymbol: "98sM",
      tokenYSymbol: "SOL",
      activeBinId: -73,
      lowerBinId: -95,
      upperBinId: -45,
      timestamp: 1_700_000_000_000,
      outOfRangeSince: null,
      oorCycleCount: 0,
      lastFeeClaimAt: 0,
      trailingStopThreshold: null,
      highestValueUsd: null,
      lastRebalanceAt: 0,
      paperExitedAt: null,
      entrySignalTimestamp: null,
      entrySignalSnapshotId: null,
      entryPriceUsd: 0.8995,
      entryAmountXUsd: 0,
      entryAmountYUsd: 19.88,
      cumulativeFeesClaimedUsd: 0,
      cumulativeRewardsClaimedUsd: 0,
      closedAt: null,
      realizedPnlUsd: null,
      entryOverheadUsd,
    };
  }

  it("round-trips through SQLite so the exit can subtract it", () => {
    const layer = DbLive(":memory:");
    Effect.runSync(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(positionRecord(3.0024));
        const read = yield* db.getPosition("pos-overhead-1");
        expect(read?.entryOverheadUsd).toBeCloseTo(3.0024, 6);
      }).pipe(Effect.provide(layer)),
    );
  });

  it("tolerates a legacy NULL (no overhead recorded) without inventing one", () => {
    const layer = DbLive(":memory:");
    Effect.runSync(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.savePosition(positionRecord(null));
        const read = yield* db.getPosition("pos-overhead-1");
        expect(read?.entryOverheadUsd ?? null).toBeNull();
        // A legacy close subtracts nothing — the old (gross) behaviour, never
        // a fabricated credit.
        expect(netWithdrawnUsd(22.88, read?.entryOverheadUsd ?? 0)).toBe(22.88);
      }).pipe(Effect.provide(layer)),
    );
  });
});
