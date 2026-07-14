import { Data, Effect, ParseResult, Schema } from "effect";
import { randomUUID } from "crypto";
import type { ActionType, AgentProposal } from "./types.js";

export class ProposalParseError extends Data.TaggedError("ProposalParseError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const PROPOSAL_TTL_MS = 5 * 60 * 1000;

const ActionTypeSchema = Schema.Literal("HOLD", "REBALANCE", "EXIT", "ENTER");

const RebalanceParamsSchema = Schema.Struct({
  lowerBinId: Schema.Int,
  upperBinId: Schema.Int,
}).pipe(
  Schema.filter((params) => params.lowerBinId < params.upperBinId, {
    message: () => "lowerBinId must be less than upperBinId",
  }),
);

const ProposalJsonSchema = Schema.Struct({
  action: ActionTypeSchema,
  poolAddress: Schema.NonEmptyString,
  confidence: Schema.Number.pipe(Schema.between(0, 1)),
  positionSizeUsd: Schema.optional(Schema.Number.pipe(Schema.nonNegative())),
  rebalanceParams: Schema.optional(RebalanceParamsSchema),
  reasoning: Schema.optional(Schema.String),
});

type DecodedProposalJson = Schema.Schema.Type<typeof ProposalJsonSchema>;

function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const char = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
    } else {
      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth++;
      } else if (char === "}") {
        depth--;
        if (depth === 0) {
          return raw.slice(start, i + 1);
        }
      }
    }
  }

  return null;
}

function decodeProposalJson(raw: string): Effect.Effect<DecodedProposalJson, ProposalParseError> {
  return Effect.gen(function* () {
    const jsonText = extractFirstJsonObject(raw);
    if (jsonText === null) {
      return yield* Effect.fail(
        new ProposalParseError({ message: "No JSON object found in response" }),
      );
    }

    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(jsonText),
      catch: (err) =>
        new ProposalParseError({
          message: "Failed to parse JSON object",
          cause: err,
        }),
    });

    return yield* Schema.decodeUnknown(ProposalJsonSchema)(parsed).pipe(
      Effect.mapError((err) => {
        const formatted = ParseResult.TreeFormatter.formatErrorSync(err);
        return new ProposalParseError({
          message: `Schema validation failed: ${formatted}`,
          cause: err,
        });
      }),
    );
  });
}

function buildProposal(
  decoded: DecodedProposalJson,
  proposalId: string,
  source: "sync-prompt" | "http-queue",
  originalAction: ActionType | undefined,
  staleMs: number,
): AgentProposal {
  const now = Date.now();
  return {
    proposalId,
    source,
    action: decoded.action,
    poolAddress: decoded.poolAddress,
    confidence: decoded.confidence,
    reasoning: decoded.reasoning ?? "",
    proposedAt: now,
    expiresAt: now + staleMs,
    status: "pending",
    ...(originalAction !== undefined && { originalAction }),
    ...(decoded.positionSizeUsd !== undefined && {
      positionSizeUsd: decoded.positionSizeUsd,
    }),
    ...(decoded.rebalanceParams !== undefined && {
      rebalanceParams: {
        newLowerBinId: decoded.rebalanceParams.lowerBinId,
        newUpperBinId: decoded.rebalanceParams.upperBinId,
        slippageBps: 0,
      },
    }),
  };
}

export function parseProposalResponse(
  raw: string,
  originalAction: ActionType,
  staleMs: number = PROPOSAL_TTL_MS,
): Effect.Effect<AgentProposal, ProposalParseError> {
  return decodeProposalJson(raw).pipe(
    Effect.map((decoded) =>
      buildProposal(decoded, randomUUID(), "sync-prompt", originalAction, staleMs),
    ),
  );
}

export function parseHttpQueueProposal(
  raw: string,
  proposalId: string,
  source: "sync-prompt" | "http-queue" = "http-queue",
  staleMs: number = PROPOSAL_TTL_MS,
): Effect.Effect<AgentProposal, ProposalParseError> {
  return decodeProposalJson(raw).pipe(
    Effect.map((decoded) => buildProposal(decoded, proposalId, source, undefined, staleMs)),
  );
}
