import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["engine/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  banner: { js: "#!/usr/bin/env node" },
});

