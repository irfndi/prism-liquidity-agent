#!/usr/bin/env bun
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const platform = process.platform;
const arch = process.arch;

const extensionSuffix = platform === "win32" ? "dll" : platform === "darwin" ? "dylib" : "so";
const platformPackageName = `sqlite-vec-${platform === "win32" ? "windows" : platform}-${arch}`;
const vec0Path = path.join(repoRoot, "node_modules", platformPackageName, `vec0.${extensionSuffix}`);
const platformKey = `${platform === "win32" ? "windows" : platform}-${arch}`;

function run(cmd: string): void {
  console.log(`→ ${cmd}`);
  execSync(cmd, { cwd: repoRoot, stdio: "inherit" });
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const pkgPath = path.join(repoRoot, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version: string };
const version = pkg.version;

// Generate embedded sqlite-vec fallback for the current platform.
if (fs.existsSync(vec0Path)) {
  run(`bun run scripts/generate-vec-embed.ts ${platform} ${arch}`);
} else {
  console.warn(`⚠ sqlite-vec extension not found for ${platformKey}; skipping embed fallback`);
}

// Build the engine and CLI bundles.
run("bun run build");
run("bunx tsdown --config tsdown.cli.config.ts");

// Stage the distribution layout.
const stageDir = path.join(repoRoot, ".prism-bundle-stage");
if (fs.existsSync(stageDir)) {
  fs.rmSync(stageDir, { recursive: true, force: true });
}
fs.mkdirSync(stageDir, { recursive: true });

fs.cpSync(path.join(repoRoot, "dist"), path.join(stageDir, "dist"), { recursive: true });

const libDir = path.join(stageDir, "lib");
fs.mkdirSync(libDir, { recursive: true });

if (fs.existsSync(vec0Path)) {
  fs.copyFileSync(vec0Path, path.join(libDir, `vec0.${extensionSuffix}`));
}

const tarballName = `prism-v${version}-${platformKey}.tar.gz`;
const tarballPath = path.join(repoRoot, tarballName);

execSync(
  `tar -czf ${tarballName} -C ${stageDir} dist lib`,
  { cwd: repoRoot, stdio: "inherit" },
);

fs.writeFileSync(`${tarballPath}.sha256`, `${sha256(tarballPath)}  ${tarballName}\n`);

console.log(`✓ Built ${tarballPath}`);
console.log(`  SHA-256: ${sha256(tarballPath)}`);

// Clean up the staging directory.
fs.rmSync(stageDir, { recursive: true, force: true });
