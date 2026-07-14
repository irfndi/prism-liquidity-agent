import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import type { ActionType } from "../engine/types.js";
import {
  parseProposalResponse,
  parseHttpQueueProposal,
  ProposalParseError,
} from "../engine/proposal-schema.js";

const ORIGINAL_ACTION: ActionType = "HOLD";

function runSyncOrFail<A, E>(effect: Effect.Effect<A, E>): A {
  return Effect.runSync(effect);
}

function expectError(effect: Effect.Effect<unknown, ProposalParseError>): void {
  const result = Effect.runSync(Effect.either(effect));
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") {
    expect(result.left).toBeInstanceOf(ProposalParseError);
  }
}

describe("parseProposalResponse", () => {
  it("decodes a valid proposal wrapped in markdown", () => {
    const raw = `Here is my decision:
    {"action":"ENTER","poolAddress":"Pool111111111111111111111111111111111111111","confidence":0.85,"positionSizeUsd":1000,"reasoning":"strong fee/IL ratio"}`;

    const proposal = runSyncOrFail(parseProposalResponse(raw, ORIGINAL_ACTION));

    expect(proposal.action).toBe("ENTER");
    expect(proposal.originalAction).toBe("HOLD");
    expect(proposal.poolAddress).toBe("Pool111111111111111111111111111111111111111");
    expect(proposal.confidence).toBe(0.85);
    expect(proposal.positionSizeUsd).toBe(1000);
    expect(proposal.reasoning).toBe("strong fee/IL ratio");
    expect(proposal.source).toBe("sync-prompt");
    expect(proposal.proposalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(proposal.expiresAt - proposal.proposedAt).toBe(5 * 60 * 1000);
  });

  it("decodes a minimal proposal without optional fields", () => {
    const raw = JSON.stringify({
      action: "HOLD",
      poolAddress: "Pool222222222222222222222222222222222222222",
      confidence: 0.5,
    });

    const proposal = runSyncOrFail(parseProposalResponse(raw, ORIGINAL_ACTION));

    expect(proposal.action).toBe("HOLD");
    expect(proposal.positionSizeUsd).toBeUndefined();
    expect(proposal.rebalanceParams).toBeUndefined();
    expect(proposal.reasoning).toBe("");
  });

  it("rejects an invalid action", () => {
    const raw = JSON.stringify({
      action: "BUY",
      poolAddress: "Pool111111111111111111111111111111111111111",
      confidence: 0.85,
    });

    expectError(parseProposalResponse(raw, ORIGINAL_ACTION));
  });

  it("rejects an empty pool address", () => {
    const raw = JSON.stringify({
      action: "ENTER",
      poolAddress: "",
      confidence: 0.85,
    });

    expectError(parseProposalResponse(raw, ORIGINAL_ACTION));
  });

  it("rejects confidence outside [0,1]", () => {
    const raw = JSON.stringify({
      action: "ENTER",
      poolAddress: "Pool111111111111111111111111111111111111111",
      confidence: 1.5,
    });

    expectError(parseProposalResponse(raw, ORIGINAL_ACTION));
  });

  it("rejects a negative position size", () => {
    const raw = JSON.stringify({
      action: "ENTER",
      poolAddress: "Pool111111111111111111111111111111111111111",
      confidence: 0.85,
      positionSizeUsd: -100,
    });

    expectError(parseProposalResponse(raw, ORIGINAL_ACTION));
  });

  it("rejects invalid rebalance range", () => {
    const raw = JSON.stringify({
      action: "REBALANCE",
      poolAddress: "Pool111111111111111111111111111111111111111",
      confidence: 0.85,
      rebalanceParams: { lowerBinId: 10, upperBinId: 5 },
    });

    expectError(parseProposalResponse(raw, ORIGINAL_ACTION));
  });

  it("rejects a response with no JSON object", () => {
    expectError(parseProposalResponse("no json here", ORIGINAL_ACTION));
  });
});

describe("parseHttpQueueProposal", () => {
  it("uses the provided proposalId and source", () => {
    const raw = JSON.stringify({
      action: "EXIT",
      poolAddress: "Pool333333333333333333333333333333333333333",
      confidence: 0.9,
    });

    const proposal = runSyncOrFail(parseHttpQueueProposal(raw, "queue-id-123", "http-queue"));

    expect(proposal.proposalId).toBe("queue-id-123");
    expect(proposal.source).toBe("http-queue");
    expect(proposal.action).toBe("EXIT");
    expect(proposal.originalAction).toBeUndefined();
  });

  it("respects a custom stale TTL", () => {
    const raw = JSON.stringify({
      action: "EXIT",
      poolAddress: "Pool333333333333333333333333333333333333333",
      confidence: 0.9,
    });

    const proposal = runSyncOrFail(
      parseHttpQueueProposal(raw, "queue-id-123", "http-queue", 30_000),
    );

    expect(proposal.expiresAt - proposal.proposedAt).toBe(30_000);
  });
});

// Wave 2+ will add integration tests for agent-service.ts wiring and risk gate rejection.
