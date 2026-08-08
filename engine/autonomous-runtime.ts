import { randomUUID } from "crypto";
import { Effect } from "effect";
import { SOL_MINT } from "./constants.js";
import { createLogger } from "./logger.js";
import { computeNetRealizedPnlUsd } from "./pnl.js";
import type { AdapterApi, DbApi } from "./services.js";
import type {
  ActionType,
  AutonomousTokenMode,
  SafetyPauseRecord,
  SettlementJobRecord,
} from "./types.js";

const logger = createLogger("autonomous-runtime");

/** Returns whether an action remains permitted while the wallet safety pause is active. */
export function isActionAllowedDuringSafetyPause(action: ActionType): boolean {
  return action === "EXIT" || action === "HOLD";
}

/**
 * Returns the reject reason when an active wallet safety pause should block
 * a decision, or null when the decision proceeds. The pause is informational
 * in `shadow` mode (no-send by design) — it never blocks a decision there.
 * EXIT/HOLD remain permitted while the pause is active.
 */
export function safetyPauseBlockReason(
  autonomousMode: AutonomousTokenMode | undefined,
  activeSafetyPause: SafetyPauseRecord | null,
  action: ActionType,
): string | null {
  if (autonomousMode === "shadow") return null;
  if (activeSafetyPause === null || activeSafetyPause.resolvedAt !== null) return null;
  if (isActionAllowedDuringSafetyPause(action)) return null;
  return `Wallet safety pause active: ${activeSafetyPause.reason}`;
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
  if (
    input.maxConsecutiveExecutionFailures > 0 &&
    input.consecutiveExecutionFailures >= input.maxConsecutiveExecutionFailures
  ) {
    return "execution_failures";
  }
  if (input.oldestSettlementAgeMs > input.settlementMaxPendingMs) {
    return "settlement_overdue";
  }
  return null;
}

export interface DailyDrawdownAutoResolveInput {
  readonly mode: AutonomousTokenMode;
  readonly dailyDrawdownPct: number;
  readonly maxDailyDrawdownPct: number;
  readonly dayRolledOver: boolean;
}

export interface ExecutionFailuresAutoResolveInput {
  readonly mode: AutonomousTokenMode;
  readonly consecutiveExecutionFailures: number;
  readonly maxConsecutiveExecutionFailures: number;
}

/**
 * Issue #182: a cycle with no execution failures is a QUIET cycle — the
 * consecutive-failure counter decays to 0 (true consecutive semantics,
 * mirroring `consecutiveCoreDataFailures`). Without the decay the counter
 * only reset on a successful execution, so after a failure spike the stale
 * breach re-armed the pause in the same pass the resolver cleared it
 * (resolve → re-arm toggle every cycle, latch never stayed cleared).
 * Runs at the end of every cycle (including skipped/empty cycles) BEFORE
 * the arm block evaluates.
 */
export function decayExecutionFailureCounter(
  consecutiveExecutionFailures: number,
  executionFailuresThisCycle: number,
): number {
  return executionFailuresThisCycle === 0 ? 0 : consecutiveExecutionFailures;
}

/**
 * Auto-resolution for a latched `execution_failures` safety pause
 * (issue #182). The trigger is a session-local counter that resets on
 * restart, on every successful execution, and (via
 * decayExecutionFailureCounter) after every quiet cycle — but an armed
 * pause was a permanent one-way latch that only `prism resume` could
 * clear, so a single transient failure spike (rate limits, RPC blips, a
 * pre-fix batch of doomed entries) halted the agent forever, surviving
 * restarts (fresh counter) and fixed releases. Mirrors the issue #148
 * daily_drawdown autonomy contract:
 *
 * - `shadow` — informational only: the pause never blocks and never requires
 *   a manual resume, so always auto-resolve.
 * - `canary` / `live` — re-evaluate fresh every cycle: auto-resolve as soon
 *   as the current failure counter is below the configured threshold (a
 *   fresh process starts at 0, so a restart alone clears the latch; the
 *   quiet-cycle decay clears it mid-run). The trigger block re-arms the
 *   pause only when a cycle genuinely breaches again.
 *
 * A non-positive threshold means the breaker is off, so a leftover pause from
 * when it was enabled should not latch either.
 *
 * Returns true when the caller should clear the active pause (`resolvedAt`).
 */
