import { Effect, Layer } from "effect";
import type { AppConfig } from "./config-service.js";
import type { AgentDecision, ActionType, PoolMetrics, PoolState, MemoryEntry } from "./types.js";
import type { AgentApi, DecisionRecord } from "./services.js";
import { AgentService } from "./services.js";
import { createLogger } from "./logger.js";
import { detectAgents } from "./agent-detection.js";
import { AcpTransport } from "./acp-transport.js";
import { GatewayTransport } from "./gateway-transport.js";
import type {
  AgentRuntimeContext,
  AgentRuntimeDetection,
  AgentRuntimeResponse,
  AgentRuntimeTransport,
  AgentRuntimeCheckin,
  AgentRuntimeAlert,
} from "./agent-transport.js";
import { OpenClawWebhookTransport } from "./openclaw-webhook-transport.js";
import { HermesApiTransport } from "./hermes-api-transport.js";

const logger = createLogger("AgentService");

const VALID_ACTIONS: ReadonlySet<string> = new Set(["HOLD", "REBALANCE", "EXIT", "ENTER"]);

interface ParsedAgentResponse {
  action?: string;
  confidence?: number;
  reasoning?: string;
}

export const AgentNoOp: AgentApi = {
  enhanceDecision: () => Effect.succeed(null),
  sendCheckin: () => Effect.void,
  sendAlert: () => Effect.void,
  getStatus: () =>
    Effect.succeed({
      connected: false,
      transport: null,
      lastPromptAt: null,
      errorCount: 0,
    }),
};

function buildPrompt(decision: AgentDecision, ctx: AgentRuntimeContext): string {
  const { pool, metrics, warnings, recentDecisions } = ctx;

  const warningsBlock =
    warnings.length > 0
      ? warnings.map((w) => `  - [${w.category}] ${w.content}`).join("\n")
      : "  (none)";

  const decisionsBlock =
    recentDecisions.length > 0
      ? recentDecisions
          .slice(0, 10)
          .map(
            (d) =>
              `  - ${d.action} (confidence: ${d.confidence.toFixed(2)}) @ ${new Date(d.timestamp).toISOString()}: ${d.reasoning}`,
          )
          .join("\n")
      : "  (none)";

  return `You are a liquidity pool risk overlay. Review the deterministic agent's decision and optionally override it.

RULES (strict — you must follow them):
- You may ONLY reduce confidence or change action to HOLD.
- You may NEVER increase confidence.
- You may NEVER promote a non-ENTER action to ENTER.
- You may NEVER change HOLD/ENTER/REBALANCE into EXIT.
- If the decision looks reasonable, return the same action and confidence.

DECISION TO REVIEW:
Action: ${decision.action}
Confidence: ${decision.confidence.toFixed(2)}
Reasoning: ${decision.reasoning}
Pool: ${pool.tokenXSymbol}/${pool.tokenYSymbol} (${pool.address})
TVL: $${pool.tvlUsd.toFixed(0)}
24h Volume: $${pool.volume24hUsd.toFixed(0)}
24h Fees: $${pool.fees24hUsd.toFixed(0)}
APR: ${pool.apr.toFixed(2)}%

METRICS:
- Fee/IL Ratio: ${metrics.feeIlRatio.toFixed(2)}
- Volume Authenticity: ${metrics.volumeAuthenticity.toFixed(2)}
- Bin Utilization: ${metrics.binUtilization.toFixed(2)}
- TVL Velocity: ${(metrics.tvlVelocity * 100).toFixed(1)}%

MEMORY WARNINGS:
${warningsBlock}

RECENT DECISIONS:
${decisionsBlock}

Respond with JSON only:
{"action": "HOLD|REBALANCE|EXIT|ENTER", "confidence": 0.0-1.0, "reasoning": "..."}
`;
}

export function parseResponse(raw: string): ParsedAgentResponse {
  const cleaned = raw.trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return {};
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as ParsedAgentResponse;
  } catch {
    return {};
  }
}

