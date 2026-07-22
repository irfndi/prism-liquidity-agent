import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["cli/index.ts"],
  format: ["esm"],
  target: "node26",
  outDir: "dist/cli",
  clean: true,
  sourcemap: true,
  dts: false,
  deps: {
    neverBundle: ["bun:sqlite"],
  },
  // Release bundles ship without node_modules. sqlite-vec's JS must be inlined
  // so its npm load() fails gracefully inside the load chain (caught, then
  // PRISM_VEC0_PATH / embedded fallbacks run) instead of crashing the CLI on
  // an unresolvable bare import.
  noExternal: ["sqlite-vec"],
});
