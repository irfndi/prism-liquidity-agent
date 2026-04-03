import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["bench/**/*.test.ts"],
    testTimeout: 30000,
  },
});

