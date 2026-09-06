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
const DAY_MS = 24 * 60 * 60 * 1000;

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
  const adapterLayer = Layer.provide(AdapterLive, Layer.merge(ConfigLive, dbLayer));
  return Layer.mergeAll(dbLayer, adapterLayer);
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
          // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
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

export interface PnlResult {
  readonly pnlUsd: number;
  readonly pnlPct: number;
}

export function computePnl(depositedUsd: number, currentValueUsd: number): PnlResult {
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

interface ClosedPnlResult {
  readonly pnlUsd: number | null;
  readonly pnlPct: number | null;
}

function realizedPnlFor(pos: PositionRecord): ClosedPnlResult {
  if (pos.realizedPnlUsd == null || !Number.isFinite(pos.realizedPnlUsd)) {
    return { pnlUsd: null, pnlPct: null };
  }
  const pnlPct = pos.depositedUsd > 0 ? (pos.realizedPnlUsd / pos.depositedUsd) * 100 : 0;
  return { pnlUsd: pos.realizedPnlUsd, pnlPct };
}

// ─── Closed-trade evidence (net expectancy, profit factor, drawdown, exit
// reasons, entry cohorts) ────────────────────────────────────────────────────
// Win rate alone misleads (a 41% win rate can still net positive with a
// better avg-win/avg-loss ratio). These pure functions read the closed
// ledger + position events so paper staging and production report the same
// evidence shape before any strategy change is promoted.

/**
 * First `[bracket]` tag of an EXIT reasoning string, or the known untagged
 * EXIT shape it opens with (several deterministic exits predate bracket
 * tags — staging's first close recorded "High volatility ..." verbatim).
 * "unknown" only when neither matches (genuinely unclassifiable rows).
 */
export function exitReasonTag(reason: string | null | undefined): string {
  if (reason == null) return "unknown";
  const match = reason.match(/\[([^\]]+)\]/);
  if (match?.[1] != null && match[1].length > 0) return match[1];
  for (const [prefix, tag] of UNTAGGED_EXIT_REASONS) {
    if (reason.startsWith(prefix)) return tag;
  }
  return "unknown";
}

/** Untagged deterministic-EXIT reasoning prefixes, longest first. */
const UNTAGGED_EXIT_REASONS: ReadonlyArray<readonly [string, string]> = [
  ["High volatility", "volatility"],
  ["Trailing stop", "trailing-stop"],
  ["IL dominance", "il-dominance"],
  ["TVL dropped", "tvl-drop"],
  ["Volume authenticity", "volume-authenticity"],
  ["Fee/IL ratio", "fee-il"],
  ["Rotation:", "rotation"],
];

/** Entry evidence from an ENTER event's metadata JSON (ladder leg + pair id). */
export interface EnterEvidence {
  readonly cohort: string;
  readonly pairId: string | null;
}

/** Split-vs-single cohort from an ENTER event's metadata JSON (ladder leg or single). */
export function enterCohortLabel(metadataJson: string | null | undefined): string {
  return enterEvidenceFromMetadata(metadataJson).cohort;
}

/** Cohort + pair id from an ENTER event's metadata JSON ("unknown"/null on legacy rows). */
export function enterEvidenceFromMetadata(metadataJson: string | null | undefined): EnterEvidence {
  if (metadataJson == null) return { cohort: "unknown", pairId: null };
  try {
    // SAFETY: position-event metadata is written by the engine's ENTER path as a JSON object; the shape is re-validated below before use.
    const metadata = JSON.parse(metadataJson) as { ladder?: unknown; pairId?: unknown };
    const cohort =
      metadata.ladder === "tight" || metadata.ladder === "wide" ? metadata.ladder : "single";
    // SAFETY: the toString tag check establishes the asserted primitive type before this operation.
    const pairId =
      Object.prototype.toString.call(metadata.pairId) === "[object String]"
        ? (metadata.pairId as string)
        : null;
    return { cohort, pairId };
  } catch {
    return { cohort: "unknown", pairId: null };
  }
}

