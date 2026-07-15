import { Effect, Layer } from "effect";
import crypto from "node:crypto";
import { createLogger } from "./logger.js";
import type { AgentStateApi } from "./services.js";
import { AgentStateService, HttpStatusServerService } from "./services.js";
import type { AppConfig } from "./config-service.js";
import type { PrismStateSnapshot } from "./state-service.js";
import type { AgentProposal } from "./types.js";
import { parseHttpQueueProposal, ProposalParseError } from "./proposal-schema.js";

const logger = createLogger("HttpStatusServer");

function sanitizeConfig(cfg: AppConfig, snapshot: PrismStateSnapshot): Record<string, unknown> {
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

  private async handlePropose(request: Request): Promise<Response> {
    const authHeader = request.headers.get("Authorization") ?? "";
    const providedToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : "";
    const expectedToken = this.config.agentProposalToken;
    if (expectedToken.length === 0) {
      return new Response("Unauthorized", { status: 401 });
    }

    const expectedBuf = Buffer.from(expectedToken);
    const actualBuf = Buffer.from(providedToken);
    if (
      actualBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(actualBuf, expectedBuf)
    ) {
      return new Response("Unauthorized", { status: 401 });
    }

    let parsedBody: unknown;
    try {
      parsedBody = await request.json();
    } catch (e) {
      if (e instanceof SyntaxError) {
        return new Response("Invalid JSON body", { status: 400 });
      }
      throw e;
    }

    const items = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
    const maxBatchSize = this.config.agentProposalMaxBatchSize;
    if (items.length > maxBatchSize) {
      return new Response(`Batch size ${items.length} exceeds limit ${maxBatchSize}`, {
        status: 413,
      });
    }

    const effect = Effect.gen(this, function* () {
      const proposals: AgentProposal[] = [];
      for (const [index, item] of items.entries()) {
        if (item === null || typeof item !== "object") {
          return new Response("Invalid proposal body", { status: 400 });
        }
        const raw = JSON.stringify(item);
        const proposal = yield* parseHttpQueueProposal(
          raw,
          crypto.randomUUID(),
          "http-queue",
          this.config.agentProposalStaleMs,
        ).pipe(
          Effect.mapError(
            (err) =>
              new ProposalParseError({
                message: `Invalid proposal at index ${index}: ${err.message}`,
              }),
          ),
        );
        proposals.push(proposal);
      }
      yield* Effect.forEach(proposals, (proposal) => this.state.enqueueProposal(proposal), {
        discard: true,
      });
      return Response.json(
        {
          accepted: proposals.length,
          proposalIds: proposals.map((p) => p.proposalId),
        },
        { status: 202 },
      );
    }).pipe(
      Effect.catchTag("ProposalParseError", (err) =>
        Effect.succeed(new Response(err.message, { status: 400 })),
      ),
    );

    return await Effect.runPromise(effect);
  }

  private async handleApprove(request: Request): Promise<Response> {
    const authHeader = request.headers.get("Authorization") ?? "";
    const providedToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : "";
    const expectedToken =
      this.config.agentApprovalToken.length > 0
        ? this.config.agentApprovalToken
        : this.config.agentProposalToken;
    if (expectedToken.length === 0) {
      return new Response("Unauthorized", { status: 401 });
    }

    const expectedBuf = Buffer.from(expectedToken);
    const actualBuf = Buffer.from(providedToken);
    if (
      actualBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(actualBuf, expectedBuf)
    ) {
      return new Response("Unauthorized", { status: 401 });
    }

    let parsedBody: unknown;
    try {
      parsedBody = await request.json();
    } catch (e) {
      if (e instanceof SyntaxError) {
        return new Response("Invalid JSON body", { status: 400 });
      }
      throw e;
    }

    if (
      parsedBody === null ||
      typeof parsedBody !== "object" ||
      !Array.isArray((parsedBody as Record<string, unknown>).proposalIds)
    ) {
      return new Response("Missing proposalIds array", { status: 400 });
    }

    const proposalIds = (parsedBody as { proposalIds: unknown }).proposalIds;
    if (!Array.isArray(proposalIds) || proposalIds.some((id) => typeof id !== "string")) {
      return new Response("proposalIds must be an array of strings", { status: 400 });
    }

    const maxBatchSize = this.config.agentProposalMaxBatchSize;
    if (proposalIds.length > maxBatchSize) {
      return new Response(`Batch size ${proposalIds.length} exceeds limit ${maxBatchSize}`, {
        status: 413,
      });
    }

    const snapshot = await Effect.runPromise(this.state.getSnapshot());
    const pendingIds = new Set(snapshot.pendingProposals.map((p) => p.proposalId));
    const ids = proposalIds as string[];
    const missing = ids.filter((id) => !pendingIds.has(id));
    if (missing.length > 0) {
      return Response.json({ error: "Proposal IDs not found", missing }, { status: 404 });
    }

    for (const proposalId of ids) {
      await Effect.runPromise(this.state.approveProposal(proposalId));
    }

    return Response.json({ approved: ids.length }, { status: 200 });
  }

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
            const limit = Math.min(
              Math.max(0, Number.isFinite(limitParam) && limitParam >= 0 ? limitParam : 10),
              100,
            );
            const pool = url.searchParams.get("pool");
            let decisions = snapshot.recentDecisions;
            if (pool) {
              decisions = decisions.filter((d) => d.poolAddress === pool);
            }
            return Response.json({ decisions: decisions.slice(0, limit) });
          }

          if (url.pathname === "/config") {
            return Response.json(sanitizeConfig(this.config, snapshot));
          }

          if (url.pathname === "/agent-policy") {
            return Response.json(snapshot.agentPolicy);
          }

          if (url.pathname === "/propose") {
            return this.handlePropose(request);
          }

          if (url.pathname === "/approve") {
            return this.handleApprove(request);
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
