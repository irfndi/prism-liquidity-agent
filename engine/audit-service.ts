import { Effect, Layer } from "effect";
import { randomUUID } from "crypto";
import { AuditService, type AuditApi } from "./services.js";
import { DbService } from "./services.js";
import type { PoolMetrics } from "./types.js";
import { stringifySafe, parseBigIntSafe } from "./bigint-json.js";

interface RiskResult {
  approved: boolean;
  reason: string;
  adjustedSizeUsd?: number;
}

function parseRiskResult(json: string | null): RiskResult {
  if (!json) return { approved: false, reason: "unknown" };
  try {
    const parsed: unknown = JSON.parse(json);
    // DB-sourced riskResultJson is untrusted: validate the shape instead of
    // asserting, so a null/array/odd-typed value cannot masquerade as a
    // valid risk result (which would fail the caller's fallback logic).
    // SAFETY: The enclosing statement has validated or constructed the asserted contract before this value is consumed.
    const raw =
      parsed !== null && parsed instanceof Object && !(parsed instanceof Function)
        ? // SAFETY: The runtime guard or typed fixture immediately above this assertion establishes the required invariant.
          // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
          (parsed as { approved?: unknown; reason?: unknown })
        : null;
    const approved = readBoolean(raw?.approved);
    const reason = readString(raw?.reason);
    if (approved !== null && (reason !== null || raw?.reason === undefined)) {
      return { approved, reason: reason ?? "unknown" };
    }
    return { approved: false, reason: "unknown" };
  } catch {
    // DB-sourced riskResultJson may be malformed (older rows, partial writes);
    // a bad parse must never fail the whole getRecentDecisions call.
    return { approved: false, reason: "unknown" };
  }
}

function readBoolean<T>(value: T): boolean | null {
  // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
  return Object.prototype.toString.call(value) === "[object Boolean]" ? (value as boolean) : null;
}

function readString<T>(value: T): string | null {
  // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
  return Object.prototype.toString.call(value) === "[object String]" ? (value as string) : null;
}

export const AuditLive = Layer.effect(
  AuditService,
  Effect.gen(function* () {
    const db = yield* DbService;

    const api: AuditApi = {
      recordDecision: (record) =>
        Effect.gen(function* () {
          yield* db.saveAudit({
            // Unique per decision: a pool now yields several decisions in one
            // cycle (multiple positions), and two same-pool decisions in the
            // same millisecond must not collide on the primary key.
            id: `${record.cycleId}-${record.poolAddress}-${record.timestamp}-${randomUUID()}`,
            timestamp: record.timestamp,
            cycleId: record.cycleId,
            poolAddress: record.poolAddress,
            action: record.action,
            confidence: record.confidence,
            reasoning: record.reasoning,
            metricsJson: record.metrics ? stringifySafe(record.metrics) : null,
            riskResultJson: stringifySafe(record.riskResult),
            executed: record.executed,
            paperTrading: record.paperTrading,
            txSignature: record.txSignature ?? null,
            error: record.error ?? null,
          });
        }),

      getRecentDecisions: (limit = 100) =>
        Effect.gen(function* () {
          const rows = yield* db.getRecentAudit(limit);
          return rows.map((row) => ({
            timestamp: row.timestamp,
            cycleId: row.cycleId,
            poolAddress: row.poolAddress,
            action: row.action,
            confidence: row.confidence,
            reasoning: row.reasoning,
            metrics: row.metricsJson ? parseBigIntSafe<PoolMetrics>(row.metricsJson) : undefined,
            riskResult: parseRiskResult(row.riskResultJson),
            executed: row.executed,
            paperTrading: row.paperTrading,
            txSignature: row.txSignature ?? undefined,
            error: row.error ?? undefined,
          }));
        }),
    };

    return api;
  }),
);
