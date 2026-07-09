import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["cli/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist/cli",
  clean: true,
  sourcemap: true,
  dts: false,
  deps: {
    neverBundle: ["bun:sqlite"],
  },
});
