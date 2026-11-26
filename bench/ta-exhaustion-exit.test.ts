/**
 * E2E for #237 (and its review follow-ups): a paper position on a pool whose
 * price history shows TA exhaustion must
 * (a) exit with an honest "losing position" reasoning when the projected P&L
 *     is negative (and the settled realized P&L must agree in sign),
 * (b) claim "profit-exhaustion" only when the position is actually net-positive,
 * (c) debit prior paper rebalance costs and use the configured tx estimate,
 * (d) treat a live fallback mark / unreadable pending fees as UNKNOWN, and
 * (e) obey the opt-in config gates.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { program } from "../engine/program.js";
import { makeTestLayer, makeAdapter, makePool, makePosition, asOwner } from "./helpers.js";
import { AuditService, DbService } from "../engine/services.js";
import type { AppConfig } from "../engine/config-service.js";

const POOL = "TaExhaustion1111111111111111111111111111111111";
const POS_ID = "paper-ta-exhaustion-pos";
const LIVE_POS_ID = "live-ta-exhaustion-pos";
// 39 flat closes + one uptick: RSI(2)=100, %B=1.59, above BB-upper, first green.
const TRIGGER_CLOSES: readonly number[] = [...Array<number>(39).fill(90), 90.9];

interface DecisionRow {
  action: string;
  reasoning: string;
  confidence: number;
  executed: boolean;
}

interface ClosedRow {
  positionId: string;
  realizedPnlUsd: number | null;
}

interface CycleOptions {
  /** Live pool price; below the entry price marks the position at a loss. */
  currentPrice: number;
  /** Claimed fees seeded on the position. */
  seededFeesUsd?: number;
  /** A prior paper REBALANCE event's modeled cost. */
  rebalanceCostsUsd?: number;
  /** Non-null makes the seeded row a live-identity position. */
  positionPubKey?: string | null;
  /** Adapter real on-chain mark (live positions only). */
  positionValueUsd?: number;
  /** Adapter pending claimable fees; null = unpriceable. */
  pendingFeesUsd?: number | null;
  /** Adapter pending claimable rewards; null = unpriceable. */
  pendingRewardsUsd?: number | null;
  /** Live entry overhead; null = unmeasured (the ledger books NULL). */
  entryOverheadUsd?: number | null;
  /** Wait for the paper close row so the settled sign can be asserted. */
  expectClose?: boolean;
  config?: Partial<AppConfig>;
}

interface CycleResult {
  decisions: ReadonlyArray<DecisionRow>;
  closed: ReadonlyArray<ClosedRow>;
}

function makeConfigOverrides(overrides: Partial<AppConfig> = {}): Partial<AppConfig> {
  return {
    paperTrading: true,
    scanIntervalMs: 300_000,
    watchlistPools: [POOL],
    maxOpenPositions: 1,
    ...overrides,
  };
}

