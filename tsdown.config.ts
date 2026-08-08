import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

// bigint-buffer's default node entry calls require('bindings') at module load and
// warns "bigint: Failed to load bindings" whenever the native addon is missing —
// always, inside the single-file bundle (no node_modules). Its dist/browser.js is
// the identical pure-JS implementation with no bindings require, so alias to it
// and the warning source is never bundled.
const bigintBufferPureJs = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "node_modules/bigint-buffer/dist/browser.js",
);

export default defineConfig({
  entry: ["engine/index.ts"],
  format: ["esm"],
  target: "node26",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  alias: {
    "bigint-buffer": bigintBufferPureJs,
  },
  deps: {
    neverBundle: ["bun:sqlite"],
  },
  // See tsdown.cli.config.ts: release bundles ship without node_modules and
  // bare imports resolve from bun's global cache — which broke v0.1.9 (issue
  // #179). Bundle every runtime dependency; @xenova/transformers stays
  // external (optional ONNX backend, import failure falls back to hash
  // vectors).
  noExternal: [
    "sqlite-vec",
    "effect",
    "commander",
    "chalk",
    "dotenv",
    "@clack/prompts",
    "semver",
    "bs58",
    "@solana/web3.js",
    "@solana/spl-token",
    "@meteora-ag/dlmm",
  ],
});