export function shouldAutoResolveExecutionFailuresPause(
  input: ExecutionFailuresAutoResolveInput,
): boolean {
  if (input.maxConsecutiveExecutionFailures <= 0) return true;
  switch (input.mode) {
    case "shadow":
      return true;
    case "canary":
    case "live":
    case "off":
      return input.consecutiveExecutionFailures < input.maxConsecutiveExecutionFailures;
    default:
      throw new Error(`Unhandled autonomous token mode: ${String(input.mode)}`);
  }
}

/**
 * Mode-aware auto-resolution for a latched `daily_drawdown` safety pause
 * (issue #148). The daily equity baseline re-seeds every day, but nothing
 * ever re-evaluated an existing pause — only `prism resume` could clear it,
 * so the pause silently latched into new days. This mirrors the autonomy
 * contract:
 *
 * - `shadow` — informational only: the pause never blocks and never requires
 *   a manual resume, so always auto-resolve.
 * - `canary` — auto-clear at the day-boundary rollover, or as soon as the
 *   drawdown recovers below `MAX_DAILY_DRAWDOWN_PCT`.
 * - `live` — re-evaluate fresh every cycle: auto-resolve when the drawdown no
 *   longer breaches the threshold (a fresh daily baseline after rollover
 *   normally drops the measured drawdown to ~0).
 *
 * A disabled threshold (`maxDailyDrawdownPct <= 0`) means the gate is off, so
 * a leftover pause from when it was enabled should not latch either.
 *
 * Returns true when the caller should clear the active pause (`resolvedAt`).
 */
export function shouldAutoResolveDailyDrawdownPause(input: DailyDrawdownAutoResolveInput): boolean {
  if (input.maxDailyDrawdownPct <= 0) return true;
  switch (input.mode) {
    case "shadow":
      return true;
    case "canary":
      return input.dayRolledOver || input.dailyDrawdownPct < input.maxDailyDrawdownPct;
    case "live":
    case "off":
      return input.dailyDrawdownPct < input.maxDailyDrawdownPct;
    default:
      throw new Error(`Unhandled autonomous token mode: ${String(input.mode)}`);
  }
}

/** Computes the bounded retry timestamp for a settlement attempt. */
export function nextSettlementRetryAt(now: number, attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 30));
  return now + Math.min(2 ** exponent * 1_000, 300_000);
}

/**
 * Age in ms of the oldest ACTIVE settlement job. `confirmed` and `terminal`
 * are final states: a dead-end terminal job (e.g. a failed rollback) must not
 * keep the `settlement_overdue` safety pause latched forever after
 * `prism resume` (issue #167). Returns 0 when no active jobs remain.
 */