/** Exit reason from an EXIT event's metadata JSON (absent on legacy rows). */
export function exitReasonFromMetadata(metadataJson: string | null | undefined): string {
  if (metadataJson == null) return "unknown";
  try {
    // SAFETY: position-event metadata is written by the engine's EXIT path as a JSON object; the field is re-validated below before use.
    const metadata = JSON.parse(metadataJson) as { exitReason?: unknown };
    const reason = metadata.exitReason;
    // SAFETY: the toString tag check establishes the asserted primitive type before this operation.
    return Object.prototype.toString.call(reason) === "[object String]"
      ? exitReasonTag(reason as string)
      : "unknown";
  } catch {
    return "unknown";
  }
}

export interface ClosedTradeStats {
  /** Number of closed rows with a finite realized outcome. */
  readonly count: number;
  /** Number of rows in the closed-position ledger. */
  readonly totalRows: number;
  /** Closed rows whose realized outcome is unknown/unpriced. */
  readonly missingOutcomes: number;
  readonly wins: number;
  readonly losses: number;
  readonly winRatePct: number | null;
  /** Net realized PnL across priced rows; null when none are priced. */
  readonly netPnlUsd: number | null;
  /** Mean realized PnL per priced closed trade (null when no closes). */
  readonly expectancyUsd: number | null;
  readonly avgWinUsd: number | null;
  readonly avgLossUsd: number | null;
  /** Gross wins / gross losses; null when there are no losses (never divide by zero). */
  readonly profitFactor: number | null;
  /** Peak-to-trough decline; null when no realized outcome is priced. */
  readonly maxDrawdownUsd: number | null;
}

/**
 * Closed-trade statistics over realized PnL (recorded value; rows with NULL
 * realized — unpriced exits — are SKIPPED, never booked as 0, so an
 * unpriceable close cannot masquerade as breakeven).
 */
export function computeClosedTradeStats(
  positions: ReadonlyArray<Pick<PositionRecord, "realizedPnlUsd" | "closedAt" | "paperExitedAt">>,
): ClosedTradeStats {
  const closes = positions.filter(
    (p): p is typeof p & { realizedPnlUsd: number } =>
      p.realizedPnlUsd !== null && Number.isFinite(p.realizedPnlUsd),
  );
  const totalRows = positions.length;
  const missingOutcomes = totalRows - closes.length;
  if (closes.length === 0) {
    return {
      count: 0,
      totalRows,
      missingOutcomes,
      wins: 0,
      losses: 0,
      winRatePct: null,
      netPnlUsd: null,
      expectancyUsd: null,
      avgWinUsd: null,
      avgLossUsd: null,
      profitFactor: null,
      maxDrawdownUsd: null,
    };
  }
  const pnls = closes.map((p) => p.realizedPnlUsd);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const grossWin = wins.reduce((sum, p) => sum + p, 0);
  const grossLoss = losses.reduce((sum, p) => sum + p, 0);
  const netPnlUsd = pnls.reduce((sum, p) => sum + p, 0);
  const ordered = [...closes].sort(
    (a, b) => (a.closedAt ?? a.paperExitedAt ?? 0) - (b.closedAt ?? b.paperExitedAt ?? 0),
  );
  let peak = 0;
  let running = 0;
  let maxDrawdownUsd = 0;
  for (const pos of ordered) {
    running += pos.realizedPnlUsd;
    if (running > peak) peak = running;
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - running);
  }
  return {
    count: closes.length,
    totalRows,
    missingOutcomes,
    wins: wins.length,
    losses: losses.length,
    winRatePct: (wins.length / closes.length) * 100,
    netPnlUsd,
    expectancyUsd: netPnlUsd / closes.length,
    avgWinUsd: wins.length > 0 ? grossWin / wins.length : null,
    avgLossUsd: losses.length > 0 ? grossLoss / losses.length : null,
    profitFactor: grossLoss < 0 ? grossWin / Math.abs(grossLoss) : null,
    maxDrawdownUsd,
  };
}

