import { Effect, Layer } from "effect";
import type { AppConfig } from "./config-service.js";
import type { AgentDecision, ActionType } from "./types.js";
import type { AgentApi } from "./services.js";
import { AgentService } from "./services.js";
import { underlyingErrorMessage } from "./errors.js";
import { createLogger } from "./logger.js";
import { detectAgents } from "./agent-detection.js";
import { AcpTransport } from "./acp-transport.js";
import { GatewayTransport } from "./gateway-transport.js";
import { parseProposalResponse } from "./proposal-schema.js";
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

/** Rolling p95 latency gate for budget-constrained advisor prompts (veto
 *  reviews and sync proposals). Samples are timestamped and age out, so a
 *  transient slow period cannot latch the skip on permanently: once the model
 *  recovers, the window drains and the skip disengages without a restart.
 *  The skip engages only when BOTH the fresh-window p95 reaches 95% of the
 *  prompt budget AND enough individual samples are slow — a single timeout
 *  among quick reviews must not silence the advisor. */
export class LatencyWindow {
  private readonly samples: Array<{ readonly latencyMs: number; readonly at: number }> = [];

  constructor(
    private readonly opts: {
      /** Prompt budget; the skip engages when p95 >= 95% of it. */
      readonly budgetMs: number;
      readonly windowSize?: number;
      readonly minSamples?: number;
      readonly minSlowSamples?: number;
      readonly sampleMaxAgeMs?: number;
    },
  ) {}

  private get windowSize(): number {
    return this.opts.windowSize ?? 20;
  }

  private get minSamples(): number {
    return this.opts.minSamples ?? 5;
  }

  private get minSlowSamples(): number {
    return this.opts.minSlowSamples ?? 3;
  }

  private get sampleMaxAgeMs(): number {
    return this.opts.sampleMaxAgeMs ?? 30 * 60 * 1000;
  }

  record(latencyMs: number, now: number): void {
    this.samples.push({ latencyMs, at: now });
    this.evict(now);
  }

  private evict(now: number): void {
    const cutoff = now - this.sampleMaxAgeMs;
    while (this.samples.length > 0) {
      const oldest = this.samples[0]!;
      if (oldest.at < cutoff || this.samples.length > this.windowSize) {
        this.samples.shift();
      } else {
        break;
      }
    }
  }

  /** Whether a prompt should be skipped right now (fail-open), with the
   *  stats the caller logs when it is. */
  shouldSkip(now: number): {
    readonly skip: boolean;
    readonly p95Ms: number | null;
    readonly slowCount: number;
    readonly windowSize: number;
  } {
    this.evict(now);
    const sorted = this.samples.map((s) => s.latencyMs).sort((a, b) => a - b);
    const p95 =
      sorted.length === 0
        ? null
        : sorted[Math.max(0, Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1))]!;
    const threshold = this.opts.budgetMs * 0.95;
    const slowCount = this.samples.filter((s) => s.latencyMs >= threshold).length;
    return {
      skip:
        this.samples.length >= this.minSamples &&
        slowCount >= this.minSlowSamples &&
        p95 !== null &&
        p95 >= threshold,
      p95Ms: p95,
      slowCount,
      windowSize: this.samples.length,
    };
  }
}

interface ParsedAgentResponse {
  action?: string;
  confidence?: number;
  reasoning?: string;
}

export const AgentNoOp: AgentApi = {
  enhanceDecision: () => Effect.succeed(null),
  shouldSkipSyncProposal: () => Effect.succeed(false),
  getPolicy: () =>
    Effect.succeed({
      mode: "veto" as const,
      proposalsQueued: 0,
      lastProposalAt: null,
      badProposalBackoffUntil: null,
      circuitBreakerOpen: false,
      hardCaps: {
        maxPositionSizePct: 0.4,
        maxRebalanceRangeBins: 50,
        minProposalConfidence: 0.65,
        proposalStaleMs: 300_000,
      },
    }),
  sendCheckin: () => Effect.void,
  sendAlert: () => Effect.void,
  getStatus: () =>
    Effect.succeed({
      connected: false,
      transport: null,
      lastPromptAt: null,
      errorCount: 0,
    }),
  disconnect: () => Effect.void,
};

