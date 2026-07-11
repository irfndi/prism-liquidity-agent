import fs from "fs";
import os from "os";
import path from "path";
import { isSourceInstall } from "./install-method.js";

/**
 * Prism path resolution.
 *
 * When running from a source checkout (e.g. `bun cli/index.ts`), the active
 * project directory is derived from the entry script so the wrapper can be a
 * symlink anywhere on PATH and the engine still finds the repo's `.env`,
 * `prism.db`, and logs.
 *
 * When running as a compiled binary, config and data are kept under the user's
 * home directory so the binary can be invoked from anywhere.
 */

let entryScriptOverride: string | undefined;

export function setPrismEntryScriptOverride(entry: string | undefined): void {
  entryScriptOverride = entry;
}

function resolveEntryScript(): string {
  if (entryScriptOverride !== undefined) return entryScriptOverride;
  if (typeof Bun !== "undefined" && Bun.main) {
    return Bun.main;
  }
  return process.argv[1] ?? "";
}

function resolveProjectRoot(): string {
  const entry = resolveEntryScript();
  if (!entry) return process.cwd();

  const realEntry = path.resolve(fs.realpathSync(entry));
  const entryDir = path.dirname(realEntry);
  const entryDirName = path.basename(entryDir);
  const parentDir = path.dirname(entryDir);

  // Explicitly support the two known entry layouts so we don't rely on a
  // blind two-level dirname assumption that breaks for bundled installs.
  const entryFile = path.basename(realEntry);
  if (entryFile === "index.ts" && entryDirName === "cli") {
    return parentDir;
  }
  if (
    entryFile === "index.mjs" &&
    entryDirName === "cli" &&
    path.basename(parentDir) === "dist"
  ) {
    return path.dirname(parentDir);
  }

  // Fallback: walk up from the entry script looking for a Prism source tree.
  let dir = entryDir;
  while (dir !== path.dirname(dir)) {
    if (isSourceInstall(dir)) {
      return dir;
    }
    dir = path.dirname(dir);
  }

  return process.cwd();
}

function isRunningFromSource(): boolean {
  return isSourceInstall(resolveProjectRoot());
}

function hasProjectEnv(): boolean {
  return fs.existsSync(path.join(resolveProjectRoot(), ".env"));
}

function getDefaultConfigDir(): string {
  return process.env.PRISM_CONFIG_DIR ?? path.join(os.homedir(), ".config", "prism");
}

function getDefaultDataDir(): string {
  return process.env.PRISM_DATA_DIR ?? path.join(os.homedir(), ".local", "share", "prism");
}

export function getPrismConfigDir(): string {
  if (isRunningFromSource() && hasProjectEnv()) {
    return resolveProjectRoot();
  }
  return getDefaultConfigDir();
}

export function getPrismDataDir(): string {
  if (isRunningFromSource() && hasProjectEnv()) {
    return resolveProjectRoot();
  }
  return getDefaultDataDir();
}

export function getPrismEnvPath(): string {
  return path.join(getPrismConfigDir(), ".env");
}

export function getPrismDbPath(): string {
  return path.join(getPrismDataDir(), "prism.db");
}

export function getPrismLogsDir(): string {
  return path.join(getPrismDataDir(), "logs");
}

export function getPrismLogsPath(): string {
  return path.join(getPrismLogsDir(), "audit-trail.jsonl");
}

export function ensurePrismDataDir(): void {
  fs.mkdirSync(getPrismDataDir(), { recursive: true, mode: 0o700 });
}

export function ensurePrismConfigDir(): void {
  fs.mkdirSync(getPrismConfigDir(), { recursive: true, mode: 0o700 });
}
