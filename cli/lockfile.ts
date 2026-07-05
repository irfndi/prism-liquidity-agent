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

export function acquireLock(
  lockfilePath = LOCKFILE_PATH,
): { readonly acquired: true } | { readonly acquired: false; readonly pid: number } {
  ensureLockfileDir(path.dirname(lockfilePath));

  const tryAtomicCreate = ():
    | { readonly acquired: true }
    | { readonly acquired: false; readonly existing: LockfileData | null } => {
    try {
      const data: LockfileData = { pid: process.pid, timestamp: Date.now() };
      const fd = fs.openSync(lockfilePath, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(data));
      } finally {
        fs.closeSync(fd);
      }
      return { acquired: true };
    } catch (err) {
      if (isNodeError(err) && err.code === "EEXIST") {
        const existing = readLockfile(lockfilePath);
        return { acquired: false, existing };
      }
      throw err;
    }
  };

  const first = tryAtomicCreate();
  if (first.acquired) return first;

  let existing = first.existing;
  if (!existing) {
    const retry = tryAtomicCreate();
    if (retry.acquired) return retry;
    existing = retry.existing;
  }

  if (existing && isProcessAlive(existing.pid)) {
    return { acquired: false, pid: existing.pid };
  }

  if (!existing) {
    // Lockfile exists but couldn't be parsed after two attempts.
    // Another process may be mid-write. Fail closed — don't unlink.
    return { acquired: false, pid: 0 };
  }

  // existing is valid and PID is dead — safe to replace
  try {
    fs.unlinkSync(lockfilePath);
  } catch (err) {
    if (!isNodeError(err) || err.code !== "ENOENT") {
      throw err;
    }
  }

  const second = tryAtomicCreate();
  if (second.acquired) return second;
  if (second.existing) {
    return { acquired: false, pid: second.existing.pid };
  }
  return { acquired: false, pid: 0 };
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