function formatRuntimeContext(ctx: AgentRuntimeContext): {
  warningsBlock: string;
  decisionsBlock: string;
  positionBlock: string;
} {
  const { warnings, recentDecisions, position } = ctx;
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

  const positionBlock =
    position === undefined
      ? ""
      : [
          "POSITION:",
          `  Value: $${position.valueUsd.toFixed(2)} (deposited $${position.depositedUsd.toFixed(2)})`,
          `  Unrealized PnL: ${position.unrealizedPnlUsd >= 0 ? "+" : "−"}$${Math.abs(position.unrealizedPnlUsd).toFixed(2)} (fees claimed $${position.feesClaimedUsd.toFixed(2)}, rewards $${position.rewardsClaimedUsd.toFixed(2)})`,
          position.outOfRangeSinceMs === null
            ? "  In range: yes"
            : `  In range: NO — out of range ${position.hoursOutOfRange === null ? "?" : position.hoursOutOfRange.toFixed(1)}h (${position.oorCycleCount} OOR cycle(s))`,
          `  Age: ${position.hoursHeld.toFixed(1)}h | range: bins ${position.lowerBinId}..${position.upperBinId} (active ${position.activeBinId})`,
          `  Entry price: ${position.entryPriceUsd === null ? "n/a" : `$${position.entryPriceUsd.toFixed(6)}`} | peak value: ${position.highestValueUsd === null ? "n/a" : `$${position.highestValueUsd.toFixed(2)}`}`,
          `  Last rebalance: ${position.lastRebalanceAtMs === 0 ? "never" : new Date(position.lastRebalanceAtMs).toISOString()}`,
        ].join("\n");

  return { warningsBlock, decisionsBlock, positionBlock };
}

