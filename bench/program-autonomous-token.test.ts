import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  isActionAllowedDuringSafetyPause,
  isTransientSettlementError,
  loadDailyEquityBaseline,
  nextSettlementRetryAt,
  oldestActiveSettlementAgeMs,
  persistDailyEquityBaseline,
  processSettlementJobs,
  safetyPauseBlockReason,
  decayExecutionFailureCounter,
  shouldAutoResolveDailyDrawdownPause,
  shouldAutoResolveExecutionFailuresPause,
  shouldTriggerSafetyPause,
  sweepOrphanSettlements,
} from "../engine/autonomous-runtime.js";
import { SOL_MINT } from "../engine/constants.js";
import { computeNetRealizedPnlUsd } from "../engine/pnl.js";
import type {
  AdapterApi,
  DbApi,
  PreparedSwap,
  SwapQuote,
  SwapSimulation,
} from "../engine/services.js";
import type { SettlementJobRecord } from "../engine/types.js";
import type { AutonomousTokenMode } from "../engine/types.js";

function settlementJob(overrides: Partial<SettlementJobRecord> = {}): SettlementJobRecord {
  return {
    id: "settlement-1",
    walletAddress: "wallet-1",
    agentInstanceId: "primary",
    positionId: "position-1",
    poolAddress: "pool-1",
    tokenMint: "token-1",
    amountAtomic: "9007199254740993",
    destinationAsset: "SOL",
    status: "pending",
    attempts: 0,
    nextRetryAt: null,
    txSignature: null,
    confirmedOutputAtomic: null,
    outputUsd: null,
    executionCostUsd: null,
    finalizedAt: null,
    realizedPnlUsd: null,
    expiresAt: 1_000_000,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function swapQuote(job: SettlementJobRecord): SwapQuote {
  return {
    request: {
      inputMint: job.tokenMint,
      outputMint: SOL_MINT,
      amountAtomic: BigInt(job.amountAtomic),
      slippageBps: 50,
    },
    outAmountAtomic: 1n,
    minimumOutAmountAtomic: 1n,
    priceImpactBps: 1,
    quotedAt: 1,
    route: [{ inputMint: job.tokenMint, outputMint: SOL_MINT }],
    rawQuote: {},
  };
}

function runSettlementProcessor(
  jobs: ReadonlyArray<SettlementJobRecord>,
  adapter: AdapterApi,
  savedJobs: SettlementJobRecord[],
  mode: AutonomousTokenMode = "live",
): Promise<ReadonlyArray<SettlementJobRecord>> {
  return Effect.runPromise(
    processSettlementJobs({
      adapter,
      db: {
        saveSettlementJob: (job: SettlementJobRecord) =>
          Effect.sync(() => {
            savedJobs.push(job);
          }),
        getPosition: () => Effect.succeed(null),
      } as unknown as DbApi,
      jobs,
      mode,
      now: 10_000,
      maxSwapSlippageBps: 50,
    }),
  );
}

describe("autonomous token runtime policy", () => {
  it("allows exits but blocks entry and rebalance during a persistent safety pause", () => {
    // Given / When / Then
    expect(isActionAllowedDuringSafetyPause("EXIT")).toBe(true);
    expect(isActionAllowedDuringSafetyPause("HOLD")).toBe(true);
    expect(isActionAllowedDuringSafetyPause("ENTER")).toBe(false);
    expect(isActionAllowedDuringSafetyPause("REBALANCE")).toBe(false);
  });

  it("enforces the safety pause at risk gates except in shadow mode (issue #148)", () => {
    // Given an unresolved pause on a live account.
    const pause = {
      walletAddress: "wallet-1",
      agentInstanceId: "primary",
      reason: "daily_drawdown",
      triggeredAt: 1_000,
      resolvedAt: null as number | null,
    };

    // Live blocks entry/rebalance but permits EXIT/HOLD.
    expect(safetyPauseBlockReason("live", pause, "ENTER")).toBe(
      "Wallet safety pause active: daily_drawdown",
    );
    expect(safetyPauseBlockReason("live", pause, "REBALANCE")).toBe(
      "Wallet safety pause active: daily_drawdown",
    );
    expect(safetyPauseBlockReason("live", pause, "EXIT")).toBeNull();
    expect(safetyPauseBlockReason("live", pause, "HOLD")).toBeNull();

    // Shadow is informational only — never blocks any action.
    expect(safetyPauseBlockReason("shadow", pause, "ENTER")).toBeNull();
    expect(safetyPauseBlockReason("shadow", pause, "REBALANCE")).toBeNull();

    // A resolved pause does not block.
    expect(safetyPauseBlockReason("live", { ...pause, resolvedAt: 2_000 }, "ENTER")).toBeNull();

    // No pause never blocks.
    expect(safetyPauseBlockReason("live", null, "ENTER")).toBeNull();
  });

  it("triggers each wallet safety threshold at its configured boundary", () => {
    // Given / When / Then
    expect(
      shouldTriggerSafetyPause({
        dailyDrawdownPct: 5,
        maxDailyDrawdownPct: 5,
        consecutiveCoreDataFailures: 0,
        consecutiveExecutionFailures: 0,
        maxConsecutiveExecutionFailures: 3,
        oldestSettlementAgeMs: 0,
        settlementMaxPendingMs: 3_600_000,
      }),
    ).toBe("daily_drawdown");
    expect(
      shouldTriggerSafetyPause({
        dailyDrawdownPct: 0,
        maxDailyDrawdownPct: 5,
        consecutiveCoreDataFailures: 2,
        consecutiveExecutionFailures: 0,
        maxConsecutiveExecutionFailures: 3,
        oldestSettlementAgeMs: 0,
        settlementMaxPendingMs: 3_600_000,
      }),
    ).toBe("core_data_unavailable");
    expect(
      shouldTriggerSafetyPause({
        dailyDrawdownPct: 0,
        maxDailyDrawdownPct: 5,
        consecutiveCoreDataFailures: 0,
        consecutiveExecutionFailures: 3,
        maxConsecutiveExecutionFailures: 3,
        oldestSettlementAgeMs: 0,
        settlementMaxPendingMs: 3_600_000,
      }),
    ).toBe("execution_failures");
    expect(
      shouldTriggerSafetyPause({
        dailyDrawdownPct: 0,
        maxDailyDrawdownPct: 5,
        consecutiveCoreDataFailures: 0,
        consecutiveExecutionFailures: 0,
        maxConsecutiveExecutionFailures: 3,
        oldestSettlementAgeMs: 3_600_001,
        settlementMaxPendingMs: 3_600_000,
      }),
    ).toBe("settlement_overdue");
  });

  it("auto-resolves a latched daily_drawdown pause per the mode table (issue #148)", () => {
    // Given a disabled threshold (gate off) — a leftover pause never latches.
    expect(
      shouldAutoResolveDailyDrawdownPause({
        mode: "live",
        dailyDrawdownPct: 99,
        maxDailyDrawdownPct: 0,
        dayRolledOver: false,
      }),
    ).toBe(true);

    // Shadow is informational only — always auto-resolve, never latch.
    expect(
      shouldAutoResolveDailyDrawdownPause({
        mode: "shadow",
        dailyDrawdownPct: 99,
        maxDailyDrawdownPct: 5,
        dayRolledOver: false,
      }),
    ).toBe(true);

    // Canary auto-clears at the day-boundary rollover even while still breached.
    expect(
      shouldAutoResolveDailyDrawdownPause({
        mode: "canary",
        dailyDrawdownPct: 99,
        maxDailyDrawdownPct: 5,
        dayRolledOver: true,
      }),
    ).toBe(true);

    // Canary also clears as soon as the drawdown recovers below the threshold.
    expect(
      shouldAutoResolveDailyDrawdownPause({
        mode: "canary",
        dailyDrawdownPct: 4,
        maxDailyDrawdownPct: 5,
        dayRolledOver: false,
      }),
    ).toBe(true);

    // Canary stays latched while breached and no rollover has occurred.
    expect(
      shouldAutoResolveDailyDrawdownPause({
        mode: "canary",
        dailyDrawdownPct: 6,
        maxDailyDrawdownPct: 5,
        dayRolledOver: false,
      }),
    ).toBe(false);

    // Live re-evaluates fresh each cycle — recovery (or a fresh-day baseline
    // that drops the measured drawdown to ~0) clears it; a live breach latches.
    expect(
      shouldAutoResolveDailyDrawdownPause({
        mode: "live",
        dailyDrawdownPct: 4,
        maxDailyDrawdownPct: 5,
        dayRolledOver: false,
      }),
    ).toBe(true);
    expect(
      shouldAutoResolveDailyDrawdownPause({
        mode: "live",
        dailyDrawdownPct: 6,
        maxDailyDrawdownPct: 5,
        dayRolledOver: true,
      }),
    ).toBe(false);
  });

  it("auto-resolves a latched execution_failures pause per the mode table (issue #182)", () => {
    // Given a disabled threshold (breaker off) — a leftover pause never latches.
    expect(
      shouldAutoResolveExecutionFailuresPause({
        mode: "live",
        consecutiveExecutionFailures: 99,
        maxConsecutiveExecutionFailures: 0,
      }),
    ).toBe(true);

    // Shadow is informational only — always auto-resolve, never latch.
    expect(
      shouldAutoResolveExecutionFailuresPause({
        mode: "shadow",
        consecutiveExecutionFailures: 99,
        maxConsecutiveExecutionFailures: 3,
      }),
    ).toBe(true);

    // A fresh process starts the counter at 0 — a restart alone clears the latch.
    expect(
      shouldAutoResolveExecutionFailuresPause({
        mode: "live",
        consecutiveExecutionFailures: 0,
        maxConsecutiveExecutionFailures: 3,
      }),
    ).toBe(true);

    // Recovery below the threshold clears the latch mid-run.
    expect(
      shouldAutoResolveExecutionFailuresPause({
        mode: "canary",
        consecutiveExecutionFailures: 2,
        maxConsecutiveExecutionFailures: 3,
      }),
    ).toBe(true);
    expect(
      shouldAutoResolveExecutionFailuresPause({
        mode: "live",
        consecutiveExecutionFailures: 2,
        maxConsecutiveExecutionFailures: 3,
      }),
    ).toBe(true);

    // The pause stays latched while the counter genuinely breaches again.
    expect(
      shouldAutoResolveExecutionFailuresPause({
        mode: "live",
        consecutiveExecutionFailures: 3,
        maxConsecutiveExecutionFailures: 3,
      }),
    ).toBe(false);
    expect(
      shouldAutoResolveExecutionFailuresPause({
        mode: "canary",
        consecutiveExecutionFailures: 4,
        maxConsecutiveExecutionFailures: 3,
      }),
    ).toBe(false);
  });

  it("a quiet cycle decays the failure counter so a stale breach cannot re-arm (issue #182 review)", () => {
    // Cycle N: a spike of 3 execution failures arms the pause.
    let counter = decayExecutionFailureCounter(3, 3);
    expect(
      shouldTriggerSafetyPause({
        dailyDrawdownPct: 0,
        maxDailyDrawdownPct: 5,
        consecutiveCoreDataFailures: 0,
        consecutiveExecutionFailures: counter,
        maxConsecutiveExecutionFailures: 3,
        oldestSettlementAgeMs: 0,
        settlementMaxPendingMs: 3_600_000,
      }),
    ).toBe("execution_failures");

    // Cycle N+1: quiet (0 failures). The end-of-cycle decay zeroes the
    // counter BEFORE the arm block evaluates, so the stale breach cannot
    // re-arm the pause in the same pass the resolver cleared it.
    counter = decayExecutionFailureCounter(counter, 0);
    expect(counter).toBe(0);
    expect(
      shouldTriggerSafetyPause({
        dailyDrawdownPct: 0,
        maxDailyDrawdownPct: 5,
        consecutiveCoreDataFailures: 0,
        consecutiveExecutionFailures: counter,
        maxConsecutiveExecutionFailures: 3,
        oldestSettlementAgeMs: 0,
        settlementMaxPendingMs: 3_600_000,
      }),
    ).toBeNull();

    // Cycle N+2: the resolver sees the decayed counter and clears the latch.
    expect(
      shouldAutoResolveExecutionFailuresPause({
        mode: "live",
        consecutiveExecutionFailures: counter,
        maxConsecutiveExecutionFailures: 3,
      }),
    ).toBe(true);
  });

  it("a breaching cycle keeps its counter so the pause stays armed", () => {
    expect(decayExecutionFailureCounter(4, 1)).toBe(4);
    expect(decayExecutionFailureCounter(4, 3)).toBe(4);
  });

  it("excludes confirmed and terminal jobs from the overdue settlement age (issue #167)", () => {
    // Given a dead-end terminal job (failed rollback) and a confirmed job,
    // both older than any pending limit.
    const terminal = settlementJob({ status: "terminal", createdAt: 1 });
    const confirmed = settlementJob({ id: "settlement-2", status: "confirmed", createdAt: 1 });

    // Then no active job remains — the pause must not re-arm on their age.
    expect(oldestActiveSettlementAgeMs([terminal, confirmed], 100_000)).toBe(0);
    expect(
      oldestActiveSettlementAgeMs([settlementJob({ status: "prepared", createdAt: 1 })], 100_000),
    ).toBe(99_999);
    expect(
      oldestActiveSettlementAgeMs(
        [settlementJob({ status: "submitted", createdAt: 50_000 })],
        100_000,
      ),
    ).toBe(50_000);

    // Active jobs still count, oldest first, regardless of the terminal rows.
    const pending = settlementJob({ id: "settlement-3", status: "pending", createdAt: 1 });
    const retryable = settlementJob({ id: "settlement-4", status: "retryable", createdAt: 50_000 });
    expect(oldestActiveSettlementAgeMs([terminal, confirmed, pending, retryable], 100_000)).toBe(
      99_999,
    );
  });

  it("caps deterministic settlement retry backoff", () => {
    // Given / When / Then
    expect(nextSettlementRetryAt(1_000, 1)).toBe(2_000);
    expect(nextSettlementRetryAt(1_000, 20)).toBe(301_000);
  });

  it("subtracts settlement and execution costs from realized PnL", () => {
    // Given / When
    const pnl = computeNetRealizedPnlUsd({
      finalValueUsd: 1_100,
      cumulativeFeesClaimedUsd: 25,
      cumulativeRewardsClaimedUsd: 10,
      costBasisUsd: 1_000,
      settlementCostUsd: 7,
      executionCostUsd: 3,
    });

    // Then
    expect(pnl).toBe(125);
  });
});

describe("settlement job processing", () => {
  it.each(["off", "shadow"] as const)("does not process jobs in %s mode", async (mode) => {
    // Given
    const job = settlementJob();
    const savedJobs: SettlementJobRecord[] = [];

    // When
    const [processed] = await runSettlementProcessor([job], {} as AdapterApi, savedJobs, mode);

    // Then
    expect(processed).toEqual(job);
    expect(savedJobs).toEqual([]);
  });

  it("terminalizes an expired job instead of retrying it", async () => {
    // Given
    const job = settlementJob({ expiresAt: 9_999 });
    const savedJobs: SettlementJobRecord[] = [];
    const adapter = {
      getTokenPrices: () => Effect.fail(new Error("expired settlement")),
    } as unknown as AdapterApi;

    // When
    const [processed] = await runSettlementProcessor([job], adapter, savedJobs);

    // Then
    expect(processed).toMatchObject({ status: "terminal", nextRetryAt: null });
    expect(savedJobs).toEqual([processed]);
  });

  it("marks a due job retryable when generic swap operations are unavailable", async () => {
    // Given
    const job = settlementJob();
    const savedJobs: SettlementJobRecord[] = [];
    const adapter = {
      getTokenPrices: () => Effect.succeed({ [SOL_MINT]: 1, [job.tokenMint]: 1 }),
      getTokenDecimals: () => Effect.succeed(6),
    } as unknown as AdapterApi;

    // When
    const [processed] = await runSettlementProcessor([job], adapter, savedJobs);

    // Then
    expect(processed).toMatchObject({ status: "retryable", attempts: 1 });
    expect(processed?.error).toContain("Generic settlement swap operations unavailable");
  });

  it("schedules a retry while a broadcast transaction is still processing", async () => {
    // Given
    const job = settlementJob({ status: "submitted", txSignature: "signature-1", attempts: 2 });
    const savedJobs: SettlementJobRecord[] = [];
    const adapter = {
      getSwapStatus: () => Effect.succeed({ state: "processed", error: null }),
    } as unknown as AdapterApi;

    // When
    const [processed] = await runSettlementProcessor([job], adapter, savedJobs);

    // Then
    expect(processed).toMatchObject({
      status: "submitted",
      txSignature: "signature-1",
      nextRetryAt: 14_000,
    });
    expect(savedJobs).toEqual([processed]);
  });

  it("retains the submitted signature instead of resubmitting when getSwapStatus transiently reports not_found", async () => {
    // Given: a broadcast settlement whose signature is not yet visible to the
    // RPC (e.g. recovered after a confirmation/RPC failure). Resubmitting the
    // full amount would sell the same tokens twice if the first tx later lands.
    const job = settlementJob({ status: "submitted", txSignature: "signature-1", attempts: 1 });
    const savedJobs: SettlementJobRecord[] = [];
    let quoteCalls = 0;
    const adapter = {
      getSwapStatus: () => Effect.succeed({ state: "not_found", error: null }),
      getTokenPrices: () => Effect.succeed({ [SOL_MINT]: 1, [job.tokenMint]: 1 }),
      getTokenDecimals: () => Effect.succeed(6),
      quoteSwap: () =>
        Effect.sync(() => {
          quoteCalls++;
          return swapQuote(job);
        }),
      prepareSwap: () => Effect.fail(new Error("must not be called")),
      simulateSwap: () => Effect.fail(new Error("must not be called")),
      submitSwap: () => Effect.fail(new Error("must not be called")),
    } as unknown as AdapterApi;

    // When
    const [processed] = await runSettlementProcessor([job], adapter, savedJobs);

    // Then: no re-quote/re-submit — the submitted state + signature are
    // retained and the status is re-queried at the next retry.
    expect(quoteCalls).toBe(0);
    expect(processed).toMatchObject({
      status: "submitted",
      txSignature: "signature-1",
      nextRetryAt: 12_000,
    });
    expect(savedJobs).toEqual([processed]);
  });

  it("terminalizes a not-found signature once the max-pending window is past", async () => {
    // Given: the same transient not_found condition, but past the job's
    // expiresAt — the transaction can no longer land, so the job stops
    // retrying instead of rearming submission.
    const job = settlementJob({
      status: "submitted",
      txSignature: "signature-1",
      attempts: 1,
      expiresAt: 9_999,
    });
    const savedJobs: SettlementJobRecord[] = [];
    let quoteCalls = 0;
    const adapter = {
      getSwapStatus: () => Effect.succeed({ state: "not_found", error: null }),
      quoteSwap: () =>
        Effect.sync(() => {
          quoteCalls++;
          return swapQuote(job);
        }),
    } as unknown as AdapterApi;

    // When
    const [processed] = await runSettlementProcessor([job], adapter, savedJobs);

    // Then
    expect(quoteCalls).toBe(0);
    expect(processed).toMatchObject({
      status: "terminal",
      nextRetryAt: null,
      error: "Swap signature not found until expiry — requires operator reconciliation",
    });
    expect(savedJobs).toEqual([processed]);
  });

  it("keeps the broadcast signature when the post-submit output delta is unavailable", async () => {
    // Given
    const job = settlementJob();
    const quote = swapQuote(job);
    const prepared: PreparedSwap = {
      quote,
      transactionBase64: "prepared",
      transactionFormat: "versioned",
      preparedAt: 1,
    };
    const simulation: SwapSimulation = { successful: true, logs: [], unitsConsumed: null };
    const savedJobs: SettlementJobRecord[] = [];
    const adapter = {
      getTokenPrices: () => Effect.succeed({ [SOL_MINT]: 1, [job.tokenMint]: 1 }),
      getTokenDecimals: () => Effect.succeed(6),
      quoteSwap: () => Effect.succeed(quote),
      prepareSwap: () => Effect.succeed(prepared),
      simulateSwap: () => Effect.succeed(simulation),
      getNativeSolBalance: () => Effect.succeed(100n),
      submitSwap: (
        _prepared: PreparedSwap,
        onBroadcast: ((signature: string) => Effect.Effect<void, Error>) | undefined,
      ) =>
        Effect.gen(function* () {
          if (onBroadcast) yield* onBroadcast("broadcast-signature");
          return "broadcast-signature";
        }),
    } as unknown as AdapterApi;

    // When
    const [processed] = await runSettlementProcessor([job], adapter, savedJobs);

    // Then
    expect(processed).toMatchObject({
      status: "prepared",
      txSignature: "broadcast-signature",
      confirmedOutputAtomic: "0",
      nextRetryAt: null,
    });
    expect(savedJobs.at(-1)).toEqual(processed);
  });

  it("preserves decimal precision when converting large atomic amounts to USD", async () => {
    // Given
    const job = settlementJob({ tokenMint: SOL_MINT });
    const savedJobs: SettlementJobRecord[] = [];
    const adapter = {
      getTokenPrices: () => Effect.succeed({ [SOL_MINT]: 1 }),
    } as unknown as AdapterApi;

    // When
    const [processed] = await runSettlementProcessor([job], adapter, savedJobs);

    // Then
    expect(processed?.outputUsd).toBe(9007199.254740993);
  });

  it("records the finalized PnL and signal outcome after all settlement jobs confirm", async () => {
    // Given
    const job = settlementJob({
      status: "confirmed",
      outputUsd: 100,
      executionCostUsd: 2,
      confirmedOutputAtomic: "1",
    });
    const position = {
      cumulativeFeesClaimedUsd: 10,
      cumulativeRewardsClaimedUsd: 0,
      depositedUsd: 100,
      entrySignalSnapshotId: 42,
    };
    let closedPnl: number | null = null;
    let outcome: { snapshotId: number; pnl: number } | null = null;
    const db = {
      saveSettlementJob: () => Effect.void,
      getPosition: () => Effect.succeed(position),
      finalizeSettlementGroup: (input: {
        readonly realizedPnlUsd: number | null;
        readonly signalSnapshotId: number | null;
      }) =>
        Effect.sync(() => {
          closedPnl = input.realizedPnlUsd;
          if (input.signalSnapshotId !== null && input.realizedPnlUsd !== null) {
            outcome = { snapshotId: input.signalSnapshotId, pnl: input.realizedPnlUsd };
          }
        }),
    } as unknown as DbApi;

    // When
    await Effect.runPromise(
      processSettlementJobs({
        adapter: {} as AdapterApi,
        db,
        jobs: [job],
        mode: "live",
        now: 10_000,
        maxSwapSlippageBps: 50,
      }),
    );

    // Then
    expect(closedPnl).toBe(10);
    expect(outcome).toEqual({ snapshotId: 42, pnl: 10 });
  });

  it("reconciles confirmed swap output from transaction evidence when fields are missing", async () => {
    // Given
    const job = settlementJob({
      status: "confirmed",
      txSignature: "confirmed-sig",
      confirmedOutputAtomic: null,
      outputUsd: null,
      executionCostUsd: null,
    });
    const savedJobs: SettlementJobRecord[] = [];
    const adapter = {
      getSwapStatus: () => Effect.succeed({ state: "confirmed", error: null }),
      getConfirmedSwapOutput: () =>
        Effect.succeed({ outputAtomic: 1_000_000_000n, feeAtomic: 5_000_000n }),
      getTokenPrices: () => Effect.succeed({ [SOL_MINT]: 100 }),
    } as unknown as AdapterApi;

    // When
    const [processed] = await runSettlementProcessor([job], adapter, savedJobs);

    // Then
    expect(processed).toMatchObject({
      status: "confirmed",
      confirmedOutputAtomic: "1000000000",
      outputUsd: 100,
      executionCostUsd: 0.5,
    });
  });

  it("preserves existing confirmed output fields when getSwapStatus reports confirmed", async () => {
    // Given
    const job = settlementJob({
      status: "confirmed",
      txSignature: "confirmed-sig",
      confirmedOutputAtomic: "500000000",
      outputUsd: 50,
      executionCostUsd: 0.25,
    });
    const savedJobs: SettlementJobRecord[] = [];
    const adapter = {
      getSwapStatus: () => Effect.succeed({ state: "confirmed", error: null }),
    } as unknown as AdapterApi;

    // When
    const [processed] = await runSettlementProcessor([job], adapter, savedJobs);

    // Then
    expect(processed).toMatchObject({
      status: "confirmed",
      confirmedOutputAtomic: "500000000",
      outputUsd: 50,
      executionCostUsd: 0.25,
    });
  });

  it("marks a confirmed job for reconciliation when swap output evidence is unavailable", async () => {
    // Given
    const job = settlementJob({
      status: "confirmed",
      txSignature: "confirmed-sig",
      confirmedOutputAtomic: null,
      outputUsd: null,
      executionCostUsd: null,
    });
    const savedJobs: SettlementJobRecord[] = [];
    const adapter = {
      getSwapStatus: () => Effect.succeed({ state: "confirmed", error: null }),
      getConfirmedSwapOutput: () => Effect.succeed(null),
    } as unknown as AdapterApi;

    // When
    const [processed] = await runSettlementProcessor([job], adapter, savedJobs);

    // Then
    expect(processed).toMatchObject({
      status: "prepared",
      error: "Confirmed swap output evidence unavailable",
    });
  });

  it("distinguishes confirmed swap evidence from an unavailable SOL price", async () => {
    // Given
    const job = settlementJob({
      status: "confirmed",
      txSignature: "confirmed-sig",
      confirmedOutputAtomic: null,
      outputUsd: null,
      executionCostUsd: null,
    });
    const savedJobs: SettlementJobRecord[] = [];
    const adapter = {
      getSwapStatus: () => Effect.succeed({ state: "confirmed", error: null }),
      getConfirmedSwapOutput: () =>
        Effect.succeed({ outputAtomic: 1_000_000_000n, feeAtomic: 5_000_000n }),
      getTokenPrices: () => Effect.succeed({}),
    } as unknown as AdapterApi;

    // When
    const [processed] = await runSettlementProcessor([job], adapter, savedJobs);

    // Then
    expect(processed).toMatchObject({
      status: "prepared",
      error: "Confirmed swap output found but SOL price unavailable for USD conversion",
    });
  });

  it("skips finalization for already-finalized settlement groups", async () => {
    // Given
    const job = settlementJob({
      status: "confirmed",
      outputUsd: 100,
      executionCostUsd: 2,
      confirmedOutputAtomic: "1",
      finalizedAt: 5_000,
    });
    const savedJobs: SettlementJobRecord[] = [];
    let finalizedCount = 0;

    // When
    await runSettlementProcessor([job], {} as AdapterApi, savedJobs);

    // Then
    expect(finalizedCount).toBe(0);
  });

  it("finalizes confirmed-but-unfinalized jobs while skipping already-finalized ones", async () => {
    // Given
    const unfinalizedJob = settlementJob({
      id: "unfinalized",
      status: "confirmed",
      outputUsd: 100,
      executionCostUsd: 2,
      confirmedOutputAtomic: "1",
      finalizedAt: null,
    });
    const finalizedJob = settlementJob({
      id: "finalized",
      status: "confirmed",
      outputUsd: 50,
      executionCostUsd: 1,
      confirmedOutputAtomic: "1",
      finalizedAt: 5_000,
    });
    const finalizedGroups: Array<{
      readonly positionId: string;
      readonly jobIds: ReadonlyArray<string>;
    }> = [];
    const position = {
      cumulativeFeesClaimedUsd: 0,
      cumulativeRewardsClaimedUsd: 0,
      depositedUsd: 100,
      entrySignalSnapshotId: null,
    };
    const db = {
      saveSettlementJob: () => Effect.void,
      getPosition: () => Effect.succeed(position),
      finalizeSettlementGroup: (input: {
        readonly positionId: string;
        readonly jobIds: ReadonlyArray<string>;
      }) =>
        Effect.sync(() => {
          finalizedGroups.push(input);
        }),
    } as unknown as DbApi;

    // When
    await Effect.runPromise(
      processSettlementJobs({
        adapter: {} as AdapterApi,
        db,
        jobs: [unfinalizedJob, finalizedJob],
        mode: "live",
        now: 10_000,
        maxSwapSlippageBps: 50,
      }),
    );

    // Then
    expect(finalizedGroups).toEqual([
      {
        positionId: "position-1",
        jobIds: ["unfinalized", "finalized"],
        realizedPnlUsd: 50,
        finalizedAt: 10_000,
        signalSnapshotId: null,
      },
    ]);
  });

  it("does not finalize a settlement result that was not durably saved", async () => {
    // Given
    const job = settlementJob({
      status: "submitted",
      txSignature: "submitted-sig",
    });
    let finalizedCount = 0;
    const db = {
      saveSettlementJob: () => Effect.fail(new Error("database unavailable")),
      getPosition: () =>
        Effect.succeed({
          cumulativeFeesClaimedUsd: 0,
          cumulativeRewardsClaimedUsd: 0,
          depositedUsd: 100,
          entrySignalSnapshotId: null,
        }),
      finalizeSettlementGroup: () =>
        Effect.sync(() => {
          finalizedCount++;
        }),
    } as unknown as DbApi;
    const adapter = {
      getSwapStatus: () => Effect.succeed({ state: "confirmed", error: null }),
      getConfirmedSwapOutput: () => Effect.succeed(null),
    } as unknown as AdapterApi;

    // When
    const processed = await Effect.runPromise(
      processSettlementJobs({
        adapter,
        db,
        jobs: [job],
        mode: "live",
        now: 10_000,
        maxSwapSlippageBps: 50,
      }),
    );

    // Then
    expect(processed).toEqual([]);
    expect(finalizedCount).toBe(0);
  });

  it("loads and persists the daily equity baseline through metadata", async () => {
    // Given
    const scope = { walletAddress: "wallet-1", agentInstanceId: "primary" };
    const metadata = new Map([
      ["dailyBaseline:wallet-1:primary:day", "2026-08-01"],
      ["dailyBaseline:wallet-1:primary:equityUsd", "50000"],
    ]);
    const db = {
      getMetadata: (key: string) => Effect.succeed(metadata.get(key) ?? null),
      setMetadataBatch: (entries: ReadonlyArray<{ key: string; value: string }>) =>
        Effect.sync(() => {
          for (const entry of entries) metadata.set(entry.key, entry.value);
        }),
    };

    // When
    const loaded = await Effect.runPromise(loadDailyEquityBaseline(db, scope));
    await Effect.runPromise(
      persistDailyEquityBaseline(db, scope, { day: "2026-08-02", equityUsd: 49_500 }),
    );

    // Then
    expect(loaded).toEqual({ day: "2026-08-01", equityUsd: 50_000 });
    expect(metadata.get("dailyBaseline:wallet-1:primary:day")).toBe("2026-08-02");
    expect(metadata.get("dailyBaseline:wallet-1:primary:equityUsd")).toBe("49500");
  });
});

describe("issue #166 settlement recovery", () => {
  it("classifies rate-limit and network failures as transient", () => {
    // Given / When / Then
    expect(isTransientSettlementError(new Error("Jupiter quote failed: 429"))).toBe(true);
    expect(isTransientSettlementError(new Error("Jupiter swap build failed: 502"))).toBe(true);
    expect(isTransientSettlementError(new Error("Jupiter quote failed: 500"))).toBe(true);
    expect(isTransientSettlementError(new Error("Jupiter quote failed: 408"))).toBe(true);
    expect(isTransientSettlementError(new Error("fetch failed"))).toBe(true);
    expect(isTransientSettlementError(new Error("request timed out after 10000ms"))).toBe(true);
    expect(isTransientSettlementError(new Error("connection reset by peer"))).toBe(true);
    expect(isTransientSettlementError(new Error("ECONNRESET"))).toBe(true);
    expect(isTransientSettlementError(new Error("INSUFFICIENT_FUNDS"))).toBe(false);
    expect(isTransientSettlementError(new Error("invalid slippage param"))).toBe(false);
    // A bare 3-digit number is NOT an HTTP status — deterministic failures
    // must not be classified transient (endless retry).
    expect(isTransientSettlementError(new Error("need 500 lamports"))).toBe(false);
    expect(isTransientSettlementError(new Error("amount 429 below minimum"))).toBe(false);
    // Real HTTP-status formats without the `failed:` prefix stay transient.
    expect(isTransientSettlementError(new Error("HTTP/1.1 500 Internal Server Error"))).toBe(true);
    expect(isTransientSettlementError(new Error("request failed with status code 429"))).toBe(true);
    expect(isTransientSettlementError(new Error("HTTP Error: Too Many Requests"))).toBe(true);
    expect(isTransientSettlementError(null)).toBe(false);
  });

  it("never terminalizes a rate-limited settlement past expiry — it stays retryable", async () => {
    // Given a pending job whose max-pending window already passed, and a
    // Jupiter rate limit on every quote.
    const job = settlementJob({ expiresAt: 9_000 });
    const savedJobs: SettlementJobRecord[] = [];
    const adapter = {
      getTokenPrices: () => Effect.succeed({ [SOL_MINT]: 100, "token-1": 1 }),
      getTokenDecimals: () => Effect.succeed(6),
      quoteSwap: () => Effect.fail(new Error("Jupiter quote failed: 429")),
      prepareSwap: () => Effect.fail(new Error("unused")),
      simulateSwap: () => Effect.fail(new Error("unused")),
      submitSwap: () => Effect.fail(new Error("unused")),
    } as unknown as AdapterApi;

    // When
    const [processed] = await runSettlementProcessor([job], adapter, savedJobs, "live");

    // Then the job resumes with backoff instead of going terminal — a 429
    // clears, so the token still gets sold on a later attempt.
    expect(processed).toMatchObject({
      status: "retryable",
      attempts: 1,
      nextRetryAt: 11_000,
      error: "Jupiter quote failed: 429",
    });
  });

  it("terminalizes a non-transient settlement failure once the max-pending window passes", async () => {
    // Given
    const job = settlementJob({ expiresAt: 9_000 });
    const savedJobs: SettlementJobRecord[] = [];
    const adapter = {
      getTokenPrices: () => Effect.succeed({ [SOL_MINT]: 100, "token-1": 1 }),
      getTokenDecimals: () => Effect.succeed(6),
      quoteSwap: () => Effect.fail(new Error("insufficient funds for swap")),
      prepareSwap: () => Effect.fail(new Error("unused")),
      simulateSwap: () => Effect.fail(new Error("unused")),
      submitSwap: () => Effect.fail(new Error("unused")),
    } as unknown as AdapterApi;

    // When
    const [processed] = await runSettlementProcessor([job], adapter, savedJobs, "live");

    // Then
    expect(processed).toMatchObject({
      status: "terminal",
      attempts: 1,
      nextRetryAt: null,
      error: "insufficient funds for swap",
    });
  });

  it("keeps retrying a non-transient failure before expiry", async () => {
    // Given
    const job = settlementJob({ expiresAt: 100_000 });
    const savedJobs: SettlementJobRecord[] = [];
    const adapter = {
      getTokenPrices: () => Effect.succeed({ [SOL_MINT]: 100, "token-1": 1 }),
      getTokenDecimals: () => Effect.succeed(6),
      quoteSwap: () => Effect.fail(new Error("insufficient funds for swap")),
      prepareSwap: () => Effect.fail(new Error("unused")),
      simulateSwap: () => Effect.fail(new Error("unused")),
      submitSwap: () => Effect.fail(new Error("unused")),
    } as unknown as AdapterApi;

    // When
    const [processed] = await runSettlementProcessor([job], adapter, savedJobs, "live");

    // Then
    expect(processed).toMatchObject({ status: "retryable", nextRetryAt: 11_000 });
  });

  it("dust-confirms an unpriceable settlement instead of quoting it (issue #183)", async () => {
    // Given a job for a mint with no resolvable USD price — quoting it would
    // 400 forever (no route), so the dust gate must terminalize it as dust.
    // Only SYNTHETIC settlement groups (orphan/rollback) qualify: they have
    // no position row to finalize, so no PnL can be booked against the
    // still-in-wallet tokens.
    const job = settlementJob({ tokenMint: "no-price-1", positionId: "orphan:test" });
    const adapter = {
      getTokenPrices: () => Effect.succeed({ [SOL_MINT]: 100, "no-price-1": 0 }),
      getTokenDecimals: () => Effect.succeed(6),
      quoteSwap: () => Effect.fail(new Error("unused — quote must never run")),
      prepareSwap: () => Effect.fail(new Error("unused")),
      simulateSwap: () => Effect.fail(new Error("unused")),
      submitSwap: () => Effect.fail(new Error("unused")),
    } as unknown as AdapterApi;
    const db = {
      saveSettlementJob: () => Effect.void,
      getPosition: () => Effect.succeed(null),
    } as unknown as DbApi;

    // When
    const [processed] = await Effect.runPromise(
      processSettlementJobs({
        adapter,
        db,
        jobs: [job],
        mode: "live",
        now: 10_000,
        maxSwapSlippageBps: 50,
        settlementDustUsd: 0.1,
      }),
    );

    // Then the job is dust-confirmed (value unknown ⇒ $0) and the quote
    // path is never touched.
    expect(processed).toMatchObject({
      status: "confirmed",
      attempts: 1,
      nextRetryAt: null,
      confirmedOutputAtomic: job.amountAtomic,
      error: "settlement dust skipped (no USD price)",
    });
    expect(processed?.outputUsd).toBe(0);
  });

  it("does NOT dust-confirm an unpriceable settlement tied to a real position (issue #183)", async () => {
    // Given an unpriceable job whose positionId is a REAL position (EXIT
    // residue/reward sweep) — dust-confirming it would finalize the group
    // with outputUsd 0 and book a full PnL loss while the tokens still sit
    // in the wallet. It must fall through to the quote path instead
    // (bounded retries, then terminal on expiry — operator-visible).
    const job = settlementJob({ tokenMint: "no-price-1" }); // default real positionId
    const adapter = {
      getTokenPrices: () => Effect.succeed({ [SOL_MINT]: 100, "no-price-1": 0 }),
      getTokenDecimals: () => Effect.succeed(6),
      quoteSwap: () => Effect.fail(new Error("Jupiter quote failed: 400")),
      prepareSwap: () => Effect.fail(new Error("unused")),
      simulateSwap: () => Effect.fail(new Error("unused")),
      submitSwap: () => Effect.fail(new Error("unused")),
    } as unknown as AdapterApi;
    const db = {
      saveSettlementJob: () => Effect.void,
      getPosition: () => Effect.succeed(null),
    } as unknown as DbApi;

    // When
    const [processed] = await Effect.runPromise(
      processSettlementJobs({
        adapter,
        db,
        jobs: [job],
        mode: "live",
        now: 10_000,
        maxSwapSlippageBps: 50,
        settlementDustUsd: 0.1,
      }),
    );

    // Then the quote path ran (400 → retryable with backoff), no dust-confirm.
    expect(processed).toMatchObject({
      status: "retryable",
      error: "Jupiter quote failed: 400",
      nextRetryAt: 11_000,
    });
  });

  it("dust-confirms a priceable sub-dust settlement with the plain dust error", async () => {
    // Given a tiny priceable amount below the dust cutoff.
    const job = settlementJob({ amountAtomic: "1000" }); // 0.001 token at $1
    const adapter = {
      getTokenPrices: () => Effect.succeed({ [SOL_MINT]: 100, "token-1": 1 }),
      getTokenDecimals: () => Effect.succeed(6),
      quoteSwap: () => Effect.fail(new Error("unused — quote must never run")),
      prepareSwap: () => Effect.fail(new Error("unused")),
      simulateSwap: () => Effect.fail(new Error("unused")),
      submitSwap: () => Effect.fail(new Error("unused")),
    } as unknown as AdapterApi;
    const db = {
      saveSettlementJob: () => Effect.void,
      getPosition: () => Effect.succeed(null),
    } as unknown as DbApi;

    // When
    const [processed] = await Effect.runPromise(
      processSettlementJobs({
        adapter,
        db,
        jobs: [job],
        mode: "live",
        now: 10_000,
        maxSwapSlippageBps: 50,
        settlementDustUsd: 0.1,
      }),
    );

    // Then
    expect(processed).toMatchObject({
      status: "confirmed",
      nextRetryAt: null,
      error: "settlement dust skipped",
    });
    expect(processed?.outputUsd).toBe(0.001);
  });

  it("does not revive an unpriceable terminal settlement (issue #191)", async () => {
    // Given a wallet holding an unpriceable token with a signature-less
    // TERMINAL job — the pre-#191 shape: the sweep used to revive it (the
    // dust gate required a known price), the Jupiter 400/429 retry loop
    // restarted, and the retryable job latched settlement_overdue forever
    // (oldestActiveSettlementAgeMs counts non-terminal jobs; #168's
    // auto-resolve only fires once everything is confirmed/terminal).
    const holdings = new Map<string, { amountAtomic: bigint; decimals: number }>([
      ["unpriceable-1", { amountAtomic: 1_000_000n, decimals: 6 }],
    ]);
    const terminalJob = settlementJob({
      id: "terminal-1",
      positionId: "orphan:old",
      tokenMint: "unpriceable-1",
      amountAtomic: "1000000",
      status: "terminal",
      attempts: 27,
      nextRetryAt: null,
      txSignature: null,
      confirmedOutputAtomic: null,
      expiresAt: 1_000,
      error: "Jupiter quote failed: 400",
      createdAt: 1,
      updatedAt: 1,
    });
    const adapter = {
      hasWallet: () => true,
      getWalletHoldings: () => Effect.succeed(holdings),
      getPoolState: () => Effect.succeed(null),
      getTokenPrices: () => Effect.succeed({ "unpriceable-1": 0 }),
    } as unknown as AdapterApi;
    const db = {
      listSettlementJobs: () => Effect.succeed([terminalJob]),
      getAllPositions: () => Effect.succeed([]),
    } as unknown as DbApi;

    // When
    const jobs = await Effect.runPromise(
      sweepOrphanSettlements({
        adapter,
        db,
        walletAddress: "wallet-1",
        agentInstanceId: "primary",
        settlementMaxPendingMs: 3_600_000,
        settlementDustUsd: 0.1,
        now: 10_000,
      }),
    );

    // Then the terminal row is NOT revived and no fresh sell job is created —
    // the unpriceable holding is dust (value unknown ⇒ $0), so no retry loop
    // can restart and nothing can latch settlement_overdue.
    expect(jobs).toHaveLength(0);
  });

  it("unpriceable retryable jobs dust-confirm and cannot latch settlement_overdue (issue #191)", async () => {
    // Given a retryable job for an unpriceable mint (the post-revival shape)
    // that has been failing for 27h: without the dust path it would retry
    // forever and — being non-terminal — keep settlement_overdue latched.
    // The quote mock fails with a TRANSIENT 429 and expiresAt is far in the
    // future on purpose: if the dust path regresses, the job stays retryable
    // (per issue #175 a rate-limited settlement never terminalizes, even past
    // expiry) and is older than settlementMaxPendingMs — so the latch
    // assertions below would FAIL on the regression instead of passing
    // vacuously via a terminalized job.
    const job = settlementJob({
      positionId: "rollback:entry-1",
      tokenMint: "no-price-1",
      status: "retryable",
      attempts: 27,
      nextRetryAt: 9_000,
      expiresAt: 20_000_000,
      createdAt: 1,
      error: "Jupiter quote failed: 429",
    });
    const adapter = {
      getTokenPrices: () => Effect.succeed({ [SOL_MINT]: 100, "no-price-1": 0 }),
      getTokenDecimals: () => Effect.succeed(6),
      quoteSwap: () => Effect.fail(new Error("Jupiter quote failed: 429")),
      prepareSwap: () => Effect.fail(new Error("unused")),
      simulateSwap: () => Effect.fail(new Error("unused")),
      submitSwap: () => Effect.fail(new Error("unused")),
    } as unknown as AdapterApi;
    const db = {
      saveSettlementJob: () => Effect.void,
      getPosition: () => Effect.succeed(null),
    } as unknown as DbApi;

    // When
    const [processed] = await Effect.runPromise(
      processSettlementJobs({
        adapter,
        db,
        jobs: [job],
        mode: "live",
        now: 10_000,
        maxSwapSlippageBps: 50,
        settlementDustUsd: 0.1,
      }),
    );

    // Then the job is dust-confirmed — no more retries...
    expect(processed).toMatchObject({
      status: "confirmed",
      nextRetryAt: null,
      error: "settlement dust skipped (no USD price)",
    });
    // ...and, mirroring issue #167, a confirmed job contributes nothing to the
    // overdue age, so settlement_overdue can neither arm nor stay latched on
    // it (and #168's all-confirmed/terminal auto-resolve can fire). The age is
    // measured at 10_000_000 — past settlementMaxPendingMs — so a hypothetical
    // still-retryable job (age ~9,999,999 ms) WOULD trip the pause while the
    // dust-confirmed job still yields 0 (the assertion is discriminating).
    const settledJobs = processed ? [processed] : [];
    const latchNow = 10_000_000;
    expect(oldestActiveSettlementAgeMs(settledJobs, latchNow)).toBe(0);
    expect(
      shouldTriggerSafetyPause({
        dailyDrawdownPct: 0,
        maxDailyDrawdownPct: 5,
        consecutiveCoreDataFailures: 0,
        consecutiveExecutionFailures: 0,
        maxConsecutiveExecutionFailures: 3,
        oldestSettlementAgeMs: oldestActiveSettlementAgeMs(settledJobs, latchNow),
        settlementMaxPendingMs: 3_600_000,
      }),
    ).toBeNull();
  });

  it("creates sell jobs only for unbacked, non-dust wallet holdings", async () => {
    // Given holdings where one mint is backed, one is below dust, one is
    // unpriceable (issue #183: treated as dust — value unknown ⇒ $0), and
    // the settlement asset itself.
    const holdings = new Map<string, { amountAtomic: bigint; decimals: number }>([
      ["stranded-1", { amountAtomic: 1_000_000n, decimals: 6 }], // $1.00 → sweep
      ["dust-1", { amountAtomic: 50_000n, decimals: 6 }], // $0.05 → skip
      ["unpriceable-1", { amountAtomic: 5_000_000n, decimals: 6 }], // no price → skip (dust; re-qualifies when priced)
      ["backed-1", { amountAtomic: 1_000_000n, decimals: 6 }], // position leg → skip
      [SOL_MINT, { amountAtomic: 1_000_000_000n, decimals: 9 }], // settlement asset → skip
      ["zero-1", { amountAtomic: 0n, decimals: 6 }], // nothing held → skip
    ]);
    const adapter = {
      hasWallet: () => true,
      getWalletHoldings: () => Effect.succeed(holdings),
      getPoolState: () => Effect.succeed({ tokenX: "backed-1", tokenY: "backed-y" }),
      getTokenPrices: (mints: string[]) =>
        Effect.succeed(
          Object.fromEntries(mints.map((mint) => [mint, mint === "unpriceable-1" ? 0 : 1])),
        ),
    } as unknown as AdapterApi;
    const db = {
      listSettlementJobs: () => Effect.succeed([]),
      getAllPositions: () => Effect.succeed([{ positionId: "live-pos-1", poolAddress: "pool-1" }]),
    } as unknown as DbApi;

    // When
    const jobs = await Effect.runPromise(
      sweepOrphanSettlements({
        adapter,
        db,
        walletAddress: "wallet-1",
        agentInstanceId: "primary",
        settlementMaxPendingMs: 3_600_000,
        settlementDustUsd: 0.1,
        now: 10_000,
      }),
    );

    // Then
    expect(jobs).toHaveLength(1);
    expect(jobs.map((job) => job.tokenMint).sort()).toEqual(["stranded-1"]);
    expect(jobs[0]).toMatchObject({
      walletAddress: "wallet-1",
      agentInstanceId: "primary",
      poolAddress: "",
      destinationAsset: "SOL",
      status: "pending",
      attempts: 0,
      nextRetryAt: 10_000,
      expiresAt: 3_610_000,
      error: null,
      positionId: expect.stringMatching(/^orphan:/),
    });
  });

  it("dust-skips an unpriceable holding when the dust gate is enabled, sweeps it when disabled", async () => {
    // Given a wallet holding only an unpriceable token.
    const holdings = new Map<string, { amountAtomic: bigint; decimals: number }>([
      ["unpriceable-1", { amountAtomic: 5_000_000n, decimals: 6 }],
    ]);
    const adapter = {
      hasWallet: () => true,
      getWalletHoldings: () => Effect.succeed(holdings),
      getPoolState: () => Effect.succeed(null),
      getTokenPrices: (mints: string[]) =>
        Effect.succeed(Object.fromEntries(mints.map((mint) => [mint, 0]))),
    } as unknown as AdapterApi;
    const db = {
      listSettlementJobs: () => Effect.succeed([]),
      getAllPositions: () => Effect.succeed([]),
    } as unknown as DbApi;

    // When the dust gate is on (default), an unpriceable token is dust: no
    // sell job — otherwise it would be quoted (Jupiter 400) and retried
    // forever (issue #183).
    const withDust = await Effect.runPromise(
      sweepOrphanSettlements({
        adapter,
        db,
        walletAddress: "wallet-1",
        agentInstanceId: "primary",
        settlementMaxPendingMs: 3_600_000,
        settlementDustUsd: 0.1,
        now: 10_000,
      }),
    );
    expect(withDust).toHaveLength(0);

    // When the dust gate is disabled, the sweep still enqueues it (best
    // effort — the operator opted out of dust classification).
    const noDustGate = await Effect.runPromise(
      sweepOrphanSettlements({
        adapter,
        db,
        walletAddress: "wallet-1",
        agentInstanceId: "primary",
        settlementMaxPendingMs: 3_600_000,
        settlementDustUsd: 0,
        now: 10_000,
      }),
    );
    expect(noDustGate.map((job) => job.tokenMint)).toEqual(["unpriceable-1"]);
  });

  it("sweeps wallet holdings against position legs and active jobs, re-enqueuing terminal-mint tokens", async () => {
    // Given a wallet holding three tokens: one backed by an open position's
    // pool, one already covered by an active settlement job, and one whose
    // settlement DIED terminal (the issue #166 stranded-token case).
    const holdings = new Map<string, { amountAtomic: bigint; decimals: number }>([
      ["stranded-1", { amountAtomic: 15_413n, decimals: 6 }],
      ["pool-leg-x", { amountAtomic: 1_000_000n, decimals: 6 }],
      ["active-job-token", { amountAtomic: 1_000_000n, decimals: 6 }],
    ]);
    const adapter = {
      hasWallet: () => true,
      getWalletHoldings: () => Effect.succeed(holdings),
      getPoolState: (poolAddress: string) =>
        Effect.succeed(
          poolAddress === "pool-1" ? { tokenX: "pool-leg-x", tokenY: "pool-leg-y" } : null,
        ),
      getTokenPrices: (mints: string[]) =>
        Effect.succeed(
          Object.fromEntries(mints.map((mint) => [mint, mint === "stranded-1" ? 1000 : 1])),
        ),
    } as unknown as AdapterApi;
    const db = {
      listSettlementJobs: () =>
        Effect.succeed([
          settlementJob({ id: "active", tokenMint: "active-job-token", status: "retryable" }),
          settlementJob({ id: "dead", tokenMint: "stranded-1", status: "terminal" }),
        ]),
      getAllPositions: () => Effect.succeed([{ positionId: "live-pos-1", poolAddress: "pool-1" }]),
    } as unknown as DbApi;

    // When
    const jobs = await Effect.runPromise(
      sweepOrphanSettlements({
        adapter,
        db,
        walletAddress: "wallet-1",
        agentInstanceId: "primary",
        settlementMaxPendingMs: 3_600_000,
        settlementDustUsd: 0.1,
        now: 10_000,
      }),
    );

    // Then only the stranded token gets a job: the terminal row is REVIVED in
    // place (same id, attempts carried forward so backoff escalates across
    // generations and the table stays one row per mint) — terminal jobs still
    // do not count as backing.
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: "dead",
      tokenMint: "stranded-1",
      amountAtomic: "15413",
      status: "pending",
      attempts: 1,
      nextRetryAt: 10_000,
      expiresAt: 3_610_000,
      error: null,
    });
  });

  it("skips the sweep entirely without a wallet or without candidate holdings", async () => {
    // Given
    const walletless = {
      hasWallet: () => false,
    } as unknown as AdapterApi;
    const emptyHoldings = {
      hasWallet: () => true,
      getWalletHoldings: () => Effect.succeed(new Map()),
    } as unknown as AdapterApi;

    // When / Then
    await expect(
      Effect.runPromise(
        sweepOrphanSettlements({
          adapter: walletless,
          db: {} as DbApi,
          walletAddress: "wallet-1",
          agentInstanceId: "primary",
          settlementMaxPendingMs: 3_600_000,
          settlementDustUsd: 0.1,
          now: 10_000,
        }),
      ),
    ).resolves.toEqual([]);
    await expect(
      Effect.runPromise(
        sweepOrphanSettlements({
          adapter: emptyHoldings,
          db: {} as DbApi,
          walletAddress: "wallet-1",
          agentInstanceId: "primary",
          settlementMaxPendingMs: 3_600_000,
          settlementDustUsd: 0.1,
          now: 10_000,
        }),
      ),
    ).resolves.toEqual([]);
  });

  it("does not let paper-position pool legs back live wallet tokens", async () => {
    // Given a live wallet token that is a leg of a PAPER position's pool
    // (paper rows share the positions table) — the sweep must still sell it.
    const holdings = new Map<string, { amountAtomic: bigint; decimals: number }>([
      ["paper-leg-token", { amountAtomic: 1_000_000n, decimals: 6 }],
    ]);
    const adapter = {
      hasWallet: () => true,
      getWalletHoldings: () => Effect.succeed(holdings),
      getPoolState: () => Effect.succeed({ tokenX: "paper-leg-token", tokenY: "paper-leg-y" }),
      getTokenPrices: (mints: string[]) =>
        Effect.succeed(Object.fromEntries(mints.map((mint) => [mint, 1]))),
    } as unknown as AdapterApi;
    const db = {
      listSettlementJobs: () => Effect.succeed([]),
      getAllPositions: () =>
        Effect.succeed([{ positionId: "paper-pool-1-abc", poolAddress: "pool-paper" }]),
    } as unknown as DbApi;

    // When
    const jobs = await Effect.runPromise(
      sweepOrphanSettlements({
        adapter,
        db,
        walletAddress: "wallet-1",
        agentInstanceId: "primary",
        settlementMaxPendingMs: 3_600_000,
        settlementDustUsd: 0.1,
        now: 10_000,
      }),
    );

    // Then the paper-backed mint is still swept.
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.tokenMint).toBe("paper-leg-token");
  });

  it("does not revive terminal rows carrying a txSignature — spawns a fresh job instead", async () => {
    // Given a terminal job terminalized via the not_found path (signature kept
    // — the operator-reconciliation bucket). Reviving it would re-poll a dead
    // signature forever, so the sweep must NOT revive it.
    const holdings = new Map<string, { amountAtomic: bigint; decimals: number }>([
      ["stranded-1", { amountAtomic: 15_413n, decimals: 6 }],
    ]);
    const adapter = {
      hasWallet: () => true,
      getWalletHoldings: () => Effect.succeed(holdings),
      getPoolState: () => Effect.succeed(null),
      getTokenPrices: (mints: string[]) =>
        Effect.succeed(Object.fromEntries(mints.map((mint) => [mint, 1000]))),
    } as unknown as AdapterApi;
    const db = {
      listSettlementJobs: () =>
        Effect.succeed([
          settlementJob({
            id: "signed-terminal",
            tokenMint: "stranded-1",
            status: "terminal",
            txSignature: "dead-sig",
            error: "Swap signature not found until expiry — requires operator reconciliation",
          }),
        ]),
      getAllPositions: () => Effect.succeed([]),
    } as unknown as DbApi;

    // When
    const jobs = await Effect.runPromise(
      sweepOrphanSettlements({
        adapter,
        db,
        walletAddress: "wallet-1",
        agentInstanceId: "primary",
        settlementMaxPendingMs: 3_600_000,
        settlementDustUsd: 0.1,
        now: 10_000,
      }),
    );

    // Then a FRESH signature-less job is created (not a revival of the row).
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: expect.not.stringMatching(/^signed-terminal$/),
      tokenMint: "stranded-1",
      status: "pending",
      attempts: 0,
      txSignature: null,
      positionId: expect.stringMatching(/^orphan:/),
    });
  });

  it("fails open when the holdings read errors", async () => {
    // Given
    const adapter = {
      hasWallet: () => true,
      getWalletHoldings: () => Effect.fail(new Error("rpc down")),
    } as unknown as AdapterApi;

    // When / Then
    await expect(
      Effect.runPromise(
        sweepOrphanSettlements({
          adapter,
          db: {} as DbApi,
          walletAddress: "wallet-1",
          agentInstanceId: "primary",
          settlementMaxPendingMs: 3_600_000,
          settlementDustUsd: 0.1,
          now: 10_000,
        }),
      ),
    ).resolves.toEqual([]);
  });
});
