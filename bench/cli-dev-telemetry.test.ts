import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { reportDevStartTelemetry } from "../cli/dev-telemetry.js";

describe("cli/dev telemetry degrade", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // SAFETY: This test fixture is constructed to satisfy the asserted service/domain contract and is exercised by the surrounding test.
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns and continues when the telemetry ping fails", async () => {
    const pingInstall = vi.fn(async () => false);

    await expect(reportDevStartTelemetry("user-1", pingInstall)).resolves.toBeUndefined();

    expect(pingInstall).toHaveBeenCalledWith("dev_start", { userId: "user-1" });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("telemetry is unavailable"));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("stays silent when the telemetry ping succeeds", async () => {
    const pingInstall = vi.fn(async () => true);

    await expect(reportDevStartTelemetry("user-1", pingInstall)).resolves.toBeUndefined();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