export function buildPrompt(decision: AgentDecision, ctx: AgentRuntimeContext): string {
  const { pool, metrics } = ctx;
  const { warningsBlock, decisionsBlock, positionBlock } = formatRuntimeContext(ctx);

  return `You are a liquidity pool risk overlay. Review the deterministic agent's decision and optionally override it.

RULES (strict — you must follow them):
- You may ONLY reduce confidence or change action to HOLD.
- You may NEVER increase confidence.
- You may NEVER promote a non-ENTER action to ENTER.
- You may NEVER change HOLD/ENTER/REBALANCE into EXIT.
- You may NEVER change EXIT into HOLD or any other action.
- If the decision looks reasonable, return the same action and confidence.
${positionBlock === "" ? "" : "- Base EXIT reviews on the position's PnL and out-of-range state below.\n"}
DECISION TO REVIEW:
Action: ${decision.action}
Confidence: ${decision.confidence.toFixed(2)}
Reasoning: ${decision.reasoning}
Pool: ${pool.tokenXSymbol}/${pool.tokenYSymbol} (${pool.address})
TVL: $${pool.tvlUsd.toFixed(0)}
24h Volume: $${pool.volume24hUsd.toFixed(0)}
24h Fees: $${pool.fees24hUsd.toFixed(0)}
APR: ${pool.apr.toFixed(2)}%
${positionBlock === "" ? "" : `\n${positionBlock}`}
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

export function buildProposalPrompt(decision: AgentDecision, ctx: AgentRuntimeContext): string {
  const { pool, metrics } = ctx;
  const { warningsBlock, decisionsBlock, positionBlock } = formatRuntimeContext(ctx);
  const currentParamsBlock = [
    decision.positionSizeUsd !== undefined
      ? `Position Size: $${decision.positionSizeUsd.toFixed(0)}`
      : null,
    decision.rebalanceParams !== undefined
      ? `Bin Range: ${decision.rebalanceParams.newLowerBinId} to ${decision.rebalanceParams.newUpperBinId}`
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  // Mirror the validator's action limits so compliant advisors are not
  // penalized for impossible promotions or downgrades. For ENTER the pool has
  // no open position, so REBALANCE/EXIT are not executable either. For an
  // unheld default HOLD, only HOLD is executable.
  const allowedActions =
    decision.action === "EXIT"
      ? ["EXIT"]
      : decision.action === "ENTER"
        ? ["HOLD", "ENTER"]
        : ctx.hasOpenPosition
          ? ["HOLD", "REBALANCE", "EXIT"]
          : ["HOLD"];
  const allowedActionsText = allowedActions.join(", ");

  return `You are a liquidity pool strategy advisor. Review the deterministic agent's decision and propose the best action for this pool.

RULES (strict — you must follow them):
- You may propose only: ${allowedActionsText}.
- The engine will validate your proposal against safety gates; only safe proposals execute.
- ENTER proposals require positionSizeUsd (USD); REBALANCE proposals require rebalanceParams.
- When echoing the engine's action, reuse the current executable values shown below — do not invent new ones.
- Do not propose actions for pools outside the current context.
- If the engine's decision is already optimal, return the same action and confidence.
${positionBlock === "" ? "" : "- Base EXIT/REBALANCE proposals on the POSITION state below.\n"}
DECISION TO REVIEW:
Action: ${decision.action}
Confidence: ${decision.confidence.toFixed(2)}
Reasoning: ${decision.reasoning}
${currentParamsBlock === "" ? "" : `${currentParamsBlock}\n`}Pool: ${pool.tokenXSymbol}/${pool.tokenYSymbol} (${pool.address})
TVL: $${pool.tvlUsd.toFixed(0)}
24h Volume: $${pool.volume24hUsd.toFixed(0)}
24h Fees: $${pool.fees24hUsd.toFixed(0)}
APR: ${pool.apr.toFixed(2)}%
${positionBlock === "" ? "" : `\n${positionBlock}`}
METRICS:
- Fee/IL Ratio: ${metrics.feeIlRatio.toFixed(2)}
- Volume Authenticity: ${metrics.volumeAuthenticity.toFixed(2)}
- Bin Utilization: ${metrics.binUtilization.toFixed(2)}
- TVL Velocity: ${(metrics.tvlVelocity * 100).toFixed(1)}%

MEMORY WARNINGS:
${warningsBlock}

RECENT DECISIONS:
${decisionsBlock}

Respond with JSON only (replace the example action and confidence with your proposal; allowed actions: ${allowedActionsText}, confidence must be a number between 0.0 and 1.0):
{"action": "${decision.action}", "poolAddress": "${pool.address}", "confidence": ${decision.confidence}, "positionSizeUsd": ${decision.positionSizeUsd ?? 100}, "rebalanceParams": {"lowerBinId": ${decision.rebalanceParams?.newLowerBinId ?? 100}, "upperBinId": ${decision.rebalanceParams?.newUpperBinId ?? 110}}, "reasoning": "..."}
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
    // A deterministic capital-protection EXIT must never be downgraded to a
    // less-defensive action (mirrors the agent-proposal gate in risk-service).
    if (original.action === "EXIT" && action !== "EXIT") {
      return null;
    }
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

export function selectTransport(
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
    // The gateway transport authenticates with the shared token; with no token the
    // connection loses its operator scopes and every per-decision re-handshake fails
    // (detection only probes the pre-auth WS upgrade, so it cannot catch this). With a
    // token, use the gateway. Without one, `auto` prefers a working review transport
    // (Hermes/ACP) over no review — falling back when it is available, otherwise
    // falling through to null; an EXPLICIT AGENT_RUNTIME=openclaw keeps the
    // warn-and-disable semantics, since the user asked for the gateway specifically.
    if ((config.agentGatewayToken ?? "").trim() !== "") {
      return new GatewayTransport({
        url: config.agentGatewayUrl,
        token: config.agentGatewayToken,
        timeoutMs: config.agentPromptTimeoutMs,
      });
    }
    // Tokenless AUTO: prefer a working review transport over no review — fall back
    // to ACP/Hermes when available. An EXPLICIT AGENT_RUNTIME=openclaw keeps the
    // warn-and-disable semantics (the user asked for the gateway specifically).
    if (config.agentRuntime === "auto" && detection.hermes.available) {
      logger.info(
        "OpenClaw gateway reachable but AGENT_GATEWAY_TOKEN empty; falling back to the Hermes/ACP transport for decision review",
        { url: config.agentGatewayUrl },
      );
      return new AcpTransport({
        command: config.agentAcpCommand,
        args: config.agentAcpArgs,
        timeoutMs: config.agentPromptTimeoutMs,
      });
    }
    if (config.agentRuntime === "openclaw") {
      logger.warn(
        "AGENT_GATEWAY_TOKEN is required for the OpenClaw gateway runtime; decision review disabled",
        { url: config.agentGatewayUrl },
      );
    }
  }

  return null;
}

