import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { AgentStateMutable } from "../engine/state-service.js";
import { AgentStateService } from "../engine/services.js";
import type { AgentProposal } from "../engine/types.js";
import type { Layer } from "effect";

function makeProposal(proposalId: string, poolAddress = "pool1"): AgentProposal {
  return {
    proposalId,
    source: "http-queue",
    action: "HOLD",
    poolAddress,
    confidence: 0.65,
    reasoning: "test",
    proposedAt: Date.now(),
    expiresAt: Date.now() + 300_000,
    status: "pending",
  };
}

function getSnapshot(layer: Layer.Layer<AgentStateService, never, never>) {
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const state = yield* AgentStateService;
        return yield* state.getSnapshot();
      }),
      layer,
    ),
  );
}

describe("AgentStateMutable", () => {
  it("synchronizes proposalsQueued with pendingProposals on enqueue", async () => {
    const { layer, enqueueProposal } = AgentStateMutable();
    const result = enqueueProposal(makeProposal("p-1"));
    expect(result).toEqual({ status: "enqueued" });
    const snapshot = await getSnapshot(layer);
    expect(snapshot.pendingProposals).toHaveLength(1);
    expect(snapshot.agentPolicy.proposalsQueued).toBe(1);
  });

  it("synchronizes proposalsQueued with pendingProposals on dequeue", async () => {
    const { layer, enqueueProposal, dequeueProposals } = AgentStateMutable();
    enqueueProposal(makeProposal("p-1"));
    enqueueProposal(makeProposal("p-2", "pool2"));
    dequeueProposals(["p-1"]);
    const snapshot = await getSnapshot(layer);
    expect(snapshot.pendingProposals).toHaveLength(1);
    expect(snapshot.agentPolicy.proposalsQueued).toBe(1);
  });

  it("synchronizes proposalsQueued after pruning rejected proposals", async () => {
    const { layer, enqueueProposal, rejectProposal } = AgentStateMutable();
    enqueueProposal({ ...makeProposal("p-1"), expiresAt: 0 });
    enqueueProposal(makeProposal("p-2", "pool2"));
    rejectProposal("p-2");
    const snapshot = await getSnapshot(layer);
    expect(snapshot.pendingProposals).toHaveLength(0);
    expect(snapshot.agentPolicy.proposalsQueued).toBe(0);
  });

  it("replaces an older pending proposal for the same pool", async () => {
    const { layer, enqueueProposal } = AgentStateMutable();
    enqueueProposal(makeProposal("p-1", "pool1"));
    const result = enqueueProposal(makeProposal("p-2", "pool1"));
    expect(result).toEqual({ status: "replaced", replacedIds: ["p-1"] });
    const snapshot = await getSnapshot(layer);
    expect(snapshot.pendingProposals.map((p) => p.proposalId)).toEqual(["p-2"]);
  });

  it("rejects enqueue when the global queue is full", async () => {
    const { layer, enqueueProposal } = AgentStateMutable({ maxPendingProposals: 1 });
    expect(enqueueProposal(makeProposal("p-1", "pool1")).status).toBe("enqueued");
    const full = enqueueProposal(makeProposal("p-2", "pool2"));
    expect(full).toEqual({ status: "rejected", reason: "queue_full" });
    const snapshot = await getSnapshot(layer);
    expect(snapshot.pendingProposals).toHaveLength(1);
    expect(snapshot.pendingProposals[0]?.proposalId).toBe("p-1");
  });

  it("allows same-pool replace even when the queue is at capacity", async () => {
    const { layer, enqueueProposal } = AgentStateMutable({ maxPendingProposals: 1 });
    enqueueProposal(makeProposal("p-1", "pool1"));
    const result = enqueueProposal(makeProposal("p-2", "pool1"));
    expect(result).toEqual({ status: "replaced", replacedIds: ["p-1"] });
    const snapshot = await getSnapshot(layer);
    expect(snapshot.pendingProposals.map((p) => p.proposalId)).toEqual(["p-2"]);
  });
});
