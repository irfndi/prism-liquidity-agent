/** @file Wash forensics: distinguish real volume from wash trading on
 * launch candidates using the Helius enhanced-API trade shape.
 *
 * Pure + unit-testable. The adapter fetches the pool's recent transaction
 * rows (feePayer per tx — DLMM swaps are not in Helius's parsed models, but
 * the fee payer survives) and this module scores them. The signals:
 *
 * - wallet concentration: few distinct fee payers across many trades is the
 *   classic wash signature (a bot moves its own volume through a handful of
 *   wallets; real mania shows a fat tail of distinct wallets)
 * - burst density: >5 trades/sec from ≤2 wallets is a bot burst, not a
 *   market
 * - fee uniformity: bots reuse fixed priority-fee configs (advisory only —
 *   a uniform fee alone proves nothing)
 *
 * Deliberately advisory-hard: `suspicious` is a STRONG signal (a real
 * launch's early volume is naturally concentrated, so only the extreme tail
 * rejects). Fetch/parse failures fail open to null upstream.
 */

export interface WashTradeRow {
  readonly payer: string;
  readonly timestamp: number;
  readonly feeLamports: number;
}

export interface WashEvidence {
  readonly tradeCount: number;
  readonly distinctPayers: number;
  /** Trades per second across the sample window (burst density). */
  readonly txsPerSecond: number;
  /** distinctPayers / tradeCount — 1.0 = every trade a different wallet. */
  readonly uniquePayerRate: number;
  /** Coefficient of variation of tx fees; null when the sample is too thin. */
  readonly feeCv: number | null;
  readonly suspicious: boolean;
  readonly reason: string | null;
}

/** Minimum sample before judging — fewer trades could be one honest burst. */
export const WASH_MIN_TRADES = 20;
/** ≤ this fraction of distinct payers across the sample = wash pattern. */
export const WASH_MAX_UNIQUE_PAYER_RATE = 0.15;
/** ≤ this many wallets producing the whole recent sample = wash pattern. */
export const WASH_MAX_DISTINCT_PAYERS = 2;
/** > this many trades/sec from ≤2 wallets = bot burst. */
export const WASH_MAX_TPS_FOR_BURST = 5;

export function scoreWashEvidence(rows: ReadonlyArray<WashTradeRow>): WashEvidence {
  const tradeCount = rows.length;
  const distinctPayers = new Set(rows.map((r) => r.payer)).size;
  const timestamps = rows.map((r) => r.timestamp);
  const spanSec =
    tradeCount >= 2 ? Math.max(1, Math.max(...timestamps) - Math.min(...timestamps)) : 0;
  const txsPerSecond = spanSec > 0 ? tradeCount / spanSec : 0;
  const uniquePayerRate = tradeCount > 0 ? distinctPayers / tradeCount : 0;

  const fees = rows.map((r) => r.feeLamports).filter((f) => f > 0);
  let feeCv: number | null = null;
  if (fees.length >= 3) {
    const mean = fees.reduce((s, f) => s + f, 0) / fees.length;
    const variance = fees.reduce((s, f) => s + (f - mean) * (f - mean), 0) / fees.length;
    feeCv = mean > 0 ? Math.sqrt(variance) / mean : null;
  }

  let suspicious = false;
  let reason: string | null = null;
  if (tradeCount >= WASH_MIN_TRADES && distinctPayers <= WASH_MAX_DISTINCT_PAYERS) {
    suspicious = true;
    reason = `${distinctPayers} wallet(s) produced ${tradeCount} recent trades — concentrated`;
  } else if (tradeCount >= WASH_MIN_TRADES && uniquePayerRate <= WASH_MAX_UNIQUE_PAYER_RATE) {
    suspicious = true;
    reason = `only ${(uniquePayerRate * 100).toFixed(0)}% distinct payers across ${tradeCount} trades — wash pattern`;
  } else if (distinctPayers <= WASH_MAX_DISTINCT_PAYERS && txsPerSecond >= WASH_MAX_TPS_FOR_BURST) {
    suspicious = true;
    reason = `${txsPerSecond.toFixed(1)} trades/sec from ${distinctPayers} wallet(s) — bot burst`;
  }

  return { tradeCount, distinctPayers, txsPerSecond, uniquePayerRate, feeCv, suspicious, reason };
}
