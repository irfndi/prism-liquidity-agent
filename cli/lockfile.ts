import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";

export const LOCKFILE_DIR = path.join(os.homedir(), ".config", "prism");
export const LOCKFILE_PATH = path.join(LOCKFILE_DIR, "dev.lock");

interface LockfileData {
  readonly pid: number;
  readonly timestamp: number;
}

function isNodeError(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause;
}

export function ensureLockfileDir(lockfileDir = LOCKFILE_DIR): void {
  if (!fs.existsSync(lockfileDir)) {
    fs.mkdirSync(lockfileDir, { recursive: true, mode: 0o700 });
  }
}

export function readLockfile(lockfilePath = LOCKFILE_PATH): LockfileData | null {
  try {
    const content = fs.readFileSync(lockfilePath, "utf-8");
    // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
    const parsed = JSON.parse(content) as LockfileData | null;
    if (parsed === null) return null;
    if (!Number.isFinite(parsed.pid) || !Number.isFinite(parsed.timestamp)) return null;
    return parsed;
  } catch (cause) {
    if (isNodeError(cause) && cause.code === "ENOENT") {
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

const EXCLUDED_PATTERNS = [
  "bun install",
  "bun add",
  "bun remove",
  "bun update",
  "bun test",
  "bun run test",
  "bun run lint",
  "bun run format",
  "bun run setup",
  "bun run backtest",
];

/** Spawner signature for `ps` scans (defaults to `spawnSync`). */
type PsSpawner = (
  command: string,
  args: ReadonlyArray<string>,
  options: { encoding: "utf-8"; shell: false; timeout?: number },
) => { readonly stdout?: string | Buffer; readonly error?: Error };

/** Run `ps` and return stdout text, or null when the scan itself fails. */
function readPsStdout(spawner: PsSpawner): string | null {
  try {
    const result = spawner("ps", ["-eo", "pid,args"], {
      encoding: "utf-8",
      shell: false,
      timeout: 3000,
    });
    if (result.error || !result.stdout) return null;
    return Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf-8") : result.stdout;
  } catch {
    return null;
  }
}

/** Parse one `ps -eo pid,args` line, excluding our own process. */
function parsePsLine(
  line: string,
  selfPid: number,
): { readonly pid: number; readonly command: string } | null {
  const trimmed = line.trim();
  const match = trimmed.match(/^(\d+)\s+(.+)$/);
  if (match === null) return null;
  const pidStr = match[1];
  const args = match[2];
  if (pidStr === undefined || args === undefined) return null;
  const pid = Number.parseInt(pidStr, 10);
  if (pid === selfPid) return null;
  return { pid, command: args };
}

/** Whether a process command line is a Prism engine/dev process. */
function isEngineCommandLine(args: string): boolean {
  if (!args.includes("bun")) return false;
  if (EXCLUDED_PATTERNS.some((pattern) => args.includes(pattern))) return false;
  return (
    args.includes("engine/index.ts") ||
    args.includes("run dev") ||
    args.includes("cli/dev.ts") ||
    // Bundled/source CLI dev process (e.g. `bun /root/.prism/dist/cli/
    // index.mjs dev` under systemd, or a relative `bun cli/index.ts dev`
    // from the repo root): the source-path patterns above do not match
    // the bundle. Scoped to Prism's CLI layout — the `cli/` segment must
    // be preceded by a whitespace, slash, or line start (so an unrelated
    // `*-cli/` or `mycli/` directory cannot match) — with a STANDALONE
    // `dev` argument: a bare substring `dev` (dev-server, development,
    // /devtools/) or an unrelated project's index.mjs must never
    // false-positive the RESTART REQUIRED notice and its kill hint.
    (/(^|[\s/])cli\/index\.(mjs|ts)(\s|$)/.test(args) && /(^|\s)dev($|\s)/.test(args))
  );
}

export function findRunningEngineProcess(
  spawner: PsSpawner = spawnSync,
): { readonly pid: number; readonly command: string } | null {
  if (process.platform === "win32") return null;
  const stdout = readPsStdout(spawner);
  if (stdout === null) return null;
  const lines = stdout.trim().split("\n").slice(1);
  for (const line of lines) {
    const parsed = parsePsLine(line, process.pid);
    if (parsed === null) continue;
    if (!isEngineCommandLine(parsed.command)) continue;
    return parsed;
  }
  return null;
}

function tryAtomicCreate(
  lockfilePath: string,
):
  | { readonly acquired: true }
  | { readonly acquired: false; readonly existing: LockfileData | null } {
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
}

/**
 * The moved file is not the stale lock we read — a concurrent launcher
 * re-acquired it (or the file was mid-write). Restore it with a hard
 * link (never clobbers a lock that appeared in the meantime) and fail
 * with the owner we displaced, falling back to the current owner.
 */
type LockFailure = { readonly acquired: false; readonly pid: number };

function restoreDisplacedLock(
  backupPath: string,
  lockfilePath: string,
  moved: LockfileData | null,
): LockFailure {
  try {
    fs.linkSync(backupPath, lockfilePath);
    try {
      fs.unlinkSync(backupPath);
    } catch {
      // Best-effort cleanup of the restored lock.
    }
  } catch (restoreErr) {
    if (!isNodeError(restoreErr) || restoreErr.code !== "EEXIST") {
      throw restoreErr;
    }
  }
  const current = readLockfile(lockfilePath);
  return { acquired: false, pid: current?.pid ?? moved?.pid ?? 0 };
}

/**
 * `existing` is a valid stale lock (dead PID) — replace it atomically. The
 * old unlink-then-create flow had a TOCTOU window: a concurrent launcher
 * could re-acquire the lock between our unlink and our exclusive create, and
 * our unlink would delete their fresh lock, leaving both launchers believing
 * they hold it. Renaming the stale file aside first is atomic, and checking
 * the moved copy (not the live path) detects a concurrent re-acquisition
 * without a check-then-act race; the exclusive create can then only fail if
 * another launcher already owns the lock.
 */
/** Rename the stale lock aside; false when it vanished under us (ENOENT). */
function tryRenameAside(lockfilePath: string, backupPath: string): boolean {
  try {
    fs.renameSync(lockfilePath, backupPath);
    return true;
  } catch (err) {
    if (!isNodeError(err) || err.code !== "ENOENT") {
      throw err;
    }
    return false;
  }
}

/** The lock vanished mid-replace — only an exclusive create can win now. */
function claimVacantLock(lockfilePath: string): { readonly acquired: true } | LockFailure {
  const created = tryAtomicCreate(lockfilePath);
  if (created.acquired) return { acquired: true };
  return { acquired: false, pid: created.existing?.pid ?? 0 };
}

/**
 * `existing` is a valid stale lock (dead PID) — replace it atomically. The
 * old unlink-then-create flow had a TOCTOU window: a concurrent launcher
 * could re-acquire the lock between our unlink and our exclusive create, and
 * our unlink would delete their fresh lock, leaving both launchers believing
 * they hold it. Renaming the stale file aside first is atomic, and checking
 * the moved copy (not the live path) detects a concurrent re-acquisition
 * without a check-then-act race; the exclusive create can then only fail if
 * another launcher already owns the lock.
 */
function replaceStaleLock(
  lockfilePath: string,
  existing: LockfileData,
): { readonly acquired: true } | LockFailure {
  const backupPath = `${lockfilePath}.${process.pid}.${Date.now()}.tmp`;
  if (!tryRenameAside(lockfilePath, backupPath)) {
    // The lock vanished between our read and rename — another launcher is
    // replacing it. Only an exclusive create can win now.
    return claimVacantLock(lockfilePath);
  }

  try {
    const moved = readLockfile(backupPath);
    if (moved === null || moved.pid !== existing.pid || moved.timestamp !== existing.timestamp) {
      return restoreDisplacedLock(backupPath, lockfilePath, moved);
    }

    const second = tryAtomicCreate(lockfilePath);
    if (second.acquired) {
      return { acquired: true };
    }
    return { acquired: false, pid: second.existing?.pid ?? 0 };
  } finally {
    try {
      fs.unlinkSync(backupPath);
    } catch {
      // Best-effort cleanup of the moved stale lock.
    }
  }
}

export function acquireLock(
  lockfilePath = LOCKFILE_PATH,
): { readonly acquired: true } | { readonly acquired: false; readonly pid: number } {
  ensureLockfileDir(path.dirname(lockfilePath));

  const first = tryAtomicCreate(lockfilePath);
  if (first.acquired) return first;

  let existing = first.existing;
  if (!existing) {
    const retry = tryAtomicCreate(lockfilePath);
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

  return replaceStaleLock(lockfilePath, existing);
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
