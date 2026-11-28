/**
 * Read-only per-rule / per-pool attribution over recorded decisions and the
 * closed-position ledger.
 *
 * The engine has always tagged decisions (`[fee-il-gate]`, `[drift-gate]`, …)
 * inside the human-readable reasoning string. This module turns that existing
 * vocabulary into a ledger: which rules co-fired on the ENTER for a position,
 * and what that position actually realized net of costs.
 *
 * Pure module (like regime-gate.ts / fee-capture.ts): no Effect services, no
 * I/O, deterministic output. The CLI supplies rows from SQLite.
 *
 * Attribution model (deliberately conservative):
 * - A closed position is attributed to the latest ENTER decision on the same
 *   pool at or before the position's open time, within a lookback window.
 * - When several rules co-fire on that ENTER, each receives an EQUAL fractional
 *   share of the realized PnL — a trade is never counted twice across rules.
 * - `solo*` fields report the subset where exactly one rule fired, i.e. the
 *   uncontaminated evidence for that rule.
 * - Unpriced closes (`realized_pnl_usd` NULL) count toward `closes` but never
 *   toward PnL.
 */

/** Default window in which an ENTER audit row is considered the cause of a position. */
export const DEFAULT_ENTER_LOOKBACK_MS = 6 * 60 * 60 * 1000;

/** Clock skew tolerated between an audit timestamp and a position row. */
const CLOCK_SKEW_MS = 60_000;

/** Bracket tokens that are not rule ids (indexes, placeholders). */
const RULE_TAG_NOISE: ReadonlySet<string> = new Set(["i", "n", "x", "y", "unknown"]);

export interface AttributionDecision {
  readonly timestamp: number;
  readonly poolAddress: string;
  readonly action: string;
  readonly reasoning: string;
  readonly executed: boolean;
  /** `risk_result_json.reason` when the row carried one, else null. */
  readonly riskReason: string | null;
}

export interface AttributionPosition {
  readonly positionId: string;
  readonly poolAddress: string;
  /** Position open timestamp (ms epoch) — `positions.timestamp`. */
  readonly openedAt: number;
  readonly closedAt: number | null;
  readonly realizedPnlUsd: number | null;
  readonly depositedUsd: number;
  readonly tokenXSymbol: string | null;
  readonly tokenYSymbol: string | null;
}

export interface RuleAttributionRow {
  readonly ruleId: string;
  /** Closes where this rule co-fired on the ENTER (priced or not). */
  readonly closes: number;
  readonly pricedCloses: number;
  readonly wins: number;
  readonly losses: number;
  readonly winRate: number | null;
  /** Fractional credit: `realized / coFiringRules` summed over closes. */
  readonly creditedPnlUsd: number;
  readonly avgCreditedPnlUsd: number | null;
  /** Closes where this rule was the ONLY rule on the ENTER. */
  readonly soloCloses: number;
  readonly soloNetPnlUsd: number;
  readonly soloWinRate: number | null;
}

export interface PoolAttributionRow {
  readonly poolAddress: string;
  readonly tokenXSymbol: string | null;
  readonly tokenYSymbol: string | null;
  readonly closes: number;
  readonly pricedCloses: number;
  readonly netPnlUsd: number;
  readonly winRate: number | null;
  readonly avgHoldDays: number | null;
  readonly avgDepositedUsd: number | null;
}

export interface RejectionRow {
  readonly action: string;
  readonly ruleId: string;
  readonly count: number;
}

export interface RuleAttributionReport {
  readonly generatedAt: number;
  /** 0 = all history. */
  readonly windowMs: number;
  readonly enterLookbackMs: number;
  readonly decisionsConsidered: number;
  readonly closes: number;
  readonly pricedCloses: number;
  readonly untaggedCloses: number;
  readonly unattributedCloses: number;
  readonly netPnlUsd: number;
  readonly winRate: number | null;
  readonly profitFactor: number | null;
  readonly rules: readonly RuleAttributionRow[];
  readonly pools: readonly PoolAttributionRow[];
  readonly rejections: readonly RejectionRow[];
}

