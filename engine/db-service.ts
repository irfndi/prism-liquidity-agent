import { Context, Effect, Layer } from "effect";
import type { Database } from "bun:sqlite";
import { createDatabase } from "./db.js";
import { getEmbedding } from "./embeddings.js";
import type { MemoryEntry, MemoryCategory, PoolSnapshot, Position, BinArray } from "./types.js";
import { DbService, type DbApi } from "./services.js";
import { bigintReplacer } from "./bigint-json.js";
import { randomUUID } from "crypto";

export interface PositionRecord {
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
              pool_address, position_pubkey, deposited_usd, current_value_usd,
              token_x_symbol, token_y_symbol, active_bin_id, lower_bin_id, upper_bin_id,
              timestamp, out_of_range_since, oor_cycle_count, last_fee_claim_at,
              trailing_stop_threshold, highest_value_usd, last_rebalance_at, paper_exited_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(pool_address) DO UPDATE SET
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
              paper_exited_at = excluded.paper_exited_at`,
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
            );
          }),

        getPosition: (poolAddress) =>
          Effect.sync(() => {
            const row = queryOne<Record<string, unknown>>(
              db,
              "SELECT * FROM positions WHERE pool_address = ?",
              poolAddress,
            );
            return row ? rowToPosition(row) : null;
          }),

        getAllPositions: () =>
          Effect.sync(() => {
            const rows = queryAll<Record<string, unknown>>(
              db,
              "SELECT * FROM positions WHERE paper_exited_at IS NULL",
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

        deletePosition: (poolAddress) =>
          Effect.sync(() => {
            runOne(db, "DELETE FROM positions WHERE pool_address = ?", poolAddress);
          }),

        markPaperExited: (poolAddress) =>
          Effect.sync(() => {
            runOne(
              db,
              "UPDATE positions SET paper_exited_at = ? WHERE pool_address = ?",
              Date.now(),
              poolAddress,
            );
          }),

        updatePositionValue: (poolAddress, currentValueUsd, highestValueUsd) =>
          Effect.sync(() => {
            if (highestValueUsd !== undefined) {
              runOne(
                db,
                "UPDATE positions SET current_value_usd = ?, highest_value_usd = ? WHERE pool_address = ?",
                currentValueUsd,
                highestValueUsd,
                poolAddress,
              );
            } else {
              runOne(
                db,
                "UPDATE positions SET current_value_usd = ? WHERE pool_address = ?",
                currentValueUsd,
                poolAddress,
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
          Effect.tryPromise(async () => {
            const id = randomUUID();
            const now = Date.now();
            const expiresAt = now + ttlMs(entry.category);
            const embedding = await getEmbedding(entry.content);
            runOne(
              db,
              `INSERT INTO vec_memory (embedding, id, category, content, pool_address, outcome, pnlUsd, confidence, createdAt, expiresAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          }),

        queryMemory: (queryText, topK, poolAddress) =>
          Effect.tryPromise(async () => {
            const now = Date.now();
            const embedding = await getEmbedding(queryText);
            const sql = poolAddress
              ? `SELECT
              id, category, content, pool_address, outcome, pnlUsd, confidence, createdAt, expiresAt,
              distance
             FROM vec_memory
             WHERE embedding MATCH ? AND k = ? AND expiresAt > ? AND pool_address = ?
             ORDER BY distance`
              : `SELECT
              id, category, content, pool_address, outcome, pnlUsd, confidence, createdAt, expiresAt,
              distance
             FROM vec_memory
             WHERE embedding MATCH ? AND k = ? AND expiresAt > ?
             ORDER BY distance`;
            const params = poolAddress
              ? [JSON.stringify(embedding), topK * 2, now, poolAddress]
              : [JSON.stringify(embedding), topK * 2, now];
            const rows = queryAll<Record<string, unknown>>(db, sql, ...params);

            const RECENCY_HALFLIFE_MS = 30 * 24 * 60 * 60 * 1000;
            const ranked = rows
              .map((row) => {
                const simScore = 1 - (Number(row.distance) || 1);
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
              content: String(row.content ?? ""),
              poolAddress: row.pool_address ? String(row.pool_address) : undefined,
              outcome: row.outcome ? (String(row.outcome) as MemoryEntry["outcome"]) : undefined,
              pnlUsd:
                row.pnlUsd !== undefined && row.pnlUsd !== null ? Number(row.pnlUsd) : undefined,
              confidence:
                row.confidence !== undefined && row.confidence !== null
                  ? Number(row.confidence)
                  : undefined,
              createdAt: Number(row.createdAt ?? 0),
              expiresAt: Number(row.expiresAt ?? 0),
            }));
          }),

        pruneMemory: () =>
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

        saveSnapshot: (snapshot) =>
          Effect.sync(() => {
            runOne(
              db,
              `INSERT INTO pool_snapshots (
              pool_address, timestamp, active_bin_id, tvl_usd, volume_24h_usd,
              fees_24h_usd, apr, current_price, bin_step,
              token_x_symbol, token_y_symbol, bin_array_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      };

      return api;
    }),
  );

function rowToPosition(row: Record<string, unknown>): PositionRecord {
  return {
    poolAddress: String(row.pool_address),
    positionPubKey: row.position_pubkey ? String(row.position_pubkey) : null,
    depositedUsd: Number(row.deposited_usd ?? 0),
    currentValueUsd: Number(row.current_value_usd ?? 0),
    tokenXSymbol: String(row.token_x_symbol ?? ""),
    tokenYSymbol: String(row.token_y_symbol ?? ""),
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
  };
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
    tokenXSymbol: String(row.token_x_symbol ?? ""),
    tokenYSymbol: String(row.token_y_symbol ?? ""),
    binArray: deserializeBinArray(String(row.bin_array_json)),
  };
}

function rowToAudit(row: Record<string, unknown>): AuditRecord {
  return {
    id: String(row.id),
    timestamp: Number(row.timestamp ?? 0),
    cycleId: String(row.cycle_id ?? ""),
    poolAddress: String(row.pool_address ?? ""),
    action: String(row.action ?? ""),
    confidence: Number(row.confidence ?? 0),
    reasoning: String(row.reasoning ?? ""),
    metricsJson: row.metrics_json ? String(row.metrics_json) : null,
    riskResultJson: row.risk_result_json ? String(row.risk_result_json) : null,
    executed: Boolean(row.executed),
    paperTrading: Boolean(row.paper_trading),
    txSignature: row.tx_signature ? String(row.tx_signature) : null,
    error: row.error ? String(row.error) : null,
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
  const relatedRaw = row.related_files ? String(row.related_files) : null;
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
    details: row.details != null ? String(row.details) : null,
    relatedFiles,
    contextJson: String(row.context_json ?? "{}"),
    githubIssueNumber: row.github_issue_number != null ? Number(row.github_issue_number) : null,
    githubIssueUrl: row.github_issue_url ? String(row.github_issue_url) : null,
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
