import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  acquireLock,
  releaseLock,
  isProcessAlive,
  readLockfile,
  findRunningEngineProcess,
} from "../cli/lockfile.js";

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

  it("findRunningEngineProcess detects the bundled CLI dev process (issue #184)", () => {
    // Given a ps snapshot where the agent runs from the release bundle
    // (`bun /root/.prism/dist/cli/index.mjs dev` — the systemd pattern), the
    // source-path matchers alone miss it.
    const spawner = () => ({
      // ps -eo pid,args prints a header line, which the matcher skips.
      stdout: [
        "PID ARGS",
        `${process.pid} some-unrelated-command`,
        `${process.pid + 1} bun /root/.prism/dist/cli/index.mjs dev`,
        `${process.pid + 2} bun install`,
      ].join("\n"),
    });
    const found = findRunningEngineProcess(spawner);
    expect(found).toEqual({ pid: process.pid + 1, command: `bun /root/.prism/dist/cli/index.mjs dev` });
  });

  it("findRunningEngineProcess ignores index.mjs runs without a dev argument", () => {
    // Given a ps snapshot with a plain bundled entry (e.g. the Docker image
    // runs `bun dist/index.mjs`) and an unrelated script.
    const spawner = () => ({
      stdout: [
        "PID ARGS",
        `${process.pid + 1} bun /root/.prism/dist/index.mjs`,
        `${process.pid + 2} bun tools/index.mjs build`,
      ].join("\n"),
    });
    expect(findRunningEngineProcess(spawner)).toBeNull();
  });

  it("findRunningEngineProcess does not false-positive unrelated index.mjs dev runs (issue #184 review)", () => {
    // Given an unrelated project's entry and a `dev` substring that is not a
    // standalone argument — neither may be reported as the Prism agent.
    const spawner = () => ({
      stdout: [
        "PID ARGS",
        `${process.pid + 1} bun /home/user/other-app/dist/index.mjs dev`,
        `${process.pid + 2} bun /srv/app/index.mjs dev-server`,
        `${process.pid + 3} bun /opt/x/index.mjs development`,
        `${process.pid + 4} bun /home/user/devtools/index.mjs dev`,
      ].join("\n"),
    });
    expect(findRunningEngineProcess(spawner)).toBeNull();
  });

  it("findRunningEngineProcess ignores cli-suffixed directories that are not Prism (issue #184 follow-up)", () => {
    // Given paths whose directory segment merely ENDS in `cli` — the bare
    // substring `cli/index.mjs` would match these; the path-anchored
    // pattern must not.
    const spawner = () => ({
      stdout: [
        "PID ARGS",
        `${process.pid + 1} bun /opt/foo-cli/index.mjs dev`,
        `${process.pid + 2} bun /home/user/mycli/index.ts dev`,
      ].join("\n"),
    });
    expect(findRunningEngineProcess(spawner)).toBeNull();
  });

  it("findRunningEngineProcess detects a source-tree CLI dev process", () => {
    const spawner = () => ({
      stdout: [
        "PID ARGS",
        `${process.pid + 1} bun /repo/prism-liquidity-agent/cli/index.ts dev`,
        `${process.pid + 2} bun /repo/prism-liquidity-agent/cli/index.ts status`,
      ].join("\n"),
    });
    const found = findRunningEngineProcess(spawner);
    expect(found?.pid).toBe(process.pid + 1);
  });

  it("findRunningEngineProcess detects a RELATIVE source-tree CLI dev run (issue #184 follow-up)", () => {
    // ps separates the executable from its arguments with spaces: a dev run
    // from the repo root renders as `bun cli/index.ts dev` — the cli/ segment
    // is preceded by whitespace, not a slash, and must still match.
    const spawner = () => ({
      stdout: [
        "PID ARGS",
        `${process.pid + 1} bun cli/index.ts dev`,
        `${process.pid + 2} bun cli/index.ts status`,
      ].join("\n"),
    });
    const found = findRunningEngineProcess(spawner);
    expect(found?.pid).toBe(process.pid + 1);
  });
});
