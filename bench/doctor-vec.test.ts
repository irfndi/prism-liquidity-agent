import { describe, expect, it, vi } from "vitest";
import { existsSync } from "fs";
import { fileURLToPath } from "url";

import { probeVecAvailability } from "../engine/db.js";
import { checkMemory, checkNativeBindings } from "../cli/doctor.js";

const unavailableVecDependencies = {
  loadVec: () => {
    throw new Error("sqlite-vec disabled by the test dependency seam");
  },
  getEmbeddedVec0Path: () => null,
};

function withEnv(key: string, value: string | undefined, run: () => void): void {
  const previous = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

describe("probeVecAvailability failure surface (bundle path)", () => {
  it("reports unavailable with an error when PRISM_VEC0_PATH points at a nonexistent file", () => {
    const garbagePath = "/nonexistent/prism-doctor-test/vec0.dylib";
    withEnv("PRISM_VEC0_PATH", garbagePath, () => {
      const result = probeVecAvailability(unavailableVecDependencies);
      expect(result.available).toBe(false);
      expect(result.source).toBeNull();
      expect(result.error).not.toBeNull();
      expect(result.error?.length ?? 0).toBeGreaterThan(0);
      expect(result.error).toContain("vec0.dylib");
    });
  });

  it("reports unavailable with an error when PRISM_VEC0_PATH is unset", () => {
    withEnv("PRISM_VEC0_PATH", undefined, () => {
      const result = probeVecAvailability(unavailableVecDependencies);
      expect(result.available).toBe(false);
      expect(result.source).toBeNull();
      expect(result.error).not.toBeNull();
      expect(result.error?.length ?? 0).toBeGreaterThan(0);
    });
  });

  it("never names a load source when unavailable", () => {
    withEnv("PRISM_VEC0_PATH", "/definitely/not/vec0.so", () => {
      expect(probeVecAvailability(unavailableVecDependencies).source).toBeNull();
    });
  });

  it("reports available via PRISM_VEC0_PATH when the env library loads (skipped where SQLite cannot load extensions)", () => {
    const suffix =
      process.platform === "win32" ? "dll" : process.platform === "darwin" ? "dylib" : "so";
    const pkgName = `sqlite-vec-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
    const libPath = fileURLToPath(
      new URL(`../node_modules/${pkgName}/vec0.${suffix}`, import.meta.url),
    );
    if (!existsSync(libPath)) {
      // Platform extension package not installed; nothing to probe against.
      return;
    }
    withEnv("PRISM_VEC0_PATH", libPath, () => {
      const result = probeVecAvailability(unavailableVecDependencies);
      if (!result.available) {
        // Host SQLite is not extension-capable; skip the positive path.
        return;
      }
      expect(result.source).toBe("env");
      expect(result.error).toBeNull();
    });
  });
});

describe("doctor memory check", () => {
  it("maps an available probe to PASS and reports the load source", () => {
    const result = checkMemory(() => ({ available: true, source: "env", error: null }));
    expect(result.name).toBe("memory");
    expect(result.status).toBe("pass");
    expect(result.message).toContain("env");
  });

  it("maps an unavailable probe to FAIL with remediation and the underlying error", () => {
    const result = checkMemory(() => ({
      available: false,
      source: null,
      error: "This build of sqlite3 does not support dynamic extension loading",
    }));
    expect(result.name).toBe("memory");
    expect(result.status).toBe("fail");
    expect(result.message).toContain(
      process.platform === "darwin" ? "brew install sqlite" : "libsqlite3-0",
    );
    expect(result.message).toContain("PRISM_VEC0_PATH");
    expect(result.message).toContain("does not support dynamic extension loading");
  });

  it("fails through the real probe when every vec0 source is unavailable", () => {
    withEnv("PRISM_VEC0_PATH", "/nonexistent/prism-doctor-test/vec0.dylib", () => {
      const result = checkMemory(() => probeVecAvailability(unavailableVecDependencies));
      expect(result.status).toBe("fail");
      expect(result.message).toContain("unavailable");
    });
  });
});

describe("doctor native-bindings check", () => {
  it("is WARN-only and explains the harmless bigint-buffer fallback", () => {
    const result = checkNativeBindings();
    expect(result.name).toBe("native-bindings");
    expect(result.status).toBe("warn");
    expect(result.status).not.toBe("fail");
    expect(result.message).toContain("bigint");
    expect(result.message.toLowerCase()).toContain("pure-js");
    expect(result.message.toLowerCase()).toContain("no action");
  });
});
