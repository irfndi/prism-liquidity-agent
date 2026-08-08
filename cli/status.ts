import { Command } from "commander";
import { Effect, Layer } from "effect";
import { DbLive } from "../engine/db-service.js";
import { DbService, AuditService, AdapterService } from "../engine/services.js";
import { AuditLive } from "../engine/audit-service.js";
import { ConfigLive, ConfigService } from "../engine/config-service.js";
import { AdapterLive } from "../engine/adapter-service.js";
import {
  computeSummaryWithEquity,
  readCliWalletBalance,
  toJsonOutput,
  type PortfolioSummary,
} from "./portfolio.js";
import { createLogger } from "../engine/logger.js";
import { readLockfile, isProcessAlive, findRunningEngineProcess } from "./lockfile.js";
import { getPrismDbPath } from "../engine/paths.js";
import { resolveEffectivePubkey } from "./wallet.js";

const logger = createLogger("status-cli");

/** Outcome of a per-mint lookup (price or decimals), three channels:
 *  ok (resolved), unavailable (typed transport/provider failure), unpriceable
 *  (defect or no resolvable value). Collapsing the first two would mislabel
 *  real stranded capital as worthless dust during the exact outage window an
 *  operator checks status. */
export type StrandedLookupState = "ok" | "unavailable" | "unpriceable";

export type StrandedSettlementClassification =
  | { readonly kind: "stranded"; readonly valueUsd: number }
  | { readonly kind: "dust"; readonly valueUsd: number }
  | { readonly kind: "unavailable" }
  | { readonly kind: "unpriceable" };

/**
 * Issue #183: classifies a typed `getTokenDecimals` failure. The adapter
 * raises the SAME typed error for an RPC outage and for a genuinely
 * unresolvable mint ("Cannot resolve decimals for mint X via Helius or
 * standard RPC" — adapter-service.ts) — only the message distinguishes the
 * two. Outage → Unavailable (retry later); unresolvable → Unpriceable
 * (permanent; a retry can never succeed). Exported for unit coverage.
 */
export function decimalsFailureState(err: unknown): StrandedLookupState {
  return err instanceof Error && err.message.includes("Cannot resolve decimals")
    ? "unpriceable"
    : "unavailable";
}

/**
 * Issue #183: pure classification of a stranded terminal settlement against
 * the sweep's dust policy. Priceable value at/above `dustUsd` is real
 * stranded capital; below the cutoff it is dust (intentionally never
 * re-queued, excluded from the report); an unavailable lookup stays distinct
 * from a genuinely unpriceable token. Channel reality (adapter API): the
 * PRICE channel can never reach "unavailable" — fetchTokenPrices never fails
 * and unresolved mints are 0 — so a price-provider outage and a genuinely
 * unquotable mint both classify as Unpriceable (a truthful point-in-time
 * statement: no USD price resolved at query time; the next run re-checks).
 * The "unavailable" state is driven by the decimals/RPC lookup, which does
 * fail typed on outage (distinguished from the adapter's unresolvable-mint
 * error by message). Exported for direct unit coverage of the channel split
 * (the CLI harness cannot inject adapter failures).
 */
export function classifyStrandedSettlement(input: {
  readonly priceState: StrandedLookupState;
  readonly priceUsd: number;
  readonly decimalsState: StrandedLookupState;
  readonly decimals: number;
  readonly amountAtomic: string;
  readonly dustUsd: number;
}): StrandedSettlementClassification {
  if (input.priceState === "unavailable" || input.decimalsState === "unavailable") {
    return { kind: "unavailable" };
  }
  if (input.priceState === "unpriceable" || input.decimalsState === "unpriceable") {
    return { kind: "unpriceable" };
  }
  const amountNum = Number(input.amountAtomic);
  if (!Number.isFinite(amountNum)) {
    return { kind: "unpriceable" };
  }
  const valueUsd = (amountNum / 10 ** input.decimals) * input.priceUsd;
  return valueUsd >= input.dustUsd ? { kind: "stranded", valueUsd } : { kind: "dust", valueUsd };
}

