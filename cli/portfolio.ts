import { Command } from "commander";
import { Effect, Layer } from "effect";
import { DbLive } from "../engine/db-service.js";
import { DbService, type DbApi, AdapterService } from "../engine/services.js";
import { AdapterLive } from "../engine/adapter-service.js";
import { ConfigLive } from "../engine/config-service.js";
import type { PositionRecord } from "../engine/db-service.js";
import { computePositionAnalytics, computePortfolioEquity } from "../engine/pnl.js";
import { createLogger } from "../engine/logger.js";
import { getPrismDbPath } from "../engine/paths.js";

const logger = createLogger("portfolio-cli");

// On-chain token symbols are attacker-controlled; strip ANSI escape sequences
// and terminal control characters before printing so a crafted symbol cannot
// corrupt the terminal or inject log output. Built with String.fromCharCode so
// the control bytes are not written as regex-literal escapes (no-control-regex).
const ANSI_ESCAPE_RE = new RegExp(
  `[${String.fromCharCode(0x1b, 0x9b)}][[\\]()#;?]*(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*)?${String.fromCharCode(0x07)}|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))`,
  "g",
);
const CONTROL_CHAR_RE = new RegExp(
  `[${String.fromCharCode(0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x7f)}]`,
  "g",
);

function sanitizeSymbol(value: string): string {
  return value.replace(ANSI_ESCAPE_RE, "").replace(CONTROL_CHAR_RE, "");
}

function buildProgram(): Layer.Layer<DbService | AdapterService, Error, never> {
  const dbPath = process.env.SQLITE_DB_PATH ?? getPrismDbPath();
  const dbLayer = DbLive(dbPath);
  const adapterLayer = Layer.provide(AdapterLive, ConfigLive);
  return Layer.mergeAll(dbLayer, adapterLayer) as unknown as Layer.Layer<
    DbService | AdapterService,
    Error,
    never
  >;
}

/**
 * Read the wallet's liquid balance once, fail-open, bounded. Returns null when
 * the wallet cannot be read (no wallet, RPC down, timeout) so the caller
 * falls back to positions-only equity — never fabricates a number.
 */
export function readCliWalletBalance(): Effect.Effect<number | null, never, AdapterService> {
  return Effect.gen(function* () {
    const adapter = yield* AdapterService;
    // No wallet configured → the liquid balance is NOT a chain-read wallet
    // (paper mode seeds paperPortfolioUsd, which positions-only already
    // reflects). Treat as unknown so equity falls back to positions-only
    // rather than presenting a fake $0 wallet.
    if (!adapter.hasWallet()) return null;
    return yield* adapter.getWalletBalanceUsd().pipe(
      Effect.timeout(15_000),
      Effect.matchEffect({
        onFailure: (err) => {
          // A genuine read failure (RPC down, parse error) is logged so it is
          // not silently masked as "no wallet"; the caller still degrades to
          // positions-only equity (fail-open for a reporting CLI).
          logger.warn("Wallet balance read failed; equity is positions-only", {
            error: err instanceof Error ? err.message : String(err),
          });
          return Effect.succeed(null as number | null);
        },
        onSuccess: (value) => Effect.succeed(value ?? null),
      }),
    );
  });
}
export interface PortfolioSummary {
  totalDepositedUsd: number;
  totalCurrentValueUsd: number;
  totalUnrealizedPnlUsd: number;
  totalUnrealizedPnlPct: number;
  totalFeesClaimedUsd: number;
  totalRewardsClaimedUsd: number;
  positionCount: number;
  /** Liquid wallet balance (SOL + SPL). Null when unreadable → positions-only. */
  walletBalanceUsd: number | null;
  /** True equity = positions value + wallet. Equals totalCurrentValueUsd when wallet unknown. */
  totalEquityUsd: number;
  /** False when the wallet balance could not be read (equity is positions-only). */
  walletKnown: boolean;
}