export function validateOverride(
  original: AgentDecision,
  parsed: ParsedAgentResponse,
): AgentDecision | null {
  if (
    parsed.action === undefined &&
    parsed.confidence === undefined &&
    parsed.reasoning === undefined
  ) {
    return null;
  }

  const action: ActionType | undefined =
    parsed.action && VALID_ACTIONS.has(parsed.action) ? (parsed.action as ActionType) : undefined;

  let newConfidence = original.confidence;
  if (parsed.confidence !== undefined) {
    if (Number.isFinite(parsed.confidence)) {
      newConfidence = Math.max(0, Math.min(1, parsed.confidence));
    }
  }

  // Agent overlay can only reduce confidence, never increase it.
  if (newConfidence > original.confidence) {
    newConfidence = original.confidence;
  }

  let newAction = original.action;
  if (action) {
    if (action === "HOLD") {
      newAction = "HOLD";
    } else if (action === original.action) {
      newAction = original.action;
    } else {
      return null;
    }
  }

  const hasChange = newAction !== original.action || newConfidence !== original.confidence;
  if (!hasChange) return null;

  return {
    ...original,
    action: newAction,
    confidence: newConfidence,
    reasoning:
      parsed.reasoning?.trim() ||
      `[agent-overlay] adjusted to ${newAction} (${newConfidence.toFixed(2)})`,
  };
}

function selectTransport(
  config: AppConfig,
  detection: AgentRuntimeDetection,
): AgentRuntimeTransport | null {
  const runtime = config.agentRuntime === "auto" ? detection.recommended : config.agentRuntime;

  if (runtime === "hermes" && detection.hermes.available) {
    return new AcpTransport({
      command: config.agentAcpCommand,
      args: config.agentAcpArgs,
      timeoutMs: config.agentPromptTimeoutMs,
    });
  }

  if (runtime === "openclaw" && detection.openclaw.gatewayRunning) {
    return new GatewayTransport({
      url: config.agentGatewayUrl,
      token: config.agentGatewayToken,
      timeoutMs: config.agentPromptTimeoutMs,
    });
  }

  return null;
}

function createAlertTransports(config: AppConfig): ReadonlyArray<AgentRuntimeTransport> {
  const transports: AgentRuntimeTransport[] = [];

  if (config.agentOpenclawWebhookUrl) {
    transports.push(
      new OpenClawWebhookTransport({
        url: config.agentOpenclawWebhookUrl,
        timeoutMs: config.agentPromptTimeoutMs,
      }),
    );
  }

  if (config.agentHermesApiUrl) {
    transports.push(
      new HermesApiTransport({
        url: config.agentHermesApiUrl,
        token: "",
        timeoutMs: config.agentPromptTimeoutMs,
      }),
    );
  }

  return transports;
}

function transportSupportsAlert(
  transport: AgentRuntimeTransport,
): transport is AgentRuntimeTransport & {
  sendAlert: (alert: AgentRuntimeAlert) => Effect.Effect<void, unknown>;
} {
  return typeof transport.sendAlert === "function";
}

function connectTransport(transport: AgentRuntimeTransport): Effect.Effect<void, unknown> {
  return transport.connect().pipe(
    Effect.catchAll((err) => {
      logger.warn("Failed to connect transport", { transport: transport.name, error: String(err) });
      return Effect.void;
    }),
  );
}

function sendToAlertTransports(
  transports: ReadonlyArray<AgentRuntimeTransport>,
  alert: AgentRuntimeAlert,
): Effect.Effect<void, unknown> {
  const effects = transports.filter(transportSupportsAlert).map((transport) =>
    transport.sendAlert(alert).pipe(
      Effect.catchAll((err) => {
        logger.warn("Failed to send alert", { transport: transport.name, error: String(err) });
        return Effect.void;
      }),
    ),
  );
  return Effect.all(effects, { discard: true });
}

