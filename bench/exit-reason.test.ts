/** Stable EXIT taxonomy tags for ledger slicing. */
import { describe, expect, it } from "vitest";
import { exitReasonTag, taggedExitReason } from "../engine/exit-reason.js";

describe("exit reason taxonomy", () => {
  it("wraps detail with a bracket tag", () => {
    expect(taggedExitReason("trailing-stop", "value dropped 12%")).toBe(
      "[trailing-stop] value dropped 12%",
    );
  });

  it("extracts bracket tags and legacy untagged prefixes", () => {
    expect(exitReasonTag("[position-loss-cap] lost 40%")).toBe("position-loss-cap");
    expect(exitReasonTag("[w15] depeg")).toBe("w15");
    expect(exitReasonTag("[dust-cleanup] below $5")).toBe("dust-cleanup");
    expect(exitReasonTag("Trailing stop: value dropped 12%")).toBe("trailing-stop");
    expect(exitReasonTag("Rotation: runner net 5000%")).toBe("rotation");
    expect(exitReasonTag("no match")).toBe("unknown");
  });
});
