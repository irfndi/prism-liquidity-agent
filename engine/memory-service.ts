import { Context, Effect, Layer } from "effect";
import { MemoryService, type MemoryApi } from "./services.js";
import { DbService } from "./services.js";
import type { MemoryCategory, MemoryEntry } from "./types.js";

export const MemoryLive = Layer.effect(
  MemoryService,
  Effect.gen(function* () {
    const db = yield* DbService;

    const api: MemoryApi = {
      initialize: () => Effect.succeed(void 0),

      upsert: (entry) =>
        Effect.gen(function* () {
          const content = entry.content ?? `${entry.category} entry`;
          yield* db.insertMemory({
            content,
            category: entry.category,
            poolAddress: entry.poolAddress,
            outcome: entry.outcome,
            pnlUsd: entry.pnlUsd,
            confidence: entry.confidence,
          });
        }),

      getRelevantContext: (query, topK = 5, poolAddress) =>
        Effect.gen(function* () {
          return yield* db.queryMemory(query, topK, poolAddress);
        }),

      pruneExpired: () =>
        Effect.gen(function* () {
          return yield* db.pruneMemory();
        }),

      recordOutcome: (poolAddress, action, pnlUsd, context) =>
        Effect.gen(function* () {
          const outcome = pnlUsd > 0 ? "profit" : pnlUsd < 0 ? "loss" : "neutral";
          const content = `${action} on ${poolAddress}: PnL=$${pnlUsd.toFixed(2)}. Context: ${context}`;
          yield* db.insertMemory({
            content,
            category: "outcome",
            poolAddress,
            outcome,
            pnlUsd,
          });
        }),
    };

    return api;
  }),
);
