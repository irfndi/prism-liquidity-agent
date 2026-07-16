import { Effect, Layer } from "effect";
import crypto from "node:crypto";
import { createLogger } from "./logger.js";
import type { AgentStateApi } from "./services.js";
import { AgentStateService, McpServerService } from "./services.js";
import type { AppConfig } from "./config-service.js";

const logger = createLogger("McpServer");
const MAX_STDIN_BUFFER_LENGTH = 65536;

interface McpRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number;
  readonly method: string;
  readonly params?: unknown;
}

interface McpResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

const tools: ReadonlyArray<McpTool> = [
  {
    name: "prism_status",
    description: "Get a high-level status snapshot of the Prism trading agent.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "prism_positions",
    description: "List open positions with deposited value, current value, and bin ranges.",
    inputSchema: {
      type: "object",
      properties: {
        pool: { type: "string", description: "Optional pool address to filter by" },
      },
    },
  },
  {
    name: "prism_decisions",
    description: "Get recent decision history from the audit log.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum number of decisions to return" },
        pool: { type: "string", description: "Optional pool address to filter by" },
      },
    },
  },
  {
    name: "prism_config",
    description: "Get sanitized configuration (no secrets) for the running agent.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "prism_agent_policy",
    description:
      "Get the current agent policy snapshot (proposal mode, hard caps, circuit breaker).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "prism_pending_proposals",
    description: "List pending agent proposals that are awaiting approval in supervised mode.",
    inputSchema: {
      type: "object",
      properties: {
        pool: { type: "string", description: "Optional pool address to filter by" },
      },
    },
  },
  {
    name: "prism_approve_proposals",
    description:
      "Approve one or more pending agent proposals so they can execute in supervised mode. Requires the approval token configured for the engine.",
    inputSchema: {
      type: "object",
      properties: {
        proposalIds: {
          type: "array",
          items: { type: "string" },
          description: "Proposal IDs to approve",
        },
        token: {
          type: "string",
          description: "Approval token (AGENT_APPROVAL_TOKEN, or AGENT_PROPOSAL_TOKEN if unset)",
        },
      },
      required: ["proposalIds", "token"],
    },
  },
];

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

