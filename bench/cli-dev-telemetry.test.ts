import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../cli/api.js", () => ({
  pingInstall: vi.fn(),
  requireRegistered: vi.fn(),
}));

// Keep the engine out of this unit test — dev.ts imports runEngine at module
// scope, and loading the real module wires up the entire engine.
vi.mock("../engine/run-engine.js", () => ({
  runEngine: vi.fn(),
}));

import { pingInstall } from "../cli/api.js";
import { reportDevStartTelemetry } from "../cli/dev.js";

const mockedPingInstall = vi.mocked(pingInstall);

describe("cli/dev telemetry degrade", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns and continues when the telemetry ping fails", async () => {
    mockedPingInstall.mockResolvedValue(false);

    await expect(reportDevStartTelemetry("user-1")).resolves.toBeUndefined();

    expect(mockedPingInstall).toHaveBeenCalledWith("dev_start", { userId: "user-1" });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("telemetry is unavailable"));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("stays silent when the telemetry ping succeeds", async () => {
    mockedPingInstall.mockResolvedValue(true);

    await expect(reportDevStartTelemetry("user-1")).resolves.toBeUndefined();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