export function oldestActiveSettlementAgeMs(
  jobs: ReadonlyArray<SettlementJobRecord>,
  now: number,
): number {
  return jobs
    .filter((job) => job.status !== "confirmed" && job.status !== "terminal")
    .reduce((oldest, job) => Math.max(oldest, now - job.createdAt), 0);
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

export interface DailyEquityBaselineScope {
  readonly walletAddress: string;
  readonly agentInstanceId: string;
}

export interface DailyEquityBaseline {
  readonly day: string;
  readonly equityUsd: number;
}

function dailyBaselineKeys(scope: DailyEquityBaselineScope): {
  readonly day: string;
  readonly equity: string;
} {
  const prefix = `dailyBaseline:${encodeURIComponent(scope.walletAddress)}:${encodeURIComponent(scope.agentInstanceId)}`;
  return { day: `${prefix}:day`, equity: `${prefix}:equityUsd` };
}

export function loadDailyEquityBaseline(
  db: Pick<DbApi, "getMetadata">,
  scope: DailyEquityBaselineScope,
): Effect.Effect<DailyEquityBaseline, never> {
  return Effect.gen(function* () {
    const keys = dailyBaselineKeys(scope);
    const day = yield* db.getMetadata(keys.day).pipe(Effect.catch(() => Effect.succeed(null)));
    const equity = yield* db
      .getMetadata(keys.equity)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    const equityUsd = equity === null ? 0 : Number(equity);
    return {
      day: day ?? "",
      equityUsd: Number.isFinite(equityUsd) && equityUsd >= 0 ? equityUsd : 0,
    };
  });
}

export function persistDailyEquityBaseline(
  db: Pick<DbApi, "setMetadataBatch">,
  scope: DailyEquityBaselineScope,
  baseline: DailyEquityBaseline,
): Effect.Effect<void, never> {
  const keys = dailyBaselineKeys(scope);
  return db
    .setMetadataBatch([
      { key: keys.day, value: baseline.day },
      { key: keys.equity, value: String(baseline.equityUsd) },
    ])
    .pipe(Effect.catch(() => Effect.void));
}

function atomicUsd(amountAtomic: bigint, decimals: number, priceUsd: number): number {
  const scale = 10n ** BigInt(decimals);
  const whole = amountAtomic / scale;
  const remainder = amountAtomic % scale;
  return (Number(whole) + Number(remainder) / Number(scale)) * priceUsd;
}

/**
 * Issue #166: classifies a settlement failure as transient (retryable) vs
 * definitively terminal. HTTP 408/425/429/5xx from the quote/swap API and
 * network-level failures (timeouts, resets, DNS, aborts) are transient by
 * definition — a rate limit clears, a connection recovers. Anything else
 * (insufficient funds, invalid params, malformed payloads) will not fix
 * itself by retrying.
 */
const TRANSIENT_HTTP_STATUS =
  /(?:failed|HTTP):?\s*(408|425|429|5\d{2})\b|HTTP\/\d(?:\.\d)?\s+(408|425|429|5\d{2})\b|status code (408|425|429|5\d{2})\b/i;
const TRANSIENT_NETWORK =
  /fetch failed|timeout|timed out|timedout|aborted|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|connection refused|connection reset|network error|too many requests/i;

export function isTransientSettlementError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // Anchored to HTTP-status context — a bare \b\d{3}\b would classify
  // deterministic messages like "need 500 lamports" as transient and retry
  // them forever instead of terminalizing.
  return TRANSIENT_HTTP_STATUS.test(message) || TRANSIENT_NETWORK.test(message);
}

