import { Command } from "commander";
import { Effect, Layer } from "effect";
import { DbLive } from "../engine/db-service.js";
import { DbService, AuditService } from "../engine/services.js";
import { AuditLive } from "../engine/audit-service.js";
import { ConfigLive, ConfigService } from "../engine/config-service.js";
import type { PositionRecord } from "../engine/db-service.js";
import { computeSummary, toJsonOutput, type PortfolioSummary } from "./portfolio.js";
import { createLogger } from "../engine/logger.js";

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
}

function buildProgram(): Layer.Layer<DbService | AuditService | ConfigService, never, never> {
  const dbLayer = DbLive(process.env.SQLITE_DB_PATH);
  const auditLayer = Layer.provide(AuditLive, dbLayer);
  const configLayer = ConfigLive;
  return Layer.merge(auditLayer, Layer.merge(dbLayer, configLayer));
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
          const summary = computeSummary(positions);

          const activePositions = positions.filter((p) => p.paperExitedAt === null);
          const hasDb = positions.length > 0 || recentAudit.length > 0;

          if (opts.json) {
            const json: StatusJsonOutput = {
              running: hasDb,
              dbPath: process.env.SQLITE_DB_PATH ?? "./prism.db",
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
              positions: toJsonOutput(activePositions).positions,
              recentDecisions: recentAudit.slice(0, 10).map((d) => ({
                timestamp: new Date(d.timestamp).toISOString(),
                action: d.action,
                pool: d.poolAddress,
                confidence: d.confidence,
                reasoning: d.reasoning,
                executed: d.executed,
                paperTrading: d.paperTrading,
              })),
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
              `  Database:    ${process.env.SQLITE_DB_PATH ?? "./prism.db"}`,
              `  Positions:   ${activePositions.length} active`,
              `  Deposited:   $${summary.totalDepositedUsd.toFixed(2)}`,
              `  Current:     $${summary.totalCurrentValueUsd.toFixed(2)}`,
              `  Unrealized:  ${pnlText}`,
              `  ${agentStatus}`,
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
