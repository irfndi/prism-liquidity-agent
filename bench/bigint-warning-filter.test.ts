import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  installBigintWarningFilter,
  resetBigintWarningFilterForTest,
} from "../engine/bigint-warning-filter.js";

// Capture the REAL console.warn before this suite touches it, so afterAll can put
// it back — the filter is a process-wide singleton whose patch would otherwise
// leak into other test files run in the same worker.
const originalWarn = console.warn;

// Install once at module load: the filter is a process-wide singleton. The spy is
// installed first so the filter captures it as the original console.warn — every
// non-suppressed warning then routes to the spy, every suppressed one never does.
const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
installBigintWarningFilter();
const patchedWarn = console.warn;

afterEach(() => {
  warnSpy.mockClear();
});

afterAll(() => {
  resetBigintWarningFilterForTest();
  console.warn = originalWarn;
});

describe("bigint-warning-filter", () => {
  it("suppresses the bigint-buffer bindings warning", () => {
    console.warn("bigint: Failed to load bindings, pure JS will be used");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("passes through unrelated warnings untouched", () => {
    console.warn("some other warning", 42);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith("some other warning", 42);
  });

  it("passes through a call whose first argument is not the marker string", () => {
    console.warn(42);
    expect(warnSpy).toHaveBeenCalledWith(42);
  });

  it("is idempotent: a second install keeps the single filter, which still suppresses", () => {
    installBigintWarningFilter();
    expect(console.warn).toBe(patchedWarn);
    console.warn("bigint: Failed to load bindings, pure JS will be used");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("reset restores the pre-install console.warn so other suites are unaffected", () => {
    resetBigintWarningFilterForTest();
    // The filter is gone: the marker now reaches the pre-install spy.
    console.warn("bigint: Failed to load bindings, pure JS will be used");
    expect(warnSpy).toHaveBeenCalledWith("bigint: Failed to load bindings, pure JS will be used");
    // The singleton is uninstalled: a fresh install patches and suppresses again.
    warnSpy.mockClear();
    installBigintWarningFilter();
    console.warn("bigint: Failed to load bindings, pure JS will be used");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