function retryableJob(job: SettlementJobRecord, now: number, error: unknown): SettlementJobRecord {
  const attempts = job.attempts + 1;
  // Transient failures (rate limits, network blips) never terminalize — the
  // failure mode is time, not logic, so the retry budget stays unbounded and
  // the job resumes as soon as the outage clears. Only non-transient failures
  // expire into terminal once the max-pending window passes.
  const transient = isTransientSettlementError(error);
  const expired = !transient && now >= job.expiresAt;
  return {
    ...job,
    status: expired ? "terminal" : "retryable",
    attempts,
    nextRetryAt: expired ? null : nextSettlementRetryAt(now, attempts),
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
      if (job.status === "terminal" || (job.nextRetryAt !== null && job.nextRetryAt > input.now)) {
        processed.push(job);
        continue;
      }
      if (
        job.status === "confirmed" &&
        job.confirmedOutputAtomic !== null &&
        job.outputUsd !== null &&
        job.executionCostUsd !== null
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
            if (
              job.confirmedOutputAtomic !== null &&
              job.outputUsd !== null &&
              job.executionCostUsd !== null
            ) {
              return {
                ...job,
                status: "confirmed" as const,
                nextRetryAt: null,
                error: null,
                updatedAt: input.now,
              };
            }

            if (input.adapter.getConfirmedSwapOutput) {
              const evidence = yield* input.adapter.getConfirmedSwapOutput(job.txSignature);
              if (evidence && evidence.outputAtomic > 0n) {
                const prices = yield* input.adapter.getTokenPrices([SOL_MINT]);
                const solPriceUsd = prices[SOL_MINT] ?? 0;
                if (solPriceUsd > 0) {
                  const outputUsd = atomicUsd(evidence.outputAtomic, 9, solPriceUsd);
                  const executionCostUsd = atomicUsd(evidence.feeAtomic, 9, solPriceUsd);
                  return {
                    ...job,
                    status: "confirmed" as const,
                    confirmedOutputAtomic: evidence.outputAtomic.toString(),
                    outputUsd,
                    executionCostUsd,
                    nextRetryAt: null,
                    error: null,
                    updatedAt: input.now,
                  };
                }
                return reconciliationJob(
                  job,
                  input.now,
                  new Error(
                    "Confirmed swap output found but SOL price unavailable for USD conversion",
                  ),
                );
              }
            }

            return reconciliationJob(
              job,
              input.now,
              new Error("Confirmed swap output evidence unavailable"),
            );
          }
          if (status.state === "processed") {
            return {
              ...job,
              status: "submitted" as const,
              nextRetryAt: nextSettlementRetryAt(input.now, job.attempts + 1),
              updatedAt: input.now,
            };
          }
          if (status.state === "not_found") {
            // A broadcast settlement recovered after a confirmation/RPC failure
            // can transiently read `not_found` before the original signature
            // becomes visible. Treating that like a definitive failure re-quotes
            // and resubmits the FULL token amount — if the first transaction
            // later lands (and the wallet has pre-existing balance), the tokens
            // are sold twice. Retain the submitted state with the signature so
            // the next retry re-queries the status instead of rearming
            // submission. Once the job's max-pending window is definitively
            // past, the transaction can no longer land: terminalize it like any
            // other unrecoverable settlement so it stops retrying.
            const attempts = job.attempts + 1;
            const expired = input.now >= job.expiresAt;
            return {
              ...job,
              status: expired ? ("terminal" as const) : ("submitted" as const),
              attempts,
              nextRetryAt: expired ? null : nextSettlementRetryAt(input.now, attempts),
              error: expired
                ? "Swap signature not found until expiry — requires operator reconciliation"
                : job.error,
              updatedAt: input.now,
            };
          }
          // status.state === "failed": the transaction definitively failed on
          // chain — fall through and submit a fresh swap.
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
        // Priceable sub-dust stays put (pre-existing policy): the value is
        // known and below the sweep cutoff, so it is recorded as recovered.
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
        // Issue #183: the dust skip covers unpriceable tokens too (value
        // unknown ⇒ $0) — quoting an unquotable mint returns a definitive 400
        // (no route) and previously re-queued the job forever. Confirmed ONLY
        // for synthetic settlement groups (orphan:/rollback: — no position row
        // to finalize): a real position's sweep job (EXIT residues/rewards)
        // must not be dust-confirmed, because finalizing its group would book
        // a full PnL loss while the tokens still sit in the wallet. Real
        // positions fall through to the quote path (bounded retries, then
        // terminal on expiry — operator-visible via prism status), and the
        // orphan sweep skips unpriceable holdings, so the 400 loop stays dead.
        const syntheticSettlementGroup =
          job.positionId.startsWith("orphan:") || job.positionId.startsWith("rollback:");
        if (syntheticSettlementGroup && settlementDustUsd > 0 && inputPriceUsd <= 0) {
          return {
            ...job,
            status: "confirmed" as const,
            attempts: job.attempts + 1,
            nextRetryAt: null,
            confirmedOutputAtomic: amountAtomic.toString(),
            outputUsd: inputUsd,
            executionCostUsd: 0,
            error: "settlement dust skipped (no USD price)",
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
        Effect.catch((error) =>
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
      const persisted = yield* input.db.saveSettlementJob(result).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
      if (persisted) processed.push(result);
    }

    const byPosition = Map.groupBy(processed, (job) => job.positionId);
    for (const [positionId, jobs] of byPosition) {
      const unfinalized = jobs.filter((job) => job.finalizedAt === null);
      if (unfinalized.length === 0) continue;
      if (jobs.some((job) => job.status !== "confirmed")) continue;
      const completeJobs = jobs.filter(
        (job): job is SettlementJobRecord & { outputUsd: number; executionCostUsd: number } =>
          job.outputUsd !== null && job.executionCostUsd !== null,
      );
      if (completeJobs.length !== jobs.length) continue;
      const position = yield* input.db
        .getPosition(positionId)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!position) continue;
      const outputUsd = completeJobs.reduce((sum, job) => sum + job.outputUsd, 0);
      const executionCostUsd = completeJobs.reduce((sum, job) => sum + job.executionCostUsd, 0);
      const realizedPnlUsd = computeNetRealizedPnlUsd({
        finalValueUsd: outputUsd + executionCostUsd,
        cumulativeFeesClaimedUsd: position.cumulativeFeesClaimedUsd,
        cumulativeRewardsClaimedUsd: position.cumulativeRewardsClaimedUsd,
        costBasisUsd: position.depositedUsd,
        settlementCostUsd: executionCostUsd,
        executionCostUsd: 0,
      });
      yield* input.db
        .finalizeSettlementGroup({
          positionId,
          realizedPnlUsd,
          jobIds: jobs.map((job) => job.id),
          finalizedAt: input.now,
          signalSnapshotId: position.entrySignalSnapshotId,
        })
        .pipe(Effect.catch(() => Effect.void));
    }
    return processed;
  });
}

