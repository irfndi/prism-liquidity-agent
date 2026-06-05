import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["bench/**/*.test.ts"],
    testTimeout: 30000,
    coverage: {
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
      ],
      reporter: ["text", "json", "html"],
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 70,
        lines: 80,
      },
    },
  },
});
