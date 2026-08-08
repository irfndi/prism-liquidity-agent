import { Effect, Layer } from "effect";
import type { Database } from "bun:sqlite";
import { createDatabase, hasVecMemoryTable } from "./db.js";
import { getEmbedding } from "./embeddings.js";
import type {
  MemoryEntry,
  MemoryCategory,
  PoolSnapshot,
  BinArray,
  SignalSnapshot,
  SignalWeights,
  ExecutionOperationRecord,
  ExecutionOperationStatus,
  ExecutionOperationType,
  SafetyPauseRecord,
  SettlementAsset,
  SettlementJobRecord,
  SettlementJobStatus,
  TokenCandidateRecord,
  TokenCandidateState,
} from "./types.js";
import { DbService, type DbApi } from "./services.js";
import { bigintReplacer } from "./bigint-json.js";
import { randomUUID } from "crypto";
import { PersistenceContractError } from "./errors.js";

export interface PositionRecord {
  /**
   * Position identity and primary key: the on-chain position pubkey for live
   * positions, a stable synthetic `paper-<pool>-<uuid>` id for paper
   * positions (legacy migrated paper rows use `paper-<pool>`).
   */
  positionId: string;
  poolAddress: string;
  positionPubKey: string | null;
  depositedUsd: number;
  currentValueUsd: number;
  tokenXSymbol: string;
  tokenYSymbol: string;
  activeBinId: number;
  lowerBinId: number;
  upperBinId: number;
  timestamp: number;
  outOfRangeSince: number | null;
  oorCycleCount: number;
  lastFeeClaimAt: number;
  trailingStopThreshold: number | null;
  highestValueUsd: number | null;
  lastRebalanceAt: number;
  paperExitedAt: number | null;
  entrySignalTimestamp: number | null;
  entrySignalSnapshotId: number | null;
  entryPriceUsd: number | null;
  entryAmountXUsd: number | null;
  entryAmountYUsd: number | null;
  cumulativeFeesClaimedUsd: number;
  cumulativeRewardsClaimedUsd: number;
  closedAt: number | null;
  realizedPnlUsd: number | null;
  /** Fallen-angel position mode: "fallen-angel" when active, else null. */
  positionMode?: string | null;
  /** Serialized TP-ladder JSON (see engine/tp-ladder.ts); null for non-FA. */
  tpLadderJson?: string | null;
  /** Invalidation stop price; null for non-FA positions. */
  invalidationStopPrice?: number | null;
}

export type PositionEventType = "ENTER" | "EXIT" | "REBALANCE" | "CLAIM" | "COMPOUND";

export interface PositionEventRecord {
  id: string;
  poolAddress: string;
  positionPubKey: string | null;
  positionId: string | null;
  event: PositionEventType;
  valueUsd: number | null;
  feesUsd: number | null;
  price: number | null;
  metadata: string | null;
  createdAt: number;
}

export interface AuditRecord {
  id: string;
  timestamp: number;
  cycleId: string;
  poolAddress: string;
  action: string;
  confidence: number;
  reasoning: string;
  metricsJson: string | null;
  riskResultJson: string | null;
  executed: boolean;
  paperTrading: boolean;
  txSignature: string | null;
  error: string | null;
}

function queryOne<T>(db: Database, sql: string, ...params: unknown[]): T | null {
  return (db.query(sql) as unknown as { get(...p: unknown[]): T | null }).get(...params);
}

function queryAll<T>(db: Database, sql: string, ...params: unknown[]): T[] {
  return (db.query(sql) as unknown as { all(...p: unknown[]): T[] }).all(...params);
}

function runOne(db: Database, sql: string, ...params: unknown[]): void {
  (db.run as (sql: string, ...params: unknown[]) => void)(sql, ...params);
}

function isVecMemoryMissingError(e: unknown): boolean {
  return e instanceof Error && e.message.includes("no such table: vec_memory");
}

function serializeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

// BinArray.bins[].reserveX/reserveY/liquiditySupply are bigint; bigintReplacer
// in ./bigint-json.ts encodes them as decimal strings (readSnapshot reverses it).
function serializeBinArray(binArray: BinArray): string {
  return JSON.stringify(binArray, bigintReplacer);
}

function deserializeBinArray(json: string): BinArray {
  const raw = JSON.parse(json) as { bins: Array<Record<string, unknown>> };
  raw.bins = raw.bins.map((b) => ({
    binId: Number(b.binId),
    price: Number(b.price),
    reserveX: BigInt(String(b.reserveX)),
    reserveY: BigInt(String(b.reserveY)),
    liquiditySupply: BigInt(String(b.liquiditySupply)),
  }));
  return raw as unknown as BinArray;
}

