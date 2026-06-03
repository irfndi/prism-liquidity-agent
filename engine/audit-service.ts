import { Context, Effect, Layer } from "effect";
import { AuditService, type AuditApi, type DecisionRecord } from "./services.js";
import { DbService } from "./services.js";
import type { PoolMetrics } from "./types.js";
import { bigintReplacer, stringifySafe } from "./bigint-json.js";

export const AuditLive = Layer.effect(
  AuditService,
  Effect.gen(function* () {
    const db = yield* DbService;

    const api: AuditApi = {
      recordDecision: (record) =>
        Effect.gen(function* () {
          yield* db.saveAudit({
            id: `${record.cycleId}-${record.poolAddress}-${record.timestamp}`,
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
            metrics: row.metricsJson
              ? (JSON.parse(row.metricsJson, bigintReplacer) as PoolMetrics)
              : undefined,
            riskResult: row.riskResultJson
              ? (JSON.parse(row.riskResultJson) as {
                  approved: boolean;
                  reason: string;
                  adjustedSizeUsd?: number;
                })
              : { approved: false, reason: "unknown" },
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