export function AgentLive(config: AppConfig): Layer.Layer<AgentService, never, never> {
  return Layer.effect(
    AgentService,
    Effect.gen(function* () {
      if (!config.agentiveMode) {
        return AgentNoOp;
      }

      const detection = yield* detectAgents({
        agentAcpCommand: config.agentAcpCommand,
        agentGatewayUrl: config.agentGatewayUrl,
      }).pipe(
        Effect.catchAll(() =>
          Effect.succeed({
            hermes: { available: false, path: null },
            openclaw: { available: false, path: null, gatewayRunning: false },
            recommended: "none" as const,
          }),
        ),
      );

      const transport = selectTransport(config, detection);
      const alertTransports = createAlertTransports(config);

      if (!transport && alertTransports.length === 0) {
        const runtime =
          config.agentRuntime === "auto" ? detection.recommended : config.agentRuntime;
        logger.warn("Agent mode enabled but no runtime available", {
          requested: config.agentRuntime,
          selected: runtime,
          detection,
        });
        return AgentNoOp;
      }

      const allTransports: AgentRuntimeTransport[] = [];
      if (transport) allTransports.push(transport);
      allTransports.push(...alertTransports);

      for (const t of allTransports) {
        t.onEvent((event) => {
          if (event.type === "error") {
            logger.warn("Agent runtime error", {
              transport: event.transport,
              error: event.error,
            });
          } else {
            logger.debug("Agent runtime event", event);
          }
        });
      }

      let connected = false;
      let lastPromptAt: number | null = null;
      let errorCount = 0;

      if (transport) {
        yield* connectTransport(transport).pipe(
          Effect.tap(() => {
            connected = true;
          }),
          Effect.catchAll((err) => {
            connected = false;
            errorCount += 1;
            logger.error("Failed to connect to agent runtime", { error: String(err) });
            return Effect.void;
          }),
        );
      }

      for (const t of alertTransports) {
        yield* connectTransport(t).pipe(
          Effect.tap(() => {
            connected = true;
          }),
        );
      }

      return {
        enhanceDecision: (decision: AgentDecision, context: AgentRuntimeContext) => {
          if (!transport) {
            return Effect.succeed(null);
          }
          const prompt = buildPrompt(decision, context);
          return transport.sendPrompt(prompt, context).pipe(
            Effect.map((response: AgentRuntimeResponse) => {
              lastPromptAt = Date.now();
              const parsed = parseResponse(response.raw);
              const override = validateOverride(decision, parsed);
              if (override) {
                logger.info("Agent override", {
                  pool: decision.poolAddress,
                  originalAction: decision.action,
                  newAction: override.action,
                  originalConfidence: decision.confidence.toFixed(2),
                  newConfidence: override.confidence.toFixed(2),
                });
              }
              return override;
            }),
            Effect.catchAll((err) => {
              errorCount += 1;
              logger.warn("Agent prompt failed", {
                pool: decision.poolAddress,
                error: String(err),
              });
              return Effect.succeed(null);
            }),
          );
        },

        sendCheckin: (checkin: AgentRuntimeCheckin) => {
          if (!transport?.sendCheckin) {
            return Effect.void;
          }
          return transport.sendCheckin(checkin).pipe(
            Effect.catchAll((err) => {
              errorCount += 1;
              logger.warn("Agent check-in failed", { error: String(err) });
              return Effect.void;
            }),
          );
        },

        sendAlert: (alert: AgentRuntimeAlert) => {
          return sendToAlertTransports(allTransports, alert);
        },

        getStatus: () =>
          Effect.succeed({
            connected,
            transport: transport?.name ?? (alertTransports.length > 0 ? "alert-only" : null),
            lastPromptAt,
            errorCount,
          }),
      };
    }).pipe(
      Effect.catchAll((err) => {
        logger.error("Agent service initialization failed; falling back to no-op", {
          error: String(err),
        });
        return Effect.succeed(AgentNoOp);
      }),
    ),
  );
}
