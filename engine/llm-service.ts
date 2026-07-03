import { Effect, Layer } from "effect";
import type { AppConfig } from "./config-service.js";
import type { AgentDecision, ActionType, PoolMetrics, PoolState, MemoryEntry } from "./types.js";
import type { DecisionRecord } from "./services.js";
import { LlmService, type LlmApi } from "./services.js";
import { createLogger } from "./logger.js";

const logger = createLogger("LlmService");

export const LlmNoOp: LlmApi = {
  enhanceDecision: () => Effect.succeed(null),
};

interface LlmResponseBody {
  readonly choices: ReadonlyArray<{
    readonly message: {
      readonly content: string;
    };
  }>;
}

interface LlmParsedResponse {
  action?: string;
  confidence?: number;
  reasoning?: string;
}

const VALID_ACTIONS: ReadonlySet<string> = new Set(["HOLD", "REBALANCE", "EXIT", "ENTER"]);
const VALIDATOR_TIMEOUT_MS = 10_000;

function buildPrompt(
  decision: AgentDecision,
  ctx: {
    readonly pool: PoolState;
    readonly metrics: PoolMetrics;
    readonly warnings: ReadonlyArray<MemoryEntry>;
    readonly recentDecisions: ReadonlyArray<DecisionRecord>;
  },
): string {
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
- You may ONLY reduce the confidence or change the action to HOLD.
- You may NEVER increase confidence above the current value.
- You may NEVER promote a non-ENTER action to ENTER.
- If you agree with the decision, return the exact same action and confidence.

Current deterministic decision:
  action: ${decision.action}
  confidence: ${decision.confidence.toFixed(4)}
  reasoning: ${decision.reasoning}

Pool: ${pool.address} (${pool.tokenXSymbol}/${pool.tokenYSymbol})
  TVL: $${pool.tvlUsd.toFixed(0)}
  24h volume: $${pool.volume24hUsd.toFixed(0)}
  24h fees: $${pool.fees24hUsd.toFixed(0)}
  APR: ${(pool.apr * 100).toFixed(1)}%
  Active bin: ${pool.activeBinId} (step ${pool.binStep})
  Current price: ${pool.currentPrice.toPrecision(6)}

Metrics:
  TVL velocity: ${(metrics.tvlVelocity * 100).toFixed(1)}%
  Fee/IL ratio: ${metrics.feeIlRatio.toFixed(4)}
  Volume authenticity: ${metrics.volumeAuthenticity.toFixed(4)}
  Bin utilization: ${(metrics.binUtilization * 100).toFixed(1)}%

Recent memory warnings:
${warningsBlock}

Recent decisions:
${decisionsBlock}

Respond with a JSON object ONLY (no markdown fences, no extra text):
{
  "action": "<HOLD|REBALANCE|EXIT|ENTER>",
  "confidence": <number between 0 and ${decision.confidence.toFixed(4)}>,
  "reasoning": "<brief explanation if overriding, or empty string>"
}`;
}

function isActionType(v: unknown): v is ActionType {
  return typeof v === "string" && VALID_ACTIONS.has(v);
}

function validateOverride(
  original: AgentDecision,
  parsed: LlmParsedResponse,
): AgentDecision | null {
  const newAction = parsed.action;
  const newConfidence = parsed.confidence;
  const newReasoning = parsed.reasoning;

  const wantsOverride =
    newAction !== undefined || newConfidence !== undefined || (newReasoning && newReasoning.length > 0);

  if (!wantsOverride) {
    return null;
  }

  if (newAction !== undefined) {
    if (!isActionType(newAction)) {
      logger.warn("LLM returned invalid action, keeping original", { action: newAction });
      return null;
    }
    if (newAction !== original.action && newAction !== "HOLD") {
      logger.warn("LLM tried non-HOLD override, keeping original", {
        original: original.action,
        attempted: newAction,
      });
      return null;
    }
  }

  if (newConfidence !== undefined) {
    if (typeof newConfidence !== "number" || !Number.isFinite(newConfidence)) {
      logger.warn("LLM returned invalid confidence, keeping original", { confidence: newConfidence });
      return null;
    }
    if (newConfidence > original.confidence) {
      logger.warn("LLM tried to increase confidence, keeping original", {
        original: original.confidence,
        attempted: newConfidence,
      });
      return null;
    }
  }

  const effectiveAction = newAction !== undefined ? (newAction as ActionType) : original.action;
  const effectiveConfidence = newConfidence !== undefined ? newConfidence : original.confidence;
  const effectiveReasoning =
    newReasoning && newReasoning.length > 0
      ? `[LLM overlay] ${newReasoning}`
      : original.reasoning;

  return {
    ...original,
    action: effectiveAction,
    confidence: effectiveConfidence,
    reasoning: effectiveReasoning,
  };
}

function parseResponse(rawText: string): LlmParsedResponse | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  let stripped = trimmed;
  if (stripped.startsWith("```")) {
    stripped = stripped.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  try {
    const parsed: unknown = JSON.parse(stripped);
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    const result: LlmParsedResponse = {};
    if ("action" in obj) result.action = obj["action"] as string;
    if ("confidence" in obj) result.confidence = obj["confidence"] as number;
    if ("reasoning" in obj) result.reasoning = obj["reasoning"] as string;
    return result;
  } catch {
    return null;
  }
}

export function LlmLive(config: AppConfig): Layer.Layer<LlmService, never, never> {
  const api: LlmApi = {
    enhanceDecision: (decision, ctx) =>
      Effect.gen(function* () {
        if (!config.agentiveMode || !config.llmApiKey) {
          return null;
        }

        const prompt = buildPrompt(decision, ctx);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), VALIDATOR_TIMEOUT_MS);

        try {
          const url = `${config.llmBaseUrl}/chat/completions`;
          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(url, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${config.llmApiKey}`,
                },
                body: JSON.stringify({
                  model: config.llmModel,
                  max_tokens: config.llmMaxTokens,
                  temperature: 0.1,
                  messages: [{ role: "user", content: prompt }],
                }),
                signal: controller.signal,
              }),
            catch: (err) => new Error(`LLM fetch failed: ${String(err)}`),
          });

          if (!response.ok) {
            logger.warn("LLM API returned non-200", {
              status: response.status,
              pool: decision.poolAddress,
            });
            return decision;
          }

          const body: LlmResponseBody = yield* Effect.tryPromise({
            try: () => response.json() as Promise<LlmResponseBody>,
            catch: (err) => new Error(`LLM JSON parse failed: ${String(err)}`),
          });

          const content = body.choices?.[0]?.message?.content;
          if (!content) {
            logger.warn("LLM returned empty content", { pool: decision.poolAddress });
            return decision;
          }

          const parsed = parseResponse(content);
          if (!parsed) {
            logger.warn("LLM returned unparseable response", {
              content: content.slice(0, 200),
              pool: decision.poolAddress,
            });
            return decision;
          }

          const override = validateOverride(decision, parsed);
          if (override === null) {
            return null;
          }

          logger.info("LLM overlay applied", {
            pool: decision.poolAddress,
            originalAction: decision.action,
            newAction: override.action,
            originalConfidence: decision.confidence.toFixed(4),
            newConfidence: override.confidence.toFixed(4),
          });

          return override;
        } catch (err) {
          logger.warn("LLM enhanceDecision failed, keeping original", {
            error: err instanceof Error ? err.message : String(err),
            pool: decision.poolAddress,
          });
          return decision;
        } finally {
          clearTimeout(timeout);
        }
      }),
  };

  return Layer.succeed(LlmService, api);
}
