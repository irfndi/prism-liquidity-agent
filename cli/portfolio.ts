import { Command } from "commander";
import { Effect, Layer } from "effect";
import { DbLive } from "../engine/db-service.js";
import { DbService } from "../engine/services.js";
import type { PositionRecord } from "../engine/db-service.js";
import { createLogger } from "../engine/logger.js";

const logger = createLogger("portfolio-cli");

function buildProgram(): Layer.Layer<DbService, never, never> {
  return DbLive(process.env.SQLITE_DB_PATH);
}

export interface PortfolioSummary {
  totalDepositedUsd: number;
  totalCurrentValueUsd: number;
  totalUnrealizedPnlUsd: number;
  totalUnrealizedPnlPct: number;
  positionCount: number;
}

export function computeSummary(positions: ReadonlyArray<PositionRecord>): PortfolioSummary {
  const totalDepositedUsd = positions.reduce((sum, p) => sum + p.depositedUsd, 0);
  const totalCurrentValueUsd = positions.reduce((sum, p) => sum + p.currentValueUsd, 0);
  const totalUnrealizedPnlUsd = totalCurrentValueUsd - totalDepositedUsd;
  const totalUnrealizedPnlPct = totalDepositedUsd > 0 ? (totalUnrealizedPnlUsd / totalDepositedUsd) * 100 : 0;

  return {
    totalDepositedUsd,
    totalCurrentValueUsd,
    totalUnrealizedPnlUsd,
    totalUnrealizedPnlPct,
    positionCount: positions.length,
  };
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPct(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function formatPosition(pos: PositionRecord): string {
  const pnlUsd = pos.currentValueUsd - pos.depositedUsd;
  const pnlPct = pos.depositedUsd > 0 ? (pnlUsd / pos.depositedUsd) * 100 : 0;
  const pnlColor = pnlUsd >= 0 ? "\x1b[32m" : "\x1b[31m";
  const reset = "\x1b[0m";

  const poolName = `${pos.tokenXSymbol}/${pos.tokenYSymbol}`;
  const range = `[${pos.lowerBinId}–${pos.upperBinId}]`;
  const age = formatAge(pos.timestamp);

  return [
    `  ${poolName} ${range}`,
    `    Pool:     ${pos.poolAddress}`,
    `    Deposited:  ${formatCurrency(pos.depositedUsd)}`,
    `    Current:    ${formatCurrency(pos.currentValueUsd)}`,
    `    P&L:        ${pnlColor}${formatCurrency(pnlUsd)} (${formatPct(pnlPct)})${reset}`,
    `    Active bin: ${pos.activeBinId}`,
    `    Age:        ${age}`,
    pos.outOfRangeSince ? `    ⚠ Out of range since ${formatAge(pos.outOfRangeSince)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatAge(timestampMs: number): string {
  const diffMs = Date.now() - timestampMs;
  if (diffMs < 0) return "just now";
  const minutes = Math.floor(diffMs / (60 * 1000));
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

function formatSummary(summary: PortfolioSummary): string {
  const pnlColor = summary.totalUnrealizedPnlUsd >= 0 ? "\x1b[32m" : "\x1b[31m";
  const reset = "\x1b[0m";

  return [
    "Portfolio Summary",
    "=================",
    `  Positions:     ${summary.positionCount}`,
    `  Total Deposited:  ${formatCurrency(summary.totalDepositedUsd)}`,
    `  Total Current:    ${formatCurrency(summary.totalCurrentValueUsd)}`,
    `  Unrealized P&L:   ${pnlColor}${formatCurrency(summary.totalUnrealizedPnlUsd)} (${formatPct(summary.totalUnrealizedPnlPct)})${reset}`,
  ].join("\n");
}

function formatPositionsList(positions: ReadonlyArray<PositionRecord>): string {
  if (positions.length === 0) {
    return "No active positions.\n";
  }

  const lines: string[] = [];
  lines.push(`Active Positions (${positions.length})`);
  lines.push("=".repeat(40));

  for (const pos of positions) {
    lines.push(formatPosition(pos));
    lines.push("");
  }

  return lines.join("\n");
}

function formatHistoryList(positions: ReadonlyArray<PositionRecord>): string {
  if (positions.length === 0) {
    return "No exited positions.\n";
  }

  const lines: string[] = [];
  lines.push(`Exited Positions (${positions.length})`);
  lines.push("=".repeat(40));

  for (const pos of positions) {
    const pnlUsd = pos.currentValueUsd - pos.depositedUsd;
    const pnlPct = pos.depositedUsd > 0 ? (pnlUsd / pos.depositedUsd) * 100 : 0;
    const pnlColor = pnlUsd >= 0 ? "\x1b[32m" : "\x1b[31m";
    const reset = "\x1b[0m";

    lines.push(`  ${pos.tokenXSymbol}/${pos.tokenYSymbol}`);
    lines.push(`    Pool:      ${pos.poolAddress}`);
    lines.push(`    Deposited:  ${formatCurrency(pos.depositedUsd)}`);
    lines.push(`    Exit Value: ${formatCurrency(pos.currentValueUsd)}`);
    lines.push(`    Realized P&L: ${pnlColor}${formatCurrency(pnlUsd)} (${formatPct(pnlPct)})${reset}`);
    lines.push(`    Exited:     ${new Date(pos.paperExitedAt ?? 0).toISOString()}`);
    lines.push("");
  }

  return lines.join("\n");
}

export interface PortfolioJsonOutput {
  positions: Array<{
    poolAddress: string;
    poolName: string;
    positionPubKey: string | null;
    depositedUsd: number;
    currentValueUsd: number;
    unrealizedPnlUsd: number;
    unrealizedPnlPct: number;
    activeBinId: number;
    lowerBinId: number;
    upperBinId: number;
    timestamp: number;
    outOfRangeSince: number | null;
    age: string;
  }>;
  summary: PortfolioSummary;
}

export function toJsonOutput(positions: ReadonlyArray<PositionRecord>): PortfolioJsonOutput {
  return {
    positions: positions.map((pos) => {
      const pnlUsd = pos.currentValueUsd - pos.depositedUsd;
      const pnlPct = pos.depositedUsd > 0 ? (pnlUsd / pos.depositedUsd) * 100 : 0;
      return {
        poolAddress: pos.poolAddress,
        poolName: `${pos.tokenXSymbol}/${pos.tokenYSymbol}`,
        positionPubKey: pos.positionPubKey,
        depositedUsd: pos.depositedUsd,
        currentValueUsd: pos.currentValueUsd,
        unrealizedPnlUsd: pnlUsd,
        unrealizedPnlPct: pnlPct,
        activeBinId: pos.activeBinId,
        lowerBinId: pos.lowerBinId,
        upperBinId: pos.upperBinId,
        timestamp: pos.timestamp,
        outOfRangeSince: pos.outOfRangeSince,
        age: formatAge(pos.timestamp),
      };
    }),
    summary: computeSummary(positions),
  };
}

export interface HistoryJsonOutput {
  positions: Array<{
    poolAddress: string;
    poolName: string;
    depositedUsd: number;
    exitValueUsd: number;
    realizedPnlUsd: number;
    realizedPnlPct: number;
    paperExitedAt: number | null;
  }>;
}

export function toHistoryJsonOutput(positions: ReadonlyArray<PositionRecord>): HistoryJsonOutput {
  return {
    positions: positions.map((pos) => {
      const pnlUsd = pos.currentValueUsd - pos.depositedUsd;
      const pnlPct = pos.depositedUsd > 0 ? (pnlUsd / pos.depositedUsd) * 100 : 0;
      return {
        poolAddress: pos.poolAddress,
        poolName: `${pos.tokenXSymbol}/${pos.tokenYSymbol}`,
        depositedUsd: pos.depositedUsd,
        exitValueUsd: pos.currentValueUsd,
        realizedPnlUsd: pnlUsd,
        realizedPnlPct: pnlPct,
        paperExitedAt: pos.paperExitedAt,
      };
    }),
  };
}

export const portfolioCommand = new Command("portfolio")
  .description("View portfolio positions and P&L")
  .option("-j, --json", "Output as JSON")
  .addHelpText(
    "after",
    `\nExamples:
  $ prism portfolio                    # Show active positions with P&L
  $ prism portfolio summary            # Show portfolio summary only
  $ prism portfolio history            # Show exited positions
  $ prism portfolio --json             # JSON output for scripting

The portfolio command reads from the local SQLite database (prism.db by default)
and displays current positions with unrealized P&L calculations.\n`,
  );

async function runPortfolioAction(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Portfolio command failed: ${message}`);
    console.error(`✗ Failed to load portfolio: ${message}`);
    process.exit(1);
  }
}

// Default action: show active positions
portfolioCommand.action(async (opts: { json?: boolean }) => {
  await runPortfolioAction(async () => {
    const program = buildProgram();
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService;
        const positions = yield* db.getAllPositions();

        if (opts.json) {
          console.log(JSON.stringify(toJsonOutput(positions), null, 2));
          return;
        }

        console.log(formatPositionsList(positions));
        console.log(formatSummary(computeSummary(positions)));
      }).pipe(Effect.provide(program)),
    );
  });
});

