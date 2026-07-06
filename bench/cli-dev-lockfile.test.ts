import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { acquireLock, releaseLock, isProcessAlive, readLockfile } from "../cli/lockfile.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prism-lockfile-"));
}

function lockfilePath(dir: string): string {
  return path.join(dir, "dev.lock");
}

function writeLockfile(dir: string, pid: number, timestamp: number): void {
  fs.writeFileSync(lockfilePath(dir), JSON.stringify({ pid, timestamp }), { mode: 0o600 });
}

describe("cli/lockfile", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("acquireLock succeeds when no lockfile exists", () => {
    tmpDir = makeTmpDir();
    const lock = lockfilePath(tmpDir);
    const result = acquireLock(lock);
    expect(result).toEqual({ acquired: true });
    expect(fs.existsSync(lock)).toBe(true);
    const data = readLockfile(lock);
    expect(data?.pid).toBe(process.pid);
  });

  it("acquireLock fails when process is alive", () => {
    tmpDir = makeTmpDir();
    writeLockfile(tmpDir, process.pid, Date.now());
    const result = acquireLock(lockfilePath(tmpDir));
    expect(result).toEqual({ acquired: false, pid: process.pid });
  });

  it("acquireLock succeeds when lockfile PID is dead", () => {
    tmpDir = makeTmpDir();
    writeLockfile(tmpDir, 99999999, Date.now());
    const result = acquireLock(lockfilePath(tmpDir));
    expect(result).toEqual({ acquired: true });
    const data = readLockfile(lockfilePath(tmpDir));
    expect(data?.pid).toBe(process.pid);
  });

  it("acquireLock rejects a live owner even if the lockfile is stale", () => {
    tmpDir = makeTmpDir();
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    writeLockfile(tmpDir, process.pid, twoHoursAgo);
    const result = acquireLock(lockfilePath(tmpDir));
    expect(result).toEqual({ acquired: false, pid: process.pid });
  });

  it("acquireLock succeeds when lockfile is stale and owner is dead", () => {
    tmpDir = makeTmpDir();
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    writeLockfile(tmpDir, 99999999, twoHoursAgo);
    const result = acquireLock(lockfilePath(tmpDir));
    expect(result).toEqual({ acquired: true });
    const data = readLockfile(lockfilePath(tmpDir));
    expect(data?.pid).toBe(process.pid);
  });

  it("acquireLock does not steal from a live owner between atomic create and read", () => {
    tmpDir = makeTmpDir();
    writeLockfile(tmpDir, process.pid, Date.now());
    const result = acquireLock(lockfilePath(tmpDir));
    expect(result).toEqual({ acquired: false, pid: process.pid });
    const data = readLockfile(lockfilePath(tmpDir));
    expect(data?.pid).toBe(process.pid);
  });

  it("acquireLock does not unlink unparsable lockfile (fail closed)", () => {
    tmpDir = makeTmpDir();
    fs.writeFileSync(lockfilePath(tmpDir), '{ "pid": 123', { mode: 0o600 });
    const result = acquireLock(lockfilePath(tmpDir));
    expect(result).toEqual({ acquired: false, pid: 0 });
    expect(fs.existsSync(lockfilePath(tmpDir))).toBe(true);
  });

  it("releaseLock removes lockfile when PID matches", () => {
    tmpDir = makeTmpDir();
    acquireLock(lockfilePath(tmpDir));
    releaseLock(lockfilePath(tmpDir));
    expect(fs.existsSync(lockfilePath(tmpDir))).toBe(false);
  });

  it("releaseLock leaves lockfile when PID differs", () => {
    tmpDir = makeTmpDir();
    writeLockfile(tmpDir, 1, Date.now());
    releaseLock(lockfilePath(tmpDir));
    expect(fs.existsSync(lockfilePath(tmpDir))).toBe(true);
  });

  it("releaseLock is no-op when lockfile does not exist", () => {
    tmpDir = makeTmpDir();
    expect(() => releaseLock(lockfilePath(tmpDir))).not.toThrow();
  });

  it("isProcessAlive returns true for current PID", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("isProcessAlive returns false for impossible PID", () => {
    expect(isProcessAlive(99999999)).toBe(false);
  });
});
