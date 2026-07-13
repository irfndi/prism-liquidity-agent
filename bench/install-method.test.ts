import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { detectInstallMethod, isSourceInstall } from "../engine/install-method.js";
import { getVersionAgnosticInstallDir } from "../engine/update-utils.js";

describe("install-method", () => {
  let tmpDir = "";
  const originalCwd = process.cwd();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-install-method-"));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects tarball install from env variable", () => {
    process.env.PRISM_TARBALL_INSTALL = "1";
    expect(detectInstallMethod()).toBe("tarball");
    delete process.env.PRISM_TARBALL_INSTALL;
  });

  it("isSourceInstall returns true for a source tree", () => {
    fs.mkdirSync(path.join(tmpDir, "engine"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "cli"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, "cli", "index.ts"), "");
    expect(isSourceInstall(tmpDir)).toBe(true);
  });

  it("isSourceInstall returns false for a binary bundle layout", () => {
    fs.mkdirSync(path.join(tmpDir, "dist", "cli"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "dist", "cli", "index.mjs"), "");
    expect(isSourceInstall(tmpDir)).toBe(false);
  });

  it("removes release versions from legacy bundle install paths", () => {
    expect(getVersionAgnosticInstallDir("/home/user/prism-dlmm-v0.0.30")).toBe(
      "/home/user/prism-dlmm",
    );
    expect(getVersionAgnosticInstallDir("/home/user/prism-dlmm-v0.0.30-beta.1")).toBe(
      "/home/user/prism-dlmm",
    );
    expect(getVersionAgnosticInstallDir("/home/user/.prism")).toBe("/home/user/.prism");
  });
});
