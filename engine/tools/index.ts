import type { Tool } from "@anthropic-ai/sdk/resources/messages.js";
import { createLogger } from "../logger.js";
import type { AgentMemory } from "../memory/store.js";
import type { MeteoraAdapter } from "../adapters/meteora.js";
import type { DLMMStrategy } from "../probes/dlmm.js";

const log = createLogger("MCPServer");

export const METEORA_TOOLS: Tool[] = [
  {
    name: "meteora_get_pool_state",
    description:
      "Fetch current state of a Meteora DLMM pool: TVL, 24h volume, fees, APR, active bin ID, bin step, current price.",
    input_schema: {
      type: "object" as const,
      properties: {
        pool_address: { type: "string", description: "Meteora DLMM pool address (base58)" },
      },
      required: ["pool_address"],
    },
  },
  {
    name: "meteora_get_bin_array",
    description:
      "Fetch the bin array ±20 bins around the active bin for a pool. Returns bin IDs, prices, reserve amounts, and liquidity supply per bin.",
    input_schema: {
      type: "object" as const,
      properties: {
        pool_address: { type: "string", description: "Meteora DLMM pool address" },
      },
      required: ["pool_address"],
    },
  },
  {
    name: "meteora_simulate_rebalance",
    description:
      "Simulate moving liquidity to a new bin range. Returns estimated IL, estimated fees, and net benefit in USD without executing on-chain.",
    input_schema: {
      type: "object" as const,
      properties: {
        pool_address: { type: "string", description: "Pool address" },
        new_lower_bin_id: { type: "number", description: "New lower bin ID" },
        new_upper_bin_id: { type: "number", description: "New upper bin ID" },
      },
      required: ["pool_address", "new_lower_bin_id", "new_upper_bin_id"],
    },
  },
  {
    name: "volume_authenticity_check",
    description:
      "Analyze trading volume for signs of wash trading or manipulation. Returns a 0–1 authenticity score and a list of flags.",
    input_schema: {
      type: "object" as const,
      properties: {
        pool_address: { type: "string", description: "Pool address to analyze" },
      },
      required: ["pool_address"],
    },
  },
  {
    name: "memory_query",
    description:
      "Query the agent's persistent memory for relevant past patterns, warnings, or outcomes. Use this before making any decision.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Natural language query" },
        top_k: { type: "number", description: "Max results to return (default 5)" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_write",
    description:
      "Write a new observation, pattern, or warning to the agent's persistent memory.",
    input_schema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          enum: ["pattern", "warning", "outcome"],
          description: "Memory category",
        },
        content: { type: "string", description: "Memory content" },
        pool_address: { type: "string", description: "Related pool address (optional)" },
      },
      required: ["category", "content"],
    },
  },
  {
    name: "meteora_decision",
    description:
      "Submit a final rebalancing decision. This is the LAST tool call — use it only after gathering all data and reasoning through memory.",
    input_schema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["HOLD", "REBALANCE", "EXIT", "ENTER"],
          description: "Action to take",
        },
        pool_address: { type: "string", description: "Target pool address" },
        confidence: {
          type: "number",
          description: "Confidence score 0–1",
        },
        reasoning: {
          type: "string",
          description: "Detailed reasoning for the decision",
        },
        new_lower_bin_id: {
          type: "number",
          description: "Required for REBALANCE action",
        },
        new_upper_bin_id: {
          type: "number",
          description: "Required for REBALANCE action",
        },
        position_size_usd: {
          type: "number",
          description: "Required for ENTER action",
        },
      },
      required: ["action", "pool_address", "confidence", "reasoning"],
    },
  },
];

export type ToolInput = Record<string, unknown>;

export interface MCPServer {
  executeTool(name: string, input: ToolInput): Promise<unknown>;
}

export function createMCPServer(
  adapter: MeteoraAdapter,
  strategy: DLMMStrategy,
  memory: AgentMemory
): MCPServer {
  const tvlHistory = new Map<string, number>();

  return {
    async executeTool(name: string, input: ToolInput): Promise<unknown> {
      log.debug("Tool call", { name, input });

      switch (name) {
        case "meteora_get_pool_state": {
          const addr = String(input["pool_address"]);
          const state = await adapter.getPoolState(addr);
          return state;
        }

        case "meteora_get_bin_array": {
          const addr = String(input["pool_address"]);
          const bins = await adapter.getBinArray(addr);
          return bins;
        }

        case "meteora_simulate_rebalance": {
          const addr = String(input["pool_address"]);
          const lower = Number(input["new_lower_bin_id"]);
          const upper = Number(input["new_upper_bin_id"]);
          const result = await adapter.simulateRebalance(addr, lower, upper);
          return result;
        }

        case "volume_authenticity_check": {
          const addr = String(input["pool_address"]);
          const state = await adapter.getPoolState(addr);
          const result = strategy.checkVolumeAuthenticity(state);
          return result;
        }

        case "memory_query": {
          const query = String(input["query"]);
          const topK = input["top_k"] !== undefined ? Number(input["top_k"]) : 5;
          const entries = await memory.getRelevantContext(query, topK);
          return entries;
        }

        case "memory_write": {
          const category = String(input["category"]) as "pattern" | "warning" | "outcome";
          const content = String(input["content"]);
          const poolAddress = input["pool_address"] ? String(input["pool_address"]) : undefined;
          await memory.upsert({ category, content, poolAddress });
          return { success: true };
        }

        case "meteora_decision":
          // Intercepted by main agent loop — should not reach here
          return { intercepted: true };

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    },
  };
}

