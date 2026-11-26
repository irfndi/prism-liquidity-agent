/**
 * E2E for #237: a paper position on a pool whose price history shows TA
 * exhaustion must (a) exit with an honest "losing position" reasoning when the
 * projected P&L is negative, (b) claim "profit-exhaustion" only when the
 * position is actually net-positive, and (c) obey the opt-in config gates.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { program } from "../engine/program.js";
import { makeTestLayer, makeAdapter, makePool, makePosition, asOwner } from "./helpers.js";
import { AuditService, DbService } from "../engine/services.js";
import type { AppConfig } from "../engine/config-service.js";

const POOL = "TaExhaustion1111111111111111111111111111111111";
const POS_ID = "paper-ta-exhaustion-pos";
// 39 flat closes + one uptick: RSI(2)=100, %B=1.59, above BB-upper, first green.
const TRIGGER_CLOSES: readonly number[] = [...Array<number>(39).fill(90), 90.9];

interface DecisionRow {
  action: string;
  reasoning: string;
  confidence: number;
  executed: boolean;
}

interface CycleOptions {
  /** Live pool price; below the entry price marks the position at a loss. */
  currentPrice: number;
  /** Claimed fees seeded on the position. */
  seededFeesUsd?: number;
  config?: Partial<AppConfig>;
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

async function runCycle(opts: CycleOptions): Promise<ReadonlyArray<DecisionRow>> {
  const now = Date.now();
  const layer = makeTestLayer({
    adapter: makeAdapter({
      [POOL]: makePool({
        address: POOL,
        tvlUsd: 100_000,
        volume24hUsd: 30_000,
        fees24hUsd: 300,
        currentPrice: opts.currentPrice,
        activeBinId: 5000,
        timestamp: now,
      }),
    }),
    configOverrides: makeConfigOverrides(opts.config),
    // No datapi source: the pool stays "heuristic", so the measured fee/IL
    // ratio is unknown and cannot satisfy the P&L gate's alternative leg.
  });
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
        positionPubKey: null,
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
      }),
    );
    const audit = yield* AuditService;
    // Wait for the per-position decision (any non-ENTER action): TA-exhaustion
    // is evaluated inside the deterministic EXIT chain ahead of it, so a
    // recorded non-ENTER row means the gate either fired or was suppressed.
    const waitForDecision = Effect.gen(function* () {
      for (let attempt = 0; attempt < 240; attempt += 1) {
        const rows = asOwner<ReadonlyArray<DecisionRow>>(yield* audit.getRecentDecisions(200));
        if (rows.some((row) => row.action !== "ENTER")) return true;
        yield* Effect.sleep(50);
      }
      return true;
    });
    yield* Effect.raceFirst(program, waitForDecision);
    return asOwner<ReadonlyArray<DecisionRow>>(yield* audit.getRecentDecisions(200));
  });
  // SAFETY: This test fixture is constructed to satisfy the asserted service/domain contract and is exercised by the surrounding test.
  return (await Effect.runPromise(
    asOwner<Effect.Effect<ReadonlyArray<DecisionRow>, Error, never>>(Effect.provide(test, layer)),
  )) as ReadonlyArray<DecisionRow>;
}

function taExit(decisions: ReadonlyArray<DecisionRow>): DecisionRow | undefined {
  return decisions.find((row) => row.reasoning.includes("[ta-exhaustion]"));
}

describe("TA-exhaustion E2E (#237)", () => {
  it("a losing position exits with an honest reasoning (no profit claim)", async () => {
    const decisions = await runCycle({ currentPrice: 90 });
    const exit = taExit(decisions);
    expect(exit, "the TA confluence must exit").toBeDefined();
    expect(exit?.action).toBe("EXIT");
    expect(exit?.confidence).toBe(1);
    expect(exit?.reasoning).not.toContain("profit-exhaustion");
    expect(exit?.reasoning).toContain("losing position");
  }, 15_000);

  it("a profitable position keeps the profit-exhaustion label", async () => {
    // $30 claimed fees clears the $10.5 modeled round-trip cost on a $1k paper
    // position, so the projected realized P&L is positive.
    const decisions = await runCycle({ currentPrice: 100, seededFeesUsd: 30 });
    const exit = taExit(decisions);
    expect(exit, "the TA confluence must exit").toBeDefined();
    expect(exit?.reasoning).toContain("profit-exhaustion");
    expect(exit?.reasoning).toContain("+$");
  }, 15_000);

  it("TA_EXHAUSTION_REQUIRE_NONNEGATIVE_PNL suppresses the losing exit", async () => {
    const decisions = await runCycle({
      currentPrice: 90,
      config: { taExhaustionRequireNonnegativePnl: true },
    });
    expect(taExit(decisions)).toBeUndefined();
    // The position was still evaluated: the decision path completed.
    expect(decisions.some((row) => row.action !== "ENTER")).toBe(true);
  }, 15_000);

  it("TA_EXHAUSTION_MIN_HOLD_MS suppresses an immature position", async () => {
    const decisions = await runCycle({
      currentPrice: 90,
      config: { taExhaustionMinHoldMs: 7_200_000 },
    });
    expect(taExit(decisions)).toBeUndefined();
    expect(decisions.some((row) => row.action !== "ENTER")).toBe(true);
  }, 15_000);

  it("TA_EXHAUSTION_ENABLED=false disables the gate", async () => {
    const decisions = await runCycle({
      currentPrice: 90,
      config: { taExhaustionEnabled: false },
    });
    expect(taExit(decisions)).toBeUndefined();
    expect(decisions.some((row) => row.action !== "ENTER")).toBe(true);
  }, 15_000);

  it("TA_EXHAUSTION_RSI_THRESHOLD=100 never trips on RSI 100", async () => {
    const decisions = await runCycle({
      currentPrice: 90,
      config: { taExhaustionRsiThreshold: 100 },
    });
    expect(taExit(decisions)).toBeUndefined();
    expect(decisions.some((row) => row.action !== "ENTER")).toBe(true);
  }, 15_000);
});
