import { describe, it, expect } from "vitest";
import { getCurrentVersion } from "../engine/version.js";

describe("version", () => {
  it("returns a non-empty string", () => {
    const version = getCurrentVersion();
    expect(typeof version).toBe("string");
    expect(version.length).toBeGreaterThan(0);
  });

  it("returns a valid-looking semver", () => {
    const version = getCurrentVersion();
    // Should match something like "0.0.16" or "1.2.3"
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("returns consistent result on multiple calls", () => {
    const v1 = getCurrentVersion();
    const v2 = getCurrentVersion();
    expect(v1).toBe(v2);
  });
});
