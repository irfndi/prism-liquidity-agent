import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  BIGINT_FALLBACK_NOTE,
  installBigintWarningFilter,
  resetBigintWarningFilterForTest,
} from "../engine/bigint-warning-filter.js";

// Capture the REAL console.warn before this suite touches it, so afterAll can put
// it back — the filter is a process-wide singleton whose patch would otherwise
// leak into other test files run in the same worker.
const originalWarn = console.warn;

// Install once at module load: the filter is a process-wide singleton. The spy is
// installed FIRST so the filter captures it as the original console.warn — every
// non-suppressed warning routes to the spy, every suppressed marker does NOT, and
// the once-per-process fallback note is EMITTED through the spy (the captured
// original console.warn — the stderr channel), which is exactly what we assert on.
const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
installBigintWarningFilter();
const patchedWarn = console.warn;

const MARKER = "bigint: Failed to load bindings, pure JS will be used";

afterEach(() => {
  warnSpy.mockClear();
});

afterAll(() => {
  resetBigintWarningFilterForTest();
  console.warn = originalWarn;
});

describe("bigint-warning-filter", () => {
  it("suppresses the marker AND emits the once-note via the captured original warn (stderr), not stdout", () => {
    // Spy on stdout (console.log) so we can prove the note never takes the old
    // logger.debug path (logger.debug writes through console.log unconditionally).
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    console.warn(MARKER);
    // The marker itself never reached the original warn...
    expect(warnSpy).not.toHaveBeenCalledWith(MARKER);
    // ...exactly ONE note did — on the captured original console.warn (stderr
    // channel) and nothing on stdout.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(BIGINT_FALLBACK_NOTE);
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("emits the note only once across repeated suppressions (idempotent note)", () => {
    console.warn(MARKER);
    console.warn(MARKER);
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
    console.warn(MARKER);
    // The module-install's note already fired in the first test; the marker is
    // still dropped and no further note is emitted.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("reset restores the pre-install console.warn so other suites are unaffected", () => {
    resetBigintWarningFilterForTest();
    // The filter is gone: the marker now reaches the pre-install spy AS the marker.
    console.warn(MARKER);
    expect(warnSpy).toHaveBeenCalledWith(MARKER);
    // A fresh install patches again: a NEW install closure fires the note once
    // more, and the marker is dropped.
    warnSpy.mockClear();
    installBigintWarningFilter();
    console.warn(MARKER);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(BIGINT_FALLBACK_NOTE);
    expect(warnSpy).not.toHaveBeenCalledWith(MARKER);
  });
});