function createAlertTransports(config: AppConfig): ReadonlyArray<AgentRuntimeTransport> {
  const transports: AgentRuntimeTransport[] = [];

  if (config.agentOpenclawWebhookUrl) {
    transports.push(
      new OpenClawWebhookTransport({
        url: config.agentOpenclawWebhookUrl,
        token: config.agentOpenclawWebhookToken,
        timeoutMs: config.agentPromptTimeoutMs,
      }),
    );
  }

  if (config.agentHermesApiUrl) {
    transports.push(
      new HermesApiTransport({
        url: config.agentHermesApiUrl,
        token: config.agentHermesApiToken,
        timeoutMs: config.agentPromptTimeoutMs,
      }),
    );
  }

  return transports;
}

function transportSupportsAlert(
  transport: AgentRuntimeTransport,
): transport is AgentRuntimeTransport & {
  sendAlert: (alert: AgentRuntimeAlert) => Effect.Effect<void, Error>;
} {
  return typeof transport.sendAlert === "function";
}

function transportSupportsCheckin(
  transport: AgentRuntimeTransport,
): transport is AgentRuntimeTransport & {
  sendCheckin: (checkin: AgentRuntimeCheckin) => Effect.Effect<void, Error>;
} {
  return typeof transport.sendCheckin === "function";
}

function connectTransport(transport: AgentRuntimeTransport): Effect.Effect<void, Error> {
  return transport.connect().pipe(
    Effect.catch((err) => {
      logger.warn("Failed to connect transport", {
        transport: transport.name,
        error: underlyingErrorMessage(err),
      });
      return Effect.void;
    }),
  );
}

// Connect the review transport and report whether it actually connected. A failed
// connect is logged and swallowed so a dead runtime never blocks engine startup; the
// returned boolean is the truthful `connected` value getStatus() surfaces (the prior
// Effect.tap set connected=true regardless of the catch-swallowed failure).
export function connectReviewTransport(
  transport: AgentRuntimeTransport,
): Effect.Effect<boolean, never> {
  return transport.connect().pipe(
    Effect.map(() => true),
    Effect.catch((err) => {
      logger.warn("Failed to connect transport", {
        transport: transport.name,
        error: underlyingErrorMessage(err),
      });
      return Effect.succeed(false);
    }),
  );
}