/**
 * One closed-trade unit for the split-vs-single comparison: a ladder pair
 * (tight+wide legs sharing a pairId — one $10+$10 split unit) or a lone
 * position. Dollar averages mislead across sizes ($10 legs vs $20 singles),
 * so every unit reports capital-normalized expectancyPct (net / deployed).
 */
export interface ClosedTradeUnit {
  readonly unitId: string;
  /** "split" for a paired tight+wide unit, else the leg cohort (or "unknown"). */
  readonly kind: string;
  readonly legs: number;
  readonly deployedUsd: number;
  /** Net PnL is null until every expected leg has a priced outcome. */
  readonly netPnlUsd: number | null;
  /** Net return on deployed capital, percent (null when incomplete or undeployed). */
  readonly expectancyPct: number | null;
  /** False for a partial pair or any unit with an unknown outcome. */
  readonly complete: boolean;
  /** Expected leg outcomes that are missing or unpriced. */
  readonly missingOutcomes: number;
  /** Maximum leg exposure duration, null until the unit is complete. */
  readonly exposureTimeDays: number | null;
}

function closedTradeUnitKey(
  pos: PositionRecord,
  enterByPositionId: ReadonlyMap<string, EnterEvidence>,
): string {
  const pairId = enterByPositionId.get(pos.positionId)?.pairId;
  return pairId != null && pairId !== pos.positionId ? pairId : pos.positionId;
}

function closedTradeUnitIsPair(
  unitId: string,
  legs: ReadonlyArray<PositionRecord>,
  enterByPositionId: ReadonlyMap<string, EnterEvidence>,
): boolean {
  return legs.some((leg) => {
    const pairId = enterByPositionId.get(leg.positionId)?.pairId;
    return pairId === unitId && pairId !== leg.positionId;
  });
}

function closedTradeUnitExposureTimeDays(legs: ReadonlyArray<PositionRecord>): number | null {
  let maxAgeMs = 0;
  for (const leg of legs) {
    const exitedAt = leg.closedAt ?? leg.paperExitedAt;
    if (
      exitedAt == null ||
      !Number.isFinite(exitedAt) ||
      !Number.isFinite(leg.timestamp) ||
      exitedAt < leg.timestamp
    ) {
      return null;
    }
    maxAgeMs = Math.max(maxAgeMs, exitedAt - leg.timestamp);
  }
  return maxAgeMs / DAY_MS;
}

function hasKnownClosedPnl(
  pos: PositionRecord,
): pos is PositionRecord & { realizedPnlUsd: number } {
  return pos.realizedPnlUsd !== null && Number.isFinite(pos.realizedPnlUsd);
}

function closedTradeUnitHasExpectedLegs(
  legs: ReadonlyArray<PositionRecord>,
  cohorts: ReadonlySet<string>,
  paired: boolean,
): boolean {
  if (!paired) return legs.length === 1;
  return legs.length === 2 && cohorts.has("tight") && cohorts.has("wide");
}

function closedTradeUnitPnl(
  priced: ReadonlyArray<PositionRecord & { realizedPnlUsd: number }>,
  complete: boolean,
  deployedUsd: number,
) {
  if (!complete) return { netPnlUsd: null, expectancyPct: null };
  const netPnlUsd = priced.reduce((sum, leg) => sum + leg.realizedPnlUsd, 0);
  return {
    netPnlUsd,
    expectancyPct: deployedUsd > 0 ? (netPnlUsd / deployedUsd) * 100 : null,
  };
}