export const DbLive = (dbPath?: string) =>
  Layer.effect(
    DbService,
    Effect.gen(function* () {
      const db = createDatabase(dbPath);

      const api: DbApi = {
        db,

        savePosition: (pos) =>
          Effect.sync(() => {
            runOne(
              db,
              `INSERT INTO positions (
              position_id, pool_address, position_pubkey, deposited_usd, current_value_usd,
              token_x_symbol, token_y_symbol, active_bin_id, lower_bin_id, upper_bin_id,
              timestamp, out_of_range_since, oor_cycle_count, last_fee_claim_at,
              trailing_stop_threshold, highest_value_usd, last_rebalance_at, paper_exited_at,
              entry_signal_timestamp,
              entry_signal_snapshot_id,
              entry_price_usd, entry_amount_x_usd, entry_amount_y_usd,
              cumulative_fees_claimed_usd, cumulative_rewards_claimed_usd,
              closed_at, realized_pnl_usd,
              position_mode, tp_ladder_json, invalidation_stop_price
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(position_id) DO UPDATE SET
              pool_address = excluded.pool_address,
              position_pubkey = COALESCE(excluded.position_pubkey, positions.position_pubkey),
              deposited_usd = excluded.deposited_usd,
              current_value_usd = excluded.current_value_usd,
              token_x_symbol = excluded.token_x_symbol,
              token_y_symbol = excluded.token_y_symbol,
              active_bin_id = excluded.active_bin_id,
              lower_bin_id = excluded.lower_bin_id,
              upper_bin_id = excluded.upper_bin_id,
              timestamp = excluded.timestamp,
              out_of_range_since = excluded.out_of_range_since,
              oor_cycle_count = excluded.oor_cycle_count,
              last_fee_claim_at = excluded.last_fee_claim_at,
              trailing_stop_threshold = excluded.trailing_stop_threshold,
              highest_value_usd = excluded.highest_value_usd,
              last_rebalance_at = excluded.last_rebalance_at,
              paper_exited_at = excluded.paper_exited_at,
              entry_signal_timestamp = excluded.entry_signal_timestamp,
              entry_signal_snapshot_id = excluded.entry_signal_snapshot_id,
              entry_price_usd = COALESCE(excluded.entry_price_usd, positions.entry_price_usd),
              entry_amount_x_usd = COALESCE(excluded.entry_amount_x_usd, positions.entry_amount_x_usd),
              entry_amount_y_usd = COALESCE(excluded.entry_amount_y_usd, positions.entry_amount_y_usd),
              cumulative_fees_claimed_usd = excluded.cumulative_fees_claimed_usd,
              cumulative_rewards_claimed_usd = excluded.cumulative_rewards_claimed_usd,
              closed_at = excluded.closed_at,
              realized_pnl_usd = excluded.realized_pnl_usd,
              position_mode = COALESCE(excluded.position_mode, positions.position_mode),
              tp_ladder_json = COALESCE(excluded.tp_ladder_json, positions.tp_ladder_json),
              invalidation_stop_price = COALESCE(
                excluded.invalidation_stop_price,
                positions.invalidation_stop_price
              )`,
              pos.positionId,
              pos.poolAddress,
              pos.positionPubKey,
              pos.depositedUsd,
              pos.currentValueUsd,
              pos.tokenXSymbol,
              pos.tokenYSymbol,
              pos.activeBinId,
              pos.lowerBinId,
              pos.upperBinId,
              pos.timestamp,
              pos.outOfRangeSince,
              pos.oorCycleCount,
              pos.lastFeeClaimAt,
              pos.trailingStopThreshold,
              pos.highestValueUsd,
              pos.lastRebalanceAt,
              pos.paperExitedAt,
              pos.entrySignalTimestamp,
              pos.entrySignalSnapshotId,
              pos.entryPriceUsd,
              pos.entryAmountXUsd,
              pos.entryAmountYUsd,
              pos.cumulativeFeesClaimedUsd,
              pos.cumulativeRewardsClaimedUsd,
              pos.closedAt,
              pos.realizedPnlUsd,
              pos.positionMode ?? null,
              pos.tpLadderJson ?? null,
              pos.invalidationStopPrice ?? null,
            );
          }),

        getPosition: (positionId) =>
          Effect.sync(() => {
            const row = queryOne<Record<string, unknown>>(
              db,
              "SELECT * FROM positions WHERE position_id = ?",
              positionId,
            );
            return row ? rowToPosition(row) : null;
          }),

        getAllPositions: () =>
          Effect.sync(() => {
            const rows = queryAll<Record<string, unknown>>(
              db,
              "SELECT * FROM positions WHERE paper_exited_at IS NULL AND closed_at IS NULL",
            );
            return rows.map(rowToPosition);
          }),

        getPaperExitedPositions: () =>
          Effect.sync(() => {
            const rows = queryAll<Record<string, unknown>>(
              db,
              "SELECT * FROM positions WHERE paper_exited_at IS NOT NULL ORDER BY paper_exited_at DESC",
            );
            return rows.map(rowToPosition);
          }),

        getClosedPositions: () =>
          Effect.sync(() => {
            const rows = queryAll<Record<string, unknown>>(
              db,
              `SELECT * FROM positions
               WHERE closed_at IS NOT NULL OR paper_exited_at IS NOT NULL
               ORDER BY COALESCE(closed_at, paper_exited_at) DESC`,
            );
            return rows.map(rowToPosition);
          }),

        deletePosition: (positionId) =>
          Effect.sync(() => {
            runOne(db, "DELETE FROM positions WHERE position_id = ?", positionId);
          }),

        markPaperExited: (positionId) =>
          Effect.sync(() => {
            runOne(
              db,
              "UPDATE positions SET paper_exited_at = ? WHERE position_id = ?",
              Date.now(),
              positionId,
            );
          }),

        closePosition: (positionId, realizedPnlUsd) =>
          Effect.sync(() => {
            runOne(
              db,
              "UPDATE positions SET closed_at = ?, realized_pnl_usd = ? WHERE position_id = ?",
              Date.now(),
              realizedPnlUsd,
              positionId,
            );
          }),

        finalizeSettlementGroup: (input) =>
          Effect.try({
            try: () => {
              db.transaction(() => {
                runOne(
                  db,
                  "UPDATE positions SET closed_at = ?, realized_pnl_usd = ? WHERE position_id = ?",
                  input.finalizedAt,
                  input.realizedPnlUsd,
                  input.positionId,
                );
                if (input.signalSnapshotId !== null && input.realizedPnlUsd !== null) {
                  runOne(
                    db,
                    "UPDATE signal_snapshots SET outcome_pnl_usd = ?, outcome_recorded_at = ? WHERE id = ?",
                    input.realizedPnlUsd,
                    input.finalizedAt,
                    input.signalSnapshotId,
                  );
                }
                for (const jobId of input.jobIds) {
                  runOne(
                    db,
                    "UPDATE settlement_jobs SET finalized_at = ?, realized_pnl_usd = ? WHERE id = ?",
                    input.finalizedAt,
                    input.realizedPnlUsd,
                    jobId,
                  );
                }
              })();
            },
            catch: (error) =>
              new Error(
                `finalizeSettlementGroup failed: ${error instanceof Error ? error.message : String(error)}`,
              ),
          }),

        savePositionEvent: (event) =>
          Effect.sync(() => {
            runOne(
              db,
              `INSERT INTO position_events (
                id, pool_address, position_pubkey, position_id, event,
                value_usd, fees_usd, price, metadata, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              event.id,
              event.poolAddress,
              event.positionPubKey,
              event.positionId,
              event.event,
              event.valueUsd,
              event.feesUsd,
              event.price,
              event.metadata != null ? serializeJson(event.metadata) : null,
              event.createdAt,
            );
          }),

        getPositionEvents: (poolAddress, limit) =>
          Effect.sync(() => {
            const rows = queryAll<Record<string, unknown>>(
              db,
              `SELECT * FROM position_events
               WHERE pool_address = ?
               ORDER BY created_at ASC, rowid ASC
               ${limit != null ? "LIMIT ?" : ""}`,
              ...(limit != null ? [poolAddress, limit] : [poolAddress]),
            );
            return rows.map(rowToPositionEvent);
          }),

        getLatestSnapshotPrice: (poolAddress) =>
          Effect.sync(() => {
            const row = queryOne<{ current_price: number }>(
              db,
              `SELECT current_price FROM pool_snapshots
               WHERE pool_address = ?
               ORDER BY timestamp DESC LIMIT 1`,
              poolAddress,
            );
            return row ? Number(row.current_price) : null;
          }),

        updatePositionValue: (positionId, currentValueUsd, highestValueUsd) =>
          Effect.sync(() => {
            if (highestValueUsd !== undefined) {
              runOne(
                db,
                "UPDATE positions SET current_value_usd = ?, highest_value_usd = ? WHERE position_id = ?",
                currentValueUsd,
                highestValueUsd,
                positionId,
              );
            } else {
              runOne(
                db,
                "UPDATE positions SET current_value_usd = ? WHERE position_id = ?",
                currentValueUsd,
                positionId,
              );
            }
          }),

        saveAudit: (record) =>
          Effect.sync(() => {
            runOne(
              db,
              `INSERT INTO audit (
              id, timestamp, cycle_id, pool_address, action, confidence, reasoning,
              metrics_json, risk_result_json, executed, paper_trading, tx_signature, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              record.id,
              record.timestamp,
              record.cycleId,
              record.poolAddress,
              record.action,
              record.confidence,
              record.reasoning,
              record.metricsJson,
              record.riskResultJson,
              record.executed ? 1 : 0,
              record.paperTrading ? 1 : 0,
              record.txSignature,
              record.error,
            );
          }),

        getRecentAudit: (limit) =>
          Effect.sync(() => {
            const rows = queryAll<Record<string, unknown>>(
              db,
              "SELECT * FROM audit ORDER BY timestamp DESC LIMIT ?",
              limit,
            );
            return rows.map(rowToAudit);
          }),

        cacheBlacklist: (type, values) =>
          Effect.sync(() => {
            db.transaction(() => {
              runOne(db, "DELETE FROM blacklists WHERE type = ?", type);
              for (const value of values) {
                runOne(
                  db,
                  "INSERT OR IGNORE INTO blacklists (type, value) VALUES (?, ?)",
                  type,
                  value,
                );
              }
            })();
          }),

        isBlacklisted: (type, value) =>
          Effect.sync(() => {
            const row = queryOne<Record<string, unknown>>(
              db,
              "SELECT 1 FROM blacklists WHERE type = ? AND value = ?",
              type,
              value,
            );
            return !!row;
          }),

        insertMemory: (entry) =>
          hasVecMemoryTable(db)
            ? Effect.catch(
                Effect.gen(function* () {
                  const id = randomUUID();
                  const now = Date.now();
                  const expiresAt = now + ttlMs(entry.category);
                  const embedding = yield* getEmbedding(entry.content);
                  yield* Effect.try({
                    try: () => {
                      // vec0 auxiliary DOUBLE columns are strictly typed on
                      // insert: the bound value must be exactly SQLITE_FLOAT (or
                      // NULL). Integer-valued JS numbers (e.g. pnlUsd 100,
                      // confidence 1) bind as SQLITE_INTEGER and are rejected by
                      // the strict linux vec0 binary with
                      // "Auxiliary column type mismatch: ... has type FLOAT, but
                      // INTEGER was provided" (sqlite-vec v0.1.9, xUpdate). Wrapping
                      // the DOUBLE aux columns in CAST(? AS REAL) coerces any bound
                      // value to FLOAT; CAST(NULL AS REAL) is NULL, which preserves
                      // the `?? null` fail-open semantics (NULL is always accepted).
                      runOne(
                        db,
                        `INSERT INTO vec_memory (embedding, id, category, content, pool_address, outcome, pnlUsd, confidence, createdAt, expiresAt)
                   VALUES (?, ?, ?, ?, ?, ?, CAST(? AS REAL), CAST(? AS REAL), ?, ?)`,
                        JSON.stringify(embedding),
                        id,
                        entry.category,
                        entry.content,
                        entry.poolAddress ?? null,
                        entry.outcome ?? null,
                        entry.pnlUsd ?? null,
                        entry.confidence ?? null,
                        now,
                        expiresAt,
                      );
                    },
                    catch: (error) => error as Error,
                  });
                }),
                (e) => (isVecMemoryMissingError(e) ? Effect.void : Effect.fail(e)),
              )
            : Effect.void,

        queryMemory: (queryText, topK, poolAddress) =>
          hasVecMemoryTable(db)
            ? Effect.catch(
                Effect.gen(function* () {
                  const now = Date.now();
                  const embedding = yield* getEmbedding(queryText);
                  // vec0 (sqlite-vec) forbids ANY auxiliary-column WHERE constraint
                  // inside a KNN query: `embedding MATCH ? AND k = ? [ORDER BY
                  // distance]` is the only legal shape. `expiresAt` and
                  // `pool_address` are both auxiliary columns, so filtering on them
                  // in the WHERE raised "An illegal WHERE constraint was provided on
                  // a vec0 auxiliary column in a KNN query" on the strict linux vec0
                  // binary (v0.1.9 vec0BestIndex: hasAuxConstraint -> error). Those
                  // filters are therefore applied in JS after the fetch below.
                  // Tradeoff (R1a + expanding window): a single global window of the
                  // nearest `topK * 2` neighbours can yield fewer than topK in-scope
                  // rows when the nearest neighbours are mostly expired or
                  // other-pool, so the window EXPANDS — k doubles each pass and the
                  // loop never stops before querying at the configured cap `maxK`
                  // (it breaks only after a query, once topK in-scope rows are found
                  // or `k >= maxK`). k is monotonically non-decreasing toward maxK,
                  // so the widest query always runs: for topK = 3 that is
                  // k = 6, 12, 24, 48, 64 — in-scope rows ranked anywhere within
                  // maxK are examined (worst case ~log2(maxK/topK) + 1 queries).
                  // This restores parity with the old SQL WHERE pre-filter in
                  // realistic cases; only genuine corner cases (a table dominated by
                  // expired/other-pool rows beyond the maxK nearest neighbours)
                  // fail-soft with fewer rows. Recency-blend ranking and ORDER BY
                  // distance are preserved exactly.
                  const maxK = Math.max(topK * 8, 64);
                  let k = topK * 2;
                  let candidates: Record<string, unknown>[] = [];
                  for (;;) {
                    const rows = yield* Effect.try({
                      try: () =>
                        queryAll<Record<string, unknown>>(
                          db,
                          `SELECT
                      id, category, content, pool_address, outcome, pnlUsd, confidence, createdAt, expiresAt,
                      distance
                     FROM vec_memory
                     WHERE embedding MATCH ? AND k = ?
                      ORDER BY distance`,
                          JSON.stringify(embedding),
                          k,
                        ),
                      catch: (error) => error as Error,
                    });
                    candidates = rows
                      .filter((row) => Number(row.expiresAt ?? 0) > now)
                      .filter((row) =>
                        poolAddress
                          ? String((row.pool_address ?? "") as unknown) === poolAddress
                          : true,
                      );
                    if (candidates.length >= topK || k >= maxK) break;
                    k = Math.min(k * 2, maxK);
                  }

                  const RECENCY_HALFLIFE_MS = 30 * 24 * 60 * 60 * 1000;
                  const ranked = candidates
                    .map((row) => {
                      const rawDistance = row.distance;
                      const distance =
                        rawDistance === undefined ||
                        rawDistance === null ||
                        Number.isNaN(rawDistance)
                          ? 1
                          : Number(rawDistance);
                      const simScore = 1 - distance;
                      const age = now - Number(row.createdAt ?? 0);
                      const recencyScore = Math.exp(-age / RECENCY_HALFLIFE_MS);
                      const blended = simScore * 0.7 + recencyScore * 0.3;
                      return { row, blended };
                    })
                    .sort((a, b) => b.blended - a.blended)
                    .slice(0, topK);

                  return ranked.map(({ row }) => ({
                    id: String(row.id),
                    category: String(row.category) as MemoryCategory,
                    content: String((row.content ?? "") as unknown),
                    poolAddress: row.pool_address ? String(row.pool_address as unknown) : undefined,
                    outcome: row.outcome
                      ? (String(row.outcome as unknown) as MemoryEntry["outcome"])
                      : undefined,
                    pnlUsd:
                      row.pnlUsd !== undefined && row.pnlUsd !== null
                        ? Number(row.pnlUsd)
                        : undefined,
                    confidence:
                      row.confidence !== undefined && row.confidence !== null
                        ? Number(row.confidence)
                        : undefined,
                    createdAt: Number(row.createdAt ?? 0),
                    expiresAt: Number(row.expiresAt ?? 0),
                  }));
                }),
                (e) => (isVecMemoryMissingError(e) ? Effect.succeed([]) : Effect.fail(e)),
              )
            : Effect.succeed([]),

        pruneMemory: () =>
          hasVecMemoryTable(db)
            ? Effect.catch(
                Effect.sync(() => {
                  const now = Date.now();
                  // sqlite-vec doesn't support DELETE with WHERE on virtual tables directly in all versions,
                  // so we find expired IDs and delete them
                  const rows = queryAll<{ rowid: number }>(
                    db,
                    "SELECT rowid FROM vec_memory WHERE expiresAt <= ?",
                    now,
                  );
                  for (const { rowid } of rows) {
                    runOne(db, "DELETE FROM vec_memory WHERE rowid = ?", rowid);
                  }
                  return rows.length;
                }),
                (e) => (isVecMemoryMissingError(e) ? Effect.succeed(0) : Effect.fail(e)),
              )
            : Effect.succeed(0),

        saveSnapshot: (snapshot) =>
          Effect.sync(() => {
            runOne(
              db,
              `INSERT OR REPLACE INTO pool_snapshots (
              pool_address, timestamp, active_bin_id, tvl_usd, volume_24h_usd,
              fees_24h_usd, apr, current_price, bin_step,
              token_x_symbol, token_y_symbol, bin_array_json, stats_source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              snapshot.poolAddress,
              snapshot.timestamp,
              snapshot.activeBinId,
              snapshot.tvlUsd,
              snapshot.volume24hUsd,
              snapshot.fees24hUsd,
              snapshot.apr,
              snapshot.currentPrice,
              snapshot.binStep,
              snapshot.tokenXSymbol,
              snapshot.tokenYSymbol,
              serializeBinArray(snapshot.binArray),
              snapshot.statsSource ?? "heuristic",
            );
          }),

        getSnapshots: (poolAddress, startMs, endMs) =>
          Effect.sync(() => {
            const rows = queryAll<Record<string, unknown>>(
              db,
              `SELECT * FROM pool_snapshots
               WHERE pool_address = ? AND timestamp >= ? AND timestamp <= ?
               ORDER BY timestamp ASC`,
              poolAddress,
              startMs,
              endMs,
            );
            return rows.map(rowToSnapshot);
          }),

        getSnapshotPools: () =>
          Effect.sync(() => {
            const rows = queryAll<{ pool_address: string }>(
              db,
              "SELECT DISTINCT pool_address FROM pool_snapshots ORDER BY pool_address",
            );
            return rows.map((r) => r.pool_address);
          }),

        getSnapshotCount: (poolAddress) =>
          Effect.sync(() => {
            const row = queryOne<{ n: number }>(
              db,
              "SELECT COUNT(*) as n FROM pool_snapshots WHERE pool_address = ?",
              poolAddress,
            );
            return row?.n ?? 0;
          }),

        pruneSnapshots: (olderThanMs) =>
          Effect.sync(() => {
            runOne(db, "DELETE FROM pool_snapshots WHERE timestamp < ?", olderThanMs);
            const row = queryOne<{ n: number }>(db, "SELECT changes() as n");
            return row?.n ?? 0;
          }),

        saveFeedback: (entry) =>
          Effect.sync(() => {
            runOne(
              db,
              `INSERT OR REPLACE INTO agent_feedback (
                id, agent_id, category, severity, summary, details,
                related_files, context_json, github_issue_number, github_issue_url,
                reported_at, hash
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              entry.id,
              entry.agentId,
              entry.category,
              entry.severity,
              entry.summary,
              entry.details,
              serializeJson(entry.relatedFiles),
              entry.contextJson,
              entry.githubIssueNumber,
              entry.githubIssueUrl,
              entry.reportedAt,
              entry.hash,
            );
          }),

        getFeedbackByHash: (hash, agentId) =>
          Effect.sync(() => {
            const row = queryOne<Record<string, unknown>>(
              db,
              "SELECT * FROM agent_feedback WHERE hash = ? AND agent_id = ? ORDER BY reported_at DESC LIMIT 1",
              hash,
              agentId,
            );
            return row ? rowToFeedback(row) : null;
          }),

        getRecentFeedbackForAgent: (agentId, sinceMs) =>
          Effect.sync(() => {
            const rows = queryAll<Record<string, unknown>>(
              db,
              "SELECT * FROM agent_feedback WHERE agent_id = ? AND reported_at >= ? ORDER BY reported_at ASC",
              agentId,
              sinceMs,
            );
            return rows.map(rowToFeedback);
          }),

        getLastFeedbackForAgent: (agentId) =>
          Effect.sync(() => {
            const row = queryOne<Record<string, unknown>>(
              db,
              "SELECT * FROM agent_feedback WHERE agent_id = ? ORDER BY reported_at DESC LIMIT 1",
              agentId,
            );
            return row ? rowToFeedback(row) : null;
          }),

        listFeedbackForAgent: (agentId) =>
          Effect.sync(() => {
            const rows = queryAll<Record<string, unknown>>(
              db,
              "SELECT * FROM agent_feedback WHERE agent_id = ? ORDER BY reported_at ASC",
              agentId,
            );
            return rows.map(rowToFeedback);
          }),

        getMetadata: (key) =>
          Effect.sync(() => {
            const row = queryOne<{ value: string }>(
              db,
              "SELECT value FROM metadata WHERE key = ?",
              key,
            );
            return row?.value ?? null;
          }),

        setMetadata: (key, value) =>
          Effect.sync(() => {
            runOne(
              db,
              "INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, ?)",
              key,
              value,
              Date.now(),
            );
          }),

        deleteMetadata: (key) =>
          Effect.sync(() => {
            runOne(db, "DELETE FROM metadata WHERE key = ?", key);
          }),

        setMetadataBatch: (entries) =>
          Effect.try({
            try: () => {
              const now = Date.now();
              db.transaction(() => {
                for (const { key, value } of entries) {
                  runOne(
                    db,
                    "INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, ?)",
                    key,
                    value,
                    now,
                  );
                }
              })();
            },
            catch: (e) =>
              new Error(`setMetadataBatch failed: ${e instanceof Error ? e.message : String(e)}`),
          }),

        saveFeeClaim: (claim) =>
          Effect.sync(() => {
            runOne(
              db,
              `INSERT INTO fee_claims (
                id, pool_address, position_pubkey, fee_x, fee_y,
                platform_fee_x, platform_fee_y, net_fee_x, net_fee_y,
                operator_fee_x, operator_fee_y,
                tx_signature, fee_transfer_tx_signature, reported_to_api, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              claim.id,
              claim.poolAddress,
              claim.positionPubkey,
              claim.feeX,
              claim.feeY,
              claim.platformFeeX,
              claim.platformFeeY,
              claim.netFeeX,
              claim.netFeeY,
              claim.operatorFeeX ?? 0,
              claim.operatorFeeY ?? 0,
              claim.txSignature,
              claim.feeTransferTxSignature,
              claim.reportedToApi ? 1 : 0,
              claim.createdAt,
            );
          }),

        getUnreportedFeeClaims: () =>
          Effect.sync(() => {
            return queryAll<{
              id: string;
              pool_address: string;
              position_pubkey: string;
              fee_x: number;
              fee_y: number;
              platform_fee_x: number;
              platform_fee_y: number;
              tx_signature: string | null;
              fee_transfer_tx_signature: string | null;
              created_at: number;
            }>(
              db,
              `SELECT id, pool_address, position_pubkey, fee_x, fee_y,
                platform_fee_x, platform_fee_y, tx_signature,
                fee_transfer_tx_signature, created_at
              FROM fee_claims WHERE reported_to_api = 0
              ORDER BY created_at ASC`,
            ).map((row) => ({
              id: row.id,
              poolAddress: row.pool_address,
              positionPubkey: row.position_pubkey,
              feeX: row.fee_x,
              feeY: row.fee_y,
              platformFeeX: row.platform_fee_x,
              platformFeeY: row.platform_fee_y,
              txSignature: row.tx_signature,
              feeTransferTxSignature: row.fee_transfer_tx_signature,
              createdAt: row.created_at,
            }));
          }),

        markFeeClaimReported: (id) =>
          Effect.sync(() => {
            runOne(db, "UPDATE fee_claims SET reported_to_api = 1 WHERE id = ?", id);
          }),

        saveSignalSnapshot: (snapshot) =>
          Effect.sync(() => {
            const result = (
              db.run as (sql: string, ...params: unknown[]) => { lastInsertRowid: number | bigint }
            )(
              `INSERT INTO signal_snapshots (pool_address, timestamp, fee_il_ratio, volume_authenticity, bin_utilization, tvl_usd, tvl_velocity, volatility_stddev, bin_step, action, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              snapshot.poolAddress,
              snapshot.timestamp,
              snapshot.feeIlRatio,
              snapshot.volumeAuthenticity,
              snapshot.binUtilization,
              snapshot.tvlUsd,
              snapshot.tvlVelocity,
              snapshot.volatilityStddev,
              snapshot.binStep,
              snapshot.action,
              snapshot.confidence,
            );
            return Number(result.lastInsertRowid);
          }),

        getSignalSnapshots: (poolAddress, startMs, endMs) =>
          Effect.sync(() => {
            const rows = queryAll<Record<string, unknown>>(
              db,
              `SELECT pool_address as poolAddress, timestamp, fee_il_ratio as feeIlRatio,
                volume_authenticity as volumeAuthenticity, bin_utilization as binUtilization,
                tvl_usd as tvlUsd, tvl_velocity as tvlVelocity,
                volatility_stddev as volatilityStddev, bin_step as binStep,
                action, confidence, outcome_pnl_usd as outcomePnlUsd,
                outcome_recorded_at as outcomeRecordedAt
              FROM signal_snapshots
              WHERE pool_address = ? AND timestamp BETWEEN ? AND ?
              ORDER BY timestamp ASC`,
              poolAddress,
              startMs,
              endMs,
            );
            return rows.map((r) => ({
              poolAddress: String(r.poolAddress),
              timestamp: Number(r.timestamp),
              feeIlRatio: Number(r.feeIlRatio),
              volumeAuthenticity: Number(r.volumeAuthenticity),
              binUtilization: Number(r.binUtilization),
              tvlUsd: Number(r.tvlUsd),
              tvlVelocity: Number(r.tvlVelocity),
              volatilityStddev: Number(r.volatilityStddev),
              binStep: Number(r.binStep),
              action: String(r.action) as SignalSnapshot["action"],
              confidence: Number(r.confidence),
              outcomePnlUsd: r.outcomePnlUsd != null ? Number(r.outcomePnlUsd) : null,
              outcomeRecordedAt: r.outcomeRecordedAt != null ? Number(r.outcomeRecordedAt) : null,
            }));
          }),

        recordSignalOutcome: (snapshotId, pnlUsd) =>
          Effect.sync(() => {
            runOne(
              db,
              `UPDATE signal_snapshots SET outcome_pnl_usd = ?, outcome_recorded_at = ? WHERE id = ?`,
              pnlUsd,
              Date.now(),
              snapshotId,
            );
          }),

        getRecentOutcomes: (limit) =>
          Effect.sync(() => {
            const rows = queryAll<Record<string, unknown>>(
              db,
              `SELECT pool_address as poolAddress, timestamp, fee_il_ratio as feeIlRatio,
                volume_authenticity as volumeAuthenticity, bin_utilization as binUtilization,
                tvl_usd as tvlUsd, tvl_velocity as tvlVelocity,
                volatility_stddev as volatilityStddev, bin_step as binStep,
                action, confidence, outcome_pnl_usd as outcomePnlUsd,
                outcome_recorded_at as outcomeRecordedAt
              FROM signal_snapshots
              WHERE outcome_pnl_usd IS NOT NULL
              ORDER BY outcome_recorded_at DESC LIMIT ?`,
              limit,
            );
            return rows.map((r) => ({
              poolAddress: String(r.poolAddress),
              timestamp: Number(r.timestamp),
              feeIlRatio: Number(r.feeIlRatio),
              volumeAuthenticity: Number(r.volumeAuthenticity),
              binUtilization: Number(r.binUtilization),
              tvlUsd: Number(r.tvlUsd),
              tvlVelocity: Number(r.tvlVelocity),
              volatilityStddev: Number(r.volatilityStddev),
              binStep: Number(r.binStep),
              action: String(r.action),
              confidence: Number(r.confidence),
              outcomePnlUsd: r.outcomePnlUsd != null ? Number(r.outcomePnlUsd) : null,
              outcomeRecordedAt: r.outcomeRecordedAt != null ? Number(r.outcomeRecordedAt) : null,
            }));
          }),

        getEvolvedThresholds: () =>
          Effect.sync(() => {
            const feeRow = queryOne<{ value: string }>(
              db,
              "SELECT value FROM metadata WHERE key = ?",
              "evolved_min_fee_il_ratio",
            );
            const authRow = queryOne<{ value: string }>(
              db,
              "SELECT value FROM metadata WHERE key = ?",
              "evolved_volume_auth_threshold",
            );
            const utilRow = queryOne<{ value: string }>(
              db,
              "SELECT value FROM metadata WHERE key = ?",
              "evolved_min_bin_utilization",
            );
            if (!feeRow || !authRow || !utilRow) return null;
            return {
              minFeeIlRatio: Number(feeRow.value),
              volumeAuthThreshold: Number(authRow.value),
              minBinUtilization: Number(utilRow.value),
            };
          }),

        saveEvolvedThresholds: (thresholds) =>
          Effect.sync(() => {
            runOne(
              db,
              "INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, ?)",
              "evolved_min_fee_il_ratio",
              String(thresholds.minFeeIlRatio),
              Date.now(),
            );
            runOne(
              db,
              "INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, ?)",
              "evolved_volume_auth_threshold",
              String(thresholds.volumeAuthThreshold),
              Date.now(),
            );
            runOne(
              db,
              "INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, ?)",
              "evolved_min_bin_utilization",
              String(thresholds.minBinUtilization),
              Date.now(),
            );
          }),

        getClosedPositionOutcomes: (limit) =>
          Effect.sync(() => {
            const rows = queryAll<Record<string, unknown>>(
              db,
              `SELECT fee_il_ratio as feeIlRatio,
                volume_authenticity as volumeAuthenticity,
                bin_utilization as binUtilization,
                outcome_pnl_usd as pnlUsd,
                outcome_recorded_at as outcomeRecordedAt
              FROM signal_snapshots
              WHERE outcome_recorded_at IS NOT NULL
                AND outcome_pnl_usd IS NOT NULL
                AND (action = 'ENTER' OR action = 'HOLD')
              ORDER BY outcome_recorded_at DESC
              LIMIT ?`,
              limit,
            );
            return rows.map((r) => ({
              feeIlRatio: Number(r.feeIlRatio),
              volumeAuthenticity: Number(r.volumeAuthenticity),
              binUtilization: Number(r.binUtilization),
              pnlUsd: Number(r.pnlUsd),
              outcomeRecordedAt: Number(r.outcomeRecordedAt),
            }));
          }),

        getSignalWeights: () =>
          Effect.sync(() => {
            const row = queryOne<{ value: string }>(
              db,
              "SELECT value FROM metadata WHERE key = ?",
              "signal_weights",
            );
            if (!row) return null;
            try {
              return JSON.parse(row.value) as SignalWeights;
            } catch {
              return null;
            }
          }),

        saveSignalWeights: (weights) =>
          Effect.sync(() => {
            runOne(
              db,
              "INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, ?)",
              "signal_weights",
              JSON.stringify(weights),
              Date.now(),
            );
          }),

        getPoolCooldown: (poolAddress) =>
          Effect.sync(() => {
            const row = queryOne<Record<string, unknown>>(
              db,
              "SELECT * FROM pool_cooldowns WHERE pool_address = ?",
              poolAddress,
            );
            if (!row) return null;
            return {
              poolAddress: String(row.pool_address),
              cooldownUntil: Number(row.cooldown_until),
              reason: String(row.reason),
              consecutiveOorExits: Number(row.consecutive_oor_exits),
            };
          }),

        setPoolCooldown: (cooldown) =>
          Effect.sync(() => {
            runOne(
              db,
              `INSERT OR REPLACE INTO pool_cooldowns (pool_address, cooldown_until, reason, consecutive_oor_exits)
               VALUES (?, ?, ?, ?)`,
              cooldown.poolAddress,
              cooldown.cooldownUntil,
              cooldown.reason,
              cooldown.consecutiveOorExits,
            );
          }),

        clearPoolCooldown: (poolAddress) =>
          Effect.sync(() => {
            runOne(db, "DELETE FROM pool_cooldowns WHERE pool_address = ?", poolAddress);
          }),

        saveTokenCandidate: (candidate) =>
          Effect.sync(() => {
            runOne(
              db,
              `INSERT INTO token_candidates (
                id, wallet_address, agent_instance_id, pool_address, token_mint, state,
                healthy_scan_count, first_seen_at, last_seen_at, eligible_at, entered_at,
                cooldown_until, rejection_reason, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                wallet_address = excluded.wallet_address,
                agent_instance_id = excluded.agent_instance_id,
                pool_address = excluded.pool_address,
                token_mint = excluded.token_mint,
                state = excluded.state,
                healthy_scan_count = excluded.healthy_scan_count,
                first_seen_at = excluded.first_seen_at,
                last_seen_at = excluded.last_seen_at,
                eligible_at = excluded.eligible_at,
                entered_at = excluded.entered_at,
                cooldown_until = excluded.cooldown_until,
                rejection_reason = excluded.rejection_reason,
                updated_at = excluded.updated_at`,
              candidate.id,
              candidate.walletAddress,
              candidate.agentInstanceId,
              candidate.poolAddress,
              candidate.tokenMint,
              candidate.state,
              candidate.healthyScanCount,
              candidate.firstSeenAt,
              candidate.lastSeenAt,
              candidate.eligibleAt,
              candidate.enteredAt,
              candidate.cooldownUntil,
              candidate.rejectionReason,
              candidate.createdAt,
              candidate.updatedAt,
            );
          }),

        getTokenCandidate: (id) =>
          Effect.try({
            try: () => {
              const row = queryOne<Record<string, unknown>>(
                db,
                "SELECT * FROM token_candidates WHERE id = ?",
                id,
              );
              return row === null ? null : rowToTokenCandidate(row);
            },
            catch: (error) => error as Error,
          }),

        listTokenCandidates: (walletAddress, agentInstanceId) =>
          Effect.try({
            try: () =>
              queryAll<Record<string, unknown>>(
                db,
                `SELECT * FROM token_candidates
               WHERE wallet_address = ? AND agent_instance_id = ?
               ORDER BY updated_at ASC, id ASC`,
                walletAddress,
                agentInstanceId,
              ).map(rowToTokenCandidate),
            catch: (error) => error as Error,
          }),

        saveExecutionOperation: (operation) =>
          Effect.sync(() => {
            runOne(
              db,
              `INSERT INTO execution_operations (
                id, wallet_address, agent_instance_id, candidate_id, position_id,
                pool_address, token_mint, operation_type, status, amount_atomic,
                tx_signature, error, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                wallet_address = excluded.wallet_address,
                agent_instance_id = excluded.agent_instance_id,
                candidate_id = excluded.candidate_id,
                position_id = excluded.position_id,
                pool_address = excluded.pool_address,
                token_mint = excluded.token_mint,
                operation_type = excluded.operation_type,
                status = excluded.status,
                amount_atomic = excluded.amount_atomic,
                tx_signature = excluded.tx_signature,
                error = excluded.error,
                updated_at = excluded.updated_at`,
              operation.id,
              operation.walletAddress,
              operation.agentInstanceId,
              operation.candidateId,
              operation.positionId,
              operation.poolAddress,
              operation.tokenMint,
              operation.operationType,
              operation.status,
              operation.amountAtomic,
              operation.txSignature,
              operation.error,
              operation.createdAt,
              operation.updatedAt,
            );
          }),

        getExecutionOperation: (id) =>
          Effect.try({
            try: () => {
              const row = queryOne<Record<string, unknown>>(
                db,
                "SELECT * FROM execution_operations WHERE id = ?",
                id,
              );
              return row === null ? null : rowToExecutionOperation(row);
            },
            catch: (error) => error as Error,
          }),

        listExecutionOperations: (walletAddress, agentInstanceId) =>
          Effect.try({
            try: () =>
              queryAll<Record<string, unknown>>(
                db,
                `SELECT * FROM execution_operations
               WHERE wallet_address = ? AND agent_instance_id = ?
               ORDER BY created_at ASC, id ASC`,
                walletAddress,
                agentInstanceId,
              ).map(rowToExecutionOperation),
            catch: (error) => error as Error,
          }),

        saveSettlementJob: (job) =>
          Effect.sync(() => {
            runOne(
              db,
              `INSERT INTO settlement_jobs (
                id, wallet_address, agent_instance_id, position_id, pool_address,
                token_mint, amount_atomic, destination_asset, status, attempts,
                next_retry_at, tx_signature, confirmed_output_atomic, output_usd,
                execution_cost_usd, finalized_at, realized_pnl_usd, expires_at,
                error, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                wallet_address = excluded.wallet_address,
                agent_instance_id = excluded.agent_instance_id,
                position_id = excluded.position_id,
                pool_address = excluded.pool_address,
                token_mint = excluded.token_mint,
                amount_atomic = excluded.amount_atomic,
                destination_asset = excluded.destination_asset,
                status = excluded.status,
                attempts = excluded.attempts,
                next_retry_at = excluded.next_retry_at,
                tx_signature = excluded.tx_signature,
                confirmed_output_atomic = excluded.confirmed_output_atomic,
                output_usd = excluded.output_usd,
                execution_cost_usd = excluded.execution_cost_usd,
                finalized_at = excluded.finalized_at,
                realized_pnl_usd = excluded.realized_pnl_usd,
                expires_at = excluded.expires_at,
                error = excluded.error,
                updated_at = excluded.updated_at`,
              job.id,
              job.walletAddress,
              job.agentInstanceId,
              job.positionId,
              job.poolAddress,
              job.tokenMint,
              job.amountAtomic,
              job.destinationAsset,
              job.status,
              job.attempts,
              job.nextRetryAt,
              job.txSignature,
              job.confirmedOutputAtomic ?? null,
              job.outputUsd ?? null,
              job.executionCostUsd ?? null,
              job.finalizedAt ?? null,
              job.realizedPnlUsd ?? null,
              job.expiresAt,
              job.error,
              job.createdAt,
              job.updatedAt,
            );
          }),

        getSettlementJob: (id) =>
          Effect.try({
            try: () => {
              const row = queryOne<Record<string, unknown>>(
                db,
                "SELECT * FROM settlement_jobs WHERE id = ?",
                id,
              );
              return row === null ? null : rowToSettlementJob(row);
            },
            catch: (error) => error as Error,
          }),

        listSettlementJobs: (walletAddress, agentInstanceId) =>
          Effect.try({
            try: () =>
              queryAll<Record<string, unknown>>(
                db,
                `SELECT * FROM settlement_jobs
               WHERE wallet_address = ? AND agent_instance_id = ?
               ORDER BY created_at ASC, id ASC`,
                walletAddress,
                agentInstanceId,
              ).map(rowToSettlementJob),
            catch: (error) => error as Error,
          }),

        saveSafetyPause: (pause) =>
          Effect.sync(() => {
            runOne(
              db,
              `INSERT INTO wallet_safety_pauses (
                wallet_address, agent_instance_id, reason, triggered_at, resolved_at
              ) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(wallet_address, agent_instance_id) DO UPDATE SET
                reason = excluded.reason,
                triggered_at = excluded.triggered_at,
                resolved_at = excluded.resolved_at`,
              pause.walletAddress,
              pause.agentInstanceId,
              pause.reason,
              pause.triggeredAt,
              pause.resolvedAt,
            );
          }),

        getSafetyPause: (walletAddress, agentInstanceId) =>
          Effect.try({
            try: () => {
              const row = queryOne<Record<string, unknown>>(
                db,
                `SELECT * FROM wallet_safety_pauses
               WHERE wallet_address = ? AND agent_instance_id = ?`,
                walletAddress,
                agentInstanceId,
              );
              return row === null ? null : rowToSafetyPause(row);
            },
            catch: (error) => error as Error,
          }),
      };

      return api;
    }),
  );

function parseTokenCandidateState(value: unknown): TokenCandidateState {
  switch (value) {
    case "discovered":
    case "observing":
    case "eligible":
    case "entered":
    case "cooling_down":
    case "rejected":
      return value;
    default:
      throw new PersistenceContractError({
        entity: "token_candidate",
        field: "state",
        value: String(value),
      });
  }
}

function parseExecutionOperationType(value: unknown): ExecutionOperationType {
  switch (value) {
    case "entry":
    case "exit":
    case "rollback":
    case "settlement":
      return value;
    default:
      throw new PersistenceContractError({
        entity: "execution_operation",
        field: "operation_type",
        value: String(value),
      });
  }
}

function parseExecutionOperationStatus(value: unknown): ExecutionOperationStatus {
  switch (value) {
    case "planned":
    case "prepared":
    case "submitted":
    case "confirmed":
    case "retryable":
    case "failed":
      return value;
    default:
      throw new PersistenceContractError({
        entity: "execution_operation",
        field: "status",
        value: String(value),
      });
  }
}

function parseSettlementJobStatus(value: unknown): SettlementJobStatus {
  switch (value) {
    case "pending":
    case "prepared":
    case "submitted":
    case "confirmed":
    case "retryable":
    case "terminal":
      return value;
    default:
      throw new PersistenceContractError({
        entity: "settlement_job",
        field: "status",
        value: String(value),
      });
  }
}

function parseSettlementAsset(value: unknown): SettlementAsset {
  if (value === "SOL") return value;
  throw new PersistenceContractError({
    entity: "settlement_job",
    field: "destination_asset",
    value: String(value),
  });
}

function rowToTokenCandidate(row: Record<string, unknown>): TokenCandidateRecord {
  return {
    id: String(row.id),
    walletAddress: String(row.wallet_address),
    agentInstanceId: String(row.agent_instance_id),
    poolAddress: String(row.pool_address),
    tokenMint: String(row.token_mint),
    state: parseTokenCandidateState(row.state),
    healthyScanCount: Number(row.healthy_scan_count),
    firstSeenAt: Number(row.first_seen_at),
    lastSeenAt: Number(row.last_seen_at),
    eligibleAt: row.eligible_at === null ? null : Number(row.eligible_at),
    enteredAt: row.entered_at === null ? null : Number(row.entered_at),
    cooldownUntil: row.cooldown_until === null ? null : Number(row.cooldown_until),
    rejectionReason: row.rejection_reason === null ? null : String(row.rejection_reason as unknown),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToExecutionOperation(row: Record<string, unknown>): ExecutionOperationRecord {
  return {
    id: String(row.id),
    walletAddress: String(row.wallet_address),
    agentInstanceId: String(row.agent_instance_id),
    candidateId: row.candidate_id === null ? null : String(row.candidate_id as unknown),
    positionId: row.position_id === null ? null : String(row.position_id as unknown),
    poolAddress: String(row.pool_address),
    tokenMint: String(row.token_mint),
    operationType: parseExecutionOperationType(row.operation_type),
    status: parseExecutionOperationStatus(row.status),
    amountAtomic: row.amount_atomic === null ? null : String(row.amount_atomic as unknown),
    txSignature: row.tx_signature === null ? null : String(row.tx_signature as unknown),
    error: row.error === null ? null : String(row.error as unknown),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToSettlementJob(row: Record<string, unknown>): SettlementJobRecord {
  return {
    id: String(row.id),
    walletAddress: String(row.wallet_address),
    agentInstanceId: String(row.agent_instance_id),
    positionId: String(row.position_id),
    poolAddress: String(row.pool_address),
    tokenMint: String(row.token_mint),
    amountAtomic: String(row.amount_atomic),
    destinationAsset: parseSettlementAsset(row.destination_asset),
    status: parseSettlementJobStatus(row.status),
    attempts: Number(row.attempts),
    nextRetryAt: row.next_retry_at === null ? null : Number(row.next_retry_at),
    txSignature: row.tx_signature === null ? null : String(row.tx_signature as unknown),
    confirmedOutputAtomic:
      row.confirmed_output_atomic == null ? null : String(row.confirmed_output_atomic as unknown),
    outputUsd: row.output_usd == null ? null : Number(row.output_usd),
    executionCostUsd: row.execution_cost_usd == null ? null : Number(row.execution_cost_usd),
    finalizedAt: row.finalized_at == null ? null : Number(row.finalized_at),
    realizedPnlUsd: row.realized_pnl_usd == null ? null : Number(row.realized_pnl_usd),
    expiresAt: Number(row.expires_at),
    error: row.error === null ? null : String(row.error as unknown),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToSafetyPause(row: Record<string, unknown>): SafetyPauseRecord {
  return {
    walletAddress: String(row.wallet_address),
    agentInstanceId: String(row.agent_instance_id),
    reason: String(row.reason),
    triggeredAt: Number(row.triggered_at),
    resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
  };
}

function rowToPosition(row: Record<string, unknown>): PositionRecord {
  return {
    positionId: String(row.position_id),
    poolAddress: String(row.pool_address),
    positionPubKey: row.position_pubkey ? String(row.position_pubkey as unknown) : null,
    depositedUsd: Number(row.deposited_usd ?? 0),
    currentValueUsd: Number(row.current_value_usd ?? 0),
    tokenXSymbol: String((row.token_x_symbol ?? "") as unknown),
    tokenYSymbol: String((row.token_y_symbol ?? "") as unknown),
    activeBinId: Number(row.active_bin_id ?? 0),
    lowerBinId: Number(row.lower_bin_id ?? 0),
    upperBinId: Number(row.upper_bin_id ?? 0),
    timestamp: Number(row.timestamp ?? 0),
    outOfRangeSince: row.out_of_range_since != null ? Number(row.out_of_range_since) : null,
    oorCycleCount: Number(row.oor_cycle_count ?? 0),
    lastFeeClaimAt: Number(row.last_fee_claim_at ?? 0),
    trailingStopThreshold:
      row.trailing_stop_threshold != null ? Number(row.trailing_stop_threshold) : null,
    highestValueUsd: row.highest_value_usd != null ? Number(row.highest_value_usd) : null,
    lastRebalanceAt: Number(row.last_rebalance_at ?? 0),
    paperExitedAt: row.paper_exited_at != null ? Number(row.paper_exited_at) : null,
    entrySignalTimestamp:
      row.entry_signal_timestamp != null ? Number(row.entry_signal_timestamp) : null,
    entrySignalSnapshotId:
      row.entry_signal_snapshot_id != null ? Number(row.entry_signal_snapshot_id) : null,
    entryPriceUsd: row.entry_price_usd != null ? Number(row.entry_price_usd) : null,
    entryAmountXUsd: row.entry_amount_x_usd != null ? Number(row.entry_amount_x_usd) : null,
    entryAmountYUsd: row.entry_amount_y_usd != null ? Number(row.entry_amount_y_usd) : null,
    cumulativeFeesClaimedUsd: Number(row.cumulative_fees_claimed_usd ?? 0),
    cumulativeRewardsClaimedUsd: Number(row.cumulative_rewards_claimed_usd ?? 0),
    closedAt: row.closed_at != null ? Number(row.closed_at) : null,
    realizedPnlUsd: row.realized_pnl_usd != null ? Number(row.realized_pnl_usd) : null,
    positionMode: row.position_mode != null ? String(row.position_mode as unknown) : null,
    tpLadderJson: row.tp_ladder_json != null ? String(row.tp_ladder_json as unknown) : null,
    invalidationStopPrice:
      row.invalidation_stop_price != null ? Number(row.invalidation_stop_price) : null,
  };
}

function rowToPositionEvent(row: Record<string, unknown>): PositionEventRecord {
  return {
    id: String(row.id),
    poolAddress: String(row.pool_address),
    positionPubKey: row.position_pubkey ? String(row.position_pubkey as unknown) : null,
    positionId: row.position_id ? String(row.position_id as unknown) : null,
    event: String(row.event) as PositionEventType,
    valueUsd: row.value_usd != null ? Number(row.value_usd) : null,
    feesUsd: row.fees_usd != null ? Number(row.fees_usd) : null,
    price: row.price != null ? Number(row.price) : null,
    metadata: row.metadata != null ? String(row.metadata as unknown) : null,
    createdAt: Number(row.created_at ?? 0),
  };
}

// Narrow the TEXT column back to the stats-source union. Anything outside the
// known members (legacy NULL, an unexpected literal) is treated as the
// conservative, fail-closed "heuristic" — never silently upgraded to "datapi",
// so an unknown provenance keeps the measured-fee-rate gate disabled on replay.
function parseStatsSource(value: unknown): "datapi" | "geckoterminal" | "heuristic" {
  if (value === "datapi" || value === "geckoterminal" || value === "heuristic") return value;
  return "heuristic";
}

function rowToSnapshot(row: Record<string, unknown>): PoolSnapshot {
  return {
    poolAddress: String(row.pool_address),
    timestamp: Number(row.timestamp),
    activeBinId: Number(row.active_bin_id),
    tvlUsd: Number(row.tvl_usd),
    volume24hUsd: Number(row.volume_24h_usd),
    fees24hUsd: Number(row.fees_24h_usd),
    apr: Number(row.apr),
    currentPrice: Number(row.current_price),
    binStep: Number(row.bin_step),
    tokenXSymbol: String((row.token_x_symbol ?? "") as unknown),
    tokenYSymbol: String((row.token_y_symbol ?? "") as unknown),
    binArray: deserializeBinArray(String(row.bin_array_json)),
    statsSource: parseStatsSource(row.stats_source),
  };
}

function rowToAudit(row: Record<string, unknown>): AuditRecord {
  return {
    id: String(row.id),
    timestamp: Number(row.timestamp ?? 0),
    cycleId: String((row.cycle_id ?? "") as unknown),
    poolAddress: String((row.pool_address ?? "") as unknown),
    action: String((row.action ?? "") as unknown),
    confidence: Number(row.confidence ?? 0),
    reasoning: String((row.reasoning ?? "") as unknown),
    metricsJson: row.metrics_json ? String(row.metrics_json as unknown) : null,
    riskResultJson: row.risk_result_json ? String(row.risk_result_json as unknown) : null,
    executed: Boolean(row.executed),
    paperTrading: Boolean(row.paper_trading),
    txSignature: row.tx_signature ? String(row.tx_signature as unknown) : null,
    error: row.error ? String(row.error as unknown) : null,
  };
}

function rowToFeedback(row: Record<string, unknown>): {
  id: string;
  agentId: string;
  category: string;
  severity: string;
  summary: string;
  details: string | null;
  relatedFiles: ReadonlyArray<string>;
  contextJson: string;
  githubIssueNumber: number | null;
  githubIssueUrl: string | null;
  reportedAt: number;
  hash: string;
} {
  const relatedRaw = row.related_files ? String(row.related_files as unknown) : null;
  let relatedFiles: ReadonlyArray<string> = [];
  if (relatedRaw) {
    try {
      const parsed = JSON.parse(relatedRaw) as unknown;
      if (Array.isArray(parsed)) {
        relatedFiles = parsed.filter((x): x is string => typeof x === "string");
      }
    } catch {
      // ignore malformed stored value
    }
  }
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    category: String(row.category),
    severity: String(row.severity),
    summary: String(row.summary),
    details: row.details != null ? String(row.details as unknown) : null,
    relatedFiles,
    contextJson: String((row.context_json ?? "{}") as unknown),
    githubIssueNumber: row.github_issue_number != null ? Number(row.github_issue_number) : null,
    githubIssueUrl: row.github_issue_url ? String(row.github_issue_url as unknown) : null,
    reportedAt: Number(row.reported_at ?? 0),
    hash: String(row.hash),
  };
}

function ttlMs(category: MemoryCategory): number {
  switch (category) {
    case "pattern":
      return 90 * 24 * 60 * 60 * 1000;
    case "warning":
      return 60 * 24 * 60 * 60 * 1000;
    case "outcome":
      return 180 * 24 * 60 * 60 * 1000;
    default:
      return 30 * 24 * 60 * 60 * 1000;
  }
}
