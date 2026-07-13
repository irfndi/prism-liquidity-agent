import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  getPrismConfigDir,
  getPrismUserConfigDir,
  getPrismDataDir,
  getPrismEnvPath,
  getPrismDbPath,
  setPrismEntryScriptOverride,
} from "../engine/paths.js";

describe("paths", () => {
  const originalConfigDir = process.env.PRISM_CONFIG_DIR;
  const originalDataDir = process.env.PRISM_DATA_DIR;
  const originalSqliteDbPath = process.env.SQLITE_DB_PATH;
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "prism-paths-"));
    process.env.PRISM_CONFIG_DIR = path.join(tmpHome, ".config", "prism");
    process.env.PRISM_DATA_DIR = path.join(tmpHome, ".local", "share", "prism");
    delete process.env.SQLITE_DB_PATH;
    setPrismEntryScriptOverride(undefined);
  });

  afterEach(() => {
    process.env.PRISM_CONFIG_DIR = originalConfigDir;
    process.env.PRISM_DATA_DIR = originalDataDir;
    if (originalSqliteDbPath === undefined) {
      delete process.env.SQLITE_DB_PATH;
    } else {
      process.env.SQLITE_DB_PATH = originalSqliteDbPath;
    }
    setPrismEntryScriptOverride(undefined);
  });

  it("uses the project root for a source install with a .env", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prism-source-"));
    fs.writeFileSync(path.join(projectRoot, "package.json"), "{}");
    fs.mkdirSync(path.join(projectRoot, "engine"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, "cli"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "cli", "index.ts"), "// entry");
    fs.writeFileSync(path.join(projectRoot, ".env"), "PAPER_TRADING=false");

    setPrismEntryScriptOverride(path.join(projectRoot, "cli", "index.ts"));

    const realProjectRoot = fs.realpathSync(projectRoot);
    expect(getPrismConfigDir()).toBe(realProjectRoot);
    expect(getPrismUserConfigDir()).toBe(process.env.PRISM_CONFIG_DIR);
    expect(getPrismDataDir()).toBe(realProjectRoot);
    expect(getPrismEnvPath()).toBe(path.join(realProjectRoot, ".env"));
    expect(getPrismDbPath()).toBe(path.join(realProjectRoot, "prism.db"));
  });

  it("falls back to home dirs when a source project has no .env", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prism-source-noenv-"));
    fs.writeFileSync(path.join(projectRoot, "package.json"), "{}");
    fs.mkdirSync(path.join(projectRoot, "engine"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, "cli"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "cli", "index.ts"), "// entry");

    setPrismEntryScriptOverride(path.join(projectRoot, "cli", "index.ts"));

    const expectedConfigDir = path.join(tmpHome, ".config", "prism");
    const expectedDataDir = path.join(tmpHome, ".local", "share", "prism");
    expect(getPrismConfigDir()).toBe(expectedConfigDir);
    expect(getPrismDataDir()).toBe(expectedDataDir);
    expect(getPrismEnvPath()).toBe(path.join(expectedConfigDir, ".env"));
    expect(getPrismDbPath()).toBe(path.join(expectedDataDir, "prism.db"));
  });

  it("uses home dirs for a compiled bundle install", () => {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prism-bundle-"));
    fs.mkdirSync(path.join(bundleRoot, "dist", "cli"), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, "dist", "cli", "index.mjs"), "// bundle");

    setPrismEntryScriptOverride(path.join(bundleRoot, "dist", "cli", "index.mjs"));

    const expectedConfigDir = path.join(tmpHome, ".config", "prism");
    const expectedDataDir = path.join(tmpHome, ".local", "share", "prism");
    expect(getPrismConfigDir()).toBe(expectedConfigDir);
    expect(getPrismDataDir()).toBe(expectedDataDir);
  });
});
