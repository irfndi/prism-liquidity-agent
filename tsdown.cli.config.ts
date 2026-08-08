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
  // Release bundles ship without node_modules and the runtime resolves bare
  // imports from bun's global cache — which can hold the WRONG effect major
  // (issue #179: v0.1.9 bundle called Context.Service against cached effect 3).
  // Bundle every runtime dependency so the artifact is version-consistent and
  // self-contained. @xenova/transformers stays external: it is only loaded for
  // the optional ONNX embeddings backend and its import failure is already
  // caught with a fallback to hash vectors.
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