interface RuleAccumulator {
  closes: number;
  pricedCloses: number;
  wins: number;
  losses: number;
  creditedPnlUsd: number;
  soloCloses: number;
  soloNetPnlUsd: number;
  soloWins: number;
  soloLosses: number;
}

interface PoolAccumulator {
  tokenXSymbol: string | null;
  tokenYSymbol: string | null;
  closes: number;
  pricedCloses: number;
  netPnlUsd: number;
  wins: number;
  losses: number;
  holdMsTotal: number;
  depositedTotal: number;
  depositedCount: number;
}

interface Totals {
  untaggedCloses: number;
  unattributedCloses: number;
  pricedCloses: number;
  wins: number;
  losses: number;
  netPnlUsd: number;
  grossProfitUsd: number;
  grossLossUsd: number;
}

interface CloseAttribution {
  readonly attributed: boolean;
  readonly tagged: boolean;
  readonly tags: readonly string[];
}

function emptyTotals(): Totals {
  return {
    untaggedCloses: 0,
    unattributedCloses: 0,
    pricedCloses: 0,
    wins: 0,
    losses: 0,
    netPnlUsd: 0,
    grossProfitUsd: 0,
    grossLossUsd: 0,
  };
}

function finiteOrNull(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : null;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/**
 * Extract deduplicated rule tags from a reasoning/risk-reason string.
 * `[fee-il-gate] Fee/IL 1.1 < 1.2` → `["fee-il-gate"]`.
 */
export function extractRuleTags(text: string | null | undefined): readonly string[] {
  if (text === null || text === undefined || text.length === 0) return [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/\[([^\]\n]{1,64})\]/g)) {
    const raw = match[1]?.trim().toLowerCase();
    if (raw === undefined || raw.length < 3) continue;
    if (!/^[a-z][a-z0-9-]*$/.test(raw)) continue;
    if (RULE_TAG_NOISE.has(raw)) continue;
    seen.add(raw);
  }
  return [...seen];
}

function emptyRule(): RuleAccumulator {
  return {
    closes: 0,
    pricedCloses: 0,
    wins: 0,
    losses: 0,
    creditedPnlUsd: 0,
    soloCloses: 0,
    soloNetPnlUsd: 0,
    soloWins: 0,
    soloLosses: 0,
  };
}

function emptyPool(close: AttributionPosition): PoolAccumulator {
  return {
    tokenXSymbol: close.tokenXSymbol,
    tokenYSymbol: close.tokenYSymbol,
    closes: 0,
    pricedCloses: 0,
    netPnlUsd: 0,
    wins: 0,
    losses: 0,
    holdMsTotal: 0,
    depositedTotal: 0,
    depositedCount: 0,
  };
}

function recordIssued(
  acc: RuleAccumulator,
  realized: number | null,
  creditShare: number,
  solo: boolean,
): void {
  acc.closes += 1;
  if (solo) acc.soloCloses += 1;
  if (realized === null) return;

  acc.pricedCloses += 1;
  acc.creditedPnlUsd += realized * creditShare;
  if (solo) acc.soloNetPnlUsd += realized;
  if (realized > 0) {
    acc.wins += 1;
    if (solo) acc.soloWins += 1;
  } else if (realized < 0) {
    acc.losses += 1;
    if (solo) acc.soloLosses += 1;
  }
}

/** Latest ENTER at or before `openedAt`, or null when outside the lookback. */
function findAttributionEnter(
  poolDecisions: readonly AttributionDecision[] | undefined,
  openedAt: number,
  lookbackMs: number,
): AttributionDecision | null {
  if (poolDecisions === undefined || !Number.isFinite(openedAt)) return null;
  for (const decision of poolDecisions) {
    if (decision.timestamp > openedAt + CLOCK_SKEW_MS) continue;
    if (openedAt - decision.timestamp > lookbackMs) return null;
    return decision;
  }
  return null;
}