function buildClosedTradeUnit(
  unitId: string,
  legs: ReadonlyArray<PositionRecord>,
  enterByPositionId: ReadonlyMap<string, EnterEvidence>,
): ClosedTradeUnit {
  const paired = closedTradeUnitIsPair(unitId, legs, enterByPositionId);
  const cohorts = new Set(
    legs.map((leg) => enterByPositionId.get(leg.positionId)?.cohort ?? "unknown"),
  );
  const priced = legs.filter(hasKnownClosedPnl);
  const deployedUsd = legs.reduce(
    (sum, leg) => (Number.isFinite(leg.depositedUsd) ? sum + leg.depositedUsd : sum),
    0,
  );
  const expectedLegs = paired ? 2 : 1;
  const complete =
    closedTradeUnitHasExpectedLegs(legs, cohorts, paired) && priced.length === legs.length;
  const pnl = closedTradeUnitPnl(priced, complete, deployedUsd);
  return {
    unitId,
    kind: paired ? "split" : ([...cohorts][0] ?? "unknown"),
    legs: legs.length,
    deployedUsd,
    ...pnl,
    complete,
    missingOutcomes: Math.max(expectedLegs - priced.length, 0),
    exposureTimeDays: complete ? closedTradeUnitExposureTimeDays(legs) : null,
  };
}

/**
 * Group closed positions into paired units (pairId from the ENTER event;
 * legacy rows without one stand alone). Units with NULL realized outcomes are
 * explicitly incomplete and expose null PnL/expectancy instead of treating an
 * unpriced exit as breakeven.
 */
export function groupClosedTradeUnits(
  positions: ReadonlyArray<PositionRecord>,
  enterByPositionId: ReadonlyMap<string, EnterEvidence>,
): ReadonlyArray<ClosedTradeUnit> {
  const legsByUnit = new Map<string, PositionRecord[]>();
  for (const pos of positions) {
    const key = closedTradeUnitKey(pos, enterByPositionId);
    const legs = legsByUnit.get(key) ?? [];
    legs.push(pos);
    legsByUnit.set(key, legs);
  }
  const units: ClosedTradeUnit[] = [];
  for (const [unitId, legs] of legsByUnit) {
    units.push(buildClosedTradeUnit(unitId, legs, enterByPositionId));
  }
  return units.sort((a, b) => a.unitId.localeCompare(b.unitId));
}

export interface HistoryEvidenceContext {
  readonly enterByPositionId?: ReadonlyMap<string, EnterEvidence>;
  readonly exitReasonByPositionId?: ReadonlyMap<string, string>;
}
function formatStatsLine(stats: ClosedTradeStats): string {
  const winRate = stats.winRatePct != null ? `${stats.winRatePct.toFixed(1)}%` : "n/a";
  const expectancy = stats.expectancyUsd != null ? formatCurrency(stats.expectancyUsd) : "n/a";
  const profitFactor = stats.profitFactor != null ? stats.profitFactor.toFixed(3) : "n/a";
  const net = stats.netPnlUsd != null ? formatCurrency(stats.netPnlUsd) : "n/a";
  const maxDrawdown = stats.maxDrawdownUsd != null ? formatCurrency(stats.maxDrawdownUsd) : "n/a";
  return [
    `Closed: ${stats.count}/${stats.totalRows} priced (unknown ${stats.missingOutcomes}; W ${stats.wins} / L ${stats.losses}, win rate ${winRate})`,
    `Net: ${net}, expectancy/trade: ${expectancy}`,
    `Profit factor: ${profitFactor}, max drawdown: ${maxDrawdown}`,
  ].join("\n  ");
}
function formatHistoryList(
  positions: ReadonlyArray<PositionRecord>,
  evidence: HistoryEvidenceContext = {},
): string {
  if (positions.length === 0) {
    return "No exited positions.\n";
  }

  const lines: string[] = [];
  lines.push(`Exited Positions (${positions.length})`);
  lines.push("=".repeat(40));

  for (const pos of positions) {
    lines.push(...formatClosedPosition(pos, evidence));
  }

  lines.push("Closed-trade evidence");
  lines.push("-".repeat(40));
  lines.push(...formatEvidenceTail(positions, evidence));
  lines.push("");

  return lines.join("\n");
}

