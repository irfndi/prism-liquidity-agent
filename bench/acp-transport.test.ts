import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { Effect } from "effect";
import { AcpTransport } from "../engine/acp-transport.js";
import type { AgentRuntimeContext } from "../engine/agent-transport.js";
import type { AgentDecision } from "../engine/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(__dirname, "fake-acp-agent.ts");

function makeContext(): AgentRuntimeContext {
  return {
    decision: {
      action: "ENTER",
      poolAddress: "Pool111111111111111111111111111111111111111",
      confidence: 0.8,
      reasoning: "test decision",
    } satisfies AgentDecision,
  } as unknown as AgentRuntimeContext;
}

describe("AcpTransport (ACP v1)", () => {
  it("speaks canonical ACP: initialize / session/new / session/prompt + session/update streaming", async () => {
    // The fixture agent only accepts canonical (non agent/-prefixed) method names and
    // an integer protocolVersion, and streams the reply via session/update
    // agent_message_chunk notifications before resolving with a stopReason. Success
    // therefore proves the handshake, method names, streaming, and completion model.
    const transport = new AcpTransport({
      command: process.execPath,
      args: [FAKE_AGENT],
      timeoutMs: 10_000,
    });

    try {
      await Effect.runPromise(transport.connect());
      const response = await Effect.runPromise(transport.sendPrompt("review", makeContext()));
      expect(response.raw).toBe("Hello from ACP");
    } finally {
      await Effect.runPromise(transport.disconnect());
    }
  });
});