function indexEnters(
  decisions: readonly AttributionDecision[],
): ReadonlyMap<string, readonly AttributionDecision[]> {
  const byPool = new Map<string, AttributionDecision[]>();
  for (const decision of decisions) {
    // Only an EXECUTED enter created the position being attributed. A rejected
    // or shadow-skipped ENTER is recorded in the same window and would
    // otherwise be credited with a later close's PnL.
    if (decision.action !== "ENTER" || decision.executed !== true) continue;
    const bucket = byPool.get(decision.poolAddress);
    if (bucket === undefined) {
      byPool.set(decision.poolAddress, [decision]);
    } else {
      bucket.push(decision);
    }
  }
  for (const bucket of byPool.values()) {
    bucket.sort((a, b) => b.timestamp - a.timestamp);
  }
  return byPool;
}

function collectRejections(
  decisions: readonly AttributionDecision[],
): ReadonlyMap<string, RejectionRow> {
  const rejections = new Map<string, RejectionRow>();
  for (const decision of decisions) {
    if (decision.executed) continue;
    const tags = new Set([
      ...extractRuleTags(decision.reasoning),
      ...extractRuleTags(decision.riskReason),
    ]);
    for (const ruleId of tags) {
      const key = `${decision.action}\u0000${ruleId}`;
      const existing = rejections.get(key);
      rejections.set(key, {
        action: decision.action,
        ruleId,
        count: (existing?.count ?? 0) + 1,
      });
    }
  }
  return rejections;
}

function resolveCloseAttribution(
  close: AttributionPosition,
  enters: ReadonlyMap<string, readonly AttributionDecision[]>,
  lookbackMs: number,
): CloseAttribution {
  const enter = findAttributionEnter(enters.get(close.poolAddress), close.openedAt, lookbackMs);
  if (enter === null) return { attributed: false, tagged: false, tags: [] };
  const tags = extractRuleTags(enter.reasoning);
  return { attributed: true, tagged: tags.length > 0, tags };
}

function applyCloseToPool(acc: PoolAccumulator, close: AttributionPosition): void {
  acc.closes += 1;
  if (Number.isFinite(close.depositedUsd) && close.depositedUsd > 0) {
    acc.depositedTotal += close.depositedUsd;
    acc.depositedCount += 1;
  }
  if (close.closedAt !== null && Number.isFinite(close.openedAt)) {
    const holdMs = close.closedAt - close.openedAt;
    if (holdMs > 0) acc.holdMsTotal += holdMs;
  }
}

function applyRealized(realized: number | null, totals: Totals, poolAcc: PoolAccumulator): void {
  if (realized === null) return;
  totals.pricedCloses += 1;
  totals.netPnlUsd += realized;
  poolAcc.pricedCloses += 1;
  poolAcc.netPnlUsd += realized;
  if (realized > 0) {
    totals.wins += 1;
    totals.grossProfitUsd += realized;
    poolAcc.wins += 1;
  } else if (realized < 0) {
    totals.losses += 1;
    totals.grossLossUsd += Math.abs(realized);
    poolAcc.losses += 1;
  }
}

function creditRules(
  tags: readonly string[],
  realized: number | null,
  rules: Map<string, RuleAccumulator>,
): void {
  const creditShare = 1 / tags.length;
  const solo = tags.length === 1;
  for (const ruleId of tags) {
    const existing = rules.get(ruleId);
    if (existing === undefined) {
      const created = emptyRule();
      rules.set(ruleId, created);
      recordIssued(created, realized, creditShare, solo);
    } else {
      recordIssued(existing, realized, creditShare, solo);
    }
  }
}

