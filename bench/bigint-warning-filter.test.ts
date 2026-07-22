import { afterEach, describe, expect, it, vi } from "vitest";
import { installBigintWarningFilter } from "../engine/bigint-warning-filter.js";

// Install once at module load: the filter is a process-wide singleton. The spy is
// installed first so the filter captures it as the original console.warn — every
// non-suppressed warning then routes to the spy, every suppressed one never does.
const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
installBigintWarningFilter();
const patchedWarn = console.warn;

afterEach(() => {
  warnSpy.mockClear();
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

  it("is idempotent: a second install leaves the single installed filter in place", () => {
    installBigintWarningFilter();
    expect(console.warn).toBe(patchedWarn);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