async function runCycle(opts: CycleOptions): Promise<CycleResult> {
  const now = Date.now();
  const mark = opts.positionValueUsd;
  const pending = opts.pendingFeesUsd;
  const pendingRewards = opts.pendingRewardsUsd;
  const adapter = makeAdapter(
    {
      [POOL]: makePool({
        address: POOL,
        tvlUsd: 100_000,
        volume24hUsd: 30_000,
        fees24hUsd: 300,
        currentPrice: opts.currentPrice,
        activeBinId: 5000,
        timestamp: now,
      }),
    },
    {
      ...(mark !== undefined ? { getPositionValueUsd: () => Effect.succeed(mark) } : undefined),
      ...(pending !== undefined
        ? { getClaimableFeesUsd: () => Effect.succeed(pending) }
        : undefined),
      ...(pendingRewards !== undefined
        ? { getClaimableRewardsUsd: () => Effect.succeed(pendingRewards) }
        : undefined),
    },
  );
  const layer = makeTestLayer({
    adapter,
    configOverrides: makeConfigOverrides(opts.config),
    // No datapi source: the pool stays "heuristic", so the measured fee/IL
    // ratio is unknown and cannot satisfy the P&L gate's alternative leg.
  });
  const positionPubKey = opts.positionPubKey ?? null;
  const test = Effect.gen(function* () {
    const db = yield* DbService;
    for (const [index, close] of TRIGGER_CLOSES.entries()) {
      yield* db.saveSnapshot({
        poolAddress: POOL,
        timestamp: now - (TRIGGER_CLOSES.length - index) * 30_000,
        activeBinId: 5000,
        tvlUsd: 100_000,
        volume24hUsd: 30_000,
        fees24hUsd: 300,
        apr: 30,
        currentPrice: close,
        binStep: 10,
        tokenXSymbol: "SOL",
        tokenYSymbol: "USDC",
        binArray: { lowerBinId: 4980, upperBinId: 5020, bins: [], activeBinId: 5000 },
        // The TA feed reads measured snapshots only; provenance is independent
        // from the live pool's stats source.
        statsSource: "datapi",
      });
    }
    yield* db.savePosition(
      makePosition({
        poolAddress: POOL,
        positionId: POS_ID,
        positionPubKey,
        timestamp: now - 3_600_000,
        depositedUsd: 1_000,
        currentValueUsd: 1_000,
        cumulativeFeesClaimedUsd: opts.seededFeesUsd ?? 0,
        cumulativeRewardsClaimedUsd: 0,
        entryPriceUsd: 100,
        entryAmountXUsd: 500,
        entryAmountYUsd: 500,
        activeBinId: 5000,
        lowerBinId: 4980,
        upperBinId: 5020,
        valuationAnchorPriceUsd: 100,
        valuationAnchorBinId: 5000,
        valuationAnchorValueUsd: 1_000,
        entryOverheadUsd: opts.entryOverheadUsd,
      }),
    );
    if (opts.rebalanceCostsUsd !== undefined) {
      yield* db.savePositionEvent({
        id: `rebalance-${POS_ID}`,
        poolAddress: POOL,
        positionPubKey,
        positionId: POS_ID,
        event: "REBALANCE",
        valueUsd: null,
        feesUsd: null,
        price: 100,
        metadata: { modeledCostUsd: opts.rebalanceCostsUsd },
        createdAt: now - 1_800_000,
      });
    }
    const audit = yield* AuditService;
    // Wait for the per-position decision (any non-ENTER action): TA-exhaustion
    // is evaluated inside the deterministic EXIT chain ahead of it, so a
    // recorded non-ENTER row means the gate either fired or was suppressed.
    // Settlement tests additionally wait for the close row so the realized sign
    // can be compared with the label.
    const waitForDone = Effect.gen(function* () {
      for (let attempt = 0; attempt < 240; attempt += 1) {
        const rows = asOwner<ReadonlyArray<DecisionRow>>(yield* audit.getRecentDecisions(200));
        if (rows.some((row) => row.action !== "ENTER")) {
          if (opts.expectClose !== true) return true;
          const closed = yield* db.getClosedPositions();
          if (closed.some((row) => row.positionId === POS_ID)) return true;
        }
        yield* Effect.sleep(50);
      }
      return false;
    });
    const done = yield* Effect.raceFirst(program, waitForDone);
    if (done !== true) {
      throw new Error("TA-exhaustion test: no decision/settlement within the poll budget");
    }
    return {
      decisions: asOwner<ReadonlyArray<DecisionRow>>(yield* audit.getRecentDecisions(200)),
      closed: asOwner<ReadonlyArray<ClosedRow>>(yield* db.getClosedPositions()),
    };
  });
  // SAFETY: This test fixture is constructed to satisfy the asserted service/domain contract and is exercised by the surrounding test.
  return (await Effect.runPromise(
    asOwner<Effect.Effect<CycleResult, Error, never>>(Effect.provide(test, layer)),
  )) as CycleResult;
}

