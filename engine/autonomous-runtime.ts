import { Effect } from "effect";
import { SOL_MINT } from "./constants.js";
import { computeNetRealizedPnlUsd } from "./pnl.js";
import type { AdapterApi, DbApi } from "./services.js";
import type { ActionType, AutonomousTokenMode, SettlementJobRecord } from "./types.js";

/** Returns whether an action remains permitted while the wallet safety pause is active. */
export function isActionAllowedDuringSafetyPause(action: ActionType): boolean {
  return action === "EXIT" || action === "HOLD";
}

export interface SafetyPauseThresholdInput {
  readonly dailyDrawdownPct: number;
  readonly maxDailyDrawdownPct: number;
  readonly consecutiveCoreDataFailures: number;
  readonly consecutiveExecutionFailures: number;
  readonly maxConsecutiveExecutionFailures: number;
  readonly oldestSettlementAgeMs: number;
  readonly settlementMaxPendingMs: number;
}

export type SafetyPauseReason =
  | "daily_drawdown"
  | "core_data_unavailable"
  | "execution_failures"
  | "settlement_overdue";

/** Evaluates configured wallet safety thresholds in priority order. */
export function shouldTriggerSafetyPause(
  input: SafetyPauseThresholdInput,
): SafetyPauseReason | null {
  if (input.maxDailyDrawdownPct > 0 && input.dailyDrawdownPct >= input.maxDailyDrawdownPct) {
    return "daily_drawdown";
  }
  if (input.consecutiveCoreDataFailures >= 2) return "core_data_unavailable";
  if (input.consecutiveExecutionFailures >= input.maxConsecutiveExecutionFailures) {
    return "execution_failures";
  }
  if (input.oldestSettlementAgeMs > input.settlementMaxPendingMs) {
    return "settlement_overdue";
  }
  return null;
}

/** Computes the bounded retry timestamp for a settlement attempt. */
export function nextSettlementRetryAt(now: number, attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 30));
  return now + Math.min(2 ** exponent * 1_000, 300_000);
}

export interface SettlementProcessorInput {
  readonly adapter: AdapterApi;
  readonly db: DbApi;
  readonly jobs: ReadonlyArray<SettlementJobRecord>;
  readonly mode: AutonomousTokenMode;
  readonly now: number;
  readonly maxSwapSlippageBps: number;
  readonly settlementDustUsd?: number;
}

function atomicUsd(amountAtomic: bigint, decimals: number, priceUsd: number): number {
  const scale = 10n ** BigInt(decimals);
  const whole = amountAtomic / scale;
  const remainder = amountAtomic % scale;
  return (Number(whole) + Number(remainder) / Number(scale)) * priceUsd;
}

function retryableJob(job: SettlementJobRecord, now: number, error: unknown): SettlementJobRecord {
  const attempts = job.attempts + 1;
  return {
    ...job,
    status: now >= job.expiresAt ? "terminal" : "retryable",
    attempts,
    nextRetryAt: now >= job.expiresAt ? null : nextSettlementRetryAt(now, attempts),
    error: error instanceof Error ? error.message : String(error),
    updatedAt: now,
  };
}

function reconciliationJob(
  job: SettlementJobRecord,
  now: number,
  error: unknown,
): SettlementJobRecord {
  return {
    ...job,
    status: "prepared",
    attempts: job.attempts + 1,
    nextRetryAt: null,
    error: error instanceof Error ? error.message : String(error),
    updatedAt: now,
  };
}

