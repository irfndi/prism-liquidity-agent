import fs from "fs";
import path from "path";
import os from "os";

export const LOCKFILE_DIR = path.join(os.homedir(), ".config", "prism");
export const LOCKFILE_PATH = path.join(LOCKFILE_DIR, "dev.lock");

interface LockfileData {
  readonly pid: number;
  readonly timestamp: number;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function isObject(err: unknown): err is Record<string, unknown> {
  return typeof err === "object" && err !== null;
}

function isLockfileData(parsed: unknown): parsed is LockfileData {
  if (!isObject(parsed)) return false;
  if (typeof parsed.pid !== "number") return false;
  if (typeof parsed.timestamp !== "number") return false;
  return true;
}

export function ensureLockfileDir(lockfileDir = LOCKFILE_DIR): void {
  if (!fs.existsSync(lockfileDir)) {
    fs.mkdirSync(lockfileDir, { recursive: true, mode: 0o700 });
  }
}

export function readLockfile(lockfilePath = LOCKFILE_PATH): LockfileData | null {
  try {
    const content = fs.readFileSync(lockfilePath, "utf-8");
    const parsed: unknown = JSON.parse(content);
    if (isLockfileData(parsed)) {
      return parsed;
    }
    return null;
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return null;
    }
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

export function acquireLock(
  lockfilePath = LOCKFILE_PATH,
): { readonly acquired: true } | { readonly acquired: false; readonly pid: number } {
  ensureLockfileDir(path.dirname(lockfilePath));

  const existing = readLockfile(lockfilePath);
  if (existing) {
    const isStale = Date.now() - existing.timestamp > STALE_THRESHOLD_MS;
    if (!isStale && isProcessAlive(existing.pid)) {
      return { acquired: false, pid: existing.pid };
    }
    // Stale lock or dead process — overwrite
  }

  const data: LockfileData = { pid: process.pid, timestamp: Date.now() };
  fs.writeFileSync(lockfilePath, JSON.stringify(data), { mode: 0o600 });
  return { acquired: true };
}

export function releaseLock(lockfilePath = LOCKFILE_PATH): void {
  try {
    const existing = readLockfile(lockfilePath);
    if (existing && existing.pid === process.pid) {
      fs.unlinkSync(lockfilePath);
    }
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return;
    }
    // Best-effort cleanup; ignore other errors.
  }
}
