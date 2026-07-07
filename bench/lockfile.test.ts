import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  acquireLock,
  releaseLock,
  readLockfile,
  isProcessAlive,
  findRunningEngineProcess,
} from "../cli/lockfile.js";

const tmpDir = path.join(os.tmpdir(), `prism-lockfile-test-${Date.now()}`);

function lockPath(name: string): string {
  return path.join(tmpDir, `${name}.lock`);
}

describe("lockfile", () => {
  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  describe("isProcessAlive", () => {
    it("returns true for the current process", () => {
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it("returns false for a non-existent process", () => {
      expect(isProcessAlive(99_999_999)).toBe(false);
    });
  });

  describe("readLockfile", () => {
    it("returns null when the lockfile does not exist", () => {
      expect(readLockfile(lockPath("missing"))).toBeNull();
    });

    it("parses a valid lockfile", () => {
      const file = lockPath("valid");
      fs.writeFileSync(file, JSON.stringify({ pid: 1234, timestamp: Date.now() }));
      const lock = readLockfile(file);
      expect(lock).not.toBeNull();
      expect(lock!.pid).toBe(1234);
    });

    it("returns null for malformed lockfile", () => {
      const file = lockPath("malformed");
      fs.writeFileSync(file, "not-json");
      expect(readLockfile(file)).toBeNull();
    });
  });

  describe("acquireLock / releaseLock", () => {
    it("acquires and releases a lock", () => {
      const file = lockPath("acquire");
      const first = acquireLock(file);
      expect(first.acquired).toBe(true);

      const second = acquireLock(file);
      expect(second.acquired).toBe(false);
      if (!second.acquired) {
        expect(second.pid).toBe(process.pid);
      }

      releaseLock(file);
      expect(readLockfile(file)).toBeNull();
    });
  });

  describe("findRunningEngineProcess", () => {
    const originalPlatform = process.platform;

    afterEach(() => {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    });

    it("returns null on Windows", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      expect(findRunningEngineProcess()).toBeNull();
    });

    it("returns null when ps cannot be run", () => {
      const spawner = () => ({ error: new Error("ENOENT") });
      expect(findRunningEngineProcess(spawner)).toBeNull();
    });

    it("detects a bun run dev process", () => {
      const pid = 42_000;
      const stdout = [
        "PID ARGS",
        `${process.pid} bun run test`,
        `${pid} bun run dev`,
        `${pid + 1} bun install`,
      ].join("\n");
      const spawner = () => ({ stdout });

      const found = findRunningEngineProcess(spawner);
      expect(found).not.toBeNull();
      expect(found!.pid).toBe(pid);
      expect(found!.command).toContain("bun run dev");
    });

    it("ignores unrelated bun commands", () => {
      const stdout = [
        "PID ARGS",
        `${process.pid} bun run test`,
        `1234 bun install some-package`,
        `1235 bun run lint`,
      ].join("\n");
      const spawner = () => ({ stdout });

      expect(findRunningEngineProcess(spawner)).toBeNull();
    });
  });
});