export class McpServer {
  private running = false;
  private dataHandler: ((chunk: string | Buffer) => void) | undefined = undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly state: AgentStateApi,
  ) {}

  private send(response: McpResponse): void {
    const line = JSON.stringify(response);
    process.stdout.write(`${line}\n`);
  }

  private async handleInitialize(): Promise<McpResponse["result"]> {
    return {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: "prism-mcp",
        version: "0.0.20",
      },
    };
  }

  private async handleToolsList(): Promise<McpResponse["result"]> {
    return { tools };
  }

  private async handleToolsCall(params: unknown): Promise<McpResponse["result"]> {
    const args =
      typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
    const name = args.name;
    const arguments_ = (args.arguments as Record<string, unknown>) ?? {};
    const snapshot = await Effect.runPromise(this.state.getSnapshot());

    switch (name) {
      case "prism_status": {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                uptimeMs: Date.now() - snapshot.programStartTime,
                scanCount: snapshot.scanCount,
                lastCycleAt: snapshot.lastCycleAt,
                portfolio: snapshot.portfolio,
              }),
            },
          ],
        };
      }
      case "prism_positions": {
        const pool = arguments_.pool as string | undefined;
        const positions = pool
          ? snapshot.positions.filter((p) => p.poolAddress === pool)
          : snapshot.positions;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ positions }),
            },
          ],
        };
      }
      case "prism_decisions": {
        const limit = typeof arguments_.limit === "number" ? arguments_.limit : 10;
        const pool = arguments_.pool as string | undefined;
        let decisions = snapshot.recentDecisions;
        if (pool) {
          decisions = decisions.filter((d) => d.poolAddress === pool);
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ decisions: decisions.slice(0, limit) }),
            },
          ],
        };
      }
      case "prism_config": {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(sanitizeConfig(this.config)),
            },
          ],
        };
      }
      case "prism_agent_policy": {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(snapshot.agentPolicy),
            },
          ],
        };
      }
      case "prism_pending_proposals": {
        const pool = arguments_.pool as string | undefined;
        const proposals = pool
          ? snapshot.pendingProposals.filter((p) => p.poolAddress === pool)
          : snapshot.pendingProposals;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ proposals }),
            },
          ],
        };
      }
      case "prism_approve_proposals": {
        // Approvals are the human boundary of supervised mode: require the
        // same credential as the HTTP /approve endpoint so an MCP-capable
        // advisor cannot approve its own proposals.
        const expectedToken =
          this.config.agentApprovalToken.length > 0
            ? this.config.agentApprovalToken
            : this.config.agentProposalToken;
        const providedToken = typeof arguments_.token === "string" ? arguments_.token : "";
        const expectedBuf = Buffer.from(expectedToken);
        const actualBuf = Buffer.from(providedToken);
        if (
          expectedToken.length === 0 ||
          actualBuf.length !== expectedBuf.length ||
          !crypto.timingSafeEqual(actualBuf, expectedBuf)
        ) {
          throw new Error("Unauthorized: invalid approval token");
        }
        const proposalIds = Array.isArray(arguments_.proposalIds)
          ? arguments_.proposalIds.filter((id): id is string => typeof id === "string")
          : [];
        if (proposalIds.length === 0) {
          throw new Error("proposalIds must be a non-empty array of strings");
        }
        const snapshot = await Effect.runPromise(this.state.getSnapshot());
        const pendingIds = new Set(snapshot.pendingProposals.map((p) => p.proposalId));
        const missing = proposalIds.filter((id) => !pendingIds.has(id));
        if (missing.length > 0) {
          throw new Error(`Proposal IDs not found: ${missing.join(", ")}`);
        }
        for (const proposalId of proposalIds) {
          await Effect.runPromise(this.state.approveProposal(proposalId));
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ approved: proposalIds.length }),
            },
          ],
        };
      }
      default: {
        throw new Error(`Unknown tool: ${String(name)}`);
      }
    }
  }

  private async handleRequest(request: McpRequest): Promise<McpResponse | undefined> {
    const id = request.id ?? null;
    if (request.jsonrpc !== "2.0") {
      return {
        jsonrpc: "2.0",
        id: id ?? 0,
        error: { code: -32600, message: "Invalid Request" },
      };
    }

    try {
      switch (request.method) {
        case "initialize":
          return { jsonrpc: "2.0", id: id ?? 0, result: await this.handleInitialize() };
        case "tools/list":
          return { jsonrpc: "2.0", id: id ?? 0, result: await this.handleToolsList() };
        case "tools/call":
          return {
            jsonrpc: "2.0",
            id: id ?? 0,
            result: await this.handleToolsCall(request.params),
          };
        case "notifications/initialized":
          // JSON-RPC notifications are one-way; do not send a response.
          return undefined;
        default:
          return {
            jsonrpc: "2.0",
            id: id ?? 0,
            error: { code: -32601, message: `Method not found: ${request.method}` },
          };
      }
    } catch (err) {
      logger.error("MCP request failed", { error: String(err) });
      return {
        jsonrpc: "2.0",
        id: id ?? 0,
        error: { code: -32603, message: String(err) },
      };
    }
  }

  start(): Effect.Effect<void, unknown> {
    return Effect.tryPromise(async () => {
      if (this.running) return;
      this.running = true;
      logger.info("MCP server started on stdio");

      const buffer: string[] = [];
      process.stdin.setEncoding("utf8");
      this.dataHandler = async (chunk) => {
        const text = chunk.toString();
        for (const char of text) {
          if (char === "\n") {
            const line = buffer.join("").trim();
            buffer.length = 0;
            if (!line) continue;
            try {
              const request = JSON.parse(line) as McpRequest;
              const response = await this.handleRequest(request);
              if (response !== undefined) {
                this.send(response);
              }
            } catch (err) {
              logger.error("Failed to parse MCP request", { error: String(err) });
              this.send({
                jsonrpc: "2.0",
                id: 0,
                error: { code: -32700, message: "Parse error" },
              });
            }
          } else {
            if (buffer.length >= MAX_STDIN_BUFFER_LENGTH) {
              logger.error("MCP stdin buffer exceeded max length; discarding");
              buffer.length = 0;
            }
            buffer.push(char);
          }
        }
      };
      process.stdin.on("data", this.dataHandler);
    });
  }

  stop(): Effect.Effect<void, unknown> {
    return Effect.sync(() => {
      this.running = false;
      if (this.dataHandler) {
        process.stdin.removeListener("data", this.dataHandler);
        this.dataHandler = undefined;
      }
      logger.info("MCP server stopped");
    });
  }
}
export function McpServerLive(
  config: AppConfig,
): Layer.Layer<McpServerService, never, AgentStateService> {
  return Layer.effect(
    McpServerService,
    Effect.gen(function* () {
      const state = yield* AgentStateService;
      const server = new McpServer(config, state);
      return {
        start: () =>
          server.start().pipe(
            Effect.catchAll((err) => {
              logger.error("MCP server failed", { error: String(err) });
              return Effect.void;
            }),
          ),
        stop: () =>
          server.stop().pipe(
            Effect.catchAll((err) => {
              logger.error("MCP server stop failed", { error: String(err) });
              return Effect.void;
            }),
          ),
      };
    }),
  );
}