export interface StatusJsonOutput {
  running: boolean;
  dbPath: string;
  timestamp: string;
  agentRuntime: {
    enabled: boolean;
    runtime: string;
    acpCommand: string;
    gatewayUrl: string;
    checkinIntervalMs: number;
    checkinOnEvents: boolean;
  };
  portfolio: PortfolioSummary;
  positions: ReturnType<typeof toJsonOutput>["positions"];
  recentDecisions: Array<{
    timestamp: string;
    action: string;
    pool: string;
    confidence: number;
    reasoning: string;
    executed: boolean;
    paperTrading: boolean;
  }>;
  autonomous: {
    mode: "off" | "shadow" | "canary" | "live";
    walletAddress: string | null;
    agentInstanceId: string;
    candidates: Array<{
      id: string;
      state: string;
      poolAddress: string;
      tokenMint: string;
      healthyScanCount: number;
      updatedAt: string;
    }>;
    operations: Array<{
      id: string;
      candidateId: string | null;
      positionId: string | null;
      type: string;
      status: string;
      poolAddress: string;
      tokenMint: string;
      txSignature: string | null;
      error: string | null;
      updatedAt: string;
    }>;
    settlements: Array<{
      id: string;
      positionId: string;
      status: string;
      poolAddress: string;
      tokenMint: string;
      attempts: number;
      nextRetryAt: string | null;
      expiresAt: string;
      txSignature: string | null;
      error: string | null;
    }>;
    safetyPause: {
      active: boolean;
      reason: string;
      triggeredAt: string;
      resolvedAt: string | null;
    } | null;
  };
}

function buildProgram(): Layer.Layer<
  DbService | AuditService | ConfigService | AdapterService,
  Error,
  never
> {
  const dbPath = process.env.SQLITE_DB_PATH ?? getPrismDbPath();
  const dbLayer = DbLive(dbPath);
  const auditLayer = Layer.provide(AuditLive, dbLayer);
  const configLayer = ConfigLive;
  const adapterLayer = Layer.provide(AdapterLive, configLayer);
  return Layer.mergeAll(dbLayer, auditLayer, configLayer, adapterLayer) as unknown as Layer.Layer<
    DbService | AuditService | ConfigService | AdapterService,
    Error,
    never
  >;
}

