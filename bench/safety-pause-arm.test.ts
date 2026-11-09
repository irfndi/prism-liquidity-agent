import { describe, expect, it } from "vitest";
import { isSafetyPauseArmed, updateCoreDataFailureCounter } from "../engine/program.js";

// The name used to invert its meaning (it returned true for "resolved or
// absent"), while the three auto-resolvers in the same file test
// `resolvedAt === null` for "latched". The predicate now says what it means;
// the call site negates it, which is the same condition as before.
describe("isSafetyPauseArmed", () => {
  it("is armed only when the pause is unresolved", () => {
    // Given a latched pause, a resolved pause and no pause at all.
    // Then only the latched one counts as armed.
    expect(isSafetyPauseArmed({ resolvedAt: null })).toBe(true);
    expect(isSafetyPauseArmed({ resolvedAt: 1_000 })).toBe(false);
    expect(isSafetyPauseArmed(null)).toBe(false);
  });
});

// A `core_data_unavailable` pause needs two consecutive cycles of unavailable
// data. `poolsScanned === 0` used to satisfy `failures >= poolsScanned` (0 >= 0)
// and reset the counter, so a discovery outage that yielded no pools read as
// healthy and the breaker never fired.
describe("updateCoreDataFailureCounter", () => {
  it("counts a cycle that was expected to scan pools but scanned none", () => {
    // Given a discovery outage: pools were configured, nothing scanned.
    // Then the counter advances instead of resetting to 0.
    expect(updateCoreDataFailureCounter(0, 0, 0, 12)).toBe(1);
    expect(updateCoreDataFailureCounter(1, 0, 0, 12)).toBe(2);
  });

  it("does not count a cycle with nothing to scan as an outage", () => {
    // Given no pools configured at all — there is no missing data to report.
    expect(updateCoreDataFailureCounter(1, 0, 0, 0)).toBe(0);
  });

  it("counts an all-pools-failed cycle and resets on a healthy one", () => {
    expect(updateCoreDataFailureCounter(0, 5, 5, 5)).toBe(1);
    expect(updateCoreDataFailureCounter(1, 5, 5, 5)).toBe(2);
    // One pool succeeded: core data is demonstrably available.
    expect(updateCoreDataFailureCounter(3, 5, 4, 5)).toBe(0);
    expect(updateCoreDataFailureCounter(3, 5, 0, 5)).toBe(0);
  });

  it("reaches the trigger threshold from an empty scan set (the outage it exists for)", () => {
    // Two consecutive no-pool cycles must arm core_data_unavailable.
    let consecutive = 0;
    consecutive = updateCoreDataFailureCounter(consecutive, 0, 0, 8);
    consecutive = updateCoreDataFailureCounter(consecutive, 0, 0, 8);
    expect(consecutive).toBeGreaterThanOrEqual(2);
  });
});
