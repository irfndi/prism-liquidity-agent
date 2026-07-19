import { defineConfig } from "vitest/config";

// Prism's tests depend on Bun-only APIs (bun:sqlite, Bun.serve). Running under
// Node produces dozens of cryptic import errors; fail fast with a clear message.
if (typeof Bun === "undefined") {
  throw new Error("Prism tests require the Bun runtime. Run: bun run test");
}

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["bench/**/*.test.ts"],
    testTimeout: 30000,
    coverage: {
      provider: "istanbul",
      include: ["engine/**/*.ts"],
      exclude: [
        "engine/index.ts",
        "engine/types.ts",
        "engine/services.ts",
        "engine/logger.ts",
        "engine/adapter-service.ts",
        "engine/program.ts",
        "engine/config-service.ts",
        "engine/memory-service.ts",
        "engine/screener-service.ts",
        // Runtime boundaries require external processes, WebSockets, or live
        // HTTP endpoints. They are covered by integration/manual checks rather
        // than the deterministic engine-unit coverage gate.
        "engine/acp-transport.ts",
        "engine/agent-detection.ts",
        "engine/agent-transport.ts",
        "engine/gateway-transport.ts",
        "engine/hermes-api-transport.ts",
        "engine/openclaw-webhook-transport.ts",
        "engine/run-engine.ts",
        "engine/load-env.ts",
      ],
      reporter: ["text", "json", "html"],
      thresholds: {
        statements: 75,
        branches: 60,
        functions: 75,
        lines: 75,
      },
    },
  },
});