// Summary subcommand
portfolioCommand
  .command("summary")
  .description("Show portfolio summary (totals, P&L)")
  .option("-j, --json", "Output as JSON")
  .action(async function (this: Command, opts: { json?: boolean }) {
    await runPortfolioAction(async () => {
      const parentOpts = (this as unknown as { parent?: { opts(): { json?: boolean } } }).parent?.opts();
      const isJson = opts.json || parentOpts?.json;

      const program = buildProgram();
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* DbService;
          const positions = yield* db.getAllPositions();
          const summary = computeSummary(positions);

          if (isJson) {
            console.log(JSON.stringify({ summary }, null, 2));
            return;
          }

          console.log(formatSummary(summary));
        }).pipe(Effect.provide(program)),
      );
    });
  });

// History subcommand - show exited positions
portfolioCommand
  .command("history")
  .description("Show exited positions with realized P&L")
  .option("-j, --json", "Output as JSON")
  .action(async function (this: Command, opts: { json?: boolean }) {
    await runPortfolioAction(async () => {
      const parentOpts = (this as unknown as { parent?: { opts(): { json?: boolean } } }).parent?.opts();
      const isJson = opts.json || parentOpts?.json;

      const program = buildProgram();
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* DbService;
          const positions = yield* db.getPaperExitedPositions();

          if (isJson) {
            console.log(JSON.stringify(toHistoryJsonOutput(positions), null, 2));
            return;
          }

          console.log(formatHistoryList(positions));
        }).pipe(Effect.provide(program)),
      );
    });
  });
