import fs from "fs";
import os from "os";
import path from "path";

/**
 * Prism path resolution.
 *
 * When running from a source checkout (e.g. `bun cli/index.ts`), the active
 * project directory is the current working directory. If a `.env` file exists
 * there, we treat it as the project root and keep `.env`, `prism.db`, and logs
 * in cwd so the existing development workflow keeps working.
 *
 * When running as a compiled binary, config and data are kept under the user's
 * home directory so the binary can be invoked from anywhere.
 */

function isRunningFromSource(): boolean {
  if (typeof Bun === "undefined") return false;
  const main = Bun.main ?? "";
  return (
    main.endsWith(".ts") || main.endsWith(".js") || main.endsWith(".mjs") || main.endsWith(".cjs")
  );
}

function hasProjectEnv(): boolean {
  return fs.existsSync(path.resolve(".env"));
}

function projectRoot(): string {
  return process.cwd();
}

export const PRISM_CONFIG_DIR =
  process.env.PRISM_CONFIG_DIR ?? path.join(os.homedir(), ".config", "prism");
export const PRISM_DATA_DIR =
  process.env.PRISM_DATA_DIR ?? path.join(os.homedir(), ".local", "share", "prism");

export function getPrismConfigDir(): string {
  if (isRunningFromSource() && hasProjectEnv()) {
    return projectRoot();
  }
  return PRISM_CONFIG_DIR;
}

export function getPrismDataDir(): string {
  if (isRunningFromSource() && hasProjectEnv()) {
    return projectRoot();
  }
  return PRISM_DATA_DIR;
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