function taExit(decisions: ReadonlyArray<DecisionRow>): DecisionRow | undefined {
  return decisions.find((row) => row.reasoning.includes("[ta-exhaustion]"));
}

function settledRealized(closed: ReadonlyArray<ClosedRow>): number | null {
  return closed.find((row) => row.positionId === POS_ID)?.realizedPnlUsd ?? null;
}

describe("TA-exhaustion E2E (#237)", () => {
  it("a losing position exits with an honest reasoning and a settled loss", async () => {
    const { decisions, closed } = await runCycle({ currentPrice: 90, expectClose: true });
    const exit = taExit(decisions);
    expect(exit, "the TA confluence must exit").toBeDefined();
    expect(exit?.action).toBe("EXIT");
    expect(exit?.confidence).toBe(1);
    expect(exit?.reasoning).not.toContain("profit-exhaustion");
    expect(exit?.reasoning).toContain("losing position");
    const realized = settledRealized(closed);
    expect(realized).not.toBeNull();
    expect(realized!).toBeLessThan(0);
  }, 15_000);

  it("a profitable position keeps the profit-exhaustion label and settles positive", async () => {
    // $30 claimed fees clears the $10.5 modeled round-trip cost on a $1k paper
    // position, so the projected realized P&L is positive.
    const { decisions, closed } = await runCycle({
      currentPrice: 100,
      seededFeesUsd: 30,
      expectClose: true,
    });
    const exit = taExit(decisions);
    expect(exit, "the TA confluence must exit").toBeDefined();
    expect(exit?.reasoning).toContain("profit-exhaustion");
    expect(exit?.reasoning).toContain("+$");
    const realized = settledRealized(closed);
    expect(realized).not.toBeNull();
    expect(realized!).toBeGreaterThan(0);
  }, 15_000);

  it("debits prior paper rebalance costs exactly like settlement", async () => {
    // $30 fees − $10.5 close costs − $40 rebalance = −$20.5 both in the label
    // and in the settled row.
    const { decisions, closed } = await runCycle({
      currentPrice: 100,
      seededFeesUsd: 30,
      rebalanceCostsUsd: 40,
      expectClose: true,
    });
    const exit = taExit(decisions);
    expect(exit, "the TA confluence must exit").toBeDefined();
    expect(exit?.reasoning).not.toContain("profit-exhaustion");
    expect(exit?.reasoning).toContain("losing position");
    const realized = settledRealized(closed);
    expect(realized).not.toBeNull();
    expect(realized!).toBeLessThan(0);
  }, 15_000);

  it("uses the configured harvest tx estimate in both the projection and settlement", async () => {
    // $30 fees − ($10 swaps + 2 × $15 txs + $1.5 conversion) = −$11.5. If
    // paper settlement still used its $0.005 default, it would settle +$18.
    const { decisions, closed } = await runCycle({
      currentPrice: 100,
      seededFeesUsd: 30,
      config: { harvestTxCostUsdEst: 15 },
      expectClose: true,
    });
    const exit = taExit(decisions);
    expect(exit, "the TA confluence must exit").toBeDefined();
    expect(exit?.reasoning).toContain("losing position");
    const realized = settledRealized(closed);
    expect(realized).not.toBeNull();
    expect(realized!).toBeLessThan(0);
  }, 15_000);

  it("a fallback live mark is UNKNOWN (never profit-exhaustion)", async () => {
    // No getPositionValueUsd override: refreshPositionValue falls back to the
    // HODL mark (entry 100 → current 150 = $1,250), which would project a
    // large "profit" but is not what a close would withdraw.
    const { decisions } = await runCycle({
      currentPrice: 150,
      positionPubKey: LIVE_POS_ID,
    });
    const exit = taExit(decisions);
    expect(exit).toBeDefined();
    expect(exit?.reasoning).toContain("P&L unknown");
    expect(exit?.reasoning).not.toContain("profit-exhaustion");
  }, 15_000);

  it("...and the P&L gate fails closed on that unknown mark", async () => {
    const { decisions } = await runCycle({
      currentPrice: 150,
      positionPubKey: LIVE_POS_ID,
      config: { taExhaustionRequireNonnegativePnl: true },
    });
    expect(taExit(decisions)).toBeUndefined();
  }, 15_000);

  it("live pending fees the close sweeps push the projection positive", async () => {
    // Real mark $980 (−$20) + $40 pending fees − live close costs ($5.01) = +$14.99.
    const { decisions } = await runCycle({
      currentPrice: 100,
      positionPubKey: LIVE_POS_ID,
      positionValueUsd: 980,
      pendingFeesUsd: 40,
      pendingRewardsUsd: 0,
      config: { paperTrading: false },
    });
    const exit = taExit(decisions);
    expect(exit?.reasoning).toContain("profit-exhaustion");
  }, 15_000);

  it("...the same live position without pending income is a loss", async () => {
    const { decisions } = await runCycle({
      currentPrice: 100,
      positionPubKey: LIVE_POS_ID,
      positionValueUsd: 980,
      pendingFeesUsd: 0,
      pendingRewardsUsd: 0,
      config: { paperTrading: false },
    });
    const exit = taExit(decisions);
    expect(exit?.reasoning).toContain("losing position");
  }, 15_000);

  it("...unpriceable pending fees label the projection unknown", async () => {
    const { decisions } = await runCycle({
      currentPrice: 100,
      positionPubKey: LIVE_POS_ID,
      positionValueUsd: 980,
      pendingFeesUsd: null,
      pendingRewardsUsd: 0,
      config: { paperTrading: false },
    });
    const exit = taExit(decisions);
    expect(exit?.reasoning).toContain("P&L unknown");
    expect(exit?.reasoning).not.toContain("profit-exhaustion");
  }, 15_000);

  it("...and the P&L gate fails closed on unreadable pending fees", async () => {
    const { decisions } = await runCycle({
      currentPrice: 100,
      positionPubKey: LIVE_POS_ID,
      positionValueUsd: 980,
      pendingFeesUsd: null,
      pendingRewardsUsd: 0,
      config: { paperTrading: false, taExhaustionRequireNonnegativePnl: true },
    });
    expect(taExit(decisions)).toBeUndefined();
    expect(decisions.some((row) => row.action !== "ENTER")).toBe(true);
  }, 15_000);

  it("live pending LM rewards the close sweeps are included in the projection", async () => {
    // Real mark $980 (−$20) + $40 pending rewards − live close costs = +$14.99.
    const { decisions } = await runCycle({
      currentPrice: 100,
      positionPubKey: LIVE_POS_ID,
      positionValueUsd: 980,
      pendingFeesUsd: 0,
      pendingRewardsUsd: 40,
      config: { paperTrading: false },
    });
    expect(taExit(decisions)?.reasoning).toContain("profit-exhaustion");
  }, 15_000);

  it("...and unpriceable pending rewards are UNKNOWN (never zero)", async () => {
    const { decisions } = await runCycle({
      currentPrice: 100,
      positionPubKey: LIVE_POS_ID,
      positionValueUsd: 980,
      pendingFeesUsd: 0,
      pendingRewardsUsd: null,
      config: { paperTrading: false },
    });
    const exit = taExit(decisions);
    expect(exit?.reasoning).toContain("P&L unknown");
    expect(exit?.reasoning).not.toContain("profit-exhaustion");
  }, 15_000);

  it("...and the P&L gate fails closed on unreadable pending rewards", async () => {
    const { decisions } = await runCycle({
      currentPrice: 100,
      positionPubKey: LIVE_POS_ID,
      positionValueUsd: 980,
      pendingFeesUsd: 0,
      pendingRewardsUsd: null,
      config: { paperTrading: false, taExhaustionRequireNonnegativePnl: true },
    });
    expect(taExit(decisions)).toBeUndefined();
    expect(decisions.some((row) => row.action !== "ENTER")).toBe(true);
  }, 15_000);

  it("PAPER_MODE_EXIT_LIVE uses live accounting for the live close", async () => {
    // Paper config, but a live-identity position exits through executeLive; the
    // projection must read pending income and price the live close, not the
    // paper one. Old code skipped pending and charged paper costs → loss.
    const { decisions } = await runCycle({
      currentPrice: 100,
      positionPubKey: LIVE_POS_ID,
      positionValueUsd: 980,
      pendingFeesUsd: 0,
      pendingRewardsUsd: 40,
      config: { paperTrading: true, paperModeExitLive: true },
    });
    expect(taExit(decisions)?.reasoning).toContain("profit-exhaustion");
  }, 15_000);

  it("a live row without measured entry overhead is UNKNOWN", async () => {
    // exitOverheadUnknown() makes the ledger realize NULL for these rows; the
    // projection must not claim a sign the settlement cannot book.
    const { decisions } = await runCycle({
      currentPrice: 100,
      positionPubKey: LIVE_POS_ID,
      positionValueUsd: 980,
      pendingFeesUsd: 0,
      pendingRewardsUsd: 0,
      entryOverheadUsd: null,
      config: { paperTrading: false },
    });
    const exit = taExit(decisions);
    expect(exit?.reasoning).toContain("P&L unknown");
    expect(exit?.reasoning).not.toContain("profit-exhaustion");
  }, 15_000);

  it("...and the P&L gate fails closed on unknown entry overhead", async () => {
    const { decisions } = await runCycle({
      currentPrice: 100,
      positionPubKey: LIVE_POS_ID,
      positionValueUsd: 980,
      pendingFeesUsd: 0,
      pendingRewardsUsd: 0,
      entryOverheadUsd: null,
      config: { paperTrading: false, taExhaustionRequireNonnegativePnl: true },
    });
    expect(taExit(decisions)).toBeUndefined();
    expect(decisions.some((row) => row.action !== "ENTER")).toBe(true);
  }, 15_000);

  it("TA_EXHAUSTION_REQUIRE_NONNEGATIVE_PNL suppresses the losing exit", async () => {
    const { decisions } = await runCycle({
      currentPrice: 90,
      config: { taExhaustionRequireNonnegativePnl: true },
    });
    expect(taExit(decisions)).toBeUndefined();
    // The position was still evaluated: the decision path completed.
    expect(decisions.some((row) => row.action !== "ENTER")).toBe(true);
  }, 15_000);

  it("TA_EXHAUSTION_MIN_HOLD_MS suppresses an immature position", async () => {
    const { decisions } = await runCycle({
      currentPrice: 90,
      config: { taExhaustionMinHoldMs: 7_200_000 },
    });
    expect(taExit(decisions)).toBeUndefined();
    expect(decisions.some((row) => row.action !== "ENTER")).toBe(true);
  }, 15_000);

  it("TA_EXHAUSTION_ENABLED=false disables the gate", async () => {
    const { decisions } = await runCycle({
      currentPrice: 90,
      config: { taExhaustionEnabled: false },
    });
    expect(taExit(decisions)).toBeUndefined();
    expect(decisions.some((row) => row.action !== "ENTER")).toBe(true);
  }, 15_000);

  it("TA_EXHAUSTION_RSI_THRESHOLD=100 never trips on RSI 100", async () => {
    const { decisions } = await runCycle({
      currentPrice: 90,
      config: { taExhaustionRsiThreshold: 100 },
    });
    expect(taExit(decisions)).toBeUndefined();
    expect(decisions.some((row) => row.action !== "ENTER")).toBe(true);
  }, 15_000);
});
