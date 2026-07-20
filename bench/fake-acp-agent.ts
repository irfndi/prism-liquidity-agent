#!/usr/bin/env bun
// Minimal ACP v1 agent used by bench/acp-transport.test.ts. Speaks newline-delimited
// JSON-RPC over stdio and only accepts CANONICAL ACP method names + integer
// protocolVersion, so a client still speaking the old agent/-prefixed methods (or a
// date-string protocolVersion) fails the handshake. On session/prompt it streams the
// reply via session/update agent_message_chunk notifications, then resolves the
// request with a stopReason.
import readline from "readline";

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function chunk(text: string): void {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "sess-test",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let req: { id?: number; method?: string; params?: Record<string, unknown> };
  try {
    req = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
  } catch {
    return;
  }
  const { id, method, params } = req;

  if (method === "initialize") {
    if (typeof params?.protocolVersion !== "number") {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "protocolVersion must be an integer" },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: params.protocolVersion, agentCapabilities: {} },
    });
  } else if (method === "session/new") {
    send({ jsonrpc: "2.0", id, result: { sessionId: "sess-test" } });
  } else if (method === "session/prompt") {
    chunk("Hello ");
    chunk("from ACP");
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  } else {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
