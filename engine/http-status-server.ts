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

    if (!this.config.agentiveMode || this.config.agentProposalMode === "veto") {
      return new Response("Agent proposals are not consumed in the current mode", {
        status: 409,
      });
    }

    // Supervised mode can only consume human-approved proposals. Without an
    // approval token nothing can ever leave pending, so reject enqueue early
    // rather than accepting IDs that will only expire.
    if (
      this.config.agentProposalMode === "supervised" &&
      this.config.agentApprovalToken.length === 0
    ) {
      return Response.json(
        {
          error: "approval_token_required",
          message:
            "AGENT_PROPOSAL_MODE=supervised requires AGENT_APPROVAL_TOKEN so proposals can be approved",
        },
        { status: 409 },
      );
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

      // Last-wins per pool within a single batch so we never advertise IDs that
      // were immediately superseded by a later item in the same request.
      const lastIndexByPool = new Map<string, number>();
      for (let i = 0; i < proposals.length; i++) {
        const pool = proposals[i]?.poolAddress;
        if (pool !== undefined) lastIndexByPool.set(pool, i);
      }
      const deduped = proposals.filter((p, i) => lastIndexByPool.get(p.poolAddress) === i);

      const acceptedIds: string[] = [];
      const replacedIds: string[] = [];
      const skipped: Array<{
        readonly poolAddress: string;
        readonly proposalId: string;
        readonly reason: "approved_exists";
      }> = [];
      for (const proposal of deduped) {
        const result = yield* this.state.enqueueProposal(proposal);
        if (result.status === "rejected") {
          // Exhaustive on EnqueueProposalResult["reason"] so new reasons fail
          // closed (and TypeScript errors) instead of being silently dropped.
          switch (result.reason) {
            case "queue_full":
              // Global — fail closed for the rest of the batch.
              return Response.json(
                {
                  accepted: acceptedIds.length,
                  proposalIds: acceptedIds,
                  ...(replacedIds.length > 0 && { replacedIds }),
                  ...(skipped.length > 0 && { skipped }),
                  error: "queue_full",
                  message:
                    `Proposal queue full (max ${this.config.agentProposalMaxQueueSize})` +
                    (acceptedIds.length > 0
                      ? ` after accepting ${acceptedIds.length} of ${deduped.length}`
                      : ""),
                },
                { status: 503 },
              );
            case "approved_exists":
              // Pool-specific: skip this item and continue so healthy pools
              // in the same batch still enqueue.
              skipped.push({
                poolAddress: proposal.poolAddress,
                proposalId: proposal.proposalId,
                reason: "approved_exists",
              });
              continue;
            default: {
              const unexpected: never = result.reason;
              return Response.json(
                {
                  accepted: acceptedIds.length,
                  proposalIds: acceptedIds,
                  ...(replacedIds.length > 0 && { replacedIds }),
                  ...(skipped.length > 0 && { skipped }),
                  error: "enqueue_rejected",
                  message: `Unhandled enqueue rejection: ${String(unexpected)}`,
                },
                { status: 500 },
              );
            }
          }
        }
        if (result.status === "replaced") {
          replacedIds.push(...result.replacedIds);
        }
        if (result.status === "enqueued" || result.status === "replaced") {
          acceptedIds.push(proposal.proposalId);
        }
      }

      if (acceptedIds.length === 0 && skipped.length > 0) {
        return Response.json(
          {
            accepted: 0,
            proposalIds: [],
            skipped,
            error: "approved_exists",
            poolAddresses: skipped.map((s) => s.poolAddress),
            message:
              "An approved proposal already exists for the requested pool(s); wait for it to execute or expire before re-proposing",
          },
          { status: 409 },
        );
      }

      return Response.json(
        {
          accepted: acceptedIds.length,
          proposalIds: acceptedIds,
          ...(replacedIds.length > 0 && { replacedIds }),
          ...(skipped.length > 0 && { skipped }),
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
    // Fail-closed: approve requires an explicit approval token. Do not fall
    // back to the proposal enqueue credential — that would collapse the
    // supervised human boundary if a single token leaks.
    const expectedToken = this.config.agentApprovalToken;
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
        // closeActiveConnections avoids TIME_WAIT races when tests rebind ports.
        this.server.stop(true);
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
