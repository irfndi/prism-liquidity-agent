import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  isActionAllowedDuringSafetyPause,
  loadDailyEquityBaseline,
  nextSettlementRetryAt,
  oldestActiveSettlementAgeMs,
  persistDailyEquityBaseline,
  processSettlementJobs,
  safetyPauseBlockReason,
  shouldAutoResolveDailyDrawdownPause,
  shouldTriggerSafetyPause,
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
  const db = {
    saveSettlementJob: (job: SettlementJobRecord) =>
      Effect.sync(() => {
        savedJobs.push(job);
      }),
    getPosition: () => Effect.succeed(null),
  } as unknown as DbApi;
  return Effect.runPromise(
    processSettlementJobs({
      adapter,
      db,
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

  it("excludes confirmed and terminal jobs from the overdue settlement age (issue #167)", () => {
    // Given a dead-end terminal job (failed rollback) and a confirmed job,
    // both older than any pending limit.
    const terminal = settlementJob({ status: "terminal", createdAt: 1 });
    const confirmed = settlementJob({ id: "settlement-2", status: "confirmed", createdAt: 1 });

    // Then no active job remains — the pause must not re-arm on their age.
    expect(oldestActiveSettlementAgeMs([terminal, confirmed], 100_000)).toBe(0);

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
        onBroadcast: ((signature: string) => Effect.Effect<void, unknown>) | undefined,
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
    const db = {
      saveSettlementJob: (j: SettlementJobRecord) =>
        Effect.sync(() => {
          savedJobs.push(j);
          if (j.finalizedAt !== null) finalizedCount++;
        }),
      getPosition: () => Effect.succeed(null),
      finalizeSettlementGroup: () => Effect.void,
    } as unknown as DbApi;

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