/** One closed position block (identity, cohort, exit reason, realized PnL). */
function formatClosedPosition(pos: PositionRecord, evidence: HistoryEvidenceContext): string[] {
  const { pnlUsd, pnlPct } = realizedPnlFor(pos);
  const pnlText =
    pnlUsd != null && pnlPct != null ? `${formatCurrency(pnlUsd)} (${formatPct(pnlPct)})` : "n/a";
  const coloredPnl =
    pnlUsd != null ? colorize(pnlText, pnlUsd >= 0 ? "\x1b[32m" : "\x1b[31m") : pnlText;
  const exitedAt = pos.closedAt ?? pos.paperExitedAt;
  const lines = [
    `  ${sanitizeSymbol(pos.tokenXSymbol)}/${sanitizeSymbol(pos.tokenYSymbol)}`,
    `    Pool:       ${pos.poolAddress}`,
    `    Position:   ${pos.positionId}`,
  ];
  lines.push(...formatClosedPositionEvidence(pos, evidence));
  lines.push(
    `    Deposited:  ${formatCurrency(pos.depositedUsd)}`,
    `    Exit Value: ${formatCurrency(pos.currentValueUsd)}`,
    `    Fees:       ${formatCurrency(pos.cumulativeFeesClaimedUsd)}`,
  );
  if (pos.cumulativeRewardsClaimedUsd > 0) {
    lines.push(`    Rewards:    ${formatCurrency(pos.cumulativeRewardsClaimedUsd)}`);
  }
  lines.push(
    `    Realized P&L: ${coloredPnl}`,
    `    Exited:     ${exitedAt != null ? new Date(exitedAt).toISOString() : "N/A"}`,
    "",
  );
  return lines;
}

/** Evidence tail: overall stats plus unit and exit-reason breakdowns. */
function formatEvidenceTail(
  positions: ReadonlyArray<PositionRecord>,
  evidence: HistoryEvidenceContext,
): string[] {
  const lines = [
    `  ${formatStatsLine(computeClosedTradeStats(positions)).replaceAll("\n", "\n  ")}`,
  ];

  if (evidence.enterByPositionId !== undefined) {
    lines.push("  By unit (split-vs-single at equal capital: compare expectancy %)");
    for (const unit of groupClosedTradeUnits(positions, evidence.enterByPositionId)) {
      lines.push(`    ${formatUnitLine(unit)}`);
    }
  }
  if (evidence.exitReasonByPositionId !== undefined) {
    lines.push(...formatExitReasonLines(positions, evidence.exitReasonByPositionId));
  }
  return lines;
}
/** Cohort/pair/exit-reason evidence lines for one closed position. */
function formatClosedPositionEvidence(
  pos: PositionRecord,
  evidence: HistoryEvidenceContext,
): string[] {
  const lines: string[] = [];
  const enter = evidence.enterByPositionId?.get(pos.positionId);
  if (enter !== undefined) {
    lines.push(`    Cohort:     ${enter.cohort}`);
    if (enter.pairId !== null && enter.pairId !== pos.positionId) {
      lines.push(`    Pair:       ${enter.pairId}`);
    }
  }
  const exitReason = evidence.exitReasonByPositionId?.get(pos.positionId);
  if (exitReason !== undefined) lines.push(`    Exit:       ${exitReason}`);
  return lines;
}

/** One unit summary line (legs, deployed, net, capital-normalized expectancy). */
function formatUnitLine(unit: ClosedTradeUnit): string {
  const net = unit.netPnlUsd != null ? formatCurrency(unit.netPnlUsd) : "n/a";
  const expectancy = unit.expectancyPct != null ? `${unit.expectancyPct.toFixed(2)}%` : "n/a";
  const exposure = unit.exposureTimeDays != null ? `${unit.exposureTimeDays.toFixed(2)}d` : "n/a";
  const status = unit.complete ? "complete" : `incomplete (missing ${unit.missingOutcomes})`;
  return `${unit.kind}: ${status}, legs=${unit.legs}, deployed ${formatCurrency(unit.deployedUsd)}, net ${net}, expectancy ${expectancy}, exposure ${exposure}`;
}