export interface OrphanSettlementSweepInput {
  readonly adapter: AdapterApi;
  readonly db: DbApi;
  readonly walletAddress: string;
  readonly agentInstanceId: string;
  readonly settlementMaxPendingMs: number;
  readonly settlementDustUsd: number;
  readonly now: number;
}

/**
 * Issue #166: a SOL-funded entry that fails after the swap leaves the bought
 * token stranded in the wallet with no position and no recovery path once its
 * rollback settlement died. Each cycle this compares wallet holdings against
 * the mints that are actually accounted for (position legs, active settlement
 * jobs) and re-enqueues a fresh sell-settlement job for everything else.
 * Dust below `settlementDustUsd` stays put; unpriceable tokens are treated as
 * dust too (value unknown ⇒ $0 for sweep purposes — issue #183: quoting an
 * unquotable mint 400s forever, so enqueuing them was an infinite retry loop)
 * and re-qualify automatically once a price resolves. Fail-open end to
 * end: a holdings read, pool-state fetch, or price fetch failure skips only
 * its own contribution and never blocks the cycle. RPC cost is gated —
 * position legs are only fetched when candidate mints actually exist, and
 * holdings come from the wallet balance's existing 30s cached snapshot.
 */
export function sweepOrphanSettlements(
  input: OrphanSettlementSweepInput,
): Effect.Effect<ReadonlyArray<SettlementJobRecord>, never> {
  return Effect.gen(function* () {
    if (!input.adapter.hasWallet()) return [];
    const holdings = yield* input.adapter
      .getWalletHoldings()
      .pipe(
        Effect.catch(() =>
          Effect.succeed(new Map<string, { amountAtomic: bigint; decimals: number }>()),
        ),
      );
    const candidates = [...holdings.entries()].filter(
      ([mint, holding]) => mint !== SOL_MINT && holding.amountAtomic > 0n,
    );
    if (candidates.length === 0) return [];
    const existingJobs = yield* input.db
      .listSettlementJobs(input.walletAddress, input.agentInstanceId)
      .pipe(Effect.catch(() => Effect.succeed([])));
    const backedMints = new Set<string>(
      existingJobs
        .filter((job) => job.status !== "terminal" && job.status !== "confirmed")
        .map((job) => job.tokenMint),
    );
    // Backing positions are the CURRENT wallet's live on-chain positions.
    // getAllPositions has no wallet filter and paper rows share the table, so
    // exclude `paper-*` rows — a paper position's pool legs must not exempt a
    // live wallet's stranded tokens. The engine's model is one wallet per DB
    // (portfolio/equity math already assumes it), so remaining rows belong to
    // the current wallet.
    const openPositions = yield* input.db
      .getAllPositions()
      .pipe(Effect.catch(() => Effect.succeed([])));
    for (const poolAddress of new Set(
      openPositions
        .filter((position) => !position.positionId.startsWith("paper-"))
        .map((position) => position.poolAddress),
    )) {
      const state = yield* input.adapter
        .getPoolState(poolAddress)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (state) {
        backedMints.add(state.tokenX);
        backedMints.add(state.tokenY);
      }
    }
    const prices = yield* input.adapter
      .getTokenPrices(candidates.map(([mint]) => mint))
      .pipe(
        // Issue #183: a price-fetch failure must not be silent — every
        // holding would read price 0 and be skipped as dust for the cycle
        // (a quiet multi-cycle sweep stall is otherwise unobservable; the
        // processor path treats the same failure as retryable).
        Effect.catch((err) => {
          logger.warn(
            "Orphan sweep price fetch failed — unpriceable holdings treated as dust this cycle",
            {
              candidateCount: candidates.length,
              error: err instanceof Error ? err.message : String(err),
            },
          );
          return Effect.succeed<Record<string, number>>({});
        }),
      );
    // A terminal job for the mint is revived in place (upsert on id) rather
    // than replaced by a fresh row: attempts carry over so backoff escalates
    // across generations, and the settlements table stays one row per mint
    // instead of growing ~1 row per max-pending window for a doomed token.
    // Terminal rows carrying a txSignature are the operator-reconciliation
    // bucket (swap signature never became visible) — reviving them would
    // re-poll a dead signature forever, so only signature-less terminal rows
    // are auto-revived; a signature terminal spawns a fresh job instead.
    const terminalByMint = new Map<string, SettlementJobRecord>(
      existingJobs
        .filter(
          (job) =>
            job.status === "terminal" &&
            job.confirmedOutputAtomic === null &&
            job.txSignature === null,
        )
        .map((job) => [job.tokenMint, job]),
    );
    const jobs: SettlementJobRecord[] = [];
    for (const [mint, holding] of holdings) {
      if (mint === SOL_MINT || holding.amountAtomic <= 0n) continue;
      if (backedMints.has(mint)) continue;
      const priceUsd = prices[mint] ?? 0;
      if (
        input.settlementDustUsd > 0 &&
        (priceUsd <= 0 ||
          atomicUsd(holding.amountAtomic, holding.decimals, priceUsd) < input.settlementDustUsd)
      ) {
        continue;
      }
      const terminal = terminalByMint.get(mint);
      if (terminal) {
        jobs.push({
          ...terminal,
          status: "pending",
          attempts: terminal.attempts + 1,
          // Sell what the wallet actually holds now, not the stale row amount.
          amountAtomic: holding.amountAtomic.toString(),
          nextRetryAt: input.now,
          expiresAt: input.now + input.settlementMaxPendingMs,
          error: null,
          updatedAt: input.now,
        });
        continue;
      }
      const id = randomUUID();
      jobs.push({
        id,
        walletAddress: input.walletAddress,
        agentInstanceId: input.agentInstanceId,
        positionId: `orphan:${id}`,
        poolAddress: "",
        tokenMint: mint,
        amountAtomic: holding.amountAtomic.toString(),
        destinationAsset: "SOL",
        status: "pending",
        attempts: 0,
        nextRetryAt: input.now,
        txSignature: null,
        confirmedOutputAtomic: null,
        outputUsd: null,
        executionCostUsd: null,
        finalizedAt: null,
        realizedPnlUsd: null,
        expiresAt: input.now + input.settlementMaxPendingMs,
        error: null,
        createdAt: input.now,
        updatedAt: input.now,
      });
    }
    return jobs;
  });
}