function sendToAlertTransports(
  transports: ReadonlyArray<AgentRuntimeTransport>,
  alert: AgentRuntimeAlert,
): Effect.Effect<void, Error> {
  const effects = transports.filter(transportSupportsAlert).map((transport) =>
    transport.sendAlert(alert).pipe(
      Effect.catch((err) => {
        logger.warn("Failed to send alert", {
          transport: transport.name,
          error: underlyingErrorMessage(err),
        });
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
        agentGatewayToken: config.agentGatewayToken,
      }).pipe(
        Effect.catch(() =>
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

      // ── Rolling p95 latency gates for budget-constrained advisor prompts ──
      // One window per mode (veto budget vs proposal timeout). When the p95 of
      // fresh samples exceeds 95% of the mode's budget, the prompt is skipped
      // fail-open (WARN): a slow model must not stall scan cycles. The window
      // drains automatically once latency recovers, so review resumes without
      // a restart. Skipped calls record no samples, so the slow samples aging
      // out together is what turns the skip back off.
      const vetoLatencyWindow = new LatencyWindow({ budgetMs: config.agentVetoTimeoutMs });
      const proposalLatencyWindow = new LatencyWindow({
        budgetMs: config.agentProposalTimeoutMs,
      });

      if (transport) {
        connected = yield* connectReviewTransport(transport);
        if (!connected) {
          errorCount += 1;
        }
      }

      for (const t of alertTransports) {
        yield* connectTransport(t);
      }

      return {
        enhanceDecision: (decision: AgentDecision, context: AgentRuntimeContext) => {
          if (!transport) {
            return Effect.succeed(null);
          }
          const proposalMode = config.agentProposalMode;
          if (proposalMode === "veto") {
            const vetoBudgetMs = config.agentVetoTimeoutMs;
            const vetoSkip = vetoLatencyWindow.shouldSkip(Date.now());
            if (vetoSkip.skip) {
              logger.warn("Skipping veto review — rolling p95 latency exceeds 95% of veto budget", {
                pool: decision.poolAddress,
                p95Ms: Math.round(vetoSkip.p95Ms ?? 0),
                budgetMs: vetoBudgetMs,
                windowSize: vetoSkip.windowSize,
              });
              return Effect.succeed(null);
            }
            const prompt = buildPrompt(decision, context);
            const attemptStart = Date.now();
            let vetoLatencyRecorded = false;
            const recordAttemptLatency = () => {
              if (!vetoLatencyRecorded) {
                vetoLatencyRecorded = true;
                vetoLatencyWindow.record(
                  Math.min(Date.now() - attemptStart, vetoBudgetMs),
                  Date.now(),
                );
              }
            };
            return transport.sendPrompt(prompt, context, vetoBudgetMs).pipe(
              Effect.map((response: AgentRuntimeResponse) => {
                lastPromptAt = Date.now();
                // Wall-clock latency from just before sendPrompt —
                // captures the prompt round-trip plus any reconnect
                // inside sendPrompt (e.g., gateway), but excludes the
                // initial startup connection which already completed
                // in connectReviewTransport above.
                recordAttemptLatency();
                const parsed = parseResponse(response.raw);
                const override = validateOverride(decision, parsed);
                if (override) {
                  logger.info("Agent override", {
                    pool: decision.poolAddress,
                    originalAction: decision.action,
                    newAction: override.action,
                    originalConfidence: decision.confidence.toFixed(2),
                    newConfidence: override.confidence.toFixed(2),
                    latencyMs: response.latencyMs,
                  });
                }
                return override;
              }),
              Effect.catchCause((cause) => {
                errorCount += 1;
                // Record actual elapsed duration for ALL failure modes:
                // typed failures (disconnect, handshake) via catch above,
                // and outer timeouts (AGENT_VETO_TIMEOUT_MS from program.ts
                // timeoutFail) which interrupt this fiber without reaching
                // catch. Interruption is the only cause type that
                // catch would not see. Record min(elapsed, budget) to
                // avoid a single hard timeout from dominating the window.
                recordAttemptLatency();
                return Effect.failCause(cause);
              }),
            );
          }

          const proposalBudgetMs = config.agentProposalTimeoutMs;
          const prompt = buildProposalPrompt(decision, context);
          const attemptStart = Date.now();
          let proposalLatencyRecorded = false;
          const recordAttemptLatency = () => {
            if (!proposalLatencyRecorded) {
              proposalLatencyRecorded = true;
              proposalLatencyWindow.record(
                Math.min(Date.now() - attemptStart, proposalBudgetMs),
                Date.now(),
              );
            }
          };
          return transport.sendPrompt(prompt, context, proposalBudgetMs).pipe(
            Effect.flatMap((response: AgentRuntimeResponse) => {
              lastPromptAt = Date.now();
              recordAttemptLatency();
              return parseProposalResponse(
                response.raw,
                decision.action,
                config.agentProposalStaleMs,
              ).pipe(
                Effect.map((proposal) => {
                  logger.info("Agent proposal", {
                    pool: decision.poolAddress,
                    originalAction: decision.action,
                    proposedAction: proposal.action,
                    confidence: proposal.confidence.toFixed(2),
                  });
                  return proposal;
                }),
              );
            }),
            Effect.catch((err) => {
              errorCount += 1;
              recordAttemptLatency();
              logger.warn("Agent proposal failed", {
                pool: decision.poolAddress,
                error: underlyingErrorMessage(err),
              });
              return Effect.succeed(null);
            }),
            Effect.catchCause((cause) => {
              // Interruption (the outer AGENT_PROPOSAL_TIMEOUT_MS deadline in
              // program.ts) bypasses catch — record the elapsed sample so
              // the latency window learns the model could not answer, and
              // fail open (null) exactly like a typed failure.
              recordAttemptLatency();
              return Effect.succeed(null);
            }),
          );
        },

        // Callers check this BEFORE a sync advisor prompt so a slow model
        // skips the round trip entirely (fail-open, no backoff penalty) —
        // mirroring the inline veto skip that already lives inside
        // enhanceDecision for the veto branch.
        shouldSkipSyncProposal: () =>
          Effect.succeed(proposalLatencyWindow.shouldSkip(Date.now()).skip),

        getPolicy: () =>
          Effect.succeed({
            mode: config.agentProposalMode,
            proposalsQueued: 0,
            lastProposalAt: lastPromptAt,
            badProposalBackoffUntil: null,
            circuitBreakerOpen: false,
            hardCaps: {
              maxPositionSizePct: config.agentProposalMaxPositionSizePct,
              maxRebalanceRangeBins: config.maxRebalanceRangeBins,
              minProposalConfidence: config.agentProposalMinConfidence,
              proposalStaleMs: config.agentProposalStaleMs,
            },
          }),

        sendCheckin: (checkin: AgentRuntimeCheckin) => {
          // Fan the check-in out to every transport that supports it: the primary
          // runtime (ACP/gateway) plus the HTTP alert transports (OpenClaw webhook,
          // Hermes HTTP). Each delivery is independent so one failure does not
          // suppress the others.
          const effects = allTransports.filter(transportSupportsCheckin).map((t) =>
            t.sendCheckin(checkin).pipe(
              Effect.catch((err) => {
                errorCount += 1;
                logger.warn("Agent check-in failed", {
                  transport: t.name,
                  error: underlyingErrorMessage(err),
                });
                return Effect.void;
              }),
            ),
          );
          return Effect.all(effects, { discard: true });
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

        disconnect: () =>
          Effect.all(
            allTransports.map((t) =>
              t.disconnect().pipe(
                Effect.catch((err) => {
                  logger.warn("Failed to disconnect transport", {
                    transport: t.name,
                    error: underlyingErrorMessage(err),
                  });
                  return Effect.void;
                }),
              ),
            ),
            { discard: true },
          ),
      };
    }).pipe(
      Effect.catch((err) => {
        logger.error("Agent service initialization failed; falling back to no-op", {
          error: underlyingErrorMessage(err),
        });
        return Effect.succeed(AgentNoOp);
      }),
    ),
  );
}