/** Exit-reason breakdown lines (net per reason tag, alphabetical). */
function formatExitReasonLines(
  positions: ReadonlyArray<PositionRecord>,
  exitReasonByPositionId: ReadonlyMap<string, string>,
): string[] {
  const byReason = new Map<string, PositionRecord[]>();
  for (const pos of positions) {
    const reason = exitReasonByPositionId.get(pos.positionId) ?? "unknown";
    const group = byReason.get(reason) ?? [];
    group.push(pos);
    byReason.set(reason, group);
  }
  const lines = ["  By exit reason"];
  const sorted = [...byReason.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [reason, group] of sorted) {
    const stats = computeClosedTradeStats(group);
    const net = stats.netPnlUsd != null ? formatCurrency(stats.netPnlUsd) : "n/a";
    lines.push(
      `    ${reason}: n=${stats.count}/${stats.totalRows} priced (unknown ${stats.missingOutcomes}), net ${net}`,
    );
  }
  return lines;
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
    realizedPnlUsd: number | null;
    realizedPnlPct: number | null;
    closedAt: number | null;
    paperExitedAt: number | null;
    cohort?: string;
    exitReason?: string;
  }>;
  summary: PortfolioSummary;
  stats: ClosedTradeStats;
  units?: ReadonlyArray<ClosedTradeUnit>;
}

export function toHistoryJsonOutput(
  positions: ReadonlyArray<PositionRecord>,
  evidence: HistoryEvidenceContext = {},
): HistoryJsonOutput {
  const output: HistoryJsonOutput = {
    positions: positions.map((pos) => historyPositionRow(pos, evidence)),
    summary: computeSummary(positions),
    stats: computeClosedTradeStats(positions),
  };
  if (evidence.enterByPositionId !== undefined) {
    output.units = groupClosedTradeUnits(positions, evidence.enterByPositionId);
  }
  return output;
}

/** One history row, with cohort/exit-reason evidence attached when known. */
function historyPositionRow(
  pos: PositionRecord,
  evidence: HistoryEvidenceContext,
): HistoryJsonOutput["positions"][number] {
  const { pnlUsd, pnlPct } = realizedPnlFor(pos);
  const row: HistoryJsonOutput["positions"][number] = {
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
  const enter = evidence.enterByPositionId?.get(pos.positionId);
  if (enter !== undefined) row.cohort = enter.cohort;
  const exitReason = evidence.exitReasonByPositionId?.get(pos.positionId);
  if (exitReason !== undefined) row.exitReason = exitReason;
  return row;
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

/**
 * Join closed positions to their ENTER/EXIT events (one pass per pool,
 * fail-open per pool): entry cohort (tight/wide/single ladder leg) for the
 * split-vs-single comparison and exit-reason tags for the breakdown.
 */
function readHistoryEvidence(
  db: DbApi,
  positions: ReadonlyArray<PositionRecord>,
): Effect.Effect<HistoryEvidenceContext, never, never> {
  return Effect.gen(function* () {
    const enterByPositionId = new Map<string, EnterEvidence>();
    const exitReasonByPositionId = new Map<string, string>();
    for (const poolAddress of new Set(positions.map((p) => p.poolAddress))) {
      const events = yield* db
        .getPositionEvents(poolAddress)
        .pipe(Effect.catch(() => Effect.succeed([])));
      for (const e of events) {
        if (e.positionId == null) continue;
        if (e.event === "ENTER" && !enterByPositionId.has(e.positionId)) {
          enterByPositionId.set(e.positionId, enterEvidenceFromMetadata(e.metadata));
        }
        if (e.event === "EXIT" && !exitReasonByPositionId.has(e.positionId)) {
          exitReasonByPositionId.set(e.positionId, exitReasonFromMetadata(e.metadata));
        }
      }
    }
    return { enterByPositionId, exitReasonByPositionId };
  });
}

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
          const evidence = yield* readHistoryEvidence(db, positions);

          if (isJson) {
            console.log(JSON.stringify(toHistoryJsonOutput(positions, evidence), null, 2));
            return;
          }

          console.log(formatHistoryList(positions, evidence));
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
