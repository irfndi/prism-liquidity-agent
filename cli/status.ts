import { Command } from "commander";
import { Effect, Layer } from "effect";
import { DbLive } from "../engine/db-service.js";
import { DbService, AuditService, AdapterService } from "../engine/services.js";
import { AuditLive } from "../engine/audit-service.js";
import { ConfigLive, ConfigService } from "../engine/config-service.js";
import { AdapterLive } from "../engine/adapter-service.js";
import type { PositionRecord } from "../engine/db-service.js";
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
  unknown,
  never
> {
  const dbPath = process.env.SQLITE_DB_PATH ?? getPrismDbPath();
  const dbLayer = DbLive(dbPath);
  const auditLayer = Layer.provide(AuditLive, dbLayer);
  const configLayer = ConfigLive;
  const adapterLayer = Layer.provide(AdapterLive, configLayer);
  return Layer.merge(auditLayer, Layer.merge(dbLayer, Layer.merge(configLayer, adapterLayer)));
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
from agent skills or cron jobs. It does not require the engine to be running.`,
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
              .pipe(Effect.catchAll(() => Effect.succeed(null)));
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
                  attempts: settlement.attempts,
                  nextRetryAt:
                    settlement.nextRetryAt === null
                      ? null
                      : new Date(settlement.nextRetryAt).toISOString(),
                  expiresAt: new Date(settlement.expiresAt).toISOString(),
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
              `  Safety pause: ${
                autonomous.safetyPause === null
                  ? "none"
                  : autonomous.safetyPause.resolvedAt === null
                    ? `ACTIVE (${autonomous.safetyPause.reason})`
                    : `resolved (${autonomous.safetyPause.reason})`
              }`,
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
