import { Effect, Layer } from "effect";
import { createLogger } from "./logger.js";
import type { AgentStateApi } from "./services.js";
import { AgentStateService, HttpStatusServerService } from "./services.js";
import type { AppConfig } from "./config-service.js";

const logger = createLogger("HttpStatusServer");

function sanitizeConfig(cfg: AppConfig): Record<string, unknown> {
  return {
    paperTrading: cfg.paperTrading,
    scanIntervalMs: cfg.scanIntervalMs,
    minPoolTvlUsd: cfg.minPoolTvlUsd,
    minFeeIlRatio: cfg.minFeeIlRatio,
    tvlDropExitPct: cfg.tvlDropExitPct,
    volumeAuthThreshold: cfg.volumeAuthThreshold,
    confidenceThreshold: cfg.confidenceThreshold,
    paperPortfolioUsd: cfg.paperPortfolioUsd,
    minBinUtilization: cfg.minBinUtilization,
    maxRebalanceRangeBins: cfg.maxRebalanceRangeBins,
    maxOpenPositions: cfg.maxOpenPositions,
    stopLossPct: cfg.stopLossPct,
    trailingStopPct: cfg.trailingStopPct,
    agentiveMode: cfg.agentiveMode,
    agentRuntime: cfg.agentRuntime,
    agentHttpPort: cfg.agentHttpPort,
    agentMcpEnabled: cfg.agentMcpEnabled,
  };
}

export class HttpStatusServer {
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly state: AgentStateApi,
  ) {}

  start(): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      if (this.server) return;
      const port = this.config.agentHttpPort;
      if (port === 0) return;

      this.server = Bun.serve({
        port,
        hostname: "127.0.0.1",
        fetch: async (request) => {
          const url = new URL(request.url);
          const snapshot = await Effect.runPromise(this.state.getSnapshot());

          if (url.pathname === "/health") {
            return Response.json({
              ok: true,
              uptimeMs: Date.now() - snapshot.programStartTime,
              version: "0.0.20",
            });
          }

          if (url.pathname === "/status") {
            return Response.json({
              uptimeMs: Date.now() - snapshot.programStartTime,
              scanCount: snapshot.scanCount,
              lastCycleAt: snapshot.lastCycleAt,
              portfolio: snapshot.portfolio,
            });
          }

          if (url.pathname === "/positions") {
            const pool = url.searchParams.get("pool");
            const positions = pool
              ? snapshot.positions.filter((p) => p.poolAddress === pool)
              : snapshot.positions;
            return Response.json({ positions });
          }

          if (url.pathname === "/decisions") {
            const limitParam = parseInt(url.searchParams.get("limit") ?? "10", 10);
            const limit = Number.isFinite(limitParam) && limitParam >= 0 ? limitParam : 10;
            const pool = url.searchParams.get("pool");
            let decisions = snapshot.recentDecisions;
            if (pool) {
              decisions = decisions.filter((d) => d.poolAddress === pool);
            }
            return Response.json({ decisions: decisions.slice(0, limit) });
          }

          if (url.pathname === "/config") {
            return Response.json(sanitizeConfig(this.config));
          }

          return new Response("Not found", { status: 404 });
        },
      });

      logger.info("HTTP status server listening", { port });
    });
  }

  stop(): Effect.Effect<void, unknown> {
    return Effect.sync(() => {
      if (this.server) {
        this.server.stop();
        this.server = null;
        logger.info("HTTP status server stopped");
      }
    });
  }
}

export function HttpStatusServerLive(
  config: AppConfig,
): Layer.Layer<HttpStatusServerService, never, AgentStateService> {
  return Layer.effect(
    HttpStatusServerService,
    Effect.gen(function* () {
      const state = yield* AgentStateService;
      const server = new HttpStatusServer(config, state);
      return {
        start: () =>
          server.start().pipe(
            Effect.catchAll((err) => {
              logger.error("HTTP status server failed", { error: String(err) });
              return Effect.void;
            }),
          ),
        stop: () =>
          server.stop().pipe(
            Effect.catchAll((err) => {
              logger.error("HTTP status server stop failed", { error: String(err) });
              return Effect.void;
            }),
          ),
      };
    }),
  );
}
