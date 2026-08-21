import { describe, it, expect } from "vitest";
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = { [key: string]: JsonValue };
import { Effect } from "effect";
import { OpenClawWebhookTransport } from "../engine/openclaw-webhook-transport.js";
import type { AgentRuntimeContext } from "../engine/agent-transport.js";
import type { AgentDecision, PoolState, PoolMetrics, MemoryEntry } from "../engine/types.js";
import type { DecisionRecord } from "../engine/services.js";

function makeContext(): AgentRuntimeContext {
  const decision: AgentDecision = {
    action: "HOLD",
    poolAddress: "Pool111111111111111111111111111111111111111",
    confidence: 0.65,
    reasoning: "test decision",
  };

  const pool: PoolState = {
    address: decision.poolAddress,
    tokenX: "SOL",
    tokenY: "USDC",
    tokenXSymbol: "SOL",
    tokenYSymbol: "USDC",
    tvlUsd: 100_000,
    volume24hUsd: 30_000,
    fees24hUsd: 300,
    apr: 60,
    activeBinId: 5000,
    binStep: 10,
    currentPrice: 150,
    timestamp: Date.now(),
  };

  const metrics: PoolMetrics = {
    pool,
    binArray: {
      lowerBinId: 4900,
      upperBinId: 5100,
      bins: [],
      activeBinId: 5000,
      binStep: 10,
    },
    tvlVelocity: 0,
    feeIlRatio: 1.5,
    volumeAuthenticity: 0.9,
    binUtilization: 0.5,
    volumeAuthenticityKnown: true,
    feeIlRatioKnown: true,
    farmAprPct: null,
    binUtilizationKnown: true,
  };

  const warnings: MemoryEntry[] = [];
  const recentDecisions: DecisionRecord[] = [];

  return { decision, pool, metrics, warnings, recentDecisions, hasOpenPosition: false };
}

describe("OpenClawWebhookTransport", () => {
  it("includes the prompt in the webhook payload", async () => {
    let capturedBody: JsonRecord | null = null;

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        // SAFETY: This test fixture is constructed to satisfy the asserted service/domain contract and is exercised by the surrounding test.
        capturedBody = (await request.json()) as JsonRecord;
        return Response.json({ action: "HOLD", confidence: 0.65, reasoning: "ok" });
      },
    });

    try {
      const transport = new OpenClawWebhookTransport({
        url: `http://127.0.0.1:${server.port}/hooks/agent`,
        timeoutMs: 5000,
      });

      const prompt = "Respond with the proposal JSON schema";
      const response = await Effect.runPromise(transport.sendPrompt(prompt, makeContext()));

      expect(response.raw).toBeTruthy();
      expect(capturedBody).toMatchObject({
        type: "prism_prompt",
        prompt,
      });
      expect(capturedBody!.decision).toBeDefined();
      expect(capturedBody!.pool).toBeDefined();
    } finally {
      void server.stop();
    }
  });
});
