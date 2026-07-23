import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

// See tsdown.config.ts: bigint-buffer's dist/browser.js is the bindings-free
// pure-JS entry, so the bundle never inlines require('bindings') and never warns.
const bigintBufferPureJs = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "node_modules/bigint-buffer/dist/browser.js",
);

export default defineConfig({
  entry: ["cli/index.ts"],
  format: ["esm"],
  target: "node26",
  outDir: "dist/cli",
  clean: true,
  sourcemap: true,
  dts: false,
  alias: {
    "bigint-buffer": bigintBufferPureJs,
  },
  deps: {
    neverBundle: ["bun:sqlite"],
  },
  // Release bundles ship without node_modules. sqlite-vec's JS must be inlined
  // so its npm load() fails gracefully inside the load chain (caught, then
  // PRISM_VEC0_PATH / embedded fallbacks run) instead of crashing the CLI on
  // an unresolvable bare import.
  noExternal: ["sqlite-vec"],
});