function toRuleRows(rules: ReadonlyMap<string, RuleAccumulator>): readonly RuleAttributionRow[] {
  const rows: RuleAttributionRow[] = [];
  for (const [ruleId, acc] of rules) {
    rows.push({
      ruleId,
      closes: acc.closes,
      pricedCloses: acc.pricedCloses,
      wins: acc.wins,
      losses: acc.losses,
      winRate: ratio(acc.wins, acc.wins + acc.losses),
      creditedPnlUsd: acc.creditedPnlUsd,
      avgCreditedPnlUsd: ratio(acc.creditedPnlUsd, acc.pricedCloses),
      soloCloses: acc.soloCloses,
      soloNetPnlUsd: acc.soloNetPnlUsd,
      soloWinRate: ratio(acc.soloWins, acc.soloWins + acc.soloLosses),
    });
  }
  return rows.sort(
    (a, b) => a.creditedPnlUsd - b.creditedPnlUsd || a.ruleId.localeCompare(b.ruleId),
  );
}

function toPoolRows(pools: ReadonlyMap<string, PoolAccumulator>): readonly PoolAttributionRow[] {
  const rows: PoolAttributionRow[] = [];
  for (const [poolAddress, acc] of pools) {
    rows.push({
      poolAddress,
      tokenXSymbol: acc.tokenXSymbol,
      tokenYSymbol: acc.tokenYSymbol,
      closes: acc.closes,
      pricedCloses: acc.pricedCloses,
      netPnlUsd: acc.netPnlUsd,
      winRate: ratio(acc.wins, acc.wins + acc.losses),
      avgHoldDays: acc.closes > 0 ? acc.holdMsTotal / acc.closes / 86_400_000 : null,
      avgDepositedUsd: ratio(acc.depositedTotal, acc.depositedCount),
    });
  }
  return rows.sort(
    (a, b) => a.netPnlUsd - b.netPnlUsd || a.poolAddress.localeCompare(b.poolAddress),
  );
}

export function buildRuleAttribution(input: {
  readonly decisions: readonly AttributionDecision[];
  readonly positions: readonly AttributionPosition[];
  readonly now?: number;
  /** 0 (default) = all history. */
  readonly windowMs?: number;
  readonly enterLookbackMs?: number;
}): RuleAttributionReport {
  const now = input.now ?? Date.now();
  const windowMs = input.windowMs ?? 0;
  const enterLookbackMs = input.enterLookbackMs ?? DEFAULT_ENTER_LOOKBACK_MS;
  const cutoff = windowMs > 0 ? now - windowMs : Number.NEGATIVE_INFINITY;

  const decisions = input.decisions.filter((decision) => decision.timestamp >= cutoff);
  const closes = input.positions.filter(
    (position) => position.closedAt !== null && position.closedAt >= cutoff,
  );

  const enters = indexEnters(decisions);
  const rejections = collectRejections(decisions);
  const rules = new Map<string, RuleAccumulator>();
  const pools = new Map<string, PoolAccumulator>();
  const totals = emptyTotals();

  for (const close of closes) {
    const poolAcc = pools.get(close.poolAddress) ?? emptyPool(close);
    pools.set(close.poolAddress, poolAcc);
    applyCloseToPool(poolAcc, close);

    const realized = finiteOrNull(close.realizedPnlUsd);
    applyRealized(realized, totals, poolAcc);

    const attribution = resolveCloseAttribution(close, enters, enterLookbackMs);
    if (!attribution.attributed) {
      totals.unattributedCloses += 1;
    } else if (!attribution.tagged) {
      totals.untaggedCloses += 1;
    } else {
      creditRules(attribution.tags, realized, rules);
    }
  }

  return {
    generatedAt: now,
    windowMs,
    enterLookbackMs,
    decisionsConsidered: decisions.length,
    closes: closes.length,
    pricedCloses: totals.pricedCloses,
    untaggedCloses: totals.untaggedCloses,
    unattributedCloses: totals.unattributedCloses,
    netPnlUsd: totals.netPnlUsd,
    winRate: ratio(totals.wins, totals.wins + totals.losses),
    profitFactor: totals.grossLossUsd > 0 ? totals.grossProfitUsd / totals.grossLossUsd : null,
    rules: toRuleRows(rules),
    pools: toPoolRows(pools),
    rejections: [...rejections.values()].sort(
      (a, b) =>
        b.count - a.count || a.action.localeCompare(b.action) || a.ruleId.localeCompare(b.ruleId),
    ),
  };
}