export const statusCommand = new Command("status")
  .description("Show current agent status for humans and agent runtimes")
  .option("-j, --json", "Output as JSON for agent consumption")
  .option("-m, --message", "Output a short markdown summary for messaging apps")
  .addHelpText(
    "after",
    `\nExamples:
  $ prism status                 # Human-readable status summary
  $ prism status --json          # JSON output for agents / skills
  $ prism status --message       # Markdown summary for Telegram/Discord/Slack/WhatsApp

The status command reads from the local SQLite database and is safe to call
from agent skills or cron jobs. It does not require the engine to be running.
When terminal settlements with unspent balance exist, classifying them
(Stranded vs dust vs unpriceable) performs price/decimals lookups against the
network; with no stranded settlements it is fully offline.`,
  )
  .action(async (opts: { json?: boolean; message?: boolean }) => {
    try {
      const program = buildProgram();
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* DbService;
          const audit = yield* AuditService;
          const config = yield* ConfigService;

          const positions = yield* db.getAllPositions();
          const recentAudit = yield* audit.getRecentDecisions(10);
          const walletBalanceUsd = yield* readCliWalletBalance();
          const summary = computeSummaryWithEquity(positions, walletBalanceUsd);
          const effectiveWallet = resolveEffectivePubkey();
          const walletAddress = effectiveWallet?.error ? null : (effectiveWallet?.pubkey ?? null);
          const autonomousWalletAddress = walletAddress ?? "paper";
          const autonomous = {
            candidates: yield* db.listTokenCandidates(
              autonomousWalletAddress,
              config.agentInstanceId,
            ),
            operations: yield* db.listExecutionOperations(
              autonomousWalletAddress,
              config.agentInstanceId,
            ),
            settlements: yield* db.listSettlementJobs(
              autonomousWalletAddress,
              config.agentInstanceId,
            ),
            safetyPause: yield* db.getSafetyPause(autonomousWalletAddress, config.agentInstanceId),
          };

          const activePositions = positions.filter((p) => p.paperExitedAt === null);
          const prices = new Map<string, number>();
          for (const pos of activePositions) {
            const price = yield* db
              .getLatestSnapshotPrice(pos.poolAddress)
              .pipe(Effect.catch(() => Effect.succeed(null)));
            if (price != null) prices.set(pos.poolAddress, price);
          }
          const hasDb = positions.length > 0 || recentAudit.length > 0;
          const lastActivityAt = recentAudit[0]?.timestamp ?? 0;
          const lock = readLockfile();
          const runningProcess = findRunningEngineProcess();
          const running =
            (lock !== null && isProcessAlive(lock.pid)) ||
            runningProcess !== null ||
            (hasDb && Date.now() - lastActivityAt < config.scanIntervalMs * 2);

          if (opts.json) {
            const json: StatusJsonOutput = {
              running: running,
              dbPath: process.env.SQLITE_DB_PATH ?? getPrismDbPath(),
              timestamp: new Date().toISOString(),
              agentRuntime: {
                enabled: config.agentiveMode,
                runtime: config.agentRuntime,
                acpCommand: config.agentAcpCommand,
                gatewayUrl: config.agentGatewayUrl,
                checkinIntervalMs: config.agentCheckinIntervalMs,
                checkinOnEvents: config.agentCheckinOnEvents,
              },
              portfolio: summary,
              positions: toJsonOutput(activePositions, prices).positions,
              recentDecisions: recentAudit.slice(0, 10).map((d) => ({
                timestamp: new Date(d.timestamp).toISOString(),
                action: d.action,
                pool: d.poolAddress,
                confidence: d.confidence,
                reasoning: d.reasoning,
                executed: d.executed,
                paperTrading: d.paperTrading,
              })),
              autonomous: {
                mode: config.autonomousTokenMode,
                walletAddress,
                agentInstanceId: config.agentInstanceId,
                candidates: autonomous.candidates.map((candidate) => ({
                  id: candidate.id,
                  state: candidate.state,
                  poolAddress: candidate.poolAddress,
                  tokenMint: candidate.tokenMint,
                  healthyScanCount: candidate.healthyScanCount,
                  updatedAt: new Date(candidate.updatedAt).toISOString(),
                })),
                operations: autonomous.operations.map((operation) => ({
                  id: operation.id,
                  candidateId: operation.candidateId,
                  positionId: operation.positionId,
                  type: operation.operationType,
                  status: operation.status,
                  poolAddress: operation.poolAddress,
                  tokenMint: operation.tokenMint,
                  txSignature: operation.txSignature,
                  error: operation.error,
                  updatedAt: new Date(operation.updatedAt).toISOString(),
                })),
                settlements: autonomous.settlements.map((settlement) => ({
                  id: settlement.id,
                  positionId: settlement.positionId,
                  status: settlement.status,
                  poolAddress: settlement.poolAddress,
                  tokenMint: settlement.tokenMint,
                  amountAtomic: settlement.amountAtomic,
                  confirmedOutputAtomic: settlement.confirmedOutputAtomic,
                  attempts: settlement.attempts,
                  nextRetryAt:
                    settlement.nextRetryAt === null
                      ? null
                      : new Date(settlement.nextRetryAt).toISOString(),
                  expiresAt: new Date(settlement.expiresAt).toISOString(),
                  createdAt: new Date(settlement.createdAt).toISOString(),
                  txSignature: settlement.txSignature,
                  error: settlement.error,
                })),
                safetyPause:
                  autonomous.safetyPause === null
                    ? null
                    : {
                        active: autonomous.safetyPause.resolvedAt === null,
                        reason: autonomous.safetyPause.reason,
                        triggeredAt: new Date(autonomous.safetyPause.triggeredAt).toISOString(),
                        resolvedAt:
                          autonomous.safetyPause.resolvedAt === null
                            ? null
                            : new Date(autonomous.safetyPause.resolvedAt).toISOString(),
                      },
              },
            };
            console.log(JSON.stringify(json, null, 2));
            return;
          }

          if (opts.message) {
            const pnlEmoji = summary.totalUnrealizedPnlUsd >= 0 ? "🟢" : "🔴";
            const positionLines =
              activePositions.length === 0
                ? ["No open positions."]
                : activePositions.map((p) => {
                    const pnl = p.currentValueUsd - p.depositedUsd;
                    const emoji = pnl >= 0 ? "🟢" : "🔴";
                    return `${emoji} ${p.tokenXSymbol}/${p.tokenYSymbol}: $${p.currentValueUsd.toFixed(2)} (${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)})`;
                  });
            const decisionLines =
              recentAudit.length === 0
                ? ["No recent decisions."]
                : recentAudit.slice(0, 3).map((d) => {
                    const pool = `${d.poolAddress.slice(0, 6)}...${d.poolAddress.slice(-4)}`;
                    return `• ${d.action} ${pool} — ${(d.confidence * 100).toFixed(0)}% confidence`;
                  });
            const lines = [
              "🔺 *Prism Status*",
              "",
              `Positions: ${activePositions.length} active`,
              `Deposited: $${summary.totalDepositedUsd.toFixed(2)}`,
              `Current:   $${summary.totalCurrentValueUsd.toFixed(2)}`,
              ...(summary.walletKnown
                ? [`Wallet:    $${(summary.walletBalanceUsd ?? 0).toFixed(2)}`]
                : []),
              `Equity:    $${summary.totalEquityUsd.toFixed(2)}`,
              `Fees:      $${summary.totalFeesClaimedUsd.toFixed(2)}`,
              ...(summary.totalRewardsClaimedUsd > 0
                ? [`Rewards:   $${summary.totalRewardsClaimedUsd.toFixed(2)}`]
                : []),
              `Unrealized: ${pnlEmoji} $${summary.totalUnrealizedPnlUsd.toFixed(2)} (${summary.totalUnrealizedPnlPct.toFixed(2)}%)`,
              "",
              "*Open positions*",
              ...positionLines,
              "",
              "*Recent decisions*",
              ...decisionLines,
            ];
            if (config.agentiveMode) {
              lines.push("", `Agent overlay: ${config.agentRuntime}`);
            }
            console.log(lines.join("\n"));
            return;
          }

          const pnlText = `${summary.totalUnrealizedPnlUsd >= 0 ? "+" : ""}$${summary.totalUnrealizedPnlUsd.toFixed(2)} (${summary.totalUnrealizedPnlPct.toFixed(2)}%)`;
          const agentStatus = config.agentiveMode
            ? `agent overlay: ${config.agentRuntime}`
            : "agent overlay: off";
          // Issue #166: surface terminal settlements whose swap never
          // recovered the token so stranded capital stays visible until
          // the orphan sweep re-queues it. A terminal record is historical
          // only when a CONFIRMED settlement for the same mint is newer than
          // it (the sweep sold the token) — a terminal record NEWER than any
          // confirmed one is a recurring stranding and must stay visible.
          // Issue #183: classify against the sweep's dust policy — a
          // sub-dust terminal is intentionally never re-queued (not stranded
          // capital, so it is excluded), an unpriceable terminal cannot be
          // valued (stays visible, labeled unpriceable), and only priceable
          // value at/above the dust cutoff is real stranded capital.
          const newestConfirmedAt = new Map<string, number>();
          for (const settlement of autonomous.settlements) {
            if (settlement.status !== "confirmed") continue;
            const previous = newestConfirmedAt.get(settlement.tokenMint);
            if (previous === undefined || settlement.createdAt > previous) {
              newestConfirmedAt.set(settlement.tokenMint, settlement.createdAt);
            }
          }
          const strandedCandidates = autonomous.settlements.filter(
            (settlement) =>
              settlement.status === "terminal" &&
              settlement.confirmedOutputAtomic === null &&
              (newestConfirmedAt.get(settlement.tokenMint) ?? -1) < settlement.createdAt,
          );
          // Issue #183: classify against the sweep's dust policy. Prices are
          // batched into ONE call (all candidates known upfront); decimals
          // run with bounded concurrency so a stranded-token burst cannot
          // fire unbounded parallel RPC. Classification is three-way:
          // - stranded — priceable value at/above SETTLEMENT_DUST_USD (the
          //   sweep deliberately re-queues nothing here; real capital).
          // - dust — priceable value below the cutoff (intentionally never
          //   re-queued; excluded from the report).
          // - unpriceable — no resolvable price/decimals (genuinely
          //   unquotable mint, or a malformed/defective lookup): cannot be
          //   valued, surfaced on its own line.
          // - unavailable — the decimals/RPC lookup failed with an outage
          //   error: distinct from unpriceable so an outage never mislabels
          //   real stranded capital as worthless dust.
          const adapter = yield* AdapterService;
          const candidateMints = [...new Set(strandedCandidates.map((s) => s.tokenMint))];
          // Price channel: fetchTokenPrices NEVER fails — every source
          // (Helius/Jupiter/CoinGecko) catches its own errors and returns {},
          // and unresolved mints come back as price 0 — so a total
          // price-provider outage is INDISTINGUISHABLE from a genuinely
          // unquotable mint at this API and classifies as Unpriceable (the
          // label is factual: no USD price resolved at query time). Only a
          // DEFECT (sync throw from a malformed mint) is caught here, with a
          // per-mint fallback so one bad mint cannot label every candidate.
          // useFallback: false — the default serves the hardcoded fallback
          // prices (SOL at $165, USDC/USDT/... at $1) as if measured during
          // a total outage, which would report stranded capital at
          // FABRICATED values (the wallet-reconciliation path avoids them
          // for the same reason).
          const resolvePriceForMint = (mint: string) =>
            adapter.getTokenPrices([mint], { useFallback: false }).pipe(
              Effect.map((p) => {
                const price = p[mint] ?? 0;
                return {
                  mint,
                  state: (price > 0 ? "ok" : "unpriceable") as StrandedLookupState,
                  value: price,
                };
              }),
              Effect.catchCause(() =>
                Effect.succeed({ mint, state: "unpriceable" as const, value: 0 }),
              ),
            );
          const priceLookup = yield* adapter
            .getTokenPrices(candidateMints, { useFallback: false })
            .pipe(
              Effect.map((prices) => {
                const entries = candidateMints.map((mint) => {
                  const price = prices[mint] ?? 0;
                  return [
                    mint,
                    {
                      state: (price > 0 ? "ok" : "unpriceable") as StrandedLookupState,
                      value: price,
                    },
                  ] as const;
                });
                return new Map(entries);
              }),
              // Batch defect: one malformed mint must not label every candidate
              // Unpriceable — fall back to per-mint fetches, deduplicated (one
              // fetch per unique mint, not per settlement).
              Effect.catchCause(() =>
                Effect.all(candidateMints.map(resolvePriceForMint), { concurrency: 4 }).pipe(
                  Effect.map((results) => new Map(results.map((r) => [r.mint, r]))),
                ),
              ),
            );
          // Decimals channel: getTokenDecimals DOES fail typed, and the error
          // message distinguishes an RPC outage (→ Unavailable) from the
          // adapter's "Cannot resolve decimals for mint X" unresolvable case
          // (→ Unpriceable — a retry can never succeed). Deduplicated per
          // unique mint, bounded concurrency.
          const decimalsLookup = new Map<string, { state: StrandedLookupState; value: number }>();
          yield* Effect.all(
            candidateMints
              .filter((mint) => priceLookup.get(mint)?.state === "ok")
              .map((mint) =>
                adapter.getTokenDecimals(mint).pipe(
                  Effect.map((decimals) => {
                    const state: StrandedLookupState = decimals > 0 ? "ok" : "unpriceable";
                    return { mint, state, value: decimals };
                  }),
                  Effect.catch((err) =>
                    Effect.succeed({
                      mint,
                      state: decimalsFailureState(err),
                      value: 0,
                    }),
                  ),
                  Effect.catchCause(() =>
                    Effect.succeed({ mint, state: "unpriceable" as const, value: 0 }),
                  ),
                ),
              ),
            { concurrency: 4 },
          ).pipe(
            Effect.map((results) => {
              for (const r of results) decimalsLookup.set(r.mint, r);
            }),
          );
          const strandedClassification = strandedCandidates.map((settlement) => {
            const price = priceLookup.get(settlement.tokenMint) ?? {
              state: "unpriceable" as const,
              value: 0,
            };
            const decimals = decimalsLookup.get(settlement.tokenMint) ?? {
              state: "unpriceable" as const,
              value: 0,
            };
            return {
              settlement,
              ...classifyStrandedSettlement({
                priceState: price.state,
                priceUsd: price.value,
                decimalsState: decimals.state,
                decimals: decimals.value,
                amountAtomic: settlement.amountAtomic,
                dustUsd: config.settlementDustUsd,
              }),
            };
          });
          const strandedSettlements = strandedClassification.filter(
            (entry): entry is typeof entry & { valueUsd: number } => entry.kind === "stranded",
          );
          const unpriceableStranded = strandedClassification.filter(
            (entry) => entry.kind === "unpriceable",
          );
          const unavailableStranded = strandedClassification.filter(
            (entry) => entry.kind === "unavailable",
          );

          // Acceptance for issue #167: an active settlement_overdue pause
          // names the non-terminal jobs keeping it latched (oldest first).
          const latchedBySettlements = (() => {
            if (
              autonomous.safetyPause === null ||
              autonomous.safetyPause.resolvedAt !== null ||
              autonomous.safetyPause.reason !== "settlement_overdue"
            ) {
              return null;
            }
            const now = Date.now();
            const offenders = autonomous.settlements
              .filter((job) => job.status !== "confirmed" && job.status !== "terminal")
              .sort((a, b) => a.createdAt - b.createdAt)
              .slice(0, 3);
            if (offenders.length === 0) return null;
            return `  Latched by: ${offenders
              .map(
                (job) =>
                  `${job.id.slice(0, 8)}… ${job.status} ${((now - job.createdAt) / 3_600_000).toFixed(1)}h${job.error ? ` (${job.error})` : ""}`,
              )
              .join(", ")}`;
          })();

          console.log(
            [
              "Prism Status",
              "============",
              `  Database:    ${process.env.SQLITE_DB_PATH ?? getPrismDbPath()}`,
              `  Positions:   ${activePositions.length} active`,
              `  Deposited:   $${summary.totalDepositedUsd.toFixed(2)}`,
              `  Current:     $${summary.totalCurrentValueUsd.toFixed(2)}`,
              ...(summary.walletKnown
                ? [`  Wallet:      $${(summary.walletBalanceUsd ?? 0).toFixed(2)}`]
                : []),
              `  Equity:      $${summary.totalEquityUsd.toFixed(2)}`,
              `  Fees:        $${summary.totalFeesClaimedUsd.toFixed(2)}`,
              ...(summary.totalRewardsClaimedUsd > 0
                ? [`  Rewards:     $${summary.totalRewardsClaimedUsd.toFixed(2)}`]
                : []),
              `  Unrealized:  ${pnlText}`,
              `  ${agentStatus}`,
              `  Autonomous:  ${config.autonomousTokenMode} (${walletAddress ?? "paper"})`,
              ...(effectiveWallet?.error ? [`  Wallet error: ${effectiveWallet.error}`] : []),
              `  Candidates:  ${autonomous.candidates.length}`,
              `  Operations:  ${autonomous.operations.length}`,
              `  Settlements: ${autonomous.settlements.length}`,
              ...(strandedSettlements.length > 0
                ? [
                    `  Stranded:    ${strandedSettlements.length} terminal settlement(s) with unspent balance (${strandedSettlements
                      .map(
                        (entry) =>
                          `${(entry.settlement.poolAddress || "?").slice(0, 8)}/${entry.settlement.tokenMint.slice(0, 8)} ($${entry.valueUsd.toFixed(2)})`,
                      )
                      .join(", ")}) — see --json for details`,
                  ]
                : []),
              ...(unpriceableStranded.length > 0
                ? [
                    `  Unpriceable: ${unpriceableStranded.length} terminal settlement(s) with no USD price resolved at query time — cannot value, left in wallet (${unpriceableStranded
                      .map(
                        (entry) =>
                          `${(entry.settlement.poolAddress || "?").slice(0, 8)}/${entry.settlement.tokenMint.slice(0, 8)}`,
                      )
                      .join(", ")})`,
                  ]
                : []),
              ...(unavailableStranded.length > 0
                ? [
                    `  Unavailable: ${unavailableStranded.length} terminal settlement(s) — price/decimals lookup unreachable, value unknown (${unavailableStranded
                      .map(
                        (entry) =>
                          `${(entry.settlement.poolAddress || "?").slice(0, 8)}/${entry.settlement.tokenMint.slice(0, 8)}`,
                      )
                      .join(", ")}) — retry later`,
                  ]
                : []),
              `  Safety pause: ${
                autonomous.safetyPause === null
                  ? "none"
                  : autonomous.safetyPause.resolvedAt === null
                    ? `ACTIVE (${autonomous.safetyPause.reason})`
                    : `resolved (${autonomous.safetyPause.reason})`
              }`,
              ...(latchedBySettlements !== null ? [latchedBySettlements] : []),
              "",
              `  Recent decisions: ${recentAudit.length}`,
              ...recentAudit
                .slice(0, 5)
                .map(
                  (d) =>
                    `    ${d.action} ${d.poolAddress.slice(0, 16)}... (${d.confidence.toFixed(2)})`,
                ),
            ].join("\n"),
          );
        }).pipe(Effect.provide(program)),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Status command failed: ${message}`);
      console.error(`✗ Failed to load status: ${message}`);
      process.exit(1);
    }
  });