export function computeSummary(positions: ReadonlyArray<PositionRecord>): PortfolioSummary {
  return computeSummaryWithEquity(positions, null);
}

/**
 * Positions summary extended with the wallet's liquid balance (issue #149).
 * When `walletBalanceUsd` is null (unreadable / not configured) the summary
 * falls back to positions-only equity — never fabricates a wallet figure.
 */
export function computeSummaryWithEquity(
  positions: ReadonlyArray<PositionRecord>,
  walletBalanceUsd: number | null,
): PortfolioSummary {
  const equity = computePortfolioEquity({ walletBalanceUsd, positions });
  const totalUnrealizedPnlPct =
    equity.totalDepositedUsd > 0 ? (equity.unrealizedPnlUsd / equity.totalDepositedUsd) * 100 : 0;

  return {
    totalDepositedUsd: equity.totalDepositedUsd,
    totalCurrentValueUsd: equity.positionsValueUsd,
    totalUnrealizedPnlUsd: equity.unrealizedPnlUsd,
    totalUnrealizedPnlPct,
    totalFeesClaimedUsd: equity.totalFeesClaimedUsd,
    totalRewardsClaimedUsd: equity.totalRewardsClaimedUsd,
    positionCount: positions.length,
    // computePortfolioEquity is the single source of truth for wallet/equity
    // normalization (non-finite -> 0, walletKnown flag); the summary mirrors
    // it so the two surfaces can never diverge.
    walletBalanceUsd: equity.walletKnown ? equity.walletBalanceUsd : null,
    totalEquityUsd: equity.totalEquityUsd,
    walletKnown: equity.walletKnown,
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

export function computePnl(
  depositedUsd: number,
  currentValueUsd: number,
): { pnlUsd: number; pnlPct: number } {
  const pnlUsd = currentValueUsd - depositedUsd;
  const pnlPct = depositedUsd > 0 ? (pnlUsd / depositedUsd) * 100 : 0;
  return { pnlUsd, pnlPct };
}

function colorize(text: string, colorCode: string): string {
  if (process.env.NO_COLOR || !process.stdout.isTTY) return text;
  return `${colorCode}${text}\x1b[0m`;
}

export function formatPosition(pos: PositionRecord, currentPriceUsd: number | null): string {
  const analytics = computePositionAnalytics(
    {
      depositedUsd: pos.depositedUsd,
      currentValueUsd: pos.currentValueUsd,
      cumulativeFeesClaimedUsd: pos.cumulativeFeesClaimedUsd,
      cumulativeRewardsClaimedUsd: pos.cumulativeRewardsClaimedUsd,
      entryPriceUsd: pos.entryPriceUsd,
      entryAmountXUsd: pos.entryAmountXUsd,
      entryAmountYUsd: pos.entryAmountYUsd,
      openedAtMs: pos.timestamp,
      outOfRangeSinceMs: pos.outOfRangeSince,
    },
    currentPriceUsd,
    Date.now(),
  );
  const pnlText = `${formatCurrency(analytics.unrealizedPnlUsd)} (${formatPct(analytics.unrealizedPnlPct)})`;
  const coloredPnl = colorize(pnlText, analytics.unrealizedPnlUsd >= 0 ? "\x1b[32m" : "\x1b[31m");

  const poolName = `${sanitizeSymbol(pos.tokenXSymbol)}/${sanitizeSymbol(pos.tokenYSymbol)}`;
  const range = `[${pos.lowerBinId}–${pos.upperBinId}]`;
  const age = formatAge(pos.timestamp);
  const ilText =
    analytics.ilVsHodlUsd != null
      ? colorize(
          `${analytics.ilVsHodlUsd >= 0 ? "+" : ""}${formatCurrency(analytics.ilVsHodlUsd)}`,
          analytics.ilVsHodlUsd >= 0 ? "\x1b[32m" : "\x1b[31m",
        )
      : "n/a";
  const inRangeText =
    analytics.timeInRangePct != null ? `${analytics.timeInRangePct.toFixed(1)}%` : "n/a";

  return [
    `  ${poolName} ${range}`,
    `    Pool:       ${pos.poolAddress}`,
    `    Position:   ${pos.positionId}`,
    `    Deposited:  ${formatCurrency(pos.depositedUsd)}`,
    `    Current:    ${formatCurrency(pos.currentValueUsd)}`,
    `    P&L:        ${coloredPnl}`,
    `    Fees:       ${formatCurrency(analytics.feesClaimedUsd)}`,
    analytics.rewardsClaimedUsd > 0
      ? `    Rewards:    ${formatCurrency(analytics.rewardsClaimedUsd)}`
      : "",
    `    IL vs HODL: ${ilText}`,
    `    In range:   ${inRangeText}`,
    `    Active bin: ${pos.activeBinId}`,
    `    Age:        ${age}`,
    pos.outOfRangeSince != null ? `    ⚠ Out of range since ${formatAge(pos.outOfRangeSince)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatAge(timestampMs: number): string {
  const diffMs = Date.now() - timestampMs;
  if (diffMs < 0) return "just now";

  const totalMinutes = Math.floor(diffMs / (60 * 1000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const remainingMinutesAfterDays = totalMinutes % (24 * 60);
  const hours = Math.floor(remainingMinutesAfterDays / 60);
  const minutes = remainingMinutesAfterDays % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatSummary(summary: PortfolioSummary): string {
  const pnlText = `${formatCurrency(summary.totalUnrealizedPnlUsd)} (${formatPct(summary.totalUnrealizedPnlPct)})`;
  const coloredPnl = colorize(
    pnlText,
    summary.totalUnrealizedPnlUsd >= 0 ? "\x1b[32m" : "\x1b[31m",
  );

  return [
    "Portfolio Summary",
    "=================",
    `  Positions:        ${summary.positionCount}`,
    `  Total Deposited:  ${formatCurrency(summary.totalDepositedUsd)}`,
    ...(summary.walletKnown
      ? [`  Wallet Balance:  ${formatCurrency(summary.walletBalanceUsd ?? 0)}`]
      : []),
    `  Total Current:    ${formatCurrency(summary.totalCurrentValueUsd)}`,
    `  Total Equity:     ${formatCurrency(summary.totalEquityUsd)}`,
    `  Fees Claimed:     ${formatCurrency(summary.totalFeesClaimedUsd)}`,
    ...(summary.totalRewardsClaimedUsd > 0
      ? [`  Rewards Claimed:  ${formatCurrency(summary.totalRewardsClaimedUsd)}`]
      : []),
    `  Unrealized P&L:   ${coloredPnl}`,
  ].join("\n");
}

function formatPositionsList(
  positions: ReadonlyArray<PositionRecord>,
  prices: ReadonlyMap<string, number>,
): string {
  if (positions.length === 0) {
    return "No active positions.\n";
  }

  const lines: string[] = [];
  lines.push(`Active Positions (${positions.length})`);
  lines.push("=".repeat(40));

  for (const pos of positions) {
    lines.push(formatPosition(pos, prices.get(pos.poolAddress) ?? null));
    lines.push("");
  }

  return lines.join("\n");
}

function realizedPnlFor(pos: PositionRecord): { pnlUsd: number; pnlPct: number } {
  const pnlUsd =
    pos.realizedPnlUsd ??
    pos.currentValueUsd +
      pos.cumulativeFeesClaimedUsd +
      pos.cumulativeRewardsClaimedUsd -
      pos.depositedUsd;
  const pnlPct = pos.depositedUsd > 0 ? (pnlUsd / pos.depositedUsd) * 100 : 0;
  return { pnlUsd, pnlPct };
}

function formatHistoryList(positions: ReadonlyArray<PositionRecord>): string {
  if (positions.length === 0) {
    return "No exited positions.\n";
  }

  const lines: string[] = [];
  lines.push(`Exited Positions (${positions.length})`);
  lines.push("=".repeat(40));

  for (const pos of positions) {
    const { pnlUsd, pnlPct } = realizedPnlFor(pos);
    const pnlText = `${formatCurrency(pnlUsd)} (${formatPct(pnlPct)})`;
    const coloredPnl = colorize(pnlText, pnlUsd >= 0 ? "\x1b[32m" : "\x1b[31m");
    const exitedAt = pos.closedAt ?? pos.paperExitedAt;

    lines.push(`  ${sanitizeSymbol(pos.tokenXSymbol)}/${sanitizeSymbol(pos.tokenYSymbol)}`);
    lines.push(`    Pool:       ${pos.poolAddress}`);
    lines.push(`    Position:   ${pos.positionId}`);
    lines.push(`    Deposited:  ${formatCurrency(pos.depositedUsd)}`);
    lines.push(`    Exit Value: ${formatCurrency(pos.currentValueUsd)}`);
    lines.push(`    Fees:       ${formatCurrency(pos.cumulativeFeesClaimedUsd)}`);
    if (pos.cumulativeRewardsClaimedUsd > 0) {
      lines.push(`    Rewards:    ${formatCurrency(pos.cumulativeRewardsClaimedUsd)}`);
    }
    lines.push(`    Realized P&L: ${coloredPnl}`);
    lines.push(`    Exited:     ${exitedAt != null ? new Date(exitedAt).toISOString() : "N/A"}`);
    lines.push("");
  }

  return lines.join("\n");
}

export interface PortfolioJsonOutput {
  positions: Array<{
    poolAddress: string;
    poolName: string;
    positionId: string;
    positionPubKey: string | null;
    depositedUsd: number;
    currentValueUsd: number;
    unrealizedPnlUsd: number;
    unrealizedPnlPct: number;
    entryPriceUsd: number | null;
    feesClaimedUsd: number;
    rewardsClaimedUsd: number;
    hodlValueUsd: number | null;
    ilVsHodlUsd: number | null;
    timeInRangePct: number | null;
    feeAprPct: number | null;
    activeBinId: number;
    lowerBinId: number;
    upperBinId: number;
    timestamp: number;
    outOfRangeSince: number | null;
    age: string;
  }>;
  /** Wallet liquid balance read (null when unreadable). Issue #149. */
  wallet: { balanceUsd: number | null; known: boolean };
  /** True equity summary = positions + wallet. Issue #149. */
  equity: PortfolioSummary;
  /** Positions-only summary (kept for backward compatibility). */
  summary: PortfolioSummary;
}

export function toJsonOutput(
  positions: ReadonlyArray<PositionRecord>,
  prices: ReadonlyMap<string, number> = new Map(),
  walletBalanceUsd: number | null = null,
): PortfolioJsonOutput {
  return {
    wallet: {
      balanceUsd: walletBalanceUsd,
      known: walletBalanceUsd !== null && Number.isFinite(walletBalanceUsd),
    },
    equity: computeSummaryWithEquity(positions, walletBalanceUsd),
    positions: positions.map((pos) => {
      const analytics = computePositionAnalytics(
        {
          depositedUsd: pos.depositedUsd,
          currentValueUsd: pos.currentValueUsd,
          cumulativeFeesClaimedUsd: pos.cumulativeFeesClaimedUsd,
          cumulativeRewardsClaimedUsd: pos.cumulativeRewardsClaimedUsd,
          entryPriceUsd: pos.entryPriceUsd,
          entryAmountXUsd: pos.entryAmountXUsd,
          entryAmountYUsd: pos.entryAmountYUsd,
          openedAtMs: pos.timestamp,
          outOfRangeSinceMs: pos.outOfRangeSince,
        },
        prices.get(pos.poolAddress) ?? null,
        Date.now(),
      );
      return {
        poolAddress: pos.poolAddress,
        poolName: `${pos.tokenXSymbol}/${pos.tokenYSymbol}`,
        positionId: pos.positionId,
        positionPubKey: pos.positionPubKey,
        depositedUsd: pos.depositedUsd,
        currentValueUsd: pos.currentValueUsd,
        unrealizedPnlUsd: analytics.unrealizedPnlUsd,
        unrealizedPnlPct: analytics.unrealizedPnlPct,
        entryPriceUsd: pos.entryPriceUsd,
        feesClaimedUsd: analytics.feesClaimedUsd,
        rewardsClaimedUsd: analytics.rewardsClaimedUsd,
        hodlValueUsd: analytics.hodlValueUsd,
        ilVsHodlUsd: analytics.ilVsHodlUsd,
        timeInRangePct: analytics.timeInRangePct,
        feeAprPct: analytics.feeAprPct,
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
    positionId: string;
    depositedUsd: number;
    exitValueUsd: number;
    feesClaimedUsd: number;
    rewardsClaimedUsd: number;
    realizedPnlUsd: number;
    realizedPnlPct: number;
    closedAt: number | null;
    paperExitedAt: number | null;
  }>;
  summary: PortfolioSummary;
}

export function toHistoryJsonOutput(positions: ReadonlyArray<PositionRecord>): HistoryJsonOutput {
  return {
    positions: positions.map((pos) => {
      const { pnlUsd, pnlPct } = realizedPnlFor(pos);
      return {
        poolAddress: pos.poolAddress,
        poolName: `${pos.tokenXSymbol}/${pos.tokenYSymbol}`,
        positionId: pos.positionId,
        depositedUsd: pos.depositedUsd,
        exitValueUsd: pos.currentValueUsd,
        feesClaimedUsd: pos.cumulativeFeesClaimedUsd,
        rewardsClaimedUsd: pos.cumulativeRewardsClaimedUsd,
        realizedPnlUsd: pnlUsd,
        realizedPnlPct: pnlPct,
        closedAt: pos.closedAt,
        paperExitedAt: pos.paperExitedAt,
      };
    }),
    summary: computeSummary(positions),
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
portfolioCommand.action(async function (this: Command, opts: { json?: boolean }) {
  await runPortfolioAction(async () => {
    const allOpts = this.optsWithGlobals();
    const isJson = opts.json || allOpts.json;

    const program = buildProgram();
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService;
        const positions = yield* db.getAllPositions();
        const prices = yield* latestPrices(db, positions);
        const walletBalanceUsd = yield* readCliWalletBalance();

        if (isJson) {
          console.log(JSON.stringify(toJsonOutput(positions, prices, walletBalanceUsd), null, 2));
          return;
        }

        console.log(formatPositionsList(positions, prices));
        console.log(formatSummary(computeSummaryWithEquity(positions, walletBalanceUsd)));
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
      const allOpts = this.optsWithGlobals();
      const isJson = opts.json || allOpts.json;

      const program = buildProgram();
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* DbService;
          const positions = yield* db.getAllPositions();
          const walletBalanceUsd = yield* readCliWalletBalance();
          const summary = computeSummaryWithEquity(positions, walletBalanceUsd);

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
      const allOpts = this.optsWithGlobals();
      const isJson = opts.json || allOpts.json;

      const program = buildProgram();
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* DbService;
          const positions = yield* db.getClosedPositions();

          if (isJson) {
            console.log(JSON.stringify(toHistoryJsonOutput(positions), null, 2));
            return;
          }

          console.log(formatHistoryList(positions));
        }).pipe(Effect.provide(program)),
      );
    });
  });

function latestPrices(
  db: DbApi,
  positions: ReadonlyArray<PositionRecord>,
): Effect.Effect<ReadonlyMap<string, number>, never, never> {
  return Effect.gen(function* () {
    const prices = new Map<string, number>();
    for (const pos of positions) {
      const price = yield* db
        .getLatestSnapshotPrice(pos.poolAddress)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (price != null) prices.set(pos.poolAddress, price);
    }
    return prices;
  });
}