/** Processes due settlement jobs and finalizes positions whose settlements completed. */
export function processSettlementJobs(
  input: SettlementProcessorInput,
): Effect.Effect<ReadonlyArray<SettlementJobRecord>, never> {
  return Effect.gen(function* () {
    if (input.mode === "off" || input.mode === "shadow") return input.jobs;
    const processed: SettlementJobRecord[] = [];
    for (const job of input.jobs) {
      if (
        job.status === "confirmed" ||
        job.status === "terminal" ||
        (job.nextRetryAt !== null && job.nextRetryAt > input.now)
      ) {
        processed.push(job);
        continue;
      }
      let submitted = false;
      let capturedSignature: string | null = null;
      let capturedConfirmedOutputAtomic: bigint = 0n;
      const result = yield* Effect.gen(function* () {
        if (job.txSignature && input.adapter.getSwapStatus) {
          const status = yield* input.adapter.getSwapStatus(job.txSignature);
          if (status.state === "confirmed" || status.state === "finalized") {
            return {
              ...job,
              status: "confirmed" as const,
              nextRetryAt: null,
              error: null,
              updatedAt: input.now,
            };
          }
          if (status.state !== "failed" && status.state !== "not_found") {
            return {
              ...job,
              status: "submitted" as const,
              nextRetryAt: nextSettlementRetryAt(input.now, job.attempts + 1),
              updatedAt: input.now,
            };
          }
        }
        if (job.status === "prepared" && job.txSignature === null) {
          return yield* Effect.fail(
            new Error("Prepared settlement requires operator reconciliation"),
          );
        }
        const amountAtomic = BigInt(job.amountAtomic);
        const prices = yield* input.adapter.getTokenPrices([job.tokenMint, SOL_MINT]);
        const solPriceUsd = prices[SOL_MINT] ?? 0;
        if (!(solPriceUsd > 0)) return yield* Effect.fail(new Error("SOL price unavailable"));
        if (job.tokenMint === SOL_MINT) {
          return {
            ...job,
            status: "confirmed" as const,
            confirmedOutputAtomic: job.amountAtomic,
            outputUsd: atomicUsd(amountAtomic, 9, solPriceUsd),
            executionCostUsd: 0,
            attempts: job.attempts + 1,
            nextRetryAt: null,
            error: null,
            updatedAt: input.now,
          };
        }
        const inputDecimals = yield* input.adapter.getTokenDecimals(job.tokenMint);
        const inputPriceUsd = prices[job.tokenMint] ?? 0;
        const inputUsd = atomicUsd(amountAtomic, inputDecimals, inputPriceUsd);
        const settlementDustUsd = input.settlementDustUsd ?? 0;
        if (settlementDustUsd > 0 && inputPriceUsd > 0 && inputUsd < settlementDustUsd) {
          return {
            ...job,
            status: "confirmed" as const,
            attempts: job.attempts + 1,
            nextRetryAt: null,
            confirmedOutputAtomic: amountAtomic.toString(),
            outputUsd: inputUsd,
            executionCostUsd: 0,
            error: "settlement dust skipped",
            updatedAt: input.now,
          };
        }
        const quoteSwap = input.adapter.quoteSwap;
        const prepareSwap = input.adapter.prepareSwap;
        const simulateSwap = input.adapter.simulateSwap;
        const submitSwap = input.adapter.submitSwap;
        if (!quoteSwap || !prepareSwap || !simulateSwap || !submitSwap) {
          return yield* Effect.fail(new Error("Generic settlement swap operations unavailable"));
        }
        const quote = yield* quoteSwap({
          inputMint: job.tokenMint,
          outputMint: SOL_MINT,
          amountAtomic,
          slippageBps: input.maxSwapSlippageBps,
        });
        const prepared = yield* prepareSwap(quote);
        yield* simulateSwap(prepared);
        const nativeBefore = yield* input.adapter.getNativeSolBalance();
        yield* input.db.saveSettlementJob({
          ...job,
          status: "prepared",
          attempts: job.attempts + 1,
          confirmedOutputAtomic: null,
          outputUsd: null,
          executionCostUsd: null,
          updatedAt: input.now,
        });
        const signature = yield* submitSwap(prepared, (broadcastSignature) => {
          submitted = true;
          capturedSignature = broadcastSignature;
          return input.db.saveSettlementJob({
            ...job,
            status: "submitted",
            attempts: job.attempts + 1,
            nextRetryAt: nextSettlementRetryAt(input.now, job.attempts + 1),
            txSignature: broadcastSignature,
            updatedAt: input.now,
          });
        });
        submitted = true;
        capturedSignature = signature;
        const nativeAfter = yield* input.adapter.getNativeSolBalance();
        const confirmedOutputAtomic = nativeAfter > nativeBefore ? nativeAfter - nativeBefore : 0n;
        capturedConfirmedOutputAtomic = confirmedOutputAtomic;
        if (confirmedOutputAtomic <= 0n) {
          return yield* Effect.fail(new Error("Settlement output balance delta unavailable"));
        }
        const outputUsd = atomicUsd(confirmedOutputAtomic, 9, solPriceUsd);
        const realizedInputUsd =
          inputPriceUsd > 0 ? atomicUsd(amountAtomic, inputDecimals, inputPriceUsd) : outputUsd;
        const executionCostUsd = Math.max(0, realizedInputUsd - outputUsd);
        return {
          ...job,
          status: "confirmed" as const,
          attempts: job.attempts + 1,
          nextRetryAt: null,
          txSignature: signature,
          confirmedOutputAtomic: confirmedOutputAtomic.toString(),
          outputUsd,
          executionCostUsd,
          error: null,
          updatedAt: input.now,
        };
      }).pipe(
        Effect.catchAll((error) =>
          Effect.succeed(
            submitted
              ? reconciliationJob(
                  {
                    ...job,
                    txSignature: capturedSignature ?? job.txSignature,
                    confirmedOutputAtomic: capturedConfirmedOutputAtomic.toString(),
                  },
                  input.now,
                  error,
                )
              : retryableJob(job, input.now, error),
          ),
        ),
      );
      yield* input.db.saveSettlementJob(result).pipe(Effect.catchAll(() => Effect.void));
      processed.push(result);
    }

    const byPosition = Map.groupBy(processed, (job) => job.positionId);
    for (const [positionId, jobs] of byPosition) {
      if (jobs.length === 0 || jobs.some((job) => job.status !== "confirmed")) continue;
      const position = yield* input.db
        .getPosition(positionId)
        .pipe(Effect.catchAll(() => Effect.succeed(null)));
      if (!position) continue;
      const outputUsd = jobs.reduce((sum, job) => sum + (job.outputUsd ?? 0), 0);
      const executionCostUsd = jobs.reduce((sum, job) => sum + (job.executionCostUsd ?? 0), 0);
      const realizedPnlUsd = computeNetRealizedPnlUsd({
        finalValueUsd: outputUsd + executionCostUsd,
        cumulativeFeesClaimedUsd: position.cumulativeFeesClaimedUsd,
        cumulativeRewardsClaimedUsd: position.cumulativeRewardsClaimedUsd,
        costBasisUsd: position.depositedUsd,
        settlementCostUsd: executionCostUsd,
        executionCostUsd: 0,
      });
      yield* input.db
        .closePosition(positionId, realizedPnlUsd)
        .pipe(Effect.catchAll(() => Effect.void));
      if (position.entrySignalSnapshotId !== null && realizedPnlUsd !== null) {
        yield* input.db
          .recordSignalOutcome(position.entrySignalSnapshotId, realizedPnlUsd)
          .pipe(Effect.catchAll(() => Effect.void));
      }
      for (const job of jobs) {
        const finalized = {
          ...job,
          finalizedAt: input.now,
          realizedPnlUsd,
          updatedAt: input.now,
        };
        yield* input.db.saveSettlementJob(finalized).pipe(Effect.catchAll(() => Effect.void));
      }
    }
    return processed;
  });
}
