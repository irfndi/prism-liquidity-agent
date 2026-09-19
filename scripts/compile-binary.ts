#!/usr/bin/env bun
// Compile a fresh tsdown bundle into a self-contained linux-x64 binary via
// `bun build --compile` (box deploy target). Runs under plain bun, no new deps.
//
// `bun build --compile` has an open upstream bug (oven-sh/bun#42664: circular
// module initializers can be emitted out of order) that this repo hits via
// @coral-xyz/anchor's bundled ESM output — the compiled binary can crash on
// startup with `ReferenceError: exports_esm is not defined` even though the
// same tsdown bundle runs fine under plain `bun <entry>.mjs`. Every build
// this script produces is smoke-tested when possible (see smokeTest below)
// so a broken artifact can never ship silently.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PROFILES = {
  prism: {
    // tsdown esm output lands on .mjs; .js first in case the bundler renames it.
    candidates: ["dist/cli/index.js", "dist/cli/index.mjs"],
    out: "dist/bin/prism",
    buildHint: "bunx --bun tsdown --config tsdown.cli.config.ts",
  },
  prismd: {
    candidates: ["dist/index.js", "dist/index.mjs"],
    out: "dist/bin/prismd",
    buildHint: "bun run build",
  },
} as const;
type Profile = keyof typeof PROFILES;

function usage(): string {
  return [
    "Usage: bun scripts/compile-binary.ts [prism|prismd]",
    "",
    "Compile a fresh tsdown bundle into a linux-x64 binary:",
    "  prism   dist/cli/index.{js,mjs}  -> dist/bin/prism   (CLI, default)",
    "  prismd  dist/index.{js,mjs}      -> dist/bin/prismd  (engine)",
    "",
    "Options:",
    "  -h, --help  Print this usage and exit without building.",
  ].join("\n");
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage());
  process.exit(0);
}

const positional = args.filter((a) => !a.startsWith("-"));
const name = positional[0] ?? "prism";
if (!(name in PROFILES) || positional.length > 1 || args.length !== positional.length) {
  console.error(`Unknown profile or flag: ${args.join(" ") || "(none)"}`);
  console.error(usage());
  process.exit(1);
}
// SAFETY: the guard above exits unless `name` is a key of PROFILES, so the lookup cannot miss.
const cfg = PROFILES[name as Profile];

const entry = cfg.candidates.map((c) => path.join(repoRoot, c)).find((p) => existsSync(p));
if (!entry) {
  console.error(`Missing bundle for ${name}: tried ${cfg.candidates.join(", ")}`);
  console.error(`Build it first: ${cfg.buildHint}`);
  process.exit(1);
}

const outAbs = path.join(repoRoot, cfg.out);
mkdirSync(path.dirname(outAbs), { recursive: true });
execFileSync("bun", ["build", "--compile", "--target=bun-linux-x64", "--outfile", outAbs, entry], {
  cwd: repoRoot,
  stdio: "inherit",
});
chmodSync(outAbs, 0o755);

const size = statSync(outAbs).size;
const sha256 = createHash("sha256").update(readFileSync(outAbs)).digest("hex");
console.log(`✓ Built ${cfg.out} (${size} bytes)`);
console.log(`  SHA-256: ${sha256}`);

/** `prism --version` is side-effect-free and exits immediately. */
function smokeTestCli(binPath: string): void {
  const out = execFileSync(binPath, ["--version"], { encoding: "utf8", timeout: 15_000 });
  if (!/^\d+\.\d+\.\d+/.test(out.trim())) {
    throw new Error(`unexpected --version output: ${JSON.stringify(out)}`);
  }
}

/**
 * The raw engine binary has no side-effect-free flag, so this only checks it
 * survives the first ~1.5s without the bundler-crash signature above — not
 * full behavioral correctness. Runs with an isolated, empty PRISM_CONFIG_DIR
 * (no real .env, no real keys) so it can never pick up live credentials.
 */
function smokeTestEngine(binPath: string): void {
  const scratch = mkdtempSync(path.join(tmpdir(), "prismd-smoke-"));
  try {
    const result = spawnSync(binPath, [], {
      cwd: scratch,
      env: {
        PATH: process.env.PATH ?? "",
        PRISM_CONFIG_DIR: scratch,
        PRISM_ALLOW_DIRECT: "true",
      },
      timeout: 1_500,
      encoding: "utf8",
    });
    const stderr = result.stderr ?? "";
    if (/ReferenceError|is not defined|SyntaxError:/.test(stderr)) {
      throw new Error(`prismd crashed on startup (bundler bug?):\n${stderr.slice(0, 2000)}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const canRunLinuxX64 = process.platform === "linux" && process.arch === "x64";
if (!canRunLinuxX64) {
  console.warn(
    `⚠ Skipping smoke test: this build targets linux-x64, host is ${process.platform}/${process.arch}.\n` +
      `  Verify on the deploy target before shipping: ${cfg.out} ` +
      (name === "prism"
        ? "--version"
        : "(see smokeTestEngine in this script for the isolated-env pattern)"),
  );
} else if (name === "prism") {
  smokeTestCli(outAbs);
  console.log("✓ Smoke test passed (--version)");
} else {
  smokeTestEngine(outAbs);
  console.log("✓ Smoke test passed (no startup crash in 1.5s, isolated env)");
}
