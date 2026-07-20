import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["engine/index.ts"],
  format: ["esm"],
  target: "node26",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  deps: {
    neverBundle: ["bun:sqlite"],
  },
});
